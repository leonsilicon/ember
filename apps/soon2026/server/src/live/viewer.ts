import { BASE_STYLE, THREE_VERSION } from '../pages';

/**
 * The live reconstruction in the browser: the point cloud growing as the phone streams, the
 * phone's camera (frustum, path and latest keyframe image), and a chase camera that follows it.
 * With no session id it follows whichever phone started streaming most recently.
 */
export function liveViewerPage(sessionId: string | null) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Live reconstruction</title>
<style>${BASE_STYLE}
  body { overflow: hidden; background: #0b0c0e; color: #e8e8e6; }
  canvas { display: block; touch-action: none; }
  .hud { position: fixed; left: 16px; right: 16px; pointer-events: none; font-size: 13px; text-shadow: 0 1px 2px #000; }
  #top { top: 14px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; }
  #top h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #top a { pointer-events: auto; color: #e8e8e6; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #666; margin-right: 6px; }
  .dot.on { background: #3ccf6e; box-shadow: 0 0 8px #3ccf6e; }
  #stats { color: #b9b9b4; font-variant-numeric: tabular-nums; }
  #skip { color: #f0b35a; }
  #bottom { bottom: 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button, .button { pointer-events: auto; font: inherit; color: #e8e8e6; background: rgba(40,42,46,0.85); border: 1px solid #3a3c40;
    border-radius: 999px; padding: 6px 12px; cursor: pointer; text-decoration: none; }
  button[aria-pressed="true"] { background: #2c5d8f; border-color: #3d7bbb; }
  label { pointer-events: auto; display: flex; gap: 6px; align-items: center; background: rgba(40,42,46,0.85);
    border: 1px solid #3a3c40; border-radius: 999px; padding: 4px 12px; }
  #empty { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; color: #9a9a94; pointer-events: none; padding: 16px; }
  #empty[hidden] { display: none; }
  #empty strong { color: #e8e8e6; font-size: 17px; display: block; margin-bottom: 6px; }
</style>
<script type="importmap">{"imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/"
}}</script></head>
<body>
<div id="top" class="hud">
  <h1>Live reconstruction</h1>
  <span><span id="phone-dot" class="dot"></span><span id="session">connecting…</span></span>
  <span id="stats"></span>
  <span id="skip"></span>
  <a href="/">Splat captures</a>
</div>
<div id="empty"><div><strong>Waiting for the phone</strong>In the app, turn on Live 3D, then start recording.<br>Points appear here as you move the phone around.</div></div>
<div id="bottom" class="hud">
  <button id="follow" aria-pressed="true" title="F">Follow phone</button>
  <button id="confidence" title="C">Show: all points</button>
  <label>Size <input id="size" type="range" min="0.4" max="3" step="0.1" value="1"></label>
  <a id="download" class="button" href="#" download>Download PLY</a>
</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const requested = ${JSON.stringify(sessionId)};
const $ = (id) => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x0b0c0e);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 200);
camera.position.set(1.5, 1.2, 1.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, -1);
const clock = new THREE.Clock();

// ---- Point cloud: one preallocated buffer; voxel i lives at slot i (the server never reorders).
const pointMaterial = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, size: { value: 0.02 }, scale: { value: 1 }, minViews: { value: 1 } },
  vertexShader: \`
    attribute vec4 rgbv;
    attribute float born;
    uniform float time, size, scale, minViews;
    varying vec3 vColor;
    varying float vFlash;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float age = max(time - born, 0.0);
      vFlash = exp(-age * 2.0);
      vColor = rgbv.rgb / 255.0;
      // New points grow in, flashing cyan, so you can watch the scene materialise.
      float grow = mix(0.25, 1.0, clamp(age / 0.35, 0.0, 1.0));
      gl_PointSize = rgbv.a < minViews ? 0.0 : max(size * scale / -mv.z * grow, 1.0);
    }\`,
  fragmentShader: \`
    varying vec3 vColor;
    varying float vFlash;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      if (dot(c, c) > 0.25) discard;
      gl_FragColor = vec4(mix(vColor, vec3(0.45, 0.9, 1.0), vFlash * 0.7) + vFlash * 0.1, 1.0);
    }\`,
});
let capacity = 0;
let count = 0;
let geometry = null;
let points = null;
let dirtyFrom = Infinity;
let dirtyTo = -1;
function allocate(size) {
  const next = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(size * 3), 3);
  const rgbv = new THREE.BufferAttribute(new Uint8Array(size * 4), 4);
  const born = new THREE.BufferAttribute(new Float32Array(size), 1);
  if (geometry) {
    position.array.set(geometry.attributes.position.array.subarray(0, count * 3));
    rgbv.array.set(geometry.attributes.rgbv.array.subarray(0, count * 4));
    born.array.set(geometry.attributes.born.array.subarray(0, count));
    geometry.dispose();
    scene.remove(points);
  }
  for (const attribute of [position, rgbv, born]) attribute.setUsage(THREE.DynamicDrawUsage);
  next.setAttribute('position', position);
  next.setAttribute('rgbv', rgbv);
  next.setAttribute('born', born);
  next.setDrawRange(0, count);
  // The cloud grows without bound; skip frustum culling rather than recomputing bounds.
  points = new THREE.Points(next, pointMaterial);
  points.frustumCulled = false;
  scene.add(points);
  geometry = next;
  capacity = size;
  dirtyFrom = 0;
  dirtyTo = count;
}
allocate(1 << 18);

function applyPoints(buffer) {
  const n = new Uint32Array(buffer, 4, 1)[0];
  const index = new Uint32Array(buffer, 8, n);
  const xyz = new Float32Array(buffer, 8 + n * 4, n * 3);
  const rgbv = new Uint8Array(buffer, 8 + n * 16, n * 4);
  let highest = count - 1;
  for (let j = 0; j < n; j++) highest = Math.max(highest, index[j]);
  if (highest >= capacity) {
    let size = capacity;
    while (size <= highest) size *= 2;
    allocate(size);
  }
  const position = geometry.attributes.position.array;
  const color = geometry.attributes.rgbv.array;
  const born = geometry.attributes.born.array;
  const now = clock.getElapsedTime();
  for (let j = 0; j < n; j++) {
    const i = index[j];
    position[i * 3] = xyz[j * 3];
    position[i * 3 + 1] = xyz[j * 3 + 1];
    position[i * 3 + 2] = xyz[j * 3 + 2];
    color.set(rgbv.subarray(j * 4, j * 4 + 4), i * 4);
    if (i >= count) born[i] = now;
    dirtyFrom = Math.min(dirtyFrom, i);
    dirtyTo = Math.max(dirtyTo, i + 1);
  }
  count = Math.max(count, highest + 1);
  geometry.setDrawRange(0, count);
  if (count > 0) $('empty').hidden = true;
}

function uploadDirty() {
  if (dirtyTo <= dirtyFrom) return;
  for (const [name, size] of [['position', 3], ['rgbv', 4], ['born', 1]]) {
    const attribute = geometry.attributes[name];
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(dirtyFrom * size, (dirtyTo - dirtyFrom) * size);
    attribute.needsUpdate = true;
  }
  dirtyFrom = Infinity;
  dirtyTo = -1;
}

// ---- The phone: a live frustum, the path it took, and the latest keyframe on its own frustum.
const FRUSTUM_DEPTH = 0.12;
function frustumCorners(k, d) {
  const left = (-k.cx / k.fx) * d, right = ((k.width - k.cx) / k.fx) * d;
  const top = (k.cy / k.fy) * d, bottom = (-(k.height - k.cy) / k.fy) * d;
  return { left, right, top, bottom };
}
function frustumLines(k, color) {
  const { left, right, top, bottom } = frustumCorners(k, FRUSTUM_DEPTH);
  const d = -FRUSTUM_DEPTH;
  const c = [[left, top, d], [right, top, d], [right, bottom, d], [left, bottom, d]];
  const v = [];
  for (let i = 0; i < 4; i++) v.push(0, 0, 0, ...c[i], ...c[i], ...c[(i + 1) % 4]);
  // A tick on the top edge shows which way is up in the image.
  v.push(left * 0.2, top, d, 0, top * 1.25, d, 0, top * 1.25, d, right * 0.2, top, d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}
// Until the first keyframe says otherwise, assume the 4:3 wide camera.
const DEFAULT_K = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 };
const phone = new THREE.Group();
phone.matrixAutoUpdate = false;
phone.visible = false;
scene.add(phone);
let phoneLines = frustumLines(DEFAULT_K, 0xffd166);
phone.add(phoneLines);

const keyframe = new THREE.Group();
keyframe.matrixAutoUpdate = false;
keyframe.visible = false;
scene.add(keyframe);
const keyframeMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
const keyframePlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), keyframeMaterial);
keyframe.add(keyframePlane);
let keyframeLines = null;
let lastK = null;

const TRAIL = 20000;
const trailPositions = new Float32Array(TRAIL * 3);
const trailGeometry = new THREE.BufferGeometry();
trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
trailGeometry.setDrawRange(0, 0);
const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45 }));
trail.frustumCulled = false;
scene.add(trail);
let trailCount = 0;

let pose = null;
function applyPose(m) {
  pose = m;
  phone.matrix.fromArray(m);
  phone.matrixWorldNeedsUpdate = true;
  phone.visible = true;
  if (trailCount === TRAIL) {
    trailPositions.copyWithin(0, 3);
    trailCount--;
  }
  const last = trailCount - 1;
  const moved = last < 0 || Math.hypot(m[12] - trailPositions[last * 3], m[13] - trailPositions[last * 3 + 1], m[14] - trailPositions[last * 3 + 2]) > 0.005;
  if (moved) {
    trailPositions.set([m[12], m[13], m[14]], trailCount * 3);
    trailCount++;
    trailGeometry.setDrawRange(0, trailCount);
    trailGeometry.attributes.position.needsUpdate = true;
  }
}

async function applyKeyframe(buffer) {
  const jsonLength = new Uint32Array(buffer, 4, 1)[0];
  const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength)));
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer, 8 + jsonLength)], { type: 'image/jpeg' }), { imageOrientation: 'flipY' });
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  keyframeMaterial.map?.dispose();
  keyframeMaterial.map = texture;
  keyframeMaterial.needsUpdate = true;
  const k = info.intrinsics;
  const { left, right, top, bottom } = frustumCorners(k, FRUSTUM_DEPTH);
  keyframePlane.scale.set(right - left, top - bottom, 1);
  keyframePlane.position.set((left + right) / 2, (top + bottom) / 2, -FRUSTUM_DEPTH);
  if (!lastK || lastK.fx !== k.fx || lastK.width !== k.width) {
    lastK = k;
    keyframe.remove(keyframeLines);
    keyframeLines = frustumLines(k, 0x7fd3ff);
    keyframe.add(keyframeLines);
    phone.remove(phoneLines);
    phoneLines = frustumLines(k, 0xffd166);
    phone.add(phoneLines);
  }
  keyframe.matrix.fromArray(info.pose);
  keyframe.matrixWorldNeedsUpdate = true;
  keyframe.visible = true;
}

// A floor grid at the height most of the lowest points agree on, once there's enough to tell.
const grid = new THREE.GridHelper(20, 40, 0x2a2d33, 0x1c1e22);
grid.visible = false;
scene.add(grid);
function placeGrid() {
  if (count < 5000) return;
  const y = geometry.attributes.position.array;
  const step = Math.max(1, Math.floor(count / 20000));
  const heights = [];
  for (let i = 0; i < count; i += step) heights.push(y[i * 3 + 1]);
  heights.sort((a, b) => a - b);
  grid.position.y = heights[Math.floor(heights.length * 0.02)];
  grid.visible = true;
}
setInterval(placeGrid, 2000);

// ---- Controls.
let follow = true;
function setFollow(on) {
  follow = on;
  $('follow').setAttribute('aria-pressed', String(on));
}
$('follow').onclick = () => setFollow(!follow);
controls.addEventListener('start', () => setFollow(false));
const CONFIDENCE = [[1, 'all points'], [2, 'seen twice+'], [3, 'seen 3×+']];
let confidence = 0;
function cycleConfidence() {
  confidence = (confidence + 1) % CONFIDENCE.length;
  pointMaterial.uniforms.minViews.value = CONFIDENCE[confidence][0];
  $('confidence').textContent = 'Show: ' + CONFIDENCE[confidence][1];
}
$('confidence').onclick = cycleConfidence;
addEventListener('keydown', (e) => {
  if (e.key === 'f') setFollow(!follow);
  if (e.key === 'c') cycleConfidence();
});

// ---- Session and socket.
let session = null;
function fmt(n) { return n.toLocaleString(); }
function showStats(s) {
  $('phone-dot').classList.toggle('on', Boolean(s?.phoneConnected));
  if (!s) return;
  const fit = s.fitError != null ? ' · depth fit ±' + (s.fitError * 100).toFixed(1) + '%' : '';
  const ms = s.fuseMs != null ? ' · ' + s.fuseMs + ' ms/keyframe' : '';
  $('stats').textContent = fmt(s.voxels) + ' points · ' + fmt(s.fused) + ' keyframes fused' + (s.skipped ? ', ' + fmt(s.skipped) + ' skipped' : '') + fit + ms;
  $('skip').textContent = s.lastSkip ? 'Last skip: ' + s.lastSkip : '';
}
function startSession(message) {
  session = message.id ? message : null;
  count = 0;
  geometry.setDrawRange(0, 0);
  trailCount = 0;
  trailGeometry.setDrawRange(0, 0);
  phone.visible = keyframe.visible = grid.visible = false;
  pose = null;
  $('empty').hidden = Boolean(session && session.stats?.voxels);
  $('session').textContent = session
    ? session.id + (session.device ? ' · ' + session.device : '') + (session.mode === 'lidar' ? ' · LiDAR' : ' · no LiDAR')
    : 'no session yet';
  $('download').href = session ? '/api/live/' + session.id + '/points.ply' : '#';
  pointMaterial.uniforms.size.value = (session?.voxelSize ?? 0.02) * Number($('size').value);
  showStats(session?.stats);
  setFollow(true);
}
$('size').oninput = () => { pointMaterial.uniforms.size.value = (session?.voxelSize ?? 0.02) * Number($('size').value); };

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live/socket' + (requested ? '?session=' + encodeURIComponent(requested) : ''));
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      if (message.type === 'session') startSession(message);
      else if (message.type === 'pose') applyPose(message.pose);
      else if (message.type === 'stats') showStats(message.stats);
      return;
    }
    const kind = new Uint32Array(event.data, 0, 1)[0];
    if (kind === 1) applyPoints(event.data);
    else if (kind === 2) applyKeyframe(event.data).catch((e) => console.warn('keyframe image', e));
  };
  ws.onclose = () => {
    $('phone-dot').classList.remove('on');
    $('session').textContent = 'reconnecting to the server…';
    setTimeout(connect, 1000);
  };
}
connect();

// ---- Render loop, with the chase camera when following.
const desiredCamera = new THREE.Vector3();
const desiredTarget = new THREE.Vector3();
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  pointMaterial.uniforms.scale.value = (innerHeight * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  pointMaterial.uniforms.time.value = clock.getElapsedTime();
  uploadDirty();
  if (follow && pose) {
    // Behind and above the phone, looking where it looks, so new points land in front of you.
    const position = new THREE.Vector3(pose[12], pose[13], pose[14]);
    const forward = new THREE.Vector3(-pose[8], -pose[9], -pose[10]);
    const flat = new THREE.Vector3(forward.x, 0, forward.z);
    if (flat.lengthSq() > 1e-4) flat.normalize(); else flat.set(0, 0, -1);
    desiredTarget.copy(position).addScaledVector(forward, 1.0);
    desiredCamera.copy(position).addScaledVector(flat, -1.1).add(new THREE.Vector3(0, 0.55, 0));
    camera.position.lerp(desiredCamera, 0.06);
    controls.target.lerp(desiredTarget, 0.08);
  }
  controls.update();
  renderer.render(scene, camera);
});
</script></body></html>`;
}
