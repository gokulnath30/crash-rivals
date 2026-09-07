import { RING } from '@domain/arena/brawler.ts';
import type { BrawlerIndex } from '@domain/arena/events.ts';
import { clear, el } from '@ui/dom.ts';
import type { RosterEntry, RosterId } from './roster.ts';

export interface HudLabels {
  readonly left: string;
  readonly right: string;
}

/**
 * Everything drawn over the 3D view: two health gauges meeting at the clock,
 * round pips, the announcer, the key legend, a cinematic letterbox and the
 * two panels.
 *
 * DOM rather than canvas, because text laid out by the browser is sharp at
 * every pixel ratio, respects the player's font size and can be read aloud.
 */
export class ArenaHud {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  private readonly fills: [HTMLElement, HTMLElement];
  private readonly ghosts: [HTMLElement, HTMLElement];
  private readonly ghostValues: [number, number] = [1, 1];
  private readonly names: [HTMLElement, HTMLElement];
  private readonly stances: [HTMLElement, HTMLElement];
  private readonly pips: [HTMLElement[], HTMLElement[]];
  private readonly clock: HTMLElement;
  private readonly announcer: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly legends: [HTMLElement, HTMLElement];
  private readonly ping: HTMLElement;
  private readonly portraits: [HTMLElement, HTMLElement];
  private readonly loading: HTMLElement;

  private readonly startPanel: HTMLElement;
  private readonly startBody: HTMLElement;
  private readonly chooser: HTMLElement;
  private readonly startActions: HTMLElement;
  private readonly startStatus: HTMLElement;
  private readonly resultPanel: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultLine: HTMLElement;
  private readonly resultActions: HTMLElement;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(mount: HTMLElement, labels: HudLabels) {
    this.canvas = el('canvas', { className: 'ar__canvas' });

    this.fills = [el('i', { className: 'ar__fill' }), el('i', { className: 'ar__fill' })];
    this.ghosts = [el('i', { className: 'ar__ghost' }), el('i', { className: 'ar__ghost' })];
    this.names = [el('b', { text: labels.left }), el('b', { text: labels.right })];
    this.stances = [el('span', { className: 'ar__stance' }), el('span', { className: 'ar__stance' })];
    this.pips = [[], []];
    for (const index of [0, 1] as const) {
      for (let i = 0; i < RING.roundsToWin; i++) {
        this.pips[index].push(el('i', { className: 'ar__pip' }));
      }
    }
    this.clock = el('div', { className: 'ar__clock', text: String(RING.roundSeconds) });
    this.announcer = el('div', { className: 'ar__announce', attrs: { 'aria-live': 'polite' } });
    this.flash = el('div', { className: 'ar__flash' });
    this.legends = [el('div', { className: 'ar__legend' }), el('div', { className: 'ar__legend ar__legend--right' })];
    this.ping = el('div', { className: 'ar__ping' });
    this.loading = el('div', { className: 'ar__loading', attrs: { role: 'status' } });
    this.loading.hidden = true;

    // The portrait frames are transparent windows: the stage renders each
    // fighter's face into the canvas behind them every frame.
    this.portraits = [
      el('div', { className: 'ar__portrait', attrs: { 'aria-hidden': 'true' } }),
      el('div', { className: 'ar__portrait ar__portrait--right', attrs: { 'aria-hidden': 'true' } }),
    ];

    const side = (index: BrawlerIndex): HTMLElement =>
      el('div', { className: index === 0 ? 'ar__side' : 'ar__side ar__side--right' }, [
        el('div', { className: 'ar__tag' }, [this.names[index], this.stances[index]]),
        el('div', { className: 'ar__track' }, [this.ghosts[index], this.fills[index]]),
        el('div', { className: 'ar__pips' }, this.pips[index]),
      ]);

    const bars = el('div', { className: 'ar__bars' }, [
      el('div', { className: 'ar__corner' }, [this.portraits[0], side(0)]),
      el('div', { className: 'ar__clock-wrap' }, [this.clock]),
      el('div', { className: 'ar__corner ar__corner--right' }, [side(1), this.portraits[1]]),
    ]);

    this.startStatus = el('div', { className: 'ar__status', attrs: { role: 'status' } });
    this.startBody = el('p');
    this.startActions = el('div', { className: 'ar__panel-actions' });
    this.chooser = el('div', {
      className: 'ar__chooser',
      attrs: { role: 'radiogroup', 'aria-label': 'Choose your fighter' },
    });
    this.startPanel = el('div', { className: 'ar__panel' }, [
      el('div', { className: 'ar__panel-inner' }, [
        el('div', { className: 'ar__kicker', text: 'The tournament of embers' }),
        el('h2', { text: 'Ashen Ring' }),
        this.startBody,
        this.chooser,
        this.startActions,
        this.startStatus,
      ]),
    ]);

    this.resultTitle = el('h2');
    this.resultLine = el('p');
    this.resultActions = el('div', { className: 'ar__panel-actions' });
    this.resultPanel = el('div', { className: 'ar__panel' }, [
      el('div', { className: 'ar__panel-inner' }, [this.resultTitle, this.resultLine, this.resultActions]),
    ]);
    this.resultPanel.hidden = true;

    this.root = el('div', { className: 'ar' }, [
      this.canvas,
      el('div', { className: 'ar__vignette' }),
      el('div', { className: 'ar__bar ar__bar--top' }),
      el('div', { className: 'ar__bar ar__bar--bottom' }),
      this.flash,
      this.loading,
      el('div', { className: 'ar__hud' }, [
        bars,
        el('div', { className: 'ar__foot' }, [this.legends[0], this.ping, this.legends[1]]),
      ]),
      this.announcer,
      this.startPanel,
      this.resultPanel,
    ]);

    mount.append(this.root);
  }

