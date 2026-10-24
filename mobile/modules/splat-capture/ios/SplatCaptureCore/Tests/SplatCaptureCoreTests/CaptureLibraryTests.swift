import Foundation
import XCTest

@testable import SplatCaptureCore

final class CaptureLibraryTests: XCTestCase {
  var root: URL!
  var library: CaptureLibrary!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("CaptureLibraryTests-\(UUID().uuidString)")
    library = CaptureLibrary(directory: root.appendingPathComponent("Documents/Captures"),
                             summaries: root.appendingPathComponent("Support/Summaries"))
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func summary(_ id: String) -> CaptureSummary {
    CaptureSummary(captureId: id, mode: "features", frames: 12, points: 340, durationSeconds: 21.5,
                   createdAt: "2026-10-24T05:00:00Z", device: "iPhone14,4", systemVersion: "27.0.1")
  }

  /// A dataset folder named after the capture, like the one the recorder writes.
  func makeDataset(_ id: String) throws -> URL {
    let dataset = root.appendingPathComponent("work/\(id)")
    try FileManager.default.createDirectory(at: dataset.appendingPathComponent("images"), withIntermediateDirectories: true)
    try Data(repeating: 0xAB, count: 4096).write(to: dataset.appendingPathComponent("images/frame_00000.jpg"))
    try Data(#"{"frames":[]}"#.utf8).write(to: dataset.appendingPathComponent("transforms.json"))
    return dataset
  }

  func testSaveWritesARealZipAndListsIt() throws {
    let saved = try library.save(dataset: try makeDataset("cap-a"), summary: summary("cap-a"))
    XCTAssertEqual(saved.zip.lastPathComponent, "cap-a.zip")
    let bytes = try Data(contentsOf: saved.zip)
    XCTAssertEqual(Array(bytes.prefix(4)), [0x50, 0x4B, 0x03, 0x04], "zip local-file-header magic")
    XCTAssertEqual(saved.bytes, bytes.count)
    XCTAssertEqual(library.list().map(\.id), ["cap-a"])
    XCTAssertEqual(library.list().first?.summary, summary("cap-a"))
  }

  func testZipKeepsTheCaptureFolderAndItsFiles() throws {
    let saved = try library.save(dataset: try makeDataset("cap-b"), summary: summary("cap-b"))
    let listing = Process()
    listing.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    listing.arguments = ["-Z1", saved.zip.path]
    let pipe = Pipe()
    listing.standardOutput = pipe
    try listing.run()
    listing.waitUntilExit()
    let entries = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    XCTAssertTrue(entries.contains("cap-b/transforms.json"), entries)
    XCTAssertTrue(entries.contains("cap-b/images/frame_00000.jpg"), entries)
  }

  func testListsNewestFirstAndIgnoresOtherFiles() throws {
    try library.save(dataset: try makeDataset("older"), summary: summary("older"))
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -60)],
                                          ofItemAtPath: library.directory.appendingPathComponent("older.zip").path)
    try library.save(dataset: try makeDataset("newer"), summary: summary("newer"))
    try Data("notes".utf8).write(to: library.directory.appendingPathComponent("notes.txt"))
    XCTAssertEqual(library.list().map(\.id), ["newer", "older"])
  }

  func testZipWithoutSummaryStillLists() throws {
    try FileManager.default.createDirectory(at: library.directory, withIntermediateDirectories: true)
    try Data([0x50, 0x4B, 0x05, 0x06] + Array(repeating: 0, count: 18)).write(to: library.directory.appendingPathComponent("dropped-in.zip"))
    let listed = library.list()
    XCTAssertEqual(listed.map(\.id), ["dropped-in"])
    XCTAssertNil(listed.first?.summary)
  }

  func testThumbnailIsKeptBesideTheSummaryAndOutOfTheZipFolder() throws {
    let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
    let saved = try library.save(dataset: try makeDataset("thumb"), summary: summary("thumb"), thumbnail: jpeg)
    XCTAssertEqual(saved.thumbnail, library.summaries.appendingPathComponent("thumb.jpg"))
    XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(library.list().first?.thumbnail)), jpeg)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: library.directory.path), ["thumb.zip"])

    try library.save(dataset: try makeDataset("plain"), summary: summary("plain"))
    XCTAssertNil(library.list().first { $0.id == "plain" }?.thumbnail)
  }

  func testVideoIsMovedBesideTheSummaryAndOutOfTheZipFolder() throws {
    let dataset = try makeDataset("clip")
    let recorded = root.appendingPathComponent("work/clip.mp4")
    try Data([0x00, 0x00, 0x00, 0x18]).write(to: recorded)
    let saved = try library.save(dataset: dataset, summary: summary("clip"), video: recorded)
    XCTAssertEqual(saved.video, library.summaries.appendingPathComponent("clip.mp4"))
    XCTAssertEqual(library.list().first?.video, saved.video)
    XCTAssertFalse(FileManager.default.fileExists(atPath: recorded.path))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: library.directory.path), ["clip.zip"])

    try library.save(dataset: try makeDataset("still"), summary: summary("still"))
    XCTAssertNil(library.list().first { $0.id == "still" }?.video)
  }

  func testDeleteRemovesZipSummaryThumbnailAndVideo() throws {
    let dataset = try makeDataset("gone")
    let recorded = root.appendingPathComponent("work/gone.mp4")
    try Data([0x00]).write(to: recorded)
    try library.save(dataset: dataset, summary: summary("gone"), thumbnail: Data([0xFF, 0xD8]), video: recorded)
    try library.delete(id: "gone")
    XCTAssertTrue(library.list().isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: library.summaries.appendingPathComponent("gone.json").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: library.summaries.appendingPathComponent("gone.jpg").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: library.summaries.appendingPathComponent("gone.mp4").path))
    XCTAssertNoThrow(try library.delete(id: "never-existed"))
  }
}
