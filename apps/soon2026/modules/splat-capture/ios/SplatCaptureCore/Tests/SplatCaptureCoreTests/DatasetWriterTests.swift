import simd
import XCTest

@testable import SplatCaptureCore

final class DatasetWriterTests: XCTestCase {
  let k = PinholeIntrinsics(fx: 960, fy: 961, cx: 640, cy: 480, width: 1280, height: 960)

  func testTransformsJSONMatchesNerfstudioLayout() throws {
    let pose = makePose(rotation: simd_quatf(angle: .pi / 2, axis: SIMD3(0, 1, 0)), translation: SIMD3(0.5, 1.2, -2))
    let data = try DatasetWriter.transformsJSON(
      frames: [DatasetFrame(filePath: "images/frame_00000.jpg", cameraToWorld: pose, intrinsics: k)],
      plyFilePath: "points.ply")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["ply_file_path"] as? String, "points.ply")
    let frame = try XCTUnwrap((json["frames"] as? [[String: Any]])?.first)
    XCTAssertEqual(frame["file_path"] as? String, "images/frame_00000.jpg")
    XCTAssertEqual(frame["w"] as? Int, 1280)
    XCTAssertEqual(frame["h"] as? Int, 960)
    XCTAssertEqual(frame["fl_y"] as? Double, 961)
    let rows = try XCTUnwrap(frame["transform_matrix"] as? [[Double]])
    XCTAssertEqual(rows.count, 4)
    XCTAssertEqual(rows[0][3], 0.5, accuracy: 1e-6)
    XCTAssertEqual(rows[1][3], 1.2, accuracy: 1e-6)
    XCTAssertEqual(rows[2][3], -2, accuracy: 1e-6)
    // A +90° yaw maps camera +x to world −z: row 2, column 0.
    XCTAssertEqual(rows[2][0], -1, accuracy: 1e-6)
    XCTAssertEqual(rows[0][2], 1, accuracy: 1e-6)
  }

  func testOmitsPlyPathWhenThereAreNoPoints() throws {
    let data = try DatasetWriter.transformsJSON(frames: [], plyFilePath: nil)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertNil(json["ply_file_path"])
  }

  func testPointCloudPLYIsBinaryWithExpectedLayout() throws {
    let points = [ColoredPoint(position: SIMD3(1, -2, 3.5), color: SIMD3(10, 20, 30)),
                  ColoredPoint(position: SIMD3(0, 0, 0), color: SIMD3(255, 0, 128))]
    let data = DatasetWriter.pointCloudPLY(points)
    let marker = Data("end_header\n".utf8)
    let headerEnd = try XCTUnwrap(data.range(of: marker)).upperBound
    let header = String(decoding: data[..<headerEnd], as: UTF8.self)
    XCTAssertTrue(header.hasPrefix("ply\nformat binary_little_endian 1.0\n"))
    XCTAssertTrue(header.contains("element vertex 2\n"))
    XCTAssertEqual(data.count - headerEnd, 2 * 15)

    let body = data[headerEnd...]
    func float(at offset: Int) -> Float {
      let bytes = body.dropFirst(offset).prefix(4)
      return Float(bitPattern: bytes.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) })
    }
    XCTAssertEqual(float(at: 0), 1)
    XCTAssertEqual(float(at: 4), -2)
    XCTAssertEqual(float(at: 8), 3.5)
    XCTAssertEqual(Array(body.dropFirst(12).prefix(3)), [10, 20, 30])
    XCTAssertEqual(Array(body.dropFirst(27).prefix(3)), [255, 0, 128])
  }
}
