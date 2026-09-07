import { GameRegistry } from '@adapters/games/game-registry.adapter.ts';
import { WebAudioAdapter } from '@adapters/audio/web-audio.adapter.ts';
import { StaticGameCatalog } from '@adapters/catalog/static-catalog.adapter.ts';
import { createFirebaseContext } from '@adapters/firebase/firebase-app.ts';
import { FirebaseAuthAdapter } from '@adapters/firebase/firebase-auth.adapter.ts';
import { FirestoreAccessDirectory } from '@adapters/firebase/firestore-access-directory.adapter.ts';
import { FirestoreMatchRepository } from '@adapters/firebase/firestore-match-repository.adapter.ts';
import { FirestoreSignaling } from '@adapters/firebase/firestore-signaling.adapter.ts';
import { LocalGuestAuth, OpenAccessDirectory } from '@adapters/local/local-session.adapter.ts';
import { OfflineMatchRepository } from '@adapters/local/offline-lobby.adapter.ts';
import { registerServiceWorker } from '@adapters/pwa/service-worker.ts';
import { ensureCanonicalOrigin } from '@adapters/firebase/canonical-origin.ts';
import { ConsoleLogger } from '@adapters/platform/console-logger.adapter.ts';
import { SystemClock } from '@adapters/platform/system-clock.adapter.ts';
import { WebShareAdapter } from '@adapters/platform/web-share.adapter.ts';
import { WebRtcPeerLink } from '@adapters/webrtc/webrtc-peer-link.adapter.ts';
import type { AccessDirectoryPort } from '@app/ports/access-directory.port.ts';
import type { AuthPort } from '@app/ports/auth.port.ts';
import type { MatchRepositoryPort } from '@app/ports/match-repository.port.ts';
import type { PeerLinkFactory } from '@app/ports/peer-link.port.ts';
import type { SignalingPort } from '@app/ports/signaling.port.ts';
import { AccessAdminService } from '@app/usecases/access-admin.usecase.ts';
import { LobbyService } from '@app/usecases/lobby.usecase.ts';
import { PairingService } from '@app/usecases/pairing.usecase.ts';
import { SessionService } from '@app/usecases/session.usecase.ts';
import { firebaseSettings, iceSettings, isCloudConfigured, isDevBuild, missingCloudSettings } from '@config/env.ts';
import { App } from '@ui/app.ts';
import '@ui/styles.css';

/**
 * The composition root.
 *
 * This is the only file allowed to know both what an interface is and which
 * class implements it. Everything above it — use cases, domain, UI, games —
 * receives what it needs and could be handed a different implementation
 * without noticing. That is the whole bargain of a hexagonal layout, and it is
 * paid for here, once, in about forty lines.
 *
 * It also decides the app's two shapes: with a Firebase project behind it, and
 * without one. The layers above cannot tell the difference beyond the ports
 * reporting that invite links are unavailable.
 */
function bootstrap(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('index.html is missing its #app element');

  /*
   * Before anything else: be on the origin that sign-in works from.
   *
   * A Firebase project serves the same site on both `project.web.app` and
   * `project.firebaseapp.com`, and Firebase Auth hands credentials back
   * through storage on whichever one is the `authDomain`. Safari and iOS
   * partition that storage by origin, so opening the app on the other domain
   * means Google accepts the login and the app never learns about it.
   *
   * Nothing below this line runs if a move is needed, because the page is
   * already navigating.
   */
  if (firebaseSettings && ensureCanonicalOrigin(firebaseSettings.authDomain)) return;

  // `?debug=1` turns on the full netcode commentary in a production build.
  // Diagnosing a failed connection otherwise means asking someone to install
  // a toolchain, which is not a reasonable thing to ask of a player.
  const verbose = new URL(window.location.href).searchParams.has('debug');
  const logger = new ConsoleLogger(isDevBuild || verbose ? 'debug' : 'warn');
  if (verbose) logger.log('info', 'debug logging is on');
  const clock = new SystemClock();
  const catalog = new StaticGameCatalog();
  const audio = new WebAudioAdapter(logger);
  const share = new WebShareAdapter();

  let auth: AuthPort;
  let directory: AccessDirectoryPort;
  let matches: MatchRepositoryPort;
  let links: PeerLinkFactory;

  if (firebaseSettings) {
    const firebase = createFirebaseContext(firebaseSettings);
    const signaling: SignalingPort = new FirestoreSignaling(firebase.db, logger);

    auth = new FirebaseAuthAdapter(firebase.auth, logger);
    directory = new FirestoreAccessDirectory(firebase.db, logger);
    matches = new FirestoreMatchRepository(firebase.db, logger);
    // A factory rather than an instance: a link is single-use, and a rematch
    // needs a fresh RTCPeerConnection rather than a half-closed one.
    links = () => new WebRtcPeerLink(signaling, iceSettings, logger);
  } else {
    logger.log('warn', 'no Firebase project configured — running in local guest mode');
    auth = new LocalGuestAuth();
    directory = new OpenAccessDirectory();
    matches = new OfflineMatchRepository();
    links = () => {
      throw new Error('online play needs a Firebase project');
    };
  }

  const session = new SessionService(auth, directory, logger);
  const lobby = new LobbyService(matches, catalog, clock, share, logger);
  const pairing = new PairingService(links, lobby, logger);
  const access = new AccessAdminService(directory, logger);

  const app = new App({
    session,
    lobby,
    pairing,
    access,
    share,
    catalog,
    registry: new GameRegistry(logger),
    audio,
    clock,
    logger,
    cloudConfigured: isCloudConfigured,
    missingSettings: missingCloudSettings(),
  });

  app.mount(root);

  // Last, and entirely optional: what makes the arcade installable.
  registerServiceWorker(logger);

  // Release the camera, the audio context and the WebGL context on the way
  // out, rather than leaving it to the browser's goodwill.
  window.addEventListener('pagehide', () => {
    app.dispose();
  });
}

bootstrap();
