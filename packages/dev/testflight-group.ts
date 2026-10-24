#!/usr/bin/env bun
/**
 * `bun packages/dev/testflight-group.ts <build number>`: gives a build that `eas submit` uploaded to an external
 * TestFlight group, so testers outside the App Store Connect team (friends who joined through the group's public
 * link) get it too. `eas submit`'s `groups` only reach internal groups. The TestFlight workflow runs it after the
 * upload.
 *
 * It waits for App Store Connect to finish processing the build, sets its "What to Test", adds it to the group and
 * submits it for Beta App Review. Apple reviews the first build of each version, which can take a day; later builds
 * of the same version usually pass at once.
 *
 * Environment: ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8 (the .p8 file's contents) of an App Store
 * Connect API key with the App Manager role, TESTFLIGHT_GROUP (the group's name) and optionally WHAT_TO_TEST.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { APP_DIR } from './lib';

const API = 'https://api.appstoreconnect.apple.com';
/** How long App Store Connect gets to process an upload. It usually takes 5–20 minutes. */
const PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;

type Resource<Attributes> = { id: string; attributes: Attributes };
type Build = Resource<{ version: string; processingState: 'PROCESSING' | 'FAILED' | 'INVALID' | 'VALID' }>;
type BetaGroup = Resource<{ name: string; isInternalGroup: boolean; publicLinkEnabled: boolean | null; publicLink: string | null }>;

function log(message: string) {
  process.stderr.write(`testflight-group: ${message}\n`);
}

function fail(message: string): never {
  console.error(`testflight-group: ${message}`);
  process.exit(1);
}

function requiredEnv(name: string) {
  return process.env[name] || fail(`${name} is not set`);
}

const buildNumber = process.argv[2] || fail('usage: bun packages/dev/testflight-group.ts <build number>');
const groupName = requiredEnv('TESTFLIGHT_GROUP');
const keyId = requiredEnv('ASC_API_KEY_ID');
const issuerId = requiredEnv('ASC_API_ISSUER_ID');
const whatToTest = process.env.WHAT_TO_TEST?.trim().slice(0, 4000);
const appId: string =
  JSON.parse(readFileSync(path.join(APP_DIR, 'eas.json'), 'utf8')).submit?.production?.ios?.ascAppId ??
  fail('apps/soon2026/eas.json has no submit.production.ios.ascAppId');

const signingKey = await crypto.subtle.importKey(
  'pkcs8',
  Buffer.from(requiredEnv('ASC_API_KEY_P8').replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);

/** A fresh App Store Connect token (they last at most 20 minutes, and processing can take longer). */
async function token() {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' })}`;
  // WebCrypto's ECDSA signature is the raw r‖s pair that ES256 wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH', route: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json()) as { errors?: { title?: string; detail?: string }[] };
  if (!res.ok) {
    const errors = json.errors ?? [];
    fail(`${method} ${route} failed (${res.status}): ${errors.map((e) => e.detail ?? e.title).join('; ') || res.statusText}`);
  }
  return json as T;
}

/** The uploaded build, once App Store Connect has processed it. */
async function processedBuild(): Promise<Build> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  for (;;) {
    const { data } = await api<{ data: Build[] }>(
      'GET',
      `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&fields[builds]=version,processingState&limit=1`,
    );
    const state = data[0]?.attributes.processingState;
    if (state === 'VALID') return data[0];
    if (state === 'FAILED' || state === 'INVALID') fail(`App Store Connect could not process build ${buildNumber} (${state})`);
    if (Date.now() > deadline) fail(`build ${buildNumber} is still ${state ? 'processing' : 'missing'} after an hour`);
    log(`build ${buildNumber} is ${state ? 'processing' : 'not in App Store Connect yet'}; checking again in 30 s`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

const { data: groups } = await api<{ data: BetaGroup[] }>(
  'GET',
  `/v1/betaGroups?filter[app]=${appId}&filter[name]=${encodeURIComponent(groupName)}&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled,publicLink`,
);
const group = groups.find((g) => g.attributes.name === groupName) ?? fail(`app ${appId} has no TestFlight group named "${groupName}"`);
if (group.attributes.isInternalGroup) fail(`"${groupName}" is an internal group; eas submit's groups cover those`);

const build = await processedBuild();
log(`build ${buildNumber} is processed (${build.id})`);

if (whatToTest) {
  const { data: localizations } = await api<{ data: Resource<{ locale: string }>[] }>(
    'GET',
    `/v1/betaBuildLocalizations?filter[build]=${build.id}&filter[locale]=en-US`,
  );
  const attributes = { whatsNew: whatToTest };
  if (localizations[0]) {
    await api('PATCH', `/v1/betaBuildLocalizations/${localizations[0].id}`, {
      data: { type: 'betaBuildLocalizations', id: localizations[0].id, attributes },
    });
  } else {
    await api('POST', '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { ...attributes, locale: 'en-US' },
        relationships: { build: { data: { type: 'builds', id: build.id } } },
      },
    });
  }
}

await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
log(`added build ${buildNumber} to "${groupName}"`);

const { data: submissions } = await api<{ data: unknown[] }>('GET', `/v1/betaAppReviewSubmissions?filter[build]=${build.id}`);
if (submissions.length === 0) {
  await api('POST', '/v1/betaAppReviewSubmissions', {
    data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
  });
  log(`submitted build ${buildNumber} for Beta App Review`);
}

const link = group.attributes.publicLinkEnabled ? group.attributes.publicLink : null;
const summary = `Build ${buildNumber} is in the "${groupName}" TestFlight group${link ? `, which testers join at ${link}` : ''}. Apple reviews the first build of each version before external testers get it.`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
