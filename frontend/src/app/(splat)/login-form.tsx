'use client';

import { useActionState } from 'react';

import { login } from './actions';
import styles from './landing.module.css';

/** A username and the password, checked by the `login` action; `next` is where to go afterwards. */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <label className={styles.field}>
        <span>Username</span>
        {/* React resets the form after the action; the key puts the typed username back. */}
        <input
          key={state?.username ?? ''}
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="leonsilicon"
          defaultValue={state?.username}
          maxLength={32}
          required
          autoFocus
        />
      </label>
      <label className={styles.field}>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" placeholder="••••••••" required />
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
