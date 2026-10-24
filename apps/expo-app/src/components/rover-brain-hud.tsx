import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { caption, type RoverBrain } from '@/hooks/use-rover-brain';
import { FOOT_M, MAX_RANGE_M } from '@/lib/rover-brain';

const BAR_HEIGHT = 36;

/**
 * What the rover's brain sees: a fan of steering corridors (bar height = how far it can drive
 * that way; red = blocked), the nearest leaf, the pile, and the autopilot with its start/stop
 * button. "Pile here" puts the pile where the rover stands: it starts from the pile and collects the
 * leaves within its work circle (6 ft by default).
 */
export function RoverBrainHud({ brain, canDrive }: { brain: RoverBrain; canDrive: boolean }) {
  const nearest = brain.leaves.find((l) => l.state === 'confirmed') ?? brain.leaves[0];
  const confirmed = brain.leaves.filter((l) => l.state === 'confirmed').length;
  const ready = canDrive && brain.hasDepth && brain.tracking && brain.pile != null;
  const why = !canDrive
    ? 'Connect the rover'
    : !brain.tracking
      ? 'Waiting for tracking'
      : !brain.hasDepth
        ? 'Needs LiDAR depth'
        : !brain.pile
          ? 'Set a pile first'
          : '';
  const circle = `${Math.round(brain.workRadiusM / FOOT_M)} ft circle`;
  const pileText = brain.pile?.rover ? `Pile ${caption(brain.pile.rover)} · ${circle}` : `No pile · ${circle}`;

  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <View style={styles.fan} accessibilityLabel="Steering corridors">
          {brain.corridors.map((c) => (
            <View
              key={c.bearingDeg}
              style={[
                styles.bar,
                {
                  height: Math.max(3, (Math.min(c.clearanceM, MAX_RANGE_M) / MAX_RANGE_M) * BAR_HEIGHT),
                  backgroundColor: c.blockedBy ? '#FF453A' : c.observedM > 0 ? '#30D158' : 'rgba(255,255,255,0.35)',
                },
              ]}
            />
          ))}
        </View>
        <View style={styles.text}>
          <ThemedText type="smallBold" style={styles.light} numberOfLines={1}>
            {nearest ? `Leaf ${caption(nearest.rover)}${nearest.state === 'tentative' ? ' (checking)' : ''}` : 'No leaves yet'}
          </ThemedText>
          <ThemedText type="small" style={styles.secondary} numberOfLines={1}>
            {confirmed} found · {brain.collected} scooped · {brain.dumped} dumped{brain.hasDepth ? '' : ' · no depth'}
          </ThemedText>
          <ThemedText type="small" style={styles.secondary} numberOfLines={1}>
            {pileText}
            {brain.load > 0 ? ` · bin ${brain.load}/${brain.capacity}` : ''}
          </ThemedText>
          {brain.autopilot.on && brain.autopilot.message !== '' && (
            <ThemedText type="small" style={styles.light} numberOfLines={1}>
              {brain.autopilot.message}
            </ThemedText>
          )}
        </View>
        {brain.autopilot.on ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop autopilot"
            onPress={brain.stopAutopilot}
            style={({ pressed }) => [styles.button, styles.stop, pressed && styles.pressed]}>
            <ThemedText type="smallBold" style={styles.light}>
              STOP
            </ThemedText>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Put the pile where the rover is"
              disabled={!brain.tracking}
              onPress={brain.setPileHere}
              style={({ pressed }) => [
                styles.button,
                styles.secondaryButton,
                (pressed || !brain.tracking) && styles.pressed,
              ]}>
              <ThemedText type="smallBold" style={styles.light}>
                {brain.pile ? 'Move pile here' : 'Pile here'}
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start autopilot"
              accessibilityHint={why || undefined}
              disabled={!ready}
              onPress={brain.startAutopilot}
              style={({ pressed }) => [styles.button, (pressed || !ready) && styles.pressed]}>
              <ThemedText type="smallBold" style={styles.dark}>
                Auto
              </ThemedText>
            </Pressable>
          </>
        )}
      </View>
      {!brain.autopilot.on && why !== '' && (
        <ThemedText type="small" style={styles.secondary}>
          Autopilot: {why.toLowerCase()}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    padding: Spacing.two + Spacing.half,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.6)',
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
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
  text: {
    flex: 1,
  },
  light: {
    color: '#fff',
  },
  dark: {
    color: '#000',
  },
  secondary: {
    color: 'rgba(255,255,255,0.7)',
  },
  button: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  stop: {
    backgroundColor: '#e5352b',
  },
  secondaryButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  pressed: {
    opacity: 0.5,
  },
});
