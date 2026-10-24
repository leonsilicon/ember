import ARKit
import ExpoModulesCore

/// Live camera preview for capture. The view's own AR session is the one that's
/// recorded: `CaptureController` attaches to it as the session delegate.
class SplatCaptureView: ExpoView {
  private let sceneView = ARSCNView()

  /// Draws ARKit's tracked feature points — the seed cloud in no-LiDAR mode — over the camera.
  var showFeaturePoints = true {
    didSet { sceneView.debugOptions = showFeaturePoints ? [.showFeaturePoints] : [] }
  }

  /// iOS allows one camera session at a time and tab screens stay mounted, so the
  /// session only runs while the screen is focused (or a recording is in progress).
  var active = true {
    didSet { updateSession() }
  }

  /// The front camera previews and feeds detection, but only the back camera records.
  var camera = CameraPosition.back {
    didSet { updateSession() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    sceneView.frame = bounds
    sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    sceneView.automaticallyUpdatesLighting = false
    sceneView.debugOptions = [.showFeaturePoints]
    // SceneKit exposes its nodes to accessibility, and walking them while ARKit swaps the anchors'
    // nodes (as when the camera flips) crashed in SCNGeometry. The preview has nothing to read anyway.
    sceneView.accessibilityElementsHidden = true
    addSubview(sceneView)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSession()
  }

  private func updateSession() {
    let visible = window != nil && active
    if visible {
      CaptureController.shared.attach(sceneView.session)
      CaptureController.shared.setCamera(camera)
    }
    CaptureController.shared.setPreviewVisible(visible)
  }
}
