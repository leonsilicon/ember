import styles from './sign-in.module.css';

/** Shown instead of a page until the browser has the access token (see proxy.ts). */
export function SignIn() {
  return (
    <main className={styles.main}>
      <h1>Splat server</h1>
      <p>Enter the access token (SPLAT_TOKEN) to continue. This browser keeps it after that.</p>
      {/* Submits to this same page with ?token=, which signs the browser in. */}
      <form className={styles.form}>
        <input name="token" type="password" autoComplete="current-password" placeholder="Access token" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
