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

// (5) Quad: essentials in the reserved strip + per-camera overlays; nothing overlaps.
const layoutCheck = () =>
  page.evaluate(() => {
    const R = (e) => e.getBoundingClientRect();
    const vis = (e) => e && !e.hidden && getComputedStyle(e).display !== 'none' && R(e).width > 0;
    const over = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const strip = document.querySelector('.st-strip');
    const keys = [...document.querySelectorAll('.st-strip .ss-read span')].map((x) => x.textContent);
    const stripItems = [...document.querySelectorAll('.st-strip .ss-read > div, .st-strip .ss-mission, .st-strip .ss-alarm')].filter(vis).map(R);
    let stripOverlap = false;
    const reads = [...document.querySelectorAll('.st-strip .ss-read > div')].map(R);
    for (let i = 0; i < reads.length; i++) for (let j = i + 1; j < reads.length; j++) if (over(reads[i], reads[j])) stripOverlap = true;
    const inView = stripItems.every((r) => r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1);
    // Panels never extend under the strip.
    const panels = [...document.querySelectorAll('.st-panel')].filter(vis).map(R);
    const sr = strip && vis(strip) ? R(strip) : null;
    const panelsAbove = !sr || panels.every((p) => p.bottom <= sr.top + 1);
    // Inside every panel: header, overlay top line, alarms, corners and compass do not overlap each other.
    let ovOverlap = [];
    document.querySelectorAll('.st-panel').forEach((f, idx) => {
      if (!vis(f)) return;
      const els = [f.querySelector('.st-head'), ...f.querySelectorAll('.pov-top, .pov-alarm, .pov-bl, .pov-br, .pov-compass')].filter(vis);
      const fr = R(f);
      for (let i = 0; i < els.length; i++) {
        const a = R(els[i]);
        if (a.left < fr.left - 1 || a.right > fr.right + 1 || a.top < fr.top - 1 || a.bottom > fr.bottom + 1) ovOverlap.push(`p${idx + 1}:${els[i].className} fora do painel`);
        for (let j = i + 1; j < els.length; j++) if (over(a, R(els[j]))) ovOverlap.push(`p${idx + 1}:${els[i].className}×${els[j].className}`);
      }
    });
    const hudBoxes = [...document.querySelectorAll('.hud > .panel')].filter(vis).length;
    return { stripVisible: vis(strip), keys, stripOverlap, inView, panelsAbove, ovOverlap, hudBoxes, overlays: document.querySelectorAll('.st-panel .pov').length };
  });
let lc = await layoutCheck();
for (const k of ['PROF', 'ALT', 'RUMO', 'PITCH', 'ROLL', 'VEL', 'TETHER'])
  check(lc.stripVisible && lc.keys.includes(k), `quad: station strip shows ${k}`);
check(lc.hudBoxes === 0 && lc.panelsAbove, `quad: no HUD boxes over the pictures; panels end above the reserved strip (boxes=${lc.hudBoxes})`);
check(!lc.stripOverlap && lc.inView, 'quad: strip items do not overlap and stay on screen');
check(lc.overlays >= 3 && lc.ovOverlap.length === 0, `quad: per-camera overlays without overlaps (${lc.overlays} overlays${lc.ovOverlap.length ? '; ' + lc.ovOverlap.join(', ') : ''})`);
await page.screenshot({ path: `${out}/quad-1280.png` });
// Responsiveness matrix: resolutions × layouts.
for (const [w, h] of [
  [1920, 1080],
  [2560, 1440],
  [1366, 768],
  [1024, 640],
]) {
  await page.setViewportSize({ width: w, height: h });
  for (const layout of ['dual', 'quad']) {
    await page.evaluate((l) => window.__ROV__.app.store.update({ layout: l }), layout);
    await sleep(900);
    lc = await layoutCheck();
    check(lc.stripVisible && !lc.stripOverlap && lc.inView && lc.panelsAbove && lc.ovOverlap.length === 0, `${w}×${h} ${layout}: strip + overlays legible, no overlaps${lc.ovOverlap.length ? ' (' + lc.ovOverlap.join(', ') + ')' : ''}`);
    if (layout === 'quad' && (w === 1366 || w === 1024)) await page.screenshot({ path: `${out}/quad-${w}.png` });
  }
}
await page.setViewportSize({ width: 1280, height: 720 });
await page.evaluate(() => window.__ROV__.app.store.update({ layout: 'quad' }));
await sleep(400);

