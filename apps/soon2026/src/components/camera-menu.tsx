import { Host, Image, Menu, Section, Toggle } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  background,
  buttonStyle,
  frame,
  menuIndicator,
  menuStyle,
  shapes,
} from '@expo/ui/swift-ui/modifiers';

export type CameraMenuProps = {
  detection: boolean;
  onDetectionChange: (detection: boolean) => void;
  featurePoints: boolean;
  onFeaturePointsChange: (featurePoints: boolean) => void;
  /** Heads the detection section, e.g. the model and how fast it runs. */
  detectionInfo: string;
};

/** The camera screen's options, as a native menu behind a round button. */
export function CameraMenu({
  detection,
  onDetectionChange,
  featurePoints,
  onFeaturePointsChange,
  detectionInfo,
}: CameraMenuProps) {
  return (
    <Host matchContents>
      <Menu
        label={
          <Image
            systemName="line.3.horizontal"
            size={18}
            color="#ffffff"
            modifiers={[frame({ width: 44, height: 44 }), background('rgba(0,0,0,0.55)', shapes.circle())]}
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
      </Menu>
    </Host>
  );
}
