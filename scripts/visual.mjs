/**
 * Visual validation (Playwright/Chromium): renders every station view at
 * operating depth and saves screenshots for human review. Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/visual.mjs [url] [outDir]
 * Env: ROV_QUALITY (low|medium|high, default medium), ROV_VIS (comma list of
 * visibility levels, default "clear,turbid").
 * NOTE: headless Chromium uses software GL (SwiftShader); frame rates printed
 * here are NOT representative of a real GPU — they only compare configurations.
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
const levels = (process.env.ROV_VIS ?? 'clear,turbid').split(',');
const views = (process.env.ROV_VIEWS ?? 'operational,auxiliary,tether,tms,external').split(',');
const full = !process.env.ROV_VIEWS;
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => {
  try {
    const cur = JSON.parse(localStorage.getItem('rov.settings.v1') || '{}');
    if (!cur.__visualInit) {
      localStorage.setItem('rov.settings.v1', JSON.stringify({ ...cur, graphics: q, layout: 'single', tmsDepth: 90, __visualInit: true }));
    }
  } catch {}
}, quality);
const sleep = (ms) => page.waitForTimeout(ms);
await page.goto(url);
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await sleep(800);
await page.locator('[data-op="free"]').click();
await page.getByRole('button', { name: 'Iniciar operação' }).click();
await sleep(600);
await page.keyboard.press('Enter'); // release from the Top-Hat
await sleep(300);
// Fly ~10 m away from the Top-Hat (real tether payout), then place the vehicle
// 4 m from inspection point IP-01 (test shortcut) with the tether it would have paid out.
const pos = await page.evaluate(() => {
  const { sim, app } = window.__ROV__;
  sim.setMode('depthHold');
  for (let i = 0; i < 60; i++) {
    sim.command.surge = 0.6;
    sim.advance(0.25);
  }
  sim.command.surge = 0;
  const ip = window.__ROV__.site.inspectionPoints[0];
  const p = sim.rov.position;
  if (ip) {
    p.set(ip.target.x + ip.approach.x * 4.2, ip.target.y + ip.approach.y * 4.2 - 0.2, ip.target.z + ip.approach.z * 4.2);
    const yaw = Math.atan2(-ip.approach.z, ip.approach.x) + Math.PI;
    sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    sim.rov.velocity.set(0, 0, 0);
    sim.rov.angularVelocity.set(0, 0, 0);
    sim.controller.reset();
    sim.tms.reset(sim.tmsExit.distanceTo(p) * 1.15 + 6, 'auto');
    sim.tether.reset(sim.tmsExit, sim.attachWorld());
    const dy = ip.target.y - (p.y - 0.18);
    const dh = Math.hypot(ip.target.x - p.x, ip.target.z - p.z) - 1.3;
    app.rig.tilt = (Math.atan2(dy, dh) * 180) / Math.PI;
  }
  for (let i = 0; i < 24; i++) sim.advance(0.25);
  return { x: p.x.toFixed(1), y: p.y.toFixed(1), z: p.z.toFixed(1), alt: sim.altitude?.toFixed(1), payout: sim.tms.payout.toFixed(1), tms: sim.lars.position.y.toFixed(1), ip: !!ip };
});
console.log('ROV position', pos);

const setStation = (patch) => page.evaluate((p) => window.__ROV__.app.store.update(p), patch);
const shot = async (name, settle = 1800) => {
  await sleep(settle);
  await page.screenshot({ path: `${out}/${name}.png` });
  const fps = await page.evaluate(() => window.__ROV__.app.fps);
  console.log(`  ${name}  (software GL ~${fps.toFixed(1)} fps)`);
};

for (const vis of levels) {
  await setStation({ visibility: vis });
  for (const src of views) {
    await setStation({ layout: 'single', panels: [src, 'sonar', 'tether', 'auxiliary'] });
    await page.evaluate(() => window.__ROV__.app.pass?.resetAdaptation());
    await shot(`${vis}-${src}`);
  }
  if (!full) continue;
  await setStation({ layout: 'quad', panels: ['operational', 'tether', 'external', 'auxiliary'] });
  await shot(`${vis}-quad`, 2500);
}
if (!full) {
  await browser.close();
  process.exit(0);
}
// Secondary monitor (two independent sources).
await setStation({ layout: 'dual', panels: ['operational', 'sonar', 'tether', 'auxiliary'], monitor: { layout: 'dual', sources: ['external', 'tms'], instruments: 'compact' } });
const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]).catch(() => [null]);
if (popup) {
  await popup.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
  await sleep(3000);
  await popup.screenshot({ path: `${out}/monitor-dual.png` });
  console.log('  monitor-dual');
} else console.log('  monitor popup did not open');
await shot('main-dual');
const stats = await page.evaluate(() => ({ ...window.__ROV__.app.frameStats, fps: window.__ROV__.app.fps }));
console.log('frameStats (main window, dual + monitor dual):', stats);
console.log(errors.length ? 'console errors: ' + errors.join(' | ') : 'no console errors');
await browser.close();