// (W) Water/effects parity: every camera panel gets the same water pipeline (composite + particles/beams).
await page.evaluate(() => window.__ROV__.app.store.update({ panels: ['operational', 'external', 'tether', 'auxiliary'] }));
await sleep(1200);
check((await page.evaluate(() => window.__ROV__.app.frameStats.waterPanels)) === 4, 'water parity: 4 camera panels → 4 panels drawn with the full water pipeline');
await page.evaluate(() => window.__ROV__.app.store.update({ panels: ['operational', 'sonar', 'external', 'auxiliary'] }));
await sleep(800);

// (C) Camera identity independent of panel position: the external camera orbits from every panel (mouse and keyboard).
const quadCenters = await page.evaluate(() => [...document.querySelectorAll('.st-panel')].slice(0, 4).map((f) => { const r = f.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2 + 20]; }));
for (let p = 0; p < 4; p++) {
  const panels = ['operational', 'tether', 'auxiliary', 'tms'];
  panels[p] = 'external';
  await page.evaluate((x) => window.__ROV__.app.store.update({ panels: x, panelLocks: [false, false, false, false] }), panels);
  await sleep(500);
  const e0 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
  const [cx, cy] = quadCenters[p];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 20, { steps: 5 });
  await page.mouse.up();
  const e1 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
  await page.keyboard.down('KeyN');
  await sleep(500);
  await page.keyboard.up('KeyN');
  await page.keyboard.down('KeyT');
  await sleep(400);
  await page.keyboard.up('KeyT');
  const e2 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
  const op = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.operational }));
  check(e1.pan !== e0.pan && e1.tilt !== e0.tilt, `external camera in panel ${p + 1}: mouse drag orbits it (pan ${e0.pan.toFixed(0)}→${e1.pan.toFixed(0)}°)`);
  check(e2.pan !== e1.pan && e2.tilt !== e1.tilt, `external camera in panel ${p + 1}: keyboard pan/tilt orbit it`);
  check(op.pan === 0, `external camera in panel ${p + 1}: operational camera untouched`);
}
// Orbit persists when the camera moves to another panel (same physical camera).
const ePersist = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
await page.evaluate(() => window.__ROV__.app.store.update({ panels: ['external', 'tether', 'auxiliary', 'tms'] }));
await sleep(1500);
const ePersist2 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
check(JSON.stringify(ePersist) === JSON.stringify(ePersist2), 'external camera keeps its orbit when moved to another panel');
await page.evaluate(() => window.__ROV__.app.store.update({ layout: 'quad', panels: ['operational', 'sonar', 'external', 'auxiliary'], panelLocks: [false, true, true, true] }));
await sleep(400);

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

