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
import { MeshStandardMaterial, Vector3 } from 'three';
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

/** Passo (m) e teto de segmentos do tubo: suave em qualquer comprimento, custo limitado. */
export const TETHER_TUBE_STEP = 0.15;
export const TETHER_TUBE_MAX_SEGMENTS = 1600;

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

/**
 * Segmentos do tubo proporcionais ao comprimento da curva (~15 cm cada). Com
 * poucos segmentos um vão longo aparecia como trechos retos e dobras em ângulo.
 */
export function tetherTubeSegments(curveLength: number, points: number): number {
  return Math.min(TETHER_TUBE_MAX_SEGMENTS, Math.max(64, Math.ceil(curveLength / TETHER_TUBE_STEP), points * 4));
}
