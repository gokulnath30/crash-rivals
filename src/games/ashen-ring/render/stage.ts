import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clamp, damp } from '@domain/shared/mathx.ts';

/** Where the camera should be looking this frame, in the fight's own terms. */
export interface CameraView {
  /** Mid-point between the fighters. */
  readonly midX: number;
  /** Distance between them, which sets how far back the camera sits. */
  readonly gap: number;
  /** 0..1 while the round's opening sweep plays; null during the fight. */
  readonly intro: number | null;
  /** Where the two fighters stand, for the sweep to start on the first. */
  readonly fighterX: readonly [number, number];
}

/**
 * The renderer, the camera and the camera's manners.
 *
 * A fighting game camera is a side view that breathes: it backs off as the
 * fighters separate and closes in as they meet, and it never leaves the line
 * they fight along. Rounds open on a low sweep past the first fighter that
 * settles into that view. Impacts shake it. None of this can affect the fight.
 */
export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);
  readonly renderer: THREE.WebGLRenderer;

  /** A second, narrow camera for the face portraits. */
  private readonly portraitCamera = new THREE.PerspectiveCamera(24, 1, 0.05, 40);
  private readonly portraitLook = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  private readonly position = new THREE.Vector3(0, 1.45, 6.2);
  private readonly lookAt = new THREE.Vector3(0, 1.0, 0);
  private readonly wantPosition = new THREE.Vector3();
  private readonly wantLookAt = new THREE.Vector3();
  private readonly sweepFrom = new THREE.Vector3();
  private readonly sweepLook = new THREE.Vector3();
  private shake = 0;
  private readonly resizeObserver: ResizeObserver;
  private environment: THREE.Texture | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Capped below 2: a 3x device pixel ratio triples the fragment cost for
    // a difference nobody can see on a moving fighter.
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadows are rendered once per frame, by `render`, and reused by the
    // portrait insets rather than rebuilt for each of them.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Image-based lighting. Skin and cloth read as materials only when there
    // is an environment for them to reflect; a room's worth of soft light is
    // what makes the PBR textures the export ships look like PBR.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.45;

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  /** Adds to the shake already scheduled, so two hits at once rock harder. */
  addShake(amount: number): void {
    this.shake = Math.min(0.4, this.shake + amount);
  }

  render(dt: number, view: CameraView): void {
    this.aim(view);

    // The fight camera eases; the sweep is placed exactly, so it stays smooth
    // even when frame time stutters at the start of a round.
    const t = view.intro === null ? 1 - Math.pow(0.004, dt) : 1;
    this.position.lerp(this.wantPosition, t);
    this.lookAt.lerp(this.wantLookAt, t);

    this.camera.position.copy(this.position);
    const shake = this.shake;
    this.shake = damp(this.shake, 0, 0.001, dt);
    if (shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.8;
    }
    this.camera.lookAt(this.lookAt);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Draws a close-up of a face into a rectangle of the canvas, over the frame
   * already rendered. The HUD leaves a hole where its portrait frame is, and
   * this fills it, so the picture beside a fighter's health bar is live.
   *
   * @param frame the frame's box in CSS pixels, as `getBoundingClientRect`
   *   reports it.
   * @param face where the face is in world space and which way it looks.
   */
  renderPortrait(frame: DOMRect, face: THREE.Vector3, facing: number): void {
    const canvasBox = this.canvas.getBoundingClientRect();
    const x = frame.left - canvasBox.left;
    const y = canvasBox.bottom - frame.bottom;
    if (frame.width < 4 || frame.height < 4) return;

    const camera = this.portraitCamera;
    camera.aspect = frame.width / frame.height;
    camera.updateProjectionMatrix();
    // In front of the face and a little toward the audience, so the portrait
    // is a three-quarter view rather than a mugshot.
    // Far enough back to keep hair and chin both in frame on the taller,
    // detailed heads.
    camera.position.set(face.x + facing * 0.66, face.y + 0.05, face.z + 0.34);
    this.portraitLook.set(face.x, face.y + 0.01, face.z);
    camera.lookAt(this.portraitLook);

    const { renderer } = this;
    renderer.getSize(this.size);
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, frame.width, frame.height);
    renderer.setScissor(x, y, frame.width, frame.height);
    renderer.clearDepth();
    renderer.render(this.scene, camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.size.x, this.size.y);
    renderer.autoClear = true;
  }

  /** Projects a world point to CSS pixels, for floating damage numbers. */
  toScreen(point: { x: number; y: number; z: number }): { x: number; y: number } {
    const projected = new THREE.Vector3(point.x, point.y, point.z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.scene.traverse((object) => {
      const drawable = object as Partial<THREE.Mesh>;
      drawable.geometry?.dispose();
      for (const material of materialsOf(drawable.material)) material.dispose();
    });
    this.environment?.dispose();
    this.renderer.dispose();
  }

  private aim(view: CameraView): void {
    // The side view: further back the further apart they are, and a little
    // higher, so a long-range fight is seen from slightly above.
    const distance = clamp(5.0 + view.gap * 0.6, 5.4, 8.6);
    this.wantPosition.set(view.midX, 1.42 + view.gap * 0.04, distance);
    this.wantLookAt.set(view.midX, 0.98, 0);

    if (view.intro === null) return;

    // The sweep: start low and close beside the first fighter, looking across
    // at the second, then swing out and up into the side view.
    const [first, second] = view.fighterX;
    const toward = second >= first ? 1 : -1;
    this.sweepFrom.set(first - toward * 1.5, 0.9, 1.7);
    this.sweepLook.set(second, 1.25, 0);

    const hold = 0.28;
    const u = smoothstep(clamp((view.intro - hold) / (1 - hold), 0, 1));
    this.wantPosition.lerpVectors(this.sweepFrom, this.wantPosition, u);
    // A gentle arc rather than a straight slide.
    this.wantPosition.y += Math.sin(u * Math.PI) * 0.45;
    this.wantLookAt.lerpVectors(this.sweepLook, this.wantLookAt, u);
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    // A tall phone screen would otherwise crop the fighters; widen the view
    // as the aspect narrows so the ring stays in frame.
    this.camera.fov = this.camera.aspect < 1.2 ? 42 : 30;
    this.camera.updateProjectionMatrix();
  }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function materialsOf(material: THREE.Material | THREE.Material[] | undefined): THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}
