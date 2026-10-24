import CoreGraphics
import CoreML
import Foundation
import ImageIO
import Vision

// Usage: depth_worker <model.mlmodelc | model.mlpackage>
//
// Talks to server/src/live/depth-worker.ts over stdin/stdout. Integers are u32 little-endian.
//   request:  id, width, height, flags (1 = estimate depth), jpegLength, jpeg bytes
//   response: id, status (0 ok, 1 error), width, height, flags (1 = depth follows), messageLength,
//             message (UTF-8), rgb (width*height*3 bytes), depth (width*height float32, if flagged)
// Depth is the model's raw output resampled to width×height: relative inverse depth (larger is
// nearer) with an unknown scale and shift per image, which the server fits to ARKit's points.
// Once the model is loaded and warmed up, the worker sends one response with id 0.

struct WorkerError: Error, CustomStringConvertible {
  let description: String
}

let stdinHandle = FileHandle.standardInput
let stdoutHandle = FileHandle.standardOutput

func readExactly(_ count: Int) -> Data? {
  var data = Data(capacity: count)
  while data.count < count {
    guard let chunk = try? stdinHandle.read(upToCount: count - data.count), !chunk.isEmpty else { return nil }
    data.append(chunk)
  }
  return data
}

func u32(_ data: Data, _ index: Int) -> Int {
  Int(data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: index * 4, as: UInt32.self) }.littleEndian)
}

extension Data {
  mutating func appendU32(_ value: Int) {
    Swift.withUnsafeBytes(of: UInt32(value).littleEndian) { append(contentsOf: $0) }
  }
}

func respond(id: Int, width: Int = 0, height: Int = 0, message: String = "", rgb: Data? = nil, depth: [Float]? = nil,
             failed: Bool = false) {
  let text = Data(message.utf8)
  var out = Data()
  for value in [id, failed ? 1 : 0, width, height, depth == nil ? 0 : 1, text.count] { out.appendU32(value) }
  out.append(text)
  if let rgb { out.append(rgb) }
  depth?.withUnsafeBytes { out.append(contentsOf: $0) }
  stdoutHandle.write(out)
}

func decodeJPEG(_ data: Data) throws -> CGImage {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw WorkerError(description: "not a decodable image") }
  return image
}

/// The image scaled to width×height as tightly packed RGB rows, top row first.
func rgbPixels(_ image: CGImage, width: Int, height: Int) throws -> Data {
  var rgba = [UInt8](repeating: 0, count: width * height * 4)
  let drawn = rgba.withUnsafeMutableBytes { bytes -> Bool in
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  guard drawn else { throw WorkerError(description: "could not create a bitmap context") }
  var rgb = Data(count: width * height * 3)
  rgb.withUnsafeMutableBytes { out in
    for i in 0..<(width * height) {
      out[i * 3] = rgba[i * 4]
      out[i * 3 + 1] = rgba[i * 4 + 1]
      out[i * 3 + 2] = rgba[i * 4 + 2]
    }
  }
  return rgb
}

final class DepthModel {
  private let model: MLModel
  private let inputName: String
  private let outputName: String
  private let constraint: MLImageConstraint

  init(url: URL) throws {
    let compiled = url.pathExtension == "mlmodelc" ? url : try MLModel.compileModel(at: url)
    let config = MLModelConfiguration()
    config.computeUnits = .all
    model = try MLModel(contentsOf: compiled, configuration: config)
    let description = model.modelDescription
    guard let input = description.inputDescriptionsByName.first(where: { $0.value.type == .image }),
          let constraint = input.value.imageConstraint,
          let output = description.outputDescriptionsByName.keys.first else {
      throw WorkerError(description: "expected a model with an image input and one output")
    }
    inputName = input.key
    outputName = output
    self.constraint = constraint
  }

  var inputSize: (Int, Int) { (constraint.pixelsWide, constraint.pixelsHigh) }

  /// Relative inverse depth resampled to width×height (the model's input is stretched to its own
  /// size, so every output pixel lines up with the same spot of the original image).
  func predict(_ image: CGImage, width: Int, height: Int) throws -> [Float] {
    let value = try MLFeatureValue(cgImage: image, constraint: constraint,
                                   options: [.cropAndScale: VNImageCropAndScaleOption.scaleFill.rawValue])
    let result = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: [inputName: value]))
    guard let buffer = result.featureValue(for: outputName)?.imageBufferValue,
          CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent16Half else {
      throw WorkerError(description: "expected a Grayscale16Half image output")
    }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw WorkerError(description: "empty output") }
    let srcW = CVPixelBufferGetWidth(buffer)
    let srcH = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    func sample(_ x: Int, _ y: Int) -> Float {
      Float(base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float16.self)[x])
    }
    var out = [Float](repeating: 0, count: width * height)
    let sx = Float(srcW) / Float(width)
    let sy = Float(srcH) / Float(height)
    for y in 0..<height {
      let fy = min(max((Float(y) + 0.5) * sy - 0.5, 0), Float(srcH - 1))
      let y0 = Int(fy)
      let y1 = min(y0 + 1, srcH - 1)
      let ty = fy - Float(y0)
      for x in 0..<width {
        let fx = min(max((Float(x) + 0.5) * sx - 0.5, 0), Float(srcW - 1))
        let x0 = Int(fx)
        let x1 = min(x0 + 1, srcW - 1)
        let tx = fx - Float(x0)
        let top = sample(x0, y0) * (1 - tx) + sample(x1, y0) * tx
        let bottom = sample(x0, y1) * (1 - tx) + sample(x1, y1) * tx
        out[y * width + x] = top * (1 - ty) + bottom * ty
      }
    }
    return out
  }
}

func blankImage(width: Int, height: Int) -> CGImage? {
  guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
  context.setFillColor(gray: 0.5, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  return context.makeImage()
}

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: depth_worker <model.mlmodelc | model.mlpackage>\n".utf8))
  exit(2)
}

let model: DepthModel
do {
  model = try DepthModel(url: URL(fileURLWithPath: CommandLine.arguments[1]))
  // The first prediction compiles the model for the Neural Engine, which takes a few seconds.
  let (w, h) = model.inputSize
  if let warmup = blankImage(width: w, height: h) { _ = try model.predict(warmup, width: 8, height: 6) }
  respond(id: 0, message: "ready \(w)x\(h)")
} catch {
  respond(id: 0, message: "could not load the depth model: \(error)", failed: true)
  exit(1)
}

while let header = readExactly(20) {
  let id = u32(header, 0)
  let width = u32(header, 1)
  let height = u32(header, 2)
  let wantDepth = u32(header, 3) & 1 == 1
  guard let jpeg = readExactly(u32(header, 4)) else { break }
  autoreleasepool {
    do {
      guard width > 0, height > 0, width * height <= 4096 * 4096 else {
        throw WorkerError(description: "bad output size \(width)x\(height)")
      }
      let image = try decodeJPEG(jpeg)
      let rgb = try rgbPixels(image, width: width, height: height)
      let depth = wantDepth ? try model.predict(image, width: width, height: height) : nil
      respond(id: id, width: width, height: height, rgb: rgb, depth: depth)
    } catch {
      respond(id: id, message: "\(error)", failed: true)
    }
  }
}
