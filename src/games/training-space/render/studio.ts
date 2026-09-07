import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * The room the character stands in: a neutral studio, deliberately plain.
 *
 * Nothing here competes with the body. A soft ground, a grid to read depth
 * against, and three lights that show a shape clearly — this room exists so
 * you can see exactly what the camera thinks you are doing.
 */
export class Studio {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);

  private readonly renderer: THREE.WebGLRenderer;
  private readonly resizeObserver: ResizeObserver;
  private environment: THREE.Texture | null = null;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  /** Where the camera orbits, so a person can look at their own back. */
  private yaw = 0;
  private pitch = 0.06;
  private radius = 3.4;
  private readonly focus = new THREE.Vector3(0, 0.95, 0);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.7;
    this.scene.background = new THREE.Color(0x14161c);
    this.scene.fog = new THREE.Fog(0x14161c, 8, 22);

    const key = new THREE.DirectionalLight(0xfff4e6, 2.2);
    key.position.set(2.5, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -1;
    key.shadow.normalBias = 0.03;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 0.7);
    fill.position.set(-4, 2.5, 2);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0x9fb0d0, 0x181a20, 0.6));

    const floor = new THREE.Mesh(
      this.keep(new THREE.CircleGeometry(6, 48)),
      this.keep(new THREE.MeshStandardMaterial({ color: 0x1b1e26, roughness: 0.85 })),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(12, 24, 0x3a4258, 0x252a35);
    grid.position.y = 0.002;
    this.scene.add(grid);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    this.resize();
    this.place();
  }

  /** Drag to orbit; the room is for looking at yourself from any side. */
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-0.5, Math.min(0.9, this.pitch + dy * 0.004));
    this.place();
  }

  /** Scroll or pinch to move in on the face or out to the whole body. */
  zoom(delta: number): void {
    this.radius = Math.max(1.2, Math.min(7, this.radius + delta * 0.0016));
    this.place();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const item of this.disposables) item.dispose();
    this.environment?.dispose();
    this.renderer.dispose();
  }

  private keep<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private place(): void {
    const horizontal = Math.cos(this.pitch) * this.radius;
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * horizontal,
      this.focus.y + Math.sin(this.pitch) * this.radius,
      this.focus.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.focus);
  }

  private resize(): void {
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 480;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
}
