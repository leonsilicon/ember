import ARKit
import CoreImage

enum CaptureMode: String {
  /// LiDAR depth seeds the splat (Pro iPhones / iPads).
  case lidar
  /// No LiDAR: ARKit's tracked feature points seed it instead (any ARKit iPhone).
  case features
}

enum CaptureError: LocalizedError {
  case arkitUnsupported
  case alreadyRecording
  case notRecording
  case noFrames

  var errorDescription: String? {
    switch self {
    case .arkitUnsupported: return "This device doesn't support ARKit world tracking."
    case .alreadyRecording: return "A capture is already recording."
    case .notRecording: return "No capture is recording."
    case .noFrames: return "No frames were kept. Move the phone slowly around the subject and keep it tracking (not 'limited')."
    }
  }
}

struct CaptureSettings {
  var maxFrames = 300
  var imageWidth = 1280
  var forceFeaturePoints = false
  /// Splat server to stream the recording to for live reconstruction (see LiveStreamer), if any.
  var liveServerURL: URL? = nil
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
  private let ciContext = CIContext()
  private weak var session: ARSession?
  // main-thread state
  private var isRunning = false
  private var previewVisible = false
  private var consecutiveFailures = 0

  // frameQueue state
  private var recording: Recording?
  private var live: LiveStreamer?
  private var detectionRequest: DetectionRequest?
  private var recoveringFromFailure = false
  private var lastStatusAt: TimeInterval = 0
  private var tracking = ("notAvailable", nil as String?)

  static var supportsARKit: Bool { ARWorldTrackingConfiguration.isSupported }
  static var supportsLiDAR: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }

  static func capabilities() -> [String: Any] {
    ["arkit": supportsARKit, "lidar": supportsLiDAR]
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
    } else {
      frameQueue.async {
        guard self.recording == nil else { return }
        DispatchQueue.main.async { self.pauseIfHidden() }
      }
    }
  }

  private func runSession(reset: Bool = false) {
    guard Self.supportsARKit, let session, !isRunning else { return }
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravity
    if Self.supportsLiDAR {
      config.frameSemantics.insert(.sceneDepth)
    }
    session.run(config, options: reset ? [.resetTracking, .removeExistingAnchors] : [])
    isRunning = true
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
      do {
        let mode: CaptureMode = Self.supportsLiDAR && !settings.forceFeaturePoints ? .lidar : .features
        let recording = try Recording(settings: settings, mode: mode)
        self.recording = recording
        self.live = settings.liveServerURL.flatMap {
          LiveStreamer(serverURL: $0, sessionId: recording.id, mode: mode, frameQueue: self.frameQueue,
                       ciContext: self.ciContext)
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
      self.live?.close()
      self.live = nil
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
  func nextDetectionFrame(maxSize: Int, completion: @escaping ([String: Any]?) -> Void) {
    frameQueue.async {
      self.detectionRequest?.completion(nil)
      self.detectionRequest = DetectionRequest(maxSize: maxSize, completion: completion)
    }
  }

  /// ARKit delivers the camera image in the sensor's landscape orientation; turn it upright for
  /// the portrait UI and scale it down, as tightly packed RGBA rows.
  private func detectionImage(from buffer: CVPixelBuffer, maxSize: Int) -> [String: Any]? {
    let upright = CIImage(cvPixelBuffer: buffer).oriented(.right)
    let scale = CGFloat(maxSize) / max(upright.extent.width, upright.extent.height)
    let width = Int((upright.extent.width * scale).rounded())
    let height = Int((upright.extent.height * scale).rounded())
    guard width > 0, height > 0, let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let image = upright
      .transformed(by: CGAffineTransform(translationX: -upright.extent.minX, y: -upright.extent.minY))
      .transformed(by: CGAffineTransform(scaleX: CGFloat(width) / upright.extent.width,
                                         y: CGFloat(height) / upright.extent.height))
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { bytes in
      ciContext.render(image, toBitmap: bytes.baseAddress!, rowBytes: width * 4,
                       bounds: CGRect(x: 0, y: 0, width: width, height: height),
                       format: .RGBA8, colorSpace: colorSpace)
    }
    return ["width": width, "height": height, "data": pixels]
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
    return out
  }

  // MARK: ARSessionDelegate (frameQueue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    tracking = Self.describe(frame.camera.trackingState)
    if recoveringFromFailure && tracking.0 == "normal" {
      recoveringFromFailure = false
      DispatchQueue.main.async { self.consecutiveFailures = 0 }
    }
    if let request = detectionRequest {
      detectionRequest = nil
      let image = frame.capturedImage
      detectionQueue.async { request.completion(self.detectionImage(from: image, maxSize: request.maxSize)) }
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
    if frame.timestamp - lastStatusAt >= 0.25 {
      lastStatusAt = frame.timestamp
      emitStatus()
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    // A restarted session has a new world origin, so frames after it can't join a
    // recording made before it: freeze the recording at what it has.
    recording?.frozen = true
    live?.close(reason: "Tracking was lost, so live streaming stopped")
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
  let completion: ([String: Any]?) -> Void
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

  init(settings: CaptureSettings, mode: CaptureMode) throws {
    let stamp = ISO8601DateFormatter().string(from: Date()).filter { $0.isNumber }
    id = "capture-\(stamp)-\(UUID().uuidString.prefix(4).lowercased())"
    dataset = CaptureController.workDirectory.appendingPathComponent(id)
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

  /// Writes transforms.json, points.ply and capture.json, then saves the dataset as a zip.
  func finish() throws -> [String: Any] {
    defer { try? FileManager.default.removeItem(at: dataset) }
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
    return CaptureController.describe(try CaptureController.library.save(dataset: dataset, summary: summary))
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
