import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import type { FirebaseSettings } from '@config/env.ts';

/**
 * One Firebase app, created lazily and exactly once.
 *
 * Everything Firebase-shaped in this codebase goes through here, so there is a
 * single place that knows the SDK exists — and a single place to change if the
 * backing service ever does.
 */
export interface FirebaseContext {
  readonly app: FirebaseApp;
  readonly auth: Auth;
  readonly db: Firestore;
}

let context: FirebaseContext | null = null;

export function createFirebaseContext(settings: FirebaseSettings): FirebaseContext {
  if (context) return context;

  const app = initializeApp({
    apiKey: settings.apiKey,
    authDomain: settings.authDomain,
    projectId: settings.projectId,
    appId: settings.appId,
    ...(settings.storageBucket ? { storageBucket: settings.storageBucket } : {}),
    ...(settings.messagingSenderId ? { messagingSenderId: settings.messagingSenderId } : {}),
  });

  context = { app, auth: getAuth(app), db: getFirestore(app) };
  return context;
}

/** Collection names, in one place so the security rules can be read against it. */
export const COLLECTIONS = {
  /** The owner's allowlist. Document id is the lower-cased email. */
  allowedPlayers: 'allowedPlayers',
  /** One document per room. Document id is the invite code. */
  matches: 'matches',
  /** WebRTC handshake, as a subcollection of a match. */
  signals: 'signals',
} as const;
