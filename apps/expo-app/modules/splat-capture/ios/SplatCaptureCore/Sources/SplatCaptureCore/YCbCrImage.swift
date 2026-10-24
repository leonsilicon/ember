import simd

/// Read-only view of a bi-planar 4:2:0 YCbCr image — the format of ARKit's
/// `capturedImage` (`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`): a full-res
/// luma plane plus a half-res plane of interleaved Cb,Cr pairs.
struct YCbCrImage {
  let width: Int
  let height: Int
  let luma: UnsafePointer<UInt8>
  let lumaBytesPerRow: Int
  let chroma: UnsafePointer<UInt8>
  let chromaBytesPerRow: Int

  /// sRGB colour at pixel (x, y) using full-range BT.601, or nil outside the image.
  func rgb(x: Float, y: Float) -> SIMD3<UInt8>? {
    guard x >= 0, y >= 0, x < Float(width), y < Float(height) else { return nil }  // also rejects NaN
    let xi = Int(x)
    let yi = Int(y)
    let lum = Float(luma[yi * lumaBytesPerRow + xi])
    let c = (yi / 2) * chromaBytesPerRow + (xi / 2) * 2
    let cb = Float(chroma[c]) - 128
    let cr = Float(chroma[c + 1]) - 128
    return SIMD3<UInt8>(Self.clamp(lum + 1.402 * cr),
                        Self.clamp(lum - 0.344136 * cb - 0.714136 * cr),
                        Self.clamp(lum + 1.772 * cb))
  }

  private static func clamp(_ v: Float) -> UInt8 {
    UInt8(max(0, min(255, v.rounded())))
  }
}
