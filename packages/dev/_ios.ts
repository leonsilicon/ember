#!/usr/bin/env bun
/**
 * `vpx _ios` (from anywhere in the repo): build the mobile development build, install it on the
 * iPhone and open it on `vpx _dev`'s Metro. The phone comes first because the camera screen needs ARKit,
 * which the simulator lacks. Expo's `i` key in the Metro pane only ever opens a simulator, so this is the
 * phone's `i`.
 *
 *   vpx _ios                         the cabled iPhone
 *   vpx _ios production              a Release build instead: its JS is embedded, without the dev client or Metro
 *   vpx _ios --device <udid|name>    one paired iPhone, also over Wi-Fi (`--device minisilicon` on the rover)
 *   vpx _ios --simulator             the simulator `i` opens (the first booted one), for UI work without ARKit
 *   vpx _ios --port <n>              Metro on another port than `vpx _dev`'s
 *
 * Like Haniverse's `_ios`: `expo prebuild --no-clean` syncs the gitignored `ios/` with the app config (and
 * runs pod install when it has to), `expo run:ios --no-bundler` builds, installs and launches the app, and
 * the dev client is then opened on Metro: on a phone through devicectl, over the cable's "iPhone USB" link when
 * the phone shares its hotspot, else at this Mac's LAN address, which the phone must share.
 *
 * The variant, like Haniverse's, is `development` (the default) or `production`. It is EXPO_PUBLIC_APP_VARIANT for
 * the Expo commands, so it picks the app's identity in mobile/app.config.ts: the development build is
 * `com.leonsilicon.soon2026.development`, and the two install side by side. `production` also builds the Release
 * configuration, which autolinking leaves expo-dev-launcher and expo-dev-menu (`debugOnly`) out of. Every other
 * argument goes to `expo run:ios`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';

import { APP_VARIANTS, type AppVariant, isAppVariant } from 'soon2026/app.config';

import { APP_DIR, DEFAULT_METRO_PORT, listenerPid, run, stimMetroPort } from './lib';

/** A progress line, on stderr like Expo's own. Not `console.error`, which Bun paints red on a terminal. */
function log(message: string) {
  process.stderr.write(`_ios: ${message}\n`);
}

function fail(message: string): never {
  console.error(`_ios: ${message}`);
  process.exit(1);
}

/** The value of `--name <value>` or `--name=<value>` in an argument list. */
function optionValue(args: string[], name: string) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
}

type DevicectlDevice = {
  hardwareProperties?: { udid?: string; platform?: string; reality?: string };
  deviceProperties?: { name?: string };
  connectionProperties?: { transportType?: string; tunnelState?: string };
};
type Phone = { udid: string; name: string; wired: boolean };

/** iPhones paired with this Mac, as `xcrun devicectl list devices` reports them. */
function pairedPhones(): Phone[] {
  // devicectl writes its JSON to a file.
  const file = path.join(tmpdir(), `_ios-devices-${process.pid}.json`);
  try {
    const listed = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', file], { stdio: 'ignore' });
    if (listed.status !== 0) fail('`xcrun devicectl list devices` failed');
    const devices: DevicectlDevice[] = JSON.parse(readFileSync(file, 'utf8')).result?.devices ?? [];
    return devices.flatMap(({ hardwareProperties: hardware, deviceProperties, connectionProperties: connection }) =>
      hardware?.reality === 'physical' && hardware.platform === 'iOS' && hardware.udid
        ? [
            {
              udid: hardware.udid,
              name: deviceProperties?.name ?? hardware.udid,
              wired: connection?.transportType === 'wired' && connection.tunnelState !== 'unavailable',
            },
          ]
        : [],
    );
  } finally {
    rmSync(file, { force: true });
  }
}

