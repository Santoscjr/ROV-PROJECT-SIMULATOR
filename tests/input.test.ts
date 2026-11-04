import { describe, expect, it } from 'vitest';
import { InputManager } from '../src/input/inputManager';
import { KeyboardDevice, type KeySource } from '../src/input/keyboard';
import { applyDeadzone } from '../src/input/gamepad';
import { KEYBOARD_PRESETS, SettingsStore, sanitizeSettings, DEFAULT_SETTINGS } from '../src/config/settings';
import type { InputDevice } from '../src/input/types';

class FakeSource implements KeySource {
  private l: Record<string, ((e: KeyboardEvent) => void)[]> = { keydown: [], keyup: [] };
  addEventListener(type: 'keydown' | 'keyup', fn: (e: KeyboardEvent) => void) {
    this.l[type].push(fn);
  }
  removeEventListener() {}
  fire(type: 'keydown' | 'keyup', code: string, repeat = false) {
    const e = { code, repeat, target: null, preventDefault() {} } as unknown as KeyboardEvent;
    this.l[type].forEach((f) => f(e));
  }
}

function kb(ramp = 0) {
  const src = new FakeSource();
  let now = 0;
  const dev = new KeyboardDevice(KEYBOARD_PRESETS.wasd, src, () => now);
  dev.ramp = ramp;
  return { src, dev, advance: (s: number) => (now += s) };
}

describe('keyboard device', () => {
  it('maps physical keys to axes and actions', () => {
    const { src, dev, advance } = kb();
    dev.poll();
    src.fire('keydown', 'KeyW');
    src.fire('keydown', 'KeyQ');
    src.fire('keydown', 'KeyL');
    advance(0.016);
    const r = dev.poll();
    expect(r.axes.surge).toBe(1);
    expect(r.axes.yaw).toBe(-1);
    expect(r.actions).toEqual(['toggleLights']);
    // Actions are edge-triggered and auto-repeat is ignored.
    src.fire('keydown', 'KeyL', true);
    expect(dev.poll().actions).toEqual([]);
  });

  it('ramps digital keys progressively', () => {
    const { src, dev, advance } = kb(0.5);
    dev.poll();
    src.fire('keydown', 'KeyR');
    advance(0.1);
    const a = dev.poll().axes.heave!;
    advance(0.1);
    const b = dev.poll().axes.heave!;
    expect(a).toBeCloseTo(0.2, 5);
    expect(b).toBeCloseTo(0.4, 5);
    src.fire('keyup', 'KeyR');
    advance(0.1);
    expect(dev.poll().axes.heave ?? 0).toBeLessThan(b);
  });

  it('supports rebinding', () => {
    const { src, dev, advance } = kb();
    dev.setBindings({ ...KEYBOARD_PRESETS.wasd, 'surge+': ['KeyI'] });
    dev.poll();
    src.fire('keydown', 'KeyW');
    src.fire('keydown', 'KeyI');
    advance(0.02);
    expect(dev.poll().axes.surge).toBe(1);
    src.fire('keyup', 'KeyI');
    advance(1);
    expect(dev.poll().axes.surge ?? 0).toBe(0);
  });
});

describe('input manager', () => {
  const fake = (axes: Record<string, number>, id = 'fake'): InputDevice => ({
    id,
    label: id,
    connected: () => true,
    poll: () => ({ axes, actions: [] }),
  });

  it('merges devices, clamps and applies sensitivity / inversion / fine control', () => {
    const im = new InputManager();
    im.add(fake({ surge: 0.8, yaw: 0.5 }, 'a'));
    im.add(fake({ surge: 0.6, heave: -0.5 }, 'b'));
    im.shaping = { sensitivity: 0.5, invert: { heave: true }, fineGain: 0.4 };
    im.poll();
    expect(im.raw.surge).toBe(1);
    expect(im.command.surge).toBeCloseTo(0.5);
    expect(im.command.heave).toBeCloseTo(0.25);
    expect(im.sources.surge).toBe('b');
    im.fine = true;
    im.poll();
    expect(im.command.yaw).toBeCloseTo(0.5 * 0.5 * 0.4);
  });

  it('ignores disconnected devices', () => {
    const im = new InputManager();
    im.add({ id: 'x', label: 'x', connected: () => false, poll: () => ({ axes: { surge: 1 }, actions: ['confirm'] }) });
    expect(im.poll()).toEqual([]);
    expect(im.command.surge).toBe(0);
  });
});

describe('gamepad dead zone', () => {
  it('zeroes small values and rescales to full range', () => {
    expect(applyDeadzone(0.1, 0.12)).toBe(0);
    expect(applyDeadzone(1, 0.12)).toBeCloseTo(1);
    expect(applyDeadzone(-0.56, 0.12)).toBeCloseTo(-0.5);
  });
});

describe('settings', () => {
  it('sanitises untrusted values', () => {
    const s = sanitizeSettings({ graphics: 'ultra', sensitivity: 9, invert: { surge: 'yes' }, bindings: { 'surge+': [3] } });
    expect(s.graphics).toBe(DEFAULT_SETTINGS.graphics);
    expect(s.sensitivity).toBe(1);
    expect(s.invert.surge).toBe(false);
    expect(s.bindings['surge+']).toEqual(['KeyW']);
  });

  it('persists and notifies', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const a = new SettingsStore(storage);
    let seen = 0;
    a.subscribe(() => seen++);
    a.update({ graphics: 'high', current: 'strong' });
    expect(seen).toBe(1);
    const b = new SettingsStore(storage);
    expect(b.get().graphics).toBe('high');
    expect(b.get().current).toBe('strong');
  });

  it('survives corrupted storage', () => {
    const storage = { getItem: () => '{not json', setItem: () => {} };
    expect(new SettingsStore(storage).get().graphics).toBe(DEFAULT_SETTINGS.graphics);
  });
});
