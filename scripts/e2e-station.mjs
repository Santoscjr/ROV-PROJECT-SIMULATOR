/**
 * v3.1.1 station tests in a real browser (Playwright/Chromium). Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/e2e-station.mjs [url] [outDir]
 * Covers: arrows drive the winch after using a panel selector (1), station
 * persistence across restart and reload (2), locked panels (3), mouse acting on
 * the panel under the pointer (4), quad instruments (5), secondary monitor with
 * two sources + keyboard forwarding (6), monitor close/reopen/reload (7), free
 * mode flow (11) and the seabed-safe Top-Hat depth (12).
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
const out = process.argv[3] ?? 'test-results/station';
mkdirSync(out, { recursive: true });

const errors = [];
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
await page.addInitScript(() => {
  if (sessionStorage.getItem('e2e-init')) return;
  sessionStorage.setItem('e2e-init', '1');
  localStorage.setItem('rov.settings.v1', JSON.stringify({ graphics: 'low' }));
});
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const sleep = (ms, p = page) => p.waitForTimeout(ms);
let fails = 0;
const check = (cond, msg) => {
  if (!cond) {
    fails++;
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else console.log('ok  -', msg);
};
const st = () => page.evaluate(() => window.__ROV__.app.store.get());
const sim = (fn) => page.evaluate(fn);
const startFree = async () => {
  await page.locator('[data-op="free"]').click();
  await page.getByRole('button', { name: 'Iniciar operação' }).click();
  await sleep(500);
};

await page.goto(url);
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await sleep(800);
await startFree();

// (12) Top-Hat at the operator depth, above the seabed.
const th = await sim(() => {
  const s = window.__ROV__.sim;
  return { depth: -s.lars.position.y, crane: s.crane, alt: s.altitude };
});
check(th.crane === 'docked' && Math.abs(th.depth - 50) < 0.1, `free mode starts latched at the configured 50 m (${th.depth.toFixed(1)} m)`);
check(th.alt === null || th.alt > 5, `latched ROV well above the seabed (alt ${th.alt?.toFixed?.(1)} m)`);
await page.keyboard.press('Enter');
await sleep(300);
check((await sim(() => window.__ROV__.sim.crane)) === 'released', 'Enter releases the ROV');

// Station: quad with explicit sources.
await page.evaluate(() => window.__ROV__.app.store.update({ layout: 'quad', panels: ['operational', 'sonar', 'tether', 'auxiliary'] }));
await sleep(400);

// (1) Choose a camera in a panel selector, then the arrows drive the winch.
const sel2 = page.locator('.st-panel').nth(2).locator('select');
await page.locator('.st-panel').nth(2).locator('.st-lock').click(); // unlock panel 3
await sleep(150);
await sel2.selectOption('external');
await sleep(150);
await sel2.focus(); // worst case: selector still focused
const pay0 = await sim(() => window.__ROV__.sim.tms.payout);
await page.keyboard.down('ArrowUp');
await sleep(2500);
await page.keyboard.up('ArrowUp');
await sleep(2000);
let s = await st();
const pay1 = await sim(() => window.__ROV__.sim.tms.payout);
check(pay1 > pay0 + 0.3, `ArrowUp pays out tether after using a panel selector (${pay0.toFixed(1)} → ${pay1.toFixed(1)} m)`);
check(JSON.stringify(s.panels) === JSON.stringify(['operational', 'sonar', 'external', 'auxiliary']), `ArrowUp did not change any panel source (${s.panels.join(',')})`);
await page.keyboard.down('ArrowDown');
await sleep(3000);
await page.keyboard.up('ArrowDown');
await sleep(2000);
const pay2 = await sim(() => window.__ROV__.sim.tms.payout);
check(pay2 < pay1, `ArrowDown hauls in (${pay1.toFixed(1)} → ${pay2.toFixed(1)} m), stops on release`);
const spd = await sim(() => window.__ROV__.sim.tms.speed);
check(Math.abs(spd) < 0.05, `winch stopped after key release (speed ${spd.toFixed(2)} m/s)`);
s = await st();
check(JSON.stringify(s.panels) === JSON.stringify(['operational', 'sonar', 'external', 'auxiliary']), 'ArrowDown did not change any panel source');

// (3) Locked panel: camera shortcuts / device buttons do not change its source.
await page.locator('.st-panel').nth(3).locator('.st-head .st-idx').click(); // activate panel 4 (locked)
await sleep(100);
check((await page.evaluate(() => window.__ROV__.app.activePanel)) === 3, 'clicking a panel header makes it the active panel');
await page.keyboard.press('Digit8'); // camExt
await page.keyboard.press('KeyC'); // toggleCamera
await page.evaluate(() => window.__ROV__.app.handleAction('camTms')); // SpaceMouse/gamepad route
await sleep(200);
s = await st();
check(s.panels[3] === 'auxiliary' && s.panelLocks[3], 'locked panel 4 keeps its source against keyboard and device camera commands');
// Unlocked active panel does follow the shortcut.
await page.mouse.click(300, 200); // panel 1 (unlocked by default)
await page.keyboard.press('Digit6'); // camAux
await sleep(200);
s = await st();
check(s.panels[0] === 'auxiliary', 'unlocked active panel 1 follows the camera shortcut');
await page.keyboard.press('Digit7');
await sleep(200);

// (4) Mouse drag on panel 4 (auxiliary) only moves that camera.
const cam0 = await page.evaluate(() => structuredClone(window.__ROV__.app.camStates));
await page.mouse.move(960, 540);
await page.mouse.down();
await page.mouse.move(1010, 570, { steps: 5 });
await page.mouse.up();
await sleep(100);
const cam1 = await page.evaluate(() => structuredClone(window.__ROV__.app.camStates));
check(cam1.auxiliary.pan !== cam0.auxiliary.pan || cam1.auxiliary.tilt !== cam0.auxiliary.tilt, 'dragging panel 4 moves the auxiliary camera');
check(JSON.stringify(cam1.operational) === JSON.stringify(cam0.operational), 'dragging panel 4 does not move the main (operational) camera');
// Keyboard pan on the active panel (4, auxiliary).
await page.keyboard.down('KeyN');
await sleep(500);
await page.keyboard.up('KeyN');
const cam2 = await page.evaluate(() => structuredClone(window.__ROV__.app.camStates));
check(cam2.auxiliary.pan > cam1.auxiliary.pan && cam2.operational.pan === cam1.operational.pan, 'camera pan key acts on the active panel camera only');

// (5) Quad: essential instruments visible and not overlapping.
await page.screenshot({ path: `${out}/quad.png` });
const ibar = await page.evaluate(() => {
  const bar = document.querySelector('.hud .ibar');
  const vis = bar && getComputedStyle(bar).display !== 'none';
  const items = [...(bar?.children ?? [])].map((d) => ({ k: d.querySelector('span')?.textContent, r: d.getBoundingClientRect().toJSON() }));
  let overlap = false;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].r;
      const b = items[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap = true;
    }
  const inView = items.every((it) => it.r.left >= 0 && it.r.right <= innerWidth && it.r.top >= 0 && it.r.bottom <= innerHeight);
  return { vis, keys: items.map((i) => i.k), overlap, inView };
});
for (const k of ['PROF', 'ALT', 'RUMO', 'PITCH', 'ROLL', 'VEL', 'TETHER'])
  check(ibar.vis && ibar.keys.includes(k), `quad instrument bar shows ${k}`);
check(!ibar.overlap && ibar.inView, 'quad instrument bar items do not overlap and stay on screen');
await page.setViewportSize({ width: 900, height: 600 });
await sleep(300);
const narrow = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.hud .ibar > div')].map((d) => d.getBoundingClientRect());
  return items.every((r) => r.left >= 0 && r.right <= innerWidth);
});
check(narrow, 'instrument bar wraps on a narrow window (900 px) instead of overflowing');
await page.screenshot({ path: `${out}/quad-900.png` });
await page.setViewportSize({ width: 1280, height: 720 });

// (2) Persistence across mission restart.
const before = await st();
await page.keyboard.press('Escape');
await sleep(300);
await page.getByRole('button', { name: 'Reiniciar operação' }).click();
await sleep(600);
let after = await st();
check(after.layout === 'quad' && JSON.stringify(after.panels) === JSON.stringify(before.panels), 'layout and panel sources survive a mission restart');
check(JSON.stringify(after.panelLocks) === JSON.stringify(before.panelLocks), 'panel locks survive a mission restart');
const camR = await page.evaluate(() => structuredClone(window.__ROV__.app.camStates));
check(camR.auxiliary.pan === cam2.auxiliary.pan, 'camera pan/tilt survive a mission restart');

// (11) Free mode basic flow: pilot, pause/resume, camera, sonar visible.
await page.keyboard.press('Enter');
await sleep(200);
const p0 = await sim(() => window.__ROV__.sim.rov.position.clone());
await page.keyboard.down('KeyW');
await sleep(2500);
const vx = await sim(() => window.__ROV__.sim.rov.velocity.x);
await page.keyboard.up('KeyW');
const p1 = await sim(() => ({ ...window.__ROV__.sim.rov.position.clone(), crane: window.__ROV__.sim.crane }));
check(p1.crane === 'released' && vx > 0.05, `free mode after restart: release + ROV responds to W (vx ${vx.toFixed(2)} m/s, moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)} m)`);
await page.keyboard.press('Escape');
await sleep(200);
check(await page.getByText('Operação em pausa').isVisible(), 'free mode: pause menu');
await page.getByRole('button', { name: 'Continuar' }).click();
await sleep(200);
check((await page.evaluate(() => window.__ROV__.app.state)) === 'running', 'free mode: resume');
check(await page.locator('.st-panel .sonar-view').count() === 1, 'sonar panel rendered in the station');

// (6) Secondary monitor: two independent sources, keyboard forwarded to the pilot.
await page.evaluate(() => window.__ROV__.app.store.update({ monitor: { layout: 'dual', sources: ['external', 'tms'], instruments: 'compact' } }));
const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
await popup.waitForLoadState();
await sleep(1500, popup);
const mon = await popup.evaluate(() => ({
  frames: [...document.querySelectorAll('.mp')].filter((f) => !f.hidden).length,
  sources: [...document.querySelectorAll('.mp select')].map((s) => s.value),
  status: document.getElementById('status')?.textContent,
  bar: document.querySelector('.mbar')?.textContent ?? '',
}));
check(mon.frames === 2 && mon.sources[0] === 'external' && mon.sources[1] === 'tms', `monitor shows 2 panels with independent sources (${mon.sources.join(', ')})`);
check(mon.status === 'sincronizado' && mon.bar.includes('PROF'), 'monitor synchronised, compact instrument bar shown');
await popup.screenshot({ path: `${out}/monitor-dual.png` });
// Change panel 2 source from the monitor itself → persisted.
await popup.locator('.mp').nth(1).locator('select').selectOption('sonar');
await sleep(400, popup);
check((await st()).monitor.sources[1] === 'sonar', 'monitor source change is persisted in the main settings');
// Keys typed in the monitor window drive the ROV (single input path).
await popup.bringToFront();
const payA = await sim(() => window.__ROV__.sim.tms.payout);
await popup.keyboard.down('ArrowUp');
await sleep(2500, popup);
await popup.keyboard.up('ArrowUp');
await sleep(500, popup);
const payB = await sim(() => window.__ROV__.sim.tms.payout);
check(payB > payA + 0.2, `ArrowUp typed in the monitor window pays out tether (${payA.toFixed(1)} → ${payB.toFixed(1)} m)`);

// (7) Reload of the monitor page: re-adopted automatically, same sources.
await popup.reload();
await sleep(2500, popup);
const mon2 = await popup.evaluate(() => ({ status: document.getElementById('status')?.textContent, sources: [...document.querySelectorAll('.mp select')].map((s) => s.value) }));
check(mon2.status === 'sincronizado' && mon2.sources[0] === 'external' && mon2.sources[1] === 'sonar', 'monitor reconnects after its own reload with the same sources');
// Close and reopen: restores layout and sources.
await popup.close();
await page.bringToFront();
await page.waitForFunction(() => !window.__ROV__.app.monitor2.isOpen, null, { timeout: 10000 });
const [popup2] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
await popup2.waitForLoadState();
await sleep(1500, popup2);
const mon3 = await popup2.evaluate(() => ({ frames: [...document.querySelectorAll('.mp')].filter((f) => !f.hidden).length, sources: [...document.querySelectorAll('.mp select')].map((s) => s.value) }));
check(mon3.frames === 2 && mon3.sources[0] === 'external' && mon3.sources[1] === 'sonar', 'monitor reopened with the saved layout and sources');
// Main window reload: station restored from storage, monitor re-adopted.
await page.reload();
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await sleep(3500);
after = await st();
check(after.layout === 'quad' && JSON.stringify(after.panels) === JSON.stringify(before.panels), 'station layout/sources restored after a page reload');
const mon4 = await popup2.evaluate(() => document.getElementById('status')?.textContent);
check(mon4 === 'sincronizado', 'monitor re-attached to the reloaded main window');
await popup2.close();

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
console.log(fails ? `${fails} failure(s)` : 'all station checks passed');
await browser.close();
