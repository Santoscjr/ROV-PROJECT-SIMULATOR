/**
 * Secondary monitor page. It runs NO simulation: the main window renders into
 * this window's canvas (same scene, same simulation, same frame) and writes a
 * heartbeat; this script only lays out the page and reports a lost link.
 */
const css = `
html,body{margin:0;height:100%;background:#05090c;color:#c9d4dc;font:13px 'IBM Plex Sans',Segoe UI,Arial,sans-serif;overflow:hidden}
#bar{position:fixed;top:0;left:0;right:0;height:30px;display:flex;gap:12px;align-items:center;padding:0 10px;background:#0e161d;border-bottom:1px solid #24323d;z-index:2}
#bar strong{font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.14em;color:#f2a93b}
#bar label{display:flex;gap:6px;align-items:center;font-size:11px;color:#7d8d99}
#bar select{background:#0f171e;color:#c9d4dc;border:1px solid #34495a;border-radius:3px;padding:3px 6px}
#status{font:11px 'IBM Plex Mono',monospace;color:#7d8d99}
#host{position:fixed;top:31px;left:0;right:0;bottom:0}
#view{position:absolute;inset:0;width:100%;height:100%;display:block}
.sonar-view{width:100%;height:100%;display:block}
.mp{position:absolute;box-sizing:border-box;border:1px solid rgba(52,73,90,.9);pointer-events:none}
.mp.active{border-color:rgba(120,190,225,.95);box-shadow:inset 0 0 0 1px rgba(120,190,225,.45)}
.mp[hidden]{display:none}
.mp-head{position:absolute;left:6px;top:6px;display:flex;gap:6px;align-items:center;font:600 11px 'IBM Plex Mono',monospace;color:#f2a93b;pointer-events:auto;z-index:2;opacity:.85}
.mp-head:hover{opacity:1}
.mp.active .mp-idx{color:#0b1218;background:#f2a93b;padding:0 4px}
.mp-head select{font-size:11px;background:rgba(14,22,29,.85);color:#c9d4dc;border:1px solid #34495a;border-radius:3px;padding:2px 4px}
.mp-head select:disabled{opacity:.75}
.mp-lock{font:600 10px 'IBM Plex Mono',monospace;padding:2px 6px;border:1px solid #34495a;background:rgba(14,22,29,.85);color:#7d8d99;cursor:pointer}
.mp.locked .mp-lock{color:#f0c060;border-color:rgba(240,192,96,.6)}
.mp-host{position:absolute;inset:30px 0 0 0}
.mstrip{position:absolute;left:0;right:0;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:2px 0;box-sizing:border-box;background:#0a1015;border-top:1px solid #24323d;padding:2px 6px;font-family:'IBM Plex Mono',monospace;white-space:nowrap;overflow:hidden}
.mstrip[hidden]{display:none}
.mstrip div{display:flex;flex-direction:column;padding:0 9px;border-right:1px solid #1f2c36}
.mstrip div:last-child{border-right:0}
.mstrip span{font-size:9px;letter-spacing:.12em;color:#7d8d99}
.mstrip b{font-size:14px;font-weight:600;color:#e9eff3}
.mstrip div.warn b{color:#f0b040}

#lost{position:fixed;inset:31px 0 0 0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:rgba(5,9,12,.88);font-size:15px;z-index:3}
#lost[hidden]{display:none}
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

type Opener = Window & { __rovAdoptMonitor?: (w: Window, index: number) => void };
/** Which monitor this page is (./monitor.html?m=k). */
const monitorIndex = Math.max(0, Math.min(2, Number(new URLSearchParams(location.search).get('m') ?? 0) || 0));
const w = window as unknown as { __rovHeartbeat?: number };
const lost = document.getElementById('lost')!;
const statusEl = document.getElementById('status')!;
/** Ask the main window to (re)adopt this page — on first load, after a reload of
 *  this page, and after the main window itself was reloaded. */
const adopt = (): boolean => {
  try {
    const op = window.opener as Opener | null;
    if (op && !op.closed && typeof op.__rovAdoptMonitor === 'function') {
      op.__rovAdoptMonitor(window, monitorIndex);
      return true;
    }
  } catch {
    /* opener navigated away / cross-origin */
  }
  return false;
};
adopt();
let lastAdopt = performance.now();
setInterval(() => {
  const beat = w.__rovHeartbeat ?? 0;
  const now = performance.timeOrigin + performance.now();
  const alive = !!window.opener && !(window.opener as Window).closed && now - beat < 6000;
  lost.hidden = alive || beat === 0;
  if (!alive && beat !== 0) statusEl.textContent = 'sem conexão';
  // Link lost (main window reloaded): try to be adopted again every 2 s.
  if (!alive && performance.now() - lastAdopt > 2000) {
    lastAdopt = performance.now();
    adopt();
  }
}, 1000);
