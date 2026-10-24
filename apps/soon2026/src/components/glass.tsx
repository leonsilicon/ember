import { GlassView, isLiquidGlassAvailable, type GlassViewProps } from 'expo-glass-effect';
import { StyleSheet } from 'react-native';

const LIQUID_GLASS = isLiquidGlassAvailable();

/**
 * The camera controls' Liquid Glass, dark like the Camera app's unless `colorScheme` says otherwise.
 * Without Liquid Glass (before iOS 26) it's a translucent dark fill.
 */
export function Glass({ style, ...props }: GlassViewProps) {
  return <GlassView colorScheme="dark" style={[!LIQUID_GLASS && styles.fallback, style]} {...props} />;
}

export { LIQUID_GLASS };

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: 'rgba(40,40,40,0.75)',
  },
});
