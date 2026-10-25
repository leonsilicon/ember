import Foundation
import Network

/// Serves the phone's camera to browsers on the same Wi-Fi, so the web app's live mode can show what
/// the rover sees. Plain HTTP, three routes, all with `Access-Control-Allow-Origin: *`:
///
/// - `GET /camera.mjpg`: the live picture as MJPEG (`multipart/x-mixed-replace`), which an `<img>`
///   plays as it arrives;
/// - `GET /frame.jpg`: the newest frame once (503 before the first); with `?size=N`, a still encoded fresh
///   from the camera, its longer side N pixels, at high quality (via `stillProvider`), for capturing;
/// - `GET /status`: JSON `{ id, device, recording, viewers, frames, width, height }`, to check the phone
///   is reachable (and, for a phone in remote mode, whether this one is the one recording);
/// - `GET /detections`: the leaf detector's boxes as they come (newline-delimited JSON, one line per
///   detector frame, the newest first on connect), for drawing over the picture as the phone does.
///
/// While running it advertises itself on the network with Bonjour as `_rovercam._tcp` (see `serviceType`),
/// so the web app's dev server, and the app on another phone in remote mode (`CameraStreamBrowser`), can
/// find the phone and link up without anyone typing an address. Its TXT record carries `id`, so the app
/// can leave its own server out.
///
/// The owner calls `publish(jpeg:)` with each new frame, and can skip encoding while `wantsFrames` is
/// false (nobody is watching). A viewer still sending its previous frame skips the new one, so a slow
/// browser gets fewer frames rather than a growing backlog.
public final class CameraStreamServer {
  public static let defaultPort: UInt16 = 8787
  /// The Bonjour service type the web app's dev server looks for (and Info.plist's NSBonjourServices lists).
  public static let serviceType = "_rovercam._tcp"

  public enum State: Equatable {
    case stopped
    case starting
    case ready(port: UInt16)
    /// iOS's Local Network privacy setting is off for the app: nothing on the Wi-Fi can find or reach
    /// it. Clears by itself (back to `ready`) once the user turns it on.
    case blocked
    case failed(String)
  }

  /// Called on the server's queue whenever `state` changes.
  public var onStateChange: ((State) -> Void)?
  /// Encodes a still of the current camera frame, its longer side the given size, and calls back with
  /// the JPEG (nil if there's no frame). Serves `/frame.jpg?size=N`. Called on the server's queue.
  public var stillProvider: ((_ maxSize: Int, _ done: @escaping (Data?) -> Void) -> Void)?
  /// A still request answered by nobody in this long gets a 503 (the camera isn't running).
  public static let stillTimeout: TimeInterval = 3

  private let queue = DispatchQueue(label: "soon2026.camera-stream-server")
  private let device: String
  /// Stays the same for this install while its address changes (Wi-Fi hands out new ones), so the web app
  /// can recognise the phone it used last. In the Bonjour TXT record and `/status`.
  public let id: String
  private var listener: NWListener?
  /// The port `start` was given, until `stop`: where a listener cut off from Bonjour starts over.
  private var port: UInt16?
  /// Times in a row the listener has started over (see `canRetry`); 1 s, 2 s, 4 s… apart.
  private var retries = 0
  private static let maxRetries = 5
  private var viewers: [ObjectIdentifier: Viewer] = [:]
  private var latest: Data?
  /// The newest detections line (JSON, no newline), sent first to each `/detections` viewer.
  private var latestDetections: Data?
  private var latestSize: (width: Int, height: Int) = (0, 0)
  private var frames = 0
  private var _state = State.stopped
  /// Read from any thread: whether anyone is watching the stream.
  private let watching = ManagedAtomicFlag()
  private let recordingFlag = ManagedAtomicFlag()

  /// `device` is reported by `/status` (e.g. "iPhone 15 Pro").
  public init(device: String, id: String) {
    self.device = device
    self.id = id
  }

  /// Whether the phone is recording, for `/status`. Safe from any thread.
  public var recording: Bool {
    get { recordingFlag.value }
    set { recordingFlag.value = newValue }
  }

