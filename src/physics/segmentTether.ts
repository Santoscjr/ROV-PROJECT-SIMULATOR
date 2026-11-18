import { Quaternion, Vector3 } from 'three';
import type { TetherForceProvider } from './tether';
import type { Collider } from '../sim/site';
import { colliderBounds, sphereCollider } from './collision';

/**
 * Managed tether between the TMS and the ROV — a chain of particles solved
 * with Position Based Dynamics (Verlet integration + unilateral "rope"
 * distance constraints), stepped at the physics fixed rate.
 *
 * Training approximation, not a cable FEM:
 *  - a fixed number of segments whose rest length follows the paid-out length
 *    (adaptive resolution: long tethers get longer segments);
 *  - per-segment wet weight (configurable: positive, neutral or negative
 *    buoyancy), normal + tangential hydrodynamic drag in the local current;
 *  - simplified contacts with the seabed, the subsea structures and the ROV
 *    body (an oriented box), so the tether can lie on, drape over or loop
 *    around them without passing through;
 *  - the force on the vehicle combines the local pull of the last segment and
 *    the elastic stretch of the whole tether (axial stiffness EA), so when the
 *    ROV tries to go further than the paid-out length it is held back
 *    progressively, with damping — no teleport, no hard stop.
 */

export type TetherBuoyancy = 'positive' | 'neutral' | 'negative';

export interface SegmentTetherConfig {
  segments: number;
  /** Outer diameter (m). */
  diameter: number;
  /** Mass per metre including entrained water (kg/m). */
  massPerMeter: number;
  /** Wet weight per metre (N/m): + sinks, − floats. */
  wetWeight: number;
  /** Normal / tangential drag coefficients. */
  cdNormal: number;
  cdTangent: number;
  /** Axial stiffness EA (N). */
  axialStiffness: number;
  /** Axial damping (N per m/s of stretch rate). */
  axialDamping: number;
  /** Constraint iterations per step (mínimo; cresce com o número de segmentos). */
  iterations: number;
  /**
   * Comprimento-alvo de cada segmento (m). O número de segmentos acompanha o
   * cabo pago: com resolução fixa, 250 m viravam elos rígidos de ~8 m e o cabo
   * suspenso aparecia como um polígono de quinas.
   */
  targetSegmentLength: number;
  /** Teto de segmentos (custo por passo cresce com n × iterações). */
  maxSegments: number;
  /**
   * Rigidez à flexão (N·m², EI). Um tether de verdade não dobra como corrente:
   * a capa e os condutores dão uma rigidez pequena, mas suficiente para o cabo
   * folgado deitar em curvas largas em vez de quinas. 0 desliga.
   */
  bendStiffness: number;
  /** Contact radius of the cable for collisions (m). */
  radius: number;
  /** Clamp of the force transmitted to the ROV (N). */
  maxForce: number;
  waterDensity: number;
}

export const TETHER_BUOYANCY: Record<TetherBuoyancy, number> = { positive: -0.8, neutral: 0, negative: 1.6 };

export const DEFAULT_SEGMENT_TETHER: SegmentTetherConfig = {
  segments: 32,
  diameter: 0.03,
  massPerMeter: 1.4,
  wetWeight: TETHER_BUOYANCY.neutral + 0.3,
  cdNormal: 1.2,
  cdTangent: 0.02,
  axialStiffness: 3.0e5,
  axialDamping: 2.0e4,
  iterations: 12,
  targetSegmentLength: 1.5,
  maxSegments: 160,
  // Ordem de grandeza de cabos de ~30 mm com capa de poliuretano (aproximação).
  bendStiffness: 60,
  radius: 0.05,
  maxForce: 15000,
  waterDensity: 1025,
};

/** ROV body box used for cable contact (body frame, centred on the CG). */
const ROV_BOX = { cx: 0, cy: -0.05, cz: 0, hx: 1.35, hy: 0.85, hz: 0.85 };
/**
 * Margin (m) around the ROV box inside which the TMS exit counts as "at the
 * vehicle" (latched / just released under the Top-Hat): the exit guide then
 * lies within the contact box, so cable-on-ROV contact is suspended instead of
 * projecting the first nodes out of the box (which stretched the chain and
 * produced a full-scale tension spike at release).
 */
const ROV_ANCHOR_MARGIN = 0.3;
/**
 * Trecho junto à terminação que fica livre do contato com o casco (m, medido ao
 * longo do cabo). A terminação fica ~0,2 m acima da face superior do casco, então
 * basta isentar o próprio ponto de fixação. Antes a isenção era "os dois últimos
 * nós": com elos longos isso deixava vários metros de cabo atravessando o ROV.
 */
