import Foundation

/// Uploads a capture zip straight from disk, so the bytes never pass through JS.
/// Used by the debug splat preview (see frontend): the server hands out an upload URL in its Blob
/// store, the zip goes there directly (a few hundred MB is more than the server itself accepts),
/// and the server is then told it's in, which queues it for training.
final class CaptureUploader: NSObject, URLSessionTaskDelegate {
  private let onProgress: (Int64, Int64) -> Void
  private var lastReported: Int64 = -1

  private init(onProgress: @escaping (Int64, Int64) -> Void) {
    self.onProgress = onProgress
  }

  /// The server's reply to the last step that ran: 201 and the job when it all worked.
  /// `room` is the username the capture belongs to (frontend/src/rooms.ts), sent as `X-Room`; nil for none.
  static func upload(_ file: URL, server: URL, captureId: String, token: String, room: String?,
                     onProgress: @escaping (Int64, Int64) -> Void) async throws -> (status: Int, body: String) {
    func api(_ path: String) -> URLRequest {
      var request = URLRequest(url: URL(string: path, relativeTo: server) ?? server)
      request.httpMethod = "POST"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      return request
    }

    var start = api("api/captures")
    start.setValue(captureId, forHTTPHeaderField: "X-Capture-Id")
    if let room, !room.isEmpty { start.setValue(room, forHTTPHeaderField: "X-Room") }
    let started = try await send(start)
    guard started.status == 201,
          let reply = try? JSONSerialization.jsonObject(with: Data(started.body.utf8)) as? [String: Any],
          let uploadURL = (reply["uploadUrl"] as? String).flatMap(URL.init(string:)) else { return started }

    var put = URLRequest(url: uploadURL)
    put.httpMethod = "PUT"
    put.timeoutInterval = 600
    put.setValue("application/zip", forHTTPHeaderField: "Content-Type")
    let delegate = CaptureUploader(onProgress: onProgress)
    let (data, response) = try await URLSession.shared.upload(for: put, fromFile: file, delegate: delegate)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { return (status, String(decoding: data, as: UTF8.self)) }

    return try await send(api("api/captures/\(captureId)/uploaded"))
  }

  private static func send(_ request: URLRequest) async throws -> (status: Int, body: String) {
    let (data, response) = try await URLSession.shared.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                  totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    // Report about every 2% rather than for every packet.
    let step = max(totalBytesExpectedToSend / 50, 1)
    guard totalBytesSent - lastReported >= step || totalBytesSent == totalBytesExpectedToSend else { return }
    lastReported = totalBytesSent
    onProgress(totalBytesSent, totalBytesExpectedToSend)
  }
}
