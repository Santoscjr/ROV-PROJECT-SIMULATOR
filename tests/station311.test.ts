import { describe, expect, it } from 'vitest';
import { DEFAULT_CAM_STATES, DEFAULT_SETTINGS, sanitizeSettings, type CameraStates } from '../src/config/settings';
import { KeyboardDevice } from '../src/input/keyboard';
import { CameraRig } from '../src/render/cameras';
import { SecondaryView } from '../src/render/station';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget;

describe('keyboard focus policy (v3.1.1)', () => {
  it('text entry always keeps the keys', () => {
    expect(KeyboardDevice.routeToPilot(el('INPUT', { type: 'text' }), false)).toBe(false);
    expect(KeyboardDevice.routeToPilot(el('INPUT', { type: 'number' }), false)).toBe(false);
    expect(KeyboardDevice.routeToPilot(el('TEXTAREA'), false)).toBe(false);
    expect(KeyboardDevice.routeToPilot(el('DIV', { isContentEditable: true }), false)).toBe(false);
  });

  it('a panel selector focused during the operation does not steal the arrows', () => {
    // After choosing a camera in a panel selector, ArrowUp/Down must reach the winch.
    expect(KeyboardDevice.routeToPilot(el('SELECT'), false)).toBe(true);
    expect(KeyboardDevice.routeToPilot(el('BUTTON'), false)).toBe(true);
    expect(KeyboardDevice.routeToPilot(el('INPUT', { type: 'range' }), false)).toBe(true);
  });

  it('while a menu is open, its controls keep the keys', () => {
    expect(KeyboardDevice.routeToPilot(el('SELECT'), true)).toBe(false);
    expect(KeyboardDevice.routeToPilot(el('INPUT', { type: 'range' }), true)).toBe(false);
    // Keys on the page body still work (Esc / H close the menu).
    expect(KeyboardDevice.routeToPilot(el('BODY'), true)).toBe(true);
    expect(KeyboardDevice.routeToPilot(null, true)).toBe(true);
  });

  it('default bindings: arrows drive the tether, camera pan has its own keys', () => {
    const b = DEFAULT_SETTINGS.bindings;
    expect(b.tetherPay).toContain('ArrowUp');
    expect(b.tetherHaul).toContain('ArrowDown');
    for (const k of ['camOp', 'camAux', 'camExt', 'camTms', 'camTether', 'camPan-', 'camPan+', 'camTilt+', 'camTilt-'] as const)
      for (const code of b[k]) expect(['ArrowUp', 'ArrowDown']).not.toContain(code);
    expect(b.tmsRecover).toEqual(['KeyO']);
  });
});

describe('station settings persistence & migration (v3.1.1)', () => {
  it('v3.1 settings migrate without losing the user setup', () => {
    const legacy = { layout: 'quad', panels: ['operational', 'tms', 'tether', 'sonar'], tmsDepth: 80, monitorSource: 'tms', graphics: 'high' };
    const s = sanitizeSettings(legacy);
    expect(s.layout).toBe('quad');
    expect(s.panels).toEqual(['operational', 'tms', 'tether', 'sonar']);
    expect(s.graphics).toBe('high');
    // The v3.1 default (80 m) was the "TMS descends too much" complaint → new default.
    expect(s.tmsDepth).toBe(DEFAULT_SETTINGS.tmsDepth);
    // The single monitor source carries over as panel 1 of the secondary monitor.
    expect(s.monitor.sources[0]).toBe('tms');
    expect(s.monitor.layout).toBe('single');
    expect(s.panelLocks).toEqual([false, true, true, true]);
    expect(s.camState).toEqual(DEFAULT_CAM_STATES);
    expect(s.version).toBeGreaterThanOrEqual(311);
  });

  it('a depth chosen by the user in v3.1.1 is kept', () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, tmsDepth: 80 });
    expect(s.tmsDepth).toBe(80);
  });

  it('locks, camera states, monitor, lighting and sonar round-trip and are clamped', () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      panelLocks: [true, false, 'x', true],
      camState: { operational: { pan: 400, tilt: -10, zoom: 0.5 }, auxiliary: { pan: 12, tilt: 5, zoom: 9 }, tether: 'bad' },
      monitor: { layout: 'dual', sources: ['external', 'nope'], instruments: 'full' },
      lighting: { front: 5, top: 1.5, tms: 0, observer: 'normal', tetherAssist: true },
      sonar: { range: 20, gain: 9, quality: 'high', tilt: 30 },
    });
    expect(s.panelLocks).toEqual([true, false, true, true]);
    expect(s.camState.operational).toEqual({ pan: 150, tilt: -10, zoom: 0.5 });
    expect(s.camState.auxiliary).toEqual({ pan: 12, tilt: 5, zoom: 1 });
    expect(s.camState.tether).toEqual(DEFAULT_CAM_STATES.tether);
    expect(s.monitor).toEqual({ layout: 'dual', sources: ['external', DEFAULT_SETTINGS.monitor.sources[1]], instruments: 'full' });
    expect(s.lighting).toEqual({ front: 2, top: 1.5, tms: 0.25, observer: 'normal', tetherAssist: true });
    expect(s.sonar).toEqual({ range: 20, gain: 3, quality: 'high', tilt: 30 });
    // JSON round trip (localStorage) is lossless.
    expect(sanitizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('per-panel cameras sharing physical camera state', () => {
  const fresh = (): CameraStates => structuredClone(DEFAULT_CAM_STATES);

  it('pan/tilt on the auxiliary camera in panel 3 does not move the main camera', () => {
    const states = fresh();
    const main = new CameraRig(1, states);
    main.setMode('operational');
    const p3 = new SecondaryView('auxiliary', states);
    const tilt0 = main.tilt;
    const pan0 = main.pan;
    p3.rig.panBy(10);
    p3.rig.tiltBy(-6);
    p3.rig.drag(40, 20);
    expect(main.tilt).toBe(tilt0);
    expect(main.pan).toBe(pan0);
    expect(states.auxiliary.pan).not.toBe(0);
    expect(states.auxiliary.tilt).not.toBe(0);
  });

  it('two panels showing the same camera show the same pan/tilt (one physical camera)', () => {
    const states = fresh();
    const a = new SecondaryView('tether', states);
    const b = new SecondaryView('tether', states);
    a.rig.panBy(-20);
    expect(b.rig.tetherPan).toBe(a.rig.tetherPan);
  });

  it('mouse wheel tilts the pilot camera (v2) and Ctrl+wheel zooms', () => {
    const rig = new CameraRig(1, fresh());
    rig.setMode('operational');
    const t0 = rig.tilt;
    rig.wheel(100);
    expect(rig.tilt).toBeLessThan(t0);
    const z0 = rig.zoom;
    rig.wheel(-100, true);
    expect(rig.zoom).toBeLessThan(z0);
    expect(rig.tilt).toBeLessThan(t0);
  });

  it('external camera: wheel changes orbit distance only', () => {
    const states = fresh();
    const rig = new CameraRig(1, states);
    rig.setMode('external');
    const d0 = rig.orbitDist;
    rig.wheel(100);
    expect(rig.orbitDist).toBeGreaterThan(d0);
    expect(states).toEqual(DEFAULT_CAM_STATES);
  });
});
