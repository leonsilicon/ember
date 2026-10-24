import Foundation

/// Uploads a capture zip straight from disk, so the bytes never pass through JS.
/// Used by the debug splat preview (see server/).
final class CaptureUploader: NSObject, URLSessionTaskDelegate {
  private let onProgress: (Int64, Int64) -> Void
  private var lastReported: Int64 = -1

  private init(onProgress: @escaping (Int64, Int64) -> Void) {
    self.onProgress = onProgress
  }

  static func upload(_ file: URL, to endpoint: URL, headers: [String: String],
                     onProgress: @escaping (Int64, Int64) -> Void) async throws -> (status: Int, body: String) {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 600
    request.setValue("application/zip", forHTTPHeaderField: "Content-Type")
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let delegate = CaptureUploader(onProgress: onProgress)
    let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file, delegate: delegate)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    return (status, String(decoding: data, as: UTF8.self))
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
