import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAUNCH_HANG_HEIGHT, LAUNCH_POINT, VESSEL } from '../sim/site';
import { makeLabelTexture } from './materials';

/** Gradient sky dome (visible above water only). */
export function createSky(): Mesh {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: { uSunDir: { value: new Vector3(0.4, 0.55, -0.6).normalize() } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w; // at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 horizon = vec3(0.70, 0.78, 0.84);
        vec3 zenith = vec3(0.22, 0.42, 0.66);
        vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
        float sun = max(dot(normalize(vDir), uSunDir), 0.0);
        col += vec3(1.0, 0.92, 0.78) * (pow(sun, 900.0) * 4.0 + pow(sun, 12.0) * 0.18);
        // Low marine haze band.
        col = mix(col, vec3(0.78, 0.82, 0.85), smoothstep(0.08, 0.0, h) * 0.6);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new Mesh(new SphereGeometry(1500, 32, 16), mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

/**
 * Sea surface seen from above (wavy, Fresnel sky reflection) and from below
 * (Snell's window: bright transmission inside ~48.6°, total internal
 * reflection outside).
 */
export function createSeaSurface(): Mesh & { material: ShaderMaterial } {
  const geo = new PlaneGeometry(3000, 3000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new ShaderMaterial({
    side: DoubleSide,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new Vector3(0.4, 0.55, -0.6).normalize() },
      uCamPos: { value: new Vector3() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWPos = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uCamPos;
      varying vec3 vWPos;
      vec2 wave(vec2 p, vec2 d, float f, float a, float s) {
        float ph = dot(p, d) * f + uTime * s;
        return d * cos(ph) * a * f;
      }
      vec3 normalAt(vec2 p) {
        vec2 g = vec2(0.0);
        g += wave(p, normalize(vec2(1.0, 0.3)), 0.18, 0.35, 1.1);
        g += wave(p, normalize(vec2(-0.4, 1.0)), 0.31, 0.18, 1.6);
        g += wave(p, normalize(vec2(0.8, -0.7)), 0.73, 0.06, 2.3);
        g += wave(p, normalize(vec2(-0.9, -0.2)), 1.7, 0.02, 3.4);
        g += wave(p, normalize(vec2(0.2, 0.9)), 3.1, 0.008, 4.6);
        return normalize(vec3(-g.x, 1.0, -g.y));
      }
      void main() {
        vec3 n = normalAt(vWPos.xz);
        vec3 v = normalize(uCamPos - vWPos);
        float dist = length(uCamPos - vWPos);
        if (uCamPos.y >= 0.0) {
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          vec3 r = reflect(-v, n);
          vec3 sky = mix(vec3(0.68, 0.76, 0.82), vec3(0.25, 0.44, 0.66), pow(max(r.y, 0.0), 0.5));
          vec3 deep = vec3(0.02, 0.10, 0.14);
          vec3 col = mix(deep, sky, fres);
          float spec = pow(max(dot(r, uSunDir), 0.0), 220.0) * 6.0;
          col += vec3(1.0, 0.95, 0.85) * spec;
          // Foam near the vessel hull.
          float a = mix(0.9, 0.98, fres);
          gl_FragColor = vec4(col, a);
        } else {
          // From below: the surface normal points down towards the viewer.
          vec3 nb = -n;
          float cosI = max(dot(nb, v), 0.0);
          float sinT = 1.333 * sqrt(max(0.0, 1.0 - cosI * cosI));
          float inWindow = 1.0 - smoothstep(0.92, 1.0, sinT);
          vec3 sky = vec3(0.75, 0.88, 0.95) * 1.6;
          vec3 tir = vec3(0.03, 0.16, 0.2);
          vec3 col = mix(tir, sky, inWindow);
          col += pow(max(dot(refract(-v, nb, 1.333), uSunDir), 0.0), 60.0) * 3.0 * inWindow;
          gl_FragColor = vec4(col, 1.0);
        }
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(geo, mat) as Mesh & { material: ShaderMaterial };
  mesh.name = 'sea-surface';
  mesh.renderOrder = 2;
  return mesh;
}

export interface VesselRig {
  group: Group;
  /** Crane boom tip (world), above the launch point. */
  boomTip: Vector3;
  /** Lift wire from the boom tip to the ROV latch. */
  wire: Line;
  setWire(to: Vector3 | null): void;
}

/** Offshore support vessel with a heavy-lift knuckle crane on the starboard side. */
export function createVessel(): VesselRig {
  const group = new Group();
  group.name = 'vessel';
  const L = VESSEL.length;
  const B = VESSEL.beam;
  const T = VESSEL.draft;
  const freeboard = 3.2;

  // Hull plan shape (bow towards -Z) extruded vertically.
  const s = new Shape();
  s.moveTo(-B / 2, L / 2);
  s.lineTo(B / 2, L / 2);
  s.lineTo(B / 2, -L / 2 + 16);
  s.quadraticCurveTo(B / 2, -L / 2 + 2, 0, -L / 2);
  s.quadraticCurveTo(-B / 2, -L / 2 + 2, -B / 2, -L / 2 + 16);
  s.closePath();
  const hullGeo = new ExtrudeGeometry(s, { depth: T + freeboard, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, steps: 1 });
  hullGeo.rotateX(Math.PI / 2); // extrude along -Y
  hullGeo.translate(0, freeboard, 0);
  // Vertex colours: red antifouling below the waterline, dark blue-grey topsides, white boot top.
  const pos = hullGeo.attributes.position;
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < -0.4) cols.push(0.45, 0.08, 0.06);
    else if (y < 0.4) cols.push(0.9, 0.9, 0.88);
    else cols.push(0.14, 0.19, 0.25);
  }
  hullGeo.setAttribute('color', new Float32BufferAttribute(cols, 3));
  const hull = new Mesh(hullGeo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }));
  hull.castShadow = hull.receiveShadow = true;
  group.add(hull);

  // Superstructure, deck items.
  const white = new MeshStandardMaterial({ color: 0xe6e8e8, roughness: 0.6 });
  const deckGrey = new MeshStandardMaterial({ color: 0x55606a, roughness: 0.85 });
  const yellow = new MeshStandardMaterial({ color: 0xe0a821, roughness: 0.55, metalness: 0.2 });
  const parts: { geo: BufferGeometry; m: Matrix4 }[] = [];
  const put = (geo: BufferGeometry, x: number, y: number, z: number, rot?: Euler) =>
    parts.push({ geo, m: new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(rot ?? new Euler()), new Vector3(1, 1, 1)) });
  put(new BoxGeometry(B - 2, 7, 16), 0, freeboard + 3.5, -L / 2 + 22);
  put(new BoxGeometry(B - 5, 3, 11), 0, freeboard + 8.5, -L / 2 + 21);
  put(new BoxGeometry(B - 7, 2.6, 6), 0, freeboard + 11.3, -L / 2 + 20); // bridge
  put(new CylinderGeometry(0.4, 0.4, 9, 10), 0, freeboard + 16, -L / 2 + 21); // mast
  put(new BoxGeometry(6, 0.25, 3.5), 0, freeboard + 12.8, -L / 2 + 20); // helideck-like platform
  const whiteGeo = mergeGeometries(parts.map((p) => p.geo.toNonIndexed().applyMatrix4(p.m)));
  const sup = new Mesh(whiteGeo, white);
  sup.castShadow = true;
  group.add(sup);
  const deck = new Mesh(new BoxGeometry(B - 0.6, 0.2, L - 26), deckGrey);
  deck.position.set(0, freeboard + 0.1, 10);
  deck.receiveShadow = true;
  group.add(deck);
  // Containers / control van on deck.
  const vanMat = new MeshStandardMaterial({ color: 0x2f5d7c, roughness: 0.7 });
  for (const [x, z] of [
    [-5, 14],
    [-5, 21],
    [-1, 28],
  ]) {
    const van = new Mesh(new BoxGeometry(2.6, 2.6, 6), vanMat);
    van.position.set(x, freeboard + 1.4, z);
    van.castShadow = true;
    group.add(van);
  }
  const vanLabel = new Mesh(new PlaneGeometry(4.5, 1.1), new MeshStandardMaterial({ map: makeLabelTexture('ROV CONTROL', { w: 512, h: 128, bg: '#2f5d7c', fg: '#e8eef2' }) }));
  vanLabel.position.set(-3.68, freeboard + 1.8, 14);
  vanLabel.rotation.y = Math.PI / 2;
  group.add(vanLabel);

  // Knuckle-boom crane at the starboard side reaching over the launch point.
  const base = new Vector3(B / 2 - 2.5, freeboard, LAUNCH_POINT.z);
  const pedestal = new Mesh(new CylinderGeometry(1.1, 1.3, 4, 16), yellow);
  pedestal.position.copy(base).add(new Vector3(0, 2, 0));
  const tip = new Vector3(LAUNCH_POINT.x, LAUNCH_HANG_HEIGHT + 7.5, LAUNCH_POINT.z);
  const knuckle = new Vector3(base.x + 1.2, base.y + 11, base.z);
  const boom1 = beamMesh(new Vector3(base.x, base.y + 4, base.z), knuckle, 0.9, yellow);
  const boom2 = beamMesh(knuckle, tip, 0.7, yellow);
  const sheave = new Mesh(new CylinderGeometry(0.45, 0.45, 0.4, 16), new MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 }));
  sheave.position.copy(tip);
  sheave.rotation.x = Math.PI / 2;
  for (const m of [pedestal, boom1, boom2, sheave]) {
    m.castShadow = true;
    group.add(m);
  }

  const wireGeo = new BufferGeometry().setFromPoints([tip, tip.clone().add(new Vector3(0, -3, 0))]);
  const wire = new Line(wireGeo, new LineBasicMaterial({ color: 0x1b1b1b }));
  wire.frustumCulled = false;
  group.add(wire);
  return {
    group,
    boomTip: tip,
    wire,
    setWire(to) {
      wire.visible = to !== null;
      if (to) {
        const p = wire.geometry.attributes.position;
        p.setXYZ(0, tip.x, tip.y, tip.z);
        p.setXYZ(1, to.x, to.y, to.z);
        p.needsUpdate = true;
      }
    },
  };
}

function beamMesh(a: Vector3, b: Vector3, size: number, mat: MeshStandardMaterial): Mesh {
  const d = new Vector3().subVectors(b, a);
  const m = new Mesh(new BoxGeometry(size, d.length(), size), mat);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize());
  return m;
}

export const SURFACE_COLORS = { water: new Color(0x0b2a35) };
