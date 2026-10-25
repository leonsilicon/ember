import { SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import type { Job } from '#jobs.ts';

import { SceneControls } from '../../scene-controls';

function describe(job: Job) {
  const seed = job.mode === 'lidar' ? 'LiDAR seed' : 'no-LiDAR feature-point seed';
  const count = job.gaussians ? ` · ${job.gaussians.toLocaleString()} gaussians` : '';
  switch (job.state) {
    case 'uploading':
      return 'Waiting for the phone to finish uploading…';
    case 'queued':
      return 'Queued for training on the Mac…';
    case 'training':
      return `Training ${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps${count} · ${seed}`;
    case 'paused':
      return `Paused at ${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps${count} · ${seed}`;
    case 'failed':
      return `Failed: ${job.error}`;
    case 'cancelled':
      return 'Cancelled from the phone; nothing was kept.';
    case 'done':
      return `Done in ${job.trainSeconds} s${count} · ${seed}`;
  }
}

/** The splat viewer's three.js scene: scene-controls.ts, and the newest snapshot loaded as training goes. */
export class SplatScene {
  private renderer = new THREE.WebGLRenderer({ antialias: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
  private controls: SceneControls;
  private clock = new THREE.Clock();
  private current: SplatMesh | null = null;
  private shownStep = 0;
  private loading = false;
  private jobText = '';
  private viewerError = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private observer: ResizeObserver;

  constructor(
    private container: HTMLElement,
    private id: string,
    private onStatus: (text: string) => void,
  ) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    container.prepend(this.renderer.domElement);
    this.scene.add(new SparkRenderer({ renderer: this.renderer }));
    this.controls = new SceneControls(this.camera, this.renderer.domElement);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.renderer.setAnimationLoop(() => {
      this.controls.update(this.clock.getDelta());
      this.renderer.render(this.scene, this.camera);
    });
    this.start().catch((error) => {
      this.viewerError = error.message;
      this.render();
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.observer.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.current?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize = () => {
    const width = this.container.clientWidth || innerWidth;
    const height = this.container.clientHeight || innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private async start() {
    // Start where the phone started: ARKit's world is gravity-aligned with +y up, like three.js,
    // so the capture pose can be used as-is. Look along its view direction with +y up so the
    // scene is upright even though ARKit's camera frame is landscape, and orbit around what
    // the camera was looking at (job.focus, from the seed cloud) rather than a guessed distance.
    const [transforms, job] = await Promise.all([
      fetch(`/api/captures/${this.id}/transforms.json`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/captures/${this.id}`).then((r) => r.json() as Promise<Job>),
    ]);
    if (transforms) {
      const m = transforms.frames[0].transform_matrix;
      const position = new THREE.Vector3(m[0][3], m[1][3], m[2][3]);
      const forward = new THREE.Vector3(-m[0][2], -m[1][2], -m[2][2]).normalize();
      const target = job.focus ? new THREE.Vector3(...job.focus) : position.clone().addScaledVector(forward, 1.5);
      this.controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z);
    } else {
      // Not extracted on the Mac yet; the next load of the page starts at the capture's pose.
      this.controls.setLookAt(0, 0, 2, 0, 0, 0);
    }
    this.poll();
  }

  private render() {
    if (this.disposed) return;
    this.onStatus(this.viewerError ? `Viewer error: ${this.viewerError}` : this.jobText + (this.loading ? ' · loading splat…' : ''));
  }

  private async show(step: number) {
    this.loading = true;
    this.render();
    try {
      const mesh = new SplatMesh({ url: `/api/captures/${this.id}/splat.ply?step=${step}`, fileType: SplatFileType.PLY });
      await mesh.initialized;
      if (this.disposed) return mesh.dispose();
      this.scene.add(mesh);
      if (this.current) {
        this.scene.remove(this.current);
        this.current.dispose();
      }
      this.current = mesh;
      this.shownStep = step;
      this.viewerError = '';
    } catch (error) {
      this.viewerError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async poll() {
    if (this.disposed) return;
    try {
      const job = (await (await fetch(`/api/captures/${this.id}`)).json()) as Job;
      this.jobText = describe(job);
      this.render();
      // One download at a time; a newer snapshot is picked up on the next poll.
      if (job.step > this.shownStep && !this.loading) await this.show(job.step);
      const pending = job.state === 'uploading' || job.state === 'queued' || job.state === 'training' || job.state === 'paused';
      if (pending || job.step > this.shownStep) this.timer = setTimeout(() => this.poll(), 2000);
    } catch (error) {
      this.viewerError = error instanceof Error ? error.message : String(error);
      this.render();
      this.timer = setTimeout(() => this.poll(), 4000);
    }
  }
}
