import { Button, Section } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { TONES } from './camera-status';
import { RailMenu } from './rail-menu';

import { caption, type RoverBrain } from '@/hooks/use-rover-brain';
import { FOOT_M, MAX_RANGE_M } from '@/lib/rover-brain';

const STOP_RED = '#FF453A';
const BAR_HEIGHT = 36;

/**
 * The rover's brain, as an icon in the camera's rail: a tap opens a native menu with the nearest
 * leaf, the pile, and the autopilot's start button. "Pile here" puts the pile where the rover
 * stands: it starts from the pile and collects the leaves within its work circle (6 ft by default).
 * While the autopilot drives, the icon turns into a stop button, and a long press still opens the
 * menu.
 */
export function RoverBrainMenu({ brain, canDrive }: { brain: RoverBrain; canDrive: boolean }) {
  const nearest = brain.leaves.find((l) => l.state === 'confirmed') ?? brain.leaves[0];
  const confirmed = brain.leaves.filter((l) => l.state === 'confirmed').length;
  const ready = canDrive && brain.hasDepth && brain.tracking && brain.pile != null;
  const on = brain.autopilot.on;
  const why = !canDrive
    ? 'connect the rover in Remote'
    : !brain.tracking
      ? 'waiting for tracking'
      : !brain.hasDepth
        ? 'needs LiDAR depth'
        : !brain.pile
          ? 'set a pile first'
          : '';
  const circle = `${Math.round(brain.workRadiusM / FOOT_M)} ft circle`;
  const leafText = nearest
    ? `Leaf ${caption(nearest.rover)}${nearest.state === 'tentative' ? ' (checking)' : ''}`
    : 'No leaves yet';
  const pileText = brain.pile?.rover ? `Pile ${caption(brain.pile.rover)} · ${circle}` : `No pile · ${circle}`;

  return (
    <RailMenu
      icon={on ? 'stop-circle' : 'robot-mower-outline'}
      color={on ? STOP_RED : ready ? undefined : TONES.dim}
      text={brain.load > 0 ? `${brain.load}/${brain.capacity}` : undefined}
      label={on ? 'Stop autopilot' : 'Rover autopilot'}
      onPrimaryAction={on ? brain.stopAutopilot : undefined}>
      <Section title={on ? brain.autopilot.message || 'Autopilot on' : why ? `Autopilot: ${why}` : leafText}>
        {on ? (
          <Button label="Stop autopilot" systemImage="stop.fill" role="destructive" onPress={brain.stopAutopilot} />
        ) : (
          <Button
            label="Start autopilot"
            systemImage="play.fill"
            onPress={brain.startAutopilot}
            modifiers={[disabled(!ready)]}
          />
        )}
      </Section>
      <Section title={`${pileText} · ${confirmed} found · ${brain.collected} scooped · ${brain.dumped} dumped`}>
        <Button
          label={brain.pile ? 'Move pile here' : 'Pile here'}
          systemImage="mappin.and.ellipse"
          onPress={brain.setPileHere}
          modifiers={[disabled(!brain.tracking || on)]}
        />
      </Section>
    </RailMenu>
  );
}

/**
 * The steering corridors the brain sees, for the debug overlay: bar height is how far it can drive
 * that way; red is blocked.
 */
export function CorridorFan({ brain }: { brain: RoverBrain }) {
  return (
    <View style={styles.fan} accessibilityLabel="Steering corridors">
      {brain.corridors.map((c) => (
        <View
          key={c.bearingDeg}
          style={[
            styles.bar,
            {
              height: Math.max(3, (Math.min(c.clearanceM, MAX_RANGE_M) / MAX_RANGE_M) * BAR_HEIGHT),
              backgroundColor: c.blockedBy ? STOP_RED : c.observedM > 0 ? '#30D158' : 'rgba(255,255,255,0.35)',
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fan: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: BAR_HEIGHT,
    gap: 2,
  },
  bar: {
    width: 5,
    borderRadius: 2,
  },
});
