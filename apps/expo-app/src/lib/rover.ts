import { useSyncExternalStore } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State, type Subscription } from 'react-native-ble-plx';

// The rover's ESP32 runs firmware/rover/rover.ino; these must match it.
export const ROVER_SERVICE_UUID = 'b6960001-fcac-4307-b328-64175bf8c076';
const DRIVE_UUID = 'b6960002-fcac-4307-b328-64175bf8c076';
const TELEMETRY_UUID = 'b6960003-fcac-4307-b328-64175bf8c076';

/** How often a non-zero drive command is resent. The firmware stops after 500 ms of silence. */
const DRIVE_INTERVAL_MS = 50;

export type FoundRover = { id: string; name: string; rssi: number | null };

export type RoverTelemetry = {
  /** Wheel speeds the firmware is applying, -100..100. */
  left: number;
  right: number;
  /** The firmware stopped the motors because drive commands stopped arriving. */
  watchdogStopped: boolean;
  batteryMillivolts: number | null;
  /** Time since the ESP32 booted; a jump back to zero means it reset (often a brownout). */
  uptimeMs: number;
};

export type RoverConnection =
  | { state: 'disconnected' }
  | { state: 'connecting'; rover: FoundRover }
  | { state: 'connected'; rover: FoundRover; telemetry: RoverTelemetry | null };

export type RoverSnapshot = {
  bluetooth: State;
  scanning: boolean;
  found: FoundRover[];
  connection: RoverConnection;
  error: string | null;
};

let snapshot: RoverSnapshot = {
  bluetooth: State.Unknown,
  scanning: false,
  found: [],
  connection: { state: 'disconnected' },
  error: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<RoverSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

let manager: BleManager | null = null;

// Created on first use rather than at import or mount (tabs mount at launch), since creating it
// is what shows iOS's Bluetooth permission prompt.
function ble() {
  if (!manager) {
    manager = new BleManager();
    manager.onStateChange((bluetooth) => update({ bluetooth }), true);
    // Never leave the rover driving while the app can't be seen.
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') stop();
    });
  }
  return manager;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRover() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Starts Bluetooth (asking for permission the first time) and begins reporting its state. */
export function enableBluetooth() {
  ble();
}

async function requestAndroidPermissions() {
  if (Platform.OS !== 'android') return true;
  const permissions =
    Number(Platform.Version) >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every((p) => results[p] === PermissionsAndroid.RESULTS.GRANTED);
}

export async function startScan() {
  if (snapshot.scanning) return;
  if (!(await requestAndroidPermissions())) {
    update({ error: 'Bluetooth permission was denied.' });
    return;
  }
  update({ scanning: true, found: [], error: null });
  // Duplicates are allowed because the rover's name is in its scan response, which can arrive
  // after the first report of it.
  ble()
    .startDeviceScan([ROVER_SERVICE_UUID], { allowDuplicates: true }, (error, device) => {
      if (error) {
        update({ scanning: false, error: error.message });
        return;
      }
      if (!device) return;
      const rover = { id: device.id, name: device.localName ?? device.name ?? 'Rover', rssi: device.rssi };
      const known = snapshot.found.find((r) => r.id === rover.id);
      if (!known) {
        update({ found: [...snapshot.found, rover] });
      } else if (known.name !== rover.name || Math.abs((known.rssi ?? 0) - (rover.rssi ?? 0)) >= 5) {
        update({ found: snapshot.found.map((r) => (r.id === rover.id ? rover : r)) });
      }
    })
    .catch((error) => update({ scanning: false, error: message(error) }));
}

export function stopScan() {
  if (!snapshot.scanning) return;
  manager?.stopDeviceScan().catch(() => {});
  update({ scanning: false });
}

let subscriptions: Subscription[] = [];
let target = { left: 0, right: 0 };
let driveTimer: ReturnType<typeof setInterval> | null = null;

function isConnecting(rover: FoundRover) {
  return snapshot.connection.state === 'connecting' && snapshot.connection.rover.id === rover.id;
}

