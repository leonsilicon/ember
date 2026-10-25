import CameraControls from 'camera-controls';
import * as THREE from 'three';

CameraControls.install({ THREE });

/** How far two fingers turn (radians) before the twist kicks in, so pinches and pans don't wobble the view. */
const TWIST_THRESHOLD = 0.12;
/** Below this span (CSS pixels) the angle between two fingers is too noisy to twist by. */
const TWIST_MIN_SPAN = 40;

/** An angle difference brought into [-π, π]. */
export function wrapAngle(angle: number) {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/**
 * The splat pages' camera: camera-controls (one finger orbits, two fingers pan and pinch towards
 * where they are, eased; on a desktop drag, right-drag and scroll), plus a two-finger twist that
 * turns the scene about the vertical, like Maps. +y is up, as in ARKit's world.
 */
export class SceneControls extends CameraControls {
  private twistPair = '';
  private twistAngle = 0;
  private twistSlack = 0;
  private twisting = false;

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement) {
    super(camera, element);
    this.dollyToCursor = true;
    // Pinching past the orbit point carries on through it, so you can walk into a room.
    this.infinityDolly = true;
    this.minDistance = 0.25;
    this.maxDistance = 50;
    // Closer to the fingers than the default 0.125 s, which feels like dragging through syrup.
    this.draggingSmoothTime = 0.07;
    this.addEventListener('control', this.twist);
  }

  /** On each drag update; turns by however much two fingers have rotated about each other since the last. */
  private twist = () => {
    const pointers = this._activePointers;
    if (pointers.length !== 2) {
      this.twistPair = '';
      return;
    }
    const [a, b] = pointers;
    const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    const pair = `${a.pointerId}:${b.pointerId}`;
    if (pair !== this.twistPair || Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) < TWIST_MIN_SPAN) {
      // A new pair of fingers (or ones too close to read): start counting from here.
      this.twistPair = pair;
      this.twistAngle = angle;
      this.twistSlack = 0;
      this.twisting = false;
      return;
    }
    const delta = wrapAngle(angle - this.twistAngle);
    this.twistAngle = angle;
    if (!this.twisting) {
      this.twistSlack += delta;
      if (Math.abs(this.twistSlack) < TWIST_THRESHOLD) return;
      this.twisting = true;
    }
    // Fingers turning clockwise on screen turn the ground clockwise as seen from above, which is the
    // camera going anticlockwise round it: a larger azimuth.
    this.rotate(delta, 0, true);
    // Eased like the drags it rides along with (rotate() resets this).
    this._isUserControllingRotate = true;
  };
}
