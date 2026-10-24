/**
 * Steadies the leaf detector's boxes from one frame to the next.
 *
 * OWL-ViT scores every frame on its own, and through the phone's camera a leaf scores only a few
 * percent, right around the threshold. Drawn straight from each frame, a box blinks on and off as
 * the score crosses the threshold, jumps about by a few pixels, and swaps between synonymous labels
 * ("dead leaf", "dry leaf"). So the frames' detections are matched to the boxes already being
 * tracked, and a box
 *
 * - shows only once it has been seen in a couple of frames (a one-frame false positive never shows),
 *   or at once when the score is strong;
 * - keeps showing through a few hundred milliseconds without a sighting, and is kept alive by
 *   sightings weaker than it took to show it (hysteresis);
 * - moves by a smoothed amount, not to wherever the latest frame put it;
 * - keeps its label until another has clearly won.
 *
 * Boxes are tracked as fractions of the whole camera frame, so the pinch zoom (which crops what the
 * detector sees) doesn't break a track. Pure TypeScript, unit-tested in tests/.
 */

export type Box = { xmin: number; ymin: number; xmax: number; ymax: number };
export type Size = { width: number; height: number };

/** One of a frame's detections, in the frame's pixels. */
export type Candidate = { box: Box; label: string; confidence: number };

/** A tracked box, in the frame's pixels. */
export type TrackedDetection = {
  /** The same for as long as the box is tracked, so the overlay keeps the same view for it. */
  id: number;
  box: Box;
  /** The label this box has been seen as, lately; it doesn't swap between synonyms. */
  label: string;
  /** The detector's score, smoothed over recent frames. */
  confidence: number;
  /** The detector didn't see it in this frame: the box is where it was last seen. */
  coasting: boolean;
};

export type TrackerOptions = {
  /** A detection at or above this counts as a sighting (and is what the detector is run with). */
  keepScore: number;
  /** A box shows once its smoothed score reaches this… */
  showScore: number;
  /** …after this many sightings, or straight away at `strongScore`. */
  confirmHits: number;
  strongScore: number;
  /** How long a box is kept without a sighting (a shown box coasts through it). */
  coastMs: number;
  /** A sighting is of a tracked box when they overlap this much (IoU)… */
  matchIou: number;
  /** …or their centres are within this fraction of their mean diagonal and they are alike in size. */
  matchCentre: number;
  /** How far a sighting moves the box towards itself, and the score towards its own (0–1). */
  boxWeight: number;
  scoreWeight: number;
  /** How much of a label's vote is left after a frame. */
  labelDecay: number;
  /** Another label takes over once its vote is this many times the current label's. */
  labelSwitch: number;
  maxTracks: number;
};

/** Defaults around the detector's own threshold, which stays what it takes for a box to show. */
export function trackerOptions(showScore: number): TrackerOptions {
  return {
    showScore,
    keepScore: showScore * 0.6,
    strongScore: showScore * 2,
    confirmHits: 2,
    coastMs: 400,
    matchIou: 0.3,
    matchCentre: 0.5,
    boxWeight: 0.5,
    scoreWeight: 0.4,
    labelDecay: 0.7,
    labelSwitch: 1.5,
    maxTracks: 48,
  };
}

type Track = {
  id: number;
  /** Fractions of the frame. */
  box: Box;
  score: number;
  hits: number;
  lastSeenMs: number;
  shown: boolean;
  label: string;
  votes: Map<string, number>;
};

const area = (b: Box) => Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
const diagonal = (b: Box) => Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin);

