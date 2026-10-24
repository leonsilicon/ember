import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app';
import type { ServerConfig } from '../src/config';
import type { DepthEstimator } from '../src/live/depth-worker';
import { anchorsInView, depthFromDisparity, fitDisparity, type Intrinsics } from '../src/live/geometry';
import type { SocketData } from '../src/live/hub';
import { encodeIngest, parseIngest, ProtocolError, type KeyframeHeader } from '../src/live/protocol';
import { depthEdges, VoxelCloud } from '../src/live/voxels';

const W = 64;
const H = 48;
const K: Intrinsics = { fx: 60, fy: 60, cx: W / 2, cy: H / 2, width: W, height: H };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A slanted wall in front of the camera: depth grows from 1.5 m on the left to 2.5 m on the right. */
const wallDepth = (u: number) => 1.5 + u / W;

/** What a depth model would say about the wall: inverse depth with an unknown scale and shift. */
function wallDisparity(scale = 2, shift = 0.1) {
  const out = new Float32Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) out[v * W + u] = (1 / wallDepth(u + 0.5) - shift) / scale;
  return out;
}

/** World points on the wall (camera at the origin looking down −z), flat x, y, z. */
function wallPoints(step = 6) {
  const points: number[] = [];
  for (let v = 2; v < H; v += step) {
    for (let u = 1; u < W; u += step) {
      const z = wallDepth(u + 0.5);
      points.push(((u + 0.5 - K.cx) / K.fx) * z, (-(v + 0.5 - K.cy) / K.fy) * z, -z);
    }
  }
  return points;
}

describe('fitDisparity', () => {
  test('recovers metric depth from anchors, ignoring wrong ones', () => {
    const disparity = wallDisparity();
    const anchors = anchorsInView(wallPoints(), IDENTITY, K);
    // A quarter of the anchors are badly wrong, like fresh ARKit points that aren't triangulated yet.
    anchors.forEach((a, i) => {
      if (i % 4 === 0) a.depth *= 0.4;
    });
    const fit = fitDisparity(disparity, W, H, anchors)!;
    expect(fit).not.toBeNull();
    expect(fit.scale).toBeCloseTo(2, 3);
    expect(fit.shift).toBeCloseTo(0.1, 3);
    expect(fit.inliers).toBe(anchors.length - Math.ceil(anchors.length / 4));
    const depth = depthFromDisparity(disparity, fit, 10);
    expect(depth[10 * W + 40]).toBeCloseTo(wallDepth(40.5), 3);
  });

  test('gives up when the anchors are too few or agree on nothing', () => {
    const disparity = wallDisparity();
    expect(fitDisparity(disparity, W, H, anchorsInView(wallPoints(30), IDENTITY, K))).toBeNull();
    const noise = anchorsInView(wallPoints(), IDENTITY, K).map((a, i) => ({ ...a, depth: 0.3 + ((i * 7919) % 97) / 20 }));
    expect(fitDisparity(disparity, W, H, noise)).toBeNull();
  });
});

