import { describe, expect, it } from 'vitest';
import { CatmullRomCurve3, Quaternion, Vector3 } from 'three';
import { Simulation, FIXED_DT } from '../src/sim/simulation';
import { missionById } from '../src/mission/catalog';
import { terrainHeight } from '../src/sim/terrain';
import { DEFAULT_SEGMENT_TETHER } from '../src/physics/segmentTether';
import { TOPHAT } from '../src/sim/topHat';
import { TETHER_LOOK, TETHER_MIN_BEND_RADIUS, tetherRenderPoints, tetherTubeSegments } from '../src/render/tetherLook';

/**
 * Engenharia do tether (v3.3), cenários do §5 do pedido:
 * perto / meia distância / longe; vão suspenso parado e com corrente; contato
 * com o ROV; mudanças bruscas de direção; guincho pagando e recolhendo;
 * retorno e acoplamento; mudança de profundidade; e a curva desenhada.
 *
 * Em cada cenário verifica: continuidade das âncoras, ausência de penetração
 * no casco, estabilidade numérica, comprimento coerente, ausência de saltos e
 * de "curvas quadradas" (dobra entre segmentos no trecho suspenso).
 */

const DT = FIXED_DT;
/** Caixa de contato do ROV (eixos do veículo), igual à da física. */
const BOX = { cy: -0.05, hx: 1.35, hy: 0.85, hz: 0.85 };
/** Raio em volta da terminação que fica fora da medição (o cabo entra no restritor ali). */
const ATTACH_CLEAR = 0.45;

const _l = new Vector3();
const _q = new Quaternion();

/** Penetração (m) de um ponto na caixa do ROV. */
function boxPen(p: Vector3, pos: Vector3, q: Quaternion): number {
  _l.copy(p).sub(pos).applyQuaternion(_q.copy(q).invert());
  const px = BOX.hx - Math.abs(_l.x);
  const py = BOX.hy - Math.abs(_l.y - BOX.cy);
  const pz = BOX.hz - Math.abs(_l.z);
  return px > 0 && py > 0 && pz > 0 ? Math.min(px, py, pz) : 0;
}

/** Maior penetração do cabo (nós E pontos entre nós) no casco. */
function rovPenetration(sim: Simulation): number {
  const p = sim.tether.p;
  const att = sim.attachWorld();
  const q = new Vector3();
  let pen = 0;
  for (let i = 0; i < p.length - 1; i++)
    for (let s = 0; s <= 10; s++) {
      q.copy(p[i]).lerp(p[i + 1], s / 10);
      if (q.distanceTo(att) < ATTACH_CLEAR) continue;
      pen = Math.max(pen, boxPen(q, sim.rov.position, sim.rov.orientation));
    }
  return pen;
}

/** Maior dobra (graus) entre segmentos vizinhos, só nos nós suspensos (sem contato por perto). */
function suspendedBend(sim: Simulation): number {
  const p = sim.tether.p;
  const contact = sim.tether.debugState().nodeContact;
  const a = new Vector3();
  const b = new Vector3();
  let max = 0;
  for (let i = 2; i < p.length - 2; i++) {
    if (contact[i - 1] || contact[i] || contact[i + 1]) continue;
    a.subVectors(p[i], p[i - 1]).normalize();
    b.subVectors(p[i + 1], p[i]).normalize();
    max = Math.max(max, (Math.acos(Math.min(1, a.dot(b))) * 180) / Math.PI);
  }
  return max;
}

function allFinite(sim: Simulation): boolean {
  return sim.tether.p.every((v) => Number.isFinite(v.x + v.y + v.z)) && Number.isFinite(sim.tether.tension) && Number.isFinite(sim.rov.position.x + sim.rov.position.y + sim.rov.position.z);
}

/** Âncoras: o primeiro nó é a saída do TMS e o último é a terminação no ROV. */
function expectAnchors(sim: Simulation): void {
  const poly = sim.tether.polyline();
  expect(poly[0].distanceTo(sim.tmsExit)).toBeLessThan(1e-6);
  expect(poly[poly.length - 1].distanceTo(sim.attachWorld())).toBeLessThan(1e-6);
}