export async function connect(rover: FoundRover) {
  stopScan();
  update({ connection: { state: 'connecting', rover }, error: null });
  try {
    await ble().connectToDevice(rover.id, { timeout: 10_000 });
    await ble().discoverAllServicesAndCharacteristicsForDevice(rover.id);
  } catch (error) {
    // disconnect() during the attempt already reset the state.
    if (!isConnecting(rover)) return;
    ble().cancelDeviceConnection(rover.id).catch(() => {});
    update({ connection: { state: 'disconnected' }, error: `Couldn't connect to ${rover.name}: ${message(error)}` });
    return;
  }
  if (!isConnecting(rover)) return;

  subscriptions = [
    ble().onDeviceDisconnected(rover.id, () => {
      resetLink();
      update({ connection: { state: 'disconnected' }, error: `Lost connection to ${rover.name}.` });
    }),
    ble().monitorCharacteristicForDevice(rover.id, ROVER_SERVICE_UUID, TELEMETRY_UUID, (error, characteristic) => {
      // Errors here come from the link dropping, which onDeviceDisconnected reports.
      const telemetry = !error && characteristic?.value ? decodeTelemetry(characteristic.value) : null;
      if (telemetry && snapshot.connection.state === 'connected') {
        update({ connection: { ...snapshot.connection, telemetry } });
      }
    }),
  ];
  update({ connection: { state: 'connected', rover, telemetry: null } });
}

export function disconnect() {
  const { connection } = snapshot;
  if (connection.state === 'disconnected') return;
  // The firmware stops the motors itself when the link closes.
  resetLink();
  update({ connection: { state: 'disconnected' } });
  manager?.cancelDeviceConnection(connection.rover.id).catch(() => {});
}

function resetLink() {
  subscriptions.forEach((s) => s.remove());
  subscriptions = [];
  if (driveTimer != null) clearInterval(driveTimer);
  driveTimer = null;
  target = { left: 0, right: 0 };
}

function toSpeed(value: number) {
  return Math.round(Math.max(-100, Math.min(100, value)));
}

function sendDrive(withResponse: boolean) {
  const { connection } = snapshot;
  if (!manager || connection.state !== 'connected') return;
  const value = btoa(String.fromCharCode(target.left & 0xff, target.right & 0xff));
  const write = withResponse
    ? manager.writeCharacteristicWithResponseForDevice(connection.rover.id, ROVER_SERVICE_UUID, DRIVE_UUID, value)
    : manager.writeCharacteristicWithoutResponseForDevice(connection.rover.id, ROVER_SERVICE_UUID, DRIVE_UUID, value);
  write.catch(() => {});
}

/**
 * Sets the wheel speeds (-100..100, + is forward). Non-zero speeds are resent until changed,
 * which keeps the firmware's watchdog fed.
 */
export function drive(left: number, right: number) {
  target = { left: toSpeed(left), right: toSpeed(right) };
  if (target.left === 0 && target.right === 0) {
    if (driveTimer != null) stop();
  } else if (driveTimer == null) {
    sendDrive(false);
    driveTimer = setInterval(() => sendDrive(false), DRIVE_INTERVAL_MS);
  }
}

/** Stops both motors, with an acknowledged write so the stop can't be dropped. */
export function stop() {
  if (driveTimer != null) clearInterval(driveTimer);
  driveTimer = null;
  target = { left: 0, right: 0 };
  sendDrive(true);
}

/** Mixes throttle and turn (each -1..1, + is forward / right) into wheel speeds up to maxSpeed. */
export function mix(throttle: number, turn: number, maxSpeed = 100) {
  const left = throttle + turn;
  const right = throttle - turn;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return { left: (left / scale) * maxSpeed, right: (right / scale) * maxSpeed };
}

function decodeTelemetry(base64: string): RoverTelemetry | null {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer);
  return {
    left: view.getInt8(0),
    right: view.getInt8(1),
    watchdogStopped: (view.getUint8(2) & 1) !== 0,
    batteryMillivolts: view.getUint16(4, true) || null,
    uptimeMs: view.getUint32(6, true),
  };
}
