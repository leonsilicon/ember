import simd
import XCTest

@testable import SplatCaptureCore

final class DepthUnprojectionTests: XCTestCase {
  let image = PinholeIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)

  func samples(depth: [Float], confidence: [UInt8]? = nil, pose: simd_float4x4 = matrix_identity_float4x4,
               stride: Int = 1) -> [DepthSample] {
    depth.withUnsafeBufferPointer { d in
      if let confidence {
        return confidence.withUnsafeBufferPointer { c in
          DepthUnprojection.worldSamples(depth: d, confidence: c, width: 8, height: 6, imageIntrinsics: image,
                                         cameraToWorld: pose, stride: stride)
        }
      }
      return DepthUnprojection.worldSamples(depth: d, confidence: nil, width: 8, height: 6, imageIntrinsics: image,
                                            cameraToWorld: pose, stride: stride)
    }
  }

  func testFlatWallTwoMetresAheadLandsAtZMinusTwo() {
    let result = samples(depth: Array(repeating: 2, count: 48))
    XCTAssertEqual(result.count, 48)
    for s in result { XCTAssertEqual(s.world.z, -2, accuracy: 1e-4) }
  }

  func testSamplesMapBackToTheirImagePixel() {
    for s in samples(depth: Array(repeating: 1.5, count: 48)) {
      let pixel = CaptureMath.project(s.world, cameraToWorld: matrix_identity_float4x4, intrinsics: image)!
      XCTAssertEqual(pixel.x, s.imagePixel.x, accuracy: 0.05)
      XCTAssertEqual(pixel.y, s.imagePixel.y, accuracy: 0.05)
    }
  }

  func testPoseMovesPointsIntoWorld() {
    let pose = makePose(rotation: simd_quatf(angle: 0, axis: SIMD3(0, 1, 0)), translation: SIMD3(0, 1.4, 0))
    let result = samples(depth: Array(repeating: 1, count: 48), pose: pose)
    for s in result { XCTAssertEqual(s.world.z, -1, accuracy: 1e-4) }
    let meanY = result.map(\.world.y).reduce(0, +) / Float(result.count)
    XCTAssertEqual(meanY, 1.4, accuracy: 0.01)
  }

  func testDropsLowConfidenceInvalidAndOutOfRangeDepth() {
    var depth = Array(repeating: Float(2), count: 48)
    depth[0] = .nan
    depth[1] = 0.01
    depth[2] = 40
    var confidence = Array(repeating: UInt8(2), count: 48)
    confidence[3] = 0
    XCTAssertEqual(samples(depth: depth, confidence: confidence).count, 44)
  }

  func testStrideSubsamples() {
    XCTAssertEqual(samples(depth: Array(repeating: 2, count: 48), stride: 2).count, 12)
  }
}
