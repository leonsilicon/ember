import ARKit
import CoreImage

enum CaptureMode: String {
  /// LiDAR depth seeds the splat (Pro iPhones / iPads).
  case lidar
  /// No LiDAR: ARKit's tracked feature points seed it instead (any ARKit iPhone).
  case features
}

enum CameraPosition: String, CaseIterable {
  /// World tracking: the camera that records.
  case back
  /// Face tracking on the TrueDepth camera, which previews and feeds detection but can't record.
  case front
}

enum CaptureError: LocalizedError {
  case arkitUnsupported
  case alreadyRecording
  case notRecording
  case noFrames
  case frontCamera

  var errorDescription: String? {
    switch self {
    case .arkitUnsupported: return "This device doesn't support ARKit world tracking."
    case .alreadyRecording: return "A capture is already recording."
    case .notRecording: return "No capture is recording."
    case .noFrames: return "No frames were kept. Move the phone slowly around the subject and keep it tracking (not 'limited')."
    case .frontCamera: return "Recording needs the back camera. Flip back to record."
    }
  }
}

struct CaptureSettings {
  var maxFrames = 300
  var imageWidth = 1280
  var forceFeaturePoints = false
  /// Splat server to stream the recording to for live reconstruction (see LiveStreamer), if any.
  var liveServerURL: URL? = nil
  /// The splat server's access token.
  var serverToken: String? = nil
}

/// Owns the AR session's frame stream while recording and turns it into a
/// Brush-ready dataset: `images/`, `transforms.json` and a `points.ply` seed cloud.
///
/// Frames arrive on `frameQueue` and only cheap work happens there (selection,
/// grabbing buffers). Encoding and colour sampling happen on `writeQueue`, with at
/// most two frames in flight so ARKit's small camera-buffer pool never runs dry.
final class CaptureController: NSObject, ARSessionDelegate {
  static let shared = CaptureController()

  /// Status for the UI, sent a few times a second and on start/stop.
  var onStatus: (([String: Any]) -> Void)?

  private let frameQueue = DispatchQueue(label: "soon2026.splatcapture.frames", qos: .userInitiated)
  private let writeQueue = DispatchQueue(label: "soon2026.splatcapture.write", qos: .userInitiated)
  private let detectionQueue = DispatchQueue(label: "soon2026.splatcapture.detection", qos: .userInitiated)
  private let streamQueue = DispatchQueue(label: "soon2026.splatcapture.stream", qos: .userInitiated)
  /// The camera for browsers on the same Wi-Fi (the web app's live mode). Encodes only while watched.
  let cameraServer = CameraStreamServer(device: hardwareModel())
  private let ciContext = CIContext()
  private weak var session: ARSession?
  // main-thread state
  private var isRunning = false
  private var previewVisible = false
  private var consecutiveFailures = 0
  private var camera = CameraPosition.back

  // frameQueue state
  private var recording: Recording?
  /// The stream to the splat server's live reconstruction: connected ahead of a recording (standing
  /// by, see `armStandby`) so the recording streams from its first frame, then carrying it.
  private var live: LiveStreamer?
  /// Where live streaming goes, as the app last said (`setLiveServer`); nil turns it off.
  private var liveServer: (url: URL, token: String?)?
  /// `previewVisible`, for the frame queue.
  private var previewShown = false
  private var detectionRequest: DetectionRequest?
  /// The newest frame's camera, for `currentCamera` (the rover's steering loop polls it).
  private var latestCamera: DetectionCamera?
  private var recoveringFromFailure = false
  private var lastStatusAt: TimeInterval = 0
  private var tracking = ("notAvailable", nil as String?)
  private var frontCamera = false
  /// One stream frame encodes at a time; a frame arriving meanwhile is skipped.
  private var streamEncoding = false
  private var lastStreamAt: TimeInterval = 0
  /// Stills the web app asked for (`/frame.jpg?size=N`, for capturing), answered from the next frame.
  private var stillRequests: [(maxSize: Int, done: (Data?) -> Void)] = []

