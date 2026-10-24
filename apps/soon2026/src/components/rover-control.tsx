import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { State } from 'react-native-ble-plx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { BottomTabInset, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  connect,
  disconnect,
  drive,
  enableBluetooth,
  mix,
  startScan,
  stop,
  stopScan,
  useRover,
  type RoverSnapshot,
  type RoverTelemetry,
} from '@/lib/rover';

const SPEEDS = [
  { label: 'Slow', value: 40 },
  { label: 'Normal', value: 70 },
  { label: 'Fast', value: 100 },
];

export function RoverControl() {
  const insets = useSafeAreaInsets();
  const rover = useRover();
  const [maxSpeed, setMaxSpeed] = useState(SPEEDS[0].value);
  const { connection } = rover;

  // Look for rovers while this tab is open and nothing is connected, and stop driving on leaving it.
  const idle = rover.bluetooth === State.PoweredOn && connection.state === 'disconnected';
  useFocusEffect(
    useCallback(() => {
      enableBluetooth();
      if (idle) startScan();
      return () => {
        stopScan();
        stop();
      };
    }, [idle]),
  );

  return (
    <ThemedView
      style={[
        styles.container,
        {
          paddingTop: insets.top + Spacing.four,
          paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
        },
      ]}>
      <ThemedText type="subtitle">Rover</ThemedText>

      <ThemedView type="backgroundElement" style={styles.card}>
        <ConnectionStatus rover={rover} />
      </ThemedView>

      <View style={styles.controls}>
        <View style={styles.speeds}>
          {SPEEDS.map(({ label, value }) => (
            <Button
              key={value}
              label={`${label} ${value}%`}
              secondary={value !== maxSpeed}
              onPress={() => setMaxSpeed(value)}
            />
          ))}
        </View>
        <Joystick
          disabled={connection.state !== 'connected'}
          onMove={(throttle, turn) => {
            const { left, right } = mix(throttle, turn, maxSpeed);
            drive(left, right);
          }}
          onRelease={stop}
        />
        <ThemedText type="small" themeColor="textSecondary">
          {connection.state === 'connected' ? 'Drag to drive, let go to stop' : 'Connect to a rover to drive'}
        </ThemedText>
      </View>
    </ThemedView>
  );
}

function ConnectionStatus({ rover }: { rover: RoverSnapshot }) {
  const { connection } = rover;

  if (connection.state === 'connected') {
    const { telemetry } = connection;
    return (
      <>
        <View style={styles.header}>
          <ThemedText type="smallBold">{connection.rover.name}</ThemedText>
          <Button label="Disconnect" secondary onPress={disconnect} />
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.stats}>
          {telemetry ? describeTelemetry(telemetry) : 'Connected, waiting for telemetry…'}
        </ThemedText>
        {telemetry?.watchdogStopped && (
          <ThemedText type="small" style={styles.warning}>
            Drive commands stopped arriving, so the rover stopped itself.
          </ThemedText>
        )}
      </>
    );
  }

  if (connection.state === 'connecting') {
    return (
      <View style={styles.header}>
        <View style={styles.busy}>
          <ActivityIndicator />
          <ThemedText type="small">Connecting to {connection.rover.name}…</ThemedText>
        </View>
        <Button label="Cancel" secondary onPress={disconnect} />
      </View>
    );
  }

  if (rover.bluetooth !== State.PoweredOn) {
    return (
      <>
        <ThemedText type="small" themeColor="textSecondary">
          {describeBluetooth(rover.bluetooth)}
        </ThemedText>
        {rover.bluetooth === State.Unauthorized && (
          <Button label="Open Settings" onPress={() => Linking.openSettings()} />
        )}
      </>
    );
  }

  return (
    <>
      <View style={styles.busy}>
        {rover.scanning && <ActivityIndicator />}
        <ThemedText type="smallBold">{rover.scanning ? 'Looking for rovers…' : 'Not scanning'}</ThemedText>
      </View>
      {rover.error && (
        <ThemedText type="small" style={styles.warning}>
          {rover.error}
        </ThemedText>
      )}
      {rover.found.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          Power the ESP32 and keep it nearby. Its blue LED blinks while it waits for the phone.
        </ThemedText>
      ) : (
        rover.found.map((found) => (
          <Pressable
            key={found.id}
            accessibilityRole="button"
            accessibilityLabel={`Connect to ${found.name}`}
            onPress={() => connect(found)}
            style={({ pressed }) => pressed && styles.pressed}>
            <ThemedView type="backgroundSelected" style={styles.found}>
              <ThemedText type="smallBold">{found.name}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {found.rssi != null ? `${found.rssi} dBm · ` : ''}Connect
              </ThemedText>
            </ThemedView>
          </Pressable>
        ))
      )}
    </>
  );
}

