import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useObjectDetector, type ObjectDetection, type ObjectDetectorModel } from 'react-native-executorch';
import type { SharedValue } from 'react-native-reanimated';

import SplatCapture, { type DetectionCamera, type DetectionFrame } from '../../modules/splat-capture';

import type { Size } from '@/components/detection-overlay';
import { DetectionTracker, trackerOptions, type Candidate, type TrackedDetection } from '@/lib/detection-tracker';
import { lidarDistances } from '@/lib/rover-brain';

const MODEL_NAME = 'OWL-ViT · leaves';
/** packages/owlvit's build, which plugins/with-leaf-detector.js embeds in the app. */
const MANIFEST_FILE = 'owlvit-leaves.json';
// The model sees each frame stretched to 768×768 (OWL-ViT's input), so this is as much as it uses.
const FRAME_SIZE = 768;
const RETRY_MS = 1000;
/** How long after a failed load (first, second, … failure) the model is loaded again. */
const RELOAD_MS = [5_000, 10_000, 30_000, 60_000];

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

/**
 * A box to show: one the tracker has seen enough of, smoothed over recent frames (see
 * src/lib/detection-tracker.ts), rather than straight from the latest frame.
 */
export type Detection = TrackedDetection;

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
  /**
   * How far each detection is from the phone in metres, by index, measured with LiDAR on the same
   * frame; null where LiDAR has no reading. Missing for frames without depth (no LiDAR, or the front
   * camera).
   */
  distances?: (number | null)[];
};

export type Detections = {
  /** The model's name. */
  model: string;
  /** Why detection isn't running: the model is still loading, failed to load, or isn't in this build. */
  status?: string;
  /** The model isn't in this build or failed to load, rather than still loading. */
  unavailable: boolean;
  /**
   * Detection is on its way but has nothing to show yet: the model is loading (Core ML compiles it
   * on the phone the first time), or it's running its first frames. Nothing is wrong.
   */
  busy: boolean;
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
 * The tracker shows a box at the model's own threshold, but keeps one it's showing alive on
 * weaker sightings, so the detector is run at that lower score.
 */
const TRACKER = trackerOptions(BUNDLED.manifest?.confidenceThreshold ?? 1);

/**
 * The boxes from a frame cropped to its centred 1/zoom, in the whole frame, which the tracker, the
 * overlay and the rover brain work in.
 */
function uncrop(
  detections: ObjectDetection<'xyxy', string>[],
  frame: DetectionFrame,
): { candidates: Candidate[]; frameSize: Size } {
  const frameSize = { width: frame.width * frame.zoom, height: frame.height * frame.zoom };
  const dx = (frameSize.width - frame.width) / 2;
  const dy = (frameSize.height - frame.height) / 2;
  return {
    frameSize,
    candidates: detections.map(({ box, label, confidence }) => ({
      label,
      confidence,
      box: { xmin: box.xmin + dx, ymin: box.ymin + dy, xmax: box.xmax + dx, ymax: box.ymax + dy },
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
 *
 * What comes back is the tracker's view of the frames, not the latest frame's detections: boxes
 * that have been seen in more than one frame, smoothed, and kept through a frame or two of misses,
 * so they don't blink.
 */
export function useDetections(enabled: boolean, zoom: SharedValue<number>): Detections {
  // A load can fail for a reason that passes (memory pressure while Core ML compiles the model), so
  // a failed load is tried again, with a growing wait. react-native-executorch keys the model on the
  // config's value, so a config that differs only in `attempt` loads it afresh; the number means
  // nothing to it otherwise.
  const [attempt, setAttempt] = useState(0);
  const config = useMemo(() => ({ ...CONFIG, attempt }), [attempt]);
  const detector = useObjectDetector(config, { preventLoad: !BUNDLED.manifest });
  const { detectObjects, error: loadError } = detector;
  useEffect(() => {
    if (!loadError) return;
    const timer = setTimeout(() => setAttempt((a) => a + 1), RELOAD_MS[Math.min(attempt, RELOAD_MS.length - 1)]);
    return () => clearTimeout(timer);
  }, [loadError, attempt]);
  const tracker = useRef(new DetectionTracker(TRACKER));
  // Results are tagged with the detector that made them: after a reload, the last one is stale and
  // the indicator says detection is starting until the new detector has run a frame.
  const [result, setResult] = useState<{ by: typeof detectObjects; value: DetectionResult }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || detectObjects == null) return;
    let cancelled = false;
    // Whatever was tracked before detection was paused is stale now.
    tracker.current.reset();

    (async () => {
      while (!cancelled) {
        try {
          // Resolves once the camera delivers a frame, so this waits while the preview is paused.
          const frame = await SplatCapture.nextDetectionFrame(FRAME_SIZE, zoom.get());
          if (cancelled || frame == null) continue;
          const start = Date.now();
          const found = await detectObjects(
            { data: frame.data, width: frame.width, height: frame.height, format: 'rgba', layout: 'hwc' },
            { confidenceThreshold: TRACKER.keepScore },
          );
          if (cancelled) break;
          const now = Date.now();
          const latencyMs = now - start;
          const { candidates, frameSize } = uncrop(found, frame);
          const detections = tracker.current.update(candidates, frameSize, now);
          setResult((previous) => ({
            by: detectObjects,
            value: {
              detections,
              frameSize,
              zoom: frame.zoom,
              camera: frame.camera,
              // Measured here, with the boxes, rather than by the rover brain a render later, so no
              // box ever shows without its distance.
              distances: frame.camera && lidarDistances(detections, frameSize, frame.camera),
              latencyMs: previous ? previous.value.latencyMs * 0.9 + latencyMs * 0.1 : latencyMs,
            },
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

  const current = result && detectObjects && result.by === detectObjects ? result.value : undefined;
  let status: string | undefined;
  let busy = false;
  if (BUNDLED.error) {
    status = `No ${MODEL_NAME}: ${BUNDLED.error}`;
  } else if (loadError) {
    status = `Couldn't load ${MODEL_NAME}: ${loadError.message}. Trying again…`;
  } else if (!detector.isReady) {
    // Core ML compiles a model for the phone the first time it loads it.
    status = `Loading ${MODEL_NAME}…`;
    busy = true;
  } else if (enabled && current == null && error == null) {
    // The first run through the model takes a while too.
    status = `Starting ${MODEL_NAME}…`;
    busy = true;
  }

  const running = enabled && !status;
  return {
    model: MODEL_NAME,
    status,
    unavailable: Boolean(BUNDLED.error || loadError),
    busy: enabled && busy,
    result: running ? current : undefined,
    error: running ? error : undefined,
  };
}
