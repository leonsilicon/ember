import type { Detections } from './use-detections';

// Detection runs on the AR camera's frames, which only the iOS app has.
export function useDetections(): Detections {
  return { model: 'OWL-ViT · leaves', status: 'Object detection is only available in the iOS app.' };
}
