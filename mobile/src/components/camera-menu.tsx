import { Section, Toggle } from '@expo/ui/swift-ui';

import { RailMenu } from './rail-menu';

export type CameraMenuProps = {
  detection: boolean;
  onDetectionChange: (detection: boolean) => void;
  featurePoints: boolean;
  onFeaturePointsChange: (featurePoints: boolean) => void;
  /** Stream each recording to the splat server, which rebuilds it live in 3D, floating over the camera. */
  liveStream: boolean;
  onLiveStreamChange: (liveStream: boolean) => void;
  /** Shows timings over the viewfinder. */
  debug: boolean;
  onDebugChange: (debug: boolean) => void;
  /** Heads the detection section: the model, or why it isn't running. */
  detectionInfo: string;
};

/** The camera screen's options, as a native menu behind the ⋯ at the foot of the camera's rail. */
export function CameraMenu({
  detection,
  onDetectionChange,
  featurePoints,
  onFeaturePointsChange,
  liveStream,
  onLiveStreamChange,
  debug,
  onDebugChange,
  detectionInfo,
}: CameraMenuProps) {
  return (
    <RailMenu icon="dots-horizontal" label="Camera options">
      <Section title={detectionInfo}>
        <Toggle
          label="Detect objects"
          systemImage="viewfinder"
          isOn={detection}
          onIsOnChange={onDetectionChange}
        />
      </Section>
      <Toggle
        label="Feature points"
        systemImage="circle.dotted"
        isOn={featurePoints}
        onIsOnChange={onFeaturePointsChange}
      />
      <Toggle label="Live 3D while recording" systemImage="cube" isOn={liveStream} onIsOnChange={onLiveStreamChange} />
      <Toggle label="Debug" systemImage="ladybug" isOn={debug} onIsOnChange={onDebugChange} />
    </RailMenu>
  );
}
