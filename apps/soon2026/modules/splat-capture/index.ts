// Re-export the native module. On web, it will be resolved to SplatCaptureModule.web.ts
// and on native platforms to SplatCaptureModule.ts
export { default } from './src/SplatCaptureModule';
export { default as SplatCaptureView } from './src/SplatCaptureView';
export * from './src/SplatCapture.types';
