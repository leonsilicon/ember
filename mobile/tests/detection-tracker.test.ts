import { describe, expect, test } from 'bun:test';

import { DetectionTracker, iou, trackerOptions, type Box, type Candidate } from '../src/lib/detection-tracker';

const FRAME = { width: 576, height: 768 };
const SHOW = 0.05;
const options = trackerOptions(SHOW);
/** The detector runs about nine times a second on the phone. */
const FRAME_MS = 110;

const box = (xmin: number, ymin: number, size = 60): Box => ({ xmin, ymin, xmax: xmin + size, ymax: ymin + size });
const leaf = (confidence = 0.06, label = 'dry leaf', at: Box = box(200, 300)): Candidate => ({ box: at, label, confidence });

/** Feeds `frames` to a fresh tracker, one every `FRAME_MS`, and returns what it showed after each. */
function run(frames: readonly (readonly Candidate[])[], tracker = new DetectionTracker(options)) {
  return frames.map((candidates, i) => tracker.update(candidates, FRAME, (i + 1) * FRAME_MS));
}

describe('showing and hiding', () => {
  test('a box seen every other frame stays shown instead of blinking', () => {
    const shown = run([[leaf()], [], [leaf()], [], [leaf()], [], [leaf()], []]);
    // The first frame alone isn't enough to show it; from the second sighting on it never goes away.
    expect(shown[0]).toHaveLength(0);
    for (const frame of shown.slice(2)) expect(frame).toHaveLength(1);
    expect(shown[2][0].coasting).toBe(false);
    expect(shown[3][0].coasting).toBe(true);
    expect(new Set(shown.slice(2).map((f) => f[0].id)).size).toBe(1);
  });

  test('a one-frame detection never shows', () => {
    const shown = run([[leaf()], [], [], [], []]);
    expect(shown.every((frame) => frame.length === 0)).toBe(true);
  });

  test('a strong detection shows at once', () => {
    const shown = run([[leaf(SHOW * 2)]]);
    expect(shown[0]).toHaveLength(1);
  });

  test('sightings too weak to show a box keep a shown one alive', () => {
    const weak = SHOW * 0.7;
    const shown = run([[leaf()], [leaf()], [leaf(weak)], [leaf(weak)], [leaf(weak)], [leaf(weak)]]);
    for (const frame of shown.slice(1)) expect(frame).toHaveLength(1);
    expect(shown[5][0].confidence).toBeLessThan(SHOW);
  });

  test('a detection below the keep score is no sighting, and a shown box leaves after coasting', () => {
    const shown = run([[leaf()], [leaf()], [leaf(SHOW * 0.5)], [], [], [], [], []]);
    expect(shown[1]).toHaveLength(1);
    expect(shown[2][0].coasting).toBe(true);
    // Last seen in the second frame; kept for coastMs after that, then gone.
    const last = 1 + Math.floor(options.coastMs / FRAME_MS);
    expect(shown[last]).toHaveLength(1);
    expect(shown[last][0].coasting).toBe(true);
    expect(shown[last + 1]).toHaveLength(0);
  });

  test('a box that is never confirmed is forgotten and gets a new id when seen again', () => {
    const tracker = new DetectionTracker(options);
    tracker.update([leaf()], FRAME, 0);
    tracker.update([], FRAME, options.coastMs + 1);
    const [later] = run([[leaf()], [leaf()]], tracker).at(-1)!;
    expect(later.id).toBe(2);
  });
});

