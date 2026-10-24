import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { Glass } from '@/components/glass';
import { SplatStatus } from '@/components/splat-status';
import { Spacing } from '@/constants/theme';
import { useSplatSettings } from '@/hooks/use-splat-settings';
import { describeDay, describeTime, formatDuration, shareCapture } from '@/lib/captures';

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The gallery, like the Photos app: the newest capture fills the screen and its video plays, and
 * swiping right goes back through older ones. Tapping shows or hides the controls; the grid button
 * shows every capture. The `id` param is the capture on screen (the newest without one), so the
 * grid opens a capture by coming back here with its id.
 */
export default function GalleryScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const splat = useSplatSettings();
  /** Oldest first, so the newest is on the right, as in Photos. */
  const [captures, setCaptures] = useState<SavedCapture[] | null>(null);
  const [chrome, setChrome] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<SavedCapture>>(null);
  /** The page the list rests on, so it's only scrolled when the capture on screen changes otherwise. */
  const restingIndex = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCaptures((await SplatCapture.listCaptures()).reverse());
    } catch (e) {
      setError(message(e));
    }
  }, []);

  // Re-read the folder whenever the screen is shown (a capture may have just been saved).
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const found = captures?.findIndex((capture) => capture.captureId === id) ?? -1;
  const index = found >= 0 ? found : (captures?.length ?? 0) - 1;
  const current = index >= 0 ? captures?.[index] : undefined;

  useEffect(() => {
    if (index < 0 || restingIndex.current === index) return;
    restingIndex.current = index;
    list.current?.scrollToOffset({ offset: index * width, animated: false });
  }, [index, width]);

  // One player for the capture on screen. Recordings have no sound; muted, they also leave other
  // apps' audio playing.
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.timeUpdateEventInterval = 0.05;
  });
  const videoUri = current?.videoUri;
  /** The video the player holds, so a page only shows the player once it holds that page's video. */
  const [loadedUri, setLoadedUri] = useState<string>();
  useEffect(() => {
    let alive = true;
    player.replaceAsync(videoUri ?? null).then(
      () => {
        if (!alive) return;
        setLoadedUri(videoUri);
        // Like Photos, a video plays as soon as it's on screen.
        if (videoUri) player.play();
      },
      (e) => alive && setError(message(e)),
    );
    return () => {
      alive = false;
    };
  }, [player, videoUri]);

  // Paused under the grid and the info sheet, and playing again on return if it was.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (focused) {
      if (wasPlaying.current) player.play();
    } else {
      wasPlaying.current = player.playing;
      player.pause();
    }
  }, [focused, player]);

  function confirmDelete(capture: SavedCapture) {
    Alert.alert(
      'Delete capture?',
      'The zip and its video are removed from this phone. Copies you already sent are unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // The one before it takes its place, or the one after when it was the oldest.
            const neighbor = captures?.[index - 1] ?? captures?.[index + 1];
            try {
              await SplatCapture.deleteCapture(capture.captureId);
              router.setParams({ id: neighbor?.captureId });
            } catch (e) {
              setError(message(e));
            }
            refresh();
          },
        },
      ],
    );
  }

  async function share(capture: SavedCapture) {
    try {
      await shareCapture(capture);
    } catch (e) {
      setError(message(e));
    }
  }

  const date = current ? new Date(current.savedAt) : null;

  return (
    <View style={styles.container}>
      {focused && <StatusBar style="light" hidden={!chrome} animated />}

      {captures && captures.length > 0 && (
        <FlatList
          ref={list}
          data={captures}
          keyExtractor={(capture) => capture.captureId}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          windowSize={3}
          extraData={`${current?.captureId}|${loadedUri}`}
          onMomentumScrollEnd={(event) => {
            const i = Math.round(event.nativeEvent.contentOffset.x / width);
            const capture = captures[i];
            restingIndex.current = i;
            if (capture && capture.captureId !== current?.captureId) router.setParams({ id: capture.captureId });
          }}
          renderItem={({ item }) => (
            <Page
              capture={item}
              style={{ width, height }}
              player={item === current && item.videoUri && item.videoUri === loadedUri ? player : null}
              onPress={() => setChrome((shown) => !shown)}
            />
          )}
        />
      )}

      {captures?.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No captures yet</Text>
          <Text style={styles.emptyText}>Record one with the camera&apos;s record button.</Text>
        </View>
      )}

      <Fade hidden={!chrome} style={[styles.top, { paddingTop: insets.top + Spacing.two }]}>
        <RoundButton icon="chevron.left" label="Back to the camera" onPress={() => router.back()} />
        {date && (
          <View style={styles.title}>
            <Text style={styles.titleDay}>{describeDay(date)}</Text>
            <Text style={styles.titleTime}>{describeTime(date)}</Text>
          </View>
        )}
        <RoundButton icon="square.grid.2x2" label="All captures" onPress={() => router.push('/all-captures')} />
      </Fade>

      <Fade hidden={!chrome} style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, Spacing.three) }]}>
        {error && (
          <Pressable accessibilityRole="button" onPress={() => setError(null)} style={styles.errorPanel}>
            <Text style={styles.errorText}>{error}</Text>
          </Pressable>
        )}
        {current && (
          // Its splat: sent to the Mac to train the first time the capture is opened here, with pause and cancel.
          <SplatStatus key={current.captureId} capture={current} serverUrl={splat.serverUrl} autoStart onDark />
        )}
        {current?.videoUri && (
          <PlaybackBar key={current.captureId} player={player} fallbackDuration={current.durationSeconds} />
        )}
        {current && (
          <View style={styles.toolbar}>
            <RoundButton icon="square.and.arrow.up" label="Share the capture" onPress={() => share(current)} />
            <RoundButton
              icon="info.circle"
              label="Info"
              onPress={() => router.push({ pathname: '/capture-info', params: { id: current.captureId } })}
            />
            <RoundButton icon="trash" label="Delete" onPress={() => confirmDelete(current)} />
          </View>
        )}
      </Fade>
    </View>
  );
}

