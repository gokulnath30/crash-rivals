import * as THREE from 'three';

export interface ArenaPalette {
  readonly first: number;
  readonly second: number;
  readonly gold: number;
}

/**
 * The ring: a raised stone platform with a glowing rim, a ragged circle of
 * basalt pillars hung with banners, four braziers, and embers in the air.
 *
 * Built once, from a seeded random, so the stage is identical on every load.
 * The only things that move are the fire and the embers, in `update`.
 */
export class ArenaSet {
  private readonly embers: THREE.Points;
  private readonly emberVelocity: Float32Array;
  private readonly flames: { light: THREE.PointLight; core: THREE.Object3D; phase: number }[] = [];
  private readonly banners: THREE.Mesh[] = [];
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    palette: ArenaPalette,
    seed = 4127,
  ) {
    const random = seededRandom(seed);
    const anisotropy = renderer.capabilities.getMaxAnisotropy();

    scene.fog = new THREE.FogExp2(0x0c0908, 0.03);
    this.buildSky();
    this.buildLights(palette);
    this.buildFloor(anisotropy);
    this.buildSurround(random, palette);
    this.buildBraziers();

    const { points, velocity } = this.buildEmbers(random);
    this.embers = points;
    this.emberVelocity = velocity;
  }

  update(dt: number, now: number): void {
    // Fire: each brazier flickers on its own phase.
    for (const flame of this.flames) {
      const n =
        Math.sin(now * 9 + flame.phase) * 0.5 +
        Math.sin(now * 23 + flame.phase * 1.7) * 0.3 +
        Math.sin(now * 3.1 + flame.phase) * 0.2;
      flame.light.intensity = 16 + n * 4;
      flame.core.scale.set(1.7 + n * 0.15, 2.3 + n * 0.4, 1);
    }

    for (const [index, banner] of this.banners.entries()) {
      banner.rotation.x = Math.sin(now * 0.7 + index) * 0.03;
    }

    // Embers drift up and sway; one that leaves the top comes back at the floor.
    const positions = this.embers.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    for (let i = 0; i < positions.count; i++) {
      const at = i * 3;
      const vx = this.emberVelocity[at] ?? 0;
      const vy = this.emberVelocity[at + 1] ?? 0;
      const vz = this.emberVelocity[at + 2] ?? 0;
      array[at] = (array[at] ?? 0) + (vx + Math.sin(now * 1.3 + i) * 0.08) * dt;
      array[at + 1] = (array[at + 1] ?? 0) + vy * dt;
      array[at + 2] = (array[at + 2] ?? 0) + (vz + Math.cos(now * 1.1 + i) * 0.08) * dt;
      if ((array[at + 1] ?? 0) > 6) array[at + 1] = 0.1;
    }
    positions.needsUpdate = true;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
  }

  // ------------------------------------------------------------- pieces

  private keep<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildSky(): void {
    // A gradient dome: warm ember glow at the horizon fading to near-black.
    // Unaffected by fog, or the fog would flatten it to one colour.
    const material = this.keep(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x020306) },
          mid: { value: new THREE.Color(0x0e0a0a) },
          horizon: { value: new THREE.Color(0x4a2210) },
        },
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 top; uniform vec3 mid; uniform vec3 horizon;
          varying vec3 vWorld;
          void main() {
            float h = clamp(vWorld.y / 70.0, -1.0, 1.0);
            vec3 c = h < 0.0 ? horizon : mix(horizon, mid, smoothstep(0.0, 0.14, h));
            c = mix(c, top, smoothstep(0.14, 0.6, h));
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    const sky = new THREE.Mesh(this.keep(new THREE.SphereGeometry(70, 24, 16)), material);
    this.scene.add(sky);
  }

  private buildLights(palette: ArenaPalette): void {
    const key = new THREE.DirectionalLight(0xfff0dd, 2.4);
    key.position.set(3.5, 8, 4.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -7;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    this.scene.add(key, key.target);

    this.scene.add(new THREE.HemisphereLight(0x3a4a66, 0x1a110c, 0.55));

    // One coloured rim per corner, from behind and above, so each fighter is
    // cut out of the dark by their own hue.
    for (const [x, colour] of [
      [-6, palette.first],
      [6, palette.second],
    ] as const) {
      const rim = new THREE.SpotLight(colour, 70, 22, 0.55, 0.6, 2);
      rim.position.set(x, 5.5, -3.5);
      rim.target.position.set(x / 5, 1.1, 0);
      this.scene.add(rim, rim.target);
    }
  }

  private buildFloor(anisotropy: number): void {
    const texture = this.keep(stoneTexture());
    texture.anisotropy = anisotropy;

    const stone = this.keep(
      new THREE.MeshStandardMaterial({
        map: texture,
        roughnessMap: texture,
        roughness: 0.55,
        metalness: 0.06,
        envMapIntensity: 0.9,
      }),
    );

    // The platform the fight is on. The top sits at y = 0.
    const platform = new THREE.Mesh(this.keep(new THREE.CylinderGeometry(5.4, 5.6, 0.5, 48)), stone);
    platform.position.y = -0.25;
    platform.receiveShadow = true;
    this.scene.add(platform);

    // A wider step beneath it, then the dark ground stretching away.
    const plinth = new THREE.Mesh(
      this.keep(new THREE.CylinderGeometry(6.4, 6.7, 0.5, 48)),
      this.keep(new THREE.MeshStandardMaterial({ color: 0x1d1916, roughness: 0.95 })),
    );
    plinth.position.y = -0.75;
    plinth.receiveShadow = true;
    this.scene.add(plinth);

    const ground = new THREE.Mesh(
      this.keep(new THREE.CircleGeometry(60, 48)),
      this.keep(new THREE.MeshStandardMaterial({ color: 0x0b0908, roughness: 1 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    this.scene.add(ground);

    // The glowing rim, and the inner fight line.
    const rimGlow = new THREE.Mesh(
      this.keep(new THREE.TorusGeometry(5.45, 0.035, 8, 128)),
      this.keep(new THREE.MeshBasicMaterial({ color: 0xffa040 })),
    );
    rimGlow.rotation.x = Math.PI / 2;
    rimGlow.position.y = 0.02;
    this.scene.add(rimGlow);

    const line = new THREE.Mesh(
      this.keep(new THREE.RingGeometry(4.55, 4.62, 96)),
      this.keep(
        new THREE.MeshBasicMaterial({ color: 0xe8c27a, transparent: true, opacity: 0.55 }),
      ),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.004;
    this.scene.add(line);

    const emblem = new THREE.Mesh(
      this.keep(new THREE.RingGeometry(0.92, 0.97, 64)),
      this.keep(
        new THREE.MeshBasicMaterial({ color: 0xe8c27a, transparent: true, opacity: 0.28 }),
      ),
    );
    emblem.rotation.x = -Math.PI / 2;
    emblem.position.y = 0.004;
    this.scene.add(emblem);
  }

  private buildSurround(random: () => number, palette: ArenaPalette): void {
    // Pillars ring the back and sides; the camera side is left open.
    const spots: { angle: number; radius: number; height: number }[] = [];
    for (let i = 0; i < 22; i++) {
      const angle = (i / 22) * Math.PI * 2 + (random() - 0.5) * 0.12;
      const z = Math.sin(angle);
      if (z > 0.35) continue;
      spots.push({ angle, radius: 9 + random() * 1.6, height: 4.4 + random() * 2.2 });
    }

    const basalt = this.keep(
      new THREE.MeshStandardMaterial({ color: 0x1c1815, roughness: 0.88, metalness: 0.02 }),
    );
    const shaft = this.keep(new THREE.BoxGeometry(0.7, 1, 0.7));
    const pillars = new THREE.InstancedMesh(shaft, basalt, spots.length);
    const cap = this.keep(new THREE.BoxGeometry(0.95, 0.28, 0.95));
    const caps = new THREE.InstancedMesh(cap, basalt, spots.length);
    const transform = new THREE.Matrix4();
    spots.forEach((spot, i) => {
      const x = Math.cos(spot.angle) * spot.radius;
      const z = Math.sin(spot.angle) * spot.radius;
      transform.makeScale(1, spot.height, 1);
      transform.setPosition(x, spot.height / 2 - 1, z);
      pillars.setMatrixAt(i, transform);
      transform.makeRotationY(-spot.angle);
      transform.setPosition(x, spot.height - 1 + 0.14, z);
      caps.setMatrixAt(i, transform);
    });
    pillars.castShadow = true;
    pillars.receiveShadow = true;
    this.scene.add(pillars, caps);

    // Banners between the back pillars, in the two corners' colours.
    const cloth = this.keep(new THREE.PlaneGeometry(1.15, 3.6, 1, 6));
    const backSpots = spots.filter((spot) => Math.sin(spot.angle) < -0.45);
    backSpots.forEach((spot, i) => {
      const colour = i % 2 === 0 ? palette.first : palette.second;
      // Dyed cloth: the team colour darkened as the base, with only a hint
      // of glow, so the banners are lit by the braziers like everything else.
      const dye = new THREE.Color(colour).multiplyScalar(0.28);
      const material = this.keep(
        new THREE.MeshStandardMaterial({
          color: dye,
          emissive: colour,
          emissiveIntensity: 0.06,
          roughness: 1,
          side: THREE.DoubleSide,
        }),
      );
      const banner = new THREE.Mesh(cloth, material);
      const radius = spot.radius - 0.9;
      banner.position.set(Math.cos(spot.angle) * radius, 3.1, Math.sin(spot.angle) * radius);
      banner.lookAt(0, 3.1, 0);
      this.banners.push(banner);
      this.scene.add(banner);
    });
  }

  private buildBraziers(): void {
    const iron = this.keep(new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.7, metalness: 0.5 }));
    const stem = this.keep(new THREE.CylinderGeometry(0.16, 0.3, 1.5, 12));
    const bowl = this.keep(new THREE.CylinderGeometry(0.55, 0.28, 0.4, 16));
    const coreGeometry = this.keep(new THREE.SphereGeometry(0.16, 12, 10));
    const coreMaterial = this.keep(new THREE.MeshBasicMaterial({ color: 0xffd08a }));
    const flameMap = this.keep(flameTexture());
    const flameMaterial = this.keep(
      new THREE.SpriteMaterial({
        map: flameMap,
        color: 0xff9a3a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    for (const [index, degrees] of [200, 250, 290, 340].entries()) {
      const angle = (degrees * Math.PI) / 180;
      const x = Math.cos(angle) * 6.6;
      const z = Math.sin(angle) * 6.6;

      const base = new THREE.Mesh(stem, iron);
      base.position.set(x, -0.25, z);
      base.castShadow = true;
      const dish = new THREE.Mesh(bowl, iron);
      dish.position.set(x, 0.65, z);
      const core = new THREE.Mesh(coreGeometry, coreMaterial);
      core.position.set(x, 0.92, z);
      // The flame itself: a soft additive sprite that the update breathes.
      const flame = new THREE.Sprite(flameMaterial);
      flame.position.set(x, 1.35, z);
      flame.scale.set(1.7, 2.3, 1);

      const light = new THREE.PointLight(0xff7a2a, 16, 16, 2);
      light.position.set(x, 1.15, z);

      this.flames.push({ light, core: flame, phase: index * 1.9 });
      this.scene.add(base, dish, core, flame, light);
    }
  }

  private buildEmbers(random: () => number): { points: THREE.Points; velocity: Float32Array } {
    const count = 260;
    const positions = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 1.5 + random() * 6.5;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = random() * 6;
      positions[i * 3 + 2] = Math.sin(angle) * radius - 1.5;
      velocity[i * 3] = (random() - 0.5) * 0.1;
      velocity[i * 3 + 1] = 0.25 + random() * 0.4;
      velocity[i * 3 + 2] = (random() - 0.5) * 0.1;
    }
    const geometry = this.keep(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = this.keep(
      new THREE.PointsMaterial({
        color: 0xffa050,
        size: 0.045,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.scene.add(points);
    return { points, velocity };
  }
}

/**
 * Dark slate tiles with grout, drawn once into a canvas. Used as both colour
 * and roughness, so the tile-to-tile variation also varies the sheen.
 */
function stoneTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  if (!ctx) return texture;

  const random = seededRandom(99);
  ctx.fillStyle = '#141110';
  ctx.fillRect(0, 0, size, size);

  const tiles = 4;
  const tile = size / tiles;
  const grout = 5;
  for (let row = 0; row < tiles; row++) {
    for (let col = 0; col < tiles; col++) {
      const shade = 38 + Math.floor(random() * 22);
      ctx.fillStyle = `rgb(${shade + 6} ${shade + 2} ${shade})`;
      ctx.fillRect(col * tile + grout, row * tile + grout, tile - grout * 2, tile - grout * 2);
      // Speckle so the stone is not flat.
      for (let i = 0; i < 260; i++) {
        const x = col * tile + grout + random() * (tile - grout * 2);
        const y = row * tile + grout + random() * (tile - grout * 2);
        const s = shade + (random() - 0.5) * 36;
        ctx.fillStyle = `rgb(${s + 4} ${s} ${s - 2})`;
        ctx.fillRect(x, y, 1 + random() * 2, 1 + random() * 2);
      }
    }
  }

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 5);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** A teardrop of light for the brazier sprites: bright core, soft falloff. */
function flameTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const texture = new THREE.CanvasTexture(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return texture;
  const gradient = ctx.createRadialGradient(size / 2, size * 0.6, 0, size / 2, size * 0.55, size * 0.5);
  gradient.addColorStop(0, 'rgba(255, 240, 200, 1)');
  gradient.addColorStop(0.25, 'rgba(255, 170, 70, 0.85)');
  gradient.addColorStop(0.6, 'rgba(255, 90, 20, 0.35)');
  gradient.addColorStop(1, 'rgba(255, 60, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.needsUpdate = true;
  return texture;
}

/** A small deterministic generator (mulberry32), so the set never changes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
