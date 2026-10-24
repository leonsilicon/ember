import Network
import XCTest
@testable import SplatCaptureCore

final class CameraStreamServerTests: XCTestCase {
  func testParsesTheRequestLineOnceTheHeadersEnd() {
    XCTAssertNil(HTTPRequestHead(Data("GET /camera.mjpg HTTP/1.1\r\nHost: x\r\n".utf8)))
    let head = HTTPRequestHead(Data("GET /camera.mjpg?t=12 HTTP/1.1\r\nHost: x\r\n\r\n".utf8))
    XCTAssertEqual(head?.path, HTTPRequestHead(Data("GET /camera.mjpg HTTP/1.1\r\n\r\n".utf8))?.path)
    XCTAssertEqual(head?.method, "GET")
    XCTAssertEqual(head?.path, "/camera.mjpg")
    XCTAssertEqual(head?.query, ["t": "12"])
    XCTAssertNil(HTTPRequestHead(Data("nonsense\r\n\r\n".utf8)))
  }

  func testLocalAddressesAreDottedIPv4WithoutLoopback() {
    for address in CameraStreamServer.localAddresses() {
      XCTAssertEqual(address.split(separator: ".").count, 4, address)
      XCTAssertFalse(address.hasPrefix("127."))
      XCTAssertFalse(address.hasPrefix("169.254."))
    }
  }

  func testLocalNetworkDenialIsBlockedNotAFailure() {
    XCTAssertEqual(CameraStreamServer.state(waitingOn: .dns(-65570)), .blocked) // kDNSServiceErr_PolicyDenied
    if case .failed = CameraStreamServer.state(waitingOn: .posix(.ENETDOWN)) {} else { XCTFail("other waits are failures") }
  }

  func testMjpegPartsCarryTheirLength() {
    let part = String(decoding: HTTPResponse.mjpegPart(Data([1, 2, 3])), as: UTF8.self)
    XCTAssertTrue(part.hasPrefix("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n"))
  }

  // MARK: A real server on a free port

  private var server: CameraStreamServer!
  private var port: UInt16 = 0

  override func setUp() {
    super.setUp()
    server = CameraStreamServer(device: "Test iPhone", id: "test-id")
    let ready = expectation(description: "listening")
    server.onStateChange = { [weak self] state in
      if case .ready(let port) = state {
        self?.port = port
        ready.fulfill()
      }
    }
    server.start(port: 0)
    wait(for: [ready], timeout: 5)
  }

  override func tearDown() {
    server.stop()
    server = nil
    super.tearDown()
  }

  private func get(_ path: String) throws -> (status: Int, headers: [AnyHashable: Any], body: Data) {
    let url = URL(string: "http://127.0.0.1:\(port)\(path)")!
    let done = expectation(description: path)
    var result: (Int, [AnyHashable: Any], Data)?
    URLSession(configuration: .ephemeral).dataTask(with: url) { data, response, _ in
      let http = response as? HTTPURLResponse
      result = (http?.statusCode ?? 0, http?.allHeaderFields ?? [:], data ?? Data())
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 5)
    let r = try XCTUnwrap(result)
    return (r.0, r.1, r.2)
  }

  func testStatusSaysWhoItIsAndAllowsAnyOrigin() throws {
    let (status, headers, body) = try get("/status")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(headers["Access-Control-Allow-Origin"] as? String, "*")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(json["device"] as? String, "Test iPhone")
    XCTAssertEqual(json["id"] as? String, "test-id")
    XCTAssertEqual(json["viewers"] as? Int, 0)
  }

  func testFrameIsTheNewestPublishedJpeg() throws {
    XCTAssertEqual(try get("/frame.jpg").status, 503)
    server.publish(jpeg: Data([0xFF, 0xD8, 1, 2]), width: 2, height: 1)
    server.publish(jpeg: Data([0xFF, 0xD8, 3, 4]), width: 2, height: 1)
    let (status, headers, body) = try get("/frame.jpg")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(headers["Content-Type"] as? String, "image/jpeg")
    XCTAssertEqual(body, Data([0xFF, 0xD8, 3, 4]))
    XCTAssertEqual(try get("/nope").status, 404)
  }