  static var supportsARKit: Bool { ARWorldTrackingConfiguration.isSupported }
  static var supportsLiDAR: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }
  static var supportsFrontCamera: Bool { ARFaceTrackingConfiguration.isSupported }

  static func capabilities() -> [String: Any] {
    ["arkit": supportsARKit, "lidar": supportsLiDAR, "frontCamera": supportsFrontCamera]
  }

  /// Where a capture is written while it records; it is zipped into `library` when it stops.
  static var workDirectory: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("CaptureWork")
  }

  /// Saved captures live in Documents, which the Files app and Finder show (UIFileSharingEnabled).
  static let library = CaptureLibrary(
    directory: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Captures"),
    summaries: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("CaptureSummaries"))

  // MARK: Session

  func attach(_ session: ARSession) {
    guard self.session !== session else { return }
    session.delegateQueue = frameQueue
    session.delegate = self
    self.session = session
  }

  /// Called on the main thread by the preview when it gains or loses the screen. The
  /// camera is released when the preview is hidden, except mid-recording, in which
  /// case it's released once the recording stops.
  func setPreviewVisible(_ visible: Bool) {
    previewVisible = visible
    if visible {
      runSession()
      frameQueue.async {
        self.previewShown = true
        self.armStandby()
      }
    } else {
      frameQueue.async {
        self.previewShown = false
        guard self.recording == nil else { return }
        self.disarmStandby()
        DispatchQueue.main.async { self.pauseIfHidden() }
      }
    }
  }

  /// Any thread. Where recordings stream for live reconstruction, from now on; nil for nowhere. A
  /// connection is made straight away while the viewfinder is on screen, so a recording starts
  /// streaming the moment it starts.
  func setLiveServer(url: URL?, token: String?) {
    frameQueue.async {
      self.liveServer = url.map { ($0, token) }
      if url == nil {
        self.disarmStandby()
      } else {
        self.armStandby()
      }
    }
  }

  /// Frame queue only. Connects to the splat server ahead of a recording, unless already connected
  /// there, no recording can start (viewfinder hidden, front camera) or one is in progress.
  private func armStandby() {
    guard let liveServer, recording == nil, previewShown, !frontCamera, Self.supportsARKit else { return }
    if let live, !live.closed, live.sessionId == nil, live.serverURL == liveServer.url, live.token == liveServer.token {
      return
    }
    live?.close()
    live = LiveStreamer(serverURL: liveServer.url, token: liveServer.token, frameQueue: frameQueue, ciContext: ciContext)
  }

  /// Frame queue only. Drops a standby connection (never a recording's).
  private func disarmStandby() {
    guard let live, live.sessionId == nil else { return }
    live.close()
    self.live = nil
  }

  /// Main thread only. Switches the preview's camera, restarting a running session on it. The front
  /// camera has no world tracking, so a recording in progress stops taking frames, as on tracking loss.
  func setCamera(_ position: CameraPosition) {
    let position = Self.supportsFrontCamera ? position : .back
    guard position != camera else { return }
    camera = position
    frameQueue.async {
      self.frontCamera = position == .front
      guard self.frontCamera else { return self.armStandby() }
      self.disarmStandby()
      guard let recording = self.recording else { return }
      recording.frozen = true
      self.live?.close(reason: "Switched to the front camera, so live streaming stopped")
    }
    if isRunning {
      isRunning = false
      runSession(reset: true)
    }
  }

  private func runSession(reset: Bool = false) {
    guard Self.supportsARKit, let session, !isRunning else { return }
    session.run(configuration(), options: reset ? [.resetTracking, .removeExistingAnchors] : [])
    isRunning = true
  }

  private func configuration() -> ARConfiguration {
    if camera == .front {
      return ARFaceTrackingConfiguration()
    }
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravity
    if Self.supportsLiDAR {
      config.frameSemantics.insert(.sceneDepth)
    }
    return config
  }

  /// Main thread only. World tracking doesn't recover from a failure by itself (e.g.
  /// after another camera client briefly took the camera), so restart it with a fresh
  /// world while the preview is on screen, backing off if it keeps failing.
  private func restartAfterFailure() {
    isRunning = false
    guard previewVisible else { return }
    consecutiveFailures += 1
    let delay = min(Double(consecutiveFailures), 5)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      guard self.previewVisible, !self.isRunning else { return }
      self.runSession(reset: true)
    }
  }

  /// Main thread only.
  private func pauseIfHidden() {
    guard !previewVisible, isRunning else { return }
    session?.pause()
    isRunning = false
  }

  // MARK: Recording

  func start(_ settings: CaptureSettings, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard Self.supportsARKit else { return completion(.failure(CaptureError.arkitUnsupported)) }
    frameQueue.async {
      guard self.recording == nil else { return completion(.failure(CaptureError.alreadyRecording)) }
      guard !self.frontCamera else { return completion(.failure(CaptureError.frontCamera)) }
      do {
        let mode: CaptureMode = Self.supportsLiDAR && !settings.forceFeaturePoints ? .lidar : .features
        let recording = try Recording(settings: settings, mode: mode)
        self.recording = recording
        if let url = settings.liveServerURL {
          // The standby connection, if it's to this server; otherwise a new one, which streams once it connects.
          if let live = self.live, !live.closed, live.sessionId == nil, live.serverURL == url, live.token == settings.serverToken {
            live.begin(sessionId: recording.id, mode: mode)
          } else {
            self.live?.close()
            self.live = LiveStreamer(serverURL: url, token: settings.serverToken, frameQueue: self.frameQueue, ciContext: self.ciContext)
            self.live?.begin(sessionId: recording.id, mode: mode)
          }
        } else {
          self.live?.close()
          self.live = nil
        }
        self.emitStatus()
        completion(.success(["captureId": recording.id, "mode": mode.rawValue]))
      } catch {
        completion(.failure(error))
      }
    }
  }

  func stop(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    frameQueue.async {
      guard let recording = self.recording else { return completion(.failure(CaptureError.notRecording)) }
      recording.stopping = true
      self.recording = nil
      // The server marks the recording's session finished when its socket closes; the next recording
      // gets a connection of its own, made now so it too starts at once.
      self.live?.close()
      self.live = nil
      self.armStandby()
      self.emitStatus()
      DispatchQueue.main.async { self.pauseIfHidden() }
      // Every frame accepted before `stopping` was already queued here, so this runs after them.
      self.writeQueue.async {
        do {
          completion(.success(try recording.finish()))
        } catch {
          completion(.failure(error))
        }
      }
    }
  }

  // MARK: Detection frames

  /// Hands the next camera frame to `completion` for object detection in JS, as an upright RGBA
  /// image whose longer side is `maxSize`. Detection reads this session's frames because iOS
  /// allows one camera session at a time. A newer request replaces a pending one, which gets nil.
  /// `zoom` crops it to the centred 1/zoom of the frame, as the zoomed preview shows it.
  func nextDetectionFrame(maxSize: Int, zoom: Double, completion: @escaping ([String: Any]?) -> Void) {
    frameQueue.async {
      self.detectionRequest?.completion(nil)
      self.detectionRequest = DetectionRequest(maxSize: maxSize, zoom: max(zoom, 1), completion: completion)
    }
  }

  /// The newest frame's pose, intrinsics and (with `includeDepth`) LiDAR depth, or nil before
  /// the first frame. Cheaper than a detection frame: no image.
  func currentCamera(includeDepth: Bool, completion: @escaping ([String: Any]?) -> Void) {
    frameQueue.async {
      let camera = self.latestCamera
      self.detectionQueue.async { completion(camera?.dictionary(includeDepth: includeDepth)) }
    }
  }

  /// ARKit delivers the camera image in the sensor's landscape orientation; turn it upright for
  /// the portrait UI (mirroring the front camera's, as its preview is), crop it to the centred
  /// 1/zoom and scale it to `maxSize`, as tightly packed RGBA rows. Cropping the full-resolution
  /// image, rather than the scaled-down one, is what makes zooming help the detector: what's zoomed
  /// in on fills more of the model's input, in up to `zoom` times as many pixels.
  private func detectionImage(from buffer: CVPixelBuffer, maxSize: Int, zoom: Double,
                              orientation: CGImagePropertyOrientation) -> [String: Any]? {
    let upright = CIImage(cvPixelBuffer: buffer).oriented(orientation)
    let extent = upright.extent
    let crop = extent.insetBy(dx: extent.width * (1 - 1 / zoom) / 2, dy: extent.height * (1 - 1 / zoom) / 2)
    let scale = CGFloat(maxSize) / max(crop.width, crop.height)
    let width = Int((crop.width * scale).rounded())
    let height = Int((crop.height * scale).rounded())
    guard width > 0, height > 0, let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    // Rendering only (0, 0, width, height) leaves out the rest of the frame.
    let image = upright
      .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
      .transformed(by: CGAffineTransform(scaleX: CGFloat(width) / crop.width,
                                         y: CGFloat(height) / crop.height))
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { bytes in
      ciContext.render(image, toBitmap: bytes.baseAddress!, rowBytes: width * 4,
                       bounds: CGRect(x: 0, y: 0, width: width, height: height),
                       format: .RGBA8, colorSpace: colorSpace)
    }
    return ["width": width, "height": height, "data": pixels, "zoom": zoom]
  }

  static func listCaptures() -> [[String: Any]] {
    library.list().map(describe)
  }

  static func deleteCapture(id: String) throws {
    guard isSafeId(id) else { return }
    try library.delete(id: id)
  }

  /// The saved zip for a capture, if there is one.
  static func zipURL(id: String) -> URL? {
    guard isSafeId(id) else { return nil }
    return library.list().first { $0.id == id }?.zip
  }

  private static func isSafeId(_ id: String) -> Bool {
    !id.isEmpty && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
  }

  /// The JS shape of a saved capture (`SavedCapture` in SplatCapture.types.ts).
  static func describe(_ capture: SavedCapture) -> [String: Any] {
    var out: [String: Any] = [
      "captureId": capture.id,
      "uri": capture.zip.absoluteString,
      "bytes": capture.bytes,
      "savedAt": ISO8601DateFormatter().string(from: capture.savedAt),
    ]
    if let s = capture.summary {
      out["mode"] = s.mode
      out["frames"] = s.frames
      out["points"] = s.points
      out["durationSeconds"] = s.durationSeconds
    }
    if let thumbnail = capture.thumbnail { out["thumbnailUri"] = thumbnail.absoluteString }
    if let video = capture.video { out["videoUri"] = video.absoluteString }
    return out
  }

  // MARK: Wi-Fi camera

  /// About this many frames a second go to the Wi-Fi camera's viewers.
  private static let streamFPS = 12.0
  /// The streamed picture's longer side, in pixels.
  private static let streamMaxSize: CGFloat = 640

  func startCameraStream(port: Int) {
    cameraServer.stillProvider = { [weak self] maxSize, done in
      self?.frameQueue.async { self?.stillRequests.append((maxSize, done)) }
    }
    cameraServer.start(port: UInt16(clamping: port))
  }

  func stopCameraStream() {
    cameraServer.stop()
  }

  /// For the UI: whether the Wi-Fi camera is up, where browsers reach it, and how many are watching.
  func cameraStreamStatus() -> [String: Any] {
    var status: [String: Any] = ["viewers": cameraServer.viewerCount]
    switch cameraServer.state {
    case .stopped: status["state"] = "stopped"
    case .starting: status["state"] = "starting"
    case .ready(let port):
      status["state"] = "ready"
      status["port"] = Int(port)
      status["urls"] = CameraStreamServer.localAddresses().map { "http://\($0):\(port)" }
    case .failed(let message):
      status["state"] = "failed"
      status["error"] = message
    }
    return status
  }

  /// The frame upright (mirrored for the front camera, as its preview is), its longer side `maxSize`
  /// (never upscaled), as a JPEG with its size.
  private func streamJPEG(_ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                          maxSize: CGFloat = streamMaxSize, quality: Double = 0.6) -> (Data, Int, Int)? {
    let upright = CIImage(cvPixelBuffer: buffer).oriented(orientation)
    let scale = min(1, maxSize / max(upright.extent.width, upright.extent.height))
    let width = (upright.extent.width * scale).rounded(.down)
    let height = (upright.extent.height * scale).rounded(.down)
    let image = upright
      .transformed(by: CGAffineTransform(translationX: -upright.extent.minX, y: -upright.extent.minY))
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ciContext.jpegRepresentation(
            of: image, colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality])
    else { return nil }
    return (jpeg, Int(width), Int(height))
  }

  // MARK: ARSessionDelegate (frameQueue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    tracking = Self.describe(frame.camera.trackingState)
    // The front camera has no world tracking, and its detection frames are mirrored, so what it
    // sees can't be placed in the world.
    latestCamera = frontCamera ? nil : DetectionCamera(frame: frame)
    if recoveringFromFailure && tracking.0 == "normal" {
      recoveringFromFailure = false
      DispatchQueue.main.async { self.consecutiveFailures = 0 }
    }
    if let recording, !recording.stopping, !recording.frozen {
      recording.preview.append(frame.capturedImage, timestamp: frame.timestamp)
    }
    if let request = detectionRequest {
      detectionRequest = nil
      let image = frame.capturedImage
      let orientation: CGImagePropertyOrientation = frontCamera ? .leftMirrored : .right
      let camera = latestCamera
      detectionQueue.async {
        var result = self.detectionImage(from: image, maxSize: request.maxSize, zoom: request.zoom,
                                         orientation: orientation)
        result?["camera"] = camera?.dictionary()
        request.completion(result)
      }
    }
    if let recording, !recording.stopping, !recording.frozen, recording.inFlight < 2,
       recording.selector.shouldKeep(timestamp: frame.timestamp,
                                     cameraToWorld: frame.camera.transform,
                                     trackingNormal: tracking.0 == "normal") {
      let job = FrameJob(frame: frame, index: recording.selector.accepted - 1, mode: recording.mode)
      recording.inFlight += 1
      writeQueue.async {
        recording.write(job, ciContext: self.ciContext)
        let written = recording.frames.count
        let points = recording.points.count
        self.frameQueue.async {
          recording.inFlight -= 1
          recording.framesWritten = written
          recording.pointCount = points
        }
      }
    }
    if let live, let recording, !recording.frozen {
      live.offer(frame, trackingNormal: tracking.0 == "normal")
    }
    if !stillRequests.isEmpty {
      let requests = stillRequests
      stillRequests = []
      let image = frame.capturedImage
      let orientation: CGImagePropertyOrientation = frontCamera ? .leftMirrored : .right
      streamQueue.async {
        for request in requests {
          request.done(self.streamJPEG(image, orientation: orientation, maxSize: CGFloat(request.maxSize), quality: 0.92)?.0)
        }
      }
    }
    if cameraServer.wantsFrames, !streamEncoding, frame.timestamp - lastStreamAt >= 1 / Self.streamFPS {
      lastStreamAt = frame.timestamp
      streamEncoding = true
      let image = frame.capturedImage
      let orientation: CGImagePropertyOrientation = frontCamera ? .leftMirrored : .right
      streamQueue.async {
        if let (jpeg, width, height) = self.streamJPEG(image, orientation: orientation) {
          self.cameraServer.publish(jpeg: jpeg, width: width, height: height)
        }
        self.frameQueue.async { self.streamEncoding = false }
      }
    }
    if frame.timestamp - lastStatusAt >= 0.25 {
      lastStatusAt = frame.timestamp
      emitStatus()
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    // A restarted session has a new world origin, so frames after it can't join a
    // recording made before it: freeze the recording at what it has.
    recording?.frozen = true
    if live?.sessionId != nil { live?.close(reason: "Tracking was lost, so live streaming stopped") }
    recoveringFromFailure = true
    emitStatus(error: error.localizedDescription)
    DispatchQueue.main.async { self.restartAfterFailure() }
  }

  private func emitStatus(error: String? = nil) {
    var status: [String: Any] = [
      "recording": recording != nil,
      "mode": (recording?.mode ?? (Self.supportsLiDAR ? .lidar : .features)).rawValue,
      "tracking": tracking.0,
      "frames": recording?.framesWritten ?? 0,
      "points": recording?.pointCount ?? 0,
      "elapsed": recording.map { Date().timeIntervalSince($0.startedAt) } ?? 0,
      "full": recording?.selector.isFull ?? false,
      "frozen": recording?.frozen ?? false,
    ]
    if let reason = tracking.1 { status["trackingReason"] = reason }
    if let live { status["live"] = live.status }
    if let error { status["error"] = error }
    onStatus?(status)
  }

  private static func describe(_ state: ARCamera.TrackingState) -> (String, String?) {
    switch state {
    case .normal: return ("normal", nil)
    case .notAvailable: return ("notAvailable", nil)
    case .limited(let reason):
      switch reason {
      case .excessiveMotion: return ("limited", "excessiveMotion")
      case .insufficientFeatures: return ("limited", "insufficientFeatures")
      case .initializing: return ("limited", "initializing")
      case .relocalizing: return ("limited", "relocalizing")
      @unknown default: return ("limited", "unknown")
      }
    }
  }
}

