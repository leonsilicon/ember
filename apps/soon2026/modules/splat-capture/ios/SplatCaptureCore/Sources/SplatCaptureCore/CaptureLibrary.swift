import Foundation

/// What a capture contains, written as `capture.json` inside the zip and kept beside it
/// so the app can list captures without unzipping them.
struct CaptureSummary: Codable, Equatable {
  var captureId: String
  /// `lidar` (seeded from LiDAR depth) or `features` (seeded from ARKit feature points).
  var mode: String
  var frames: Int
  var points: Int
  var durationSeconds: Double
  var createdAt: String
  var device: String
  var systemVersion: String
  /// Notes for whoever reconstructs the capture, so the zip documents itself.
  var format = "nerfstudio (transforms.json + images/ + optional points.ply seed cloud)"
  var coordinates = "ARKit world: metres, gravity-aligned, +y up. transform_matrix is camera-to-world (OpenGL camera: +x right, +y up, looks down -z), row-major."
}

struct SavedCapture: Equatable {
  var id: String
  var zip: URL
  var bytes: Int
  var savedAt: Date
  /// Nil for a zip that arrived some other way (e.g. copied in through Files).
  var summary: CaptureSummary?
  /// A small JPEG of the capture for the gallery button, when one was saved with it.
  var thumbnail: URL?
}

enum CaptureLibraryError: LocalizedError {
  case zipFailed(String)

  var errorDescription: String? {
    switch self {
    case .zipFailed(let reason): return "Couldn't package the capture: \(reason)"
    }
  }
}

/// Saved captures, one `<id>.zip` each, in a directory the user can browse (the app's
/// Documents folder appears in the Files app and in Finder).
struct CaptureLibrary {
  let directory: URL
  /// Summaries (and thumbnails) live outside `directory` so the Files app only shows the zips.
  let summaries: URL

  /// Zips `dataset` (whose folder name becomes the zip's top-level folder) into the library,
  /// keeping `thumbnail` (JPEG data) beside its summary.
  @discardableResult
  func save(dataset: URL, summary: CaptureSummary, thumbnail: Data? = nil) throws -> SavedCapture {
    let fm = FileManager.default
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    try fm.createDirectory(at: summaries, withIntermediateDirectories: true)
    let zip = directory.appendingPathComponent("\(summary.captureId).zip")
    try Self.zipDirectory(dataset, to: zip)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(summary).write(to: summaryURL(summary.captureId))
    try thumbnail?.write(to: thumbnailURL(summary.captureId))
    return try saved(zip)
  }

  /// Newest first.
  func list() -> [SavedCapture] {
    let zips = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    return zips
      .filter { $0.pathExtension.lowercased() == "zip" }
      .compactMap { try? saved($0) }
      .sorted { $0.savedAt > $1.savedAt }
  }

  func delete(id: String) throws {
    let fm = FileManager.default
    for url in [directory.appendingPathComponent("\(id).zip"), summaryURL(id), thumbnailURL(id)]
    where fm.fileExists(atPath: url.path) {
      try fm.removeItem(at: url)
    }
  }

  private func summaryURL(_ id: String) -> URL {
    summaries.appendingPathComponent("\(id).json")
  }

  private func thumbnailURL(_ id: String) -> URL {
    summaries.appendingPathComponent("\(id).jpg")
  }

  private func saved(_ zip: URL) throws -> SavedCapture {
    let attributes = try FileManager.default.attributesOfItem(atPath: zip.path)
    let id = zip.deletingPathExtension().lastPathComponent
    let summary = (try? Data(contentsOf: summaryURL(id))).flatMap { try? JSONDecoder().decode(CaptureSummary.self, from: $0) }
    let thumbnail = thumbnailURL(id)
    return SavedCapture(id: id, zip: zip, bytes: (attributes[.size] as? Int) ?? 0,
                        savedAt: (attributes[.modificationDate] as? Date) ?? .distantPast, summary: summary,
                        thumbnail: FileManager.default.fileExists(atPath: thumbnail.path) ? thumbnail : nil)
  }

  /// Foundation's built-in archiver: reading a directory with `.forUploading` yields a zip of it.
  static func zipDirectory(_ directory: URL, to destination: URL) throws {
    var coordinationError: NSError?
    var copyError: Error?
    NSFileCoordinator().coordinate(readingItemAt: directory, options: [.forUploading], error: &coordinationError) { zipped in
      do {
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.copyItem(at: zipped, to: destination)
      } catch {
        copyError = error
      }
    }
    if let error = coordinationError ?? copyError {
      throw CaptureLibraryError.zipFailed(error.localizedDescription)
    }
  }
}