describe('matching', () => {
  test('a jittering box is one box, and moves by less than it jitters', () => {
    const positions = [200, 215, 200, 215, 200, 215];
    const shown = run(positions.map((x) => [leaf(0.06, 'dry leaf', box(x, 300))]));
    const ids = new Set(shown.slice(1).map((f) => f[0].id));
    expect(ids.size).toBe(1);
    const xs = shown.slice(1).map((f) => f[0].box.xmin);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(200);
    for (const x of xs) expect(x).toBeLessThanOrEqual(215);
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThan(15);
  });

  test('zooming in keeps the track: boxes are matched as fractions of the whole frame', () => {
    const tracker = new DetectionTracker(options);
    const at1 = tracker.update([leaf(0.06, 'dry leaf', box(200, 300, 60))], FRAME, 100);
    expect(at1).toHaveLength(0);
    // At 2× the whole frame is twice as big in the detector's coordinates, and so is the box.
    const at2 = tracker.update(
      [leaf(0.06, 'dry leaf', box(400, 600, 120))],
      { width: FRAME.width * 2, height: FRAME.height * 2 },
      200,
    );
    expect(at2).toHaveLength(1);
    expect(at2[0].box).toEqual(box(400, 600, 120));
  });

  test('two leaves are two boxes, each matched to its own', () => {
    const a = (c = 0.06) => leaf(c, 'dry leaf', box(100, 100));
    const b = (c = 0.06) => leaf(c, 'dead leaf', box(400, 500));
    const shown = run([[a(), b()], [b(), a()], [a(), b()]]);
    expect(shown[2]).toHaveLength(2);
    expect(shown[2].map((d) => d.id).sort()).toEqual(shown[1].map((d) => d.id).sort());
    const byId = new Map(shown[2].map((d) => [d.id, d]));
    expect(byId.get(1)!.box.xmin).toBe(100);
    expect(byId.get(2)!.box.xmin).toBe(400);
  });

  test('a small leaf in the middle of a pile is not the pile', () => {
    const pile = leaf(0.08, 'leaf pile', { xmin: 50, ymin: 100, xmax: 500, ymax: 700 });
    const small = leaf(0.06, 'dry leaf', box(250, 370, 50));
    const shown = run([[pile, small], [pile, small]]);
    expect(shown[1]).toHaveLength(2);
  });

  test('a box that moves a little from frame to frame follows the leaf', () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) => [leaf(0.06, 'dry leaf', box(200 + i * 12, 300))]);
    const shown = run(frames);
    expect(new Set(shown.slice(1).map((f) => f[0].id)).size).toBe(1);
    expect(shown.at(-1)![0].box.xmin).toBeGreaterThan(230);
  });

  test('iou', () => {
    expect(iou(box(0, 0, 10), box(0, 0, 10))).toBe(1);
    expect(iou(box(0, 0, 10), box(5, 0, 10))).toBeCloseTo(1 / 3);
    expect(iou(box(0, 0, 10), box(20, 0, 10))).toBe(0);
  });
});

describe('labels', () => {
  test('synonyms trading places from frame to frame do not change the label', () => {
    const labels = ['dead leaf', 'dry leaf', 'dead leaf', 'dry leaf', 'dead leaf', 'dry leaf'];
    const shown = run(labels.map((label, i) => [leaf(i % 2 ? 0.055 : 0.06, label)]));
    for (const frame of shown.slice(1)) expect(frame[0].label).toBe('dead leaf');
  });

  test('a label that keeps winning takes over', () => {
    const labels = ['dead leaf', 'leaf pile', 'leaf pile', 'leaf pile', 'leaf pile'];
    const shown = run(labels.map((label) => [leaf(0.06, label)]));
    expect(shown[1][0].label).toBe('dead leaf');
    expect(shown.at(-1)![0].label).toBe('leaf pile');
  });
});

describe('limits', () => {
  test('no more than maxTracks boxes are kept, shown ones first', () => {
    const tracker = new DetectionTracker({ ...options, maxTracks: 3 });
    const grid = (n: number, c = 0.06) =>
      Array.from({ length: n }, (_, i) => leaf(c, 'dry leaf', box(10 + (i % 8) * 70, 10 + Math.floor(i / 8) * 70, 50)));
    tracker.update(grid(2), FRAME, 100);
    tracker.update(grid(2), FRAME, 200);
    expect(tracker.update(grid(2), FRAME, 300)).toHaveLength(2);
    const after = tracker.update(grid(10, 0.04), FRAME, 400);
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.id)).toEqual([1, 2]);
  });

  test('reset forgets everything', () => {
    const tracker = new DetectionTracker(options);
    run([[leaf()], [leaf()]], tracker);
    tracker.reset();
    expect(tracker.update([leaf()], FRAME, 1000)).toHaveLength(0);
  });
});
