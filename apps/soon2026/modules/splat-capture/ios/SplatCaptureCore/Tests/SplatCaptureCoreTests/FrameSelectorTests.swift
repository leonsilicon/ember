import simd
import XCTest

@testable import SplatCaptureCore

final class FrameSelectorTests: XCTestCase {
  let still = matrix_identity_float4x4

  func testKeepsFirstFrameWithGoodTracking() {
    var selector = FrameSelector()
    XCTAssertTrue(selector.shouldKeep(timestamp: 10, cameraToWorld: still, trackingNormal: true))
    XCTAssertEqual(selector.accepted, 1)
  }

  func testNeverKeepsFramesWithLimitedTracking() {
    var selector = FrameSelector()
    XCTAssertFalse(selector.shouldKeep(timestamp: 10, cameraToWorld: still, trackingNormal: false))
    XCTAssertEqual(selector.accepted, 0)
  }

  func testRateLimitsEvenWhenMoving() {
    var selector = FrameSelector()
    XCTAssertTrue(selector.shouldKeep(timestamp: 10, cameraToWorld: still, trackingNormal: true))
    let moved = makePose(rotation: simd_quatf(angle: 0, axis: SIMD3(0, 1, 0)), translation: SIMD3(1, 0, 0))
    XCTAssertFalse(selector.shouldKeep(timestamp: 10.1, cameraToWorld: moved, trackingNormal: true))
    XCTAssertTrue(selector.shouldKeep(timestamp: 10.4, cameraToWorld: moved, trackingNormal: true))
  }

  func testStationaryPhoneOnlyKeepsAFrameEveryMaxInterval() {
    var selector = FrameSelector()
    XCTAssertTrue(selector.shouldKeep(timestamp: 0, cameraToWorld: still, trackingNormal: true))
    XCTAssertFalse(selector.shouldKeep(timestamp: 0.5, cameraToWorld: still, trackingNormal: true))
    XCTAssertFalse(selector.shouldKeep(timestamp: 1.0, cameraToWorld: still, trackingNormal: true))
    XCTAssertTrue(selector.shouldKeep(timestamp: 1.6, cameraToWorld: still, trackingNormal: true))
  }

  func testSmallTranslationOrRotationCountsAsANewView() {
    var selector = FrameSelector()
    XCTAssertTrue(selector.shouldKeep(timestamp: 0, cameraToWorld: still, trackingNormal: true))
    let stepped = makePose(rotation: simd_quatf(angle: 0, axis: SIMD3(0, 1, 0)), translation: SIMD3(0, 0, 0.06))
    XCTAssertTrue(selector.shouldKeep(timestamp: 0.4, cameraToWorld: stepped, trackingNormal: true))
    let turned = makePose(rotation: simd_quatf(angle: 8 * .pi / 180, axis: SIMD3(0, 1, 0)), translation: SIMD3(0, 0, 0.06))
    XCTAssertTrue(selector.shouldKeep(timestamp: 0.8, cameraToWorld: turned, trackingNormal: true))
  }

  func testStopsAtMaxFrames() {
    var selector = FrameSelector(config: FrameSelectorConfig(minInterval: 0, maxInterval: 0, maxFrames: 3))
    let kept = (0..<10).filter { selector.shouldKeep(timestamp: Double($0), cameraToWorld: still, trackingNormal: true) }
    XCTAssertEqual(kept.count, 3)
    XCTAssertTrue(selector.isFull)
  }
}
