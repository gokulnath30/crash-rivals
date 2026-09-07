import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type { RosterEntry } from '../roster.ts';

/** How a download is going, for whatever is showing a loading state. */
export interface LoadProgress {
  readonly name: string;
  /** 0..1 when the server sent a length, null when it did not. */
  readonly fraction: number | null;
  readonly loadedBytes: number;
  readonly done: boolean;
}

/**
 * Loads character models, once each.
 *
 * Both fighters may wear the same export, so the file is fetched once and
 * every fighter gets a `SkeletonUtils.clone`: an ordinary clone would leave
 * both skins bound to one skeleton, and posing one fighter would pose both.
 * In-flight requests are shared, so two fighters asking at once cost one
 * download.
 */
export class ModelLibrary {
  private readonly loader = new GLTFLoader();
  private readonly loaded = new Map<string, THREE.Object3D>();
  private readonly pending = new Map<string, Promise<Result<THREE.Object3D>>>();
  private readonly log: LoggerPort;
  private onProgress: ((progress: LoadProgress) => void) | null = null;

  constructor(logger: LoggerPort) {
    this.log = logger.scoped('ashen-ring/models');
  }

  watchProgress(listener: (progress: LoadProgress) => void): void {
    this.onProgress = listener;
  }

  /** A fresh, independently posable copy. Never throws. */
  async instance(entry: RosterEntry): Promise<Result<THREE.Object3D>> {
    const source = await this.source(entry);
    if (!source.ok) return source;
    return ok(cloneSkinned(source.value));
  }

  private async source(entry: RosterEntry): Promise<Result<THREE.Object3D>> {
    const cached = this.loaded.get(entry.model);
    if (cached) return ok(cached);
    const inFlight = this.pending.get(entry.model);
    if (inFlight) return inFlight;

    const request = this.fetch(entry, new URL(entry.model, document.baseURI).href);
    this.pending.set(entry.model, request);
    const result = await request;
    this.pending.delete(entry.model);
    return result;
  }

  private async fetch(entry: RosterEntry, url: string): Promise<Result<THREE.Object3D>> {
    try {
      const started = performance.now();
      const scene = await new Promise<THREE.Object3D>((resolve, reject) => {
        this.loader.load(
          url,
          (gltf) => {
            resolve(gltf.scene);
          },
          (event) => {
            this.onProgress?.({
              name: entry.name,
              fraction: event.lengthComputable ? event.loaded / event.total : null,
              loadedBytes: event.loaded,
              done: false,
            });
          },
          reject,
        );
      });
      this.onProgress?.({ name: entry.name, fraction: 1, loadedBytes: 0, done: true });
      this.loaded.set(entry.model, scene);
      this.log.log('info', `loaded ${entry.name} in ${Math.round(performance.now() - started)}ms`);
      return ok(scene);
    } catch (error: unknown) {
      this.onProgress?.({ name: entry.name, fraction: null, loadedBytes: 0, done: true });
      this.log.log('warn', `could not load the model for ${entry.name}`, error);
      return fail(failure('unavailable', `Could not load ${entry.name}. Check the connection.`));
    }
  }

  /** Frees the cached originals. Clones share their geometry, so they go with it. */
  dispose(): void {
    for (const model of this.loaded.values()) {
      model.traverse((object) => {
        const drawable = object as Partial<THREE.Mesh>;
        drawable.geometry?.dispose();
        for (const material of materialsOf(drawable.material)) material.dispose();
      });
    }
    this.loaded.clear();
    this.pending.clear();
  }
}

export function materialsOf(
  material: THREE.Material | THREE.Material[] | undefined,
): readonly THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}
