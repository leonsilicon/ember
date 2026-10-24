/**
 * The rover's brain: finding dry leaves in the world, seeing where it can't drive, and steering to
 * leaves. Pure TypeScript (no React Native), unit-tested in tests/rover-brain. See README.md at
 * the repo root for how it fits together.
 */

export * from './autopilot';
export * from './geometry';
export * from './leaf-map';
export * from './obstacles';
export * from './perceive';
