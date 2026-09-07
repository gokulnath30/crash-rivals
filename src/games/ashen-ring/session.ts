import * as THREE from 'three';
import { MachineMind } from '@domain/arena/ai.ts';
import { IDLE_INTENT, type Intent } from '@domain/arena/brawler.ts';
import type { ArenaEvent, BrawlerIndex } from '@domain/arena/events.ts';
import { Fight } from '@domain/arena/fight.ts';
import { applyFightState, captureFight } from '@domain/arena/snapshot.ts';
import { HOST_SEAT, type SeatIndex } from '@domain/lobby/match.ts';
import { linkToHost, type GameContext, type GameHandle } from '@app/ports/game-runtime.port.ts';
import type { LinkState } from '@app/ports/peer-link.port.ts';
import { button, on } from '@ui/dom.ts';
import { NetFight } from './netcode/net-fight.ts';
import type { NetMessage } from './netcode/protocol.ts';
import { GAMEPAD_LEGEND, GamepadPad, anyGamepadConnected } from './controls/gamepad.ts';
import { MergedInput, isTouchDevice, type InputSource } from './controls/input.ts';
import { ARROW_KEYS, KeyboardPad, PLAYER_ONE_KEYS, describeKeys } from './controls/keyboard.ts';
import { TouchPad } from './controls/touch.ts';
import { ArenaHud } from './hud.ts';
import {
  ROSTER,
  findRoster,
  readSavedPick,
  rivalFor,
  savePick,
  type RosterId,
} from './roster.ts';
import { ArenaSet } from './render/arena.ts';
import { ClipLibrary } from './render/clip-library.ts';
import { FighterAvatar } from './render/fighter-avatar.ts';
import { Impacts } from './render/impacts.ts';
import { ModelLibrary, type LoadProgress } from './render/model-library.ts';
import { Stage } from './render/stage.ts';
import './ashen-ring.css';

/** Longest frame the simulation will accept; a backgrounded tab resumes gently. */
const MAX_FRAME = 0.05;

const COLOURS: readonly [number, number] = [0xff6a2a, 0x58c9ff];
const CSS_COLOURS: readonly [string, string] = ['#ff6a2a', '#58c9ff'];
const GOLD = 0xe8c27a;
const BLOCKED_COLOUR = '#c8d6e6';

type Phase = 'menu' | 'fighting' | 'between';
type Opponent = 'machine' | 'keyboard' | 'online';

/**
 * One playable session of Ashen Ring.
 *
 * The layering: this class owns the loop and the wiring; `Fight` under
 * `@domain/arena` owns what is true; `render/` and `ArenaHud` own how it
 * looks; the pads, the machine and the network own where intents come from.
 * Only this file knows about more than one of those.
 *
 * Online play is host-authoritative, the same bargain the racing game makes.
 * Seat 0 runs the only copy of the rules that counts and broadcasts what it
 * decided; seat 1 sends the buttons it is holding and draws what it is told.
 * It costs the guest a round trip of input latency and buys a match that
 * cannot disagree with itself about who won.
 */
export class AshenRingSession implements GameHandle {
  private readonly fight: Fight;
  private readonly hud: ArenaHud;
  private readonly stage: Stage;
  private readonly set: ArenaSet;
  private readonly impacts: Impacts;
  private readonly models: ModelLibrary;
  /** Motion capture segments, shared by both fighters and loaded once. */
  private readonly clips: ClipLibrary;
  private readonly avatars: [FighterAvatar | null, FighterAvatar | null] = [null, null];
  private readonly chosen: [RosterId, RosterId];

  /** Each player's hands: keyboard, gamepad and touch folded into one. */
  private inputs: [InputSource | null, InputSource | null] = [null, null];
  private touch: TouchPad | null = null;
  private readonly touchDevice = isTouchDevice();
  private machine: MachineMind | null = null;
  private readonly detach: (() => void)[] = [];
  private opponent: Opponent = 'machine';

  /** The connection to the other player, or null offline. */
  private readonly net: NetFight | null;
  /** Which corner this browser is playing. Seat 0 is the left fighter. */
  private readonly self: BrawlerIndex;
  private readonly rival: BrawlerIndex;
  /** Set when the guest has asked to start, so the host can say so. */
  private rivalReady = false;

  private phase: Phase = 'menu';
  private readonly facePoint = new THREE.Vector3();
  private lastFrameAt: number;
  private frameHandle: number | null = null;
  private stopped = false;

