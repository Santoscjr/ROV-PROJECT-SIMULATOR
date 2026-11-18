import { describe, expect, it } from 'vitest';
import {
  buttonBitsFor,
  buttonName,
  hexDump,
  lookupDevice,
  parseRawPacket,
  parseReport,
  risingEdges,
} from '../src/input/spacemouse/hidParser';
import {
  DEFAULT_SPACEMOUSE_CONFIG,
  SpaceMouseDevice,
  applyDeadzone,
  buttonActions,
  defaultConfig,
  loadSpaceMouseConfig,
  mapAxes,
  processRawAxis,
  sanitizeConfig,
  saveSpaceMouseConfig,
  SPACEMOUSE_STORAGE_KEY,
  type RawAxis,
} from '../src/input/spacemouse/spacemouseDevice';

function view(values: number[], kind: 'i16' | 'u8' = 'i16'): DataView {
  const bytes = kind === 'i16' ? values.length * 2 : values.length;
  const dv = new DataView(new ArrayBuffer(bytes));
  values.forEach((v, i) => (kind === 'i16' ? dv.setInt16(i * 2, v, true) : dv.setUint8(i, v)));
  return dv;
}

const raw0 = (): Record<RawAxis, number> => ({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });

describe('parseReport', () => {
  it('decodes legacy 6-byte translation report', () => {
    expect(parseReport(1, view([100, -200, 350]))).toEqual({ translation: [100, -200, 350] });
  });
  it('decodes legacy rotation report 2', () => {
    expect(parseReport(2, view([-1, 2, -350]))).toEqual({ rotation: [-1, 2, -350] });
  });
  it('decodes combined 12-byte report 1', () => {
    expect(parseReport(1, view([1, 2, 3, -4, -5, -6]))).toEqual({ translation: [1, 2, 3], rotation: [-4, -5, -6] });
  });
  it('decodes button bitmask little-endian, unsigned', () => {
    expect(parseReport(3, view([0x01, 0x10, 0x00, 0x04], 'u8')).buttons).toBe(0x04001001);
    expect(parseReport(3, view([0, 0, 0, 0x80], 'u8')).buttons).toBe(0x80000000);
    expect(parseReport(3, view([0x03, 0x00], 'u8')).buttons).toBe(3);
  });
  it('ignores unknown or short reports', () => {
    expect(parseReport(0x16, view([1, 2]))).toEqual({});
    expect(parseReport(1, view([1, 2]))).toEqual({});
    expect(parseReport(3, new DataView(new ArrayBuffer(0)))).toEqual({});
  });
  it('parses packets that include the report id byte', () => {
    const bytes = new Uint8Array([0x01, 0x5e, 0x01, 0xa2, 0xfe, 0x00, 0x00]);
    expect(parseRawPacket(bytes)).toEqual({ translation: [350, -350, 0] });
  });
  it('hex dumps with report id first', () => {
    expect(hexDump(3, view([0x01, 0xff], 'u8'))).toBe('03 01 ff');
  });
});

describe('device table and buttons', () => {
  it('knows the SpaceMouse Pro ids', () => {
    expect(lookupDevice(0x046d, 0xc62b)?.layout).toBe('pro');
    expect(lookupDevice(0x256f, 0xc632)?.layout).toBe('pro');
    expect(lookupDevice(0x256f, 0xc652)?.layout).toBe('pro');
    expect(lookupDevice(0x1234, 0x5678)).toBeUndefined();
  });
  it('names SpaceMouse Pro buttons', () => {
    expect(buttonName(0, 'pro')).toBe('Menu');
    expect(buttonName(26, 'pro')).toBe('Lock');
    expect(buttonName(3, 'pro')).toBe('B4');
    expect(buttonBitsFor('pro')).toHaveLength(15);
    expect(buttonBitsFor('two')).toEqual([0, 1]);
  });
  it('detects rising edges', () => {
    expect(risingEdges(0b0001, 0b0111)).toEqual([1, 2]);
    expect(risingEdges(0b0111, 0b0001)).toEqual([]);
    expect(risingEdges(0, 0x80000000)).toEqual([31]);
  });
  it('maps rising edges to actions', () => {
    expect(buttonActions(0, 0b11, { '0': 'toggleCamera', '1': 'none' })).toEqual(['toggleCamera']);
  });
});

