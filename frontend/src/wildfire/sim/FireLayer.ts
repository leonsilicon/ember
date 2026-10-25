import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MLMap } from 'maplibre-gl'
import { gridBounds, type FuelGrid } from './grid'

const VS = `#version 300 es
in vec2 a_pos; in vec2 a_uv; uniform mat4 u_matrix; out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_arr; uniform float u_t; uniform float u_clock; uniform vec2 u_size;
in vec2 v_uv; out vec4 color;
float at(ivec2 p) { p = clamp(p, ivec2(0), ivec2(u_size) - 1); return min(texelFetch(u_arr, p, 0).r, 1e6); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 g = v_uv * u_size - 0.5;
  ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  float a = mix(mix(at(i), at(i + ivec2(1, 0)), f.x), mix(at(i + ivec2(0, 1)), at(i + ivec2(1, 1)), f.x), f.y);
  float age = u_t - a;
  if (age < 0.0) discard;
  float flick = hash(floor(g * 3.0) + floor(u_clock * 10.0) * 0.173);
  float n = hash(floor(g * 3.0));
  float front = smoothstep(35.0, 0.0, age);
  vec3 fire = mix(vec3(1.0, 0.22, 0.0), vec3(1.0, 0.86, 0.25), flick * front);
  vec3 ash = vec3(0.07, 0.055, 0.05);
  float ember = step(0.975, n) * step(0.5, flick) * smoothstep(300.0, 20.0, age);
  vec3 c = mix(ash, fire, front) + ember * vec3(1.0, 0.35, 0.05);
  float alpha = mix(0.6, 0.95, front) * smoothstep(0.0, 6.0, age);
  color = vec4(c * alpha, alpha);
}`

/**
 * Drapes the simulation's arrival-time field over the map as a WebGL texture and shades it by the
 * timeline position: an animated flame band where the front is now, char and embers behind it.
 */
export class FireLayer implements CustomLayerInterface {
  id = 'wf-fire'
  type = 'custom' as const
  renderingMode = '2d' as const
  private map: MLMap | null = null
  private gl: WebGL2RenderingContext | null = null
  private prog: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private tex: WebGLTexture | null = null
  private size: [number, number] = [1, 1]
  private pending: Float32Array | null = null
  private start = performance.now()
  /** timeline position, minutes since ignition; negative hides the layer */
  t = -1
  playing = false

  private grid: FuelGrid
  constructor(grid: FuelGrid) {
    this.grid = grid
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
    this.prog = prog

    const [[w, s], [e, n]] = gridBounds(this.grid)
    const nw = MercatorCoordinate.fromLngLat([w, n]), se = MercatorCoordinate.fromLngLat([e, s])
    // x, y, u, v  — v = 0 is the grid's top row (north)
    const verts = new Float32Array([nw.x, nw.y, 0, 0, se.x, nw.y, 1, 0, nw.x, se.y, 0, 1, se.x, se.y, 1, 1])
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'a_pos'), aUv = gl.getAttribLocation(prog, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
    this.vao = vao

    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.pending) this.upload(this.pending)
  }

  setArrival(arrival: Float32Array | null) {
    this.pending = arrival
    if (this.gl && arrival) this.upload(arrival)
    this.map?.triggerRepaint()
  }

  private upload(arr: Float32Array) {
    const gl = this.gl!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.grid.width, this.grid.height, 0, gl.RED, gl.FLOAT, arr)
    this.size = [this.grid.width, this.grid.height]
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    if (!this.prog || !this.pending || this.t < 0) return
    gl.useProgram(this.prog)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'u_matrix'), false, opts.defaultProjectionData.mainMatrix)
    gl.uniform1f(gl.getUniformLocation(this.prog, 'u_t'), this.t)
    gl.uniform1f(gl.getUniformLocation(this.prog, 'u_clock'), (performance.now() - this.start) / 1000)
    gl.uniform2f(gl.getUniformLocation(this.prog, 'u_size'), this.size[0], this.size[1])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform1i(gl.getUniformLocation(this.prog, 'u_arr'), 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    if (this.playing) this.map?.triggerRepaint()
  }

  onRemove() {
    const gl = this.gl
    if (!gl) return
    if (this.prog) gl.deleteProgram(this.prog)
    if (this.tex) gl.deleteTexture(this.tex)
    if (this.vao) gl.deleteVertexArray(this.vao)
    this.gl = null
  }
}