  public var state: State { queue.sync { _state } }

  /// True while at least one browser has `/camera.mjpg` open. Cheap; safe from any thread.
  public var wantsFrames: Bool { watching.value }

  /// Starts listening on `port` (0 picks a free one; see `state` for which). Restarts if already running.
  public func start(port: UInt16 = defaultPort) {
    queue.async { [self] in
      self.retries = 0
      self.listen(on: port)
    }
  }

  /// On the queue.
  private func listen(on port: UInt16) {
    stopListening()
    self.port = port
    setState(.starting)
    do {
      let parameters = NWParameters.tcp
      parameters.allowLocalEndpointReuse = true
      let listener = try NWListener(using: parameters, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
      // The TXT record says which device it is; Bonjour renames the service if the name is taken.
      let txt = NWTXTRecord(["device": device, "id": id, "path": "/camera.mjpg"])
      listener.service = NWListener.Service(name: "Rover camera (\(device))", type: Self.serviceType,
                                            txtRecord: txt)
      listener.stateUpdateHandler = { [weak self, weak listener] state in
        guard let self, let listener, listener === self.listener else { return }
        switch state {
        case .ready:
          self.retries = 0
          self.setState(.ready(port: listener.port?.rawValue ?? port))
        case .waiting(let error) where self.canRetry(error), .failed(let error) where self.canRetry(error):
          // iOS cuts a suspended app off from Bonjour, and the listener never recovers; the new one can
          // find the old one's port still taken for a moment. Start over, waiting longer each time.
          self.stopListening()
          self.setState(.starting)
          self.retries += 1
          self.queue.asyncAfter(deadline: .now() + .seconds(1 << (self.retries - 1))) {
            guard self.listener == nil, let port = self.port else { return }
            self.listen(on: port)
          }
        case .waiting(let error): self.setState(Self.state(waitingOn: error))
        case .failed(let error):
          self.setState(.failed(error.localizedDescription))
          self.stopListening()
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
      self.listener = listener
      listener.start(queue: queue)
    } catch {
      setState(.failed(error.localizedDescription))
    }
  }

  public func stop() {
    queue.async {
      self.stopListening()
      self.port = nil
      self.setState(.stopped)
    }
  }

  /// What a listener stuck waiting on `error` means for the UI. Bonjour refusing to advertise with
  /// kDNSServiceErr_PolicyDenied is iOS's Local Network privacy setting being off for the app.
  static func state(waitingOn error: NWError) -> State {
    if case .dns(let code) = error, code == -65570 { return .blocked }
    return .failed(error.localizedDescription)
  }

  /// kDNSServiceErr_DefunctConnection: iOS closed the app's connection to Bonjour, as it does while the
  /// app is suspended. The listener or browser has to be made again.
  static func isDefunct(_ error: NWError) -> Bool {
    if case .dns(let code) = error { return code == -65569 }
    return false
  }

  /// Whether a listener that stopped on `error` should start over by itself: cut off from Bonjour, or
  /// (starting over after that) the port not free yet, a few times before saying so.
  private func canRetry(_ error: NWError) -> Bool {
    guard retries < Self.maxRetries else { return false }
    if case .posix(.EADDRINUSE) = error { return true }
    return Self.isDefunct(error)
  }

  /// A new camera frame: kept for `/frame.jpg` and sent to every viewer that's ready for one.
  public func publish(jpeg: Data, width: Int, height: Int) {
    queue.async {
      self.latest = jpeg
      self.latestSize = (width, height)
      self.frames += 1
      for viewer in self.viewers.values where viewer.streaming && !viewer.sending {
        self.send(jpeg, to: viewer)
      }
    }
  }

  /// The phone's IPv4 addresses that other devices can reach: Wi-Fi first (en*), then the
  /// Personal Hotspot bridge, skipping loopback and link-local (169.254.x.x) ones.
  public static func localAddresses() -> [String] {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }
    var found: [(name: String, address: String)] = []
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let entry = pointer.pointee
      guard let addr = entry.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
            entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
      else { continue }
      let address = String(cString: host)
      guard !address.hasPrefix("169.254.") else { continue }
      found.append((String(cString: entry.ifa_name), address))
    }
    let rank = { (name: String) -> Int in name.hasPrefix("en") ? 0 : name.hasPrefix("bridge") ? 1 : 2 }
    return found.sorted { rank($0.name) < rank($1.name) }.map(\.address)
  }

  /// The leaf detector's newest boxes, as one line of JSON: sent to every `/detections` viewer.
  public func publishDetections(json: Data) {
    queue.async {
      self.latestDetections = json
      for viewer in self.viewers.values where viewer.detections && !viewer.sending {
        self.sendLine(json, to: viewer)
      }
    }
  }

  /// Viewers with the stream open, for the UI.
  public var viewerCount: Int { queue.sync { viewers.values.filter(\.streaming).count } }

  // MARK: Connections (all on `queue`)

  private final class Viewer {
    let connection: NWConnection
    var request = Data()
    var streaming = false
    /// Has `/detections` open.
    var detections = false
    var sending = false
    init(_ connection: NWConnection) { self.connection = connection }
  }

  private func setState(_ state: State) {
    guard state != _state else { return }
    _state = state
    onStateChange?(state)
  }

  private func stopListening() {
    listener?.cancel()
    listener = nil
    for viewer in viewers.values { viewer.connection.cancel() }
    viewers.removeAll()
    updateWatching()
  }

  private func updateWatching() {
    watching.value = viewers.values.contains(where: \.streaming)
  }

  private func accept(_ connection: NWConnection) {
    let viewer = Viewer(connection)
    let id = ObjectIdentifier(viewer)
    viewers[id] = viewer
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.viewers[id] = nil
        self?.updateWatching()
      default: break
      }
    }
    connection.start(queue: queue)
    readRequest(viewer)
  }

  private func readRequest(_ viewer: Viewer) {
    viewer.connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data { viewer.request.append(data) }
      if let head = HTTPRequestHead(viewer.request) {
        self.respond(to: head, viewer: viewer)
      } else if error != nil || isComplete || viewer.request.count > 8192 {
        viewer.connection.cancel()
      } else {
        self.readRequest(viewer)
      }
    }
  }

  private func respond(to head: HTTPRequestHead, viewer: Viewer) {
    guard head.method == "GET" || head.method == "HEAD" else {
      return finish(viewer, HTTPResponse.text(405, "Only GET"))
    }
    switch head.path {
    case "/camera.mjpg":
      viewer.streaming = true
      updateWatching()
      viewer.sending = true
      viewer.connection.send(content: HTTPResponse.mjpegHead(), completion: .contentProcessed { [weak self] error in
        guard let self else { return }
        viewer.sending = false
        if error != nil { return viewer.connection.cancel() }
        if let latest = self.latest { self.send(latest, to: viewer) }
      })
    case "/detections":
      viewer.detections = true
      viewer.sending = true
      viewer.connection.send(content: HTTPResponse.streamHead(contentType: "application/x-ndjson"),
                             completion: .contentProcessed { [weak self] error in
        guard let self else { return }
        viewer.sending = false
        if error != nil { return viewer.connection.cancel() }
        if let latest = self.latestDetections { self.sendLine(latest, to: viewer) }
      })
    case "/frame.jpg":
      if let size = head.query["size"].flatMap(Int.init), let stillProvider {
        var answered = false
        let answer = { [weak self] (data: Data?) -> Void in
          guard let self else { return }
          self.queue.async {
            guard !answered else { return }
            answered = true
            if let data {
              self.finish(viewer, HTTPResponse.make(200, contentType: "image/jpeg", body: data))
            } else {
              self.finish(viewer, HTTPResponse.text(503, "No camera frame: is the camera screen open?"))
            }
          }
        }
        stillProvider(min(max(size, 160), 4096), answer)
        queue.asyncAfter(deadline: .now() + Self.stillTimeout) { answer(nil) }
      } else if let latest {
        finish(viewer, HTTPResponse.make(200, contentType: "image/jpeg", body: latest))
      } else {
        finish(viewer, HTTPResponse.text(503, "No camera frame yet: is the camera screen open?"))
      }
    case "/status":
      let status: [String: Any] = [
        "id": id,
        "device": device,
        "recording": recording,
        "viewers": viewers.values.filter(\.streaming).count,
        "frames": frames,
        "width": latestSize.width,
        "height": latestSize.height,
      ]
      let body = (try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys])) ?? Data("{}".utf8)
      finish(viewer, HTTPResponse.make(200, contentType: "application/json", body: body))
    default:
      finish(viewer, HTTPResponse.text(404, "Not found. Try /camera.mjpg, /frame.jpg or /status"))
    }
  }

  private func send(_ jpeg: Data, to viewer: Viewer) {
    viewer.sending = true
    viewer.connection.send(content: HTTPResponse.mjpegPart(jpeg), completion: .contentProcessed { error in
      viewer.sending = false
      if error != nil { viewer.connection.cancel() }
    })
  }

  private func sendLine(_ json: Data, to viewer: Viewer) {
    viewer.sending = true
    viewer.connection.send(content: json + Data("\n".utf8), completion: .contentProcessed { error in
      viewer.sending = false
      if error != nil { viewer.connection.cancel() }
    })
  }

  private func finish(_ viewer: Viewer, _ response: Data) {
    viewer.connection.send(content: response, completion: .contentProcessed { _ in viewer.connection.cancel() })
  }
}

