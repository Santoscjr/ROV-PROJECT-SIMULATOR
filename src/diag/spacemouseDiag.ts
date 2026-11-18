/**
 * SpaceMouse diagnostic page (spacemouse.html). pt-BR UI.
 * `?demo=1` feeds synthetic reports so the page can be checked without hardware.
 */
import './spacemouseDiag.css';
import { AXIS_NAMES } from '../input/types';
import type { AxisName, PilotAction } from '../input/types';
import { buttonBitsFor, buttonName, type ButtonLayout } from '../input/spacemouse/hidParser';
import { RAW_AXES, SpaceMouseDevice, type RawAxis, type SpaceMouseConfig } from '../input/spacemouse/spacemouseDevice';

const RAW_LABEL: Record<RawAxis, [string, string]> = {
  tx: ['TX', 'empurrar lateral'],
  ty: ['TY', 'frente / trás'],
  tz: ['TZ', 'subir / descer'],
  rx: ['RX', 'inclinar frente/trás'],
  ry: ['RY', 'inclinar lateral'],
  rz: ['RZ', 'girar (twist)'],
};

const AXIS_LABEL: Record<AxisName, string> = {
  surge: 'avanço',
  sway: 'lateral',
  heave: 'vertical',
  yaw: 'guinada',
  pitch: 'arfagem',
  roll: 'rolagem',
  camTilt: 'tilt câmera',
};

const ACTIONS: (PilotAction | 'none')[] = [
  'none',
  'toggleCamera',
  'toggleLights',
  'lightsUp',
  'lightsDown',
  'modeManual',
  'modeStabilize',
  'modeDepthHold',
  'cycleMode',
  'camTiltCenter',
  'fineControl',
  'pause',
  'help',
  'confirm',
];

const demo = new URLSearchParams(location.search).has('demo');
const dev = new SpaceMouseDevice();
const supported = SpaceMouseDevice.isSupported();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const hex4 = (n: number) => '0x' + n.toString(16).padStart(4, '0');

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

$('#app').innerHTML = `
<header class="top">
  <h1><span class="tag">HID</span>SpaceMouse — diagnóstico de entrada</h1>
  <div class="spacer"></div>
  <a href="./index.html">← Voltar ao simulador</a>
</header>
<main>
  <section class="panel span-5">
    <h2>Conexão <span class="aux" id="rate">— Hz</span></h2>
    <div class="body">
      <dl class="kv">
        <dt>WebHID</dt><dd id="st-webhid"></dd>
        <dt>Estado</dt><dd id="st-conn"></dd>
        <dt>Dispositivo</dt><dd id="st-name">—</dd>
        <dt>VID : PID</dt><dd id="st-ids">—</dd>
        <dt>Layout botões</dt><dd id="st-layout">—</dd>
        <dt>Último relatório</dt><dd id="st-age">—</dd>
      </dl>
      <div class="actions">
        <button class="primary" id="btn-connect">Conectar SpaceMouse…</button>
        <button id="btn-reconnect">Reabrir autorizado</button>
        <button id="btn-close">Desconectar</button>
      </div>
      <p class="note" id="note-support" hidden></p>
      <p class="note" id="note-silent" hidden>
        Dispositivo aberto, mas nenhum relatório chegou. Mova a tampa. Se continuar assim,
        o driver 3DxWare / 3DxService provavelmente está retendo o dispositivo: encerre-o e reconecte.
      </p>
      <p class="note info" id="note-demo" hidden>Modo demonstração: dados sintéticos, nenhum hardware lido.</p>
    </div>
  </section>

  <section class="panel span-7">
    <h2>Relatório bruto <span class="aux" id="hex-id"></span></h2>
    <div class="body">
      <pre class="hex" id="hex">(aguardando dados)</pre>
      <div class="hex-log" id="hex-log"></div>
      <div class="hex-meta" id="hex-meta">IDs esperados: 0x01 translação (6 B) ou 6 eixos (12 B) · 0x02 rotação (6 B) · 0x03 botões</div>
    </div>
  </section>

  <section class="panel span-6">
    <h2>Eixos brutos <span class="aux">contagens · ±fundo de escala</span></h2>
    <div class="body"><div class="bars" id="raw-bars"></div></div>
  </section>

  <section class="panel span-6">
    <h2>Comandos do piloto <span class="aux">após zona morta / ganho / inversão</span></h2>
    <div class="body"><div class="bars mapped" id="map-bars"></div></div>
  </section>

  <section class="panel span-12">
    <h2>Botões <span class="aux" id="btn-mask">0x00000000</span></h2>
    <div class="body"><div class="btn-grid" id="btn-grid"></div></div>
  </section>

  <section class="panel span-7">
    <h2>Mapeamento de eixos</h2>
    <div class="body">
      <table class="cfg">
        <thead><tr><th>Eixo do dispositivo</th><th>Comanda</th><th>Inverter</th><th>Ganho</th><th>Offset</th></tr></thead>
        <tbody id="cfg-axes"></tbody>
      </table>
    </div>
  </section>

  <section class="panel span-5">
    <h2>Ajustes</h2>
    <div class="body">
      <div class="sliders">
        <label for="sl-dz">Zona morta</label><input type="range" id="sl-dz" min="0" max="0.4" step="0.01"><output id="o-dz"></output>
        <label for="sl-sens">Sensibilidade</label><input type="range" id="sl-sens" min="0.2" max="3" step="0.05"><output id="o-sens"></output>
        <label for="sl-expo">Curva (expo)</label><input type="range" id="sl-expo" min="1" max="3" step="0.05"><output id="o-expo"></output>
        <label for="sl-fs">Fundo de escala</label><input type="range" id="sl-fs" min="150" max="600" step="10"><output id="o-fs"></output>
      </div>
      <div class="actions">
        <button class="primary" id="btn-cal">Calibrar zero (tampa em repouso)</button>
        <button id="btn-cal-clear">Limpar calibração</button>
      </div>
      <div class="actions">
        <button class="primary" id="btn-save">Salvar configuração</button>
        <button id="btn-reset">Restaurar padrão</button>
      </div>
      <div class="status-line" id="cfg-status"></div>
    </div>
  </section>

  <section class="panel span-12">
    <h2>Ações dos botões</h2>
    <div class="body"><div class="btn-grid" id="btn-map" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))"></div></div>
  </section>

  <section class="panel span-12">
    <h2>Gamepad API <span class="aux" id="gp-count">0 detectados</span></h2>
    <div class="body">
      <div id="gp-list"></div>
      <p class="note info">Alguns drivers/navegadores expõem o SpaceMouse como gamepad (controlador multi-eixo, uso HID 0x08).
      O navegador só lista gamepads depois que um botão ou eixo é acionado com a página em foco.</p>
    </div>
  </section>
</main>
<footer>Configuração salva localmente em <code>localStorage["rov.spacemouse.v1"]</code>. Veja docs/SPACEMOUSE.md para os testes com hardware.</footer>
`;

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

