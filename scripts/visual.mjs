/**
 * Visual evidence (Playwright/Chromium) for review by a person. Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/visual.mjs [url] [outDir]
 * Env: ROV_QUALITY (low|medium|high, default medium).
 * Captures: start screen; main, auxiliary, external, tether and TMS cameras;
 * sonar; instrumentation (full window); 2- and 4-panel layouts; monitor window;
 * clear vs turbid water; a tether/TMS operation sequence (release → pay out →
 * haul in → dock).
 * NOTE: headless Chromium renders with SwiftShader (CPU). Images are faithful
 * to the WebGL output; frame rates are not representative of a GPU.
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
const out = process.argv[3] ?? 'test-results/visual';
const quality = process.env.ROV_QUALITY ?? 'medium';
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => {
  if (sessionStorage.getItem('visual')) return;
  sessionStorage.setItem('visual', '1');
  localStorage.setItem('rov.settings.v1', JSON.stringify({ graphics: q, tmsDepth: 90 }));
}, quality);
const sleep = (ms, p = page) => p.waitForTimeout(ms);
const set = (patch) => page.evaluate((p) => window.__ROV__.app.store.update(p), patch);
const shot = async (name, settle = 2200, p = page) => {
  await sleep(settle, p);
  // Software GL: a frame can take several seconds (first use of a program compiles it).
  await p.screenshot({ path: `${out}/${name}.png`, timeout: 120000 });
  console.log('  ' + name);
};

await page.goto(url);
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await shot('00-tela-inicial', 1500);

await page.locator('[data-op="free"]').click();
await page.getByRole('button', { name: 'Iniciar operação' }).click();
await sleep(600);
await shot('10-acoplado-no-top-hat', 1500);
await page.keyboard.press('Enter'); // release (processed on the next frame)
await page.waitForFunction(() => window.__ROV__.sim.crane === 'released', null, { timeout: 15000 });
// Operation sequence with real commands: pay out and fly away from the Top-Hat.
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  sim.setMode('depthHold');
  sim.tms.reset(sim.tms.payout, 'manual');
  for (let i = 0; i < 60; i++) {
    sim.tms.setCommand(true, false);
    sim.command.surge = 0.5;
    sim.advance(0.25);
  }
  sim.tms.setCommand(false, false);
  sim.command.surge = 0;
});
await set({ layout: 'quad', panels: ['tms', 'tether', 'external', 'operational'], panelLocks: [true, true, true, true] });
await shot('11-tether-pago-quad-tms-tether-externa', 3000);
// Haul in while approaching (TMS camera shows the drum turning; tether camera the cable).
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  for (let i = 0; i < 30; i++) {
    sim.tms.setCommand(false, true);
    sim.command.surge = -0.4;
    sim.advance(0.25);
  }
});
await shot('12-recolhendo-tether', 2000);
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  sim.tms.setCommand(false, false);
  sim.command.surge = 0;
});
// Engineering view of the tether physics (nodes / contacts / attach force).
await page.evaluate(() => window.__ROV__.app.toggleTetherDebug());
await set({ layout: 'single', panels: ['external', 'sonar', 'tether', 'auxiliary'] });
await page.evaluate(() => Object.assign(window.__ROV__.app.camStates.external, { pan: 100, tilt: 18, zoom: 14 }));
await shot('13-fisica-do-tether-diagnostico', 2500);
await page.evaluate(() => window.__ROV__.app.toggleTetherDebug());

// Place the vehicle at a structure (IP-01) with the tether a pilot would have paid out.
await page.evaluate(() => {
  const { sim, site, app } = window.__ROV__;
  const ip = site.inspectionPoints[0];
  const p = sim.rov.position;
  p.set(ip.target.x + ip.approach.x * 4.2, ip.target.y + ip.approach.y * 4.2 - 0.2, ip.target.z + ip.approach.z * 4.2);
  const yaw = Math.atan2(-ip.approach.z, ip.approach.x) + Math.PI;
  sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  sim.rov.velocity.set(0, 0, 0);
  sim.tms.reset(sim.tmsExit.distanceTo(p) * 1.15 + 6, 'auto');
  sim.tether.reset(sim.tmsExit, sim.attachWorld());
  sim.controller.reset();
  const dy = ip.target.y - (p.y - 0.18);
  const dh = Math.hypot(ip.target.x - p.x, ip.target.z - p.z) - 1.3;
  app.rig.tilt = (Math.atan2(dy, dh) * 180) / Math.PI;
  Object.assign(app.camStates.external, { pan: 150, tilt: 12, zoom: 7.5 });
  for (let i = 0; i < 16; i++) sim.advance(0.25);
});

// --- v3.2 environment: rocks, pipeline, structure, sediment resuspension ---------------
const place = (x, y, z, yawDeg) =>
  page.evaluate(
    ([x, y, z, yawDeg]) => {
      const { sim } = window.__ROV__;
      const p = sim.rov.position;
      p.set(x, y, z);
      const yaw = (yawDeg * Math.PI) / 180;
      sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      sim.rov.velocity.set(0, 0, 0);
      sim.rov.angularVelocity.set(0, 0, 0);
      sim.tms.reset(sim.tmsExit.distanceTo(p) * 1.15 + 6, 'auto');
      sim.tether.reset(sim.tmsExit, sim.attachWorld());
      sim.controller.reset();
      window.__ROV__.app.world.sediment.reset();
      for (let i = 0; i < 12; i++) sim.advance(0.25);
    },
    [x, y, z, yawDeg],
  );
// Boulder field: the largest physical rock outside the site, ROV 3 m above, looking at it.
const rock = await page.evaluate(() => {
  const r = [...window.__ROV__.site.rocks].filter((r) => Math.hypot(r.x - 24, r.z + 84) > 40).sort((a, b) => b.size - a.size)[0];
  return { x: r.x, z: r.z, g: r.ground };
});
// yaw 0 → heading 090: the ROV faces east, towards the rock 4.5 m ahead.
await place(rock.x - 4.5, rock.g + 2.25, rock.z, 0);
await page.evaluate(() => (window.__ROV__.app.rig.tilt = -18));
await set({ visibility: 'clear', layout: 'dual', panels: ['operational', 'external', 'tether', 'auxiliary'] });
await page.evaluate(() => Object.assign(window.__ROV__.app.camStates.external, { pan: 235, tilt: 18, zoom: 8 }));
await shot('60-fundo-rochas', 3500);
// Pipeline (route mid-point), ROV 2.5 m above, following it.
const pipe = await page.evaluate(() => {
  const P = window.__ROV__.site.pipelinePath;
  const i = Math.floor(P.length * 0.45);
  const a = P[i];
  const b = P[i + 1];
  return { x: a.x, y: a.y, z: a.z, yaw: (Math.atan2(-(b.z - a.z), b.x - a.x) * 180) / Math.PI };
});
await place(pipe.x, pipe.y + 2.6, pipe.z, pipe.yaw);
await shot('61-duto', 3500);
// Sediment resuspension: ROV ~0.4 m above a muddy seabed, pushing towards the bottom
// for 5 s (vertical jets + skid contact stir the sediment), then stop and watch it drift.
await place(rock.x - 12, rock.g + 0.85, rock.z + 6, 0);
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  sim.setMode('manual');
  for (let i = 0; i < 20; i++) {
    sim.command.heave = -0.7;
    sim.advance(0.25);
    window.__ROV__.app.world.sediment.step(0.25, { amount: sim.rov.seabedDisturbance, x: sim.rov.seabedDisturbancePoint.x, y: sim.rov.seabedDisturbancePoint.y, z: sim.rov.seabedDisturbancePoint.z }, (p, o) => sim.env.current(p, o));
  }
  sim.command.heave = 0;
});
await shot('62-sedimentos-levantados', 2500);
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  sim.setMode('depthHold');
  for (let i = 0; i < 24; i++) {
    sim.advance(0.25);
    window.__ROV__.app.world.sediment.step(0.25, { amount: sim.rov.seabedDisturbance, x: sim.rov.seabedDisturbancePoint.x, y: sim.rov.seabedDisturbancePoint.y, z: sim.rov.seabedDisturbancePoint.z }, (p, o) => sim.env.current(p, o));
  }
});
await shot('63-sedimentos-6s-depois', 2500);
await page.evaluate(() => window.__ROV__.app.world.sediment.reset());
// Back to the structure (IP-01) for the per-camera captures.
await page.evaluate(() => {
  const { sim, site, app } = window.__ROV__;
  const ip = site.inspectionPoints[0];
  const p = sim.rov.position;
  p.set(ip.target.x + ip.approach.x * 4.2, ip.target.y + ip.approach.y * 4.2 - 0.2, ip.target.z + ip.approach.z * 4.2);
  const yaw = Math.atan2(-ip.approach.z, ip.approach.x) + Math.PI;
  sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  sim.rov.velocity.set(0, 0, 0);
  sim.tms.reset(sim.tmsExit.distanceTo(p) * 1.15 + 6, 'auto');
  sim.tether.reset(sim.tmsExit, sim.attachWorld());
  sim.controller.reset();
  sim.setMode('depthHold');
  const dy = ip.target.y - (p.y - 0.18);
  const dh = Math.hypot(ip.target.x - p.x, ip.target.z - p.z) - 1.3;
  app.rig.tilt = (Math.atan2(dy, dh) * 180) / Math.PI;
  Object.assign(app.camStates.external, { pan: 150, tilt: 12, zoom: 7.5 });
  for (let i = 0; i < 16; i++) sim.advance(0.25);
});

for (const vis of ['clear', 'turbid']) {
  await set({ visibility: vis });
  for (const src of ['operational', 'auxiliary', 'external', 'tether', 'tms', 'sonar', 'instruments']) {
    await set({ layout: 'single', panels: [src, 'sonar', 'tether', 'auxiliary'] });
    await page.evaluate(() => window.__ROV__.app.pass?.resetAdaptation());
    if (vis === 'clear' || ['operational', 'external', 'tether', 'tms'].includes(src)) await shot(`2${vis === 'clear' ? '0' : '5'}-${vis === 'clear' ? 'agua-clara' : 'agua-turva'}-${src}`);
  }
  await set({ layout: 'quad', panels: ['tether', 'tms', 'operational', 'auxiliary'] });
  await shot(`${vis === 'clear' ? '30' : '35'}-${vis === 'clear' ? 'agua-clara' : 'agua-turva'}-quad-offshore`, 3000);
}
await set({ visibility: 'clear', layout: 'dual', panels: ['operational', 'external', 'tether', 'auxiliary'] });
await shot('31-dual-principal-externa', 2500);

// Monitor window (2 independent sources + reserved strip).
await set({ monitors: [{ layout: 'dual', sources: ['sonar', 'instruments', 'external', 'tms'], locks: [true, true, true, true], instruments: 'compact' }] });
const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
await popup.setViewportSize({ width: 1280, height: 720 });
// Keep the main window in front: it drives the rendering of every window (a hidden
// main window is throttled by the browser — see PENDÊNCIAS in the report).
await page.bringToFront();
await shot('40-monitor-2-sonar-instrumentacao', 6000, popup);
await page.evaluate(() => {
  const m = structuredClone(window.__ROV__.app.store.get().monitors);
  m[0] = { ...m[0], layout: 'quad', sources: ['external', 'tms', 'auxiliary', 'tether'] };
  window.__ROV__.app.store.update({ monitors: m });
});
await page.bringToFront();
await shot('41-monitor-2-quatro-cameras', 6000, popup);
await page.bringToFront();
const stats = await page.evaluate(() => window.__ROV__.app.frameStats);
console.log('frameStats (main dual + monitor quad):', JSON.stringify(stats));
console.log(errors.length ? 'console errors: ' + errors.join(' | ') : 'no console errors');
await browser.close();