private struct DetectionRequest {
  let maxSize: Int
  let zoom: Double
  let completion: ([String: Any]?) -> Void
}

/// Where the camera was when a detection frame was taken, so JS can place what it detects in
/// the world: the pose, the intrinsics of the sensor-oriented image (the detection frame is that
/// image turned upright with `.oriented(.right)` and scaled), and the LiDAR depth when there is
/// some. Holds the frame's buffers, not the ARFrame, which ARKit warns about retaining.
private struct DetectionCamera {
  let timestamp: TimeInterval
  let cameraToWorld: simd_float4x4
  let intrinsics: PinholeIntrinsics
  let trackingNormal: Bool
  let depth: CVPixelBuffer?
  let confidence: CVPixelBuffer?

  init(frame: ARFrame) {
    timestamp = frame.timestamp
    cameraToWorld = frame.camera.transform
    intrinsics = PinholeIntrinsics(arkit: frame.camera.intrinsics,
                                   width: CVPixelBufferGetWidth(frame.capturedImage),
                                   height: CVPixelBufferGetHeight(frame.capturedImage))
    if case .normal = frame.camera.trackingState {
      trackingNormal = true
    } else {
      trackingNormal = false
    }
    depth = frame.sceneDepth?.depthMap
    confidence = frame.sceneDepth?.confidenceMap
  }

