/**
 * Pure (DOM-free) helpers to decode 3Dconnexion SpaceMouse HID input reports.
 *
 * Report layout (sources: openantz "3D Mouse" wiki, spacenavd dev.c, Blender
 * GHOST_NDOFManager; see docs/SPACEMOUSE.md):
 *
 *  - Legacy devices (Logitech VID 0x046d, e.g. SpaceMouse Pro 0xc62b):
 *      report 0x01 = translation X, Y, Z   (3 x int16 little-endian, 6 bytes)
 *      report 0x02 = rotation   RX, RY, RZ (3 x int16 little-endian, 6 bytes)
 *  - Newer devices (3Dconnexion VID 0x256f): report 0x01 carries all six axes
 *      in one 12-byte payload (X, Y, Z, RX, RY, RZ).
 *  - report 0x03 = button bitmask (2..4 bytes, little-endian, bit n = button n+1,
 *      1 = pressed).
 *
 * WebHID strips the report ID byte from `event.data` (WebHID spec, "inputreport"),
 * so the DataView passed here starts at the first payload byte.
 *
 * Raw HID axis directions are NOT documented by 3Dconnexion. The commonly
 * reported convention (unverified, must be confirmed with hardware) is
 * X+ = push right, Y+ = pull toward the user, Z+ = push down, with rotations
 * right-handed around those axes. The mapping layer lets the user flip each axis.
 */

export type Vec3 = [number, number, number];

export interface ParsedReport {
  translation?: Vec3;
  rotation?: Vec3;
  /** Button bitmask (bit 0 = HID button 1). Unsigned 32-bit. */
  buttons?: number;
}

export const REPORT_TRANSLATION = 0x01;
export const REPORT_ROTATION = 0x02;
export const REPORT_BUTTONS = 0x03;

function readVec3(data: DataView, offset: number): Vec3 {
  return [data.getInt16(offset, true), data.getInt16(offset + 2, true), data.getInt16(offset + 4, true)];
}

/**
 * Decode one input report. `data` must NOT contain the report ID byte
 * (that is how WebHID delivers it). Unknown report IDs return `{}`.
 */
export function parseReport(reportId: number, data: DataView): ParsedReport {
  const len = data.byteLength;
  switch (reportId) {
    case REPORT_TRANSLATION: {
      if (len >= 12) return { translation: readVec3(data, 0), rotation: readVec3(data, 6) };
      if (len >= 6) return { translation: readVec3(data, 0) };
      return {};
    }
    case REPORT_ROTATION:
      return len >= 6 ? { rotation: readVec3(data, 0) } : {};
    case REPORT_BUTTONS: {
      if (len < 1) return {};
      let mask = 0;
      const n = Math.min(len, 4);
      for (let i = 0; i < n; i++) mask |= data.getUint8(i) << (8 * i);
      return { buttons: mask >>> 0 };
    }
    default:
      return {};
  }
}

/** Decode a packet that still has the report ID as its first byte (e.g. hidraw dumps). */
export function parseRawPacket(bytes: Uint8Array): ParsedReport {
  if (bytes.length < 1) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset + 1, bytes.length - 1);
  return parseReport(bytes[0], view);
}