/** Comprimento coerente: o cabo esticado não passa do pago (alongamento axial pequeno). */
function expectLength(sim: Simulation): void {
  const p = sim.tether.p;
  let arc = 0;
  for (let i = 1; i < p.length; i++) arc += p[i].distanceTo(p[i - 1]);
  expect(arc).toBeLessThanOrEqual(sim.tether.payout * 1.01 + 0.05);
  expect(sim.tether.chordLength).toBeLessThanOrEqual(arc + 1e-6);
}

/** ROV liberado, cabo pago e ROV preso (cinemático) num ponto relativo à saída do TMS. */
function heldSim(payout: number, dx: number, dy: number, current: 'off' | 'normal' | 'strong' = 'off') {
  const sim = new Simulation('stabilize', 'free');
  sim.tmsDepth = 50;
  sim.reset('stabilize', missionById('free'));
  sim.setConditionChoice({ ...sim.conditionChoice, current });
  expect(sim.releaseRov()).toBe(true);
  const target = sim.tmsExit.clone().add(new Vector3(dx, dy, 0));
  // Nunca dentro do fundo: pelo menos 3 m de altitude no ponto.
  target.y = Math.max(target.y, terrainHeight(target.x, target.z) + 3);
  sim.rov.reset(target, sim.lars.yaw);
  sim.tms.reset(payout, 'manual');
  sim.tether.payout = payout;
  sim.tether.reset(sim.tmsExit, sim.attachWorld());
  const hold = () => {
    sim.rov.position.copy(target);
    sim.rov.velocity.set(0, 0, 0);
    sim.rov.angularVelocity.set(0, 0, 0);
  };
  const run = (seconds: number, each?: () => void) => {
    for (let k = 0; k < Math.round(seconds / DT); k++) {
      hold();
      sim.advance(DT);
      each?.();
    }
  };
  return { sim, target, run };
}

/** Maior distância de um ponto à polilinha. */
function distToPolyline(q: Vector3, poly: readonly Vector3[]): number {
  let best = Infinity;
  const ab = new Vector3();
  const aq = new Vector3();
  for (let i = 0; i < poly.length - 1; i++) {
    ab.subVectors(poly[i + 1], poly[i]);
    aq.subVectors(q, poly[i]);
    const t = Math.min(1, Math.max(0, aq.dot(ab) / Math.max(1e-12, ab.lengthSq())));
    best = Math.min(best, aq.addScaledVector(ab, -t).length());
  }
  return best;
}

