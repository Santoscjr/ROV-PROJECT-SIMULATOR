/**
 * Aparência única do tether, do tambor do TMS até o ROV.
 *
 * Antes da v3.3 o cabo enrolado no tambor era cinza-escuro (textura própria) e
 * os trechos tambor → level-wind → guia usavam a borracha preta do modelo,
 * enquanto o cabo livre era amarelo. No equipamento real é o mesmo cabo, então
 * a cor, a rugosidade e o diâmetro saem daqui para os dois modelos.
 *
 * Amarelo foi mantido porque capa de poliuretano amarela (ou laranja) é comum
 * em tethers de ROVs work-class: o cabo precisa aparecer nas câmeras e para a
 * equipe no convés. O diâmetro é o mesmo usado pela física.
 */
import { Box3, BufferAttribute, BufferGeometry, CatmullRomCurve3, MeshStandardMaterial, Sphere, Vector3 } from 'three';
import { DEFAULT_SEGMENT_TETHER } from '../physics/segmentTether';

export const TETHER_LOOK = {
  /** Cor da capa (sRGB). */
  color: 0xd9a42a,
  /** A mesma cor em CSS, para as texturas desenhadas em canvas. */
  colorCss: '#d9a42a',
  roughness: 0.5,
  metalness: 0,
  /** Raio visual (m) = metade do diâmetro físico. */
  radius: DEFAULT_SEGMENT_TETHER.diameter / 2,
} as const;

/** Material da capa do tether (cada chamada devolve uma instância nova; quem cria descarta). */
export function tetherJacketMaterial(name = 'tether-jacket'): MeshStandardMaterial {
  return new MeshStandardMaterial({ name, color: TETHER_LOOK.color, roughness: TETHER_LOOK.roughness, metalness: TETHER_LOOK.metalness });
}

/** Passo (m) das amostras do arco de saída do restritor. */
const EXIT_ARC_STEP = 0.06;

/**
 * Raio mínimo de curvatura (m) do cabo desenhado fora do restritor: ~10× o
 * diâmetro, ordem de grandeza usual para tethers com capa de poliuretano.
 */
export const TETHER_MIN_BEND_RADIUS = 0.3;

const _a = new Vector3();
const _n = new Vector3();
const _w = new Vector3();

/**
 * Pontos da curva desenhada: os nós físicos, com a ponta do restritor (`tip`)
 * inserida antes da terminação. A ponta só entra se ficar ENTRE o penúltimo nó
 * e a terminação; com o penúltimo nó mais perto que a ponta, inseri-la criaria
 * um "cotovelo" falso de ida e volta no fim do cabo.
 *
 * Entre a ponta e o penúltimo nó o cabo sai alinhado com o eixo do restritor
 * (é para isso que ele existe), faz um arco de raio controlado e segue reto até
 * o nó. Sem isso a interpolação fazia uma dobra em ângulo logo na saída,
 * principalmente quando o cabo vem por baixo do veículo e precisa subir até o
 * restritor. Todos os nós físicos continuam na curva, exatamente onde a física
 * os pôs; nada é deslocado.
 */
export function tetherRenderPoints(path: readonly Vector3[], tip: Vector3): Vector3[] {
  if (path.length < 2) return path.slice();
  const end = path[path.length - 1];
  const before = path[path.length - 2];
  const tipDist = tip.distanceTo(end);
  const useTip = tipDist > 1e-4 && tipDist < 0.5 && before.distanceTo(end) > tipDist + 0.05;
  if (!useTip) return path.slice();
  const out = path.slice(0, -1);
  out.push(...restrictorExit(tip, _a.subVectors(tip, end).divideScalar(tipDist), before).reverse());
  out.push(tip.clone(), end);
  return out;
}

/**
 * Arco tangente ao eixo do restritor na ponta, seguido da reta tangente até o
 * penúltimo nó (construção de concordância no plano eixo–nó). Devolve os pontos
 * do arco, da ponta para fora (sem a ponta e sem o nó).
 */
