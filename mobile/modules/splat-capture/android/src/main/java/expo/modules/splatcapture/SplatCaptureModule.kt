package expo.modules.splatcapture

import android.content.pm.PackageManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The capture module on Android, which has no ARKit: no recording, detection, LiDAR or world tracking.
 * It does what mount and remote mode need: the camera on screen (`SplatCaptureView`), served on the
 * Wi-Fi (`CameraStreamServer`), and the other phones' cameras found (`CameraStreamBrowser`). The rest
 * answers as an iPhone without them would.
 */
class SplatCaptureModule : Module() {
  private val browser: CameraStreamBrowser by lazy {
    CameraStreamBrowser(context, requireNotNull(server).id).also { browser ->
      browser.onChange = { streams -> sendEvent("onCameraStreams", mapOf("streams" to streams.map { it.toMap() })) }
    }
  }

  private val context get() = requireNotNull(appContext.reactContext).applicationContext

  override fun definition() = ModuleDefinition {
    Name("SplatCapture")

    Events("onStatus", "onUploadProgress", "onCameraStreams")

    OnCreate {
      if (server == null) server = CameraStreamServer(context)
    }

    Function("getCapabilities") {
      mapOf(
        "arkit" to false,
        "lidar" to false,
        "frontCamera" to false,
        "cameraStream" to true,
        "torch" to context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH),
      )
    }

    AsyncFunction("startCapture") { _: Map<String, Any?>, promise: Promise ->
      promise.reject("ERR_CAPTURE", "Recording needs ARKit, so an iPhone", null)
    }

    AsyncFunction("stopCapture") { promise: Promise ->
      promise.reject("ERR_CAPTURE", "Nothing is recording", null)
    }

    AsyncFunction("nextDetectionFrame") { _: Int, _: Double -> null as Map<String, Any>? }

    AsyncFunction("currentCamera") { _: Boolean -> null as Map<String, Any>? }

    Function("setLiveServer") { _: String?, _: String?, _: String? -> }

    Function("startCameraStream") { port: Int ->
      val server = requireNotNull(server)
      server.start(port)
      server.status()
    }

    Function("publishCameraDetections") { json: String ->
      server?.publishDetections(json)
    }

    Function("stopCameraStream") {
      server?.stop()
    }

    Function("cameraStreamStatus") {
      requireNotNull(server).status()
    }

    Function("startCameraBrowse") {
      browser.start()
    }

    Function("stopCameraBrowse") {
      browser.stop()
    }

    AsyncFunction("listCaptures") { emptyList<Map<String, Any>>() }

    AsyncFunction("deleteCapture") { _: String -> }

    AsyncFunction("uploadCapture") { _: String, _: String, _: String, _: String?, promise: Promise ->
      promise.reject("ERR_UPLOAD", "There are no captures on Android", null)
    }

    View(SplatCaptureView::class) {
      Prop("active") { view: SplatCaptureView, active: Boolean ->
        view.active = active
      }
      Prop("torch") { view: SplatCaptureView, on: Boolean ->
        view.torch = on
      }
      // The back camera only, without feature points: ARKit's.
      Prop("camera") { _: SplatCaptureView, _: String -> }
      Prop("showFeaturePoints") { _: SplatCaptureView, _: Boolean -> }
    }
  }

  companion object {
    /** One for the app, shared with the camera view, which feeds it frames. */
    @Volatile
    var server: CameraStreamServer? = null
      private set
  }
}
