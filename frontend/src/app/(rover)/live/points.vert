// The live cloud's points: sized by distance, hidden below the confidence filter, and growing in
// with a cyan flash when new, so you can watch the scene materialise.
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
  float grow = mix(0.25, 1.0, clamp(age / 0.35, 0.0, 1.0));
  gl_PointSize = rgbv.a < minViews ? 0.0 : max(size * scale / -mv.z * grow, 1.0);
}