interface BarRow {
  fill: HTMLElement;
  dz: HTMLElement;
  val: HTMLElement;
}

function makeBars(container: HTMLElement, names: [string, string][]): BarRow[] {
  return names.map(([n, sub]) => {
    const name = h('div', 'name', n);
    if (sub) name.appendChild(h('small', undefined, sub));
    const bar = h('div', 'bar');
    const dz = h('div', 'dz');
    const fill = h('div', 'fill');
    bar.append(dz, fill);
    const val = h('div', 'val', '0');
    container.append(name, bar, val);
    return { fill, dz, val };
  });
}

function setBar(row: BarRow, norm: number, text: string): void {
  const v = Math.max(-1, Math.min(1, norm));
  const w = Math.abs(v) * 50;
  row.fill.style.left = `${v >= 0 ? 50 : 50 - w}%`;
  row.fill.style.width = `${w}%`;
  row.val.textContent = text;
}

const rawRows = makeBars($('#raw-bars'), RAW_AXES.map((a) => RAW_LABEL[a]));
const mapRows = makeBars($('#map-bars'), AXIS_NAMES.map((a) => [a, AXIS_LABEL[a]] as [string, string]));
mapRows.forEach((r) => (r.dz.style.display = 'none'));

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

let currentLayout: ButtonLayout | null = null;
let btnEls: { bit: number; el: HTMLElement }[] = [];

function buildButtons(layout: ButtonLayout): void {
  if (layout === currentLayout) return;
  currentLayout = layout;
  const grid = $('#btn-grid');
  grid.innerHTML = '';
  btnEls = buttonBitsFor(layout).map((bit) => {
    const el = h('div', 'btn-ind');
    el.append(h('span', undefined, buttonName(bit, layout)), h('span', 'bit', `b${bit}`));
    grid.appendChild(el);
    return { bit, el };
  });
  buildButtonMap(layout);
}

