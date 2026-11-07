/**
 * Capturas da v3.3 (tether e identidade) para revisão por uma pessoa.
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/visual-v33.mjs [url] [pasta] [--tether-only]
 *
 * --tether-only roda só as cenas do cabo. Serve para gerar o "antes" com a
 * mesma cena num build da main, que não tem as telas novas.
 *
 * Cada cena prende o ROV numa posição (modo cinemático), paga o cabo e deixa a
 * física assentar antes da captura. Assim o "antes" e o "depois" mostram a
 * mesma geometria.
 *
 * Aviso: o Chromium headless renderiza por software (SwiftShader). As imagens
 * são fiéis ao WebGL, mas o desempenho não representa uma GPU.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'test-results/visual-v33';
const tetherOnly = process.argv.includes('--tether-only');
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

async function newPage(viewport, settings) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('v33')) return;
    sessionStorage.setItem('v33', '1');
    localStorage.setItem('rov.settings.v1', JSON.stringify(s));
  }, settings);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
  return page;
}
const shot = async (page, name, settle = 2000) => {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120000 });
  console.log('  ' + name);
};

// --- Identidade: início, Sobre, Contato (pt-BR e inglês; desktop e celular) ----------
if (!tetherOnly) {
  for (const [lang, vp, tag] of [
    ['pt-BR', { width: 1366, height: 768 }, 'desktop1366'],
    ['pt-BR', { width: 390, height: 844 }, 'mobile390'],
    ['en', { width: 1366, height: 768 }, 'desktop1366'],
    ['en', { width: 390, height: 844 }, 'mobile390'],
  ]) {
    const page = await newPage(vp, { graphics: 'low', language: lang });
    const p = lang === 'en' ? 'en' : 'pt';
    await shot(page, `00-${p}-inicio-${tag}`, 1200);
    await page.locator('[data-a="about"]:visible').first().click();
    await shot(page, `01-${p}-sobre-${tag}`, 600);
    await page.locator('.dedication:visible').first().scrollIntoViewIfNeeded();
    await shot(page, `02-${p}-sobre-dedicatoria-${tag}`, 400);
    await page.locator('[data-a="back"]:visible').first().click();
    await page.locator('[data-a="contact"]:visible').first().click();
    await shot(page, `03-${p}-contato-${tag}`, 600);
    await page.context().close();
  }
}

// --- Tether --------------------------------------------------------------------------
const page = await newPage({ width: 1280, height: 720 }, { graphics: 'medium', tmsDepth: 50 });
await page.locator('[data-op="free"]').click();
await page.getByRole('button', { name: 'Iniciar operação' }).click();
await page.waitForTimeout(800);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__ROV__.sim.crane === 'released', null, { timeout: 15000 });
const set = (patch) => page.evaluate((p) => window.__ROV__.app.store.update(p), patch);

/** Prende o ROV em saída do TMS + (dx, dy, dz), com `payout` m pagos, e assenta `secs` s. */
const scene = (dx, dy, dz, payout, yawDeg, secs, cam) =>
  page.evaluate(
    ([dx, dy, dz, payout, yawDeg, secs, cam]) => {
      const { sim, app } = window.__ROV__;
      const p = sim.rov.position;
      p.copy(sim.tmsExit).add({ x: dx, y: dy, z: dz });
      const yaw = (yawDeg * Math.PI) / 180;
      sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      sim.rov.velocity.set(0, 0, 0);
      sim.rov.angularVelocity.set(0, 0, 0);
      sim.rov.kinematic = true;
      sim.rov.kinematicTarget.copy(p);
      sim.rov.kinematicYaw = yaw;
      sim.tms.reset(payout, 'manual');
      sim.tether.payout = payout;
      sim.tether.reset(sim.tmsExit, sim.attachWorld());
      sim.controller.reset();
      for (let i = 0; i < secs * 4; i++) sim.advance(0.25);
      Object.assign(app.camStates.external, cam);
    },
    [dx, dy, dz, payout, yawDeg, secs, cam],
  );

await set({ layout: 'single', panels: ['external', 'tms', 'tether', 'operational'], panelLocks: [false, false, false, false] });
// 1) Curto: ROV a ~8 m da saída, 20 m pagos.
await scene(-6, -5, 2, 20, 0, 30, { pan: 120, tilt: 14, zoom: 12 });
await shot(page, '10-tether-curto-externa', 2500);
// 2) Folga caindo sobre o ROV (contato com o casco).
await scene(0, -8, 0, 40, 0, 30, { pan: 60, tilt: 25, zoom: 7 });
await shot(page, '11-tether-contato-casco-externa', 2500);
// 3) Saída do restritor de perto (cabo vindo por baixo do veículo).
await scene(-12, -14, 0, 45, 0, 30, { pan: 200, tilt: 8, zoom: 4.5 });
await shot(page, '12-tether-saida-restritor', 2500);
// 4) Longo: 250 m pagos, ROV a 150 m. Vista de engenharia (nós e contatos) + externa.
await scene(-150, -40, 10, 250, 0, 40, { pan: 160, tilt: 12, zoom: 16 });
await shot(page, '13-tether-longo-externa', 3000);
await page.evaluate(() => window.__ROV__.app.toggleTetherDebug());
await shot(page, '14-tether-longo-diagnostico', 2500);
await page.evaluate(() => window.__ROV__.app.toggleTetherDebug());
// 5) Tambor do TMS (mesma capa do cabo livre) e câmera do tether, com cabo pago.
await scene(-10, -6, 0, 60, 0, 20, { pan: 120, tilt: 14, zoom: 12 });
await set({ layout: 'quad', panels: ['tms', 'tether', 'external', 'operational'], panelLocks: [true, true, true, true] });
await shot(page, '15-quad-tms-tether-externa-operacional', 3500);
await set({ layout: 'single', panels: ['tms', 'tether', 'external', 'operational'], panelLocks: [false, false, false, false] });
await shot(page, '16-camera-tms-tambor-e-cabo', 3000);

const stats = await page.evaluate(() => window.__ROV__.app.frameStats);
console.log('frameStats', JSON.stringify(stats));
console.log(errors.length ? `console errors (${errors.length}):\n` + errors.join('\n') : 'no console errors');
await browser.close();