  constructor(private readonly context: GameContext) {
    const online = context.online;
    /*
     * A duel, so a room for it holds two and the seat index is also the
     * fighter index. `asFighter` is the one place that assumption is written
     * down: rooms can be four wide, and putting this fight in one of those
     * should fail here rather than quietly aim punches at a fighter that does
     * not exist.
     */
    this.self = asFighter(online ? online.seat : HOST_SEAT);
    this.rival = this.self === 0 ? 1 : 0;

    const names: [string, string] = ['', ''];
    names[this.self] = context.labels.self;
    names[this.rival] = context.labels.opponent;
    this.fight = new Fight(names);

    // Whose corner is whose is worth saying outright, because both players
    // look at the same view rather than a mirrored one.
    this.hud = new ArenaHud(context.mount, {
      left: online && this.self === 0 ? `${names[0]} · you` : names[0],
      right: online && this.self === 1 ? `${names[1]} · you` : names[1],
    });
    this.stage = new Stage(this.hud.canvas);
    this.set = new ArenaSet(this.stage.scene, this.stage.renderer, {
      first: COLOURS[0],
      second: COLOURS[1],
      gold: GOLD,
    });
    this.impacts = new Impacts(this.stage.scene);

    this.models = new ModelLibrary(context.logger);
    this.models.watchProgress((progress) => {
      this.hud.setLoading(describeProgress(progress));
    });
    this.clips = new ClipLibrary(context.logger);

    const mine = readSavedPick();
    this.chosen = [mine, rivalFor(mine).id];
    if (online) {
      // Online, each side wears what it picked; the rival's arrives with its
      // greeting rather than being guessed at.
      this.chosen[this.self] = mine;
      this.chosen[this.rival] = rivalFor(mine).id;
    }

    // A duel has exactly one connection: to the other fighter.
    const link = online ? (linkToHost(online) ?? online.links.get(this.rival) ?? null) : null;
    if (online && link) {
      const net = new NetFight(link, this.self === HOST_SEAT, context.logger);
      this.net = net;
      // Sent immediately: the link is already open by the time a session
      // exists, and the far end needs to know who it is fighting.
      net.send({ t: 'hello', name: context.labels.self, pick: mine });
      this.detach.push(
        net.onMessage((message) => {
          this.receive(message);
        }),
        link.onStateChange((state: LinkState) => {
          if (state === 'closed' || state === 'failed') this.rivalLeft();
        }),
      );
    } else {
      this.net = null;
    }

    // A pad plugged in mid-fight changes what the legend should say.
    this.detach.push(
      on(window, 'gamepadconnected', () => {
        this.refreshLegend();
      }),
      on(window, 'gamepaddisconnected', () => {
        this.refreshLegend();
      }),
    );

    this.lastFrameAt = context.clock.elapsed();
  }

  /** Shows the opening panel with both fighters already on stage behind it. */
  begin(): void {
    this.showMenu();
    // A few dozen kilobytes each; the fighters are procedural until they land.
    this.clips.load();
    void this.dressBoth();
    this.loop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    for (const remove of this.detach.splice(0)) remove();
    this.net?.send({ t: 'bye' });
    this.net?.dispose();
    this.dropInputs();
    this.context.audio.stopMusic(0.4);
    for (const avatar of this.avatars) avatar?.dispose();
    this.models.dispose();
    this.clips.dispose();
    this.impacts.dispose();
    this.set.dispose();
    this.stage.dispose();
    this.hud.dispose();
  }

  // ------------------------------------------------------------------ menus