function buildButtonMap(layout: ButtonLayout): void {
  const box = $('#btn-map');
  box.innerHTML = '';
  const cfg = dev.getConfig();
  const bits = layout === 'generic' ? buttonBitsFor('pro') : buttonBitsFor(layout);
  for (const bit of bits) {
    const row = h('div', 'btn-ind');
    row.append(h('span', undefined, `${buttonName(bit, layout === 'generic' ? 'pro' : layout)}`));
    const sel = document.createElement('select');
    for (const a of ACTIONS) {
      const o = document.createElement('option');
      o.value = a;
      o.textContent = a === 'none' ? '— nenhuma —' : a;
      sel.appendChild(o);
    }
    sel.value = cfg.buttons[String(bit)] ?? 'none';
    sel.addEventListener('change', () => {
      const c = dev.getConfig();
      c.buttons[String(bit)] = sel.value as PilotAction | 'none';
      applyConfig(c, false);
    });
    row.appendChild(sel);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Config UI
// ---------------------------------------------------------------------------

const axisInputs: Record<RawAxis, { target: HTMLSelectElement; invert: HTMLInputElement; scale: HTMLInputElement; off: HTMLElement }> =
  {} as never;

(function buildAxisTable() {
  const tbody = $('#cfg-axes');
  for (const a of RAW_AXES) {
    const tr = document.createElement('tr');
    const tdDev = h('td', 'dev', RAW_LABEL[a][0]);
    tdDev.appendChild(h('small', undefined, RAW_LABEL[a][1]));
    const target = document.createElement('select');
    for (const t of ['none', ...AXIS_NAMES]) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t === 'none' ? '— nenhum —' : `${t} (${AXIS_LABEL[t as AxisName]})`;
      target.appendChild(o);
    }
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    const scale = document.createElement('input');
    scale.type = 'number';
    scale.min = '0';
    scale.max = '3';
    scale.step = '0.1';
    scale.style.width = '64px';
    const off = h('span', undefined, '0');
    off.style.fontFamily = 'var(--mono)';
    const cells = [tdDev, h('td'), h('td'), h('td'), h('td')];
    cells[1].appendChild(target);
    cells[2].appendChild(invert);
    cells[3].appendChild(scale);
    cells[4].appendChild(off);
    tr.append(...cells);
    tbody.appendChild(tr);
    axisInputs[a] = { target, invert, scale, off };
    const onChange = () => {
      const c = dev.getConfig();
      c.axes[a] = { target: target.value as AxisName | 'none', invert: invert.checked, scale: Number(scale.value) || 0 };
      applyConfig(c, false);
    };
    target.addEventListener('change', onChange);
    invert.addEventListener('change', onChange);
    scale.addEventListener('change', onChange);
  }
})();

const sliders: [string, keyof SpaceMouseConfig, (v: number) => string][] = [
  ['dz', 'deadzone', (v) => `${Math.round(v * 100)}%`],
  ['sens', 'sensitivity', (v) => `×${v.toFixed(2)}`],
  ['expo', 'expo', (v) => v.toFixed(2)],
  ['fs', 'fullScale', (v) => String(v)],
];
for (const [id, key] of sliders) {
  const input = $<HTMLInputElement>(`#sl-${id}`);
  input.addEventListener('input', () => {
    const c = dev.getConfig();
    (c[key] as number) = Number(input.value);
    applyConfig(c, false);
  });
}

let dirty = false;
function applyConfig(c: SpaceMouseConfig, rebuild = true): void {
  dev.setConfig(c);
  dirty = true;
  syncConfigUi(rebuild);
  setStatus('Alterações não salvas.');
}

function syncConfigUi(rebuildButtons = true): void {
  const c = dev.getConfig();
  for (const a of RAW_AXES) {
    const i = axisInputs[a];
    i.target.value = c.axes[a].target;
    i.invert.checked = c.axes[a].invert;
    i.scale.value = String(c.axes[a].scale);
    i.off.textContent = String(c.offsets[a]);
  }
  for (const [id, key, fmt] of sliders) {
    $<HTMLInputElement>(`#sl-${id}`).value = String(c[key]);
    $(`#o-${id}`).textContent = fmt(c[key] as number);
  }
  // deadzone overlay on raw bars (relative to the calibrated zero)
  for (let k = 0; k < RAW_AXES.length; k++) {
    const off = Math.max(-1, Math.min(1, c.offsets[RAW_AXES[k]] / c.fullScale));
    const left = 50 + (off - c.deadzone) * 50;
    rawRows[k].dz.style.left = `${left}%`;
    rawRows[k].dz.style.width = `${c.deadzone * 100}%`;
  }
  if (rebuildButtons && currentLayout) {
    const l = currentLayout;
    currentLayout = null;
    buildButtons(l);
  }
}

function setStatus(msg: string, cls = ''): void {
  const el = $('#cfg-status');
  el.textContent = msg;
  el.style.color = cls === 'ok' ? 'var(--ok)' : cls === 'warn' ? 'var(--warn)' : '';
}

$('#btn-cal').addEventListener('click', () => {
  dev.calibrate();
  dirty = true;
  syncConfigUi(false);
  setStatus('Zero capturado. Salve para manter.', 'ok');
});
$('#btn-cal-clear').addEventListener('click', () => {
  dev.clearCalibration();
  dirty = true;
  syncConfigUi(false);
  setStatus('Calibração removida.');
});
$('#btn-save').addEventListener('click', () => {
  if (dev.saveConfig()) {
    dirty = false;
    setStatus('Configuração salva neste navegador.', 'ok');
  } else setStatus('Não foi possível salvar (armazenamento bloqueado?).', 'warn');
});
$('#btn-reset').addEventListener('click', () => {
  dev.resetConfig();
  dirty = true;
  syncConfigUi();
  setStatus('Padrões restaurados (ainda não salvos).');
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const btnConnect = $<HTMLButtonElement>('#btn-connect');
const btnReconnect = $<HTMLButtonElement>('#btn-reconnect');
const btnClose = $<HTMLButtonElement>('#btn-close');
let lastError = '';

if (!supported) {
  $('#st-webhid').innerHTML = '<span class="state err">indisponível</span>';
  const note = $('#note-support');
  note.hidden = false;
  note.textContent =
    (SpaceMouseDevice.unsupportedReason() ?? '') +
    ' O simulador continua funcionando com teclado e gamepad; veja também a seção Gamepad API abaixo.';
  btnConnect.disabled = btnReconnect.disabled = true;
} else {
  $('#st-webhid').innerHTML = '<span class="state ok">disponível</span>';
}

btnConnect.addEventListener('click', async () => {
  lastError = '';
  const ok = await dev.requestAndOpen();
  if (!ok && !lastError) lastError = 'Nenhum dispositivo selecionado.';
});
btnReconnect.addEventListener('click', async () => {
  lastError = '';
  if (!(await dev.reconnectGranted())) lastError = 'Nenhum dispositivo autorizado disponível.';
});
btnClose.addEventListener('click', () => void dev.close());

dev.on('error', (e) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  lastError = /NotAllowed|Failed to open/i.test(msg)
    ? `${msg} — o dispositivo pode estar em uso exclusivo pelo driver 3DxWare.`
    : msg;
});
dev.on('connect', () => {
  const info = dev.getInfo();
  if (info) buildButtons(info.layout);
});

if (supported && !demo) void dev.reconnectGranted();

// ---------------------------------------------------------------------------
// Demo feed
// ---------------------------------------------------------------------------

let demoT = 0;
function feedDemo(dt: number): void {
  demoT += dt;
  const t = demoT;
  const dv = new DataView(new ArrayBuffer(12));
  const vals = [
    Math.sin(t * 0.9) * 260,
    -Math.max(0, Math.sin(t * 0.6)) * 330,
    Math.sin(t * 1.3) * 40,
    Math.sin(t * 0.7) * 150,
    6,
    Math.cos(t * 0.5) * 210,
  ];
  vals.forEach((v, i) => dv.setInt16(i * 2, Math.round(v), true));
  dev.ingestReport(1, dv, performance.now());
  if (Math.floor(t * 2) % 7 === 0) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, (1 << 1) | (1 << 13) | (1 << 24), true);
    dev.ingestReport(3, b, performance.now());
  } else if (Math.floor(t * 2) % 7 === 1) {
    dev.ingestReport(3, new DataView(new ArrayBuffer(4)), performance.now());
  }
}
if (demo) {
  $('#note-demo').hidden = false;
  buildButtons('pro');
}