function describeBluetooth(state: State) {
  switch (state) {
    case State.Unsupported:
      return 'This device has no Bluetooth LE. Run the app on a phone (the simulator has none).';
    case State.Unauthorized:
      return 'Bluetooth access is off. Allow it in Settings to find the rover.';
    case State.PoweredOff:
      return 'Turn Bluetooth on to find the rover.';
    default:
      return 'Starting Bluetooth…';
  }
}

function describeTelemetry(telemetry: RoverTelemetry) {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const s = Math.floor(telemetry.uptimeMs / 1000);
  const parts = [`L ${signed(telemetry.left)} · R ${signed(telemetry.right)}`];
  if (telemetry.batteryMillivolts) parts.push(`${(telemetry.batteryMillivolts / 1000).toFixed(2)} V`);
  parts.push(`up ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  return parts.join(' · ');
}

const PAD_SIZE = 220;
const KNOB_SIZE = 84;
const TRAVEL = (PAD_SIZE - KNOB_SIZE) / 2;
const DEADZONE = 0.1;

function Joystick({
  disabled,
  onMove,
  onRelease,
}: {
  disabled: boolean;
  /** throttle and turn are -1..1, + is forward / right. */
  onMove: (throttle: number, turn: number) => void;
  onRelease: () => void;
}) {
  const theme = useTheme();
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  // Where the touch began, in pad and page coordinates. Moves are tracked as page deltas from it,
  // since locationX/Y are relative to whatever view is under the finger.
  const origin = useRef({ x: 0, y: 0, pageX: 0, pageY: 0 });

  function moveTo(x: number, y: number) {
    const dx = x - PAD_SIZE / 2;
    const dy = y - PAD_SIZE / 2;
    const scale = Math.min(1, TRAVEL / Math.max(Math.hypot(dx, dy), 1)) / TRAVEL;
    const next = { x: dx * scale, y: dy * scale };
    setKnob(next);
    if (Math.hypot(next.x, next.y) < DEADZONE) onMove(0, 0);
    else onMove(-next.y, next.x);
  }

  function grant(event: GestureResponderEvent) {
    const { locationX, locationY, pageX, pageY } = event.nativeEvent;
    origin.current = { x: locationX, y: locationY, pageX, pageY };
    moveTo(locationX, locationY);
  }

  function move(event: GestureResponderEvent) {
    const { pageX, pageY } = event.nativeEvent;
    moveTo(origin.current.x + pageX - origin.current.pageX, origin.current.y + pageY - origin.current.pageY);
  }

  function release() {
    setKnob({ x: 0, y: 0 });
    onRelease();
  }

  return (
    <View
      accessibilityLabel="Drive joystick"
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={grant}
      onResponderMove={move}
      onResponderRelease={release}
      onResponderTerminate={release}
      style={[
        styles.pad,
        { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
        disabled && styles.disabled,
      ]}>
      <View
        style={[
          styles.knob,
          {
            backgroundColor: theme.text,
            transform: [{ translateX: knob.x * TRAVEL }, { translateY: knob.y * TRAVEL }],
          },
        ]}
      />
    </View>
  );
}

function Button({
  label,
  onPress,
  secondary,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: secondary ? theme.backgroundSelected : theme.text },
        pressed && styles.pressed,
      ]}>
      <ThemedText type="smallBold" style={{ color: secondary ? theme.text : theme.background }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.two,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  stats: {
    fontVariant: ['tabular-nums'],
  },
  warning: {
    color: '#d97706',
  },
  found: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  controls: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.three,
  },
  speeds: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  pad: {
    width: PAD_SIZE,
    height: PAD_SIZE,
    borderRadius: PAD_SIZE / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  knob: {
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    // Touches go to the pad, so locationX/Y at the start are relative to it.
    pointerEvents: 'none',
  },
  disabled: {
    opacity: 0.4,
  },
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
  pressed: {
    opacity: 0.6,
  },
});