  func testAdvertisesItselfOverBonjour() {
    let found = expectation(description: "found over Bonjour")
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: CameraStreamServer.serviceType, domain: nil), using: .tcp)
    var fulfilled = false
    browser.browseResultsChangedHandler = { results, _ in
      for result in results {
        guard case .service(let name, _, _, _) = result.endpoint, name.contains("Test iPhone"), !fulfilled else { continue }
        if case .bonjour(let txt) = result.metadata {
          XCTAssertEqual(txt["device"], "Test iPhone")
          XCTAssertEqual(txt["id"], "test-id")
        }
        fulfilled = true
        found.fulfill()
      }
    }
    browser.start(queue: DispatchQueue(label: "browser"))
    wait(for: [found], timeout: 10)
    browser.cancel()
  }

  func testSizedFrameIsAFreshStillFromTheProvider() throws {
    server.publish(jpeg: Data("stream".utf8), width: 1, height: 1)
    var askedFor: Int?
    server.stillProvider = { size, done in
      askedFor = size
      done(Data("still at \(size)".utf8))
    }
    let (status, _, body) = try get("/frame.jpg?size=1920")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(String(decoding: body, as: UTF8.self), "still at 1920")
    XCTAssertEqual(askedFor, 1920)
    XCTAssertEqual(try get("/frame.jpg").body, Data("stream".utf8)) // no size: the stream's newest frame
  }

  func testStillThatNeverComesIsA503() throws {
    server.stillProvider = { _, _ in } // the camera isn't running
    let start = Date()
    XCTAssertEqual(try get("/frame.jpg?size=1920").status, 503)
    XCTAssertEqual(Date().timeIntervalSince(start), CameraStreamServer.stillTimeout, accuracy: 1)
  }

  func testDetectionsStreamAsLinesNewestFirst() throws {
    server.publishDetections(json: Data(#"{"boxes":1}"#.utf8))
    let client = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    var received = Data()
    let gotBoth = expectation(description: "both lines")
    var done = false
    func read() {
      client.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, _ in
        if let data { received.append(data) }
        let text = String(decoding: received, as: UTF8.self)
        if !done && text.contains(#"{"boxes":1}"#) && text.contains(#"{"boxes":2}"#) { done = true; gotBoth.fulfill() }
        if !isComplete && !done { read() }
      }
    }
    client.start(queue: DispatchQueue(label: "detections-client"))
    client.send(content: Data("GET /detections HTTP/1.1\r\nHost: test\r\n\r\n".utf8), completion: .contentProcessed { _ in })
    read()
    // The newest line arrives on connect; publish the next once the client is surely connected.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
      self.server.publishDetections(json: Data(#"{"boxes":2}"#.utf8))
    }
    wait(for: [gotBoth], timeout: 5)
    let text = String(decoding: received, as: UTF8.self)
    XCTAssertTrue(text.hasPrefix("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"))
    XCTAssertTrue(text.hasSuffix(#"{"boxes":1}"# + "\n" + #"{"boxes":2}"# + "\n"))
    client.cancel()
  }

  func testStreamSendsTheLatestFrameThenEachNewOne() throws {
    server.publish(jpeg: Data("first".utf8), width: 1, height: 1)
    let client = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    let queue = DispatchQueue(label: "client")
    var received = Data()
    let gotFirst = expectation(description: "first frame")
    let gotSecond = expectation(description: "second frame")
    var sawFirst = false
    var sawSecond = false
    func read() {
      client.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, _ in
        if let data { received.append(data) }
        let text = String(decoding: received, as: UTF8.self)
        if !sawFirst && text.contains("first\r\n") { sawFirst = true; gotFirst.fulfill() }
        if !sawSecond && text.contains("second\r\n") { sawSecond = true; gotSecond.fulfill() }
        if !isComplete && !sawSecond { read() }
      }
    }
    client.start(queue: queue)
    client.send(content: Data("GET /camera.mjpg HTTP/1.1\r\nHost: test\r\n\r\n".utf8), completion: .contentProcessed { _ in })
    read()
    wait(for: [gotFirst], timeout: 5)
    XCTAssertTrue(server.wantsFrames)
    XCTAssertEqual(server.viewerCount, 1)
    server.publish(jpeg: Data("second".utf8), width: 1, height: 1)
    wait(for: [gotSecond], timeout: 5)
    let text = String(decoding: received, as: UTF8.self)
    XCTAssertTrue(text.hasPrefix("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n"))
    XCTAssertTrue(text.contains("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\nsecond\r\n"))

    client.cancel()
    // The server notices the viewer has gone once a send to it fails.
    let gone = expectation(description: "viewer gone")
    DispatchQueue.global().async {
      for _ in 0..<50 where self.server.wantsFrames {
        self.server.publish(jpeg: Data("more".utf8), width: 1, height: 1)
        Thread.sleep(forTimeInterval: 0.05)
      }
      gone.fulfill()
    }
    wait(for: [gone], timeout: 5)
    XCTAssertFalse(server.wantsFrames)
  }
}
