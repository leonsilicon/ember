import { NativeModule, requireNativeModule } from 'expo';

import {
  Capabilities,
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
   * Resolves with the next frame of the capture camera, scaled so its longer side is `maxSize`,
   * once the preview is running. Resolves with null if a newer call replaces this one.
   */
  nextDetectionFrame(maxSize: number): Promise<DetectionFrame | null>;
  /**
   * The newest AR frame's camera: pose, intrinsics and, with `includeDepth`, LiDAR depth. Null
   * before the first frame. The rover's steering loop polls this.
   */
  currentCamera(includeDepth: boolean): Promise<DetectionCamera | null>;
  /** Saved captures, newest first. */
  listCaptures(): Promise<SavedCapture[]>;
  deleteCapture(captureId: string): Promise<void>;
  /** Debug splat preview: POSTs a saved capture zip to `<serverUrl>/api/captures` (see server/). */
  uploadCapture(captureId: string, serverUrl: string): Promise<UploadResult>;
}

export default requireNativeModule<SplatCaptureModule>('SplatCapture');
