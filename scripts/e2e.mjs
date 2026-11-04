/**
 * Browser smoke test (Playwright/Chromium). Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/e2e.mjs [url] [screenshotDir]
 * Verifies: page loads without console errors, menu → start, pre-dive
 * checklist via keyboard, launch, physics response to keys, camera toggle,
 * mode switching, and (by repositioning the vehicle) an inspection hold.
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
const out = process.argv[3] ?? 'test-results';
mkdirSync(out, { recursive: true });

const errors = [];
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
// Software rendering in CI is slow: use the low preset unless told otherwise.
const quality = process.env.ROV_QUALITY ?? 'low';
await page.addInitScript((q) => {
  try {
    const cur = JSON.parse(localStorage.getItem('rov.settings.v1') || '{}');
    localStorage.setItem('rov.settings.v1', JSON.stringify({ ...cur, graphics: q }));
  } catch {}
}, quality);
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const sleep = (ms) => page.waitForTimeout(ms);
const state = () =>
  page.evaluate(() => {
    const s = window.__ROV__.sim;
    return {
      depth: s.rov.depth,
      x: s.rov.position.x,
      z: s.rov.position.z,
      heading: s.rov.heading,
      vx: s.rov.velocity.x,
      stage: s.mission.stage,
      phase: s.mission.phase,
      crane: s.crane,
      mode: s.controller.mode,
      lights: s.lightsOn,
    };
  });
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else console.log('ok  -', msg);
};

await page.goto(url);
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await sleep(1500);
await page.screenshot({ path: `${out}/01-menu.png` });
await page.getByRole('button', { name: 'Iniciar operação' }).click();
await sleep(800);
check((await state()).stage === 'prep', 'operation starts in preparation stage');
await page.keyboard.press('KeyL');
await sleep(150);
await page.keyboard.press('KeyC');
await sleep(150);
await page.keyboard.press('KeyC');
await sleep(150);
await hold('KeyW', 1000);
await sleep(300);
await page.screenshot({ path: `${out}/02-prep.png` });
await page.keyboard.press('Enter');
await sleep(500);
check((await state()).stage === 'launch', 'checklist complete → launch authorised');
// Fast-forward the crane descent (~15 s of simulated time) by stepping the simulation directly.
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  for (let i = 0; i < 200 && sim.crane !== 'released'; i++) {
    sim.advance(0.25);
    sim.updateMission(0.25, { cameraPosition: { x: 0, y: 0, z: 0 }, cameraDirection: { x: 1, y: 0, z: 0 }, cameraMode: 'external' });
  }
});
await sleep(500);
check((await state()).stage === 'descent', 'released by the crane → descent');
await page.screenshot({ path: `${out}/03-released.png` });

// Physics responds to keys progressively.
const s0 = await state();
await hold('KeyF', 3000);
const s1 = await state();
check(s1.depth > s0.depth + 0.02, `descends with F (${s0.depth.toFixed(1)} → ${s1.depth.toFixed(1)} m)`);
await hold('KeyW', 2500);
const s2 = await state();
check(s2.vx > 0.05, `surges forward with W (vx=${s2.vx.toFixed(2)} m/s)`);
await hold('KeyE', 1500);
const s3 = await state();
check(Math.abs(((s3.heading - s2.heading + 540) % 360) - 180) > 0.5, `turns with E (${s2.heading.toFixed(0)}° → ${s3.heading.toFixed(0)}°)`);
await page.keyboard.press('Digit3');
await sleep(200);
check((await state()).mode === 'depthHold', 'mode switch to DEPTH HOLD');

// Teleport near IP-01 to verify inspection hold & confirm (test shortcut).
await page.evaluate(() => {
  const { sim } = window.__ROV__;
  const ip = sim.mission.config.points[0];
  sim.mission.stage = 'inspection';
  const p = sim.rov.position;
  p.set(ip.target.x + ip.approach.x * 4.2, ip.target.y + ip.approach.y * 4.2 - 0.2, ip.target.z + ip.approach.z * 4.2);
  const yaw = Math.atan2(-ip.approach.z, ip.approach.x) + Math.PI; // face the target
  sim.rov.orientation.setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, 0);
  sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  sim.rov.velocity.set(0, 0, 0);
  sim.rov.angularVelocity.set(0, 0, 0);
  sim.controller.reset();
  sim.lightsOn = true;
  // Aim the pan/tilt unit at the target.
  const dy = ip.target.y - (p.y - 0.18);
  const dh = Math.hypot(ip.target.x - p.x, ip.target.z - p.z) - 1.3;
  window.__ROV__.app.rig.tilt = (Math.atan2(dy, dh) * 180) / Math.PI;
});
await page.keyboard.press('KeyC'); // operational camera
await sleep(1500);
await page.screenshot({ path: `${out}/04-inspection-op.png` });
const ph = await state();
console.log('     inspection phase:', ph.phase);
await page.waitForFunction(() => ['hold', 'confirm'].includes(window.__ROV__.sim.mission.phase), null, { timeout: 20000 }).catch(() => {});
await page.waitForFunction(() => window.__ROV__.sim.mission.phase === 'confirm', null, { timeout: 120000 }).catch(() => {});
check((await state()).phase === 'confirm', 'stable hold on IP-01 → ready to record');
await page.keyboard.press('Enter');
await sleep(300);
check((await page.evaluate(() => window.__ROV__.sim.mission.stats.inspections.length)) === 1, 'inspection IP-01 recorded');
await page.keyboard.press('KeyC');
await sleep(1200);
await page.screenshot({ path: `${out}/05-inspection-ext.png` });

// Pause menu.
await page.keyboard.press('Escape');
await sleep(300);
check(await page.getByText('Operação em pausa').isVisible(), 'pause menu opens with Esc');
await page.screenshot({ path: `${out}/06-pause.png` });
await page.getByRole('button', { name: 'Configurações' }).click();
await sleep(300);
await page.screenshot({ path: `${out}/07-settings.png` });

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
