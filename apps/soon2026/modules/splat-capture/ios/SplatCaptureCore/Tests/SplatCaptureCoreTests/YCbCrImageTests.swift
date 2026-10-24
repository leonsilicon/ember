import XCTest

@testable import SplatCaptureCore

final class YCbCrImageTests: XCTestCase {
  /// Runs `body` on a 4×4 image whose luma and chroma are given row by row
  /// (chroma rows hold Cb,Cr pairs for each 2×2 block). Rows are padded to check
  /// that bytes-per-row is honoured rather than assumed to equal the width.
  func withImage(luma: [[UInt8]], chroma: [[UInt8]], _ body: (YCbCrImage) -> Void) {
    let pad: UInt8 = 7
    let lumaRow = luma[0].count + 3
    let chromaRow = chroma[0].count + 5
    let lumaBytes = luma.flatMap { $0 + Array(repeating: pad, count: 3) }
    let chromaBytes = chroma.flatMap { $0 + Array(repeating: pad, count: 5) }
    lumaBytes.withUnsafeBufferPointer { l in
      chromaBytes.withUnsafeBufferPointer { c in
        body(YCbCrImage(width: luma[0].count, height: luma.count, luma: l.baseAddress!, lumaBytesPerRow: lumaRow,
                        chroma: c.baseAddress!, chromaBytesPerRow: chromaRow))
      }
    }
  }

  func testNeutralChromaGivesGray() {
    withImage(luma: Array(repeating: [128, 128, 128, 128], count: 4),
              chroma: Array(repeating: [128, 128, 128, 128], count: 2)) { image in
      XCTAssertEqual(image.rgb(x: 1, y: 1), SIMD3(128, 128, 128))
    }
  }

  func testHighCrIsRed() {
    withImage(luma: Array(repeating: [76, 76, 76, 76], count: 4),
              chroma: Array(repeating: [85, 255, 85, 255], count: 2)) { image in
      let c = image.rgb(x: 0, y: 0)!
      XCTAssertGreaterThan(c.x, 200)
      XCTAssertLessThan(c.y, 40)
      XCTAssertLessThan(c.z, 40)
    }
  }

  func testChromaIsSharedPer2x2Block() {
    // Left block neutral, right block blue-ish.
    withImage(luma: Array(repeating: [100, 100, 100, 100], count: 4),
              chroma: Array(repeating: [128, 128, 230, 128], count: 2)) { image in
      XCTAssertEqual(image.rgb(x: 1.9, y: 3), SIMD3(100, 100, 100))
      let right = image.rgb(x: 2, y: 3)!
      XCTAssertGreaterThan(right.z, 200)
      XCTAssertEqual(right.x, 100)
    }
  }

  func testOutsideImageIsNil() {
    withImage(luma: Array(repeating: [0, 0, 0, 0], count: 4), chroma: Array(repeating: [128, 128, 128, 128], count: 2)) { image in
      XCTAssertNil(image.rgb(x: -0.5, y: 1))
      XCTAssertNil(image.rgb(x: 4, y: 1))
      XCTAssertNil(image.rgb(x: 1, y: 4))
      XCTAssertNil(image.rgb(x: .nan, y: 1))
    }
  }
}