export function iou(a: Box, b: Box) {
  const overlap = area({
    xmin: Math.max(a.xmin, b.xmin),
    ymin: Math.max(a.ymin, b.ymin),
    xmax: Math.min(a.xmax, b.xmax),
    ymax: Math.min(a.ymax, b.ymax),
  });
  const union = area(a) + area(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * How well a sighting fits a tracked box: above 1 when they overlap enough, in (0.5, 1] when only
 * their centres are close, 0 when it isn't the same box. Overlap always beats closeness.
 */
function fit(sighting: Box, tracked: Box, options: TrackerOptions) {
  const overlap = iou(sighting, tracked);
  if (overlap >= options.matchIou) return 1 + overlap;
  // A small leaf inside a big pile's box isn't the pile, however central it is.
  const ds = diagonal(sighting);
  const dt = diagonal(tracked);
  if (Math.max(ds, dt) > 2 * Math.min(ds, dt)) return 0;
  const dx = (sighting.xmin + sighting.xmax - tracked.xmin - tracked.xmax) / 2;
  const dy = (sighting.ymin + sighting.ymax - tracked.ymin - tracked.ymax) / 2;
  const distance = Math.hypot(dx, dy) / ((ds + dt) / 2);
  return distance <= options.matchCentre ? 1 - distance : 0;
}

export class DetectionTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(readonly options: TrackerOptions) {}

  /**
   * Takes one frame's detections (in the frame's pixels, `frameSize` being the whole camera frame
   * they're in) and returns the boxes to show, oldest first.
   */
  update(candidates: readonly Candidate[], frameSize: Size, nowMs: number): TrackedDetection[] {
    const { options } = this;
    const sightings: Candidate[] = candidates
      .filter((c) => c.confidence >= options.keepScore)
      .map((c) => ({
        ...c,
        box: {
          xmin: c.box.xmin / frameSize.width,
          ymin: c.box.ymin / frameSize.height,
          xmax: c.box.xmax / frameSize.width,
          ymax: c.box.ymax / frameSize.height,
        },
      }))
      .filter((c) => area(c.box) > 0)
      // Strongest first, so a strong sighting isn't left with a worse box because a weak one took its.
      .sort((a, b) => b.confidence - a.confidence);

    const taken = new Set<Track>();
    for (const sighting of sightings) {
      let best: Track | undefined;
      let bestFit = 0;
      for (const track of this.tracks) {
        if (taken.has(track)) continue;
        const f = fit(sighting.box, track.box, options);
        if (f > bestFit) {
          best = track;
          bestFit = f;
        }
      }
      if (best) {
        taken.add(best);
        this.sight(best, sighting, nowMs);
      } else {
        this.tracks.push(this.start(sighting, nowMs));
      }
    }

    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeenMs <= options.coastMs);
    if (this.tracks.length > options.maxTracks) {
      // Keep what's shown, then the strongest.
      this.tracks.sort((a, b) => Number(b.shown) - Number(a.shown) || b.score - a.score);
      this.tracks.length = options.maxTracks;
      this.tracks.sort((a, b) => a.id - b.id);
    }

    const shown: TrackedDetection[] = [];
    for (const track of this.tracks) {
      if (!track.shown) {
        track.shown =
          track.score >= options.strongScore ||
          (track.hits >= options.confirmHits && track.score >= options.showScore);
      }
      if (!track.shown) continue;
      shown.push({
        id: track.id,
        label: track.label,
        confidence: track.score,
        coasting: track.lastSeenMs !== nowMs,
        box: {
          xmin: track.box.xmin * frameSize.width,
          ymin: track.box.ymin * frameSize.height,
          xmax: track.box.xmax * frameSize.width,
          ymax: track.box.ymax * frameSize.height,
        },
      });
    }
    return shown;
  }

  /** Forgets every box, e.g. when the camera flips. */
  reset() {
    this.tracks = [];
  }

  private start(sighting: Candidate, nowMs: number): Track {
    return {
      id: this.nextId++,
      box: { ...sighting.box },
      score: sighting.confidence,
      hits: 1,
      lastSeenMs: nowMs,
      shown: false,
      label: sighting.label,
      votes: new Map([[sighting.label, sighting.confidence]]),
    };
  }

  private sight(track: Track, sighting: Candidate, nowMs: number) {
    const { boxWeight, scoreWeight, labelDecay, labelSwitch } = this.options;
    const b = track.box;
    const s = sighting.box;
    track.box = {
      xmin: b.xmin + (s.xmin - b.xmin) * boxWeight,
      ymin: b.ymin + (s.ymin - b.ymin) * boxWeight,
      xmax: b.xmax + (s.xmax - b.xmax) * boxWeight,
      ymax: b.ymax + (s.ymax - b.ymax) * boxWeight,
    };
    track.score += (sighting.confidence - track.score) * scoreWeight;
    track.hits += 1;
    track.lastSeenMs = nowMs;

    for (const [label, vote] of track.votes) track.votes.set(label, vote * labelDecay);
    track.votes.set(sighting.label, (track.votes.get(sighting.label) ?? 0) + sighting.confidence);
    // Synonymous labels trade places from frame to frame; only a label that keeps winning takes over.
    let top = track.label;
    for (const [label, vote] of track.votes) {
      if (vote > (track.votes.get(top) ?? 0)) top = label;
    }
    if (top !== track.label && (track.votes.get(top) ?? 0) >= (track.votes.get(track.label) ?? 0) * labelSwitch) {
      track.label = top;
    }
  }
}
