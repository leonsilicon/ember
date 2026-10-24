import { requireNativeView } from 'expo';
import * as React from 'react';

import { SplatCaptureViewProps } from './SplatCapture.types';

const NativeView: React.ComponentType<SplatCaptureViewProps> = requireNativeView('SplatCapture');

export default function SplatCaptureView(props: SplatCaptureViewProps) {
  return <NativeView {...props} />;
}