  private showMenu(): void {
    this.phase = 'menu';
    this.hud.setCinematic(false);
    this.hud.setLegend(0, null);
    this.hud.setLegend(1, null);
    const howToHold = this.touchDevice
      ? 'Turn the device sideways. Left thumb moves, up jumps, down guards; the right thumb has the four limbs.'
      : anyGamepadConnected()
        ? 'Your gamepad is ready: stick to move, up to jump, bumpers to guard, the four face buttons to strike.'
        : 'Double-tap forward to run. A gamepad works too, if you plug one in.';
    const online = this.context.online !== null;
    const actions: HTMLElement[] = online
      ? [
          button({
            label: this.isHost ? 'Start the fight' : 'Ready',
            onClick: () => {
              void this.launch('online');
            },
          }),
        ]
      : [
          button({
            label: `Fight ${this.context.labels.opponent}`,
            onClick: () => {
              void this.launch('machine');
            },
          }),
          button({
            label: this.touchDevice ? 'Two players, two gamepads' : 'Two players, one keyboard',
            tone: 'ghost',
            onClick: () => {
              void this.launch('keyboard');
            },
          }),
        ];
    actions.push(button({ label: 'Back to the store', tone: 'ghost', onClick: this.context.exit }));

    this.hud.showStart({
      body: online
        ? `You are fighting ${this.context.labels.opponent}, best of three. Close the distance, ` +
          'land the punch, follow with the kick. Sweep goes under a jump; the uppercut is what ' +
          `catches one. ${this.isHost ? 'Start when you are both ready.' : 'Press Ready; the host starts the fight.'}`
        : 'Two fighters, one ring of fire, best of three. Close the distance, land the punch, ' +
          'follow with the kick. Sweep goes under a jump; the uppercut is what catches one. ' +
          `Guard cuts a blow to a fifth. ${howToHold}`,
      actions,
      ...(this.rivalReady ? { status: 'Your rival is ready.' } : {}),
    });
    // Online, the picker only ever dresses your own corner; theirs arrives
    // with their greeting.
    this.hud.showRoster(ROSTER, this.chosen[this.self], (id) => {
      this.chosen[this.self] = id;
      if (!online) this.chosen[this.rival] = rivalFor(id).id;
      savePick(id);
      // Swap the models straight away, so the pick is visible behind the panel.
      void this.dressBoth();
      this.net?.send({ t: 'hello', name: this.context.labels.self, pick: id });
    });
  }

  /** True when this browser runs the rules: offline, or seat 0 online. */
  private get isHost(): boolean {
    return this.net === null || this.net.isHost;
  }

  private async launch(opponent: Opponent): Promise<void> {
    // Audio needs a user gesture, and this click is one.
    await this.context.audio.unlock();
    if (this.stopped) return;
    this.opponent = opponent;

    this.dropInputs();
    // Whoever is here holds whatever is to hand: the first gamepad, the
    // keyboard (both clusters when they are alone at it), and thumbs on a
    // touch screen.
    const alone = opponent !== 'keyboard';
    const mine: InputSource[] = [new GamepadPad(0)];
    mine.push(alone ? new KeyboardPad(PLAYER_ONE_KEYS, ARROW_KEYS) : new KeyboardPad(PLAYER_ONE_KEYS));
    if (this.touchDevice) {
      this.touch = new TouchPad(this.hud.root);
      mine.push(this.touch);
    }

    this.inputs = [null, null];
    this.inputs[this.self] = new MergedInput(mine);
    if (opponent === 'keyboard') {
      this.inputs[this.rival] = new MergedInput([new KeyboardPad(ARROW_KEYS), new GamepadPad(1)]);
    }
    this.machine = opponent === 'machine' ? new MachineMind() : null;
    this.refreshLegend();

    this.context.audio.startMusic('fight');
    this.hud.hidePanels();
    this.hud.resetHealth();
    this.phase = 'fighting';

    if (opponent !== 'online') {
      this.present(this.fight.start());
      return;
    }

    // Online, only the host may start a round. A guest that presses first
    // says so and waits; the host starts when it is ready, or immediately if
    // it was already waiting on this.
    if (this.isHost) {
      this.present(this.fight.start());
    } else {
      this.net?.send({ t: 'ready' });
      this.hud.announce('Waiting for the host', 1200);
    }
  }

  private dropInputs(): void {
    for (const input of this.inputs) input?.dispose();
    this.inputs = [null, null];
    // The touch overlay is one of the merged sources, so it is already
    // disposed; only the reference remains.
    this.touch = null;
  }

  /**
   * The key legend in the corners, matching what the player is holding: the
   * touch overlay labels itself, a connected gamepad shows its buttons, and
   * otherwise the keyboard clusters.
   */
  private refreshLegend(): void {
    if (this.phase === 'menu') return;
    if (this.touch) {
      this.hud.setLegend(0, null);
      this.hud.setLegend(1, null);
      return;
    }
    const mine = anyGamepadConnected() ? GAMEPAD_LEGEND : describeKeys(PLAYER_ONE_KEYS);
    this.hud.setLegend(this.self, mine);
    this.hud.setLegend(
      this.rival,
      this.opponent === 'keyboard' ? describeKeys(ARROW_KEYS) : null,
    );
  }

