import { NativeModule, requireNativeModule } from 'expo';

import {
  Capabilities,
  CameraStreamStatus,
  CaptureMode,
  DetectionCamera,
  DetectionFrame,
  SavedCapture,
  SplatCaptureModuleEvents,
  StartCaptureOptions,
  UploadResult,
} from './SplatCapture.types';

declare class SplatCaptureModule extends NativeModule<SplatCaptureModuleEvents> {
  getCapabilities(): Capabilities;
  startCapture(options: StartCaptureOptions): Promise<{ captureId: string; mode: CaptureMode }>;
  /** Finishes the dataset and saves it as a zip in the app's Documents/Captures folder. */
  stopCapture(): Promise<SavedCapture>;
  /**
   * Resolves with the next frame of the capture camera, cropped to its centred 1/`zoom` (as a
   * preview zoomed by `zoom` shows it) and scaled so its longer side is `maxSize`, once the preview
   * is running. Resolves with null if a newer call replaces this one.
   */
  nextDetectionFrame(maxSize: number, zoom: number): Promise<DetectionFrame | null>;
  /**
   * The newest AR frame's camera: pose, intrinsics and, with `includeDepth`, LiDAR depth. Null
   * before the first frame. The rover's steering loop polls this.
   */
  currentCamera(includeDepth: boolean): Promise<DetectionCamera | null>;
  /**
   * Serves the camera preview on the local network for the web app's live mode: an MJPEG stream at
   * `/camera.mjpg` (plus `/frame.jpg` and `/status`). Frames are only encoded while someone watches.
   */
  /**
   * Where recordings stream for live reconstruction (`liveServerUrl`), from now on; null for nowhere.
   * The connection is made straight away while the viewfinder is on screen (back camera), so a
   * recording streams from its first frame rather than after a handshake. `room` is the username the
   * recordings are sent to (see src/lib/username.ts); null for none.
   */
  setLiveServer(url: string | null, token: string | null, room: string | null): void;
  startCameraStream(port: number): CameraStreamStatus;
  stopCameraStream(): void;
  /** Hands the Wi-Fi camera's viewers the leaf detector's boxes: one JSON line, streamed at `/detections`. */
  publishCameraDetections(json: string): void;
  cameraStreamStatus(): CameraStreamStatus;
  /**
   * Looks on the Wi-Fi for the other phones' camera servers (Bonjour `_rovercam._tcp`), leaving this
   * one's own out; `onCameraStreams` reports them.
   */
  startCameraBrowse(): void;
  stopCameraBrowse(): void;
  /** Saved captures, newest first. */
  listCaptures(): Promise<SavedCapture[]>;
  deleteCapture(captureId: string): Promise<void>;
  /**
   * Uploads a saved capture zip to the splat server (see frontend), with its access token, into the
   * username's room (`room`, the `X-Room` header; null for none). Resolves with the server's reply to
   * the finished upload (201 and the job).
   */
  uploadCapture(captureId: string, serverUrl: string, token: string, room: string | null): Promise<UploadResult>;
}

export default requireNativeModule<SplatCaptureModule>('SplatCapture');
