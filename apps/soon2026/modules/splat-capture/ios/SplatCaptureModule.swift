import ExpoModulesCore

struct StartCaptureOptions: Record {
  @Field var maxFrames: Int = 300
  @Field var imageWidth: Int = 1280
  /// Use the no-LiDAR path even on a LiDAR device (to test the fallback).
  @Field var forceFeaturePoints: Bool = false
  /// Splat server to stream the recording to for live reconstruction.
  @Field var liveServerUrl: String? = nil
  /// The splat server's access token.
  @Field var serverToken: String? = nil
}

public class SplatCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SplatCapture")

    Events("onStatus", "onUploadProgress")

    OnCreate {
      CaptureController.shared.onStatus = { [weak self] status in
        self?.sendEvent("onStatus", status)
      }
    }

    Function("getCapabilities") {
      CaptureController.capabilities()
    }

    AsyncFunction("startCapture") { (options: StartCaptureOptions, promise: Promise) in
      let settings = CaptureSettings(maxFrames: options.maxFrames, imageWidth: options.imageWidth,
                                     forceFeaturePoints: options.forceFeaturePoints,
                                     liveServerURL: options.liveServerUrl.flatMap { URL(string: $0) },
                                     serverToken: options.serverToken)
      CaptureController.shared.start(settings) { promise.settle($0) }
    }

    AsyncFunction("stopCapture") { (promise: Promise) in
      CaptureController.shared.stop { promise.settle($0) }
    }

    AsyncFunction("nextDetectionFrame") { (maxSize: Int, promise: Promise) in
      CaptureController.shared.nextDetectionFrame(maxSize: maxSize) { promise.resolve($0) }
    }

    AsyncFunction("currentCamera") { (includeDepth: Bool, promise: Promise) in
      CaptureController.shared.currentCamera(includeDepth: includeDepth) { promise.resolve($0) }
    }

    AsyncFunction("listCaptures") {
      CaptureController.listCaptures()
    }

    AsyncFunction("deleteCapture") { (captureId: String) in
      try CaptureController.deleteCapture(id: captureId)
    }

    // Debug splat preview: uploads the saved zip to the splat server (server/, see CaptureUploader).
    AsyncFunction("uploadCapture") { (captureId: String, serverUrl: String, token: String, promise: Promise) in
      guard let zip = CaptureController.zipURL(id: captureId) else {
        return promise.reject("ERR_CAPTURE_NOT_FOUND", "No saved capture \(captureId)")
      }
      guard let server = URL(string: serverUrl) else {
        return promise.reject("ERR_BAD_SERVER_URL", "Invalid server URL \(serverUrl)")
      }
      Task {
        do {
          let result = try await CaptureUploader.upload(zip, server: server, captureId: captureId, token: token) {
            [weak self] sent, total in
            self?.sendEvent("onUploadProgress", ["captureId": captureId, "sentBytes": sent, "totalBytes": total])
          }
          promise.resolve(["status": result.status, "body": result.body])
        } catch {
          promise.reject("ERR_UPLOAD", error.localizedDescription)
        }
      }
    }

    View(SplatCaptureView.self) {
      Prop("showFeaturePoints", true) { (view: SplatCaptureView, show: Bool) in
        view.showFeaturePoints = show
      }
      Prop("active", true) { (view: SplatCaptureView, active: Bool) in
        view.active = active
      }
      Prop("camera", CameraPosition.back) { (view: SplatCaptureView, camera: CameraPosition) in
        view.camera = camera
      }
    }
  }
}

extension CameraPosition: Enumerable {}

private extension Promise {
  func settle(_ result: Result<[String: Any], Error>) {
    switch result {
    case .success(let value): resolve(value)
    case .failure(let error): reject("ERR_CAPTURE", error.localizedDescription)
    }
  }
}
