import { useEffect, useMemo, useState } from 'react';
import { useObjectDetector, type ObjectDetection, type ObjectDetectorModel } from 'react-native-executorch';

import SplatCapture, { type DetectionCamera } from '../../modules/splat-capture';

import type { Size } from '@/components/detection-overlay';
import { useDebugSettings } from '@/hooks/use-debug-settings';

const MODEL_NAME = 'OWL-ViT · leaves';
/** packages/owlvit's build, which the splat server serves at /models/. */
const MANIFEST_PATH = '/models/owlvit-leaves.json';
// The model sees each frame stretched to 768×768 (OWL-ViT's input), so this is as much as it uses.
const FRAME_SIZE = 768;
const RETRY_MS = 1000;

/** What `bun run --filter @soon2026/owlvit build` writes next to the model (see export.py). */
type LeafDetectorManifest = {
  /** File name of the .pte, unique to each build. */
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
  /** The upright camera frame the boxes are in, scaled down from the camera's full size. */
  frameSize: Size;
  /** Inference time, smoothed over recent frames. */
  latencyMs: number;
  /** Where the camera was for the frame, to place the detections in the world. */
  camera?: DetectionCamera;
};

export type Detections = {
  /** The model, and how fast it runs once it does. */
  model: string;
  /** Why detection isn't running: the model is still downloading or loading, or failed to load. */
  status?: string;
  result?: DetectionResult;
  error?: string;
};

function serverEndpoint(serverUrl: string, path: string) {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

/** react-native-executorch's object detector, run on the leaf detector's export. */
function detectorConfig(serverUrl: string, manifest: LeafDetectorManifest): ObjectDetectorModel<'xyxy', string> {
  const { mean, std } = manifest;
  return {
    modelPath: serverEndpoint(serverUrl, `/models/${manifest.model}`),
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

// Stands in until the manifest arrives; `preventLoad` keeps it from being fetched.
const NO_MODEL: ObjectDetectorModel<'xyxy', string> = {
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

type Fetched = { serverUrl: string; manifest?: LeafDetectorManifest; error?: string };

/** The leaf detector's manifest from the splat server, which says which model to download. */
function useManifest(serverUrl: string): Omit<Fetched, 'serverUrl'> {
  const [fetched, setFetched] = useState<Fetched>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(serverEndpoint(serverUrl, MANIFEST_PATH));
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setFetched({ serverUrl, manifest: body });
      } catch (e) {
        if (!cancelled) setFetched({ serverUrl, error: `${serverUrl}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  // Until the server the settings now name answers, there's no manifest.
  return fetched?.serverUrl === serverUrl ? fetched : {};
}

/**
 * Runs the OWL-ViT leaf detector on the capture camera's frames while `enabled`. The AR session
 * owns the camera, so frames come from it (see `nextDetectionFrame`) rather than from a second
 * camera session. The model is built on the Mac and downloaded from the splat server once.
 */
export function useDetections(enabled: boolean): Detections {
  const { serverUrl } = useDebugSettings();
  const manifest = useManifest(serverUrl);
  const config = useMemo(
    () => (manifest.manifest ? detectorConfig(serverUrl, manifest.manifest) : NO_MODEL),
    [serverUrl, manifest.manifest],
  );
  const detector = useObjectDetector(config, { preventLoad: !manifest.manifest });
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
          const frame = await SplatCapture.nextDetectionFrame(FRAME_SIZE);
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
            detections,
            frameSize: { width: frame.width, height: frame.height },
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
  }, [enabled, detectObjects]);

  let status: string | undefined;
  if (manifest.error) {
    status = `Couldn't get ${MODEL_NAME} from ${manifest.error}`;
  } else if (!manifest.manifest) {
    status = `Looking up ${MODEL_NAME}…`;
  } else if (detector.error) {
    status = `Couldn't load ${MODEL_NAME}: ${detector.error.message}`;
  } else if (!detector.isReady) {
    status =
      detector.downloadProgress < 100
        ? `Downloading ${MODEL_NAME}… ${Math.round(detector.downloadProgress)}%`
        : // Core ML compiles a model for the phone the first time it loads it.
          `Loading ${MODEL_NAME}…`;
  }

  const running = enabled && !status;
  return {
    // Rounded so the menu showing it isn't rebuilt on every frame.
    model: running && result ? `${MODEL_NAME} · ~${Math.round(result.latencyMs / 10) * 10} ms` : MODEL_NAME,
    status,
    result: running ? result : undefined,
    error: running ? error : undefined,
  };
}
