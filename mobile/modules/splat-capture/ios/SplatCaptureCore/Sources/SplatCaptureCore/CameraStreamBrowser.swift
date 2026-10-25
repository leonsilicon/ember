import Foundation
import Network

/// Finds the other phones' cameras on the local network: the `_rovercam._tcp` services that
/// `CameraStreamServer` advertises, each resolved to an IPv4 address a web view can load, leaving out
/// the one whose id is `ownId` (this phone's own). In remote mode the app shows the camera of the
/// phone in mount mode, the one on the rover.
public final class CameraStreamBrowser {
  public struct Stream: Equatable {
    /// The serving app's `CameraStreamServer.id`; nil from servers that don't say (older builds).
    public let id: String?
    /// The Bonjour service name, e.g. "Rover camera (iPhone14,4)".
    public let name: String
    public let device: String
    /// e.g. "http://192.168.1.23:8787".
    public let origin: String

    public var dictionary: [String: Any] {
      var dictionary: [String: Any] = ["name": name, "device": device, "origin": origin]
      dictionary["id"] = id
      return dictionary
    }
  }

  /// Called on the browser's queue with every stream found so far, whenever that changes.
  public var onChange: (([Stream]) -> Void)?

  private let queue = DispatchQueue(label: "soon2026.camera-stream-browser")
  private let ownId: String
  /// Between `start` and `stop`: whether a browser that failed should start over.
  private var wanted = false
  private var browser: NWBrowser?
  private var results: Set<NWBrowser.Result> = []
  /// Connections made only to learn a service's address, by service.
  private var resolving: [NWEndpoint: NWConnection] = [:]
  private var streams: [NWEndpoint: Stream] = [:]

  public init(ownId: String) {
    self.ownId = ownId
  }

  public func start() {
    queue.async { [self] in
      wanted = true
      guard browser == nil else { return }
      let browser = NWBrowser(for: .bonjourWithTXTRecord(type: CameraStreamServer.serviceType, domain: nil),
                              using: .tcp)
      browser.browseResultsChangedHandler = { [weak self] results, _ in
        self?.results = results
        self?.update()
      }
      browser.stateUpdateHandler = { [weak self, weak browser] state in
        // Failed (the network went away, say), or cut off from Bonjour (as iOS does to a suspended
        // app): start over in a moment.
        switch state {
        case .failed: break
        case .waiting(let error) where CameraStreamServer.isDefunct(error): break
        default: return
        }
        guard let self, let browser, self.browser === browser else { return }
        self.stopBrowsing()
        self.queue.asyncAfter(deadline: .now() + 2) {
          if self.wanted { self.start() }
        }
      }
      self.browser = browser
      browser.start(queue: queue)
    }
  }

  public func stop() {
    queue.async { [self] in
      wanted = false
      stopBrowsing()
    }
  }

  private func stopBrowsing() {
    browser?.cancel()
    browser = nil
    results = []
    resolving.values.forEach { $0.cancel() }
    resolving = [:]
    if !streams.isEmpty {
      streams = [:]
      emit()
    }
  }

  /// Forgets services that went away, and resolves new ones.
  private func update() {
    let current = Set(results.map(\.endpoint))
    for endpoint in Array(resolving.keys) where !current.contains(endpoint) {
      resolving.removeValue(forKey: endpoint)?.cancel()
    }
    let gone = streams.keys.filter { !current.contains($0) }
    gone.forEach { streams[$0] = nil }
    for result in results where streams[result.endpoint] == nil && resolving[result.endpoint] == nil {
      var txt: [String: String] = [:]
      if case .bonjour(let record) = result.metadata { txt = record.dictionary }
      if txt["id"] == ownId { continue }
      resolve(result.endpoint, txt: txt)
    }
    if !gone.isEmpty { emit() }
  }

  /// Connects to the service just to learn its address, then hangs up.
  private func resolve(_ endpoint: NWEndpoint, txt: [String: String]) {
    let parameters = NWParameters.tcp
    // IPv4, which a URL holds as it is (a link-local IPv6 address needs its interface too).
    if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let connection = NWConnection(to: endpoint, using: parameters)
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection, self.resolving[endpoint] === connection else { return }
      switch state {
      case .ready:
        self.resolving[endpoint] = nil
        connection.cancel()
        guard case .hostPort(.ipv4(let address), let port)? = connection.currentPath?.remoteEndpoint else { return }
        var name = ""
        if case .service(let serviceName, _, _, _) = endpoint { name = serviceName }
        let host = address.rawValue.map(String.init).joined(separator: ".")
        self.streams[endpoint] = Stream(id: txt["id"], name: name, device: txt["device"] ?? name,
                                        origin: "http://\(host):\(port.rawValue)")
        self.emit()
      case .failed, .waiting:
        // Unreachable for now: try again in a moment, if it's still advertised.
        self.resolving[endpoint] = nil
        connection.cancel()
        self.queue.asyncAfter(deadline: .now() + 2) { self.update() }
      default:
        break
      }
    }
    resolving[endpoint] = connection
    connection.start(queue: queue)
  }

  private func emit() {
    onChange?(streams.values.sorted { $0.name < $1.name })
  }
}
