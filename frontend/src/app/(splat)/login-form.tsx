'use client';

import { useActionState } from 'react';

import { login } from './actions';
import styles from './landing.module.css';

/** Email or username, and the password, checked by the `login` action; `next` is where to go afterwards. */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <label className={styles.field}>
        <span>Email or username</span>
        {/* React resets the form after the action; the key puts the typed login back. */}
        <input
          key={state?.login ?? ''}
          name="login"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          defaultValue={state?.login}
          required
          autoFocus
        />
      </label>
      <label className={styles.field}>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" placeholder="••••" required />
      </label>
      {state?.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className={styles.submit} disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