// (6) Monitor window: independent sources, active panel there, keyboard forwarded, same water pipeline.
await page.evaluate(() => window.__ROV__.app.store.update({ monitors: [{ layout: 'quad', sources: ['external', 'tms', 'sonar', 'instruments'], locks: [true, true, true, true], instruments: 'compact' }] }));
const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
await popup.waitForLoadState();
await sleep(2500, popup);
const mon = await popup.evaluate(() => ({
  frames: [...document.querySelectorAll('.mp')].filter((f) => !f.hidden).length,
  sources: [...document.querySelectorAll('.mp select')].map((s) => s.value),
  status: document.getElementById('status')?.textContent,
  strip: document.querySelector('.mstrip')?.textContent ?? '',
  overlays: document.querySelectorAll('.mp .pov').length,
  instr: !!document.querySelector('.mp .instr'),
  sonar: !!document.querySelector('.mp .sonar-view'),
}));
check(mon.frames === 4 && mon.sources.slice(0, 4).join() === 'external,tms,sonar,instruments', `monitor quad shows 4 independent sources (${mon.sources.join(', ')})`);
check(mon.status === 'sincronizado' && mon.strip.includes('PROF'), 'monitor synchronised, reserved instrument strip shown');
check(mon.overlays === 2 && mon.instr && mon.sonar, 'monitor: overlays on camera panels, sonar and instrumentation rendered');
const wp = await page.evaluate(() => window.__ROV__.app.frameStats.waterPanels);
check(wp >= 4, `water parity across windows: main + monitor camera panels share the pipeline (${wp} panels/frame)`);
await popup.screenshot({ path: `${out}/monitor-quad.png` });
// Mouse on the monitor's external panel orbits the SAME external camera and makes it the active panel.
const me0 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
await popup.mouse.move(320, 220);
await popup.mouse.down();
await popup.mouse.move(400, 250, { steps: 5 });
await popup.mouse.up();
const me1 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external, act: window.__ROV__.app.active }));
check(me1.pan !== me0.pan && me1.act.w === 1 && me1.act.p === 0, 'monitor: dragging its external panel orbits the external camera and activates that panel');
// Keyboard typed in the monitor acts on the monitor's active panel camera (not on the main window).
await popup.bringToFront();
const op0 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.operational }));
await popup.keyboard.down('KeyN');
await sleep(600, popup);
await popup.keyboard.up('KeyN');
const me2 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.external }));
const op1 = await page.evaluate(() => ({ ...window.__ROV__.app.camStates.operational }));
check(me2.pan !== me1.pan && op1.pan === op0.pan, 'monitor: camera keys act on the monitor active panel camera only');
// Locked monitor panel refuses camera shortcuts.
await popup.keyboard.press('Digit7');
await sleep(300, popup);
check((await st()).monitors[0].sources[0] === 'external', 'monitor: locked panel keeps its source against camera shortcuts');
// Winch from the monitor keyboard (single input path, no duplication).
const payA = await sim(() => window.__ROV__.sim.tms.payout);
await popup.keyboard.down('ArrowUp');
await sleep(2500, popup);
await popup.keyboard.up('ArrowUp');
await sleep(500, popup);
const payB = await sim(() => window.__ROV__.sim.tms.payout);
const rate = (payB - payA) / 3;
check(payB > payA + 0.2 && rate < 1.6, `ArrowUp in the monitor pays out once (${payA.toFixed(1)} → ${payB.toFixed(1)} m; ≤ winch max rate, no double input)`);

// (7) Reload of the monitor page: re-adopted automatically, same sources.
await popup.reload();
await sleep(3000, popup);
const mon2 = await popup.evaluate(() => ({ status: document.getElementById('status')?.textContent, sources: [...document.querySelectorAll('.mp select')].map((s) => s.value) }));
check(mon2.status === 'sincronizado' && mon2.sources.slice(0, 4).join() === 'external,tms,sonar,instruments', 'monitor reconnects after its own reload with the same sources');
await popup.close();
await page.bringToFront();
await page.waitForFunction(() => !window.__ROV__.app.monitors.some((m) => m.isOpen), null, { timeout: 10000 });
const [popup2] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.keyboard.press('F8')]);
await popup2.waitForLoadState();
await sleep(2000, popup2);
const mon3 = await popup2.evaluate(() => ({ frames: [...document.querySelectorAll('.mp')].filter((f) => !f.hidden).length, sources: [...document.querySelectorAll('.mp select')].map((s) => s.value) }));
check(mon3.frames === 4 && mon3.sources.slice(0, 4).join() === 'external,tms,sonar,instruments', 'monitor reopened with the saved layout and sources');
// Main window reload: station restored from storage, monitor re-adopted.
const before2 = await st();
await page.reload();
await page.waitForFunction(() => !!window.__ROV__, null, { timeout: 30000 });
await sleep(5000);
const after2 = await st();
check(after2.layout === before2.layout && JSON.stringify(after2.panels) === JSON.stringify(before2.panels) && JSON.stringify(after2.camState) === JSON.stringify(before2.camState), 'station layout/sources/camera states restored after a page reload');
const mon4 = await popup2.evaluate(() => document.getElementById('status')?.textContent);
check(mon4 === 'sincronizado', 'monitor re-attached to the reloaded main window');
await popup2.close();

// (P) Offshore profile from the start screen: 3-screen station.
await page.selectOption('[data-q="profile"]', 'offshore');
await sleep(300);
const prof = await st();
check(prof.stationProfile === 'offshore' && prof.layout === 'quad' && prof.panels.join() === 'tether,tms,operational,auxiliary' && prof.monitors.length === 2, 'offshore profile: quad tether/TMS/main/aux + sonar monitor + instruments monitor');
const ver = await page.locator('[data-o="build"]').textContent();
check(/v\d+\.\d+\.\d+(-[\w.]+)? · [0-9a-f]{7}/.test(ver ?? ''), `start screen shows version + commit (${ver})`);

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
console.log(fails ? `${fails} failure(s)` : 'all station checks passed');
await browser.close();