/** Hex dump "01 0a ff ..." of a report, report ID first. */
export function hexDump(reportId: number, data: DataView): string {
  const parts = [reportId.toString(16).padStart(2, '0')];
  for (let i = 0; i < data.byteLength; i++) parts.push(data.getUint8(i).toString(16).padStart(2, '0'));
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Device table
// ---------------------------------------------------------------------------

export const VID_LOGITECH = 0x046d;
export const VID_3DCONNEXION = 0x256f;

export type ButtonLayout = 'pro' | 'two' | 'enterprise' | 'generic';

export interface KnownDevice {
  vendorId: number;
  productId: number;
  name: string;
  layout: ButtonLayout;
}

/**
 * Known 6-DoF devices. IDs from spacenavd `usbdb[]` and Blender
 * GHOST_NDOFManager (0xc652 / 0xc658 receivers). Only 6-DoF devices listed.
 */
export const KNOWN_DEVICES: readonly KnownDevice[] = [
  { vendorId: VID_LOGITECH, productId: 0xc603, name: 'SpaceMouse Plus XT', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc605, name: 'CadMan', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc606, name: 'SpaceMouse Classic', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc621, name: 'SpaceBall 5000', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc623, name: 'SpaceTraveler', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc625, name: 'SpacePilot', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc626, name: 'SpaceNavigator', layout: 'two' },
  { vendorId: VID_LOGITECH, productId: 0xc627, name: 'SpaceExplorer', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc628, name: 'SpaceNavigator for Notebooks', layout: 'two' },
  { vendorId: VID_LOGITECH, productId: 0xc629, name: 'SpacePilot Pro', layout: 'generic' },
  { vendorId: VID_LOGITECH, productId: 0xc62b, name: 'SpaceMouse Pro', layout: 'pro' },
  { vendorId: VID_3DCONNEXION, productId: 0xc62e, name: 'SpaceMouse Wireless (cabo)', layout: 'two' },
  { vendorId: VID_3DCONNEXION, productId: 0xc62f, name: 'SpaceMouse Wireless (receptor)', layout: 'two' },
  { vendorId: VID_3DCONNEXION, productId: 0xc631, name: 'SpaceMouse Pro Wireless (cabo)', layout: 'pro' },
  { vendorId: VID_3DCONNEXION, productId: 0xc632, name: 'SpaceMouse Pro Wireless (receptor)', layout: 'pro' },
  { vendorId: VID_3DCONNEXION, productId: 0xc633, name: 'SpaceMouse Enterprise', layout: 'enterprise' },
  { vendorId: VID_3DCONNEXION, productId: 0xc635, name: 'SpaceMouse Compact', layout: 'two' },
  { vendorId: VID_3DCONNEXION, productId: 0xc636, name: 'SpaceMouse Module', layout: 'two' },
  { vendorId: VID_3DCONNEXION, productId: 0xc638, name: 'SpaceMouse Pro Wireless BT (cabo)', layout: 'pro' },
  { vendorId: VID_3DCONNEXION, productId: 0xc63a, name: 'SpaceMouse Wireless BT', layout: 'two' },
  { vendorId: VID_3DCONNEXION, productId: 0xc652, name: 'Universal Receiver (SpaceMouse Pro Wireless)', layout: 'pro' },
  { vendorId: VID_3DCONNEXION, productId: 0xc658, name: 'Universal Receiver (SpaceMouse Wireless)', layout: 'two' },
];

export function lookupDevice(vendorId: number, productId: number): KnownDevice | undefined {
  return KNOWN_DEVICES.find((d) => d.vendorId === vendorId && d.productId === productId);
}

/** Generic Desktop page / Multi-axis Controller usage (HID Usage Tables). */
export const HID_USAGE_PAGE_GENERIC_DESKTOP = 0x01;
export const HID_USAGE_MULTI_AXIS = 0x08;

/** Filters for `navigator.hid.requestDevice`. */
export const HID_REQUEST_FILTERS = [
  { vendorId: VID_3DCONNEXION },
  { vendorId: VID_LOGITECH, usagePage: HID_USAGE_PAGE_GENERIC_DESKTOP, usage: HID_USAGE_MULTI_AXIS },
  { usagePage: HID_USAGE_PAGE_GENERIC_DESKTOP, usage: HID_USAGE_MULTI_AXIS },
];

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * SpaceMouse Pro (wired 0xc62b and Pro Wireless) bit index -> label.
 * Cross-checked: spacenavd `bnhack_smpro` (evdev code 256+bit) and Blender
 * `ndof_HID_map_Shared3Dx` with mask 0x07C0F137 -> bits 0,1,2,4,5,8,12-15,22-26.
 */
export const SPACEMOUSE_PRO_BUTTONS: Readonly<Record<number, string>> = {
  0: 'Menu',
  1: 'Fit',
  2: 'T',
  4: 'R',
  5: 'F',
  8: 'Rot',
  12: '1',
  13: '2',
  14: '3',
  15: '4',
  22: 'Esc',
  23: 'Alt',
  24: 'Shift',
  25: 'Ctrl',
  26: 'Lock',
};

/** Two-button devices (SpaceNavigator, SpaceMouse Wireless/Compact). */
export const TWO_BUTTON_NAMES: Readonly<Record<number, string>> = { 0: 'Esquerdo', 1: 'Direito' };

/** Bits shown in the UI for a given layout. */
export function buttonBitsFor(layout: ButtonLayout): number[] {
  if (layout === 'pro') return Object.keys(SPACEMOUSE_PRO_BUTTONS).map(Number);
  if (layout === 'two') return [0, 1];
  return Array.from({ length: 32 }, (_, i) => i);
}

export function buttonName(bit: number, layout: ButtonLayout): string {
  if (layout === 'pro' && SPACEMOUSE_PRO_BUTTONS[bit]) return SPACEMOUSE_PRO_BUTTONS[bit];
  if (layout === 'two' && TWO_BUTTON_NAMES[bit]) return TWO_BUTTON_NAMES[bit];
  return `B${bit + 1}`;
}

/** Bits that went from 0 to 1 between two masks. */
export function risingEdges(prev: number, next: number): number[] {
  const rising = (next & ~prev) >>> 0;
  const out: number[] = [];
  for (let b = 0; b < 32; b++) if (rising & (1 << b)) out.push(b);
  return out;
}
