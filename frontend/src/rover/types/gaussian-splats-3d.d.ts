declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Camera, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
  import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

  export enum SceneRevealMode {
    Default = 0,
    Gradual = 1,
    Instant = 2,
  }

  export enum SceneFormat {
    Splat = 0,
    KSplat = 1,
    Ply = 2,
    Spz = 3,
  }

  export enum RenderMode {
    Always = 0,
    OnChange = 1,
    Never = 2,
  }

  export interface ViewerOptions {
    rootElement?: HTMLElement
    cameraUp?: [number, number, number]
    initialCameraPosition?: [number, number, number]
    initialCameraLookAt?: [number, number, number]
    selfDrivenMode?: boolean
    useBuiltInControls?: boolean
    gpuAcceleratedSort?: boolean
    sharedMemoryForWorkers?: boolean
    halfPrecisionCovariancesOnGPU?: boolean
    dynamicScene?: boolean
    renderMode?: RenderMode
    sceneRevealMode?: SceneRevealMode
    sphericalHarmonicsDegree?: number
    camera?: Camera
    renderer?: WebGLRenderer
    threeScene?: Scene
    antialiased?: boolean
    logLevel?: number
  }

  export interface SplatSceneOptions {
    showLoadingUI?: boolean
    progressiveLoad?: boolean
    splatAlphaRemovalThreshold?: number
    position?: [number, number, number]
    rotation?: [number, number, number, number]
    scale?: [number, number, number]
    format?: SceneFormat
    onProgress?: (percent: number, message: string, stage: number) => void
  }

  export interface SplatBuffer {
    getSplatCount(): number
  }

  export interface SplatScene {
    splatBuffer?: SplatBuffer
  }

  export class Viewer {
    constructor(options?: ViewerOptions)
    camera: PerspectiveCamera
    renderer: WebGLRenderer
    controls?: OrbitControls
    perspectiveControls?: OrbitControls
    orthographicControls?: OrbitControls
    selfDrivenModeRunning: boolean
    keyDownListener?: (e: KeyboardEvent) => void
    addSplatScene(path: string, options?: SplatSceneOptions): Promise<void>
    removeSplatScene(index: number, showLoadingUI?: boolean): Promise<void>
    getSplatScene(index: number): SplatScene | undefined
    getSceneCount(): number
    isLoadingOrUnloading(): boolean
    start(): void
    stop(): void
    dispose(): Promise<void>
    setRenderMode(mode: RenderMode): void
    forceRenderNextFrame(): void
  }
}