  // ------------------------------------------------------------ live state

  setHealth(index: BrawlerIndex, fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    this.fills[index].style.transform = `scaleX(${clamped})`;
    // The ghost only ever falls, and slowly, so a hit leaves a trace of what
    // it cost.
    if (this.ghostValues[index] > clamped) {
      this.ghostValues[index] = clamped;
      this.ghosts[index].style.transform = `scaleX(${clamped})`;
    }
    this.fills[index].classList.toggle('is-low', clamped < 0.25);
  }

  resetHealth(): void {
    for (const index of [0, 1] as const) {
      this.ghostValues[index] = 1;
      this.ghosts[index].style.transform = 'scaleX(1)';
      this.fills[index].style.transform = 'scaleX(1)';
    }
  }

  setClock(seconds: number): void {
    const shown = String(Math.ceil(Math.max(0, seconds)));
    if (this.clock.textContent !== shown) this.clock.textContent = shown;
    this.clock.classList.toggle('is-urgent', seconds <= 10);
  }

  setWins(wins: readonly [number, number]): void {
    for (const index of [0, 1] as const) {
      this.pips[index].forEach((pip, i) => {
        pip.classList.toggle('is-won', i < wins[index]);
      });
    }
  }

  /** A short word under the name: "guard", "K.O.", nothing. */
  setStance(index: BrawlerIndex, text: string): void {
    if (this.stances[index].textContent !== text) this.stances[index].textContent = text;
  }

  /**
   * The round trip to the other player, in an online match. Null hides it,
   * which is what an offline fight wants.
   */
  setPing(ms: number | null): void {
    const text = ms === null ? '' : `${Math.round(ms)} ms to your rival`;
    if (this.ping.textContent !== text) this.ping.textContent = text;
  }

  /** The key legend for a corner. Pass null to leave it blank. */
  setLegend(index: BrawlerIndex, entries: readonly (readonly [string, string])[] | null): void {
    const target = this.legends[index];
    clear(target);
    if (!entries) return;
    for (const [keys, action] of entries) {
      target.append(
        el('span', { className: 'ar__key' }, [el('kbd', { text: keys }), el('em', { text: action })]),
      );
    }
  }

