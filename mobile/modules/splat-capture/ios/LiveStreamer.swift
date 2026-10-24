import ARKit
import CoreImage

/// Streams a recording to the live reconstruction on the splat server (frontend/src/live) while it
/// records, so a browser can watch the scene being rebuilt: a keyframe whenever the phone has
/// moved enough (a 640×480 JPEG with its pose and intrinsics, plus the feature points ARKit sees
/// in it, or LiDAR depth), and the pose about 15 times a second so the viewer can draw the phone
/// moving. The wire format is described in frontend/src/live/protocol.ts.
///
/// `offer` runs on the capture's frame queue and only picks frames and grabs their buffers;
/// encoding happens on `encodeQueue`, with at most two keyframes in flight, so a slow network
/// drops keyframes instead of holding on to ARKit's camera buffers.
final class LiveStreamer: NSObject, URLSessionWebSocketDelegate {
  private static let imageWidth = 640

  /// Where it streams to, so a connection made ahead of a recording can serve one to the same server.
  let serverURL: URL
  let token: String?
  private let endpoint: URL
  /// The recording being streamed; nil while standing by, connected before a recording so one streams from its first frame.
  private(set) var sessionId: String?
  private var mode: CaptureMode?
  /// The owner's frame queue; every `var` below is only touched on it.
  private let frameQueue: DispatchQueue
  private let encodeQueue = DispatchQueue(label: "soon2026.splatcapture.live", qos: .userInitiated)
  private let ciContext: CIContext
  private var urlSession: URLSession!

  private var task: URLSessionWebSocketTask?
  private var state = "connecting"
  private var error: String?
  private(set) var closed = false
  /// Denser than the dataset's selection: the reconstruction wants overlapping views.
  private static let steadyConfig = FrameSelectorConfig(
    minInterval: 0.2, maxInterval: 1.0, minTranslation: 0.03, minRotation: 3 * .pi / 180, maxFrames: .max)
  /// Until the server has fused a keyframe, they go faster: the first ones are often skipped (too few
  /// feature points in view to pin the depth's scale), and each wait would otherwise be a full second.
  private static let eagerConfig = FrameSelectorConfig(
    minInterval: 0.2, maxInterval: 0.3, minTranslation: 0.03, minRotation: 3 * .pi / 180, maxFrames: .max)
  private var selector = FrameSelector(config: LiveStreamer.steadyConfig)
  private var eagerSelector = FrameSelector(config: LiveStreamer.eagerConfig)
  private var inFlight = 0
  private var sequence = 0
  private var sent = 0
  private var lastPoseAt: TimeInterval = 0
  /// The server's latest `stats` message for this session.
  private var serverStats: [String: Any] = [:]