describe('mapping math', () => {
  it('deadzone is continuous and rescaled', () => {
    expect(applyDeadzone(0.05, 0.1)).toBe(0);
    expect(applyDeadzone(-0.1, 0.1)).toBe(0);
    expect(applyDeadzone(1, 0.1)).toBeCloseTo(1);
    expect(applyDeadzone(-0.55, 0.1)).toBeCloseTo(-0.5);
  });

  it('normalises by full scale and clamps', () => {
    const cfg = { ...defaultConfig(), deadzone: 0, expo: 1 };
    const m = { target: 'surge' as const, invert: false, scale: 1 };
    expect(processRawAxis(175, 0, m, cfg)).toBeCloseTo(0.5);
    expect(processRawAxis(900, 0, m, cfg)).toBe(1);
    expect(processRawAxis(-900, 0, m, cfg)).toBe(-1);
  });

  it('applies invert, sensitivity and per-axis scale', () => {
    const cfg = { ...defaultConfig(), deadzone: 0, expo: 1, sensitivity: 2 };
    expect(processRawAxis(70, 0, { target: 'yaw', invert: true, scale: 1 }, cfg)).toBeCloseTo(-0.4);
    expect(processRawAxis(70, 0, { target: 'yaw', invert: false, scale: 0.5 }, cfg)).toBeCloseTo(0.2);
    expect(processRawAxis(300, 0, { target: 'yaw', invert: false, scale: 1 }, cfg)).toBe(1);
  });

  it('subtracts calibration offsets', () => {
    const cfg = { ...defaultConfig(), deadzone: 0.05, expo: 1 };
    const m = { target: 'heave' as const, invert: false, scale: 1 };
    // Resting drift of 12 counts would leak through without calibration...
    expect(processRawAxis(30, 0, m, cfg)).not.toBe(0);
    // ...and is zero once the offset is captured.
    expect(processRawAxis(30, 30, m, cfg)).toBe(0);
  });

  it('expo keeps sign and endpoints', () => {
    const cfg = { ...defaultConfig(), deadzone: 0, expo: 2 };
    const m = { target: 'sway' as const, invert: false, scale: 1 };
    expect(processRawAxis(-175, 0, m, cfg)).toBeCloseTo(-0.25);
    expect(processRawAxis(350, 0, m, cfg)).toBeCloseTo(1);
  });

  it('default mapping follows the body convention (assumed HID frame)', () => {
    const cfg = { ...defaultConfig(), deadzone: 0, expo: 1 };
    const r = raw0();
    r.ty = -350; // push forward
    r.tx = 350; // push right
    r.tz = -350; // lift
    r.rz = 350; // twist clockwise
    r.rx = 175; // tilt back
    const out = mapAxes(r, cfg);
    expect(out.surge).toBeCloseTo(1);
    expect(out.sway).toBeCloseTo(1);
    expect(out.heave).toBeCloseTo(1);
    expect(out.yaw).toBeCloseTo(1);
    expect(out.camTilt).toBeCloseTo(0.5);
    expect(out.roll).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it('sums and clamps several sources on one target', () => {
    const cfg = defaultConfig();
    cfg.deadzone = 0;
    cfg.expo = 1;
    cfg.axes.ry = { target: 'yaw', invert: false, scale: 1 };
    const r = raw0();
    r.rz = 300;
    r.ry = 300;
    expect(mapAxes(r, cfg).yaw).toBe(1);
  });
});

describe('config persistence', () => {
  class MemStorage {
    m = new Map<string, string>();
    getItem(k: string) {
      return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
  }

  it('round-trips through storage', () => {
    const s = new MemStorage() as unknown as Storage;
    const cfg = defaultConfig();
    cfg.deadzone = 0.2;
    cfg.axes.rx.target = 'pitch';
    expect(saveSpaceMouseConfig(cfg, s)).toBe(true);
    expect(loadSpaceMouseConfig(s)).toEqual(cfg);
  });

  it('falls back to defaults on garbage', () => {
    const s = new MemStorage() as unknown as Storage;
    s.setItem(SPACEMOUSE_STORAGE_KEY, '{not json');
    expect(loadSpaceMouseConfig(s)).toEqual(defaultConfig());
    const bad = sanitizeConfig({ deadzone: 9, axes: { tx: { target: 'warp', invert: 'yes' } } });
    expect(bad.deadzone).toBe(0.5);
    expect(bad.axes.tx).toEqual(DEFAULT_SPACEMOUSE_CONFIG.axes.tx);
  });

  it('survives storage that throws', () => {
    const s = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadSpaceMouseConfig(s)).toEqual(defaultConfig());
    expect(saveSpaceMouseConfig(defaultConfig(), s)).toBe(false);
  });
});

describe('SpaceMouseDevice (no WebHID)', () => {
  it('is unsupported under node and polls empty while disconnected', () => {
    const d = new SpaceMouseDevice({ loadFromStorage: false });
    expect(SpaceMouseDevice.isSupported()).toBe(false);
    expect(d.connected()).toBe(false);
    expect(d.poll()).toEqual({ axes: {}, actions: [] });
  });

  it('ingests reports, calibrates and queues button actions', () => {
    const d = new SpaceMouseDevice({ loadFromStorage: false });
    d.ingestReport(1, view([5, -7, 3, 0, 0, 0]), 0);
    expect(d.getRawState().axes).toEqual({ tx: 5, ty: -7, tz: 3, rx: 0, ry: 0, rz: 0 });
    d.calibrate();
    expect(d.getConfig().offsets.ty).toBe(-7);
    d.ingestReport(3, view([0x01, 0, 0, 0], 'u8'), 10);
    d.ingestReport(3, view([0x00, 0, 0, 0], 'u8'), 20);
    // Disconnected devices report no axes but still hand out queued edges.
    expect(d.poll().actions).toEqual(['toggleCamera']);
    expect(d.poll().actions).toEqual([]);
    expect(d.getLastReport()?.hex).toBe('03 00 00 00 00');
  });
});