  /// The JS shape (`DetectionCamera` in SplatCapture.types.ts). Copies the depth rows, so call it
  /// off the AR frame queue.
  func dictionary(includeDepth: Bool = true) -> [String: Any] {
    var out: [String: Any] = [
      "timestamp": timestamp,
      "pose": LiveStreamer.columnMajor(cameraToWorld).map { Double($0) },
      "intrinsics": [
        "fx": Double(intrinsics.fx), "fy": Double(intrinsics.fy),
        "cx": Double(intrinsics.cx), "cy": Double(intrinsics.cy),
        "width": intrinsics.width, "height": intrinsics.height,
      ] as [String: Any],
      "trackingNormal": trackingNormal,
    ]
    if includeDepth, let depth {
      let width = CVPixelBufferGetWidth(depth)
      let height = CVPixelBufferGetHeight(depth)
      let metres: [Float32] = copyRows(depth, width: width, height: height)
      var depthOut: [String: Any] = [
        "width": width,
        "height": height,
        "data": metres.withUnsafeBytes { Data($0) },
      ]
      if let confidence {
        let levels: [UInt8] = copyRows(confidence, width: width, height: height)
        depthOut["confidence"] = Data(levels)
      }
      out["depth"] = depthOut
    }
    return out
  }
}

/// What the write queue needs from one ARFrame. Holding these buffers (not the
/// ARFrame itself) keeps ARKit from warning about retained frames.
private struct FrameJob {
  let index: Int
  let image: CVPixelBuffer
  let cameraToWorld: simd_float4x4
  let intrinsics: PinholeIntrinsics
  let depth: CVPixelBuffer?
  let confidence: CVPixelBuffer?
  let featurePoints: [SIMD3<Float>]
  let featureIDs: [UInt64]

