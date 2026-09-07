/**
 * Configuration, read once and validated once.
 *
 * The Firebase web config is not a secret — it ships in every client of every
 * Firebase app on the web, and it is the *security rules* that keep data safe,
 * not the config. It still lives in `.env` rather than in source, so that
 * pointing a fork at a different project is a deploy-time change.
 */
export interface FirebaseSettings {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
  readonly storageBucket: string | undefined;
  readonly messagingSenderId: string | undefined;
}

/**
 * STUN servers for the WebRTC handshake. These only help the two browsers
 * discover their public addresses; no game traffic passes through them.
 *
 * On a network that blocks peer-to-peer entirely (some corporate and mobile
 * carrier NATs), a relay — a TURN server — is the only way through. Set
 * `VITE_TURN_URL`, `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL` if you
 * have one; without it those players simply cannot connect, and the lobby
 * says so rather than hanging.
 */
export interface IceSettings {
  readonly stunUrls: readonly string[];
  readonly turn: { url: string; username: string; credential: string } | null;
}

/**
 * `import.meta.env` is typed loosely, so it is narrowed once here rather than
 * letting `any` leak into the settings.
 */
const environment = import.meta.env as unknown as Readonly<Record<string, unknown>>;

const read = (key: string): string | undefined => {
  const value = environment[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

function readFirebase(): FirebaseSettings | null {
  const apiKey = read('VITE_FIREBASE_API_KEY');
  const authDomain = read('VITE_FIREBASE_AUTH_DOMAIN');
  const projectId = read('VITE_FIREBASE_PROJECT_ID');
  const appId = read('VITE_FIREBASE_APP_ID');

  // All four or none. A half-filled config produces failures at sign-in time
  // that are far harder to diagnose than "Firebase is not configured".
  if (!apiKey || !authDomain || !projectId || !appId) return null;

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: read('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: read('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  };
}

function readIce(): IceSettings {
  const turnUrl = read('VITE_TURN_URL');
  const username = read('VITE_TURN_USERNAME');
  const credential = read('VITE_TURN_CREDENTIAL');
  return {
    stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    turn: turnUrl && username && credential ? { url: turnUrl, username, credential } : null,
  };
}

export const firebaseSettings: FirebaseSettings | null = readFirebase();

/**
 * Whether Firebase Auth is configured on a different origin to the app.
 *
 * This is worth its own exported fact because of how badly it fails and how
 * invisible the cause is. The sign-in flow needs to hand a credential from the
 * `authDomain` back to the app, and it does that through storage on the
 * authDomain's origin. Safari and iOS — and Chrome with third-party cookies
 * off — partition that storage, so when the two origins differ the credential
 * never arrives: Google accepts the login, the visitor comes back, and the app
 * still thinks nobody is signed in.
 *
 * It works fine on desktop Chrome, which is what makes it so easy to ship.
 */
export function authDomainIsCrossOrigin(): boolean {
  if (!firebaseSettings || typeof window === 'undefined') return false;
  // The host, not the origin: authDomain carries no scheme.
  return firebaseSettings.authDomain.toLowerCase() !== window.location.host.toLowerCase();
}
export const iceSettings: IceSettings = readIce();

/**
 * With no Firebase project configured the store still runs: it signs you in as
 * a local guest and solo play works in full. Only
 * invite links need a real project, because they need somewhere for two
 * browsers to find each other.
 */
export const isCloudConfigured = firebaseSettings !== null;

/** Which settings are missing, for the banner on the sign-in screen. */
export function missingCloudSettings(): readonly string[] {
  const required = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_APP_ID',
  ];
  return required.filter((key) => read(key) === undefined);
}

export const isDevBuild = import.meta.env.DEV;
