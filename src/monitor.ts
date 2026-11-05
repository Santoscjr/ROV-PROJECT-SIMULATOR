/**
 * Secondary monitor page. It runs NO simulation: the main window renders into
 * this window's canvas (same scene, same simulation, same frame) and writes a
 * heartbeat; this script only lays out the page and reports a lost link.
 */
const css = `
html,body{margin:0;height:100%;background:#05090c;color:#c9d4dc;font:13px 'IBM Plex Sans',Segoe UI,Arial,sans-serif;overflow:hidden}
#bar{position:fixed;top:0;left:0;right:0;height:30px;display:flex;gap:12px;align-items:center;padding:0 10px;background:#0e161d;border-bottom:1px solid #24323d;z-index:2}
#bar strong{font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.14em;color:#f2a93b}
#bar select{background:#0f171e;color:#c9d4dc;border:1px solid #34495a;border-radius:3px;padding:3px 6px}
#status{font:11px 'IBM Plex Mono',monospace;color:#7d8d99}
#host{position:fixed;top:31px;left:0;right:0;bottom:0}
#view,.sonar-view{width:100%;height:100%;display:block}
#lost{position:fixed;inset:31px 0 0 0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:rgba(5,9,12,.88);font-size:15px;z-index:3}
#lost[hidden]{display:none}
.instr{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;background:#070c10;font-family:'IBM Plex Mono',monospace;color:#e9eff3}
.instr .rd{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 12px;align-content:start}
.instr .rd span{display:block;font-size:10px;letter-spacing:.12em;color:#7d8d99}
.instr .rd b{font-size:22px}
.instr canvas{width:100%;height:100%}
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const w = window as unknown as { __rovHeartbeat?: number };
const lost = document.getElementById('lost')!;
const statusEl = document.getElementById('status')!;
setInterval(() => {
  const beat = w.__rovHeartbeat ?? 0;
  const alive = !!window.opener && !(window.opener as Window).closed && performance.timeOrigin + performance.now() - beat < 2500;
  lost.hidden = alive || beat === 0;
  if (!alive && beat !== 0) statusEl.textContent = 'sem conexão';
}, 1000);
