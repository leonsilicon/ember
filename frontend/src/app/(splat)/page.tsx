import { redirect } from 'next/navigation';

import { safeNext, signedIn } from '#web/auth.ts';

import styles from './landing.module.css';
import { LoginForm } from './login-form';

export const metadata = {
  title: 'soon2026',
  description: 'An autonomous rover that clears the dry leaves that feed wildfires, with its yard rebuilt live in 3D.',
};

/** The landing page: sign in to reach the dashboard. A browser that already has goes straight there. */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  if (await signedIn()) redirect(next);
  return (
    <main className={styles.page}>
      <section>
        <p className={styles.eyebrow}>soon2026</p>
        <h1 className={styles.title}>A rover that clears the leaves that feed wildfires.</h1>
        <p className={styles.lead}>
          It finds dry leaves and pine needles on the ground and collects them, breaking up the fuel that lets a small
          ignition grow. An iPhone on board scans the yard, and this site rebuilds it in 3D as it drives.
        </p>
        <ul className={styles.features}>
          <li>
            <div>
              <strong>Rover control</strong>
              <span>Drive the rover and run the arm from a laptop, with the phone's view and leaf boxes.</span>
            </div>
          </li>
          <li>
            <div>
              <strong>Live 3D and splat captures</strong>
              <span>Follow a recording as it's reconstructed, then train it into a Gaussian splat.</span>
            </div>
          </li>
          <li>
            <div>
              <strong>Autopilot sim and wildfire map</strong>
              <span>The rover's own brain clearing a virtual yard, and the hazard around real buildings.</span>
            </div>
          </li>
        </ul>
      </section>
      <section className={styles.card} aria-labelledby="sign-in">
        <h2 id="sign-in">Sign in</h2>
        <p className={styles.hint}>The dashboard is for the demo team. There's no sign-up.</p>
        <LoginForm next={next} />
        <p className={styles.fine}>Opened from the app? Its links sign this browser in on their own.</p>
      </section>
    </main>
  );
}