describe('tether v3.3 — resolução, curvatura e contato (ROV parado)', () => {
  it('§5.1 perto do TMS (20 m): sem penetração, curva suave, âncoras contínuas', () => {
    const { sim, run } = heldSim(20, -5, -3);
    run(30);
    expect(allFinite(sim)).toBe(true);
    expect(rovPenetration(sim)).toBeLessThan(0.03);
    expect(suspendedBend(sim)).toBeLessThan(25);
    expectAnchors(sim);
    expectLength(sim);
  });

  it('§5.2 meia distância (100 m): segmentos de ~1,5 m, dobra suspensa pequena', () => {
    const { sim, run } = heldSim(100, -60, -20);
    run(30);
    expect(allFinite(sim)).toBe(true);
    expect(sim.tether.payout / sim.tether.n).toBeLessThanOrEqual(DEFAULT_SEGMENT_TETHER.targetSegmentLength * 1.1);
    expect(suspendedBend(sim)).toBeLessThan(12);
    expect(rovPenetration(sim)).toBeLessThan(0.03);
    expectAnchors(sim);
    expectLength(sim);
  });

  it('§5.3 longe, tether longo (250 m): resolução adaptativa sem curvas quadradas (antes: 32 nós de 7,8 m)', () => {
    const { sim, run } = heldSim(250, -150, -40);
    run(30);
    expect(allFinite(sim)).toBe(true);
    expect(sim.tether.n).toBeGreaterThan(32);
    expect(sim.tether.n).toBeLessThanOrEqual(DEFAULT_SEGMENT_TETHER.maxSegments);
    expect(sim.tether.payout / sim.tether.n).toBeLessThan(1.7);
    expect(suspendedBend(sim)).toBeLessThan(12);
    expect(rovPenetration(sim)).toBeLessThan(0.03);
    expectAnchors(sim);
    expectLength(sim);
  });

  it('§5.4 vão suspenso em água parada (200 m): catenária suave', () => {
    const { sim, run } = heldSim(200, -150, -60);
    run(30);
    expect(allFinite(sim)).toBe(true);
    expect(suspendedBend(sim)).toBeLessThan(10);
    expectAnchors(sim);
    expectLength(sim);
  });

  it('§5.5 vão suspenso com corrente: a curva muda com a corrente e continua suave', () => {
    const still = heldSim(150, -100, -30, 'off');
    still.run(30);
    const flow = heldSim(150, -100, -30, 'strong');
    flow.run(30);
    expect(allFinite(flow.sim)).toBe(true);
    // Mesmo cabo, mesma geometria: só a corrente desloca o vão.
    const mid = Math.floor(still.sim.tether.n / 2);
    expect(flow.sim.tether.p[mid].distanceTo(still.sim.tether.p[mid])).toBeGreaterThan(0.3);
    expect(suspendedBend(flow.sim)).toBeLessThan(12);
    expect(rovPenetration(flow.sim)).toBeLessThan(0.03);
    expectAnchors(flow.sim);
    expectLength(flow.sim);
  });

  it('§5.6 cabo em contato com o ROV (folga caindo sobre o veículo): não atravessa o casco', () => {
    const short = heldSim(40, 0, -8);
    short.run(30);
    expect(allFinite(short.sim)).toBe(true);
    expect(rovPenetration(short.sim)).toBeLessThan(0.03);
    expectAnchors(short.sim);
    // Folga longa (100 m de sobra) com corrente, empilhando sobre o veículo.
    const pile = heldSim(120, -2, -20, 'normal');
    let worst = 0;
    pile.run(30, () => {
      worst = Math.max(worst, rovPenetration(pile.sim));
    });
    expect(allFinite(pile.sim)).toBe(true);
    expect(worst).toBeLessThan(0.05);
    expect(rovPenetration(pile.sim)).toBeLessThan(0.03);
    expectAnchors(pile.sim);
  });
});