  /// `serverURL` is the splat server's address (e.g. https://<project>.vercel.app), `token` its access token.
  /// Connects at once and stands by; `begin` starts streaming a recording.
  init?(serverURL: URL, token: String?, frameQueue: DispatchQueue, ciContext: CIContext) {
    guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false),
          components.scheme == "http" || components.scheme == "https" else { return nil }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).isEmpty
      ? "/live/ingest"
      : "/" + components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/live/ingest"
    guard let endpoint = components.url else { return nil }
    self.serverURL = serverURL
    self.endpoint = endpoint
    self.token = token
    self.frameQueue = frameQueue
    self.ciContext = ciContext
    super.init()
    // Not `.default`: development builds swizzle it to add Expo's network-inspector URLProtocol,
    // which answers the WebSocket upgrade itself and fails it ("Connection not set before response
    // is received"). The session holds its delegate strongly until `close` invalidates it.
    urlSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    frameQueue.async { self.connect() }
  }

  /// Status for the capture screen (`LiveStatus` in SplatCapture.types.ts). Frame queue only.
  var status: [String: Any] {
    var status: [String: Any] = [
      "state": state,
      "standby": sessionId == nil,
      "sent": sent,
      "fused": serverStats["fused"] as? Int ?? 0,
      "skipped": serverStats["skipped"] as? Int ?? 0,
      "points": serverStats["voxels"] as? Int ?? 0,
    ]
    if let error { status["error"] = error }
    if let lastSkip = serverStats["lastSkip"] as? String { status["lastSkip"] = lastSkip }
    return status
  }

  /// Frame queue only. Starts streaming a recording: over the standby connection if it's open (the
  /// hello goes at once), else as soon as it connects.
  func begin(sessionId: String, mode: CaptureMode) {
    self.sessionId = sessionId
    self.mode = mode
    selector = FrameSelector(config: Self.steadyConfig)
    eagerSelector = FrameSelector(config: Self.eagerConfig)
    inFlight = 0
    sequence = 0
    sent = 0
    lastPoseAt = 0
    serverStats = [:]
    if state == "open", let task { sendHello(on: task) }
  }

  /// Frame queue only. Sends the pose, and the frame as a keyframe if the phone has moved enough.
  func offer(_ frame: ARFrame, trackingNormal: Bool) {
    guard !closed, state == "open", let task, sessionId != nil, let mode, trackingNormal else { return }
    if frame.timestamp - lastPoseAt >= 1.0 / 15 {
      lastPoseAt = frame.timestamp
      if let message = Self.message(["type": "pose", "t": frame.timestamp, "pose": Self.columnMajor(frame.camera.transform)]) {
        task.send(.data(message)) { _ in }
      }
    }
    guard inFlight < 2 else { return }
    let fusedYet = (serverStats["fused"] as? Int ?? 0) > 0
    let keep = fusedYet
      ? selector.shouldKeep(timestamp: frame.timestamp, cameraToWorld: frame.camera.transform, trackingNormal: true)
      : eagerSelector.shouldKeep(timestamp: frame.timestamp, cameraToWorld: frame.camera.transform, trackingNormal: true)
    guard keep else { return }
    inFlight += 1
    sequence += 1
    let keyframe = LiveKeyframe(frame: frame, sequence: sequence, mode: mode)
    encodeQueue.async {
      let message = keyframe.encode(ciContext: self.ciContext, width: Self.imageWidth)
      self.frameQueue.async {
        guard let message, task === self.task else {
          self.inFlight = max(0, self.inFlight - 1)
          return
        }
        task.send(.data(message)) { error in
          self.frameQueue.async {
            self.inFlight = max(0, self.inFlight - 1)
            if error == nil { self.sent += 1 }
          }
        }
      }
    }
  }

  /// Frame queue only. Stops streaming for good; `reason` is shown if it's not a normal stop.
  func close(reason: String? = nil) {
    guard !closed else { return }
    closed = true
    state = "closed"
    if let reason { error = reason }
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    urlSession.finishTasksAndInvalidate()
  }

  // MARK: Connection (frame queue)

  private func connect() {
    guard !closed else { return }
    state = "connecting"
    var request = URLRequest(url: endpoint)
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let task = urlSession.webSocketTask(with: request)
    self.task = task
    task.resume()
  }

  /// A dropped connection (Wi-Fi blip, server restart, or the server's 5-minute socket limit) is
  /// retried; the server picks the session back up by its id, so the cloud carries on where it was.
  private func connectionLost(_ task: URLSessionTask, reason: String) {
    guard task === self.task, !closed else { return }
    self.task = nil
    state = "reconnecting"
    error = reason
    inFlight = 0
    frameQueue.asyncAfter(deadline: .now() + 2) { self.connect() }
  }

  private func receive(on task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, case .success(let message) = result else { return }
      if case .string(let text) = message,
         let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
        self.frameQueue.async {
          if json["type"] as? String == "stats", let stats = json["stats"] as? [String: Any] {
            self.serverStats = stats
          } else if json["type"] as? String == "error" {
            self.error = json["message"] as? String
          }
        }
      }
      self.receive(on: task)
    }
  }

  // MARK: URLSessionWebSocketDelegate (URLSession's queue)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    frameQueue.async {
      guard webSocketTask === self.task, !self.closed else { return }
      self.state = "open"
      self.error = nil
      // Standing by, there's no recording to announce yet; `begin` sends it.
      self.sendHello(on: webSocketTask)
      self.receive(on: webSocketTask)
    }
  }

  /// Frame queue only. Announces the recording to the server, which starts (or picks back up) its session.
  private func sendHello(on task: URLSessionWebSocketTask) {
    guard let sessionId, let mode,
          let hello = Self.message(["type": "hello", "session": sessionId, "mode": mode.rawValue, "device": hardwareModel()])
    else { return }
    task.send(.data(hello)) { _ in }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    let text = reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
    frameQueue.async { self.connectionLost(webSocketTask, reason: text.isEmpty ? "The server closed the connection" : text) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    frameQueue.async {
      self.connectionLost(task, reason: error?.localizedDescription ?? "The connection closed")
    }
  }

  // MARK: Encoding

  /// A u32 little-endian header length, the JSON header, then the payload.
  static func message(_ header: [String: Any], payload: [Data] = []) -> Data? {
    guard let json = try? JSONSerialization.data(withJSONObject: header) else { return nil }
    var data = Data(capacity: 4 + json.count + payload.reduce(0) { $0 + $1.count })
    withUnsafeBytes(of: UInt32(json.count).littleEndian) { data.append(contentsOf: $0) }
    data.append(json)
    payload.forEach { data.append($0) }
    return data
  }

  /// simd matrices are column-major, which is also what the server and three.js expect.
  static func columnMajor(_ m: simd_float4x4) -> [Float] {
    (0..<4).flatMap { column in (0..<4).map { row in m[column][row] } }
  }
}