/**
 * One capture, as large as fits. Its first frame stands in until `player` (only set for the page
 * on screen, once it holds this capture's video) draws over it.
 */
function Page({
  capture,
  player,
  style,
  onPress,
}: {
  capture: SavedCapture;
  player: VideoPlayer | null;
  style: StyleProp<ViewStyle>;
  onPress: () => void;
}) {
  const date = new Date(capture.savedAt);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Capture, ${describeDay(date)} ${describeTime(date)}`}
      accessibilityHint="Shows or hides the controls"
      onPress={onPress}
      style={style}>
      {capture.thumbnailUri ? (
        <Image source={capture.thumbnailUri} style={StyleSheet.absoluteFill} contentFit="contain" />
      ) : (
        !capture.videoUri && (
          <View style={styles.noPreview}>
            <SymbolView name="cube.transparent" size={48} tintColor="rgba(255,255,255,0.5)" />
            <Text style={styles.emptyText}>No preview for this capture</Text>
          </View>
        )
      )}
      {player && (
        // Taps go to the page, to show or hide the controls.
        <View style={[StyleSheet.absoluteFill, styles.inert]}>
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
        </View>
      )}
    </Pressable>
  );
}

/** Play/pause and a scrubber for the video on screen, in a glass capsule like the Photos app's. */
function PlaybackBar({ player, fallbackDuration }: { player: VideoPlayer; fallbackDuration?: number }) {
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const time = useEvent(player, 'timeUpdate')?.currentTime ?? 0;
  const duration = useEvent(player, 'sourceLoad')?.duration || fallbackDuration || 0;
  /**
   * While dragging: the scrubber's position, as a fraction of the video, and whether to play again
   * on letting go.
   */
  const [scrub, setScrub] = useState<{ fraction: number; resume: boolean } | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  /** Moves to where the finger is, `locationX` from the scrubber's left edge (even outside it). */
  function scrubTo(locationX: number, resume: boolean) {
    const fraction = Math.min(Math.max(locationX / trackWidth, 0), 1);
    setScrub({ fraction, resume });
    seek(player, fraction * duration);
  }

  function togglePlaying() {
    if (isPlaying) {
      player.pause();
      return;
    }
    // From the start again once it has played to the end.
    if (duration > 0 && player.currentTime >= duration - 0.1) seek(player, 0);
    player.play();
  }

  const progress = scrub?.fraction ?? (duration > 0 ? Math.min(time / duration, 1) : 0);

  return (
    <View style={styles.playback}>
      <Glass style={[StyleSheet.absoluteFill, styles.capsuleShape]} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        onPress={togglePlaying}
        style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}>
        <SymbolView name={isPlaying ? 'pause.fill' : 'play.fill'} size={18} tintColor="#fff" />
      </Pressable>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityValue={{ text: `${formatDuration(progress * duration)} of ${formatDuration(duration)}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          const step = event.nativeEvent.actionName === 'increment' ? 5 : -5;
          seek(player, Math.min(Math.max(player.currentTime + step, 0), duration));
        }}
        style={styles.scrubber}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => duration > 0 && trackWidth > 0}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          const resume = player.playing;
          player.pause();
          scrubTo(event.nativeEvent.locationX, resume);
        }}
        onResponderMove={(event) => scrubTo(event.nativeEvent.locationX, scrub?.resume ?? false)}
        onResponderRelease={() => {
          if (scrub?.resume) player.play();
          setScrub(null);
        }}
        onResponderTerminate={() => setScrub(null)}>
        {/* Not touchable, so touches land on the scrubber itself and are measured from its left edge. */}
        <View style={[styles.track, styles.inert]}>
          <View style={[styles.trackFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={[styles.knob, styles.inert, { left: progress * trackWidth - KNOB_SIZE / 2 }]} />
      </View>
      <Text style={styles.time}>{formatDuration(progress * duration)}</Text>
    </View>
  );
}

