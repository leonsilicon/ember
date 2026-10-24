import {
  MaterialDesignIcons,
  type MaterialDesignIconsIconName,
} from '@react-native-vector-icons/material-design-icons';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Spacing } from '@/constants/theme';

export type Indicator = {
  key: string;
  /** A Material Design Icons glyph (https://pictogrammers.com/library/mdi/). */
  icon: MaterialDesignIconsIconName;
  /** What it means: shown for a moment when it's tapped, and read by VoiceOver. */
  label: string;
  /** `on`: a setting that's on, in the Camera app's yellow, like its flash. */
  tone?: 'dim' | 'good' | 'warn' | 'on';
  /** A count under the icon. */
  text?: string;
  /** Something is on its way (a model loading, say): a spinner turns over the icon. */
  busy?: boolean;
  /** For a setting, like the Camera app's flash: what a tap does, instead of saying what it means. */
  onPress?: () => void;
};

/** A tool of its own in the column (a zoom button, a menu), drawn with `RailIcon` to match. */
export type RailElement = { key: string; element: ReactNode };

export const TONES = {
  dim: 'rgba(255,255,255,0.5)',
  good: '#30D158',
  warn: '#FFD60A',
  on: '#FFD60A',
};

/** How many show before the chevron, as in TikTok's camera. */
const COLLAPSED = 5;

/**
 * The camera's tools and status, like TikTok's camera tools: icons down the top right of the
 * viewfinder, each with its count under it, the first few showing and a chevron for the rest.
 * Beside them, `caption` says what a tapped one means for a moment, and `hint` is guidance that
 * stays while it applies.
 */
export function CameraStatus({
  indicators,
  hint,
  caption,
  onPressIndicator,
}: {
  indicators: (Indicator | RailElement)[];
  hint?: string;
  caption?: string;
  onPressIndicator: (indicator: Indicator) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const message = caption ?? hint;
  const more = indicators.length > COLLAPSED;
  const shown = expanded || !more ? indicators : indicators.slice(0, COLLAPSED);

  return (
    <View style={styles.container}>
      {message && (
        <Animated.View
          key={message}
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          style={styles.message}>
          <Text style={[styles.messageText, caption == null && styles.hintText]}>{message}</Text>
        </Animated.View>
      )}
      {/* Scrolls only if they don't all fit above the record button. */}
      <ScrollView
        style={styles.tools}
        contentContainerStyle={styles.toolsContent}
        showsVerticalScrollIndicator={false}
        bounces={false}>
        {shown.map((indicator, index) => (
          <Animated.View key={indicator.key} entering={index >= COLLAPSED ? FadeIn.duration(150) : undefined}>
            {'element' in indicator ? (
              <Fragment>{indicator.element}</Fragment>
            ) : (
              <Pressable
                accessibilityRole={indicator.onPress ? 'button' : undefined}
                accessibilityLabel={indicator.label}
                hitSlop={Spacing.one}
                onPress={indicator.onPress ?? (() => onPressIndicator(indicator))}
                style={({ pressed }) => pressed && styles.pressed}>
                <RailIcon
                  icon={indicator.icon}
                  color={indicator.tone && TONES[indicator.tone]}
                  text={indicator.text}
                  busy={indicator.busy}
                />
              </Pressable>
            )}
          </Animated.View>
        ))}
        {more && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Fewer tools' : 'All tools'}
            hitSlop={Spacing.one}
            onPress={() => setExpanded(!expanded)}
            style={({ pressed }) => pressed && styles.pressed}>
            <RailIcon icon={expanded ? 'chevron-up' : 'chevron-down'} />
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

/** One of the camera's tools: its icon, with its count under it. `children` (a zoom level, say) take the icon's place. */
export function RailIcon({
  icon,
  color = '#fff',
  text,
  busy,
  children,
}: {
  icon?: MaterialDesignIconsIconName;
  color?: string;
  text?: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={styles.tool}>
      <View style={styles.icon}>
        {children ?? (icon && <MaterialDesignIcons name={icon} size={ICON_SIZE} color={color} style={styles.shadow} />)}
        {busy && <ActivityIndicator size="small" color="#fff" style={styles.spinner} />}
      </View>
      {text && <Text style={[styles.text, styles.shadow, { color }]}>{text}</Text>}
    </View>
  );
}

/** A caption that clears itself after a moment; showing another restarts the clock. */
export function useCaption(durationMs = 2500) {
  const [caption, setCaption] = useState<{ text: string; shownAt: number }>();

  useEffect(() => {
    if (!caption) return;
    const timeout = setTimeout(() => setCaption(undefined), durationMs);
    return () => clearTimeout(timeout);
  }, [caption, durationMs]);

  return [caption?.text, (text: string) => setCaption({ text, shownAt: Date.now() })] as const;
}

const ICON_SIZE = 28;
const TOOL_WIDTH = 44;
/** Room left under the tools for the record button's row. */
const TOOLS_BOTTOM = 112;

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    paddingRight: Spacing.two,
    paddingBottom: TOOLS_BOTTOM,
    pointerEvents: 'box-none',
  },
  /** Level with the first icon. */
  message: {
    flexShrink: 1,
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  messageText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
  },
  hintText: {
    color: '#FFD60A',
  },
  tools: {
    flexGrow: 0,
    maxHeight: '100%',
  },
  toolsContent: {
    alignItems: 'center',
    gap: Spacing.three,
  },
  tool: {
    width: TOOL_WIDTH,
    alignItems: 'center',
  },
  icon: {
    minWidth: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Rings the icon rather than covering it: the small indicator is 20 pt, scaled past the glyph. */
  spinner: {
    position: 'absolute',
    transform: [{ scale: 1.5 }],
  },
  text: {
    fontSize: 11,
    fontWeight: 600,
    fontVariant: ['tabular-nums'],
  },
  /** Legible over any picture, as TikTok's are. */
  shadow: {
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  pressed: {
    opacity: 0.5,
  },
});
