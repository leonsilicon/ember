import type { StyleProp, ViewStyle } from 'react-native';

/** `lidar`: LiDAR depth seeds the splat. `features`: no LiDAR, ARKit feature points seed it. */
export type CaptureMode = 'lidar' | 'features';

export type TrackingState = 'normal' | 'limited' | 'notAvailable';

/** `back`: world tracking, which recording needs. `front`: the TrueDepth camera, for preview and detection. */
export type CameraPosition = 'back' | 'front';

export type Capabilities = {
  arkit: boolean;
  lidar: boolean;
  /** The front camera can be shown (ARKit face tracking, which needs a TrueDepth camera). */
  frontCamera: boolean;
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
  /** Present while a recording streams to the live reconstruction (`liveServerUrl`). */
  live?: LiveStatus;
};

/** The live stream to the splat server, and what the server has made of it so far. */
export type LiveStatus = {
  state: 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** Keyframes sent, and fused into the reconstruction or skipped by the server. */
  sent: number;
  fused: number;
  skipped: number;
  /** Points in the reconstruction. */
  points: number;
  /** Why the server skipped its latest skipped keyframe. */
  lastSkip?: string;
  error?: string;
};

export type StartCaptureOptions = {
  maxFrames?: number;
  imageWidth?: number;
  /** Use the no-LiDAR path even on a LiDAR device. */
  forceFeaturePoints?: boolean;
  /**
   * Splat server (apps/next-app, e.g. https://<project>.vercel.app) to stream the recording to while
   * it records; the scene is rebuilt live at `<server>/live` in a browser.
   */
  liveServerUrl?: string;
  /** The splat server's access token, for `liveServerUrl`. */
  serverToken?: string;
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
  /** file:// URL of a small upright JPEG of the first frame. Missing where `mode` is, and for older captures. */
  thumbnailUri?: string;
  /**
   * file:// URL of a small upright H.264 video of the whole recording, for the gallery to play. It
   * isn't in the zip. Missing where `thumbnailUri` is, and for captures from before it existed.
   */
  videoUri?: string;
};

/** A camera frame for object detection: upright for the portrait UI, as RGBA rows. */
export type DetectionFrame = {
  width: number;
  height: number;
  data: Uint8Array;
  /**
   * The digital zoom it was cropped to (at least 1): it shows the centred 1/zoom of the camera's
   * view, in each direction, at `width` × `height`.
   */
  zoom: number;
  /** Where the camera was for this frame; lets detections be placed in the world (src/lib/rover-brain). */
  camera?: DetectionCamera;
};

/** Pinhole intrinsics in pixels, for an image of `width` × `height`. */
export type PinholeIntrinsics = { fx: number; fy: number; cx: number; cy: number; width: number; height: number };

/**
 * The AR camera for a detection frame. ARKit conventions: the world is gravity-aligned with +y up;
 * camera space has +x right, +y up, looking down −z.
 */
export type DetectionCamera = {
  /** ARKit frame timestamp, seconds. */
  timestamp: number;
  /** Camera-to-world transform, 16 numbers, column-major. */
  pose: number[];
  /**
   * Of the sensor-oriented (landscape) camera image. The detection frame is that image rotated a
   * quarter turn clockwise (upright for portrait), cropped to its `zoom` and scaled.
   */
  intrinsics: PinholeIntrinsics;
  trackingNormal: boolean;
  /** LiDAR depth in the sensor orientation (256×192 on iPhone): float32 metres, row-major. */
  depth?: {
    width: number;
    height: number;
    /** Little-endian float32 bytes. */
    data: Uint8Array;
    /** ARKit confidence per pixel: 0 low, 1 medium, 2 high. */
    confidence?: Uint8Array;
  };
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
  /**
   * Which camera to show. The front one's preview is mirrored, like the Camera app's, and so are its
   * detection frames; it can't record. Defaults to `back`.
   */
  camera?: CameraPosition;
  style?: StyleProp<ViewStyle>;
};