/// What the encode queue needs from one ARFrame (its buffers, not the frame itself, which ARKit
/// warns about retaining).
private struct LiveKeyframe {
  let sequence: Int
  let timestamp: TimeInterval
  let image: CVPixelBuffer
  let cameraToWorld: simd_float4x4
  let intrinsics: PinholeIntrinsics
  let featurePoints: [SIMD3<Float>]
  let depth: CVPixelBuffer?
  let confidence: CVPixelBuffer?

  init(frame: ARFrame, sequence: Int, mode: CaptureMode) {
    self.sequence = sequence
    timestamp = frame.timestamp
    image = frame.capturedImage
    cameraToWorld = frame.camera.transform
    intrinsics = PinholeIntrinsics(arkit: frame.camera.intrinsics,
                                   width: CVPixelBufferGetWidth(frame.capturedImage),
                                   height: CVPixelBufferGetHeight(frame.capturedImage))
    // LiDAR depth is metric already; without it, the server scales its depth model to these.
    featurePoints = mode == .features ? frame.rawFeaturePoints?.points ?? [] : []
    depth = mode == .lidar ? frame.sceneDepth?.depthMap : nil
    confidence = mode == .lidar ? frame.sceneDepth?.confidenceMap : nil
  }

  func encode(ciContext: CIContext, width outW: Int) -> Data? {
    let srcW = CVPixelBufferGetWidth(image)
    let srcH = CVPixelBufferGetHeight(image)
    let outH = Int((Double(srcH) * Double(outW) / Double(srcW)).rounded())
    let scaled = CIImage(cvPixelBuffer: image)
      .transformed(by: CGAffineTransform(scaleX: CGFloat(outW) / CGFloat(srcW), y: CGFloat(outH) / CGFloat(srcH)))
      .cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ciContext.jpegRepresentation(
            of: scaled, colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7])
    else { return nil }
    let k = intrinsics.scaled(toWidth: outW, height: outH)
    var header: [String: Any] = [
      "type": "keyframe",
      "seq": sequence,
      "t": timestamp,
      "pose": LiveStreamer.columnMajor(cameraToWorld),
      "intrinsics": ["fx": k.fx, "fy": k.fy, "cx": k.cx, "cy": k.cy, "width": k.width, "height": k.height],
      "jpegBytes": jpeg.count,
    ]
    var payload = [jpeg]
    if let depth {
      let w = CVPixelBufferGetWidth(depth)
      let h = CVPixelBufferGetHeight(depth)
      let metres: [Float32] = copyRows(depth, width: w, height: h)
      payload.append(metres.withUnsafeBytes { Data($0) })
      if let confidence {
        let levels: [UInt8] = copyRows(confidence, width: w, height: h)
        payload.append(Data(levels))
      }
      header["depth"] = ["width": w, "height": h, "confidence": confidence != nil]
    } else {
      // Millimetres are plenty, and keep the JSON short.
      header["anchors"] = featurePoints.flatMap { p in [p.x, p.y, p.z].map { (Double($0) * 1000).rounded() / 1000 } }
    }
    return LiveStreamer.message(header, payload: payload)
  }
}
