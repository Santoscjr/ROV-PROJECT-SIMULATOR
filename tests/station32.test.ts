import { describe, expect, it } from 'vitest';
import { DEFAULT_CAM_STATES, DEFAULT_SETTINGS, RESET_CATEGORIES, resetPatch, sanitizeSettings, type CameraStates } from '../src/config/settings';
import { BUILTIN_PROFILES, profilePatch, stationOf } from '../src/config/profiles';
import { CameraRig, CAMERA_MODES } from '../src/render/cameras';
import { SecondaryView, layoutRects } from '../src/render/station';
import { comparePublished, runtimeEnvironment, shortCommit, type BuildInfo } from '../src/diagnostics/buildInfo';
import { overlayPolicy } from '../src/ui/panelOverlay';

const fresh = (): CameraStates => structuredClone(DEFAULT_CAM_STATES);

describe('camera identity is independent of panel / window (v3.2)', () => {
  // Movable cameras and the action that moves them.
  const movable = ['operational', 'auxiliary', 'tether', 'tms', 'external'] as const;

  it.each(movable)('%s: same control result in every panel slot and in a monitor window', (cam) => {
    // Panel 1 (main rig), panels 2–4 (SecondaryView) and a monitor panel share ONE state.
    const states = fresh();
    const main = new CameraRig(1, states);
    main.setMode(cam);
    const slots = [main, ...[1, 2, 3].map(() => new SecondaryView(cam, states).rig), new SecondaryView(cam, states, 2).rig];
    const before = structuredClone(states[cam]);
    for (const rig of slots) {
      const s0 = structuredClone(states[cam]);
      rig.panBy(5);
      rig.tiltBy(-3);
      rig.drag(10, 5);
      rig.wheel(100, true);
      const s1 = structuredClone(states[cam]);
      // Every slot moves the camera (no slot is "dead").
      expect(s1).not.toEqual(s0);
    }
    // All slots see the same final state.
    expect(states[cam]).not.toEqual(before);
    for (const other of CAMERA_MODES.filter((m) => m !== cam)) expect(states[other]).toEqual(DEFAULT_CAM_STATES[other]);
  });

  it('external orbit persists through settings (moving it to another panel keeps the view)', () => {
    const states = fresh();
    const a = new SecondaryView('external', states);
    a.rig.panBy(40);
    a.rig.tiltBy(10);
    const saved = sanitizeSettings({ ...DEFAULT_SETTINGS, camState: states }).camState;
    const b = new SecondaryView('external', structuredClone(saved));
    expect(b.rig.orbitYaw).toBeCloseTo(a.rig.orbitYaw, 6);
    expect(b.rig.orbitPitch).toBeCloseTo(a.rig.orbitPitch, 6);
  });

  it('camera limits are enforced (no runaway pan/tilt/zoom)', () => {
    const rig = new CameraRig(1, fresh());
    for (const m of CAMERA_MODES) {
      rig.setMode(m);
      for (let i = 0; i < 200; i++) {
        rig.panBy(10);
        rig.tiltBy(10);
        rig.adjustZoom(5);
      }
    }
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, camState: rig.states }).camState;
    expect(s).toEqual(rig.states);
  });
});