function restrictorExit(tip: Vector3, axis: Vector3, node: Vector3): Vector3[] {
  _w.subVectors(node, tip);
  const bx = _w.dot(axis);
  _n.copy(_w).addScaledVector(axis, -bx);
  const by = _n.length();
  // Nó praticamente no prolongamento do eixo: reta, sem arco.
  if (by < 1e-3 || Math.atan2(by, bx) < 0.05) return [];
  _n.divideScalar(by);
  const w2 = bx * bx + by * by;
  // Raio: proporcional à distância até o nó, nunca abaixo do mínimo do cabo,
  // e menor que o do círculo que passaria pelo nó (senão não há reta tangente).
  const rThrough = w2 / (2 * by);
  const R = Math.min(Math.max(TETHER_MIN_BEND_RADIUS, 0.35 * Math.sqrt(w2)), 1, 0.95 * rThrough);
  // No plano (eixo, n): centro em (0, R); ponto do arco P(φ) = (R sen φ, R − R cos φ),
  // tangente (cos φ, sen φ). Procura o φ em que a tangente aponta para o nó.
  const f = (phi: number) => {
    const px = R * Math.sin(phi);
    const py = R - R * Math.cos(phi);
    return (bx - px) * Math.sin(phi) - (by - py) * Math.cos(phi);
  };
  let lo = 0;
  let hi = 0;
  const dphi = 0.02;
  let found = false;
  for (let phi = dphi; phi < 1.9 * Math.PI; phi += dphi) {
    if (f(phi - dphi) <= 0 && f(phi) > 0) {
      lo = phi - dphi;
      hi = phi;
      found = true;
      break;
    }
  }
  if (!found) return [];
  for (let k = 0; k < 30; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  const phiEnd = 0.5 * (lo + hi);
  const steps = Math.max(2, Math.ceil((R * phiEnd) / EXIT_ARC_STEP));
  const pts: Vector3[] = [];
  for (let k = 1; k <= steps; k++) {
    const phi = (phiEnd * k) / steps;
    pts.push(
      new Vector3()
        .copy(tip)
        .addScaledVector(axis, R * Math.sin(phi))
        .addScaledVector(_n, R - R * Math.cos(phi)),
    );
  }
  // Um ponto no meio da reta tangente segura a interpolação reta até o nó.
  const last = pts[pts.length - 1];
  if (last.distanceTo(node) > 2 * EXIT_ARC_STEP) pts.push(new Vector3().lerpVectors(last, node, 0.5));
  return pts;
}

/** Giro máximo (graus) entre amostras consecutivas da curva desenhada. */
export const TETHER_SAMPLE_MAX_TURN_DEG = 3;
/** Distância máxima (m) entre amostras num trecho reto. */
const SAMPLE_MAX_STEP = 0.75;
const MAX_SUBDIV = 24;

const _t0 = new Vector3();
const _t1 = new Vector3();

/**
 * Amostras da curva desenhada (Catmull-Rom centrípeta pelos pontos de
 * `tetherRenderPoints`). A densidade é adaptativa: cada trecho entre pontos é
 * subdividido pelo quanto o cabo gira ali, não por um passo fixo. Trecho reto
 * de 1,5 m leva 2 amostras; a saída do restritor e as dobras levam várias. Com
 * passo fixo de 15 cm, 250 m de cabo davam 1600 anéis e ~7 ms de CPU por quadro.
 * Os pontos de entrada (nós físicos inclusive) estão todos entre as amostras.
 */
export function sampleTetherCurve(pts: readonly Vector3[], out: Vector3[] = []): Vector3[] {
  const N = pts.length;
  let count = 0;
  const push = (v: Vector3) => {
    (out[count] ??= new Vector3()).copy(v);
    count++;
  };
  if (N < 2) {
    for (const v of pts) push(v);
    out.length = count;
    return out;
  }
  const curve = new CatmullRomCurve3(pts as Vector3[], false, 'centripetal');
  const turnAt = (i: number): number => {
    if (i <= 0 || i >= N - 1) return 0;
    _t0.subVectors(pts[i], pts[i - 1]);
    _t1.subVectors(pts[i + 1], pts[i]);
    const l = _t0.length() * _t1.length();
    return l > 1e-12 ? (Math.acos(Math.min(1, Math.max(-1, _t0.dot(_t1) / l))) * 180) / Math.PI : 0;
  };
  const tmp = new Vector3();
  push(pts[0]);
  for (let i = 0; i < N - 1; i++) {
    const len = pts[i].distanceTo(pts[i + 1]);
    // Giro do trecho: o maior das duas pontas (a spline concentra a dobra perto
    // do nó; pela média, as amostras vizinhas a um nó dobrado ficavam esparsas).
    // A folga de 1,5× cobre o giro da spline ser maior que o das cordas.
    const turn = Math.max(turnAt(i), turnAt(i + 1));
    const k = Math.min(MAX_SUBDIV, Math.max(1, Math.ceil(len / SAMPLE_MAX_STEP), Math.ceil((1.5 * turn) / TETHER_SAMPLE_MAX_TURN_DEG)));
    for (let j = 1; j < k; j++) push(curve.getPoint((i + j / k) / (N - 1), tmp));
    push(pts[i + 1]);
  }
  out.length = count;
  return out;
}

/**
 * Tubo do tether reaproveitando os mesmos buffers a cada quadro (só crescem
 * quando faltam anéis). Os referenciais dos anéis usam transporte paralelo, então
 * o tubo não torce de um quadro para outro.
 */
export class TetherTube {
  readonly geometry = new BufferGeometry();
  private capacity = 0;
  private pos = new Float32Array(0);
  private nrm = new Float32Array(0);
  private readonly n = new Vector3();
  private readonly b = new Vector3();
  private readonly t = new Vector3();
  private readonly tPrev = new Vector3();
  private readonly box = new Box3();

  constructor(
    private readonly radius: number,
    private readonly radial = 8,
  ) {}

  private ensure(rings: number): void {
    if (rings <= this.capacity) return;
    const cap = Math.max(64, Math.ceil(rings * 1.5));
    const R = this.radial + 1; // costura: primeiro e último vértice do anel repetidos
    this.pos = new Float32Array(cap * R * 3);
    this.nrm = new Float32Array(cap * R * 3);
    const idx = new Uint32Array((cap - 1) * this.radial * 6);
    let o = 0;
    for (let i = 0; i < cap - 1; i++)
      for (let j = 0; j < this.radial; j++) {
        const a = i * R + j;
        const b = (i + 1) * R + j;
        idx[o++] = a;
        idx[o++] = b;
        idx[o++] = a + 1;
        idx[o++] = b;
        idx[o++] = b + 1;
        idx[o++] = a + 1;
      }
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.nrm, 3));
    this.geometry.setIndex(new BufferAttribute(idx, 1));
    this.capacity = cap;
  }

  /** Reconstrói o tubo pelas amostras (≥ 2). */
  update(samples: readonly Vector3[]): void {
    const m = samples.length;
    if (m < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensure(m);
    const R = this.radial + 1;
    const { n, b, t, tPrev } = this;
    for (let i = 0; i < m; i++) {
      // Tangente por diferença central (nas pontas, unilateral).
      const a = samples[Math.max(0, i - 1)];
      const c = samples[Math.min(m - 1, i + 1)];
      t.subVectors(c, a);
      if (t.lengthSq() < 1e-16) t.copy(tPrev.lengthSq() > 0 ? tPrev : _t0.set(0, 1, 0));
      t.normalize();
      if (i === 0) {
        // Normal inicial: qualquer perpendicular estável à tangente.
        n.set(Math.abs(t.y) < 0.9 ? 0 : 1, Math.abs(t.y) < 0.9 ? 1 : 0, 0);
      }
      // Transporte paralelo: tira da normal a componente na tangente nova.
      n.addScaledVector(t, -n.dot(t));
      if (n.lengthSq() < 1e-12) {
        // Normal caiu sobre a tangente (dobra de ~180° entre amostras): recomeça.
        n.set(Math.abs(t.x) < 0.9 ? 1 : 0, Math.abs(t.x) < 0.9 ? 0 : 1, 0);
        n.addScaledVector(t, -n.dot(t));
      }
      n.normalize();
      b.crossVectors(t, n);
      const p = samples[i];
      for (let j = 0; j <= this.radial; j++) {
        const ang = (j / this.radial) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const nx = cs * n.x + sn * b.x;
        const ny = cs * n.y + sn * b.y;
        const nz = cs * n.z + sn * b.z;
        const o = (i * R + j) * 3;
        this.nrm[o] = nx;
        this.nrm[o + 1] = ny;
        this.nrm[o + 2] = nz;
        this.pos[o] = p.x + this.radius * nx;
        this.pos[o + 1] = p.y + this.radius * ny;
        this.pos[o + 2] = p.z + this.radius * nz;
      }
      tPrev.copy(t);
    }
    const posAttr = this.geometry.getAttribute('position') as BufferAttribute;
    const nrmAttr = this.geometry.getAttribute('normal') as BufferAttribute;
    posAttr.addUpdateRange(0, m * R * 3);
    nrmAttr.addUpdateRange(0, m * R * 3);
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, (m - 1) * this.radial * 6);
    // Esfera envolvente só das amostras usadas (o buffer tem sobras de quadros
    // anteriores além do drawRange, que computeBoundingSphere() incluiria).
    const box = this.box.makeEmpty();
    for (let i = 0; i < m; i++) box.expandByPoint(samples[i]);
    const sphere = (this.geometry.boundingSphere ??= new Sphere());
    box.getCenter(sphere.center);
    sphere.radius = box.getSize(_t0).length() / 2 + this.radius;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
