import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
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
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { BottomTray, TRAY_MARGIN } from './bottom-tray';
import { SplatStatus } from './splat-status';

import { Spacing } from '@/constants/theme';
import { useSplatSettings } from '@/hooks/use-splat-settings';
import { describeDay, describeTime, formatDuration, shareCapture } from '@/lib/captures';

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The camera screen's gallery mode, laid out like its remote mode: the capture on screen plays
 * whole in a card where the viewfinder was, and its controls (the splat it's being made into, the
 * scrubber, share, info, delete and the grid of every capture) rise in a tray of glass under it,
 * which the card makes room for. Swiping the card right goes back through older captures (the
 * newest first, as in Photos), and pulling the tray down returns to the camera: there's no back
 * button. The capture on screen is the camera screen's `capture` param (the newest without one), so
 * the grid (/all-captures) opens one by coming back with its id; the camera screen clears it on
 * closing, so the gallery opens on the newest again.
 */
export function Gallery({ onClose }: { onClose: () => void }) {
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const splat = useSplatSettings();
  /** Oldest first, so the newest is on the right, as in Photos. */
  const [captures, setCaptures] = useState<SavedCapture[] | null>(null);
  /** The capture on screen; the newest while unset. */
  const { capture: currentId } = useLocalSearchParams<{ capture?: string }>();
  const [error, setError] = useState<string | null>(null);
  /** The tray's height once it's laid out, which the card leaves room for. */
  const [trayHeight, setTrayHeight] = useState(0);
  const list = useRef<FlatList<SavedCapture>>(null);
  /** The page and page width the list rests at, so it's only scrolled when either changes under it. */
  const resting = useRef<{ index: number; width: number } | null>(null);

  useEffect(() => {
    let alive = true;
    SplatCapture.listCaptures().then(
      (list) => alive && setCaptures(list.reverse()),
      (e) => alive && setError(message(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  function select(captureId: string | undefined) {
    router.setParams({ capture: captureId });
  }

  const found = captures?.findIndex((capture) => capture.captureId === currentId) ?? -1;
  const index = found >= 0 ? found : (captures?.length ?? 0) - 1;
  const current = index >= 0 ? captures?.[index] : undefined;

  // The card: the screen's width at the shape of the camera's frames, under the status bar, with
  // the tray's margin between it and the tray, unless that leaves it too tall, when it narrows
  // rather than crops. It waits for the tray's height, so it appears at its size, once.
  const roomBelow = trayHeight > 0 ? trayHeight + TRAY_MARGIN * 2 : 0;
  const cardHeight = Math.max(
    Math.min(screen.width / ASPECT, screen.height - insets.top - roomBelow),
    MIN_CARD_HEIGHT,
  );
  const cardWidth = Math.min(cardHeight * ASPECT, screen.width);
  const frame = { top: insets.top, left: (screen.width - cardWidth) / 2, width: cardWidth, height: cardHeight };

  useEffect(() => {
    if (index < 0 || (resting.current?.index === index && resting.current.width === cardWidth)) return;
    resting.current = { index, width: cardWidth };
    list.current?.scrollToOffset({ offset: index * cardWidth, animated: false });
  }, [index, cardWidth]);

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
              select(neighbor?.captureId);
              setCaptures((list) => list?.filter((c) => c.captureId !== capture.captureId) ?? null);
            } catch (e) {
              setError(message(e));
            }
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
    <>
      {trayHeight > 0 && (
        <Animated.View entering={APPEAR} exiting={VANISH} layout={SWAP} style={[styles.card, frame]}>
          {captures && captures.length > 0 && (
            <FlatList
              ref={list}
              data={captures}
              keyExtractor={(capture) => capture.captureId}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={index}
              getItemLayout={(_, i) => ({ length: cardWidth, offset: cardWidth * i, index: i })}
              windowSize={3}
              extraData={`${current?.captureId}|${loadedUri}`}
              onMomentumScrollEnd={(event) => {
                const i = Math.round(event.nativeEvent.contentOffset.x / cardWidth);
                const capture = captures[i];
                resting.current = { index: i, width: cardWidth };
                if (capture && capture.captureId !== current?.captureId) select(capture.captureId);
              }}
              renderItem={({ item }) => (
                <Page
                  capture={item}
                  style={{ width: cardWidth, height: cardHeight }}
                  player={item === current && item.videoUri && item.videoUri === loadedUri ? player : null}
                  onPress={item.videoUri ? () => togglePlaying(player) : undefined}
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
        </Animated.View>
      )}

      <BottomTray
        label="Gallery"
        // The card above it is part of the gallery too.
        modal={false}
        onClose={onClose}
        onLayout={(event) => setTrayHeight(event.nativeEvent.layout.height)}>
        <View style={styles.controls}>
          <View style={styles.header}>
            <View style={styles.title}>
              {date ? (
                <>
                  <Text style={styles.titleDay} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                    {describeDay(date)}
                  </Text>
                  <Text style={styles.titleTime}>{describeTime(date)}</Text>
                </>
              ) : (
                captures?.length === 0 && <Text style={styles.titleDay}>No captures</Text>
              )}
            </View>
            <View style={styles.actions}>
              {current && (
                <>
                  <IconButton icon="square.and.arrow.up" label="Share the capture" onPress={() => share(current)} />
                  <IconButton
                    icon="info.circle"
                    label="Info"
                    onPress={() => router.push({ pathname: '/capture-info', params: { id: current.captureId } })}
                  />
                  <IconButton icon="trash" label="Delete" onPress={() => confirmDelete(current)} />
                </>
              )}
              <IconButton icon="square.grid.2x2" label="All captures" onPress={() => router.push('/all-captures')} />
            </View>
          </View>

          {error && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={error}
              accessibilityHint="Dismisses it"
              onPress={() => setError(null)}>
              <Text style={styles.errorText}>{error}</Text>
            </Pressable>
          )}

          {current && (
            // Its splat: sent to the Mac as soon as it was recorded (or from here, if that never happened), with pause and cancel.
            <SplatStatus key={`splat-${current.captureId}`} capture={current} serverUrl={splat.serverUrl} autoStart onDark />
          )}

          {current?.videoUri && (
            <PlaybackBar key={current.captureId} player={player} fallbackDuration={current.durationSeconds} />
          )}
        </View>
      </BottomTray>
    </>
  );
}

/**
 * One capture, as large as fits. Its first frame stands in until `player` (only set for the page
 * on screen, once it holds this capture's video) draws over it. A tap plays or pauses it.
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
  onPress?: () => void;
}) {
  const date = new Date(capture.savedAt);
  return (
    <Pressable
      accessibilityRole={onPress ? 'imagebutton' : 'image'}
      accessibilityLabel={`Capture, ${describeDay(date)} ${describeTime(date)}`}
      accessibilityHint={onPress ? 'Plays or pauses it' : undefined}
      disabled={!onPress}
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
        // Taps go to the page, to play or pause.
        <View style={[StyleSheet.absoluteFill, styles.inert]}>
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
        </View>
      )}
    </Pressable>
  );
}

/** Play/pause and a scrubber for the video on screen, in a dark capsule on the tray's glass. */
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

  const progress = scrub?.fraction ?? (duration > 0 ? Math.min(time / duration, 1) : 0);

  return (
    <View style={styles.playback}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        onPress={() => togglePlaying(player)}
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

/** Pauses, or plays: from the start again once it has played to the end. */
function togglePlaying(player: VideoPlayer) {
  if (player.playing) {
    player.pause();
    return;
  }
  const { duration } = player;
  if (duration > 0 && player.currentTime >= duration - 0.1) seek(player, 0);
  player.play();
}

/** A plain white symbol, as the Camera app's tray draws its controls. */
function IconButton({ icon, label, onPress }: { icon: SFSymbol; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={Spacing.one}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
      <SymbolView name={icon} size={ICON_GLYPH} weight="medium" tintColor="#fff" />
    </Pressable>
  );
}

/** The shape of the camera's frames (ARKit's world tracking, upright), which is all that records. */
const ASPECT = 3 / 4;
/** However tall the tray, the card keeps this much: the tray overlaps it rather than squash it. */
const MIN_CARD_HEIGHT = 160;
/** The card's corners, like the camera's. */
const CARD_RADIUS = 24;
const ROUND_SIZE = 48;
const ICON_SIZE = 40;
const ICON_GLYPH = 20;
const KNOB_SIZE = 14;
// Eased like the camera's card, not sprung.
const SWAP = LinearTransition.duration(260).easing(Easing.out(Easing.cubic));
const APPEAR = FadeIn.duration(200);
const VANISH = FadeOut.duration(200);

const styles = StyleSheet.create({
  /** Where the camera's card was, edge to edge with its rounded corners. */
  card: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: CARD_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: '#000',
  },
  controls: {
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: ICON_SIZE,
  },
  title: {
    flex: 1,
  },
  titleDay: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 600,
  },
  titleTime: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontWeight: 500,
  },
  /** The last symbol lines up with the text's edge, not its button's. */
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginRight: -(ICON_SIZE - ICON_GLYPH) / 2,
  },
  iconButton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Dark on the tray's glass, like the remote's joystick. */
  playback: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROUND_SIZE,
    paddingRight: Spacing.three,
    borderRadius: ROUND_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.3)',
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
  empty: {
    ...StyleSheet.absoluteFill,
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
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  errorText: {
    color: '#ffb4a8',
    fontSize: 14,
    lineHeight: 20,
  },
  inert: {
    pointerEvents: 'none',
  },
  pressed: {
    opacity: 0.6,
  },
});