  init(frame: ARFrame, index: Int, mode: CaptureMode) {
    self.index = index
    image = frame.capturedImage
    cameraToWorld = frame.camera.transform
    intrinsics = PinholeIntrinsics(arkit: frame.camera.intrinsics,
                                   width: CVPixelBufferGetWidth(frame.capturedImage),
                                   height: CVPixelBufferGetHeight(frame.capturedImage))
    depth = mode == .lidar ? frame.sceneDepth?.depthMap : nil
    confidence = mode == .lidar ? frame.sceneDepth?.confidenceMap : nil
    featurePoints = mode == .features ? frame.rawFeaturePoints?.points ?? [] : []
    featureIDs = mode == .features ? frame.rawFeaturePoints?.identifiers ?? [] : []
  }
}

private final class Recording {
  let id: String
  /// Named after the capture, so the saved zip unpacks to `<id>/transforms.json` etc.
  let dataset: URL
  let mode: CaptureMode
  let settings: CaptureSettings
  let startedAt = Date()

  // frameQueue
  var selector: FrameSelector
  var inFlight = 0
  var stopping = false
  /// Tracking failed mid-recording; later frames would be in a different world frame.
  var frozen = false
  var framesWritten = 0
  var pointCount = 0

  // writeQueue
  var frames: [DatasetFrame] = []
  var points: PointCloudAccumulator
  /// The first frame, small and upright, saved beside the zip for the gallery button.
  var thumbnail: Data?

