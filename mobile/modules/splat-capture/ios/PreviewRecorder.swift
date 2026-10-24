import AVFoundation
import VideoToolbox

/// A small video of a recording for the gallery to play: the camera feed scaled down, at most
/// 30 fps, and shown upright by the track's transform (ARKit's frames are landscape). It isn't part
/// of the dataset; the library keeps it beside the zip, like the thumbnail.
///
/// Frames are added on the AR session's frame queue while recording, and `finish` runs on the write
/// queue once no more are coming. Each frame is copied out of ARKit's buffer straight away, so the
/// encoder never holds on to ARKit's small buffer pool.
final class PreviewRecorder {
  static let longSide = 960
  static let frameInterval: TimeInterval = 1.0 / 30

  let url: URL
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var transfer: VTPixelTransferSession?
  private var firstTimestamp: TimeInterval?
  private var lastTimestamp = -TimeInterval.infinity
  private var failed = false

  init(url: URL) {
    self.url = url
  }

  /// Adds a camera frame, unless it comes too soon after the last one or the encoder is busy.
  func append(_ image: CVPixelBuffer, timestamp: TimeInterval) {
    // A little slack, so a 60 fps feed keeps every other frame despite jitter.
    guard !failed, timestamp - lastTimestamp >= Self.frameInterval * 0.9 else { return }
    if writer == nil && !start(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image)) {
      failed = true
      return
    }
    guard let writer, let input, let adaptor, let transfer, input.isReadyForMoreMediaData,
          let pool = adaptor.pixelBufferPool else { return }
    var scaled: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &scaled) == kCVReturnSuccess, let scaled,
          VTPixelTransferSessionTransferImage(transfer, from: image, to: scaled) == noErr else { return }
    // Keeps the camera's colour tags, which the encoder writes into the file.
    CVBufferPropagateAttachments(image, scaled)
    if firstTimestamp == nil {
      firstTimestamp = timestamp
      writer.startSession(atSourceTime: .zero)
    }
    let time = CMTime(seconds: timestamp - (firstTimestamp ?? timestamp), preferredTimescale: 600)
    if adaptor.append(scaled, withPresentationTime: time) {
      lastTimestamp = timestamp
    } else if writer.status == .failed {
      failed = true
    }
  }

  /// Finishes the file and waits for it. Nil if no frame was written or writing failed, in which
  /// case there's no file.
  func finish() -> URL? {
    guard let writer, let input, firstTimestamp != nil, writer.status == .writing else {
      if writer?.status == .writing { writer?.cancelWriting() }
      try? FileManager.default.removeItem(at: url)
      return nil
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status == .completed { return url }
    try? FileManager.default.removeItem(at: url)
    return nil
  }

  private func start(width sourceWidth: Int, height sourceHeight: Int) -> Bool {
    guard sourceWidth > 0, sourceHeight > 0 else { return false }
    // Encoders want even sizes.
    let width = min(Self.longSide, sourceWidth) / 2 * 2
    let height = Int((Double(sourceHeight) * Double(width) / Double(sourceWidth) / 2).rounded()) * 2
    try? FileManager.default.removeItem(at: url)
    guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 3_000_000,
        AVVideoExpectedSourceFrameRateKey: 30,
        // A keyframe a second, so scrubbing in the gallery stays quick.
        AVVideoMaxKeyFrameIntervalKey: 30,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ] as [String: Any],
    ])
    input.expectsMediaDataInRealTime = true
    // ARKit's image is the sensor's landscape; a quarter turn clockwise makes it upright in portrait.
    input.transform = CGAffineTransform(rotationAngle: .pi / 2)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ])
    var transfer: VTPixelTransferSession?
    guard writer.canAdd(input),
          VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer) == noErr,
          let transfer else { return false }
    writer.add(input)
    guard writer.startWriting() else { return false }
    self.writer = writer
    self.input = input
    self.adaptor = adaptor
    self.transfer = transfer
    return true
  }

  deinit {
    if let transfer { VTPixelTransferSessionInvalidate(transfer) }
  }
}
