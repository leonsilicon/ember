#!/usr/bin/env bun
/**
 * Renders the app's icons from the Ember mark, the README's flame (assets/ember-mark.svg at the repo root),
 * so that the mark stays the one source of the brand:
 *
 *   assets/images/icon.png                     Expo's icon: Android's and the web's, and iOS's below iOS 26
 *   assets/expo.icon/Assets/ember-flame.png    the flame layer of the iOS 26 Icon Composer icon (icon.json)
 *   assets/images/android-icon-foreground.png  the adaptive icon's foreground, inside its 66% safe circle
 *   assets/images/android-icon-monochrome.png  the same silhouette for Android's themed icons
 *   assets/images/splash-icon.png              the splash screen's image (and the in-app AnimatedSplashOverlay's)
 *   assets/images/favicon.png                  the web favicon
 *
 * `bun run icons` in mobile, or `bun mobile/scripts/ember-icons.ts` from anywhere, then commit the PNGs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = path.join(MOBILE, '..', 'assets', 'ember-mark.svg');
const ASSETS = path.join(MOBILE, 'assets');

/** The off-white that the web's panels are (`--panel` in frontend's rover.css): the icon's and splash's ground. */
const PANEL = '#F8F7F4';

const mark = readFileSync(MARK, 'utf8');
/** The mark's defs (the firebreak mask) and the flame path, to place inside a transformed group. */
const flame = mark.slice(mark.indexOf('<defs>'), mark.lastIndexOf('</svg>'));
const flameColor = /<path[^>]*\sfill="(#[0-9a-fA-F]{6})"/.exec(mark)?.[1] ?? '#E8501F';
/** The flame's box in the mark's 512-unit space: 128–384 across, 64–448 down, centred at (256, 256). */
const FLAME = { width: 256, height: 384, cx: 256, cy: 256 };

type Render = {
  width: number;
  height: number;
  /** The flame's height in pixels; it keeps its 2:3 proportions, centred. */
  flameHeight: number;
  background?: string;
  color?: string;
};

function svg({ width, height, flameHeight, background, color }: Render) {
  const scale = flameHeight / FLAME.height;
  const tx = width / 2 - FLAME.cx * scale;
  const ty = height / 2 - FLAME.cy * scale;
  const body = color ? flame.replaceAll(`fill="${flameColor}"`, `fill="${color}"`) : flame;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : ''}
  <g transform="translate(${tx} ${ty}) scale(${scale})">${body}</g>
</svg>`;
}

async function render(file: string, options: Render) {
  let image = sharp(Buffer.from(svg(options)));
  // The icon must be opaque: iOS rejects an alpha channel in an app icon.
  if (options.background) image = image.flatten({ background: options.background }).removeAlpha();
  const out = path.join(ASSETS, file);
  await image.png().toFile(out);
  console.log(`${path.relative(MOBILE, out)}  ${options.width}×${options.height}`);
}

// The mark's own proportions: the flame three quarters of the canvas tall.
await render('images/icon.png', { width: 1024, height: 1024, flameHeight: 768, background: PANEL });
await render('expo.icon/Assets/ember-flame.png', { width: 1024, height: 1024, flameHeight: 768 });
// Android masks the adaptive icon to a circle 66% of the canvas wide: the flame's tip and base must stay inside it.
await render('images/android-icon-foreground.png', { width: 512, height: 512, flameHeight: 300 });
await render('images/android-icon-monochrome.png', { width: 512, height: 512, flameHeight: 300, color: '#FFFFFF' });
// Square, as the splash shows it in a square of `imageWidth` (120pt, like AnimatedSplashOverlay's box), at 3x.
await render('images/splash-icon.png', { width: 360, height: 360, flameHeight: 360 });
await render('images/favicon.png', { width: 48, height: 48, flameHeight: 36 });
