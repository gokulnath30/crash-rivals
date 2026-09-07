import { button, el } from '../dom.ts';

/**
 * The front door.
 *
 * One state now, and that is the change worth noting: there used to be a
 * second, "we know exactly who you are, and you're not on the list". The
 * arcade is no longer invitation only — signing in with Google is the whole
 * entry requirement — so there is nobody left to show it to.
 * What is left to keep distinct is "we cannot sign anyone in at all" — no
 * Firebase project configured — from "sign-in failed". Collapsing those into
 * one "access denied" is what makes an app feel broken rather than
 * unconfigured.
 */
export function renderSignIn(props: {
  onSignIn: () => void;
  busy: boolean;
  error: string | null;
  cloudConfigured: boolean;
  missingSettings: readonly string[];
}): HTMLElement {
  const children: HTMLElement[] = [
    el('h1', { className: 'hero__title', text: 'The Arcade' }),
    el('p', {
      className: 'hero__lead',
      text: 'A small shelf of games for you and your friends. Sign in, pick one, send a link.',
    }),
  ];

  if (props.cloudConfigured) {
    children.push(
      button({
        label: props.busy ? 'Opening Google…' : 'Sign in with Google',
        onClick: props.onSignIn,
        disabled: props.busy,
      }),
      el('p', {
        className: 'hero__fine',
        text: 'Any Google account can play. Nothing to be added to, nothing to wait for.',
      }),
    );
  } else {
    children.push(
      el('div', { className: 'notice notice--warn' }, [
        el('strong', { text: 'No Firebase project configured' }),
        el('p', {
          text:
            'Google sign-in and invite links need one. Copy .env.example to .env, fill in the four ' +
            'values from your Firebase console, and reload. Until then you can play as a local guest.',
        }),
        props.missingSettings.length > 0
          ? el('p', { className: 'hero__fine', text: `Missing: ${props.missingSettings.join(', ')}` })
          : el('span'),
      ]),
      button({ label: 'Play as a local guest', onClick: props.onSignIn, disabled: props.busy }),
    );
  }

  if (props.error) {
    children.push(el('p', { className: 'notice notice--error', text: props.error }));
  }

  return el('section', { className: 'hero' }, children);
}
