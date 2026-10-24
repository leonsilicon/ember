import simd

/// Pinhole intrinsics in pixels of the image they describe (origin top-left, +u right, +v down).
struct PinholeIntrinsics: Equatable {
  var fx: Float
  var fy: Float
  var cx: Float
  var cy: Float
  var width: Int
  var height: Int

  /// ARKit's `camera.intrinsics` is column-major: fx = [0][0], fy = [1][1], (cx, cy) = column 2.
  init(arkit matrix: simd_float3x3, width: Int, height: Int) {
    fx = matrix.columns.0.x
    fy = matrix.columns.1.y
    cx = matrix.columns.2.x
    cy = matrix.columns.2.y
    self.width = width
    self.height = height
  }

  init(fx: Float, fy: Float, cx: Float, cy: Float, width: Int, height: Int) {
    self.fx = fx
    self.fy = fy
    self.cx = cx
    self.cy = cy
    self.width = width
    self.height = height
  }

  /// The same camera described at another resolution of the same field of view
  /// (a resized JPEG, or the 256×192 LiDAR depth map).
  func scaled(toWidth newWidth: Int, height newHeight: Int) -> PinholeIntrinsics {
    let sx = Float(newWidth) / Float(width)
    let sy = Float(newHeight) / Float(height)
    return PinholeIntrinsics(fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy, width: newWidth, height: newHeight)
  }
}

/// Geometry in ARKit's conventions: world is gravity-aligned with +y up, and camera
/// space has +x right, +y up, with the camera looking down −z.
enum CaptureMath {
  static func transform(_ point: SIMD3<Float>, by matrix: simd_float4x4) -> SIMD3<Float> {
    let p = matrix * SIMD4<Float>(point, 1)
    return SIMD3<Float>(p.x, p.y, p.z)
  }

  /// Pixel at which `world` appears, or nil when it is behind the camera.
  static func project(_ world: SIMD3<Float>, cameraToWorld: simd_float4x4, intrinsics: PinholeIntrinsics) -> SIMD2<Float>? {
    let cam = transform(world, by: cameraToWorld.inverse)
    let depth = -cam.z
    guard depth > 1e-4 else { return nil }
    return SIMD2<Float>(intrinsics.cx + intrinsics.fx * cam.x / depth,
                        intrinsics.cy - intrinsics.fy * cam.y / depth)
  }

  /// Camera-space point for pixel (u, v) seen at `depth` metres in front of the camera.
  static func unproject(u: Float, v: Float, depth: Float, intrinsics: PinholeIntrinsics) -> SIMD3<Float> {
    SIMD3<Float>((u - intrinsics.cx) / intrinsics.fx * depth,
                 -(v - intrinsics.cy) / intrinsics.fy * depth,
                 -depth)
  }

  static func translationDistance(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
    simd_distance(SIMD3<Float>(a.columns.3.x, a.columns.3.y, a.columns.3.z),
                  SIMD3<Float>(b.columns.3.x, b.columns.3.y, b.columns.3.z))
  }

  /// Angle in radians of the rotation taking `a`'s orientation to `b`'s.
  static func rotationAngle(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
    let ra = simd_float3x3(columns: (a.columns.0.xyz, a.columns.1.xyz, a.columns.2.xyz))
    let rb = simd_float3x3(columns: (b.columns.0.xyz, b.columns.1.xyz, b.columns.2.xyz))
    let r = ra.transpose * rb
    let trace = r.columns.0.x + r.columns.1.y + r.columns.2.z
    return acos(min(1, max(-1, (trace - 1) / 2)))
  }

  /// simd matrices are column-major; datasets are written row by row.
  static func rowMajor(_ m: simd_float4x4) -> [[Float]] {
    (0..<4).map { row in (0..<4).map { col in m[col][row] } }
  }
}

extension SIMD4 where Scalar == Float {
  var xyz: SIMD3<Float> { SIMD3<Float>(x, y, z) }
}