/** The phone to build for: the named one, else the cabled one. Wi-Fi phones are only taken by name. */
function targetPhone(device: string | null) {
  const phones = pairedPhones();
  const listed = phones.map(({ name, udid }) => `${name} (${udid})`).join(', ') || 'none';
  if (device) {
    const lower = device.toLowerCase();
    return (
      phones.find(({ udid, name }) => udid.toLowerCase() === lower || name.toLowerCase() === lower) ??
      fail(`no paired iPhone has the name or UDID "${device}". Paired: ${listed}`)
    );
  }
  return (
    phones.find((phone) => phone.wired) ??
    fail(
      `no iPhone is plugged in. Plug it in, pass --device <name> for one on Wi-Fi (paired: ${listed}), ` +
        'or --simulator to build without ARKit.',
    )
  );
}

/** The first booted iOS simulator, in `simctl list` order: the one Expo's `i` and `expo run:ios` take. */
function firstBootedSimulator() {
  const listed = run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']) ?? fail('`xcrun simctl list devices` failed');
  const { devices }: { devices: Record<string, { udid: string; name: string }[]> } = JSON.parse(listed);
  return Object.entries(devices).flatMap(([runtime, simulators]) => (runtime.includes('SimRuntime.iOS-') ? simulators : []))[0];
}

/** The Mac's "iPhone USB" interfaces: a cabled iPhone sharing its Personal Hotspot over the cable. */
function iphoneUsbInterfaces() {
  const ports = run('networksetup', ['-listallhardwareports']) ?? '';
  return [...ports.matchAll(/Hardware Port: iPhone USB\nDevice: (\S+)/g)].map(([, device]) => device);
}

/**
 * The address a phone reaches Metro at. A cabled phone sharing its hotspot reaches the Mac over the cable even
 * when it is not on the Mac's Wi-Fi; otherwise this Mac's LAN address, en0 first, as Expo advertises Metro.
 */
function metroHost(phone: Phone) {
  const interfaces = networkInterfaces();
  const names = [
    ...(phone.wired ? iphoneUsbInterfaces() : []),
    'en0',
    ...Object.keys(interfaces).filter((name) => name.startsWith('en')),
  ];
  for (const name of names) {
    const address = interfaces[name]?.find(
      ({ family, internal, address }) => family === 'IPv4' && !internal && !address.startsWith('169.254.'),
    );
    if (address) return address.address;
  }
  return null;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: vpx _ios [development | production] [--device <udid|name> | --simulator] [--port <metro port>] [expo run:ios args…]\n' +
      'Builds the development build onto the cabled iPhone and opens it on the `vpx _dev` Metro.\n' +
      '`production` builds the production app (Release) instead, which embeds its JS and has no dev client.',
  );
  process.exit(0);
}

let variant: AppVariant | null = null;
let device: string | null = null;
let simulator = false;
let metroPort: number | null = null;
const expoArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  // Only among this script's own arguments: after the first `expo run:ios` one, a bare word is Expo's.
  if (variant === null && expoArgs.length === 0 && isAppVariant(arg)) variant = arg;
  else if (arg === '--simulator') simulator = true;
  else if (arg === '--device') device = args[++i] ?? '';
  else if (arg.startsWith('--device=')) device = arg.slice('--device='.length);
  else if (arg === '--port') metroPort = Number(args[++i]);
  else if (arg.startsWith('--port=')) metroPort = Number(arg.slice('--port='.length));
  else expoArgs.push(arg);
}
if (device !== null && (!device || device.startsWith('-'))) fail('--device needs an iPhone UDID or name');
if (device !== null && simulator) fail('--device picks a phone; it cannot be combined with --simulator');
if (variant === 'production' && optionValue(expoArgs, '--configuration') !== null) {
  fail('production builds the Release configuration; it cannot be combined with --configuration');
}
variant ??= 'development';
const { bundleIdentifier, scheme } = APP_VARIANTS[variant];
// Read by app.config.ts in the Expo commands below, and by the Xcode build phases that run Expo.
process.env.EXPO_PUBLIC_APP_VARIANT = variant;
const configurationArgs = variant === 'production' ? ['--configuration', 'Release'] : [];
const configuration = optionValue([...configurationArgs, ...expoArgs], '--configuration') ?? 'Debug';
metroPort ??= stimMetroPort() ?? DEFAULT_METRO_PORT;
if (!Number.isInteger(metroPort) || metroPort < 1 || metroPort > 65_535) {
  fail('--port needs a port number, e.g. --port 8082');
}

