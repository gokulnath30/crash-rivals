import { ACTIONS, findAction, SAMPLES_WANTED, type ActionName, type ActionSpec } from '@domain/motion/actions.ts';
import { ActionGate, GestureClassifier, type Verdict } from '@domain/motion/classifier.ts';
import {
  actionsPresent,
  addSample,
  countsByAction,
  EMPTY_DATASET,
  forgetAction,
  forgetLast,
  type Dataset,
} from '@domain/motion/dataset.ts';
import { PoseWindow } from '@domain/motion/features.ts';
import { isUsable } from '@domain/motion/landmarks.ts';
import { TakeRecorder } from '@domain/motion/recorder.ts';
import type { GameContext, GameHandle } from '@app/ports/game-runtime.port.ts';
import type { PoseSourcePort, PoseStatus } from '@app/ports/pose-source.port.ts';
import { on } from '@ui/dom.ts';
// The same fighter the ring uses, loaded the same way. Imported rather than
// copied so "the character" means one thing across the whole app; nothing in
// Ashen Ring is changed by reading these.
import { findRoster, readSavedPick } from '@games/ashen-ring/roster.ts';
import { ModelLibrary } from '@games/ashen-ring/render/model-library.ts';
import { TrainingHud } from './hud.ts';
import { LandmarkCanvas } from './render/landmark-canvas.ts';
import { PoseRig } from './render/pose-rig.ts';
import { Studio } from './render/studio.ts';
import { downloadDataset, loadDataset, readDatasetFile, saveDataset } from './storage.ts';
import './training-space.css';

/** A tab left in the background resumes with a delta of several seconds. */
const MAX_FRAME = 0.05;

/**
 * The training room.
 *
 * Two views of the same moment: the game's own fighter copying your body, and
 * the landmark model's own picture of you. Around them, a recorder that turns
 * performances into labelled examples, and a classifier that learns from them
 * as you go — so the loop closes in the room rather than in an export.
 *
 * It keeps no score and cannot be won. Nothing here writes to any other game:
 * the dataset it produces is the product, and wiring it into a fight is a
 * separate, deliberate step.
 */
export class TrainingSession implements GameHandle {
  private readonly hud: TrainingHud;
  private readonly studio: Studio;
  private readonly overlay: LandmarkCanvas;
  private readonly models: ModelLibrary;
  private readonly window = new PoseWindow();
  private readonly recorder = new TakeRecorder();
  private readonly gate = new ActionGate();