  private async dressBoth(): Promise<void> {
    await Promise.all(([0, 1] as const).map((index) => this.dress(index)));
  }

  /**
   * Puts a fighter in their chosen character. A model that will not download
   * leaves that corner empty and says so; the other still fights.
   */
  private async dress(index: BrawlerIndex): Promise<void> {
    const entry = findRoster(this.chosen[index]);
    const loaded = await this.models.instance(entry);
    // The player may have left, or picked again, while this was downloading.
    if (this.stopped || findRoster(this.chosen[index]).id !== entry.id) return;
    if (!loaded.ok) {
      this.hud.setStartStatus(loaded.error.message);
      return;
    }

    this.avatars[index]?.dispose();
    this.avatars[index] = new FighterAvatar(this.stage.scene, loaded.value, {
      outfit: entry.outfit,
      eyewear: entry.eyewear,
      seed: index * 2.1,
      clips: this.clips,
    });
  }

  // ------------------------------------------------------------------- loop

  private loop(): void {
    const step = (): void => {
      if (this.stopped) return;
      this.frameHandle = requestAnimationFrame(step);
      this.frame();
    };
    this.frameHandle = requestAnimationFrame(step);
  }

  private frame(): void {
    const now = this.context.clock.elapsed();
    const wall = Math.min(MAX_FRAME, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;

    // Hitstop slows the whole fight, so a hit lands with weight.
    const dt = this.fight.scaleFrameTime(wall);
    if (this.isHost) {
      const intents =
        this.phase === 'menu' ? ([IDLE_INTENT, IDLE_INTENT] as const) : this.readIntents(dt);
      const events = this.fight.step(intents, dt);
      this.present(events);
      if (this.net) {
        // The spectacle goes on the reliable channel because losing a
        // knockdown desynchronises the match; where everybody is goes on the
        // unreliable one, because a stale position is worse than none.
        this.net.sendEvents(events);
        this.net.publishState(captureFight(this.fight), wall);
      }
    } else {
      this.followHost(dt, wall);
    }

    for (const index of [0, 1] as const) {
      this.avatars[index]?.sync(this.fight.brawlers[index], dt);
    }
    this.impacts.update(dt);
    this.set.update(dt, now / 1000);
    this.paintHud();

    this.stage.render(wall, {
      midX: this.fight.midpoint,
      gap: this.fight.gap,
      // Timed by the round itself, so the sweep ends exactly on "Fight".
      intro: this.phase === 'menu' ? null : this.fight.round.introProgress,
      fighterX: [this.fight.brawlers[0].x, this.fight.brawlers[1].x],
    });

    // The faces, live, beside the health bars. The side camera only ever
    // shows a profile; this is where the fighters look back at you.
    for (const index of [0, 1] as const) {
      const frame = this.hud.portraitFrame(index);
      const face = frame ? this.avatars[index]?.face(this.facePoint) : null;
      if (frame && face) this.stage.renderPortrait(frame, this.facePoint, face.facing);
    }
  }

  /**
   * What both fighters are trying to do this frame, from whichever source
   * owns each of them: the local pads, the machine, or the wire.
   */
  private readIntents(dt: number): readonly [Intent, Intent] {
    const [a, b] = this.fight.brawlers;
    const intents: [Intent, Intent] = [IDLE_INTENT, IDLE_INTENT];
    intents[this.self] = this.inputs[this.self]?.read() ?? IDLE_INTENT;

    if (this.machine !== null) {
      // The machine always fights from the other corner.
      const [self, foe] = this.self === 0 ? [b, a] : [a, b];
      intents[this.rival] = this.machine.decide(self, foe, dt);
    } else if (this.net !== null) {
      intents[this.rival] = this.net.remoteIntent() ?? IDLE_INTENT;
    } else {
      intents[this.rival] = this.inputs[this.rival]?.read() ?? IDLE_INTENT;
    }
    return intents;
  }

  /**
   * The guest's frame: send what is being held, take whatever the host last
   * said, and carry the bodies along in between.
   *
   * No rules run here at all. Integrating between snapshots is motion, not
   * judgement — it decides nothing, it only stops thirty updates a second
   * from looking like thirty frames a second.
   */
  private followHost(dt: number, wall: number): void {
    const net = this.net;
    if (!net) return;

    if (this.phase !== 'menu') {
      net.publishIntent(this.inputs[this.self]?.read() ?? IDLE_INTENT, wall);
    }

    const state = net.takeState();
    if (state) applyFightState(this.fight, state);

    for (const brawler of this.fight.brawlers) {
      brawler.stanceTime += dt;
      brawler.integrate(dt);
    }
    if (this.fight.round.phase === 'fighting') {
      this.fight.round.timeLeft = Math.max(0, this.fight.round.timeLeft - dt);
    }
  }

  // ------------------------------------------------------------ presentation

  private present(events: readonly ArenaEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'round-start':
          this.hud.setCinematic(true);
          this.hud.announce(event.round === 1 ? 'Round 1' : `Round ${event.round}`, 1300);
          this.context.audio.play('crowd-swell', { intensity: 0.5 });
          break;

        case 'fight-call':
          this.hud.setCinematic(false);
          this.context.audio.play('bell-start');
          break;

        case 'announce':
          if (event.text.startsWith('Round')) break; // handled above, with the sweep
          this.hud.announce(event.text, event.holdMs);
          if (event.text === 'K.O.') this.context.audio.play('knockout', { intensity: 1 });
          break;

        case 'attack':
          this.context.audio.play('whiff', { intensity: 0.25, pan: this.panOf(event.attacker) });
          break;

        case 'hit':
          this.showHit(event);
          break;

        case 'whiff':
          break;

        case 'round-end':
          this.context.audio.play('bell-end');
          this.showResult(event.winner, event.matchOver, event.wins);
          break;
      }
    }
  }

  private showHit(event: Extract<ArenaEvent, { kind: 'hit' }>): void {
    const heavy = event.move === 'kick' || event.move === 'uppercut' || event.move === 'air-kick';
    const point = { x: event.x, y: event.y, z: 0 };
    this.impacts.burst(
      point,
      event.blocked ? 0xa9c4e6 : 0xffc070,
      event.blocked ? 8 : heavy ? 20 : 14,
      event.blocked ? 2 : heavy ? 4.2 : 3.2,
    );
    this.hud.damageNumber(
      this.stage.toScreen(point),
      event.damage,
      event.blocked ? BLOCKED_COLOUR : CSS_COLOURS[event.attacker],
    );
    this.hud.impactFlash(event.blocked);
    this.stage.addShake(event.blocked ? 0.04 : heavy ? 0.2 : 0.11);
    if (!event.blocked) this.avatars[event.defender]?.flare();

    const pan = this.panOf(event.defender);
    if (event.blocked) this.context.audio.play('block', { intensity: 0.6, pan });
    else if (event.move === 'uppercut') this.context.audio.play('punch-heavy', { intensity: 1, pan });
    else if (event.move === 'punch') this.context.audio.play('punch-heavy', { intensity: 0.7, pan });
    else this.context.audio.play('kick', { intensity: event.move === 'sweep' ? 0.6 : 0.9, pan });
    this.context.audio.duck(heavy ? 0.5 : 0.3, 0.25);
  }

  private paintHud(): void {
    const [a, b] = this.fight.brawlers;
    this.hud.setHealth(0, a.healthFraction);
    this.hud.setHealth(1, b.healthFraction);
    this.hud.setClock(this.fight.round.timeLeft);
    this.hud.setWins([this.fight.round.wins[0], this.fight.round.wins[1]]);
    this.hud.setStance(0, stanceWord(a.stance));
    this.hud.setStance(1, stanceWord(b.stance));
    this.hud.setPing(this.net?.latencyMs ?? null);
  }

  /** Where a fighter sits in the stereo field, from where they are on screen. */
  private panOf(index: BrawlerIndex): number {
    return Math.max(-1, Math.min(1, this.fight.brawlers[index].x / 3.4));
  }

  private showResult(
    winner: BrawlerIndex | null,
    matchOver: boolean,
    wins: readonly [number, number],
  ): void {
    this.phase = 'between';
    const [a, b] = this.fight.brawlers;
    // Solo and online are both "one of these is me"; two on one keyboard is
    // not, so it gets told who won by name instead.
    const mine = this.opponent !== 'keyboard';
    const iWon = winner === this.self;
    const title = matchOver
      ? mine
        ? iWon
          ? 'You win'
          : 'You lose'
        : `${(winner === 0 ? a : b).name} wins`
      : `Round ${this.fight.round.round}`;
    const line = matchOver
      ? `Final score ${wins[0]}–${wins[1]}.`
      : winner === null
        ? 'Level on health. That round goes again.'
        : `${(winner === 0 ? a : b).name} takes the round. ${wins[0]}–${wins[1]}.`;

    if (matchOver) this.context.audio.play(iWon || !mine ? 'match-won' : 'match-lost');

    const actions: HTMLElement[] = [];
    if (this.isHost) {
      actions.push(
        button({
          label: matchOver ? 'Fight again' : 'Next round',
          onClick: () => {
            this.advance();
          },
        }),
      );
    } else {
      // The guest can ask, but only the host starts a round — otherwise the
      // two browsers can disagree about which round they are in.
      actions.push(
        button({
          label: matchOver ? 'Ask for a rematch' : 'Ready',
          onClick: () => {
            this.net?.send({ t: 'ready' });
            this.hud.announce('Waiting for the host', 1000);
          },
        }),
      );
    }
    if (this.net === null) {
      actions.push(
        button({
          label: 'Change fighter',
          tone: 'ghost',
          onClick: () => {
            this.fight.start();
            this.fight.round.resetMatch();
            for (const brawler of this.fight.brawlers) brawler.reset();
            this.context.audio.stopMusic(0.4);
            this.showMenu();
          },
        }),
      );
    }
    actions.push(button({ label: 'Leave', tone: 'ghost', onClick: this.context.exit }));

    this.hud.showResult({ title, line, actions });
  }

  private advance(): void {
    this.rivalReady = false;
    this.hud.hidePanels();
    this.hud.resetHealth();
    this.phase = 'fighting';
    const events = this.fight.advance();
    this.present(events);
    this.net?.sendEvents(events);
  }

  // ---------------------------------------------------------------- network

  private receive(message: NetMessage): void {
    switch (message.t) {
      case 'hello': {
        this.context.audio.play('peer-joined');
        const theirs = findRoster(message.pick).id;
        if (theirs !== this.chosen[this.rival]) {
          this.chosen[this.rival] = theirs;
          void this.dress(this.rival);
        }
        break;
      }

      case 'fx':
        // Only the guest takes the host's account of what happened; a host
        // receiving one is a bug or a hostile peer, and either way it is not
        // the truth.
        if (this.isHost) return;
        // The host can start before the guest has pressed anything. Rather
        // than leave them watching a fight from behind a panel, the round
        // starting is itself the cue to join it.
        if (this.phase === 'menu' && message.events.some((e) => e.kind === 'round-start')) {
          void this.launch('online');
        }
        this.present(message.events);
        break;

      case 'ready':
        if (!this.isHost) return;
        this.rivalReady = true;
        // Waiting between rounds, and now both sides want the next one.
        if (this.phase === 'between') this.advance();
        else if (this.phase === 'menu') this.hud.setStartStatus('Your rival is ready.');
        break;

      case 'bye':
        this.rivalLeft();
        break;
    }
  }

  private rivalLeft(): void {
    if (this.stopped) return;
    this.phase = 'between';
    this.context.audio.play('peer-left');
    this.hud.showResult({
      title: 'Rival left',
      line: 'The connection to the other player is gone.',
      actions: [button({ label: 'Back to the store', onClick: this.context.exit })],
    });
  }
}

