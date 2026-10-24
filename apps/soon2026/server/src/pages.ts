import type { Job } from './jobs';

const THREE_VERSION = '0.180.0';
const SPARK_VERSION = '2.3.1';

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function describe(job: Job) {
  const seed = job.mode === 'lidar' ? 'LiDAR seed' : job.mode === 'features' ? 'feature-point seed (no LiDAR)' : 'seed';
  const progress =
    job.state === 'training' ? `training ${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps` : job.state;
  const gaussians = job.gaussians ? ` · ${job.gaussians.toLocaleString()} gaussians` : '';
  return `${progress}${gaussians} · ${job.frames} frames · ${seed}, ${job.seedPoints.toLocaleString()} pts`;
}

const BASE_STYLE = `
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1a; --muted: #6b6b66; --card: #fff; --line: #e2e2dd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #9a9a94; --card: #1b1b1b; --line: #2c2c2c; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
`;

export function indexPage(jobs: Job[]) {
  const rows = jobs
    .map(
      (job) => `<li><a href="/view/${escape(job.id)}">${escape(job.id)}</a>
      <span class="state ${job.state}">${escape(describe(job))}</span>
      ${job.error ? `<pre>${escape(job.error)}</pre>` : ''}</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Splat captures</title>
<style>${BASE_STYLE}
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px; }
  ul { list-style: none; padding: 0; } li { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 10px 0; }
  a { color: inherit; font-weight: 600; } .state { display: block; color: var(--muted); font-size: 13px; }
  .failed { color: #c0392b; } pre { white-space: pre-wrap; font-size: 12px; color: var(--muted); }
</style></head>
<body><main><h1>Splat captures</h1>
${jobs.length ? `<ul>${rows}</ul>` : '<p>No captures yet. Record one in the app and it appears here.</p>'}
<p class="state">API: <code>GET /api/captures</code>, <code>GET /api/captures/:id</code>, <code>GET /api/captures/:id/splat.ply</code></p>
</main><script>setTimeout(() => location.reload(), 3000)</script></body></html>`;
}

export function viewerPage(id: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Splat viewer</title>
<style>${BASE_STYLE}
  body { overflow: hidden; background: #0d0d0d; } canvas { display: block; touch-action: none; }
  #hud { position: fixed; left: 12px; right: 12px; top: 12px; color: #eee; font-size: 13px; pointer-events: none;
         text-shadow: 0 1px 2px #000; } #hud a { pointer-events: auto; color: #eee; }
</style>
<script type="importmap">{"imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/",
  "@sparkjsdev/spark": "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@${SPARK_VERSION}/dist/spark.module.js"
}}</script></head>
<body><div id="hud"><a href="/">All captures</a> · <span id="status">loading…</span></div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const id = ${JSON.stringify(id)};
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new SparkRenderer({ renderer }));
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Start where the phone started: ARKit's world is gravity-aligned with +y up, like three.js,
// so the capture pose can be used as-is. Look along its view direction with +y up so the
// scene is upright even though ARKit's camera frame is landscape, and orbit around what
// the camera was looking at (job.focus, from the seed cloud) rather than a guessed distance.
const [transforms, firstJob] = await Promise.all([
  fetch('/api/captures/' + id + '/transforms.json').then((r) => r.json()),
  fetch('/api/captures/' + id).then((r) => r.json()),
]);
const m = transforms.frames[0].transform_matrix;
const position = new THREE.Vector3(m[0][3], m[1][3], m[2][3]);
const forward = new THREE.Vector3(-m[0][2], -m[1][2], -m[2][2]).normalize();
camera.position.copy(position);
controls.target.copy(firstJob.focus ? new THREE.Vector3(...firstJob.focus) : position.clone().addScaledVector(forward, 1.5));
controls.update();

let shownStep = 0;
let loading = false;
let current = null;
let jobText = '';
let viewerError = '';
function render() {
  status.textContent = viewerError ? 'Viewer error: ' + viewerError : jobText + (loading ? ' · loading splat…' : '');
}

async function show(step) {
  loading = true;
  render();
  try {
    const mesh = new SplatMesh({ url: '/api/captures/' + id + '/splat.ply?step=' + step, fileType: 'ply' });
    await mesh.initialized;
    scene.add(mesh);
    if (current) { scene.remove(current); current.dispose(); }
    current = mesh;
    shownStep = step;
    viewerError = '';
  } catch (e) {
    viewerError = e.message;
  } finally {
    loading = false;
    render();
  }
}

async function poll() {
  try {
    const job = await (await fetch('/api/captures/' + id)).json();
    const seed = job.mode === 'lidar' ? 'LiDAR seed' : 'no-LiDAR feature-point seed';
    const count = job.gaussians ? ' · ' + job.gaussians.toLocaleString() + ' gaussians' : '';
    jobText = job.state === 'training'
      ? 'Training ' + job.step.toLocaleString() + ' / ' + job.steps.toLocaleString() + ' steps' + count + ' · ' + seed
      : job.state === 'failed' ? 'Failed: ' + job.error
      : job.state === 'queued' ? 'Queued for training…'
      : 'Done in ' + job.trainSeconds + ' s' + count + ' · ' + seed;
    render();
    // One download at a time; a newer snapshot is picked up on the next poll.
    if (job.step > shownStep && !loading) await show(job.step);
    if (job.state === 'queued' || job.state === 'training' || job.step > shownStep) setTimeout(poll, 2000);
  } catch (e) {
    viewerError = e.message;
    render();
    setTimeout(poll, 4000);
  }
}
poll();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
</script></body></html>`;
}
