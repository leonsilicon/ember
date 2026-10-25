import { Geist, Geist_Mono } from 'next/font/google';
import Script from 'next/script';

import { AccountProvider } from '#rover/ui/account.tsx';
import { currentLogin } from '#web/auth.ts';

import './rover.css';

export const metadata = { icons: '/favicon.svg' };

const sans = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

// Runs before paint so a saved light/dark choice never flashes the other theme (rover/ui/theme.ts).
const THEME_SCRIPT = `try{var t=localStorage.getItem('ember.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

/**
 * The signed-in pages' root layout (rover control, the autopilot simulator, the wildfire map, Live 3D
 * and the splat viewer): full-height and styled with Tailwind on the Ember tokens in rover.css. It's a
 * root layout of its own, beside the landing page's (`../(splat)/layout.tsx`), so Tailwind's base
 * styles never reach that page. The top bar's account control (rover/ui/Shell.tsx) gets who's signed
 * in from here.
 */
export default async function RoverLayout({ children }: { children: React.ReactNode }) {
  const who = await currentLogin();
  return (
    <html lang="en" className={`h-full ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="h-full">
        <Script id="ember-theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        {/*
          THESIS: Ember as a field instrument. The rover's state is the loudest thing on screen; panels are modules on one enclosure, separated by gaps the way the logo's flame is cut by its firebreak. Refuses the dark neon ops-console and the card-grid admin page.
          OWN-WORLD: warm light-grey enclosure, off-white module faces, ink #1C1917, ember #E8501F reserved for live state and the one primary action; square LEDs, segmented meters, tabular mono for measurements only; Geist UI, Helvetica wide-tracked wordmark. Dark mode inverts the enclosure.
          STORY: a stranger sees what the rover is doing in one glance; the team drives, tunes and captures without the mouse.
          FIRST VIEWPORT: top bar (mark, nav, live status); the stage (3D yard or splat) fills the screen with a status readout top-left and transport bottom; a resizable module rail on the right whose modules collapse or dock to an edge tab rail.
          FORM: field instrument, candidate 3 of 7; seed e116cec7.
          FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
        */}
        <AccountProvider who={who}>{children}</AccountProvider>
      </body>
    </html>
  );
}
