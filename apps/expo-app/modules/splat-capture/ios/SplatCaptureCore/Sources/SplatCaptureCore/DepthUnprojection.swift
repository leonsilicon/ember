import simd

/// A LiDAR sample lifted into the world, with the full-resolution image pixel it
/// corresponds to (where its colour should be read).
struct DepthSample: Equatable {
  var world: SIMD3<Float>
  var imagePixel: SIMD2<Float>
}

enum DepthUnprojection {
  /// Turns a row-major float32 depth map (metres) into world points.
  ///
  /// `imageIntrinsics` describe the colour image; the depth map is a lower-resolution
  /// view of the same camera, so they are scaled down to it before unprojecting.
  static func worldSamples(depth: UnsafeBufferPointer<Float32>,
                           confidence: UnsafeBufferPointer<UInt8>?,
                           width: Int,
                           height: Int,
                           imageIntrinsics: PinholeIntrinsics,
                           cameraToWorld: simd_float4x4,
                           stride: Int = 4,
                           minConfidence: UInt8 = 1,
                           depthRange: ClosedRange<Float> = 0.1...6.0) -> [DepthSample] {
    precondition(depth.count >= width * height, "depth buffer too small")
    let k = imageIntrinsics.scaled(toWidth: width, height: height)
    let toImageX = Float(imageIntrinsics.width) / Float(width)
    let toImageY = Float(imageIntrinsics.height) / Float(height)
    var samples: [DepthSample] = []
    samples.reserveCapacity((width / stride) * (height / stride))
    for v in Swift.stride(from: 0, to: height, by: stride) {
      for u in Swift.stride(from: 0, to: width, by: stride) {
        let i = v * width + u
        let d = depth[i]
        guard d.isFinite, depthRange.contains(d) else { continue }
        if let confidence, confidence[i] < minConfidence { continue }
        // Sample at the pixel centre in both resolutions.
        let cam = CaptureMath.unproject(u: Float(u) + 0.5, v: Float(v) + 0.5, depth: d, intrinsics: k)
        samples.append(DepthSample(world: CaptureMath.transform(cam, by: cameraToWorld),
                                   imagePixel: SIMD2<Float>((Float(u) + 0.5) * toImageX, (Float(v) + 0.5) * toImageY)))
      }
    }
    return samples
  }
}
