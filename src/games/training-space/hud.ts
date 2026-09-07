import { ACTIONS, SAMPLES_WANTED, type ActionName, type ActionSpec } from '@domain/motion/actions.ts';
import type { TakeState } from '@domain/motion/recorder.ts';
import { button, el } from '@ui/dom.ts';

/**
 * Everything around the two views: the recorder, the counts, the live
 * recognition readout and the dataset controls.
 *
 * DOM rather than drawn into a canvas, because this half of the room is
 * information — it should be selectable, readable by a screen reader, and
 * sharp at any pixel ratio.
 */
export interface HudHandlers {
  readonly onStartCamera: () => void;
  readonly onRecord: (action: ActionSpec) => void;
  readonly onCancelTake: () => void;
  readonly onForget: (action: ActionName) => void;
  readonly onUndo: () => void;
  readonly onExport: () => void;
  readonly onImport: (file: File) => void;
  readonly onClear: () => void;
  readonly onExit: () => void;
}

export class TrainingHud {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;

  private readonly cameraSlot: HTMLElement;
  private readonly gate: HTMLElement;
  private readonly gateStatus: HTMLElement;
  private readonly status: HTMLElement;
  private readonly takeLine: HTMLElement;
  private readonly takeBar: HTMLElement;
  private readonly bigCount: HTMLElement;
  private readonly verdictName: HTMLElement;
  private readonly verdictBar: HTMLElement;
  private readonly verdictNote: HTMLElement;
  private readonly actionList: HTMLElement;
  private readonly totalLine: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly takeEl: HTMLElement;
  private readonly chips = new Map<ActionName, { row: HTMLElement; count: HTMLElement }>();

  constructor(mount: HTMLElement, handlers: HudHandlers) {
    this.canvas = el('canvas', { className: 'ts__canvas' });
    this.overlay = el('canvas', { className: 'ts__overlay' });
    this.cameraSlot = el('div', { className: 'ts__camera' }, [this.overlay]);

    const stage = el('div', { className: 'ts__stage' }, [
      el('section', { className: 'ts__view' }, [
        this.canvas,
        el('div', { className: 'ts__view-label' }, [
          el('b', { text: 'Your fighter' }),
          el('span', { text: 'the game character, driven by your body · drag to orbit' }),
        ]),
      ]),
      el('section', { className: 'ts__view ts__view--camera' }, [
        this.cameraSlot,
        el('div', { className: 'ts__view-label' }, [
          el('b', { text: 'Holistic landmarker' }),
          el('span', { text: 'pose, hands and face, exactly as the model reports them' }),
        ]),
      ]),
    ]);

    // ---------------------------------------------------------- the rail

    this.status = el('div', { className: 'ts__status', attrs: { role: 'status' } });
    this.bigCount = el('div', { className: 'ts__count' });
    this.takeLine = el('div', { className: 'ts__take-line' });
    this.takeBar = el('i');
    const takeTrack = el('div', { className: 'ts__take-track' }, [this.takeBar]);
    const cancel = button({ label: 'Cancel', tone: 'ghost', onClick: handlers.onCancelTake });
    const take = el('div', { className: 'ts__take' }, [
      this.bigCount,
      this.takeLine,
      takeTrack,
      cancel,
    ]);
    take.hidden = true;

    this.actionList = el('div', { className: 'ts__actions' });
    for (const action of ACTIONS) {
      const count = el('span', { className: 'ts__chip-count', text: '0' });
      const row = el('div', { className: 'ts__chip' }, [
        el('div', { className: 'ts__chip-main' }, [
          el('b', { text: action.label }),
          el('em', { text: action.hint }),
        ]),
        el('div', { className: 'ts__chip-side' }, [
          count,
          button({
            label: 'Record',
            onClick: () => {
              handlers.onRecord(action);
            },
          }),
          button({
            label: 'Clear',
            tone: 'ghost',
            onClick: () => {
              handlers.onForget(action.name);
            },
          }),
        ]),
      ]);
      row.style.setProperty('--chip-accent', action.accent);
      this.chips.set(action.name, { row, count });
      this.actionList.append(row);
    }

    this.verdictName = el('b', { text: 'nothing yet' });
    this.verdictBar = el('i');
    this.verdictNote = el('span', {
      text: 'Record at least two actions and this starts naming what you do.',
    });
    const verdict = el('div', { className: 'ts__verdict' }, [
      el('div', { className: 'ts__verdict-head' }, [
        el('span', { className: 'ts__label', text: 'Recognised now' }),
        this.verdictName,
      ]),
      el('div', { className: 'ts__verdict-track' }, [this.verdictBar]),
      this.verdictNote,
    ]);

    this.totalLine = el('div', { className: 'ts__total' });
    this.fileInput = el('input', {
      className: 'ts__file',
      attrs: { type: 'file', accept: 'application/json,.json' },
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) handlers.onImport(file);
      this.fileInput.value = '';
    });

