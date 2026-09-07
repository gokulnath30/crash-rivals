import * as THREE from 'three';
import type { Brawler } from '@domain/arena/brawler.ts';
import { SkeletonAnimator } from './animator.ts';
import type { ClipLibrary } from './clip-library.ts';
import { materialsOf } from './model-library.ts';

/**
 * One fighter on stage: the skinned model, its animator, and the few things
 * that mark it as a particular person (an outfit colour, eyewear or not).
 *
 * Reads a `Brawler` every frame and never writes to it. The fighter faces
 * along x in the world, so the group's yaw is the only thing that turns the
 * character-space poses into a fighter looking at their opponent.
 */
export class FighterAvatar {
  readonly group = new THREE.Group();

  private readonly animator: SkeletonAnimator;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly contactShadow: THREE.Mesh;
  private readonly head: THREE.Object3D | null;
  private facing = 1;
  private flash = 0;

  constructor(
    scene: THREE.Scene,
    model: THREE.Object3D,
    options: {
      outfit: number | null;
      eyewear: boolean;
      seed: number;
      /** The recorded segments shared by every fighter; null stays procedural. */
      clips: ClipLibrary | null;
    },
  ) {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    // Rest orientations are read here, before the model is posed or moved.
    this.animator = new SkeletonAnimator(model, options.seed, options.clips);

    let head: THREE.Object3D | null = null;
    model.traverse((object) => {
      if (object.type === 'Bone' && object.name === 'Head') head = object;
      if (!(object instanceof THREE.SkinnedMesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = false; // a posed skin can leave its rest bounds

      if (!options.eyewear && object.name.includes('glasses')) {
        object.visible = false;
        return;
      }

      const skin = object as Partial<THREE.Mesh>;
      // Cloned per fighter, so a tint on one cannot land on the other.
      const cloned = materialsOf(skin.material).map((material) => {
        const copy = material.clone();
        if (copy instanceof THREE.MeshStandardMaterial) {
          if (options.outfit !== null && isOutfit(copy.name)) copy.color.setHex(options.outfit);
          copy.emissive = new THREE.Color(0xffffff);
          copy.emissiveIntensity = 0;
          this.materials.push(copy);
        }
        return copy;
      });
      object.material = cloned.length === 1 ? (cloned[0] as THREE.Material) : cloned;
    });
    this.head = head;

    this.group.add(model);

    // A soft blob under the feet. The key light casts a real shadow too, but
    // this one stays put when that shadow falls where the camera cannot see,
    // and it is what tells the eye how high a jump is.
    this.contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = 0.004;

    scene.add(this.group);
    scene.add(this.contactShadow);
  }

  /** Called once per rendered frame, after the simulation has settled. */
  sync(brawler: Brawler, dt: number): void {
    this.facing = brawler.facing;
    this.group.position.set(brawler.x, brawler.y, 0);
    // The model faces +z; a quarter turn either way faces it along the line.
    this.group.rotation.y = (brawler.facing * Math.PI) / 2;

    this.animator.update(
      {
        stance: brawler.stance,
        time: brawler.stanceTime,
        stride: brawler.stride,
        attack: brawler.attack?.spec ?? null,
        stagger: brawler.staggerSeconds,
      },
      dt,
    );

    this.contactShadow.position.x = brawler.x;
    const lying = brawler.down ? Math.min(1, brawler.stanceTime / 0.7) : 0;
    const lift = Math.min(1, brawler.y / 1.2);
    this.contactShadow.scale.set(
      (1 + lying * 1.4) * (1 - lift * 0.4),
      (1 + lying * 0.4) * (1 - lift * 0.4),
      1,
    );
    (this.contactShadow.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - lift * 0.6);

    // A white flare on impact that fades over a few frames.
    this.flash = Math.max(0, this.flash - dt * 8);
    for (const material of this.materials) material.emissiveIntensity = this.flash * 0.14;
  }

  /** Lights the body up for a moment. Called by whoever saw the hit land. */
  flare(): void {
    this.flash = 1;
  }

  /**
   * Where the face is, in world space, and which way it points along x.
   * False when the model has no head bone to read.
   */
  face(out: THREE.Vector3): { facing: number } | null {
    if (!this.head) return null;
    this.head.getWorldPosition(out);
    // The head bone sits at the base of the skull; the face is a little up
    // and forward of it.
    out.y += 0.08;
    out.x += this.facing * 0.04;
    return { facing: this.facing };
  }

  /**
   * Releases only what this avatar made: the group, the blob and the cloned
   * materials. The geometry belongs to the library's cached original, which
   * is shared by every clone, and goes when the library does.
   */
  dispose(): void {
    this.group.removeFromParent();
    this.contactShadow.removeFromParent();
    this.contactShadow.geometry.dispose();
    (this.contactShadow.material as THREE.Material).dispose();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }
}

/** The outfit materials, by the names Avaturn gives them. Never the skin. */
function isOutfit(name: string): boolean {
  return name.includes('look') || name.includes('outfit') || name.includes('cloth');
}
