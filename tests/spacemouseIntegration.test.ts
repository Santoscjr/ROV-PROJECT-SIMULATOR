import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpaceMouseDevice, defaultConfig } from '../src/input/spacemouse/spacemouseDevice';
import { InputManager } from '../src/input/inputManager';
import type { InputDevice } from '../src/input/types';

/**
 * WebHID is mocked here: these tests check the software behaviour
 * (permissions flow, reconnection, safety on disconnect). They do NOT
 * validate the real SpaceMouse Pro — that is done by the user with hardware.
 */

class MockHidDevice extends EventTarget {
  opened = false;
  constructor(
    public vendorId = 0x046d,
    public productId = 0xc62b,
    public productName = 'SpaceMouse Pro',
  ) {
    super();
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  /** Send a 6-axis report (3Dconnexion VID style, report 1, 12 bytes). */
  send(axes: [number, number, number, number, number, number]) {
    const buf = new DataView(new ArrayBuffer(12));
    axes.forEach((v, i) => buf.setInt16(i * 2, v, true));
    const ev = new Event('inputreport') as Event & { reportId: number; data: DataView; device: MockHidDevice };
    ev.reportId = 1;
    ev.data = buf;
    ev.device = this;
    this.dispatchEvent(ev);
  }
  /** Legacy (Logitech VID) split reports: 1 = translation, 2 = rotation. */
  sendSplit(t: [number, number, number], r: [number, number, number]) {
    for (const [id, v] of [
      [1, t],
      [2, r],
    ] as const) {
      const buf = new DataView(new ArrayBuffer(6));
      v.forEach((x, i) => buf.setInt16(i * 2, x, true));
      const ev = new Event('inputreport') as Event & { reportId: number; data: DataView };
      ev.reportId = id;
      ev.data = buf;
      this.dispatchEvent(ev);
    }
  }
}

class MockHid extends EventTarget {
  granted: MockHidDevice[] = [];
  chooserResult: MockHidDevice[] = [];
  async getDevices() {
    return this.granted;
  }
  async requestDevice() {
    this.granted.push(...this.chooserResult);
    return this.chooserResult;
  }
  fire(type: 'connect' | 'disconnect', device: MockHidDevice) {
    const ev = new Event(type) as Event & { device: MockHidDevice };
    ev.device = device;
    this.dispatchEvent(ev);
  }
}

let hid: MockHid;
const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'hid');

beforeEach(() => {
  hid = new MockHid();
  Object.defineProperty(globalThis.navigator, 'hid', { value: hid, configurable: true });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis.navigator, 'hid', original);
  else delete (globalThis.navigator as unknown as Record<string, unknown>).hid;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function newDevice() {
  return new SpaceMouseDevice({ config: defaultConfig() });
}

describe('SpaceMouse WebHID integration (mocked)', () => {
  it('reconnects a previously authorised device without a prompt', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    expect(await sm.reconnectGranted()).toBe(true);
    expect(sm.connected()).toBe(true);
    expect(sm.getInfo()?.name).toMatch(/SpaceMouse Pro/);
  });

  it('does nothing silently when no device was authorised', async () => {
    const sm = newDevice();
    expect(await sm.reconnectGranted()).toBe(false);
    expect(sm.connected()).toBe(false);
  });

  it('produces proportional (analog) commands, not digital steps', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    const values: number[] = [];
    for (const raw of [60, 120, 200, 350]) {
      dev.sendSplit([raw, 0, 0], [0, 0, 0]); // tx → sway
      values.push(sm.poll(1).axes.sway ?? 0);
    }
    expect(values[0]).toBeGreaterThan(0);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[3]).toBeCloseTo(1, 5);
    expect(values[1]).toBeLessThan(0.5); // expo curve: fine near centre
  });

  it('zeroes its commands immediately on disconnect, keyboard keeps working', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    const keyboard: InputDevice = { id: 'keyboard', label: 'kb', connected: () => true, poll: () => ({ axes: { yaw: 0.5 }, actions: [] }) };
    const im = new InputManager();
    im.shaping = { sensitivity: 1, invert: {}, fineGain: 0.35 };
    im.add(sm);
    im.add(keyboard);
    dev.sendSplit([0, -350, 0], [0, 0, 0]); // push forward → surge
    im.poll();
    expect(im.command.surge).toBeGreaterThan(0.9);
    let disconnected = 0;
    sm.on('disconnect', () => disconnected++);
    hid.fire('disconnect', dev);
    im.poll();
    expect(disconnected).toBe(1);
    expect(sm.connected()).toBe(false);
    expect(im.command.surge).toBe(0);
    expect(im.command.yaw).toBeCloseTo(0.5);
  });

  it('re-opens automatically when the authorised device is plugged back in, starting from zero', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    dev.sendSplit([300, 0, 0], [0, 0, 0]);
    hid.fire('disconnect', dev);
    await dev.close();
    hid.fire('connect', dev);
    await flush();
    expect(sm.connected()).toBe(true);
    expect(sm.poll(1).axes.sway ?? 0).toBe(0); // no stale value carried over
  });

  it('watchdog releases axes when reports stop while deflected', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    sm.ingestReport(1, new DataView(new Int16Array([0, 0, -350, 0, 0, 0]).buffer), 1000);
    expect(sm.poll(1100).axes.heave).toBeGreaterThan(0.9);
    let stale = 0;
    sm.on('stale', () => stale++);
    expect(sm.poll(1000 + sm.staleTimeoutMs + 50).axes.heave ?? 0).toBe(0);
    expect(stale).toBe(1);
  });

  it('calibration removes a resting offset', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    dev.sendSplit([40, 0, 0], [0, 0, 0]); // slight drift at rest (above dead zone)
    expect(Math.abs(sm.poll(1).axes.sway ?? 0)).toBeGreaterThan(0);
    sm.calibrate();
    expect(sm.poll(2).axes.sway ?? 0).toBe(0);
  });

  it('requestAndOpen goes through the browser chooser and opens the chosen device', async () => {
    const dev = new MockHidDevice(0x256f, 0xc652, 'Universal Receiver');
    hid.chooserResult = [dev];
    const sm = newDevice();
    expect(await sm.requestAndOpen()).toBe(true);
    expect(sm.connected()).toBe(true);
    expect(hid.granted).toContain(dev);
  });

  it('button presses become pilot actions (rising edges only)', async () => {
    const dev = new MockHidDevice();
    hid.granted.push(dev);
    const sm = newDevice();
    await sm.reconnectGranted();
    const btn = (mask: number) => sm.ingestReport(3, new DataView(new Uint32Array([mask]).buffer), 1);
    btn(1); // bit 0 → toggleCamera
    btn(1);
    btn(0);
    expect(sm.poll(1).actions).toEqual(['toggleCamera']);
  });
});
