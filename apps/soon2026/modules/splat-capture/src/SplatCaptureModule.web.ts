import { registerWebModule, NativeModule } from 'expo';

import { Capabilities, SavedCapture, SplatCaptureModuleEvents } from './SplatCapture.types';

// Capture needs ARKit, so on the web the module only reports that it can't capture.
class SplatCaptureModule extends NativeModule<SplatCaptureModuleEvents> {
  getCapabilities(): Capabilities {
    return { arkit: false, lidar: false };
  }

  async listCaptures(): Promise<SavedCapture[]> {
    return [];
  }
}

export default registerWebModule(SplatCaptureModule, 'SplatCaptureModule');