describe('VoxelCloud', () => {
  test('unprojects depth into the world and merges repeat views of a surface', () => {
    const cloud = new VoxelCloud(0.05);
    const depth = new Float32Array(W * H).fill(2);
    const rgb = new Uint8Array(W * H * 3).fill(200);
    // Camera moved 1 m along +x, still looking down −z.
    const pose = [...IDENTITY];
    pose[12] = 1;
    const first = cloud.integrate(depth, rgb, W, H, K, pose);
    expect(first.length).toBe(cloud.count);
    for (let i = 0; i < cloud.count; i++) expect(cloud.positions[i * 3 + 2]).toBeCloseTo(-2, 1);
    const xs = Array.from({ length: cloud.count }, (_, i) => cloud.positions[i * 3]);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(2);

    const again = cloud.integrate(depth, rgb, W, H, K, pose);
    expect(again.length).toBe(first.length);
    expect(Math.max(...cloud.views.subarray(0, cloud.count))).toBe(2);
    const anchors = cloud.anchorsInView(pose, K, { minViews: 2, maxDepth: 4, cells: 8 });
    expect(anchors.length).toBeGreaterThan(20);
    for (const a of anchors) expect(a.depth).toBeCloseTo(2, 1);
  });

  test('drops depth edges and holes', () => {
    const depth = new Float32Array(W * H).fill(1);
    for (let v = 0; v < H; v++) for (let u = W / 2; u < W; u++) depth[v * W + u] = 3;
    depth[10 * W + 10] = NaN;
    const edges = depthEdges(depth, W, H, 0.06);
    expect(edges[20 * W + W / 2 - 1]).toBe(1);
    expect(edges[20 * W + W / 2]).toBe(1);
    expect(edges[20 * W + 5]).toBe(0);
    expect(edges[11 * W + 11]).toBe(1);
  });

  test('exports a PLY', () => {
    const cloud = new VoxelCloud(0.05);
    cloud.integrate(new Float32Array(W * H).fill(2), new Uint8Array(W * H * 3).fill(9), W, H, K, IDENTITY);
    const ply = cloud.toPly();
    const header = new TextDecoder().decode(ply.subarray(0, 300));
    expect(header).toContain(`element vertex ${cloud.count}\n`);
    expect(ply.byteLength).toBe(header.indexOf('end_header\n') + 'end_header\n'.length + cloud.count * 15);
  });
});

describe('protocol', () => {
  test('round-trips a keyframe and rejects malformed ones', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const header: KeyframeHeader = { type: 'keyframe', seq: 1, t: 0, pose: IDENTITY, intrinsics: K, anchors: [0, 0, -1], jpegBytes: 5 };
    const parsed = parseIngest(encodeIngest(header, jpeg));
    expect(parsed.header).toEqual(header);
    expect([...parsed.payload]).toEqual([...jpeg]);
    expect(() => parseIngest(encodeIngest({ ...header, jpegBytes: 9 }, jpeg))).toThrow(ProtocolError);
    expect(() => parseIngest(encodeIngest({ ...header, pose: [1, 2] }, jpeg))).toThrow(ProtocolError);
    expect(() => parseIngest(encodeIngest({ type: 'hello', session: '../x', mode: 'features' }))).toThrow(ProtocolError);
  });
});

