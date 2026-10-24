import Foundation
import simd

struct FrameSelectorConfig: Equatable {
  /// Never keep frames closer together than this (seconds).
  var minInterval: TimeInterval = 1.0 / 3.0
  /// Keep a frame after this long even if the phone hasn't moved, so a slow pan still records.
  var maxInterval: TimeInterval = 1.5
  /// Movement that makes a new view worth keeping (metres / radians).
  var minTranslation: Float = 0.05
  var minRotation: Float = 5 * .pi / 180
  var maxFrames: Int = 400
}

/// Decides which camera frames become training images. Splat training wants views
/// from many positions, so near-duplicates are dropped and bad-tracking frames
/// (whose poses can't be trusted) are never kept.
struct FrameSelector {
  let config: FrameSelectorConfig
  private(set) var accepted = 0
  private var lastTimestamp: TimeInterval?
  private var lastPose: simd_float4x4?

  init(config: FrameSelectorConfig = FrameSelectorConfig()) {
    self.config = config
  }

  var isFull: Bool { accepted >= config.maxFrames }

  /// Returns true, and records the frame as kept, when it should be kept.
  mutating func shouldKeep(timestamp: TimeInterval, cameraToWorld: simd_float4x4, trackingNormal: Bool) -> Bool {
    guard trackingNormal, !isFull, timestamp.isFinite else { return false }
    if let last = lastTimestamp, let lastPose {
      let dt = timestamp - last
      guard dt >= config.minInterval else { return false }
      let moved = CaptureMath.translationDistance(lastPose, cameraToWorld) >= config.minTranslation
        || CaptureMath.rotationAngle(lastPose, cameraToWorld) >= config.minRotation
      guard moved || dt >= config.maxInterval else { return false }
    }
    lastTimestamp = timestamp
    lastPose = cameraToWorld
    accepted += 1
    return true
  }
}
