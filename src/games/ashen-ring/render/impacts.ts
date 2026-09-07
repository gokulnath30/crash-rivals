import * as THREE from 'three';

/**
 * Impact sparks, from a fixed pool.
 *
 * A pool rather than create-and-destroy: allocating geometry per spark would
 * hand the garbage collector a reason to stutter exactly when the fight is at
 * its most frantic. When the pool runs dry the newest burst is simply smaller.
 */
export class Impacts {
  private readonly pool: {
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    velocity: THREE.Vector3;
    life: number;
  }[] = [];

  private readonly geometry = new THREE.OctahedronGeometry(0.05, 0);

  constructor(scene: THREE.Scene, size = 80) {
    for (let i = 0; i < size; i++) {
      const mesh = new THREE.Mesh(
        this.geometry,
        new THREE.MeshBasicMaterial({
          color: 0xffc070,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, velocity: new THREE.Vector3(), life: 0 });
    }
  }

  burst(at: { x: number; y: number; z: number }, colour: number, count: number, power: number): void {
    let spawned = 0;
    for (const spark of this.pool) {
      if (spark.life > 0) continue;
      spark.mesh.position.set(at.x, at.y, at.z);
      spark.mesh.visible = true;
      spark.mesh.material.color.setHex(colour);
      spark.mesh.material.opacity = 1;
      spark.mesh.scale.setScalar(0.6 + Math.random());
      spark.velocity.set(
        (Math.random() - 0.5) * power,
        Math.random() * power * 0.7,
        (Math.random() - 0.5) * power * 0.8,
      );
      spark.life = 0.4 + Math.random() * 0.3;
      if (++spawned >= count) break;
    }
  }

  update(dt: number): void {
    for (const spark of this.pool) {
      if (spark.life <= 0) continue;
      spark.life -= dt;
      spark.velocity.y -= 9 * dt;
      spark.mesh.position.addScaledVector(spark.velocity, dt);
      spark.mesh.material.opacity = Math.max(0, spark.life * 2);
      spark.mesh.rotation.x += dt * 7;
      if (spark.life <= 0) spark.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const spark of this.pool) {
      spark.mesh.removeFromParent();
      spark.mesh.material.dispose();
    }
    this.geometry.dispose();
    this.pool.length = 0;
  }
}
