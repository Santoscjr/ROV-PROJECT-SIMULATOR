import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer, type Object3D, type Scene } from 'three';
import { SecondaryView, isCameraSource } from './station';
import type { UnderwaterPass } from './underwaterPass';
import { Sonar } from './sonar';
import type { ViewSource, CameraFx } from '../config/settings';
import { VIEW_SOURCES } from '../config/settings';
import { t } from '../i18n';
import type { InstrumentPanel } from '../ui/stationUi';
import type { Collider } from '../sim/site';

export interface WindowFrame {
  scene: Scene;
  dt: number;
  time: number;
  rovRoot: Object3D;
  eye: Object3D;
  headingRad: number;
  tmsMount: Object3D | null;
  mainPass: UnderwaterPass;
  fx: CameraFx;
  terrainHeight: (x: number, z: number) => number;
  whiteBalance: (depth: number) => number;
  observer: (mode: string, y: number, pos: { x: number; y: number; z: number }) => void;
  rovPos: { x: number; y: number; z: number };
  heading: number;
  running: boolean;
}

/**
 * Independent browser window for a second physical monitor. The main window
 * owns the only simulation and renders the selected source into this window's
 * canvas with a second WebGL renderer (same scene graph, same frame). Closing
 * the window disposes its GPU resources; reopening creates them again.
 */
export class SecondaryWindow {
  private win: Window | null = null;
  private renderer: WebGLRenderer | null = null;
  private view: SecondaryView | null = null;
  private sonar: Sonar | null = null;
  source: ViewSource = 'sonar';
  onSourceChange: (s: ViewSource) => void = () => {};

  constructor(
    private readonly terrain: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
    private readonly instrFactory: (doc: Document) => InstrumentPanel,
  ) {}
  private instr: InstrumentPanel | null = null;

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Must be called from a user gesture (popup blockers). */
  open(source: ViewSource): boolean {
    this.source = source;
    if (this.isOpen) {
      this.win!.focus();
      return true;
    }
    const win = window.open('./monitor.html', 'rov-monitor-2', 'popup,width=1280,height=760');
    if (!win) return false;
    this.win = win;
    win.addEventListener('load', () => this.attach());
    return true;
  }

  private attach(): void {
    const win = this.win;
    if (!win) return;
    const doc = win.document;
    const canvas = doc.getElementById('view') as HTMLCanvasElement | null;
    const sel = doc.getElementById('src') as HTMLSelectElement | null;
    if (!canvas || !sel) return;
    sel.innerHTML = VIEW_SOURCES.map((s) => `<option value="${s}">${t('view.' + s)}</option>`).join('');
    sel.value = this.source;
    sel.addEventListener('change', () => {
      this.source = sel.value as ViewSource;
      this.onSourceChange(this.source);
    });
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.view = new SecondaryView(this.source);
    this.sonar = new Sonar(this.terrain, this.colliders);
    const status = doc.getElementById('status');
    if (status) status.textContent = 'sincronizado';
  }

  /** Render the selected source (called by the main loop once per frame). */
  render(f: WindowFrame): void {
    const win = this.win;
    if (!win) return;
    if (win.closed) {
      this.dispose();
      return;
    }
    if (!this.renderer || !this.view || !this.sonar) return;
    (win as unknown as { __rovHeartbeat?: number }).__rovHeartbeat = performance.timeOrigin + performance.now();
    const doc = win.document;
    const host = doc.getElementById('host');
    const canvas = this.renderer.domElement;
    const w = Math.max(1, win.innerWidth);
    const h = Math.max(1, win.innerHeight - 31);
    const src = this.source;
    if (this.view.source !== src) this.view.setSource(src);
    const sonarEl = this.sonar.canvas;
    const showCam = isCameraSource(src);
    canvas.style.display = showCam ? 'block' : 'none';
    if (src === 'sonar') {
      if (sonarEl.ownerDocument !== doc) doc.adoptNode(sonarEl);
      if (sonarEl.parentElement !== host) host?.appendChild(sonarEl);
      if (f.running) this.sonar.scan(f.rovPos as never, f.heading);
      this.sonar.draw(w, h);
    } else sonarEl.remove();
    if (src === 'instruments') {
      this.instr ??= this.instrFactory(doc);
      if (this.instr.root.parentElement !== host) host?.appendChild(this.instr.root);
    } else this.instr?.root.remove();
    if (!showCam) return;
    const pr = Math.min(win.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const pass = this.view.ensurePass(Math.round(w * pr), Math.round(h * pr));
    pass.setWater(f.mainPass.optics);
    const rig = this.view.rig;
    rig.tmsMount = f.tmsMount;
    rig.camera.aspect = w / h;
    rig.update(f.dt, f.rovRoot, f.eye, f.headingRad);
    const cam = rig.camera;
    const d = -cam.position.y;
    f.observer(rig.mode, cam.position.y, cam.position);
    pass.setCameraFx(f.fx, src === 'operational' || src === 'auxiliary');
    pass.update(cam, { camDepth: d, seabedDepth: -f.terrainHeight(cam.position.x, cam.position.z) || 120, time: f.time, wet: 0, whiteBalance: f.whiteBalance(d) });
    pass.render(this.renderer, f.scene, cam);
  }

  /** Instrumentation panel instance living in this window (if shown). */
  get instruments(): InstrumentPanel | null {
    return this.source === 'instruments' ? this.instr : null;
  }

  dispose(): void {
    this.view?.dispose();
    this.renderer?.dispose();
    this.view = null;
    this.renderer = null;
    this.sonar = null;
    this.instr = null;
    if (this.win && !this.win.closed) this.win.close();
    this.win = null;
  }
}
