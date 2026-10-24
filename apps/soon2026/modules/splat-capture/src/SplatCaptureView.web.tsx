import { View } from 'react-native';

import { SplatCaptureViewProps } from './SplatCapture.types';

// There's no AR camera on the web; render an empty box where the preview would be.
export default function SplatCaptureView({ style }: SplatCaptureViewProps) {
  return <View style={[{ backgroundColor: '#000' }, style]} />;
}
