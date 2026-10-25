import * as THREE from 'three';

import type { Intrinsics } from '#live/geometry.ts';

import { SceneControls, wrapAngle } from '../scene-controls';
import fragmentShader from './points.frag';
import vertexShader from './points.vert';

const FRUSTUM_DEPTH = 0.12;
// Until the first keyframe says otherwise, assume the 4:3 wide camera.
const DEFAULT_K: Intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 };
const TRAIL = 20000;
/** How long (s) the chase camera takes to catch up with the phone: long enough to iron out a hand's shake. */
const FOLLOW_SMOOTH = 0.45;
/** camera-controls' own, for transitions the user starts (a scroll, say). */
const MANUAL_SMOOTH = 0.25;

function frustumCorners(k: Intrinsics, d: number) {
  const left = (-k.cx / k.fx) * d;
  const right = ((k.width - k.cx) / k.fx) * d;
  const top = (k.cy / k.fy) * d;
  const bottom = (-(k.height - k.cy) / k.fy) * d;
  return { left, right, top, bottom };
}

function frustumLines(k: Intrinsics, color: number) {
  const { left, right, top, bottom } = frustumCorners(k, FRUSTUM_DEPTH);
  const d = -FRUSTUM_DEPTH;
  const c = [[left, top, d], [right, top, d], [right, bottom, d], [left, bottom, d]];
  const v: number[] = [];
  for (let i = 0; i < 4; i++) v.push(0, 0, 0, ...c[i], ...c[i], ...c[(i + 1) % 4]);
  // A tick on the top edge shows which way is up in the image.
  v.push(left * 0.2, top, d, 0, top * 1.25, d, 0, top * 1.25, d, right * 0.2, top, d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

/**
 * The live reconstruction's 3D view: the point cloud growing as the phone streams, the phone's
 * camera (frustum, path and latest keyframe image), a floor grid, and a chase camera that follows
 * the phone until someone moves the view (scene-controls.ts). live-viewer.tsx feeds it the
 * socket's messages (see live/protocol.ts).
 */
export class LiveScene {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 200);
  private controls: SceneControls;
  private clock = new THREE.Clock();
  private lastFrame = 0;
  private following = true;
  /** The element the canvas fills; the renderer follows its size. */
  private host: HTMLElement;
  private observer: ResizeObserver;

  // Point cloud: one preallocated buffer; voxel i lives at slot i (the server never reorders).
  private pointMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, size: { value: 0.02 }, scale: { value: 1 }, minViews: { value: 1 } },
    vertexShader,
    fragmentShader,
  });
  private capacity = 0;
  private count = 0;
  private geometry: THREE.BufferGeometry | null = null;
  private points: THREE.Points | null = null;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;

  // The phone: a live frustum, the path it took, and the latest keyframe on its own frustum.
  private phone = new THREE.Group();
  private phoneLines = frustumLines(DEFAULT_K, 0xffd166);
  private keyframe = new THREE.Group();
  private keyframeMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  private keyframePlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.keyframeMaterial);
  private keyframeLines: THREE.LineSegments | null = null;
  private lastK: Intrinsics | null = null;
  private trailPositions = new Float32Array(TRAIL * 3);
  private trailGeometry = new THREE.BufferGeometry();
  private trailCount = 0;
  private pose: number[] | null = null;

  // A floor grid at the height most of the lowest points agree on, once there's enough to tell.
  private grid = new THREE.GridHelper(20, 40, 0x2a2d33, 0x1c1e22);
  private gridTimer: ReturnType<typeof setInterval>;

  // The chase camera: how far ahead the phone's view meets the cloud, and its level heading.
  private lookDistance = 1;
  private heading = new THREE.Vector3(0, 0, -1);
  private chaseTarget = new THREE.Vector3();
  private chaseCamera = new THREE.Vector3();

  /** `onTakeOver` is called when someone moves the view, which stops the camera following. */
  constructor(container: HTMLElement, onTakeOver: () => void) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.host = container;
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    this.renderer.setClearColor(0x0b0c0e);
    container.prepend(this.renderer.domElement);
    this.controls = new SceneControls(this.camera, this.renderer.domElement);
    this.controls.setLookAt(1.5, 1.2, 1.5, 0, 0, -1);
    this.controls.smoothTime = FOLLOW_SMOOTH;
    // A drag, not a touch: a tap shouldn't knock it off the phone.
    this.controls.addEventListener('control', () => {
      if (!this.following) return;
      this.follow = false;
      onTakeOver();
    });
    this.allocate(1 << 18);

    this.phone.matrixAutoUpdate = false;
    this.phone.visible = false;
    this.phone.add(this.phoneLines);
    this.scene.add(this.phone);
    this.keyframe.matrixAutoUpdate = false;
    this.keyframe.visible = false;
    this.keyframe.add(this.keyframePlane);
    this.scene.add(this.keyframe);
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(this.trailGeometry, new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45 }));
    trail.frustumCulled = false;
    this.scene.add(trail);
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.gridTimer = setInterval(() => this.placeGrid(), 2000);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get pointCount() {
    return this.count;
  }

  /** Whether the camera chases the phone. */
  get follow() {
    return this.following;
  }

  set follow(on: boolean) {
    this.following = on;
    this.controls.smoothTime = on ? FOLLOW_SMOOTH : MANUAL_SMOOTH;
  }

  /** Whether touches and the mouse move the view; off, it only follows the phone. */
  setInteractive(on: boolean) {
    if (!on) this.controls.cancel();
    this.controls.enabled = on;
  }

  /** Clears everything for a new session. */
  reset() {
    this.count = 0;
    this.geometry!.setDrawRange(0, 0);
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
    this.phone.visible = this.keyframe.visible = this.grid.visible = false;
    this.pose = null;
    this.lookDistance = 1;
  }

  /** Point size in metres (the voxel size times the size slider). */
  setPointSize(size: number) {
    this.pointMaterial.uniforms.size.value = size;
  }

  /** Hides points fewer keyframes have seen. */
  setMinViews(views: number) {
    this.pointMaterial.uniforms.minViews.value = views;
  }

  /** A POINTS message: voxels to add or update. */
  applyPoints(buffer: ArrayBuffer) {
    const n = new Uint32Array(buffer, 4, 1)[0];
    const index = new Uint32Array(buffer, 8, n);
    const xyz = new Float32Array(buffer, 8 + n * 4, n * 3);
    const rgbv = new Uint8Array(buffer, 8 + n * 16, n * 4);
    let highest = this.count - 1;
    for (let j = 0; j < n; j++) highest = Math.max(highest, index[j]);
    if (highest >= this.capacity) {
      let size = this.capacity;
      while (size <= highest) size *= 2;
      this.allocate(size);
    }
    const geometry = this.geometry!;
    const position = geometry.attributes.position.array as Float32Array;
    const color = geometry.attributes.rgbv.array as Uint8Array;
    const born = geometry.attributes.born.array as Float32Array;
    const now = this.clock.getElapsedTime();
    for (let j = 0; j < n; j++) {
      const i = index[j];
      position[i * 3] = xyz[j * 3];
      position[i * 3 + 1] = xyz[j * 3 + 1];
      position[i * 3 + 2] = xyz[j * 3 + 2];
      color.set(rgbv.subarray(j * 4, j * 4 + 4), i * 4);
      if (i >= this.count) born[i] = now;
      this.dirtyFrom = Math.min(this.dirtyFrom, i);
      this.dirtyTo = Math.max(this.dirtyTo, i + 1);
    }
    this.count = Math.max(this.count, highest + 1);
    geometry.setDrawRange(0, this.count);
    this.measureLookDistance(xyz, n);
  }

  /** The phone's camera-to-world pose (column-major), many times a second. */
  applyPose(m: number[]) {
    this.pose = m;
    this.phone.matrix.fromArray(m);
    this.phone.matrixWorldNeedsUpdate = true;
    this.phone.visible = true;
    const trail = this.trailPositions;
    if (this.trailCount === TRAIL) {
      trail.copyWithin(0, 3);
      this.trailCount--;
    }
    const last = this.trailCount - 1;
    const moved = last < 0 || Math.hypot(m[12] - trail[last * 3], m[13] - trail[last * 3 + 1], m[14] - trail[last * 3 + 2]) > 0.005;
    if (moved) {
      trail.set([m[12], m[13], m[14]], this.trailCount * 3);
      this.trailCount++;
      this.trailGeometry.setDrawRange(0, this.trailCount);
      this.trailGeometry.attributes.position.needsUpdate = true;
    }
  }

  /** A KEYFRAME message: the image of the latest fused keyframe, drawn on its frustum. */
  async applyKeyframe(buffer: ArrayBuffer) {
    const jsonLength = new Uint32Array(buffer, 4, 1)[0];
    const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength))) as { pose: number[]; intrinsics: Intrinsics };
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer, 8 + jsonLength)], { type: 'image/jpeg' }), {
      imageOrientation: 'flipY',
    });
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.keyframeMaterial.map?.dispose();
    this.keyframeMaterial.map = texture;
    this.keyframeMaterial.needsUpdate = true;
    const k = info.intrinsics;
    const { left, right, top, bottom } = frustumCorners(k, FRUSTUM_DEPTH);
    this.keyframePlane.scale.set(right - left, top - bottom, 1);
    this.keyframePlane.position.set((left + right) / 2, (top + bottom) / 2, -FRUSTUM_DEPTH);
    if (!this.lastK || this.lastK.fx !== k.fx || this.lastK.width !== k.width) {
      this.lastK = k;
      if (this.keyframeLines) this.keyframe.remove(this.keyframeLines);
      this.keyframeLines = frustumLines(k, 0x7fd3ff);
      this.keyframe.add(this.keyframeLines);
      this.phone.remove(this.phoneLines);
      this.phoneLines = frustumLines(k, 0xffd166);
      this.phone.add(this.phoneLines);
    }
    this.keyframe.matrix.fromArray(info.pose);
    this.keyframe.matrixWorldNeedsUpdate = true;
    this.keyframe.visible = true;
  }

  /** The cloud as a binary PLY (x, y, z, red, green, blue) of the points seen at least `minViews` times. */
  toPly(minViews: number) {
    const position = this.geometry!.attributes.position.array as Float32Array;
    const rgbv = this.geometry!.attributes.rgbv.array as Uint8Array;
    const kept: number[] = [];
    for (let i = 0; i < this.count; i++) if (rgbv[i * 4 + 3] >= minViews) kept.push(i);
    const header = new TextEncoder().encode(
      'ply\nformat binary_little_endian 1.0\ncomment soon2026 live reconstruction\n' +
        `element vertex ${kept.length}\nproperty float x\nproperty float y\nproperty float z\n` +
        'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n',
    );
    const body = new DataView(new ArrayBuffer(kept.length * 15));
    kept.forEach((i, j) => {
      for (let a = 0; a < 3; a++) {
        body.setFloat32(j * 15 + a * 4, position[i * 3 + a], true);
        body.setUint8(j * 15 + 12 + a, rgbv[i * 4 + a]);
      }
    });
    return new Blob([header, body.buffer], { type: 'application/octet-stream' });
  }

  dispose() {
    clearInterval(this.gridTimer);
    this.observer.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.geometry?.dispose();
    this.trailGeometry.dispose();
    this.pointMaterial.dispose();
    this.keyframeMaterial.map?.dispose();
    this.keyframeMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private allocate(size: number) {
    const next = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(size * 3), 3);
    const rgbv = new THREE.BufferAttribute(new Uint8Array(size * 4), 4);
    const born = new THREE.BufferAttribute(new Float32Array(size), 1);
    if (this.geometry && this.points) {
      (position.array as Float32Array).set((this.geometry.attributes.position.array as Float32Array).subarray(0, this.count * 3));
      (rgbv.array as Uint8Array).set((this.geometry.attributes.rgbv.array as Uint8Array).subarray(0, this.count * 4));
      (born.array as Float32Array).set((this.geometry.attributes.born.array as Float32Array).subarray(0, this.count));
      this.geometry.dispose();
      this.scene.remove(this.points);
    }
    for (const attribute of [position, rgbv, born]) attribute.setUsage(THREE.DynamicDrawUsage);
    next.setAttribute('position', position);
    next.setAttribute('rgbv', rgbv);
    next.setAttribute('born', born);
    next.setDrawRange(0, this.count);
    // The cloud grows without bound; skip frustum culling rather than recomputing bounds.
    this.points = new THREE.Points(next, this.pointMaterial);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.geometry = next;
    this.capacity = size;
    this.dirtyFrom = 0;
    this.dirtyTo = this.count;
  }

  private uploadDirty() {
    if (this.dirtyTo <= this.dirtyFrom) return;
    for (const [name, size] of [['position', 3], ['rgbv', 4], ['born', 1]] as const) {
      const attribute = this.geometry!.attributes[name] as THREE.BufferAttribute;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(this.dirtyFrom * size, (this.dirtyTo - this.dirtyFrom) * size);
      attribute.needsUpdate = true;
    }
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
  }

  private placeGrid() {
    if (this.count < 5000) return;
    const y = this.geometry!.attributes.position.array as Float32Array;
    const step = Math.max(1, Math.floor(this.count / 20000));
    const heights: number[] = [];
    for (let i = 0; i < this.count; i += step) heights.push(y[i * 3 + 1]);
    heights.sort((a, b) => a - b);
    this.grid.position.y = heights[Math.floor(heights.length * 0.02)];
    this.grid.visible = true;
  }

  private resize = () => {
    const width = this.host.clientWidth || innerWidth;
    const height = this.host.clientHeight || innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.pointMaterial.uniforms.scale.value = (height * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  };

  /**
   * Where the phone's view meets the cloud: the median depth, along its view direction, of the
   * points a keyframe just fused (a sample of them), eased so one odd keyframe doesn't lurch it.
   */
  private measureLookDistance(xyz: Float32Array, n: number) {
    const m = this.pose;
    if (!m || n < 16) return;
    const step = Math.max(1, Math.floor(n / 256));
    const depths: number[] = [];
    for (let j = 0; j < n; j += step) {
      const depth = -((xyz[j * 3] - m[12]) * m[8] + (xyz[j * 3 + 1] - m[13]) * m[9] + (xyz[j * 3 + 2] - m[14]) * m[10]);
      if (depth > 0.05) depths.push(depth);
    }
    if (depths.length < 8) return;
    depths.sort((a, b) => a - b);
    const median = THREE.MathUtils.clamp(depths[depths.length >> 1], 0.4, 6);
    this.lookDistance += (median - this.lookDistance) * 0.4;
  }

  /**
   * The chase camera: behind and above the phone, looking where it looks at the distance its view
   * meets the cloud, and further back the further that is, so what's being scanned stays in frame
   * whether it's a leaf or a wall across the room. camera-controls eases it there (critically
   * damped, so it never overshoots), orbiting round the target rather than cutting across.
   */
  private chase(m: number[]) {
    const position = new THREE.Vector3(m[12], m[13], m[14]);
    const forward = new THREE.Vector3(-m[8], -m[9], -m[10]);
    // Pointing (nearly) straight up or down, what's left of the level heading is mostly noise;
    // keep the last one rather than swinging round.
    const level = new THREE.Vector3(forward.x, 0, forward.z);
    if (level.lengthSq() > 0.04) this.heading.copy(level.normalize());
    const d = this.lookDistance;
    this.chaseTarget.copy(position).addScaledVector(forward, d);
    this.chaseCamera
      .copy(position)
      .addScaledVector(this.heading, -(0.5 + 0.6 * d))
      .setY(position.y + 0.3 + 0.25 * d);
    const offset = this.chaseCamera.sub(this.chaseTarget);
    const radius = offset.length();
    // Unwrapped next to the current azimuth, so it eases the short way round.
    const current = this.controls.azimuthAngle;
    const azimuth = current + wrapAngle(Math.atan2(offset.x, offset.z) - current);
    const polar = Math.acos(THREE.MathUtils.clamp(offset.y / radius, -1, 1));
    this.controls.moveTo(this.chaseTarget.x, this.chaseTarget.y, this.chaseTarget.z, true);
    this.controls.rotateTo(azimuth, polar, true);
    this.controls.dollyTo(radius, true);
  }

  /** Each frame, with the chase camera when following. */
  private frame() {
    const now = this.clock.getElapsedTime();
    const delta = now - this.lastFrame;
    this.lastFrame = now;
    this.pointMaterial.uniforms.time.value = now;
    this.uploadDirty();
    if (this.following && this.pose) this.chase(this.pose);
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
  }
}