  /// The whole recording as a small video for the gallery, fed on frameQueue and finished on writeQueue.
  let preview: PreviewRecorder

  init(settings: CaptureSettings, mode: CaptureMode) throws {
    let stamp = ISO8601DateFormatter().string(from: Date()).filter { $0.isNumber }
    id = "capture-\(stamp)-\(UUID().uuidString.prefix(4).lowercased())"
    dataset = CaptureController.workDirectory.appendingPathComponent(id)
    preview = PreviewRecorder(url: CaptureController.workDirectory.appendingPathComponent("\(id).mp4"))
    self.mode = mode
    self.settings = settings
    selector = FrameSelector(config: FrameSelectorConfig(maxFrames: settings.maxFrames))
    // LiDAR is dense, so dedupe on a 2 cm grid; feature points are keyed by ARKit id instead.
    points = PointCloudAccumulator(voxelSize: 0.02, capacity: mode == .lidar ? 300_000 : 100_000)
    try FileManager.default.createDirectory(at: dataset.appendingPathComponent("images"), withIntermediateDirectories: true)
  }

  func write(_ job: FrameJob, ciContext: CIContext) {
    addPoints(from: job)
    let srcW = CVPixelBufferGetWidth(job.image)
    let srcH = CVPixelBufferGetHeight(job.image)
    let outW = min(settings.imageWidth, srcW)
    let outH = Int((Double(srcH) * Double(outW) / Double(srcW)).rounded())
    let image = CIImage(cvPixelBuffer: job.image)
      .transformed(by: CGAffineTransform(scaleX: CGFloat(outW) / CGFloat(srcW), y: CGFloat(outH) / CGFloat(srcH)))
      .cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
    let name = String(format: "images/frame_%05d.jpg", job.index)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ciContext.jpegRepresentation(
            of: image, colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85]),
          (try? jpeg.write(to: dataset.appendingPathComponent(name))) != nil
    else { return }
    frames.append(DatasetFrame(filePath: name, cameraToWorld: job.cameraToWorld,
                               intrinsics: job.intrinsics.scaled(toWidth: outW, height: outH)))
    if thumbnail == nil {
      thumbnail = Self.thumbnail(of: job.image, colorSpace: colorSpace, ciContext: ciContext)
    }
  }

  /// The frame turned upright for the portrait UI (ARKit's sensor is landscape), its longer side
  /// `maxSize`, as a JPEG.
  private static func thumbnail(of buffer: CVPixelBuffer, maxSize: CGFloat = 360, colorSpace: CGColorSpace,
                                ciContext: CIContext) -> Data? {
    let upright = CIImage(cvPixelBuffer: buffer).oriented(.right)
    let scale = maxSize / max(upright.extent.width, upright.extent.height)
    let image = upright
      .transformed(by: CGAffineTransform(translationX: -upright.extent.minX, y: -upright.extent.minY))
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .cropped(to: CGRect(x: 0, y: 0, width: (upright.extent.width * scale).rounded(.down),
                          height: (upright.extent.height * scale).rounded(.down)))
    return ciContext.jpegRepresentation(
      of: image, colorSpace: colorSpace,
      options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])
  }

  private func addPoints(from job: FrameJob) {
    CVPixelBufferLockBaseAddress(job.image, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(job.image, .readOnly) }
    guard let image = YCbCrImage(lockedPixelBuffer: job.image) else { return }

    switch mode {
    case .features:
      for (point, id) in zip(job.featurePoints, job.featureIDs) {
        guard let pixel = CaptureMath.project(point, cameraToWorld: job.cameraToWorld, intrinsics: job.intrinsics),
              let color = image.rgb(x: pixel.x, y: pixel.y) else { continue }
        points.insert(ColoredPoint(position: point, color: color), key: id, replace: true)
      }
    case .lidar:
      guard let depthMap = job.depth else { return }
      let width = CVPixelBufferGetWidth(depthMap)
      let height = CVPixelBufferGetHeight(depthMap)
      let depth: [Float32] = copyRows(depthMap, width: width, height: height)
      let confidence: [UInt8]? = job.confidence.map { copyRows($0, width: width, height: height) }
      let samples = depth.withUnsafeBufferPointer { d in
        withOptionalBuffer(confidence) { c in
          DepthUnprojection.worldSamples(depth: d, confidence: c, width: width, height: height,
                                         imageIntrinsics: job.intrinsics, cameraToWorld: job.cameraToWorld)
        }
      }
      for sample in samples {
        guard let color = image.rgb(x: sample.imagePixel.x, y: sample.imagePixel.y) else { continue }
        points.insertVoxelDeduplicated(ColoredPoint(position: sample.world, color: color))
      }
    }
  }

  /// Writes transforms.json, points.ply and capture.json, then saves the dataset as a zip, with the
  /// preview video beside it.
  func finish() throws -> [String: Any] {
    let video = preview.finish()
    defer {
      try? FileManager.default.removeItem(at: dataset)
      // Moved into the library unless saving failed.
      try? FileManager.default.removeItem(at: preview.url)
    }
    guard !frames.isEmpty else { throw CaptureError.noFrames }
    let plyName: String? = points.count > 0 ? "points.ply" : nil
    if let plyName {
      try DatasetWriter.pointCloudPLY(points.points).write(to: dataset.appendingPathComponent(plyName))
    }
    try DatasetWriter.transformsJSON(frames: frames, plyFilePath: plyName)
      .write(to: dataset.appendingPathComponent("transforms.json"))
    let summary = CaptureSummary(
      captureId: id, mode: mode.rawValue, frames: frames.count, points: points.count,
      durationSeconds: Date().timeIntervalSince(startedAt),
      createdAt: ISO8601DateFormatter().string(from: startedAt),
      device: hardwareModel(), systemVersion: ProcessInfo.processInfo.operatingSystemVersionString)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(summary).write(to: dataset.appendingPathComponent("capture.json"))
    return CaptureController.describe(
      try CaptureController.library.save(dataset: dataset, summary: summary, thumbnail: thumbnail, video: video))
  }
}