/** Stands in for the Core ML worker: the slanted wall, whatever the image. */
class FakeEstimator implements DepthEstimator {
  alive = true;
  calls = 0;
  async estimate(_jpeg: Uint8Array, width: number, height: number, wantDepth: boolean) {
    this.calls++;
    expect([width, height]).toEqual([W, H]);
    return { width, height, rgb: new Uint8Array(width * height * 3).fill(128), disparity: wantDepth ? wallDisparity() : null };
  }
  close() {}
}

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('live hub', () => {
  async function startServer() {
    root = await mkdtemp(path.join(tmpdir(), 'live-server-'));
    const config: ServerConfig = {
      port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), brushBin: null, steps: 300, exportEvery: 100,
      maxResolution: 960, shDegree: 1, growthFraction: 0.5, maxSplats: 600_000, depthWorkerBin: null, depthModel: null,
      modelsDir: path.join(root, 'models'), live: { voxelSize: 0.05, maxDepth: 4, gridWidth: W, gridHeight: H },
    };
    const estimator = new FakeEstimator();
    const app = await createApp(config, { startEstimator: async () => estimator });
    const server = Bun.serve<SocketData>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, server) {
        if (app.live.upgrade(request, server)) return;
        return app.fetch(request);
      },
      websocket: app.live.websocket,
    });
    return { app, server, estimator, base: `127.0.0.1:${server.port}` };
  }

  function open(url: string) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const messages: (string | ArrayBuffer)[] = [];
    ws.onmessage = (event) => messages.push(event.data);
    return new Promise<{ ws: WebSocket; messages: typeof messages }>((resolve, reject) => {
      ws.onopen = () => resolve({ ws, messages });
      ws.onerror = reject;
    });
  }

  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
  };

  /** Points messages decoded into { index → z }. */
  function pointDepths(messages: (string | ArrayBuffer)[]) {
    const z = new Map<number, number>();
    for (const m of messages) {
      if (typeof m === 'string' || new Uint32Array(m, 0, 1)[0] !== 1) continue;
      const n = new Uint32Array(m, 4, 1)[0];
      const index = new Uint32Array(m, 8, n);
      const xyz = new Float32Array(m, 8 + n * 4, n * 3);
      index.forEach((i, j) => z.set(i, xyz[j * 3 + 2]));
    }
    return z;
  }

  test('fuses a phone keyframe and streams it to viewers, including late ones', async () => {
    const { app, server, estimator, base } = await startServer();
    try {
      const viewer = await open(`ws://${base}/live/socket`);
      const phone = await open(`ws://${base}/live/ingest`);
      phone.ws.send(encodeIngest({ type: 'hello', session: 'capture-test', mode: 'features', device: 'iPhone14,4' }));
      await waitFor(() => viewer.messages.some((m) => typeof m === 'string' && m.includes('"id":"capture-test"')));

      phone.ws.send(encodeIngest({ type: 'pose', t: 0, pose: IDENTITY }));
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
      const keyframe: KeyframeHeader = { type: 'keyframe', seq: 1, t: 0, pose: IDENTITY, intrinsics: K, anchors: wallPoints(), jpegBytes: 3 };
      phone.ws.send(encodeIngest(keyframe, jpeg));
      await app.live.idle();
      await waitFor(() => pointDepths(viewer.messages).size > 0);

      expect(estimator.calls).toBe(1);
      const depths = pointDepths(viewer.messages);
      expect(depths.size).toBe(app.live.cloud('capture-test')!.count);
      // The wall spans 1.5–2.5 m in front of the camera (−z).
      for (const z of depths.values()) {
        expect(z).toBeLessThan(-1.4);
        expect(z).toBeGreaterThan(-2.6);
      }
      expect(viewer.messages.some((m) => typeof m === 'string' && m.includes('"type":"pose"'))).toBe(true);
      expect(viewer.messages.some((m) => typeof m !== 'string' && new Uint32Array(m, 0, 1)[0] === 2)).toBe(true);
      await waitFor(() => phone.messages.some((m) => typeof m === 'string' && m.includes('"fused":1')));

      const late = await open(`ws://${base}/live/socket?session=capture-test`);
      await waitFor(() => pointDepths(late.messages).size === depths.size);

      const sessions = (await (await app.fetch(new Request('http://x/api/live'))).json()) as { sessions: { id: string; fused: number }[] };
      expect(sessions.sessions).toMatchObject([{ id: 'capture-test', fused: 1 }]);
      const ply = await app.fetch(new Request('http://x/api/live/capture-test/points.ply'));
      expect(ply.status).toBe(200);

      // Without anchors the keyframe can't be scaled, so it's skipped with a reason.
      phone.ws.send(encodeIngest({ ...keyframe, seq: 2, anchors: [] }, jpeg));
      await app.live.idle();
      await waitFor(() => phone.messages.some((m) => typeof m === 'string' && m.includes('feature points in view')));
      for (const socket of [viewer, phone, late]) socket.ws.close();
    } finally {
      app.live.close();
      server.stop(true);
    }
  });

  test('tells the phone about a malformed message and keeps going', async () => {
    const { app, server, base } = await startServer();
    try {
      const phone = await open(`ws://${base}/live/ingest`);
      phone.ws.send(encodeIngest({ type: 'pose', t: 0, pose: IDENTITY }));
      phone.ws.send(new Uint8Array([1, 2]));
      await waitFor(() => phone.messages.filter((m) => typeof m === 'string' && m.includes('"type":"error"')).length === 2);
      expect(String(phone.messages[0])).toContain('send hello first');
      phone.ws.close();
    } finally {
      app.live.close();
      server.stop(true);
    }
  });
});