/**
 * A seat index, checked against being a fighter index.
 *
 * `BrawlerIndex` is `0 | 1` because a ring has two corners, while a room's
 * seat is any number up to four. Ashen Ring declares two seats, so the two
 * always coincide — and this is where that is asserted rather than assumed,
 * so putting the fight in a wider room fails loudly instead of aiming punches
 * at a fighter who does not exist.
 */
function asFighter(seat: SeatIndex): BrawlerIndex {
  if (seat !== 0 && seat !== 1) {
    throw new Error(`Ashen Ring is a duel; seat ${seat} cannot fight in it.`);
  }
  return seat;
}

/** The word under a fighter's name. Blank for the ordinary states. */
function stanceWord(stance: string): string {
  switch (stance) {
    case 'guard':
      return 'guard';
    case 'knockdown':
      return 'down';
    case 'run':
      return 'rush';
    case 'jump':
    case 'air-kick':
      return 'air';
    default:
      return '';
  }
}

/** The corner chip while a model downloads. Null once nothing is pending. */
function describeProgress(progress: LoadProgress): string | null {
  if (progress.done) return null;
  if (progress.fraction !== null) {
    return `Loading ${progress.name}… ${Math.round(progress.fraction * 100)}%`;
  }
  return `Loading ${progress.name}… ${(progress.loadedBytes / 1048576).toFixed(1)} MB`;
}