// With no simulator booted, `expo run:ios` boots the one `i` would, and it is the first booted afterwards.
const phone = simulator ? null : targetPhone(device);
const target = phone?.udid ?? firstBootedSimulator()?.udid;
log(
  `building ${bundleIdentifier} (${configuration}${configuration === 'Debug' ? '' : ', no dev client'}) for ` +
    `${phone ? `${phone.name}${phone.wired ? '' : ' over Wi-Fi'}` : 'the simulator `i` opens'}`,
);

// The real binary rather than a version manager's PATH shim, as `vpx _dev` runs Expo.
const node = run('node', ['-p', 'process.execPath']) ?? fail('node is not on PATH');
const expoCli = path.join(path.dirname(createRequire(path.join(APP_DIR, 'package.json')).resolve('expo/package.json')), 'bin/cli');

function expo(expoCommandArgs: string[]) {
  log(`expo ${expoCommandArgs.join(' ')}`);
  const { status } = spawnSync(node, [expoCli, ...expoCommandArgs], { cwd: APP_DIR, stdio: 'inherit' });
  if (status !== 0) fail(`expo ${expoCommandArgs[0]} failed${status === null ? '' : ` (exit ${status})`}`);
}

// Prebuild deletes and regenerates `ios/` (Pods included) unless told `--no-clean`.
expo(['prebuild', '--platform', 'ios', '--no-clean']);
expo(['run:ios', '--no-bundler', ...configurationArgs, ...(target ? ['--device', target] : []), ...expoArgs]);

// A Release build embeds its JS and has no dev client; `expo run:ios` has already launched it.
if (configuration !== 'Debug') {
  log(`installed and launched the ${configuration} build on ${phone?.name ?? 'the simulator'}; it needs no Metro.`);
  process.exit(0);
}
if (!listenerPid(metroPort)) {
  log(`installed. Nothing listens on Metro's port ${metroPort}: run \`vpx _dev\`, then rerun \`vpx _ios\` or open the app.`);
  process.exit(0);
}

// The variant's own scheme, so iOS opens the app just built rather than another variant's dev client.
const devClientUrl = (host: string) =>
  `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://${host}:${metroPort}`)}`;

if (phone) {
  // `expo run:ios` launched the app without a Metro URL; relaunch it with one, as `i` does on a simulator.
  const host = metroHost(phone) ?? fail('this Mac has no network address for the phone to reach Metro on');
  const launched = spawnSync(
    'xcrun',
    ['devicectl', 'device', 'process', 'launch', '--device', phone.udid, '--terminate-existing', '--payload-url', devClientUrl(host), bundleIdentifier],
    { stdio: 'inherit' },
  );
  if (launched.status !== 0) fail(`could not open the dev client on ${phone.name}; is it unlocked?`);
  log(`opened the dev client on ${phone.name} (Metro ${host}:${metroPort}).`);
} else {
  const booted = firstBootedSimulator() ?? fail('no simulator is booted after `expo run:ios`');
  // The simulator's UDID rather than `booted`, which is ambiguous with several simulators booted.
  if (spawnSync('xcrun', ['simctl', 'openurl', booted.udid, devClientUrl('localhost')], { stdio: 'inherit' }).status !== 0) {
    fail(`could not open the dev client on ${booted.name}`);
  }
  log(`opened the dev client on ${booted.name} (Metro ${metroPort}); \`i\` in the Metro pane opens it there too.`);
}
