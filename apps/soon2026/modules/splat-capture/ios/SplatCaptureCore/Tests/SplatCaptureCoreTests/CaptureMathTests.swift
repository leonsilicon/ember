import simd
import XCTest

@testable import SplatCaptureCore

final class CaptureMathTests: XCTestCase {
  let k = PinholeIntrinsics(fx: 1000, fy: 1000, cx: 960, cy: 720, width: 1920, height: 1440)

  func testIntrinsicsReadFromARKitColumnMajorMatrix() {
    let arkit = simd_float3x3(columns: (SIMD3(1450, 0, 0), SIMD3(0, 1460, 0), SIMD3(955, 712, 1)))
    let k = PinholeIntrinsics(arkit: arkit, width: 1920, height: 1440)
    XCTAssertEqual(k, PinholeIntrinsics(fx: 1450, fy: 1460, cx: 955, cy: 712, width: 1920, height: 1440))
  }

  func testIntrinsicsScaleWithResolution() {
    let small = k.scaled(toWidth: 256, height: 192)
    XCTAssertEqual(small.fx, 1000 * 256 / 1920, accuracy: 1e-3)
    XCTAssertEqual(small.fy, 1000 * 192 / 1440, accuracy: 1e-3)
    XCTAssertEqual(small.cx, 128, accuracy: 1e-3)
    XCTAssertEqual(small.cy, 96, accuracy: 1e-3)
  }

  func testPointStraightAheadProjectsToPrincipalPoint() {
    let pixel = CaptureMath.project(SIMD3(0, 0, -2), cameraToWorld: matrix_identity_float4x4, intrinsics: k)
    XCTAssertEqual(pixel?.x ?? .nan, 960, accuracy: 1e-3)
    XCTAssertEqual(pixel?.y ?? .nan, 720, accuracy: 1e-3)
  }

  func testUpAndRightInCameraSpaceIsUpAndRightInImage() {
    // ARKit camera: +y is up, but image rows grow downwards.
    let pixel = CaptureMath.project(SIMD3(0.5, 0.5, -1), cameraToWorld: matrix_identity_float4x4, intrinsics: k)!
    XCTAssertGreaterThan(pixel.x, 960)
    XCTAssertLessThan(pixel.y, 720)
  }

  func testPointsBehindCameraDoNotProject() {
    XCTAssertNil(CaptureMath.project(SIMD3(0, 0, 1), cameraToWorld: matrix_identity_float4x4, intrinsics: k))
  }

  func testProjectInvertsUnprojectUnderArbitraryPose() {
    let pose = makePose(rotation: simd_quatf(angle: 0.7, axis: simd_normalize(SIMD3(0.2, 1, 0.1))),
                        translation: SIMD3(1.5, -0.3, 2))
    for (u, v, d) in [(100 as Float, 200 as Float, 1.2 as Float), (1800, 50, 3.5), (960, 1400, 0.4)] {
      let world = CaptureMath.transform(CaptureMath.unproject(u: u, v: v, depth: d, intrinsics: k), by: pose)
      let pixel = CaptureMath.project(world, cameraToWorld: pose, intrinsics: k)!
      XCTAssertEqual(pixel.x, u, accuracy: 1e-2)
      XCTAssertEqual(pixel.y, v, accuracy: 1e-2)
    }
  }

  func testRowMajorPutsTranslationInLastColumn() {
    let pose = makePose(rotation: simd_quatf(angle: 0, axis: SIMD3(0, 1, 0)), translation: SIMD3(1, 2, 3))
    let rows = CaptureMath.rowMajor(pose)
    XCTAssertEqual(rows[0][3], 1)
    XCTAssertEqual(rows[1][3], 2)
    XCTAssertEqual(rows[2][3], 3)
    XCTAssertEqual(rows[3], [0, 0, 0, 1])
  }

  func testRotationAngleAndTranslationDistance() {
    let a = matrix_identity_float4x4
    let b = makePose(rotation: simd_quatf(angle: .pi / 6, axis: SIMD3(0, 1, 0)), translation: SIMD3(0.3, 0.4, 0))
    XCTAssertEqual(CaptureMath.rotationAngle(a, b), .pi / 6, accuracy: 1e-4)
    XCTAssertEqual(CaptureMath.translationDistance(a, b), 0.5, accuracy: 1e-5)
    XCTAssertEqual(CaptureMath.rotationAngle(b, b), 0, accuracy: 1e-3)
  }
}

func makePose(rotation: simd_quatf, translation: SIMD3<Float>) -> simd_float4x4 {
  var m = simd_float4x4(rotation)
  m.columns.3 = SIMD4(translation, 1)
  return m
}
