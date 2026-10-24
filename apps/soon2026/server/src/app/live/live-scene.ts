import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Intrinsics } from '#live/geometry.ts';

import fragmentShader from './points.frag';
import vertexShader from './points.vert';

const FRUSTUM_DEPTH = 0.12;
// Until the first keyframe says otherwise, assume the 4:3 wide camera.
const DEFAULT_K: Intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 };
const TRAIL = 20000;

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
 * the phone. live-viewer.tsx feeds it the socket's messages (see live/protocol.ts).
 */
export class LiveScene {
  /** Whether the camera chases the phone. */
  follow = true;

  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 200);
  private controls: OrbitControls;
  private clock = new THREE.Clock();

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
  private desiredCamera = new THREE.Vector3();
  private desiredTarget = new THREE.Vector3();

  constructor(container: HTMLElement, onDrag: { start(): void; end(): void }) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setClearColor(0x0b0c0e);
    container.prepend(this.renderer.domElement);
    this.camera.position.set(1.5, 1.2, 1.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, -1);
    this.controls.addEventListener('start', onDrag.start);
    this.controls.addEventListener('end', onDrag.end);
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

    addEventListener('resize', this.resize);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get pointCount() {
    return this.count;
  }

  /** Clears everything for a new session. */
  reset() {
    this.count = 0;
    this.geometry!.setDrawRange(0, 0);
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
    this.phone.visible = this.keyframe.visible = this.grid.visible = false;
    this.pose = null;
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
    removeEventListener('resize', this.resize);
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
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.pointMaterial.uniforms.scale.value = (innerHeight * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  };

  /** Each frame, with the chase camera when following. */
  private frame() {
    this.pointMaterial.uniforms.time.value = this.clock.getElapsedTime();
    this.uploadDirty();
    const pose = this.pose;
    if (this.follow && pose) {
      // Behind and above the phone, looking where it looks, so new points land in front of you.
      const position = new THREE.Vector3(pose[12], pose[13], pose[14]);
      const forward = new THREE.Vector3(-pose[8], -pose[9], -pose[10]);
      const flat = new THREE.Vector3(forward.x, 0, forward.z);
      if (flat.lengthSq() > 1e-4) flat.normalize();
      else flat.set(0, 0, -1);
      this.desiredTarget.copy(position).addScaledVector(forward, 1.0);
      this.desiredCamera.copy(position).addScaledVector(flat, -1.1).add(new THREE.Vector3(0, 0.55, 0));
      this.camera.position.lerp(this.desiredCamera, 0.06);
      this.controls.target.lerp(this.desiredTarget, 0.08);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