const ROV_TERMINATION_FREE = 0.15;
/**
 * Se a terminação estiver DENTRO do volume do casco (ex.: fixação na proa em
 * testes ou outro veículo), o cabo precisa de um trecho livre maior para sair
 * do volume sem ficar preso entre a fixação e o contato.
 */
const ROV_TERMINATION_FREE_INSIDE = 0.75;
/** Espaçamento das amostras usadas para testar cada segmento contra o casco (m). */
const ROV_SEGMENT_SAMPLE = 0.2;
/** Raio de uma esfera que contém o casco (para descartar segmentos longe do ROV). */
const ROV_BOX_RADIUS = Math.hypot(1.35, 0.9, 0.85);

/** Per-node contact flags in {@link TetherDebugState.nodeContact}. */
export const TETHER_CONTACT = { seabed: 1, structure: 2, rov: 4 } as const;

/**
 * Engineering diagnostics of the tether (read-only snapshot, see
 * {@link SegmentTether.debugState}). Arrays are reused between calls.
 */
export interface TetherDebugState {
  /** Node positions (world, m), n+1 entries: [0] = TMS exit, [n] = ROV termination. */
  nodes: Vector3[];
  /** Per-segment tension estimate (N), n entries; [j] joins nodes j and j+1. */
  segmentTension: Float64Array;
  /** Per-segment strain (d/L − 1), negative when the segment is slack/compressed. */
  segmentStrain: Float64Array;
  /** Per-node contact bit flags (TETHER_CONTACT.seabed | structure | rov), last step. */
  nodeContact: Uint8Array;
  /** Force applied on the ROV at the termination (world, N). */
  attachForce: Vector3;
  /** Tension at the termination (N) — same value as `tension`. */
  tension: number;
  /** Paid-out length (m), straight TMS→ROV distance (m), slack (m), elastic stretch (m). */
  payout: number;
  chord: number;
  slack: number;
  stretch: number;
  /** Rest length of one segment (m). */
  restLength: number;
  /** Contact counts of the last step. */
  contacts: { seabed: number; structure: number; rov: number };
  /** False while the tether is disabled (ROV latched): no force is applied. */
  enabled: boolean;
  /** True when cable-on-ROV contact is suspended because the TMS exit is at the vehicle. */
  rovContactSuspended: boolean;
}

const _v = new Vector3();
const _c = new Vector3();
const _t = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _s = new Vector3();
const _w = new Vector3();
const _o = new Vector3();

export class SegmentTether implements TetherForceProvider {
  readonly config: SegmentTetherConfig;
  /** Número atual de segmentos (muda com o cabo pago, ver remesh()). */
  n: number;
  /** Particle positions (world) — index 0 at the TMS exit, n at the ROV termination. */
  p: Vector3[];
  private prev: Vector3[];
  private lambda: Float64Array;
  /** Lambdas acumulados da flexão (XPBD), um por nó interno. */
  private lambdaBend: Float64Array;
  /** Per-node contact flags of the last step (TETHER_CONTACT bits). */
  private nodeFlags: Uint8Array;
  private lastDt = 1 / 120;
  private rovContactSuspended = false;
  /** Trecho do cabo junto à terminação sem contato com o casco (m), calculado a cada passo. */
  private rovFree = ROV_TERMINATION_FREE;
  private debug: TetherDebugState | null = null;
  /** Paid-out length (m), set by the TMS winch every step. */
  payout = 30;
  enabled = true;
  readonly anchor = new Vector3();
  /** Force on the ROV (world, N), last step. */
  readonly force = new Vector3();
  /** Tension at the ROV termination (N). */
  tension = 0;
  /** Elastic elongation of the whole tether (m), ≥ 0. */
  stretch = 0;
  /** Contacts in the last step. */
  contacts = { seabed: 0, structure: 0, rov: 0 };
  private lastStretch = 0;
  private readonly vehiclePos = new Vector3();
  private readonly vehicleQuat = new Quaternion();
  private hasVehicle = false;
  private readonly bounds: { x: number; y: number; z: number; r: number }[];
  private readonly nearIdx: number[] = [];