describe('tether v3.3 — dinâmica (ROV em movimento, guincho)', () => {
  it('§5.7 mudanças bruscas de direção a 1,5 m/s: estável, sem saltos, sem penetração', () => {
    const { sim } = heldSim(60, -25, -10);
    for (let k = 0; k < 120 * 10; k++) sim.advance(DT); // assentar (ROV livre, sem comando)
    const v = new Vector3();
    const prev = sim.tether.p.map((p) => p.clone());
    let maxNodeStep = 0;
    let worst = 0;
    for (let k = 0; k < 120 * 16; k++) {
      // Reverte a direção a cada 2 s, alternando eixos (avanço/lateral/vertical).
      const phase = Math.floor(k / 240);
      const s = phase % 2 === 0 ? 1 : -1;
      const axis = Math.floor(phase / 2) % 3;
      v.set(axis === 0 ? 1.5 * s : 0, axis === 2 ? 0.8 * s : 0, axis === 1 ? 1.5 * s : 0);
      sim.rov.position.addScaledVector(v, DT);
      sim.rov.velocity.copy(v);
      sim.rov.angularVelocity.set(0, 0, 0);
      sim.advance(DT);
      const p = sim.tether.p;
      if (p.length === prev.length) for (let i = 0; i < p.length; i++) maxNodeStep = Math.max(maxNodeStep, p[i].distanceTo(prev[i]));
      for (let i = 0; i < p.length; i++) (prev[i] ??= new Vector3()).copy(p[i]);
      prev.length = p.length;
      worst = Math.max(worst, rovPenetration(sim));
    }
    expect(allFinite(sim)).toBe(true);
    // 0,1 m por passo de 1/120 s = 12 m/s: bem acima de qualquer movimento real do cabo aqui.
    expect(maxNodeStep).toBeLessThan(0.1);
    expect(worst).toBeLessThan(0.05);
    expect(sim.tether.tension).toBeLessThan(DEFAULT_SEGMENT_TETHER.maxForce);
    expectAnchors(sim);
  });

  it('§5.8/§5.9 guincho pagando e recolhendo: a resolução acompanha o comprimento sem saltos na forma', () => {
    const { sim, run } = heldSim(30, -20, -8);
    run(10);
    const n0 = sim.tether.n;
    let remeshes = 0;
    let worstJump = 0;
    let worstJumpHull = 0;
    let lastN = sim.tether.n;
    const watch = () => {
      const prevPoly = sim.tether.p.map((p) => p.clone());
      return () => {
        if (sim.tether.n !== lastN) {
          // Recalculada a malha, cada nó novo continua sobre a curva anterior.
          // Junto ao casco (≤ 3 m do centro do ROV) a corda nova pode se
          // reacomodar um pouco na quina; o resto do cabo não pode se mover.
          remeshes++;
          for (const q of sim.tether.p) {
            const d = distToPolyline(q, prevPoly);
            if (q.distanceTo(sim.rov.position) <= 3) worstJumpHull = Math.max(worstJumpHull, d);
            else worstJump = Math.max(worstJump, d);
          }
          lastN = sim.tether.n;
        }
      };
    };
    // Pagando: 30 m → ~200 m (1,5 m/s).
    sim.tms.setCommand(true, false);
    for (let k = 0; k < 120 * 115; k++) {
      const check = watch();
      sim.rov.velocity.set(0, 0, 0);
      sim.advance(DT);
      check();
    }
    const nPaid = sim.tether.n;
    expect(sim.tether.payout).toBeGreaterThan(180);
    expect(nPaid).toBeGreaterThan(n0);
    expect(allFinite(sim)).toBe(true);
    expectAnchors(sim);
    // Recolhendo de volta (1,0 m/s).
    sim.tms.setCommand(false, true);
    for (let k = 0; k < 120 * 170; k++) {
      const check = watch();
      sim.rov.velocity.set(0, 0, 0);
      sim.advance(DT);
      check();
    }
    expect(sim.tether.payout).toBeLessThan(60);
    expect(sim.tether.n).toBeLessThan(nPaid);
    expect(remeshes).toBeGreaterThan(4);
    expect(worstJump).toBeLessThan(0.02);
    // Medido ~8 cm (antes, com reamostragem por arco uniforme: 24–31 cm).
    expect(worstJumpHull).toBeLessThan(0.12);
    expect(allFinite(sim)).toBe(true);
    expectAnchors(sim);
    expectLength(sim);
  }, 30_000);

  it('§5.11 mudança de profundidade (descida de 40 m em AUTO): cabo suave, sem penetração', () => {
    const { sim, run } = heldSim(20, -6, -4);
    sim.tms.reset(20, 'auto');
    // Assenta a folga lançada no reset antes de medir a descida (o transitório
    // de 1–2 s do cabo recém-colocado não é o que este cenário avalia).
    run(8);
    let worst = 0;
    let worstBend = 0;
    for (let k = 0; k < 120 * 60; k++) {
      sim.rov.position.y = Math.max(sim.rov.position.y - 0.6 * DT, terrainHeight(sim.rov.position.x, sim.rov.position.z) + 3);
      sim.rov.velocity.set(0, -0.6, 0);
      sim.rov.angularVelocity.set(0, 0, 0);
      sim.advance(DT);
      if (k % 60 === 0) {
        worst = Math.max(worst, rovPenetration(sim));
        worstBend = Math.max(worstBend, suspendedBend(sim));
      }
    }
    expect(allFinite(sim)).toBe(true);
    expect(sim.tether.payout).toBeGreaterThan(40);
    expect(worst).toBeLessThan(0.03);
    expect(worstBend).toBeLessThan(25);
    expectAnchors(sim);
    expectLength(sim);
  });
});

