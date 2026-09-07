# The Arcade

A small game store for browser games you play with friends.
Sign in with Google, pick a game, send a link, and the browsers talk directly
to each other — up to four of them in one room.

Three rooms on the shelf:

- **Ashen Ring** — a side-on 3D fighting game in the classic shape: two
  realistic fighters on a raised stone ring, a cinematic camera that breathes
  with the distance between them, best of three. Walk, run, jump, punch, kick,
  sweep, uppercut and guard on a keyboard, a gamepad or your thumbs; the game
  picks the controls from the device. Fight the machine, share a screen with a
  friend, or send a link and settle it from opposite ends of the country.
  Motion-captured clips are blended over a procedural animator, and each
  fighter's face is rendered live beside their health bar.
- **Crash Rivals** — a four-car drag race down one straight road. Take the
  boost pads, ram the others off it. Race three machines, or fill the grid with
  friends over an invite link; any seat nobody takes is driven by a machine.
- **Training Space** — no game logic at all. A webcam and MediaPipe's holistic
  landmarker read your body; the fighter copies you beside the tracker's own
  skeleton. Record each control a few times and the room learns to name your
  punches, kicks and jumps as you throw them, then exports the dataset.

Online play is one person per browser: a room of friends, each on their own
screen. Ashen Ring can also be played the old way, two people at one keyboard.

---

## Running it

```bash
npm install
npm run dev
```

That works immediately, with no Firebase project: you are signed in as a local
guest, and every game's solo mode plays in full. Invite links need a project,
because separate browsers need somewhere to find each other.

```bash
npm run build      # typecheck, then bundle into dist/
npm run preview    # serve the built bundle
npm test           # no browser needed
npm run lint       # includes the architecture rules below
```

The Training Space needs a camera, and browsers only allow one on `https://`
or `localhost` — that is a browser rule, not a project one. `npm run dev` is
localhost, so it is fine.

---

## Setting up Firebase

Ten minutes, once. This is what turns on Google sign-in and invite links.

