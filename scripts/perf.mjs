/**
 * Station performance (Playwright/Chromium): measured frame time per station
 * configuration — 1, 2 and 4 main panels, and 4 + 2 (secondary monitor with two
 * panels) — plus draw calls/triangles of the main window. Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/perf.mjs [url] [quality,...]
 * IMPORTANT: headless Chromium renders with SwiftShader (CPU). Absolute numbers
 * are far below a real GPU; use them only to compare configurations.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}
const url = process.argv[2] ?? 'http://localhost:4173/';
const qualities = (process.argv[3] ?? 'low,medium').split(',');
const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const rows = [];
for (const q of qualities) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.addInitScript((q) => {
    if (sessionStorage.getItem('perf')) return;
    sessionStorage.setItem('perf', '1');
    localStorage.setItem('rov.settings.v1', JSON.stringify({ graphics: q, tmsDepth: 90 }));
  }, q);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__ROV__);
  await page.locator('[data-op="free"]').click();
  await page.getByRole('button', { name: 'Iniciar operação' }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  // Place the vehicle at a structure (heaviest typical view).
  await page.evaluate(() => {
    const { sim, site } = window.__ROV__;
    const ip = site.inspectionPoints[0];
    const p = sim.rov.position;
    p.set(ip.target.x + ip.approach.x * 4.2, ip.target.y + ip.approach.y * 4.2 - 0.2, ip.target.z + ip.approach.z * 4.2);
    sim.tms.reset(sim.tmsExit.distanceTo(p) * 1.15 + 6, 'auto');
    sim.tether.reset(sim.tmsExit, sim.attachWorld());
    sim.setMode('depthHold');
  });
  const measure = async (label, p = page) => {
    await p.waitForTimeout(1500);
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          const times = [];
          let last = performance.now();
          const t0 = last;
          const tick = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            if (now - t0 < 5000) requestAnimationFrame(tick);
            else {
              times.sort((a, b) => a - b);
              const avg = times.reduce((a, b) => a + b, 0) / times.length;
              const f = window.__ROV__.app.frameStats;
              res({ frames: times.length, avgMs: +avg.toFixed(1), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(1), fps: +(1000 / avg).toFixed(1), calls: f.calls + f.monitorCalls, tris: f.triangles + f.monitorTriangles, waterPanels: f.waterPanels, secScale: f.secondaryScale });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    rows.push({ quality: q, config: label, ...r });
    
  };
  const set = (patch) => page.evaluate((x) => window.__ROV__.app.store.update(x), patch);
  await set({ layout: 'single', panels: ['operational', 'sonar', 'tether', 'auxiliary'] });
  await measure('1 painel (operacional)');
  await set({ layout: 'dual', panels: ['operational', 'external', 'tether', 'auxiliary'] });
  await measure('2 painéis (op + externa)');
  await set({ layout: 'quad', panels: ['operational', 'external', 'tether', 'auxiliary'] });
  await measure('4 painéis (op, ext, tether, aux)');
  await set({ monitors: [{ layout: 'dual', sources: ['tms', 'external', 'sonar', 'instruments'], locks: [true, true, true, true], instruments: 'compact' }] });
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
  await popup.waitForLoadState();
  await page.bringToFront(); // the main window drives every window; keep it visible
  await measure('4 + 2 (monitor: tms + externa)');
  await set({ panels: ['operational', 'sonar', 'tether', 'auxiliary'] });
  await measure('4 + 2 com sonar no painel 2');
  await popup.close();
  await context.close();
}
console.table(rows);
await browser.close();
