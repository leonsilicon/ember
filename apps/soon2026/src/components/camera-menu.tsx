import { Host, Image, Menu, Section, Toggle } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  background,
  buttonStyle,
  frame,
  glassEffect,
  menuIndicator,
  menuStyle,
  shapes,
} from '@expo/ui/swift-ui/modifiers';

import { LIQUID_GLASS } from './glass';

export type CameraMenuProps = {
  detection: boolean;
  onDetectionChange: (detection: boolean) => void;
  featurePoints: boolean;
  onFeaturePointsChange: (featurePoints: boolean) => void;
  /** Shows timings over the viewfinder. */
  debug: boolean;
  onDebugChange: (debug: boolean) => void;
  /** Heads the detection section: the model, or why it isn't running. */
  detectionInfo: string;
};

/** The camera screen's options, as a native menu behind a round glass button beside the record button. */
export function CameraMenu({
  detection,
  onDetectionChange,
  featurePoints,
  onFeaturePointsChange,
  debug,
  onDebugChange,
  detectionInfo,
}: CameraMenuProps) {
  return (
    <Host matchContents colorScheme="dark">
      <Menu
        label={
          <Image
            systemName="ellipsis"
            size={20}
            color="#ffffff"
            modifiers={[
              frame({ width: 48, height: 48 }),
              LIQUID_GLASS
                ? glassEffect({ glass: { variant: 'regular' }, shape: 'circle' })
                : background('rgba(40,40,40,0.75)', shapes.circle()),
            ]}
          />
        }
        modifiers={[
          menuStyle('button'),
          buttonStyle('plain'),
          menuIndicator('hidden'),
          accessibilityLabel('Camera options'),
        ]}>
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
        <Toggle label="Debug" systemImage="ladybug" isOn={debug} onIsOnChange={onDebugChange} />
      </Menu>
    </Host>
  );
}