// ---------------------------------------------------------------------------
// Gamepads
// ---------------------------------------------------------------------------

const gpBox = $('#gp-list');
const gpCache = new Map<string, { rows: BarRow[]; btns: HTMLElement }>();
let gpSig: string | null = null;

function renderGamepads(): void {
  const pads = (typeof navigator.getGamepads === 'function' ? Array.from(navigator.getGamepads()) : []).filter(
    (p): p is Gamepad => !!p,
  );
  $('#gp-count').textContent = `${pads.length} detectado${pads.length === 1 ? '' : 's'}`;
  const sig = pads.map((p) => `${p.index}:${p.id}:${p.axes.length}`).join('|');
  if (sig !== gpSig) {
    gpSig = sig;
    gpBox.innerHTML = '';
    gpCache.clear();
    if (!pads.length) gpBox.appendChild(h('div', 'empty', 'Nenhum gamepad visto. Pressione um botão do controle.'));
    for (const p of pads) {
      const card = h('div', 'gp');
      const head = h('div', 'gp-head', `#${p.index} ${p.id} `);
      head.appendChild(h('span', undefined, `· mapping: ${p.mapping || '(nenhum)'} · ${p.axes.length} eixos · ${p.buttons.length} botões`));
      const bars = h('div', 'bars');
      const rows = makeBars(bars, p.axes.map((_, i) => [`a${i}`, ''] as [string, string]));
      rows.forEach((r) => (r.dz.style.display = 'none'));
      const btns = h('div', 'hex-meta');
      card.append(head, bars, btns);
      gpBox.appendChild(card);
      gpCache.set(String(p.index), { rows, btns });
    }
  }
  for (const p of pads) {
    const c = gpCache.get(String(p.index));
    if (!c) continue;
    p.axes.forEach((v, i) => setBar(c.rows[i], v, v.toFixed(3)));
    const pressed = p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
    c.btns.textContent = `botões pressionados: ${pressed.length ? pressed.join(', ') : '—'}`;
  }
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

const fmtSigned = (v: number): string => {
  const s = v.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
};

// Rolling log: last report per ID plus a short history.
const hexLog: string[] = [];
let logDirty = false;
dev.on('report', () => {
  const r = dev.getLastReport();
  if (!r) return;
  const line = `${new Date().toISOString().slice(11, 23)}  [${r.byteLength.toString().padStart(2)} B]  ${r.hex}`;
  hexLog.unshift(line);
  if (hexLog.length > 8) hexLog.length = 8;
  logDirty = true;
});
let logShownAt = 0;

let prev = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (demo) feedDemo(dt);

  const connected = dev.connected();
  const info = dev.getInfo();
  const st = $('#st-conn');
  if (demo) st.innerHTML = '<span class="state warn">demonstração</span>';
  else if (connected) st.innerHTML = '<span class="state ok">conectado</span>';
  else st.innerHTML = `<span class="state">${supported ? 'desconectado' : 'n/d'}</span>`;
  if (lastError && !connected) st.innerHTML += ` <span style="color:var(--warn)">${lastError.replace(/</g, '&lt;')}</span>`;

  $('#st-name').textContent = info?.name ?? (demo ? 'SpaceMouse Pro (simulado)' : '—');
  $('#st-ids').textContent = info
    ? `${hex4(info.vendorId)} : ${hex4(info.productId)}${info.known ? '' : '  (não catalogado)'}`
    : demo
      ? '0x046d : 0xc62b'
      : '—';
  $('#st-layout').textContent = info?.layout ?? (demo ? 'pro' : '—');
  btnClose.disabled = !connected;
  btnConnect.disabled = !supported;

  const age = Math.max(0, dev.msSinceLastReport(performance.now()));
  $('#st-age').textContent = Number.isFinite(age) ? (age < 1000 ? `${Math.round(age)} ms` : `${(age / 1000).toFixed(1)} s`) : '—';
  $('#note-silent').hidden = !(connected && !Number.isFinite(age) && openedAt && now - openedAt > 3000);
  $('#rate').textContent = `${dev.getReportRateHz(now)} Hz`;

  const cfg = dev.getConfig();
  const raw = dev.getRawState();
  RAW_AXES.forEach((a, k) => setBar(rawRows[k], raw.axes[a] / cfg.fullScale, String(raw.axes[a])));
  const mapped = dev.getMappedAxes();
  AXIS_NAMES.forEach((a, k) => setBar(mapRows[k], mapped[a], fmtSigned(mapped[a])));

  $('#btn-mask').textContent = '0x' + raw.buttons.toString(16).padStart(8, '0');
  for (const b of btnEls) b.el.classList.toggle('on', (raw.buttons & (1 << b.bit)) !== 0);
  dev.poll(); // drain queued actions

  const last = dev.getLastReport();
  if (last) {
    $('#hex').textContent = last.hex;
    $('#hex-id').textContent = `id 0x${last.reportId.toString(16).padStart(2, '0')} · ${last.byteLength} B`;
  }

  if (logDirty && now - logShownAt > 100) {
    $('#hex-log').textContent = hexLog.join('\n');
    logDirty = false;
    logShownAt = now;
  }

  renderGamepads();
  requestAnimationFrame(frame);
}

let openedAt = 0;
dev.on('connect', () => (openedAt = performance.now()));
dev.on('disconnect', () => (openedAt = 0));

syncConfigUi();
if (!demo) buildButtons('pro');
requestAnimationFrame(frame);