/// e.g. "iPhone14,4" — readable from any thread, unlike UIDevice.
func hardwareModel() -> String {
  var info = utsname()
  uname(&info)
  return withUnsafeBytes(of: info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
}

/// Copies a single-plane pixel buffer into a tightly packed row-major array,
/// dropping any row padding.
func copyRows<T>(_ buffer: CVPixelBuffer, width: Int, height: Int) -> [T] {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
  let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
  var out = [T]()
  out.reserveCapacity(width * height)
  for row in 0..<height {
    let rowStart = base.advanced(by: row * bytesPerRow).assumingMemoryBound(to: T.self)
    out.append(contentsOf: UnsafeBufferPointer(start: rowStart, count: width))
  }
  return out
}

private func withOptionalBuffer<T, R>(_ array: [T]?, _ body: (UnsafeBufferPointer<T>?) -> R) -> R {
  guard let array else { return body(nil) }
  return array.withUnsafeBufferPointer { body($0) }
}

extension YCbCrImage {
  /// The caller must hold the buffer's base-address lock while using the image.
  init?(lockedPixelBuffer buffer: CVPixelBuffer) {
    guard CVPixelBufferGetPlaneCount(buffer) >= 2,
          let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
          let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) else { return nil }
    self.init(width: CVPixelBufferGetWidthOfPlane(buffer, 0),
              height: CVPixelBufferGetHeightOfPlane(buffer, 0),
              luma: UnsafePointer(luma.assumingMemoryBound(to: UInt8.self)),
              lumaBytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0),
              chroma: UnsafePointer(chroma.assumingMemoryBound(to: UInt8.self)),
              chromaBytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(buffer, 1))
  }
}
