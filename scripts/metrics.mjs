/**
 * Rendering metrics per graphics preset (draw calls, triangles, geometries,
 * textures, JS heap, load time). Usage: node scripts/metrics.mjs [url]
 * Note: FPS in a headless/software-GL environment is not representative.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await playwright.chromium.launch();
const rows = [];
for (const q of ['low', 'medium', 'high']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((q) => localStorage.setItem('rov.settings.v1', JSON.stringify({ graphics: q })), q);
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => !!window.__ROV__);
  const load = Date.now() - t0;
  await page.evaluate(() => {
    const { sim, app } = window.__ROV__;
    sim.crane = 'released'; sim.rov.kinematic = false;
    sim.rov.position.set(20, -114, -74); sim.lightsOn = true;
    app.state = 'running';
  });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const { app } = window.__ROV__;
    const r = app.renderer.info;
    return { calls: app.frameStats.calls, tris: app.frameStats.triangles, geos: r.memory.geometries, tex: r.memory.textures,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null };
  });
  rows.push({ quality: q, loadMs: load, ...m });
  await page.close();
}
console.table(rows);
await browser.close();
