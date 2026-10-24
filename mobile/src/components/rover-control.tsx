import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { State } from 'react-native-ble-plx';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
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

const SPEEDS = [40, 70, 100];

/**
 * The rover's remote, for the camera's Remote tray: the connection (finding the rover, connecting,
 * its telemetry), the speeds like the Camera app's zoom levels, and the joystick under them.
 */
export function RoverRemote() {
  const rover = useRover();
  const [maxSpeed, setMaxSpeed] = useState(SPEEDS[0]);
  const { connection } = rover;

  // Look for rovers while the remote is shown and nothing is connected, and stop driving on leaving it.
  const idle = rover.bluetooth === State.PoweredOn && connection.state === 'disconnected';
  useEffect(() => {
    enableBluetooth();
    if (idle) startScan();
    return () => {
      stopScan();
      stop();
    };
  }, [idle]);

  return (
    <View style={styles.container}>
      <View style={styles.connection}>
        <ConnectionStatus rover={rover} />
      </View>

      <View accessibilityRole="radiogroup" accessibilityLabel="Top speed" style={styles.speeds}>
        {SPEEDS.map((speed) => {
          const active = speed === maxSpeed;
          return (
            <Pressable
              key={speed}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${speed}% speed`}
              onPress={() => setMaxSpeed(speed)}
              style={[styles.speed, active && styles.speedActive]}>
              <Text style={[styles.speedLabel, active && styles.speedLabelActive]}>
                {active ? `${speed}%` : speed}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Joystick
        disabled={connection.state !== 'connected'}
        onMove={(throttle, turn) => {
          const { left, right } = mix(throttle, turn, maxSpeed);
          drive(left, right);
        }}
        onRelease={stop}
      />
    </View>
  );
}

function ConnectionStatus({ rover }: { rover: RoverSnapshot }) {
  const { connection } = rover;

  if (connection.state === 'connected') {
    const { telemetry } = connection;
    return (
      <>
        <View style={styles.header}>
          <View style={styles.busy}>
            <View style={styles.dot} />
            <ThemedText type="smallBold" style={styles.light} numberOfLines={1}>
              {connection.rover.name}
            </ThemedText>
          </View>
          <Button label="Disconnect" secondary onPress={disconnect} />
        </View>
        <ThemedText type="small" style={[styles.secondary, styles.stats]}>
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
          <ActivityIndicator color="#fff" />
          <ThemedText type="small" style={styles.light} numberOfLines={1}>
            Connecting to {connection.rover.name}…
          </ThemedText>
        </View>
        <Button label="Cancel" secondary onPress={disconnect} />
      </View>
    );
  }

  if (rover.bluetooth !== State.PoweredOn) {
    return (
      <View style={styles.header}>
        <ThemedText type="small" style={[styles.secondary, styles.shrink]}>
          {describeBluetooth(rover.bluetooth)}
        </ThemedText>
        {rover.bluetooth === State.Unauthorized && (
          <Button label="Open Settings" onPress={() => Linking.openSettings()} />
        )}
      </View>
    );
  }

  return (
    <>
      <View style={styles.busy}>
        {rover.scanning && <ActivityIndicator color="#fff" />}
        <ThemedText type="smallBold" style={styles.light}>
          {rover.scanning ? 'Looking for rovers…' : 'Not scanning'}
        </ThemedText>
      </View>
      {rover.error && (
        <ThemedText type="small" style={styles.warning}>
          {rover.error}
        </ThemedText>
      )}
      {rover.found.length === 0 ? (
        <ThemedText type="small" style={styles.secondary}>
          Power the ESP32 and keep it nearby. Its blue LED blinks while it waits for the phone.
        </ThemedText>
      ) : (
        rover.found.map((found) => (
          <Pressable
            key={found.id}
            accessibilityRole="button"
            accessibilityLabel={`Connect to ${found.name}`}
            onPress={() => connect(found)}
            style={({ pressed }) => [styles.found, pressed && styles.pressed]}>
            <ThemedText type="smallBold" style={styles.light}>
              {found.name}
            </ThemedText>
            <ThemedText type="small" style={styles.secondary}>
              {found.rssi != null ? `${found.rssi} dBm · ` : ''}Connect
            </ThemedText>
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

const PAD_SIZE = 160;
const KNOB_SIZE = 64;
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
      accessibilityLabel={disabled ? 'Drive joystick, connect to a rover first' : 'Drive joystick'}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={grant}
      onResponderMove={move}
      onResponderRelease={release}
      onResponderTerminate={release}
      style={[styles.pad, disabled && styles.disabled]}>
      <View
        style={[styles.knob, { transform: [{ translateX: knob.x * TRAVEL }, { translateY: knob.y * TRAVEL }] }]}
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
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, pressed && styles.pressed]}>
      <ThemedText type="smallBold" style={secondary ? styles.light : styles.buttonLabel}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.three,
  },
  connection: {
    gap: Spacing.two,
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
  shrink: {
    flexShrink: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#30D158',
  },
  light: {
    color: '#fff',
  },
  secondary: {
    color: 'rgba(255,255,255,0.7)',
  },
  stats: {
    fontVariant: ['tabular-nums'],
  },
  warning: {
    color: '#FFD60A',
  },
  found: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.three,
    borderRadius: Spacing.three,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  speeds: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: Spacing.one,
    padding: Spacing.one,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  speed: {
    minWidth: 36,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: Spacing.one,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedActive: {
    minWidth: 48,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  speedLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    fontVariant: ['tabular-nums'],
  },
  speedLabelActive: {
    color: '#FFD60A',
  },
  /** Dark on the tray's glass, like the Camera app's tray buttons. */
  pad: {
    width: PAD_SIZE,
    height: PAD_SIZE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: PAD_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  knob: {
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: '#fff',
    // Touches go to the pad, so locationX/Y at the start are relative to it.
    pointerEvents: 'none',
  },
  disabled: {
    opacity: 0.4,
  },
  button: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one + Spacing.half,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  buttonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  buttonLabel: {
    color: '#000',
  },
  pressed: {
    opacity: 0.6,
  },
});
