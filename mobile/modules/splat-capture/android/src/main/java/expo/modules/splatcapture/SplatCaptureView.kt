package expo.modules.splatcapture

import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * The camera, without ARKit: CameraX's preview of the back camera, 4:3 like the iPhone's, filling the
 * view (which the camera screen sizes to the frame's shape, so nothing is cropped). While someone
 * watches the Wi-Fi camera, its frames go to `CameraStreamServer` as upright JPEGs.
 */
class SplatCaptureView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // CameraX lays out the preview itself, which React Native doesn't pick up otherwise.
  override val shouldUseAndroidLayout = true

  /** Run the camera; false while the screen is covered, or in remote mode. */
  var active = true
    set(value) {
      if (field == value) return
      field = value
      update()
    }

  /** Light the scene with the torch, like the Camera app's flash in video mode; lit while the camera runs. */
  var torch = false
    set(value) {
      if (field == value) return
      field = value
      camera?.cameraControl.enableTorch(value)
    }

  // A TextureView, so the preview zooms (a transform) and clips to the card's rounded corners.
  private val preview = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val analysisExecutor = Executors.newSingleThreadExecutor()
  private var provider: ProcessCameraProvider? = null
  /** The bound camera, whose torch is the flash. */
  private var camera: Camera? = null
  private var bound = false
  private var asked = false
  private var lastFrameAt = 0L

  init {
    addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    update()
  }

  override fun onDetachedFromWindow() {
    unbind()
    super.onDetachedFromWindow()
  }

  private fun update() {
    if (!isAttachedToWindow || !active) return unbind()
    if (bound) return
    val permissions = appContext.permissions ?: return
    if (!permissions.hasGrantedPermissions(Manifest.permission.CAMERA)) {
      if (asked) return
      asked = true
      permissions.askForPermissions({ result ->
        if (result[Manifest.permission.CAMERA]?.status == PermissionsStatus.GRANTED) post { update() }
      }, Manifest.permission.CAMERA)
      return
    }
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      val provider = future.get()
      this.provider = provider
      if (isAttachedToWindow && active && !bound) bind(provider, owner)
    }, ContextCompat.getMainExecutor(context))
  }

  private fun bind(provider: ProcessCameraProvider, owner: LifecycleOwner) {
    val fourByThree = ResolutionSelector.Builder()
      .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
      .build()
    val previewUseCase = Preview.Builder().setResolutionSelector(fourByThree).build()
    previewUseCase.setSurfaceProvider(preview.surfaceProvider)
    val analysis = ImageAnalysis.Builder()
      .setResolutionSelector(fourByThree)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
      // Upright, like the iPhone's stream.
      .setOutputImageRotationEnabled(true)
      .build()
    analysis.setAnalyzer(analysisExecutor) { image -> image.use { stream(it) } }
    provider.unbindAll()
    val camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
    this.camera = camera
    if (torch) camera.cameraControl.enableTorch(true)
    bound = true
  }

  private fun unbind() {
    if (!bound) return
    // Unbinding closes the camera, torch and all.
    provider?.unbindAll()
    camera = null
    bound = false
  }

  /** Encodes the frame for the Wi-Fi camera, only while someone watches, at most ~15 fps. */
  private fun stream(image: ImageProxy) {
    val server = SplatCaptureModule.server ?: return
    val now = SystemClock.elapsedRealtime()
    if (!server.wantsFrames || now - lastFrameAt < FRAME_INTERVAL_MS) return
    lastFrameAt = now
    val bitmap: Bitmap = image.toBitmap()
    val jpeg = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
    server.publish(jpeg.toByteArray(), bitmap.width, bitmap.height)
  }

  private companion object {
    const val FRAME_INTERVAL_MS = 66L
    const val JPEG_QUALITY = 70
  }
}