/// The first line of an HTTP request, once its headers have all arrived.
struct HTTPRequestHead: Equatable {
  let method: String
  /// Without the query string.
  let path: String
  /// The query string's parameters (`?size=1920` → ["size": "1920"]).
  let query: [String: String]

  /// Nil until `data` holds the blank line that ends the headers, or if the request line is malformed.
  init?(_ data: Data) {
    guard let end = data.range(of: Data("\r\n\r\n".utf8)),
          let text = String(data: data[..<end.lowerBound], encoding: .utf8),
          let line = text.split(separator: "\r\n", omittingEmptySubsequences: false).first else { return nil }
    let parts = line.split(separator: " ")
    guard parts.count == 3, parts[2].hasPrefix("HTTP/") else { return nil }
    method = String(parts[0])
    let target = parts[1].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    path = String(target[0])
    var query: [String: String] = [:]
    if target.count > 1 {
      for pair in target[1].split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        query[String(kv[0])] = kv.count > 1 ? String(kv[1]).removingPercentEncoding ?? String(kv[1]) : ""
      }
    }
    self.query = query
  }
}

enum HTTPResponse {
  static let boundary = "frame"
  private static let common = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n"

  static func make(_ status: Int, contentType: String, body: Data) -> Data {
    var head = "HTTP/1.1 \(status) \(reason(status))\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\n"
    head += common + "\r\n"
    return Data(head.utf8) + body
  }

  static func text(_ status: Int, _ message: String) -> Data {
    make(status, contentType: "text/plain; charset=utf-8", body: Data((message + "\n").utf8))
  }

  /// The head of an open-ended response: its body runs until the connection closes.
  static func streamHead(contentType: String) -> Data {
    Data("HTTP/1.1 200 OK\r\nContent-Type: \(contentType)\r\n\(common)\r\n".utf8)
  }

  static func mjpegHead() -> Data {
    Data("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=\(boundary)\r\n\(common)\r\n".utf8)
  }

  static func mjpegPart(_ jpeg: Data) -> Data {
    Data("--\(boundary)\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8) + jpeg + Data("\r\n".utf8)
  }

  private static func reason(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 503: return "Service Unavailable"
    default: return "Status"
    }
  }
}

/// A Bool read and written from any thread.
private final class ManagedAtomicFlag {
  private let lock = NSLock()
  private var _value = false
  var value: Bool {
    get { lock.lock(); defer { lock.unlock() }; return _value }
    set { lock.lock(); _value = newValue; lock.unlock() }
  }
}