  private rig: PoseRig | null = null;
  private dataset: Dataset = EMPTY_DATASET;
  private classifier = new GestureClassifier(EMPTY_DATASET);
  private recordingAction: ActionSpec | null = null;
  private tracking = false;
  private lastFrameAt: number;
  private frameHandle: number | null = null;
  private stopped = false;
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly context: GameContext,
    private readonly pose: PoseSourcePort,
  ) {
    this.hud = new TrainingHud(context.mount, {
      onStartCamera: () => {
        void this.startCamera();
      },
      onRecord: (action) => {
        this.beginTake(action);
      },
      onCancelTake: () => {
        this.recorder.cancel();
        this.recordingAction = null;
        this.hud.setStatus('Take cancelled.');
      },
      onForget: (action) => {
        this.useDataset(forgetAction(this.dataset, action));
        this.hud.setStatus(`Cleared every ${findAction(action)?.label ?? action} recording.`);
      },
      onUndo: () => {
        this.useDataset(forgetLast(this.dataset));
        this.hud.setStatus('Removed the last recording.');
      },
      onExport: () => {
        if (this.dataset.samples.length === 0) {
          this.hud.setStatus('Nothing recorded yet, so there is nothing to export.');
          return;
        }
        downloadDataset(this.dataset);
        this.hud.setStatus('Exported. The file holds movement numbers only, no video.');
      },
      onImport: (file) => {
        void this.importFile(file);
      },
      onClear: () => {
        this.useDataset(EMPTY_DATASET);
        this.hud.setStatus('Cleared every recording on this device.');
      },
      onExit: context.exit,
    });

    this.studio = new Studio(this.hud.canvas);
    this.overlay = new LandmarkCanvas(this.hud.overlay);
    this.models = new ModelLibrary(context.logger);
    this.models.watchProgress((progress) => {
      if (progress.done) return;
      const done =
        progress.fraction !== null
          ? `${Math.round(progress.fraction * 100)}%`
          : `${(progress.loadedBytes / 1048576).toFixed(1)} MB`;
      this.hud.setGateStatus(`Loading ${progress.name}… ${done}`);
    });

    this.detach.push(
      this.pose.onStatusChange((status) => {
        this.onPoseStatus(status);
      }),
    );
    this.watchOrbit();

    this.lastFrameAt = context.clock.elapsed();
  }

  begin(): void {
    this.useDataset(loadDataset());
    // The character loads immediately, so there is something to look at and
    // orbit before the camera is ever switched on.
    void this.dress();
    this.loop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    for (const remove of this.detach.splice(0)) remove();
    this.pose.stop();
    this.rig?.dispose();
    this.models.dispose();
    this.studio.dispose();
    this.hud.dispose();
  }

  // ------------------------------------------------------------------ setup

  private async dress(): Promise<void> {
    const entry = findRoster(readSavedPick());
    const loaded = await this.models.instance(entry);
    if (this.stopped) return;
    if (!loaded.ok) {
      this.hud.setGateStatus(loaded.error.message);
      return;
    }
    this.rig?.dispose();
    this.rig = new PoseRig(this.studio.scene, loaded.value);
    this.hud.setGateStatus('');
  }

  private async startCamera(): Promise<void> {
    this.hud.setGateStatus('Asking for the camera…');
    const started = await this.pose.start();
    if (this.stopped) return;
    if (!started.ok) {
      this.hud.setGateStatus(started.error.message);
      return;
    }
    const video = this.pose.videoElement();
    if (video) this.hud.attachCamera(video);
    this.tracking = true;
    this.hud.hideGate();
    this.hud.setStatus('Tracking. Pick an action and press Record.');
  }

  private onPoseStatus(status: PoseStatus): void {
    switch (status.kind) {
      case 'starting':
        this.hud.setGateStatus(status.message);
        break;
      case 'failed':
        this.hud.setGateStatus(status.message);
        this.hud.setStatus(status.message);
        break;
      case 'no-body':
        this.hud.setStatus('No body in frame — step back so your hips and feet are visible.');
        break;
      case 'tracking':
      case 'off':
        break;
    }
  }

  /** Drag to orbit, scroll or pinch to zoom. */
  private watchOrbit(): void {
    const canvas = this.hud.canvas;
    let pointer: number | null = null;
    let last = { x: 0, y: 0 };
    this.detach.push(
      on(canvas, 'pointerdown', (event) => {
        pointer = event.pointerId;
        last = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      }),
      on(canvas, 'pointermove', (event) => {
        if (event.pointerId !== pointer) return;
        this.studio.orbit(event.clientX - last.x, event.clientY - last.y);
        last = { x: event.clientX, y: event.clientY };
      }),
      on(canvas, 'pointerup', (event) => {
        if (event.pointerId === pointer) pointer = null;
      }),
      on(canvas, 'wheel', (event) => {
        event.preventDefault();
        this.studio.zoom(event.deltaY);
      }),
    );
  }

  // -------------------------------------------------------------- recording

  private beginTake(action: ActionSpec): void {
    if (!this.tracking) {
      this.hud.setStatus('Start the camera first.');
      return;
    }
    if (this.recorder.recording) return;
    this.recordingAction = action;
    this.recorder.begin(action.name, action.held);
    this.hud.setStatus(`${action.label}: ${action.hint}`);
  }

  private useDataset(dataset: Dataset): void {
    this.dataset = dataset;
    // Retraining is just wrapping the samples, so recognition improves on the
    // very next frame after a recording.
    this.classifier = new GestureClassifier(dataset);
    this.gate.reset();
    this.hud.setCounts(countsByAction(dataset));
    if (!saveDataset(dataset)) {
      this.hud.setStatus('Could not save to this browser — export the file to keep it.');
    }
  }

  private async importFile(file: File): Promise<void> {
    const loaded = await readDatasetFile(file);
    if (this.stopped) return;
    if (loaded.samples.length === 0) {
      this.hud.setStatus('That file held no usable recordings.');
      return;
    }
    this.useDataset(loaded);
    this.hud.setStatus(`Imported ${loaded.samples.length} recordings.`);
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
    const elapsed = Math.max(0, (now - this.lastFrameAt) / 1000);
    // Smoothing is clamped, because a tab that has been in the background
    // should not snap the body across the room in one step. The recorder is
    // not: a countdown is a wall-clock promise to the person performing, and
    // must not stretch because the machine is drawing slowly.
    const dt = Math.min(MAX_FRAME, elapsed);
    this.lastFrameAt = now;

    const frame = this.pose.read();
    if (frame) {
      if (isUsable(frame.body)) {
        this.rig?.setPose(frame.body, dt);
        this.window.push(frame.body);
      }
      this.rig?.setFace(frame.face);
      this.overlay.draw(frame, { mirrored: true });
    }

    this.rig?.sync();

    const usable = frame && isUsable(frame.body) ? frame.body : null;
    const result = this.recorder.tick(elapsed, usable);
    if (result.sample) {
      const action = findAction(result.sample.action);
      this.useDataset(addSample(this.dataset, result.sample));
      const count = countsByAction(this.dataset)[result.sample.action] ?? 0;
      this.hud.setStatus(
        count >= SAMPLES_WANTED
          ? `${action?.label ?? 'Action'} recorded — ${count} takes, that is plenty.`
          : `${action?.label ?? 'Action'} recorded — ${count} of ${SAMPLES_WANTED}.`,
      );
      this.recordingAction = null;
    } else if (result.problem) {
      this.hud.setStatus(result.problem);
      this.recordingAction = null;
    }

    this.hud.setTake(this.recorder.state, this.recordingAction?.label ?? null);
    this.updateVerdict(dt);
    this.studio.render();
  }

  /** Classifies the newest window and says what it would mean in a fight. */
  private updateVerdict(dt: number): void {
    const classes = actionsPresent(this.dataset).length;
    if (classes < 2) {
      this.hud.setVerdict(
        null,
        0,
        `Record at least two different actions — idle first, then a move — and this starts naming what you do. ${classes} of 2 so far.`,
      );
      return;
    }

    const features = this.window.feature();
    if (!features) {
      this.hud.setVerdict(null, 0, 'Waiting for a clear, full-body view.');
      return;
    }

    const verdict = this.classifier.classify(features);
    const fired = this.gate.accept(verdict, dt);
    const action = verdict ? findAction(verdict.action) : null;
    this.hud.setVerdict(action, verdict?.confidence ?? 0, this.describe(verdict, fired));
  }

  private describe(verdict: Verdict | null, fired: ActionName | null): string {
    if (!verdict) return 'Nothing like anything recorded yet — hold still, or record more takes.';
    if (verdict.action === 'idle') return 'Standing by. The classifier is watching for a move.';
    if (fired) return `A fight would act on this: ${findAction(fired)?.label ?? fired}.`;
    return verdict.confidence < 0.55
      ? 'Too unsure to act on. More takes of this action would sharpen it.'
      : 'Held — an action only fires once per performance.';
  }
}

/** Every action the room can teach, for anything that wants the list. */
export const TRAINABLE_ACTIONS = ACTIONS;