  constructor(
    private readonly current: (p: Vector3, out: Vector3) => Vector3,
    config: Partial<SegmentTetherConfig> = {},
    private readonly terrainHeight: (x: number, z: number) => number = () => -1e9,
    private readonly colliders: readonly Collider[] = [],
    /** Optional spatial index of static seabed colliders (boulders, berm): ColliderGrid from sim/environment.ts. */
    private readonly field?: {
      readonly colliders: readonly Collider[];
      readonly bounds: readonly { x: number; y: number; z: number; r: number }[];
      queryIndices(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[];
    },
  ) {
    this.config = { ...DEFAULT_SEGMENT_TETHER, ...config };
    this.n = this.targetSegments();
    this.p = Array.from({ length: this.n + 1 }, () => new Vector3());
    this.prev = Array.from({ length: this.n + 1 }, () => new Vector3());
    this.lambda = new Float64Array(this.n);
    this.lambdaBend = new Float64Array(this.n + 1);
    this.nodeFlags = new Uint8Array(this.n + 1);
    this.bounds = colliders.map(colliderBounds);
  }

  setBuoyancy(b: TetherBuoyancy): void {
    this.config.wetWeight = TETHER_BUOYANCY[b];
  }

  /** Quantos segmentos o cabo pago pede: ~targetSegmentLength cada, entre o mínimo e o teto. */
  private targetSegments(): number {
    const c = this.config;
    const min = Math.max(4, Math.round(c.segments));
    return Math.min(Math.max(min, c.maxSegments), Math.max(min, Math.round(this.payout / c.targetSegmentLength)));
  }

  /**
   * Troca a resolução do cabo sem mudar sua forma: reamostro a curva atual por
   * comprimento de arco em `m` segmentos iguais. A posição anterior (prev) é
   * reamostrada nos mesmos parâmetros, então a velocidade de cada trecho também
   * se mantém — o cabo não dá saltos quando o guincho paga ou recolhe.
   */
  private remesh(m: number): void {
    // Reamostragem pelo índice fracionário dos nós (o nó novo i fica na posição
    // i·n/m da cadeia antiga), não por comprimento de arco uniforme. Assim cada
    // trecho mantém a sua deformação e o seu espaçamento: onde o cabo estava
    // folgado continua folgado, onde estava esticado continua esticado, e um
    // trecho curto dobrado na quina do casco continua curto. Com arco uniforme,
    // a corda nova junto ao ROV cortava a quina e o contato reacomodava o cabo
    // ~25 cm num passo. p e prev usam os mesmos parâmetros, então a velocidade
    // de cada ponto é preservada.
    const n = this.n;
    const at = (src: Vector3[], u: number): Vector3 => {
      const j = Math.min(n - 1, Math.floor(u));
      return new Vector3().lerpVectors(src[j], src[j + 1], Math.min(1, Math.max(0, u - j)));
    };
    const newP: Vector3[] = [];
    const newPrev: Vector3[] = [];
    for (let i = 0; i <= m; i++) {
      const u = (i * n) / m;
      newP.push(i === m ? this.p[n].clone() : at(this.p, u));
      newPrev.push(i === m ? this.prev[n].clone() : at(this.prev, u));
    }
    this.n = m;
    this.p = newP;
    this.prev = newPrev;
    this.lambda = new Float64Array(m);
    this.lambdaBend = new Float64Array(m + 1);
    this.nodeFlags = new Uint8Array(m + 1);
    this.debug = null;
  }

  /** Vehicle pose for cable-on-ROV contact (call before each step). */
  setVehicle(position: Vector3, orientation: Quaternion): void {
    this.vehiclePos.copy(position);
    this.vehicleQuat.copy(orientation);
    this.hasVehicle = true;
  }

  get restLength(): number {
    return Math.max(0.05, this.payout / this.n);
  }

  /** Straight-line distance TMS → ROV (m). */
  get chordLength(): number {
    return this.p[0].distanceTo(this.p[this.n]);
  }

  /** Length of tether in excess of the straight line (m): the slack. */
  get slack(): number {
    return Math.max(0, this.payout - this.chordLength);
  }

  /**
   * Lay the chain out between anchor and attach, sagging to absorb extra length.
   * @param sagDirection direction of the bight (unit, world); default straight down.
   *   The simulation lays it aft of the vehicle at release so the cable does not
   *   start inside the ROV body.
   */
  reset(anchor: Vector3, attach: Vector3, sagDirection?: Vector3): void {
    this.anchor.copy(anchor);
    // Resolução de acordo com o cabo pago agora (reset recoloca todos os nós).
    const m = this.targetSegments();
    if (m !== this.n) {
      this.n = m;
      this.p = Array.from({ length: m + 1 }, () => new Vector3());
      this.prev = Array.from({ length: m + 1 }, () => new Vector3());
      this.lambda = new Float64Array(m);
      this.lambdaBend = new Float64Array(m + 1);
      this.nodeFlags = new Uint8Array(m + 1);
      this.debug = null;
    }
    const chord = anchor.distanceTo(attach);
    const extra = Math.max(0, this.payout - chord);
    // Shallow-sag estimate, capped so that no segment starts stretched: the
    // nodes are equally spaced in the parameter, and the end segments of a
    // parabola are the longest (|dP/ds| = √(c² + 16a²) at s = 0, 1). Without the
    // cap a short chord (release under the TMS) began with ~17 % strain at the
    // ends and a ~9 kN segment-tension spike.
    const sagCap = (0.98 * Math.sqrt(Math.max(0, this.payout * this.payout - chord * chord))) / 4;
    const sag = Math.min(Math.sqrt((3 * Math.max(chord, 1) * extra) / 8), sagCap);
    const dir = _c.set(0, -1, 0);
    if (sagDirection && sagDirection.lengthSq() > 1e-12) dir.copy(sagDirection).normalize();
    else if (this.hasVehicle) {
      // Sem direção dada (re-lançamento após teleporte, testes): deito a barriga do
      // cabo para FORA do casco, a partir do centro do ROV em direção à fixação.
      // Com a barriga para baixo e a saída do TMS acima do ROV, o cabo nascia
      // atravessando o veículo — um nó preso "por dentro" que nenhum contato
      // local consegue desenroscar.
      _t.subVectors(attach, this.vehiclePos);
      _t.y = 0;
      if (_t.lengthSq() > 1e-6) dir.copy(_t.normalize()).multiplyScalar(1).add(_a.set(0, -0.3, 0)).normalize();
    }
    for (let i = 0; i <= this.n; i++) {
      const s = i / this.n;
      this.p[i].lerpVectors(anchor, attach, s).addScaledVector(dir, sag * 4 * s * (1 - s));
      if (i > 0 && i < this.n) this.clampToSeabed(this.p[i]);
      this.prev[i].copy(this.p[i]);
    }
    this.nodeFlags.fill(0);
    this.lambda.fill(0);
    this.force.set(0, 0, 0);
    this.tension = 0;
    this.stretch = 0;
    this.lastStretch = 0;
  }

  private clampToSeabed(q: Vector3): boolean {
    const h = this.terrainHeight(q.x, q.z) + this.config.radius;
    if (q.y <= h + 1e-4) {
      q.y = Math.max(q.y, h);
      return true;
    }
    return false;
  }

  step(dt: number, attachWorld: Vector3, attachVelocityWorld: Vector3, out: Vector3): Vector3 {
    void attachVelocityWorld;
    // Ajusto a resolução quando o cabo pago muda o bastante (histerese de ~10 %
    // para não reamostrar a cada passo durante o pagamento/recolhimento).
    const want = this.targetSegments();
    if (this.enabled && Math.abs(want - this.n) >= Math.max(2, Math.ceil(this.n * 0.1))) this.remesh(want);
    const n = this.n;
    const cfg = this.config;
    const p = this.p;
    const prev = this.prev;
    // Robust to teleports / restarts: re-lay the chain.
    if (p[n].distanceToSquared(attachWorld) > 64 || !Number.isFinite(p[n].x)) this.reset(this.anchor, attachWorld);
    if (!this.enabled) {
      p[n].copy(attachWorld);
      prev[n].copy(attachWorld);
      this.force.set(0, 0, 0);
      this.tension = 0;
      return out.set(0, 0, 0);
    }

    const L = this.restLength;
    const segMass = cfg.massPerMeter * L;
    const rho = cfg.waterDensity;
    const dnAreaN = 0.5 * rho * cfg.cdNormal * cfg.diameter * L;
    const dnAreaT = 0.5 * rho * cfg.cdTangent * Math.PI * cfg.diameter * L;
    const dt2 = dt * dt;
    this.lastDt = dt;

    // 1. Integrate interior particles (Verlet) under weight + drag.
    for (let i = 1; i < n; i++) {
      const pi = p[i];
      _v.subVectors(pi, prev[i]).divideScalar(dt); // velocity
      this.current(pi, _c);
      _a.subVectors(_v, _c); // velocity relative to water
      _t.subVectors(p[i + 1], p[i - 1]);
      const tl = _t.length();
      if (tl > 1e-6) _t.divideScalar(tl);
      else _t.set(0, 1, 0);
      const vt = _a.dot(_t);
      _b.copy(_t).multiplyScalar(vt); // tangential part
      _a.sub(_b); // normal part
      const vnLen = _a.length();
      // Drag (cannot reverse the relative velocity within one step: clamp).
      const kN = Math.min((dnAreaN * vnLen) / segMass, 0.9 / dt);
      const kT = Math.min((dnAreaT * Math.abs(vt)) / segMass, 0.9 / dt);
      const ax = -kN * _a.x - kT * _b.x;
      const ay = -kN * _a.y - kT * _b.y - (cfg.wetWeight * L) / segMass;
      const az = -kN * _a.z - kT * _b.z;
      const nx = pi.x + _v.x * dt * 0.998 + ax * dt2;
      const ny = pi.y + _v.y * dt * 0.998 + ay * dt2;
      const nz = pi.z + _v.z * dt * 0.998 + az * dt2;
      prev[i].copy(pi);
      pi.set(nx, ny, nz);
    }
    p[0].copy(this.anchor);
    prev[0].copy(this.anchor);
    p[n].copy(attachWorld);
    prev[n].copy(attachWorld);

    // 2. Rope constraints (unilateral: resist stretching only), XPBD-style.
    const lam = this.lambda;
    lam.fill(0);
    this.lambdaBend.fill(0);
    const alpha = L / cfg.axialStiffness / dt2;
    // Mais segmentos pedem mais iterações para a tração atravessar o cabo inteiro
    // (senão ele fica "elástico" e o esticamento vira tração falsa no ROV).
    // Testei varrer alternando o sentido: converge igual, mas distribui mal os
    // lambdas por segmento e estraga a leitura de tração por trecho — ficou só TMS→ROV.
    // Só o cabo esticado precisa disso: folgado, não há tração para propagar e as
    // iterações-base bastam (300 m de cabo folgado custavam 4× mais à toa).
    const taut = this.stretch > 5e-4 * this.payout || this.tension > 50;
    const iters = taut ? Math.min(48, Math.max(cfg.iterations, Math.ceil(n / 4))) : cfg.iterations;
    for (let it = 0; it < iters; it++) {
      for (let j = 0; j < n; j++) {
        const a = p[j];
        const b = p[j + 1];
        _v.subVectors(a, b);
        const d = _v.length();
        const C = d - L;
        if (C <= 0 || d < 1e-9) continue;
        const wa = j === 0 ? 0 : 1;
        const wb = j + 1 === n ? 0 : 1;
        const wsum = wa + wb;
        if (wsum === 0) {
          // Both ends fixed (n=1 edge case): only record tension.
          lam[j] = -C / alpha;
          continue;
        }
        const dl = (-C - alpha * lam[j]) / (wsum + alpha);
        lam[j] += dl;
        _v.divideScalar(d);
        if (wa) a.addScaledVector(_v, wa * dl);
        if (wb) b.addScaledVector(_v, -wb * dl);
      }
      // Flexão: restrição entre vizinhos de segunda ordem (i−1, i+1), unilateral —
      // só age quando o cabo dobra (distância < 2L); reto e tracionado, não muda nada.
      if (cfg.bendStiffness > 0) this.solveBending(L, dt2);
      // 3. Contacts (every few iterations and at the end).
      // Contatos a cada 2 iterações: a flexão empurra nós contra o casco entre uma
      // passada e outra, e penetrações rasas são resolvidas pela face certa.
      if (it % 2 === 1 || it === iters - 1) this.solveContacts(it === iters - 1);
    }

    // 4. Force on the ROV: local pull of the last segment vs elastic stretch of the whole line.
    let total = 0;
    for (let j = 0; j < n; j++) total += p[j].distanceTo(p[j + 1]);
    this.stretch = Math.max(0, total - this.payout);
    const rate = (this.stretch - this.lastStretch) / dt;
    this.lastStretch = this.stretch;
    // Kelvin–Voigt axial model, damping bounded by the elastic term: a pure
    // viscous term jumped to c·v the instant a slack cable came taut (≈ 20 kN
    // at 1 m/s, clamped to maxForce with only millimetres of stretch), which
    // flashed full-scale tension and tripped the winch protections.
    const tElastic = (cfg.axialStiffness * this.stretch) / Math.max(this.payout, 1);
    const tGlobal = tElastic + Math.min(tElastic, Math.max(0, cfg.axialDamping * rate));
    const tLocal = Math.max(0, -lam[n - 1] / dt2);
    // Weight of the half segment hanging from the termination.
    const tension = Math.min(cfg.maxForce, Math.max(tGlobal, tLocal));
    _v.subVectors(p[n - 1], p[n]);
    const dl = _v.length();
    if (dl > 1e-6) _v.divideScalar(dl);
    else _v.set(0, -1, 0);
    this.tension = Number.isFinite(tension) ? tension : 0;
    this.force.copy(_v).multiplyScalar(this.tension);
    this.force.y -= cfg.wetWeight * L * 0.5;
    if (!Number.isFinite(this.force.x + this.force.y + this.force.z)) this.force.set(0, 0, 0);
    return out.copy(this.force);
  }

  /**
   * Rigidez à flexão no estilo XPBD. Para cada nó interno, a restrição é a
   * distância entre o nó e o ponto médio dos vizinhos (zero = cabo reto). A
   * correção move o nó do meio em direção à corda e os vizinhos no sentido
   * oposto, o que só ENCURTA os segmentos — como a restrição axial só resiste a
   * esticar, a flexão nunca cria tração falsa no ROV (a primeira versão afastava
   * os vizinhos e gerava picos de tração).
   * Rigidez equivalente de uma viga de vão 2L com carga no meio: k = 6·EI/L³.
   * Os lambdas são acumulados por passo, então a rigidez não depende do número
   * de iterações.
   */
  private solveBending(L: number, dt2: number): void {
    const n = this.n;
    const p = this.p;
    const lam = this.lambdaBend;
    const k = (6 * this.config.bendStiffness) / (L * L * L);
    const alpha = 1 / (k * dt2);
    for (let i = 1; i < n; i++) {
      const a = p[i - 1];
      const m = p[i];
      const b = p[i + 1];
      // Vetor do ponto médio dos vizinhos até o nó do meio.
      _v.set((a.x + b.x) * 0.5 - m.x, (a.y + b.y) * 0.5 - m.y, (a.z + b.z) * 0.5 - m.z);
      const C = _v.length();
      if (C < 1e-7) continue;
      _v.divideScalar(C); // direção nó → corda
      // Pesos (massa inversa) e gradientes: nó do meio 1, vizinhos 1/2 cada.
      const wa = i - 1 === 0 ? 0 : 1;
      const wm = 1;
      const wb = i + 1 === n ? 0 : 1;
      const wsum = wm + 0.25 * wa + 0.25 * wb;
      const dl = (C - alpha * lam[i]) / (wsum + alpha);
      lam[i] += dl;
      m.addScaledVector(_v, wm * dl);
      if (wa) a.addScaledVector(_v, -0.5 * wa * dl);
      if (wb) b.addScaledVector(_v, -0.5 * wb * dl);
    }
  }

  private solveContacts(count: boolean): void {
    const n = this.n;
    const r = this.config.radius;
    const flags = this.nodeFlags;
    let seabed = 0;
    let structure = 0;
    let rov = 0;
    let rovContact = this.hasVehicle;
    if (rovContact) {
      _qi.copy(this.vehicleQuat).invert();
      // TMS exit at the vehicle (latched / just released): suspend ROV contact.
      _b.subVectors(this.anchor, this.vehiclePos).applyQuaternion(_qi);
      const m = ROV_ANCHOR_MARGIN + r;
      this.rovContactSuspended =
        Math.abs(_b.x - ROV_BOX.cx) < ROV_BOX.hx + m && Math.abs(_b.y - ROV_BOX.cy) < ROV_BOX.hy + m && Math.abs(_b.z - ROV_BOX.cz) < ROV_BOX.hz + m;
      rovContact = !this.rovContactSuspended;
    } else this.rovContactSuspended = false;
    if (count) flags.fill(0);
    // Trecho livre junto à terminação: mínimo se a fixação está fora do casco.
    this.rovFree = ROV_TERMINATION_FREE;
    if (rovContact) {
      _b.subVectors(this.p[n], this.vehiclePos).applyQuaternion(_qi);
      const inside = Math.abs(_b.x - ROV_BOX.cx) < ROV_BOX.hx + r && Math.abs(_b.y - ROV_BOX.cy) < ROV_BOX.hy + r && Math.abs(_b.z - ROV_BOX.cz) < ROV_BOX.hz + r;
      if (inside) this.rovFree = ROV_TERMINATION_FREE_INSIDE;
    }
    // Seabed colliders near the cable: one grid query for the cable's xz bounding box.
    const near = this.nearIdx;
    near.length = 0;
    if (this.field) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 1; i < n; i++) {
        const q = this.p[i];
        if (q.x < x0) x0 = q.x;
        if (q.x > x1) x1 = q.x;
        if (q.z < z0) z0 = q.z;
        if (q.z > z1) z1 = q.z;
      }
      this.field.queryIndices(x0 - r, z0 - r, x1 + r, z1 + r, near);
    }
    for (let i = 1; i < n; i++) {
      const q = this.p[i];
      // Seabed (with simple friction: damp the horizontal motion).
      if (this.clampToSeabed(q)) {
        seabed++;
        if (count) flags[i] |= TETHER_CONTACT.seabed;
        const pv = this.prev[i];
        pv.x += (q.x - pv.x) * 0.5;
        pv.z += (q.z - pv.z) * 0.5;
      }
      // Subsea structures.
      for (let k = 0; k < this.colliders.length; k++) {
        const bd = this.bounds[k];
        const reach = bd.r + r;
        if (Math.abs(q.x - bd.x) > reach || Math.abs(q.z - bd.z) > reach || Math.abs(q.y - bd.y) > reach) continue;
        const hit = sphereCollider(q, r, this.colliders[k]);
        if (hit) {
          q.addScaledVector(hit.normal, hit.depth);
          structure++;
          if (count) flags[i] |= TETHER_CONTACT.structure;
        }
      }
      for (let m = 0; m < near.length; m++) {
        const bd = this.field!.bounds[near[m]];
        const reach = bd.r + r;
        if (Math.abs(q.x - bd.x) > reach || Math.abs(q.z - bd.z) > reach || Math.abs(q.y - bd.y) > reach) continue;
        const hit = sphereCollider(q, r, this.field!.colliders[near[m]]);
        if (hit) {
          q.addScaledVector(hit.normal, hit.depth);
          structure++;
          if (count) flags[i] |= TETHER_CONTACT.structure;
        }
      }
      // Casco do ROV. Fica de fora só o trecho do restritor junto à terminação,
      // medido ao longo do cabo (não por índice de nó).
      if (rovContact && (n - i) * this.restLength >= this.rovFree) {
        _b.subVectors(q, this.vehiclePos).applyQuaternion(_qi);
        _o.subVectors(this.prev[i], this.vehiclePos).applyQuaternion(_qi);
        if (this.rovPushOut(_b.x - ROV_BOX.cx, _b.y - ROV_BOX.cy, _b.z - ROV_BOX.cz, _o.x - ROV_BOX.cx, _o.y - ROV_BOX.cy, _o.z - ROV_BOX.cz)) {
          _b.add(_w);
          q.copy(_b.applyQuaternion(this.vehicleQuat).add(this.vehiclePos));
          rov++;
          if (count) flags[i] |= TETHER_CONTACT.rov;
        }
      }
    }
    // Segmentos contra o casco: com elos de 1–2 m, um trecho pode cruzar uma
    // quina do casco com os dois nós do lado de fora. Amostro cada segmento
    // próximo ao ROV a cada ~20 cm e, se uma amostra entrar no casco, empurro os
    // dois nós do segmento (peso proporcional à posição da amostra, como no PBD).
    if (rovContact) rov += this.solveRovSegments(count);
    if (count) this.contacts = { seabed, structure, rov };
    void _q;
  }

  /**
   * Empurra um ponto (no referencial do ROV) para fora do casco. A face de saída
   * é a face por onde ele ENTROU (decidida pela posição do passo anterior, também
   * no referencial do ROV); só se o ponto já estava dentro uso a face mais
   * próxima. Sair sempre pela face mais próxima deixava o cabo "atravessar" o
   * casco: um ponto que passava do meio saía pelo lado oposto. Resultado em _w
   * (deslocamento local); retorna false se o ponto está fora.
   */
  private rovPushOut(lx: number, ly: number, lz: number, ox: number, oy: number, oz: number): boolean {
    const r = this.config.radius;
    const hx = ROV_BOX.hx + r;
    const hy = ROV_BOX.hy + r;
    const hz = ROV_BOX.hz + r;
    const px = hx - Math.abs(lx);
    const py = hy - Math.abs(ly);
    const pz = hz - Math.abs(lz);
    if (px <= 0 || py <= 0 || pz <= 0) return false;
    // De onde veio: eixo(s) em que a posição anterior estava fora; fico com o de
    // maior "folga" anterior (a face realmente atravessada).
    const ex = Math.abs(ox) - hx;
    const ey = Math.abs(oy) - hy;
    const ez = Math.abs(oz) - hz;
    if (ex > 0 || ey > 0 || ez > 0) {
      if (ey >= ex && ey >= ez) _w.set(0, Math.sign(oy || 1) * hy - ly, 0);
      else if (ex >= ez) _w.set(Math.sign(ox || 1) * hx - lx, 0, 0);
      else _w.set(0, 0, Math.sign(oz || 1) * hz - lz);
    } else if (py <= px && py <= pz) _w.set(0, Math.sign(ly || 1) * py, 0);
    else if (px <= pz) _w.set(Math.sign(lx || 1) * px, 0, 0);
    else _w.set(0, 0, Math.sign(lz || 1) * pz);
    return true;
  }

  private solveRovSegments(count: boolean): number {
    const n = this.n;
    const L = this.restLength;
    const r = this.config.radius;
    const flags = this.nodeFlags;
    const pos = this.vehiclePos;
    const reach = ROV_BOX_RADIUS + r + L * 0.5;
    const samples = Math.max(2, Math.ceil(L / ROV_SEGMENT_SAMPLE));
    let hits = 0;
    for (let j = 0; j < n; j++) {
      const a = this.p[j];
      const b = this.p[j + 1];
      _s.addVectors(a, b).multiplyScalar(0.5);
      if (_s.distanceToSquared(pos) > reach * reach) continue;
      for (let k = 1; k < samples; k++) {
        const t = k / samples;
        // Trecho do restritor (perto da terminação) fica livre do contato.
        if ((n - j - t) * L < this.rovFree) break;
        _s.lerpVectors(a, b, t).sub(pos).applyQuaternion(_qi);
        _o.lerpVectors(this.prev[j], this.prev[j + 1], t).sub(pos).applyQuaternion(_qi);
        if (!this.rovPushOut(_s.x - ROV_BOX.cx, _s.y - ROV_BOX.cy, _s.z - ROV_BOX.cz, _o.x - ROV_BOX.cx, _o.y - ROV_BOX.cy, _o.z - ROV_BOX.cz)) continue;
        _w.applyQuaternion(this.vehicleQuat);
        // Nós fixos (saída do TMS e terminação) não se movem.
        const wa = j === 0 ? 0 : 1 - t;
        const wb = j + 1 >= n ? 0 : t;
        const den = wa * wa + wb * wb;
        if (den < 1e-9) continue;
        // Perto de um nó fixo a correção do nó livre é amplificada (1/(1−t)); limito
        // para não injetar saltos — o resto é resolvido nas próximas iterações.
        const ka = Math.min(4, wa / den);
        const kb = Math.min(4, wb / den);
        a.addScaledVector(_w, ka);
        b.addScaledVector(_w, kb);
        hits++;
        if (count) {
          flags[j] |= TETHER_CONTACT.rov;
          flags[j + 1] |= TETHER_CONTACT.rov;
        }
      }
    }
    return hits;
  }

  /**
   * Move the termination node to the vehicle's current attach point (call after
   * the vehicle has integrated its pose, so p[n] — and the rendered end — sit
   * exactly at the termination instead of one step behind). Does not change
   * the force of the step already computed.
   */
  syncAttach(attachWorld: Vector3): void {
    if (!Number.isFinite(attachWorld.x + attachWorld.y + attachWorld.z)) return;
    this.p[this.n].copy(attachWorld);
    this.prev[this.n].copy(attachWorld);
  }

  /**
   * Points for rendering, from the TMS to the ROV (reuses `out`): exactly the
   * n+1 physical nodes (no independent curve). `_points` is accepted for API
   * compatibility and ignored — the renderer should interpolate through these
   * nodes (e.g. Catmull-Rom), which keeps the drawn cable on the physical one.
   */
  polyline(_points = 0, out: Vector3[] = []): Vector3[] {
    out.length = this.n + 1;
    for (let i = 0; i <= this.n; i++) (out[i] ??= new Vector3()).copy(this.p[i]);
    return out;
  }

  /**
   * Engineering diagnostics for a debug overlay: node positions, per-segment
   * tension estimate and strain, per-node contact flags, the force applied at
   * the ROV termination and the scalar state. O(n), no allocation after the
   * first call (the returned object and its arrays are reused — copy what you
   * keep). Read-only: changing the returned data does not affect the physics.
   *
   * Segment tension estimate: max(EA·strain, XPBD constraint force λ/dt²) of the
   * last step, clamped to `maxForce` — the same two measures used for the
   * termination tension; the last segment reports the termination tension.
   */
  debugState(): TetherDebugState {
    const n = this.n;
    const cfg = this.config;
    const d = (this.debug ??= {
      nodes: Array.from({ length: n + 1 }, () => new Vector3()),
      segmentTension: new Float64Array(n),
      segmentStrain: new Float64Array(n),
      nodeContact: new Uint8Array(n + 1),
      attachForce: new Vector3(),
      tension: 0,
      payout: 0,
      chord: 0,
      slack: 0,
      stretch: 0,
      restLength: 0,
      contacts: { seabed: 0, structure: 0, rov: 0 },
      enabled: true,
      rovContactSuspended: false,
    });
    const L = this.restLength;
    const dt2 = this.lastDt * this.lastDt;
    for (let i = 0; i <= n; i++) d.nodes[i].copy(this.p[i]);
    for (let j = 0; j < n; j++) {
      const strain = this.p[j].distanceTo(this.p[j + 1]) / L - 1;
      d.segmentStrain[j] = strain;
      const t = this.enabled ? Math.max(cfg.axialStiffness * Math.max(0, strain), -this.lambda[j] / dt2) : 0;
      d.segmentTension[j] = Number.isFinite(t) ? Math.min(cfg.maxForce, Math.max(0, t)) : 0;
    }
    // Last segment: report the tension actually applied at the termination (its
    // own strain is not representative — node n is re-synced to the vehicle
    // after the solve and the Gauss-Seidel sweep ends on it).
    if (this.enabled) d.segmentTension[n - 1] = this.tension;
    d.nodeContact.set(this.nodeFlags);
    d.attachForce.copy(this.force);
    d.tension = this.tension;
    d.payout = this.payout;
    d.chord = this.chordLength;
    d.slack = this.slack;
    d.stretch = this.stretch;
    d.restLength = L;
    d.contacts.seabed = this.contacts.seabed;
    d.contacts.structure = this.contacts.structure;
    d.contacts.rov = this.contacts.rov;
    d.enabled = this.enabled;
    d.rovContactSuspended = this.rovContactSuspended;
    return d;
  }
}
