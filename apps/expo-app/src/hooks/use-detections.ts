import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { useObjectDetector, type ObjectDetection, type ObjectDetectorModel } from 'react-native-executorch';
import type { SharedValue } from 'react-native-reanimated';

import SplatCapture, { type DetectionCamera, type DetectionFrame } from '../../modules/splat-capture';

import type { Size } from '@/components/detection-overlay';

const MODEL_NAME = 'OWL-ViT · leaves';
/** packages/owlvit's build, which plugins/with-leaf-detector.js embeds in the app. */
const MANIFEST_FILE = 'owlvit-leaves.json';
// The model sees each frame stretched to 768×768 (OWL-ViT's input), so this is as much as it uses.
const FRAME_SIZE = 768;
const RETRY_MS = 1000;

/** What `bun run --filter @soon2026/owlvit build` writes next to the model (see export.py). */
type LeafDetectorManifest = {
  /** File name of the .pte, beside the manifest in the app. */
  model: string;
  precision: string;
  inputSize: number;
  /** One per text query; the model's classes index them. */
  labels: string[];
  /** CLIP's normalization, applied after stretching the frame to `inputSize`². */
  mean: [number, number, number];
  std: [number, number, number];
  confidenceThreshold: number;
  iouThreshold: number;
};

export type Detection = ObjectDetection<'xyxy', string>;

export type DetectionResult = {
  detections: Detection[];
  /**
   * The whole upright camera frame the boxes are in, scaled from the camera's full size, even when
   * the model only saw its zoomed-in middle.
   */
  frameSize: Size;
  /** The digital zoom the frame was taken at: the model saw the centred 1/zoom of `frameSize`. */
  zoom: number;
  /** Inference time, smoothed over recent frames. */
  latencyMs: number;
  /** Where the camera was for the frame, to place the detections in the world. */
  camera?: DetectionCamera;
};

export type Detections = {
  /** The model's name. */
  model: string;
  /** Why detection isn't running: the model is still loading, failed to load, or isn't in this build. */
  status?: string;
  /** The model isn't in this build or failed to load, rather than still loading. */
  unavailable: boolean;
  result?: DetectionResult;
  error?: string;
};

/** A file in the app bundle as a plain path, which react-native-executorch loads without copying. */
function bundlePath(name: string) {
  return decodeURIComponent(new File(Paths.bundle, name).uri.replace(/^file:\/\//, ''));
}

/** react-native-executorch's object detector, run on the leaf detector's export. */
function detectorConfig(manifest: LeafDetectorManifest): ObjectDetectorModel<'xyxy', string> {
  const { mean, std } = manifest;
  return {
    modelPath: bundlePath(manifest.model),
    modelOpts: {
      labels: manifest.labels,
      boxFormat: 'xyxy',
      resizeMode: 'stretch',
      interpolation: 'linear',
      normalizeOpts: {
        alpha: std.map((s) => 1 / (255 * s)),
        beta: mean.map((m, i) => -m / std[i]),
      },
      defaultConfidenceThreshold: manifest.confidenceThreshold,
      defaultIouThreshold: manifest.iouThreshold,
    },
  };
}

/** The embedded leaf detector's manifest, or why there isn't one. */
function readManifest(): { manifest?: LeafDetectorManifest; error?: string } {
  try {
    const file = new File(Paths.bundle, MANIFEST_FILE);
    if (!file.exists) return { error: "it isn't in this build (see packages/owlvit's README)" };
    return { manifest: JSON.parse(file.textSync()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const BUNDLED = readManifest();

const CONFIG: ObjectDetectorModel<'xyxy', string> = BUNDLED.manifest
  ? detectorConfig(BUNDLED.manifest)
  : // Stands in for the missing model; `preventLoad` keeps it from being loaded.
    {
      modelPath: '',
      modelOpts: {
        labels: [],
        boxFormat: 'xyxy',
        resizeMode: 'stretch',
        interpolation: 'linear',
        normalizeOpts: {},
        defaultConfidenceThreshold: 1,
        defaultIouThreshold: 1,
      },
    };

/**
 * The boxes from a frame cropped to its centred 1/zoom, in the whole frame, which the overlay and
 * the rover brain work in.
 */
function uncrop(detections: Detection[], frame: DetectionFrame): Pick<DetectionResult, 'detections' | 'frameSize'> {
  const frameSize = { width: frame.width * frame.zoom, height: frame.height * frame.zoom };
  const dx = (frameSize.width - frame.width) / 2;
  const dy = (frameSize.height - frame.height) / 2;
  return {
    frameSize,
    detections: detections.map(({ box, ...detection }) => ({
      ...detection,
      box: { ...box, xmin: box.xmin + dx, ymin: box.ymin + dy, xmax: box.xmax + dx, ymax: box.ymax + dy },
    })),
  };
}

/**
 * Runs the OWL-ViT leaf detector on the capture camera's frames while `enabled`. The AR session
 * owns the camera, so frames come from it (see `nextDetectionFrame`) rather than from a second
 * camera session. The model is built on the Mac and embedded in the app.
 *
 * Each frame is cropped to the preview's `zoom`, so zooming in on a leaf hands the model more of
 * the leaf, in more pixels, than the whole frame scaled down to its input would.
 */
export function useDetections(enabled: boolean, zoom: SharedValue<number>): Detections {
  const detector = useObjectDetector(CONFIG, { preventLoad: !BUNDLED.manifest });
  const { detectObjects } = detector;
  const [result, setResult] = useState<DetectionResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || detectObjects == null) return;
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        try {
          // Resolves once the camera delivers a frame, so this waits while the preview is paused.
          const frame = await SplatCapture.nextDetectionFrame(FRAME_SIZE, zoom.get());
          if (cancelled || frame == null) continue;
          const start = Date.now();
          const detections = await detectObjects({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            format: 'rgba',
            layout: 'hwc',
          });
          if (cancelled) break;
          const latencyMs = Date.now() - start;
          setResult((previous) => ({
            ...uncrop(detections, frame),
            zoom: frame.zoom,
            camera: frame.camera,
            latencyMs: previous ? previous.latencyMs * 0.9 + latencyMs * 0.1 : latencyMs,
          }));
          setError(undefined);
        } catch (e) {
          if (cancelled) break;
          setError(e instanceof Error ? e.message : String(e));
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, detectObjects, zoom]);

  let status: string | undefined;
  if (BUNDLED.error) {
    status = `No ${MODEL_NAME}: ${BUNDLED.error}`;
  } else if (detector.error) {
    status = `Couldn't load ${MODEL_NAME}: ${detector.error.message}`;
  } else if (!detector.isReady) {
    // Core ML compiles a model for the phone the first time it loads it.
    status = `Loading ${MODEL_NAME}…`;
  }

  const running = enabled && !status;
  return {
    model: MODEL_NAME,
    status,
    unavailable: Boolean(BUNDLED.error || detector.error),
    result: running ? result : undefined,
    error: running ? error : undefined,
  };
}