  /** The black bars of the opening sweep. */
  setCinematic(on: boolean): void {
    this.root.classList.toggle('is-cinematic', on);
  }

  /**
   * Where a fighter's portrait frame is on screen, or null when the HUD is
   * not showing (the opening sweep, a panel), so nothing is drawn into a
   * window nobody can see.
   */
  portraitFrame(index: BrawlerIndex): DOMRect | null {
    if (this.root.classList.contains('is-cinematic')) return null;
    if (!this.startPanel.hidden || !this.resultPanel.hidden) return null;
    const box = this.portraits[index].getBoundingClientRect();
    return box.width > 0 ? box : null;
  }

  setLoading(text: string | null): void {
    this.loading.textContent = text ?? '';
    this.loading.hidden = text === null;
  }

  // -------------------------------------------------------------- spectacle

  announce(text: string, holdMs = 900): void {
    this.announcer.textContent = text;
    this.announcer.classList.remove('is-shown');
    // Forces a layout flush, so a second announcement restarts the slam.
    void this.announcer.getBoundingClientRect();
    this.announcer.classList.add('is-shown');
    this.after(holdMs + 200, () => {
      this.announcer.classList.remove('is-shown');
    });
  }

  impactFlash(blocked: boolean): void {
    this.flash.style.opacity = blocked ? '0.05' : '0.12';
    this.after(60, () => {
      this.flash.style.opacity = '0';
    });
  }

  damageNumber(at: { x: number; y: number }, amount: number, colour: string): void {
    const node = el('div', { className: 'ar__damage', text: String(amount) });
    node.style.color = colour;
    node.style.left = `${at.x}px`;
    node.style.top = `${at.y}px`;
    document.body.append(node);
    this.after(1000, () => {
      node.remove();
    });
  }

  // ------------------------------------------------------------------ panels

  showStart(input: { body: string; actions: readonly HTMLElement[]; status?: string }): void {
    this.startBody.textContent = input.body;
    clear(this.startActions);
    this.startActions.append(...input.actions);
    this.startStatus.textContent = input.status ?? '';
    this.startPanel.hidden = false;
    this.resultPanel.hidden = true;
  }

  /** The fighter picker: one choice from a set, so radio semantics. */
  showRoster(roster: readonly RosterEntry[], selected: RosterId, onPick: (id: RosterId) => void): void {
    clear(this.chooser);
    this.chooser.append(
      el('div', { className: 'ar__chooser-label', text: 'Your fighter' }),
      el(
        'div',
        { className: 'ar__chooser-row' },
        roster.map((entry) => {
          const chosen = entry.id === selected;
          const card = el(
            'button',
            {
              className: `ar__pick${chosen ? ' is-picked' : ''}`,
              attrs: { type: 'button', role: 'radio', 'aria-checked': String(chosen) },
            },
            [
              el('span', { className: 'ar__pick-name', text: entry.name }),
              el('span', { className: 'ar__pick-blurb', text: entry.blurb }),
            ],
          );
          card.style.setProperty('--pick-accent', entry.accent);
          card.addEventListener('click', () => {
            onPick(entry.id);
            this.showRoster(roster, entry.id, onPick);
          });
          return card;
        }),
      ),
    );
  }

  setStartStatus(text: string): void {
    this.startStatus.textContent = text;
  }

  hidePanels(): void {
    this.startPanel.hidden = true;
    this.resultPanel.hidden = true;
  }

  showResult(input: { title: string; line: string; actions: readonly HTMLElement[] }): void {
    this.resultTitle.textContent = input.title;
    this.resultLine.textContent = input.line;
    clear(this.resultActions);
    this.resultActions.append(...input.actions);
    this.resultPanel.hidden = false;
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const node of document.querySelectorAll('.ar__damage')) node.remove();
    this.root.remove();
  }

  /** A tracked `setTimeout`, so `dispose` can cancel anything still pending. */
  private after(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }
}
