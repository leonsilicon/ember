varying vec3 vColor;
varying float vFlash;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(mix(vColor, vec3(0.45, 0.9, 1.0), vFlash * 0.7) + vFlash * 0.1, 1.0);
}