describe('station profiles and multi-monitor settings', () => {
  it('offshore profile reproduces the reference control room', () => {
    const p = BUILTIN_PROFILES.offshore;
    expect(p.layout).toBe('quad');
    expect(p.panels).toEqual(['tether', 'tms', 'operational', 'auxiliary']);
    expect(p.monitors.map((m) => [m.layout, m.sources[0]])).toEqual([
      ['single', 'sonar'],
      ['single', 'instruments'],
    ]);
  });

  it('applying a profile changes only the station, and saving/restoring custom works', () => {
    const s0 = sanitizeSettings({ ...DEFAULT_SETTINGS, graphics: 'high', visibility: 'turbid' });
    const s1 = sanitizeSettings({ ...s0, ...profilePatch('offshore', s0) });
    expect(s1.graphics).toBe('high');
    expect(s1.visibility).toBe('turbid');
    expect(stationOf(s1)).toEqual(BUILTIN_PROFILES.offshore);
    expect(profilePatch('custom', s1)).toBeNull();
    const s2 = sanitizeSettings({ ...s1, customStation: stationOf(s1), layout: 'single' });
    const s3 = sanitizeSettings({ ...s2, ...profilePatch('custom', s2) });
    expect(s3.layout).toBe('quad');
    expect(s3.monitors).toHaveLength(2);
  });

  it('monitor windows: up to 3, 1/2/4 panels, invalid entries corrected', () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, monitors: [{ layout: 'quad', sources: ['sonar', 'x'], locks: [false] }, {}, {}, {}] });
    expect(s.monitors).toHaveLength(3);
    expect(s.monitors[0].layout).toBe('quad');
    expect(s.monitors[0].sources).toHaveLength(4);
    expect(s.monitors[0].sources[0]).toBe('sonar');
    expect(s.monitors[0].locks[0]).toBe(false);
    for (const l of ['single', 'dual', 'quad'] as const) expect(layoutRects(l, 800, 600).length).toBe(l === 'quad' ? 4 : l === 'dual' ? 2 : 1);
  });

  it('selective reset touches only its category', () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, graphics: 'high', layout: 'quad', sonar: { range: 10, gain: 2, quality: 'low', tilt: 5 } });
    const r = sanitizeSettings({ ...s, ...resetPatch('sonar') });
    expect(r.sonar).toEqual(DEFAULT_SETTINGS.sonar);
    expect(r.graphics).toBe('high');
    expect(r.layout).toBe('quad');
    for (const keys of Object.values(RESET_CATEGORIES)) for (const k of keys) expect(k in DEFAULT_SETTINGS).toBe(true);
  });
});

describe('build identification', () => {
  const run: BuildInfo = { version: '3.2.0', commit: 'abcdef1234567', dirty: false, builtAt: '2026-11-05T17:00:00Z', builder: 'local', ref: '' };
  it('detects a cached old build vs the published one', () => {
    expect(comparePublished(run, { ...run }).state).toBe('same');
    expect(comparePublished(run, { ...run, commit: '1234567aaaa' }).state).toBe('newer');
    expect(comparePublished(run, null).state).toBe('unavailable');
    expect(comparePublished(run, { foo: 1 }).state).toBe('unavailable');
  });
  it('labels', () => {
    expect(shortCommit('abcdef1234567')).toBe('abcdef1');
    expect(runtimeEnvironment({ hostname: 'santoscjr.github.io', protocol: 'https:' })).toContain('GitHub Pages');
    expect(runtimeEnvironment({ hostname: 'localhost', protocol: 'http:' })).toContain('local');
  });
});

describe('camera overlay compaction policy', () => {
  it('keeps the essentials at every panel size and drops secondary items first', () => {
    for (const [w, h] of [
      [1920, 1080],
      [960, 540],
      [683, 384],
      [640, 360],
      [400, 225],
      [300, 170],
    ]) {
      const p = overlayPolicy(w, h);
      // The top line (depth/altitude/heading) is always present.
      expect(['full', 'short']).toContain(p.line);
      if (w >= 420 && h >= 220) expect(p.corners).toBe(true);
    }
    expect(overlayPolicy(300, 170).corners).toBe(false);
  });
});

describe('Top-Hat depth mode (v3.2)', () => {
  it('fixed and seabed-relative modes persist and are clamped', async () => {
    const { sanitizeSettings, DEFAULT_SETTINGS } = await import('../src/config/settings');
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, tmsDepthMode: 'seabed', tmsAboveSeabed: 999 });
    expect(s.tmsDepthMode).toBe('seabed');
    expect(s.tmsAboveSeabed).toBe(60);
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, tmsDepthMode: 'x' }).tmsDepthMode).toBe('fixed');
    // Default keeps the operator's previous choice (fixed 50 m).
    expect(DEFAULT_SETTINGS.tmsDepthMode).toBe('fixed');
    expect(DEFAULT_SETTINGS.tmsDepth).toBe(50);
  });
});
