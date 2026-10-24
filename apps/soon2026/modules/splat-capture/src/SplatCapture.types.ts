import type { StyleProp, ViewStyle } from 'react-native';

/** `lidar`: LiDAR depth seeds the splat. `features`: no LiDAR, ARKit feature points seed it. */
export type CaptureMode = 'lidar' | 'features';

export type TrackingState = 'normal' | 'limited' | 'notAvailable';

export type Capabilities = {
  arkit: boolean;
  lidar: boolean;
};

export type CaptureStatus = {
  recording: boolean;
  mode: CaptureMode;
  tracking: TrackingState;
  /** Why tracking is limited, e.g. `excessiveMotion` or `insufficientFeatures`. */
  trackingReason?: string;
  frames: number;
  points: number;
  elapsed: number;
  /** The frame budget is used up; further frames are ignored. */
  full: boolean;
  /** Tracking failed during this recording, so no more frames are added; stop to save it. */
  frozen?: boolean;
  /** Set when the AR session failed; it restarts by itself. */
  error?: string;
};

export type StartCaptureOptions = {
  maxFrames?: number;
  imageWidth?: number;
  /** Use the no-LiDAR path even on a LiDAR device. */
  forceFeaturePoints?: boolean;
};

/**
 * A capture saved on the phone as one zip: `<captureId>/images/*.jpg`, `transforms.json`
 * (Nerfstudio format), `points.ply` (seed cloud, when there is one) and `capture.json`.
 */
export type SavedCapture = {
  captureId: string;
  /** file:// URL of the zip, ready for sharing. */
  uri: string;
  bytes: number;
  savedAt: string;
  /** Missing for a zip that was put in the Captures folder some other way. */
  mode?: CaptureMode;
  frames?: number;
  points?: number;
  durationSeconds?: number;
};

/** A camera frame for object detection: upright for the portrait UI, as RGBA rows. */
export type DetectionFrame = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type UploadProgress = {
  captureId: string;
  sentBytes: number;
  totalBytes: number;
};

export type UploadResult = {
  status: number;
  body: string;
};

export type SplatCaptureModuleEvents = {
  onStatus: (status: CaptureStatus) => void;
  onUploadProgress: (progress: UploadProgress) => void;
};

export type SplatCaptureViewProps = {
  /** Draw ARKit's tracked feature points over the camera. Defaults to true. */
  showFeaturePoints?: boolean;
  /**
   * Run the camera. Set false when the screen loses focus so other screens can use
   * the camera; an in-progress recording keeps it running. Defaults to true.
   */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
};
