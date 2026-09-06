# Arcade

Two browser games and a launcher to pick between them. No install, no build step.

Play: https://gokulnath30.github.io/crash-rivals/

```
index.html          the launcher
shadowbout.html     Shadowbout — 3D fighter, webcam pose control
crash/index.html    Crash Rivals — split-screen car battle
```

## Shadowbout

A fighting game with no buttons. MediaPipe Pose reads your body through the webcam
and drives your fighter's skeleton directly, so punches, kicks, guard and dodges are
your own movements.

- **Punch** — snap either arm straight toward the screen
- **Kick** — lift a knee and push the foot forward
- **Block** — bring both hands up beside your head
- **Dodge** — lean and step; your fighter's head really moves

Three modes: solo against an AI, two players tracked by one camera, and a
keyboard mode (J/K/L punch, I kick, Space block, A/D move) for when there's no camera.

Rounds are 60 seconds, best of three. The camera check waits until it can see you
before the bell rings.

## Crash Rivals

A two-player split-screen car battle. Two cars, one straight 2.6 km road. Win by
crossing the finish line first, or by wrecking your rival three times.

Ramming damages both cars, but whoever lands the hit takes far less — so catching
your rival from behind or from the side is how you come out ahead. At 100% damage
the car explodes and respawns further back with a wreck against its name.

## Controls
| | Player 1 | Player 2 |
|---|---|---|
| Accelerate | W | Up arrow |
| Brake / reverse | S | Down arrow |
| Steer left | A | Left arrow |
| Steer right | D | Right arrow |
| Handbrake | Space | Right Shift |

On phones and tablets each half of the screen gets its own touch pad. Both players
share one device.

## Adding a game

Drop its folder next to `index.html`, then add one entry to the `GAMES` list at the
top of the launcher's script:

```js
{
  title: "Name of the game",
  tagline: "One line about what you do in it.",
  href: "folder/index.html",
  accent: "#ff3f6e",
  controls: ["Keyboard", "Touch"],   // these also become the filter chips
  players: "1 player",
  featured: false,                    // true = double-width tile
  status: "ready"                     // "soon" greys it out and disables the link
}
```

## Running locally

```bash
npx serve
```

Open the printed `localhost` address. Shadowbout needs `https://` or `localhost` —
browsers refuse camera access on a plain `file://` page.
