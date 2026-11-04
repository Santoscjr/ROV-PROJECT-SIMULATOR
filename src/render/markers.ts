import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import type { MissionMarker } from '../mission/types';
import { makeLabelTexture } from './materials';

const COLORS = {
  active: 0xf2a93b,
  done: 0x5fbf7a,
  pending: 0x7d8d99,
};

/**
 * Physical mission aids placed in the water: LED training gates (rings),
 * numbered target posts on the seabed and holding zones. They exist in the
 * scene like any other object (lit, attenuated by the water), so they can
 * only be seen within visibility range — navigation still relies on the
 * USBL display.
 */
export class MissionMarkers {
  readonly group = new Group();
  private items = new Map<string, { root: Group; mats: MeshStandardMaterial[]; state: MissionMarker['state'] }>();
  private signature = '';

  constructor() {
    this.group.name = 'mission-markers';
  }

  /** Rebuild when the marker set changes, recolour when states change. */
  update(markers: MissionMarker[]): void {
    const sig = markers.map((m) => m.id).join('|');
    if (sig !== this.signature) {
      this.clear();
      this.signature = sig;
      for (const m of markers) this.items.set(m.id, { ...this.build(m), state: m.state });
    }
    for (const m of markers) {
      const it = this.items.get(m.id);
      if (!it || it.state === m.state) continue;
      it.state = m.state;
      for (const mat of it.mats) this.paint(mat, m.state);
    }
  }

  private paint(mat: MeshStandardMaterial, state: MissionMarker['state']): void {
    const c = COLORS[state];
    mat.emissive.setHex(c);
    mat.emissiveIntensity = state === 'active' ? 2.2 : state === 'done' ? 0.5 : 0.35;
  }

  private build(m: MissionMarker): { root: Group; mats: MeshStandardMaterial[] } {
    const root = new Group();
    root.position.set(m.position.x, m.position.y, m.position.z);
    const mats: MeshStandardMaterial[] = [];
    const glow = () => {
      const mat = new MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.1 });
      this.paint(mat, m.state);
      mats.push(mat);
      return mat;
    };
    const frame = new MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.7, metalness: 0.3 });
    if (m.kind === 'gate') {
      // LED ring on a buoyant frame, held by a mooring line to a clump weight.
      const ring = new Mesh(new TorusGeometry(m.radius, 0.06, 8, 48), glow());
      const n = m.normal ? new Vector3(m.normal.x, m.normal.y, m.normal.z) : new Vector3(0, 0, 1);
      ring.lookAt(n);
      root.add(ring);
      const collar = new Mesh(new TorusGeometry(m.radius + 0.08, 0.04, 6, 48), frame);
      collar.quaternion.copy(ring.quaternion);
      root.add(collar);
      const line = new Mesh(new CylinderGeometry(0.015, 0.015, 30, 4), frame);
      line.position.y = -m.radius - 15;
      root.add(line);
      root.add(this.label(m.label, new Vector3(0, m.radius + 0.45, 0)));
    } else if (m.kind === 'target') {
      // Yellow post with a numbered plate (the plate is what the camera must frame).
      const post = new Mesh(new CylinderGeometry(0.05, 0.06, 1.3, 8), new MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6 }));
      post.position.y = 0.65;
      root.add(post);
      const base = new Mesh(new CylinderGeometry(0.35, 0.4, 0.15, 12), frame);
      base.position.y = 0.07;
      root.add(base);
      const lamp = new Mesh(new CylinderGeometry(0.06, 0.06, 0.08, 10), glow());
      lamp.position.y = 1.62;
      root.add(lamp);
      root.add(this.label(m.label, new Vector3(0, 1.25, 0), true));
    } else {
      // Holding zone: horizontal LED circle.
      const ring = new Mesh(new TorusGeometry(m.radius, 0.03, 6, 64), glow());
      ring.rotation.x = Math.PI / 2;
      root.add(ring);
      root.add(this.label(m.label, new Vector3(0, 0.4, 0)));
    }
    root.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = true;
    });
    this.group.add(root);
    return { root, mats };
  }

  private label(text: string, at: Vector3, plate = false): Mesh {
    const tex = makeLabelTexture(text, { w: 256, h: 128, bg: plate ? '#f2f2ee' : '#e8b320', fg: '#111' });
    const mesh = new Mesh(new PlaneGeometry(plate ? 0.6 : 0.8, plate ? 0.3 : 0.4), new MeshStandardMaterial({ map: tex, roughness: 0.6, side: DoubleSide }));
    mesh.position.copy(at);
    return mesh;
  }

  clear(): void {
    for (const it of this.items.values()) {
      it.root.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as Material | undefined;
        if (mat) {
          (mat as MeshStandardMaterial).map?.dispose();
          mat.dispose();
        }
      });
      this.group.remove(it.root);
    }
    this.items.clear();
    this.signature = '';
  }
}