/** Piloto automático pelos eixos do manche: traz o pino sob o receptáculo e sobe (mesma lógica de operationCycle.test.ts). */
function homingCommand(sim: Simulation) {
  const rec = sim.lars.receptacleWorld(new Vector3());
  const tip = TOPHAT.bulletTop.clone().applyQuaternion(sim.rov.orientation).add(sim.rov.position);
  const e = rec.sub(tip);
  const horiz = Math.hypot(e.x, e.z);
  const below = horiz > 0.3 ? 3 : 0;
  e.y -= below;
  const eb = e.applyQuaternion(new Quaternion().copy(sim.rov.orientation).invert());
  const vb = sim.rov.velocity;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  sim.command.surge = clamp(0.25 * eb.x - 0.8 * vb.x, 0.6);
  sim.command.sway = clamp(0.25 * eb.z - 0.8 * vb.z, 0.6);
  sim.command.heave = clamp(0.3 * eb.y - 1.0 * vb.y, below ? 0.6 : 0.25);
  const tmsHeading = ((90 - (sim.lars.yaw * 180) / Math.PI) % 360 + 360) % 360;
  const he = ((tmsHeading - sim.rov.heading + 540) % 360) - 180;
  sim.command.yaw = Math.abs(he) > 1 ? clamp(he * 0.05, 0.5) : 0;
}

describe('tether v3.3 — retorno e acoplamento', () => {
  it('§5.10 retorno e acoplamento no Top-Hat: âncoras contínuas, sem saltos nem penetração', () => {
    const sim = new Simulation('stabilize', 'free');
    sim.tmsDepth = 50;
    sim.reset('stabilize', missionById('free'));
    expect(sim.releaseRov()).toBe(true);
    // Desce afastado do TMS com o guincho em AUTO, depois volta.
    sim.tms.reset(sim.tms.payout, 'auto');
    for (let k = 0; k < 120 * 25; k++) {
      sim.command.heave = -0.5;
      sim.command.surge = k < 120 * 12 ? 0.4 : 0;
      sim.advance(DT);
    }
    Object.assign(sim.command, { surge: 0, sway: 0, heave: 0, yaw: 0 });
    const prev = sim.tether.p.map((p) => p.clone());
    let maxNodeStep = 0;
    let worst = 0;
    let docked = false;
    for (let k = 0; k < 120 * 240 && !docked; k++) {
      homingCommand(sim);
      const ev = sim.advance(DT);
      docked = ev.docked || sim.lars.state === 'atDepth';
      const p = sim.tether.p;
      if (sim.tether.enabled && p.length === prev.length) for (let i = 0; i < p.length; i++) maxNodeStep = Math.max(maxNodeStep, p[i].distanceTo(prev[i]));
      for (let i = 0; i < p.length; i++) (prev[i] ??= new Vector3()).copy(p[i]);
      prev.length = p.length;
      if (k % 30 === 0 && sim.tether.enabled) worst = Math.max(worst, rovPenetration(sim));
      expect(allFinite(sim)).toBe(true);
    }
    expect(docked).toBe(true);
    expect(maxNodeStep).toBeLessThan(0.1);
    expect(worst).toBeLessThan(0.03);
  }, 30_000);
});