    const data = el('div', { className: 'ts__data' }, [
      this.totalLine,
      el('div', { className: 'ts__data-row' }, [
        button({ label: 'Export JSON', tone: 'ghost', onClick: handlers.onExport }),
        button({
          label: 'Import',
          tone: 'ghost',
          onClick: () => {
            this.fileInput.click();
          },
        }),
        button({ label: 'Undo last', tone: 'ghost', onClick: handlers.onUndo }),
        button({ label: 'Clear all', tone: 'danger', onClick: handlers.onClear }),
      ]),
      this.fileInput,
    ]);

    const rail = el('div', { className: 'ts__rail' }, [
      el('div', { className: 'ts__rail-head' }, [
        el('h2', { text: 'Training Space' }),
        button({ label: 'Back to the store', tone: 'ghost', onClick: handlers.onExit }),
      ]),
      el('p', {
        className: 'ts__blurb',
        text:
          'Teach the camera your controls. Record each action a few times, and the room learns ' +
          'to name it as you do it. Nothing leaves this machine: a recording is a list of ' +
          'numbers describing the movement, never video.',
      }),
      this.status,
      take,
      verdict,
      el('div', { className: 'ts__label', text: `Actions · aim for ${SAMPLES_WANTED} takes each` }),
      this.actionList,
      data,
    ]);

    // ------------------------------------------------------------- gate

    this.gateStatus = el('div', { className: 'ts__status', attrs: { role: 'status' } });
    this.gate = el('div', { className: 'ts__gate' }, [
      el('div', { className: 'ts__gate-inner' }, [
        el('h2', { text: 'Training Space' }),
        el('p', {
          text:
            'A camera watches you, a landmark model reads your body, and the game character ' +
            'copies it. Record punches, kicks, jumps and guards, and the room learns to tell ' +
            'them apart. Stand about two metres back so your hips and feet are in frame.',
        }),
        el('div', { className: 'ts__gate-actions' }, [
          button({ label: 'Start the camera', onClick: handlers.onStartCamera }),
          button({ label: 'Back to the store', tone: 'ghost', onClick: handlers.onExit }),
        ]),
        this.gateStatus,
      ]),
    ]);

    this.takeEl = take;
    this.root = el('div', { className: 'ts' }, [stage, rail, this.gate]);
    mount.append(this.root);
  }

  /** Slots the live camera feed in behind the landmark overlay. */
  attachCamera(video: HTMLVideoElement): void {
    if (video.parentElement === this.cameraSlot) return;
    video.className = 'ts__video';
    this.cameraSlot.prepend(video);
  }

  hideGate(): void {
    this.gate.hidden = true;
  }

  setGateStatus(text: string): void {
    this.gateStatus.textContent = text;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** The countdown and capture bar, or nothing when no take is running. */
  setTake(state: TakeState, label: string | null): void {
    const running = state.phase === 'counting' || state.phase === 'capturing';
    this.takeEl.hidden = !running;
    if (!running) return;
    if (state.phase === 'counting') {
      this.bigCount.textContent = String(Math.max(1, state.countdown));
      this.takeLine.textContent = `Get ready — ${label ?? ''}`;
      this.takeBar.style.transform = 'scaleX(0)';
    } else {
      this.bigCount.textContent = 'Go';
      this.takeLine.textContent = `Recording ${label ?? ''}`;
      this.takeBar.style.transform = `scaleX(${state.progress})`;
    }
  }

  /** The counts on each action, and which one is being recognised right now. */
  setCounts(counts: Readonly<Record<string, number>>): void {
    let total = 0;
    for (const [name, chip] of this.chips) {
      const count = counts[name] ?? 0;
      total += count;
      chip.count.textContent = String(count);
      chip.row.classList.toggle('is-empty', count === 0);
      chip.row.classList.toggle('is-ready', count >= SAMPLES_WANTED);
    }
    this.totalLine.textContent =
      total === 0
        ? 'No recordings yet.'
        : `${total} recording${total === 1 ? '' : 's'} saved on this device.`;
  }

  setVerdict(action: ActionSpec | null, confidence: number, note: string): void {
    this.verdictName.textContent = action ? action.label : '—';
    this.verdictName.style.color = action ? action.accent : '';
    this.verdictBar.style.transform = `scaleX(${Math.max(0, Math.min(1, confidence))})`;
    this.verdictBar.style.background = action ? action.accent : '';
    this.verdictNote.textContent = note;
    for (const [name, chip] of this.chips) {
      chip.row.classList.toggle('is-live', action?.name === name);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