**1. Create the project.** In the [Firebase console](https://console.firebase.google.com),
make a project, then add a **Web app** to it. Copy the four values it shows you.

**2. Fill in `.env`.**

```bash
cp .env.example .env
```

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_APP_ID=1:123...:web:abc...
```

These are not secrets — every Firebase web client ships them. What keeps your
data safe is step 4.

**3. Switch on Google sign-in.** Console → **Authentication** → *Sign-in
method* → enable **Google**. Then under *Settings → Authorised domains*, add
the domain you will deploy to. `localhost` is already there.

**4. Create the database and deploy the rules.** Console → **Firestore
Database** → create one (production mode is correct). Then:

```bash
npm install -g firebase-tools
firebase login
cd firebase && firebase deploy --only firestore:rules --project your-project
```

**Do not skip this.** Without the rules in [`firebase/firestore.rules`](firebase/firestore.rules),
your database is either wide open or entirely shut. The rules are commented and
worth reading; they enforce the same access model the UI shows, on the server,
where it counts.

**5. Make yourself an admin.** Optional, and only if you want the admin
screen. The very first entry has to go in by hand, because there is nobody yet
who is allowed to add it. In the console, create a document:

- Collection: `allowedPlayers`
- Document ID: **your email address, lower-cased** — e.g. `you@gmail.com`
- Fields: `email` (string, the same address), `role` (string, `admin`)

Now reload the app, sign in, and **Admins** appears in the header.

### Sign-in and the two domains

Firebase gives the project two hosting domains that serve the same site:

- `games-6b049.web.app`
- `games-6b049.firebaseapp.com`

**Sign-in only works on whichever one is the `authDomain`.** Firebase Auth
hands the credential back through storage belonging to the authDomain, and
Safari, iOS, and Chrome with third-party cookies disabled partition that
storage by origin. Open the app on the *other* domain and Google accepts the
login, returns the visitor, and the app still believes nobody is signed in —
with no error anywhere. It works on desktop Chrome, which is what makes it easy
to ship without noticing.

So the app moves itself: opening it on the non-auth domain redirects to the
authDomain, invite code and all, before anything boots. See
[`canonical-origin.ts`](src/adapters/firebase/canonical-origin.ts). It only
ever moves between the two hosting domains of one project, never off a custom
domain, and never twice.

**To make `web.app` the canonical domain instead**, the app is not enough — you
also have to tell Google. In the
[Google Cloud console](https://console.cloud.google.com/apis/credentials) →
Credentials → the OAuth 2.0 Client ID auto-created for the project → Authorised
redirect URIs, add:

```
https://games-6b049.web.app/__/auth/handler
```

Then set `VITE_FIREBASE_AUTH_DOMAIN=games-6b049.web.app` and redeploy. Without
that first step Google refuses the request with `Error 400:
redirect_uri_mismatch` and sign-in breaks on **every** platform, not just Apple
ones — so change the console first, and the env second.

The other half of the same problem is popups. `signInWithPopup` cannot work in
an installed app on any platform — the popup is a separate browsing context, so
the credential has nowhere to return to — and it is unreliable on iOS even in a
normal tab. [`sign-in-flow.ts`](src/adapters/firebase/sign-in-flow.ts) picks a
redirect for those cases up front, rather than waiting for an error that never
arrives.

### Who can play

Anyone with a Google account. There is no list to be added to and nothing to
wait for: signing in *is* the entry requirement, enforced by `mayPlay()` in
[`firestore.rules`](firebase/firestore.rules) and mirrored by `canPlay` in
[`session.ts`](src/domain/identity/session.ts).

Be clear-eyed about what that means. The arcade is open to anybody on the
internet who finds the URL, and every room they open is a document in your
Firestore project — so the free tier's quota is now a shared resource. It was
invitation-only precisely to avoid that, and `allowedPlayers` still exists,
now recording **admins** rather than players. To go back to a closed arcade,
change those two functions to require a row again; nothing else needs to move.

---

## Playing with friends

One player opens a game and presses **Invite a friend** (or **Invite friends**,
for a game that seats more than two). They get a four-character room code and a
share link. The others open the link, or type the code. Everyone needs to be
signed in.

The lobby lists the seats as they fill. The host starts whenever they like:
Crash Rivals gives any seat nobody took to a machine, so a room of two is still
a four-car race, and Ashen Ring seats exactly two because a ring has two
corners. A room stops admitting people once it is full or once the match has
started — a latecomer would arrive a lap behind.

Each browser opens a **direct WebRTC connection** and the game runs peer to
peer. Firestore is used only to find each other and to swap the handshake, and
the handshake documents are deleted as soon as the links are up. The lobby
shows the round-trip time in the corner during a fight.

A room is a **star, not a mesh**: every guest connects to the host and to
nobody else. That is three connections in a four-player room instead of six, it
matches who needs to talk to whom — seat 0 simulates and the rest send input —
and it means a guest needs one working connection rather than three. Each pair
gets its own handshake documents, named after the guest's seat, so the host's
simultaneous handshakes do not overwrite each other.

Some networks — a few corporate ones, some mobile carriers — block direct
connections entirely. Those players need a relay; set `VITE_TURN_*` in `.env`
with any TURN provider. Without one, the lobby reports a clear failure after 25
seconds rather than hanging.

### Deploying

Any static host works. The build uses relative paths, so a project subpath is
fine.

```bash
npm run build           # -> dist/
firebase deploy --only hosting --project your-project    # or push dist/ anywhere
```

Remember to add the deployed domain to Firebase's authorised domains, or
sign-in will refuse with a message telling you exactly that.

---

## How the code is laid out

A hexagonal architecture — ports and adapters. The rule is that dependencies
point inwards only:

```
        ┌──────────────────────────────────────────────┐
        │  ui/          games/         (drive the app) │
        └───────────────────┬──────────────────────────┘
                            │ calls use cases
        ┌───────────────────▼──────────────────────────┐
        │  application/                                │
        │    usecases/   — session, lobby, pairing     │
        │    ports/      — the interfaces they need    │
        └───────────────────┬──────────────────────────┘
                            │ depends only on
        ┌───────────────────▼──────────────────────────┐
        │  domain/       — rules. no I/O, no libraries │
        │    arena/      brawler, fight, round, AI     │
        │    motion/     features, recorder, classifier│
        │    lobby/      match, invite codes           │
        │    identity/   players, access grants        │
        └──────────────────────────────────────────────┘
                            ▲ implemented by
        ┌───────────────────┴──────────────────────────┐
        │  adapters/     firebase · webrtc · webaudio  │
        │                mediapipe · three · platform  │
        └──────────────────────────────────────────────┘
                            ▲ wired together by
                     src/main.ts  (composition root)
```

| Directory | What lives there | May import |
| --- | --- | --- |
| [`src/domain/`](src/domain/) | The rules. Damage, blocking, rounds, room state, invite codes. Pure functions and plain classes. | nothing |
| [`src/application/`](src/application/) | Use cases, and the [ports](src/application/ports/) they depend on. | `domain` |
| [`src/adapters/`](src/adapters/) | The outside world, one adapter per port. | `domain`, `application` |
| [`src/games/`](src/games/) | Each game, behind a `GameRuntime`. | `domain`, `application` |
| [`src/ui/`](src/ui/) | The store shell and its screens. | `domain`, `application` |
| [`src/main.ts`](src/main.ts) | The only file that picks implementations. | everything |

**The linter enforces this.** [`eslint.config.js`](eslint.config.js) forbids the
domain from importing `three`, `firebase`, adapters or use cases, and forbids
use cases from importing adapters. `npm run lint` fails if a layer reaches the
wrong way, so the diagram cannot quietly stop being true.

### What that buys, concretely

- The whole room lifecycle — codes, collisions, seats, expiry, invite links —
  is tested in [`tests/lobby.test.ts`](tests/lobby.test.ts) against in-memory
  fakes. No emulator, no network, sub-second.
- Ashen Ring's rules are tested without a canvas, a keyboard or a browser
  ([`arena.test.ts`](tests/arena.test.ts)): a whole match is fed time in fixed
  steps and judged by the events it hands back.
- Audio is a port with two implementations: the real
  [`WebAudioAdapter`](src/adapters/audio/web-audio.adapter.ts) and a
  [silent one](src/adapters/audio/silent-audio.adapter.ts) used in tests.
- The app runs with or without Firebase because `main.ts` chooses a different
  set of adapters. Nothing above it knows.

### A few decisions worth knowing about

**Online matches are host-authoritative.** Seat 0 runs the only copy of the
simulation that counts and broadcasts state; the other seats send input and
render what they are told. It costs a guest a little input latency and buys a
match that cannot disagree with itself about who won.

**Two data channels, on purpose.** Fast-changing state goes on an unreliable,
unordered channel with retransmission off — a resent frame arrives after the
frame that superseded it, so resending actively makes things worse. Events that
must not be lost go on a reliable one. See
[`peer-link.port.ts`](src/application/ports/peer-link.port.ts).

**Nothing off the wire is trusted.** Every decoder validates and returns null
rather than throwing, and every number a peer sends is clamped — the far end is
somebody else's browser.

**The sound is synthesised, not sampled.** Every impact, bell and bass note is
built from oscillators and filtered noise in
[`voices.ts`](src/adapters/audio/voices.ts) and mixed through
[`web-audio.adapter.ts`](src/adapters/audio/web-audio.adapter.ts); each game
maps its own events onto the cues. Nothing to download, nothing to license,
works offline. The music is a lookahead step sequencer, because `setInterval`
drifts audibly.

**Time is a dependency.** The fighting rules take `dt` as an argument and the
app asks a `ClockPort` for timestamps, which is why a whole bout is
reproducible in a test. Round transitions are a state machine fed time, in
[`round.ts`](src/domain/arena/round.ts), never a `setTimeout`.

**Crash Rivals is framed, not ported.** It shipped as one self-contained HTML
file, and rewriting it would be a week's work to arrive back at the same game.
`GameRuntime` says "mount something and stop it when asked", and an iframe
honours that as well as a Three.js scene does. The trade-off is that the
store cannot reach into it directly — so a thin bridge relays the store's
WebRTC messages across the frame boundary with `postMessage`, and the game's
own networking is untouched behind the same seam PeerJS used to fill.

That bridge does one thing the framed game cannot: it stamps every incoming
message with the seat it arrived from. A guest's input is meaningless without
knowing whose it is, and the seat is only knowable outside the frame, from
which link delivered it — carrying it in the message body instead would let
any guest claim any seat.

The original file is at
[`public/legacy/crash-rivals.html`](public/legacy/crash-rivals.html). Two
earlier games, Shadowbout (a webcam-driven fighter) and its Training Space,
were removed in September 2026; their sources, along with the pose-tracking
adapters and fighting rules only they used, are archived as a tarball in
[`legacy/`](legacy/) for reference.

### Adding a game

1. Add a `GameDefinition` to [`static-catalog.adapter.ts`](src/adapters/catalog/static-catalog.adapter.ts).
2. Write a module exporting a `GameRuntime`.
3. Add a case to [`game-registry.adapter.ts`](src/adapters/games/game-registry.adapter.ts).

The shelf, the lobby, invite links, the admin list and the audio mixer all
come along for free. Each game is behind a dynamic `import`, so a player who only
wants the racing game never downloads the fighters.

---

## Ashen Ring: how to play

Two fighters on a line. Distance is everything.

The game picks the controls from the device: thumbs on a phone or tablet, a
gamepad whenever one is plugged in, and the keyboard on a computer. All three
can be used at once, and the legend in the corner shows whichever you hold.

| | Keyboard, player 1 | Keyboard, player 2 | Gamepad | Touch |
| --- | --- | --- | --- | --- |
| Walk | `A` `D` | `←` `→` | stick or `◀` `▶` | left thumb |
| Run | tap forward twice, or hold `Shift` | tap forward twice | stick pushed fully | stick pushed fully |
| Jump | `W` | `↑` | `▲` or stick up | stick up |
| Guard | hold `S` | hold `↓` | `▼`, bumpers or triggers | `G` or stick down |
| Punch | `J` | `,` | `X` / `□` | `P` |
| Kick | `K` (in the air: flying kick) | `.` | `A` / `✕` | `K` |
| Sweep | `L` | `/` | `B` / `○` | `S` |
| Uppercut | `U` | `M` | `Y` / `△` | `U` |

The touch diamond and the gamepad's face buttons share one shape: the heavy
punch on top, kick at the bottom, punch on the left, sweep on the right.

### Fighting someone else's browser

Press **Invite a friend** and send the link. Both of you get the same view —
no mirroring, because a fighting game shows both fighters at once — with
`· you` beside your own name and the round trip in the corner.

The match is host-authoritative, the same bargain the racing game makes. Seat
0 runs the only copy of the rules that counts; seat 1 sends the buttons it is
holding and draws what it is told. That costs the guest a round trip of input
latency and buys a match that cannot disagree with itself about who won. Only
the host starts a round, so the two browsers can never be in different rounds;
the guest's **Ready** asks, and the host's press decides.

Two shapes cross the wire, in
[`protocol.ts`](src/games/ashen-ring/netcode/protocol.ts). What goes every
frame is hand-packed binary on the unreliable channel — three bytes of buttons
one way, fifty-seven bytes of fight the other — because a snapshot that has
been superseded is worse than useless: it arrives after the one that replaced
it and drags the fight backwards. What goes rarely but must not be lost — a
hit, a knockdown, a round ending, who you are — is JSON on the reliable
channel. Between snapshots the guest integrates the bodies from the velocities
the snapshot carries, which is motion rather than judgement: it keeps thirty
updates a second from looking like thirty frames a second.

Nothing off the wire is trusted. Every decoder validates and returns null
rather than throwing, a fighter claimed to be a mile outside the ring is put
against the wall, and a peer claiming a nine-thousand-damage jab gets it
clamped. The far end is somebody else's browser.

A punch is quick and short; a kick is slow, long and hits hard. The sweep goes
under a jump, and the uppercut is the one blow that reaches into one; nothing
can be guarded in the air. Guarding cuts a blow to a fifth. Knock them down, or
have more health when sixty seconds run out. Two rounds win. Solo puts you
against VARRA and gives you both key clusters; the second player's keys are
only listened to in the two-player mode.

Each fighter's face is rendered live into the frame beside their health bar,
from a small camera of its own, since the side view only ever shows a profile.

The fight is in [`src/domain/arena/`](src/domain/arena/), tested in
[`arena.test.ts`](tests/arena.test.ts) with no canvas or keyboard.

**Animation is two layers.** Every state (idle, walk, run, jump, guard, punch,
kick, sweep, uppercut, flying kick, hit, knockdown) is authored as joint angles
and curves in [`animator.ts`](src/games/ashen-ring/render/animator.ts) and
driven onto the Mixamo-named skeleton each frame, so a fighter is always fully
posed with nothing downloaded. On top of that, five motion-captured segments in
[`public/animations/`](public/animations/) (idle, guard, punch, kick, jump) are
blended in bone by bone once they load. They were cut from Avaturn's animation
exports and stripped to animation-only files of about 50 kB each; the mapping
from a stance to a clip time is in
[`clip-timing.ts`](src/games/ashen-ring/render/clip-timing.ts), and its one
promise is that a recording never moves a hit: the wind-up is warped so the
clip's contact frame lands exactly when the rules make the blow live. Walk, run,
sweep, uppercut, flying kick, hit and knockdown have no recording and stay
procedural.

---

## Training Space: teaching the camera your controls

Two views of the same moment. On the left, the game's own fighter copying your
body. On the right, MediaPipe's holistic landmarker exactly as its own samples
show it: pose, both hands and the face, with a landmark drawn red when the
model is guessing rather than seeing it.

The loop is: pick an action, press **Record**, perform it once after the
countdown, repeat about eight times. Recognition improves on the very next
frame, because the model is a nearest-neighbour vote over your own takes and
training it is just keeping them. Once two actions have examples, the
**Recognised now** panel names what you are doing and says whether a fight
would act on it.

Why nearest neighbours rather than something with weights to fit: with ten
examples per class it is both the most accurate option available and the only
one that can explain itself — a match is a particular take you performed. The
JSON export is the thing to feed a larger model later.

What a recording actually is: a label and 234 numbers. A window of about 0.7
seconds is resampled to six key frames; each frame is moved to the origin,
divided by the length of your own torso and turned to face front, so where you
stand, how tall you are and which way you have turned cannot change the answer.
No video is stored or sent anywhere, and the dataset stays in this browser
until you export it.

| Piece | Where |
| --- | --- |
| Features, recorder, classifier | [`src/domain/motion/`](src/domain/motion/), tested in [`motion.test.ts`](tests/motion.test.ts) |
| Camera and the landmarker | [`src/adapters/pose/`](src/adapters/pose/) |
| The room | [`src/games/training-space/`](src/games/training-space/) |

The GPU delegate refuses the face model on some machines, so the adapter tries
four configurations and *runs a frame through each* before accepting it —
creating a landmarker that then fails on every inference is a real thing that
happens, and it presents as a camera that simply never tracks.

Nothing here writes to any other game. Wiring a trained model into Ashen Ring
as a camera controller is a separate, deliberate step: the actions it knows are
already named after that game's controls, so the seam is `ActionName` and
nothing more.