/** Outside the components, as the React Compiler doesn't let them assign to a prop. */
function seek(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}

/** Fades out while `hidden`, staying mounted, and meanwhile lets taps and VoiceOver past it. */
function Fade({ hidden, style, children }: { hidden: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const fade = useAnimatedStyle(() => ({ opacity: withTiming(hidden ? 0 : 1, { duration: 200 }) }));

  return (
    <Animated.View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[style, fade, hidden ? styles.inert : styles.passThrough]}>
      {children}
    </Animated.View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: SFSymbol; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
      <Glass style={[StyleSheet.absoluteFill, styles.roundShape]} />
      <SymbolView name={icon} size={20} weight="medium" tintColor="#fff" />
    </Pressable>
  );
}

const ROUND_SIZE = 48;
const KNOB_SIZE = 14;
const SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.5)',
  textShadowRadius: 4,
} as const;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
  },
  /** Centred on the screen, whatever the buttons either side. */
  title: {
    position: 'absolute',
    left: Spacing.three + ROUND_SIZE,
    right: Spacing.three + ROUND_SIZE,
    bottom: 0,
    height: ROUND_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  titleDay: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 600,
    ...SHADOW,
  },
  titleTime: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: 500,
    ...SHADOW,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  playback: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROUND_SIZE,
    paddingRight: Spacing.three,
  },
  capsuleShape: {
    borderRadius: ROUND_SIZE / 2,
  },
  playButton: {
    width: ROUND_SIZE,
    height: ROUND_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Taller than the track it draws, so it's easy to catch. */
  scrubber: {
    flex: 1,
    height: ROUND_SIZE,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    backgroundColor: '#fff',
  },
  knob: {
    position: 'absolute',
    top: (ROUND_SIZE - KNOB_SIZE) / 2,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: '#fff',
  },
  time: {
    minWidth: 40,
    marginLeft: Spacing.three,
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  round: {
    width: ROUND_SIZE,
    height: ROUND_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundShape: {
    borderRadius: ROUND_SIZE / 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 600,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    textAlign: 'center',
  },
  noPreview: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  errorPanel: {
    padding: Spacing.three,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  errorText: {
    color: '#ffb4a8',
    textAlign: 'center',
  },
  passThrough: {
    pointerEvents: 'box-none',
  },
  inert: {
    pointerEvents: 'none',
  },
  pressed: {
    opacity: 0.6,
  },
});