describe('tether v3.3 — curva desenhada e aparência', () => {
  it('a curva desenhada começa na saída do TMS e termina na terminação física (sem deslocamento visual)', () => {
    const { sim, run } = heldSim(250, -150, -40);
    run(20);
    const poly = sim.tether.polyline();
    const end = poly[poly.length - 1];
    // Ponta do restritor ~0,16 m acima da terminação, no eixo do restritor.
    const tip = end.clone().add(new Vector3(0, 0.16, 0));
    const pts = tetherRenderPoints(poly, tip);
    const curve = new CatmullRomCurve3(pts, false, 'centripetal');
    expect(curve.getPoint(0).distanceTo(sim.tmsExit)).toBeLessThan(1e-6);
    expect(curve.getPoint(1).distanceTo(sim.attachWorld())).toBeLessThan(1e-6);
    // Tubo com segmentos proporcionais ao comprimento: ≤ ~20 cm por segmento.
    const segs = tetherTubeSegments(curve.getLength(), pts.length);
    expect(curve.getLength() / segs).toBeLessThan(0.2);
    // Curva desenhada sem dobras em ângulo, inclusive na saída do restritor, onde
    // o cabo vem por baixo do veículo e sobe até a ponta (curva real de >100°).
    const s = curve.getSpacedPoints(segs);
    let maxTurn = 0;
    const a = new Vector3();
    const b = new Vector3();
    // O trecho ponta → terminação fica dentro do restritor (não aparece).
    const inside = Math.ceil((tip.distanceTo(end) / curve.getLength()) * segs) + 1;
    for (let i = 1; i < s.length - 1 - inside; i++) {
      a.subVectors(s[i], s[i - 1]).normalize();
      b.subVectors(s[i + 1], s[i]).normalize();
      maxTurn = Math.max(maxTurn, (Math.acos(Math.min(1, a.dot(b))) * 180) / Math.PI);
    }
    // Critério: nenhuma dobra mais fechada que o raio mínimo do cabo (≈10× o diâmetro).
    // Ângulo máximo entre amostras de passo h para raio R: h/R rad.
    const h = curve.getLength() / segs;
    expect(maxTurn).toBeLessThan(((h / TETHER_MIN_BEND_RADIUS) * 180) / Math.PI);
  });

  it('a ponta do restritor só entra na curva quando fica entre o penúltimo nó e a terminação', () => {
    const end = new Vector3(0, 0, 0);
    const tip = new Vector3(0, 0.16, 0);
    // Penúltimo nó a 1,5 m, de lado: a ponta fica no caminho → entra, com a saída
    // tangente ao eixo do restritor; os nós físicos continuam todos na lista.
    const path = [new Vector3(-3, 3, 0), new Vector3(-1.2, 0.9, 0), end];
    const pts = tetherRenderPoints(path, tip);
    expect(pts.length).toBeGreaterThan(path.length + 1);
    for (const n of path) expect(pts.some((q) => q.distanceTo(n) < 1e-12)).toBe(true);
    expect(pts[pts.length - 2].distanceTo(tip)).toBeLessThan(1e-12);
    expect(pts[pts.length - 1]).toBe(end);
    // Primeiro ponto depois da ponta (indo para fora): sai ao longo do eixo do restritor (+y).
    const out = pts[pts.length - 3].clone().sub(tip).normalize();
    expect(out.y).toBeGreaterThan(0.8);
    // Penúltimo nó mais perto que a ponta: inserir criaria um cotovelo → não entra.
    expect(tetherRenderPoints([new Vector3(0, 3, 0), new Vector3(0.05, 0.05, 0), end], tip)).toHaveLength(3);
  });

  it('cabo do tambor, trechos do TMS e cabo livre usam a mesma capa e o diâmetro físico', () => {
    expect(TETHER_LOOK.radius * 2).toBeCloseTo(DEFAULT_SEGMENT_TETHER.diameter, 6);
    expect(TETHER_LOOK.colorCss.toLowerCase()).toBe(`#${TETHER_LOOK.color.toString(16).padStart(6, '0')}`);
  });
});

describe('tether v3.3 — desempenho', () => {
  it('passo da física com 250 m pagos (n no teto) fica abaixo de 2 ms em média', () => {
    const { sim, run } = heldSim(250, -150, -40);
    run(5);
    expect(sim.tether.n).toBe(DEFAULT_SEGMENT_TETHER.maxSegments);
    const t0 = performance.now();
    run(5);
    const perStep = (performance.now() - t0) / (5 / DT);
    // Medido ~0,25 ms neste ambiente (simulação completa: ROV + tether); folga para CI.
    expect(perStep).toBeLessThan(2);
  });
});
