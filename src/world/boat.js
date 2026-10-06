import * as THREE from 'three';
import { heightAt, layout, WATER } from './terrain.js';
import { platformHeight } from './colliders.js';

// A wooden rowboat on the lake. Get in near it (E), W/S to row ahead or back, A/D to turn, Shift for
// long hard strokes, E near the shore or the dock to step out.
//
// The rower sits facing the stern like a real one; the boat runs toward the bow. It floats (bob, pitch,
// roll), slides along its keel far more easily than sideways, glides between strokes and grounds gently
// in the shallows. Oars sweep, dip, drive and feather; every stroke leaves rings and a wake.

const LEN = 3.4, BEAM = 1.28, HL = LEN / 2, HB = BEAM / 2;
const GUNWALE = 0.28, DEPTH = 0.5; // gunwale above the waterline; hull depth below the gunwale
const SEAT_S = 0.04, LOCK_S = -0.14, INBOARD = 0.62, OUTBOARD = 1.55;

// plan and section of the hull (station s: −1 stern … +1 bow)
const halfBeam = (s) => (s >= 0 ? HB * Math.pow(Math.max(0, 1 - s * s), 0.52) : HB * (1 - 0.38 * Math.pow(-s, 2.6)));
const sheer = (s) => GUNWALE + 0.07 * s * s + 0.06 * Math.max(0, s);
const depthAt = (s) => DEPTH * (1 - 0.18 * s * s);
function hullPoint(s, u, inset = 0) {
  // u: −1 (port gunwale) … 0 (keel) … +1 (starboard gunwale); x < 0 is starboard
  const a = u * Math.PI / 2;
  const hb = Math.max(0, halfBeam(s) - inset);
  const top = sheer(s), d = depthAt(s) - inset;
  return [-Math.sin(a) * hb, top - d * Math.pow(Math.max(0, Math.cos(a)), 1.25), s * HL];
}

function woodTexture() {
  const W = 256, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ph = Array.from({ length: 8 }, () => rnd() * 6.28);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // grain runs along x; long wavy streaks and fine lines
    const v = y / H;
    const streak = Math.sin(v * 90 + Math.sin(x / W * 6.28 * 2 + ph[0]) * 2.4 + ph[1]) * 0.5 + 0.5;
    const fine = Math.sin(v * 420 + Math.sin(x / W * 6.28 * 5 + ph[2]) * 1.5) * 0.5 + 0.5;
    const k = 0.78 + 0.16 * streak + 0.06 * fine;
    const o = (y * W + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 * k; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildHull(woodMap) {
  const NS = 30, NU = 18;
  const pos = [], col = [], uv = [], idx = [];
  const paint = new THREE.Color('#3f6f78'), band = new THREE.Color('#e4d8c0'), wood = new THREE.Color('#9b7450'), keel = new THREE.Color('#3a2c21');
  const tmp = new THREE.Color();
  const surface = (inset, flip, colorAt) => {
    const base = pos.length / 3;
    for (let i = 0; i <= NS; i++) {
      const s = -1 + (2 * i) / NS;
      for (let j = 0; j <= NU; j++) {
        const u = -1 + (2 * j) / NU;
        const p = hullPoint(s, u, inset);
        pos.push(...p);
        colorAt(tmp, s, u);
        const v = 0.88 + 0.12 * Math.sin(i * 1.7 + j * 3.1) ** 2;
        col.push(tmp.r * v, tmp.g * v, tmp.b * v);
        uv.push(s * 2.2, (u + 1) * 2.5); // planks run bow to stern
      }
    }
    for (let i = 0; i < NS; i++) for (let j = 0; j < NU; j++) {
      const a = base + i * (NU + 1) + j, b = a + 1, c = a + NU + 1, d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  };
  // strakes: a seam darkens every fifth of the side
  const strake = (u) => 1 - 0.28 * Math.pow(Math.abs(Math.cos(Math.abs(u) * Math.PI * 2.5)), 24);
  surface(0, false, (c, s, u) => { if (Math.abs(u) > 0.84) c.copy(band); else if (Math.abs(u) < 0.08) c.copy(keel); else c.copy(paint); c.multiplyScalar(strake(u)); });
  surface(0.025, true, (c, s, u) => { c.copy(wood).multiplyScalar(strake(u) * (Math.abs(u) > 0.9 ? 0.85 : 1)); });
  // gunwale rim joining the two skins, and the transom
  const rimBase = pos.length / 3;
  for (let i = 0; i <= NS; i++) {
    const s = -1 + (2 * i) / NS;
    for (const u of [-1, 1]) {
      const o = hullPoint(s, u, 0), n = hullPoint(s, u, 0.025);
      pos.push(o[0], o[1] + 0.012, o[2], n[0], n[1] + 0.012, n[2]);
      col.push(0.46, 0.33, 0.22, 0.46, 0.33, 0.22);
      uv.push(s * 2.2, 0, s * 2.2, 0.1);
    }
  }
  for (let i = 0; i < NS; i++) for (let k = 0; k < 2; k++) {
    const a = rimBase + i * 4 + k * 2, c = a + 4;
    if (k === 0) idx.push(a, a + 1, c, a + 1, c + 1, c); else idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const tb = pos.length / 3;
  for (let j = 0; j <= NU; j++) {
    const u = -1 + (2 * j) / NU;
    const p = hullPoint(-1, u, 0), q = hullPoint(-1, u, 0.025);
    pos.push(...p, q[0], q[1], q[2] + 0.025);
    col.push(0.25, 0.44, 0.47, 0.6, 0.45, 0.31);
    uv.push(u, 0, u, 0.1);
  }
  const mid = hullPoint(-1, 0, 0);
  for (let j = 0; j < NU; j++) {
    const a = tb + j * 2, c = a + 2;
    idx.push(a, c, a + 1, a + 1, c, c + 1); // closes the transom's edge; the flat face comes from a fan
  }
  const fo = pos.length / 3, fi = fo + 1;
  pos.push(0, sheer(-1) - 0.05, -HL, 0, sheer(-1) - 0.05, -HL + 0.025);
  col.push(0.25, 0.44, 0.47, 0.6, 0.45, 0.31);
  uv.push(0, 0.5, 0, 0.5);
  for (let j = 0; j < NU; j++) {
    const a = tb + j * 2;
    idx.push(fo, a + 2, a, fi, a + 1, a + 3);
  }
  void mid;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z, color, mats) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  mats.push(g);
}

function buildOar(woodMat) {
  const g = new THREE.Group();
  const shaft = new THREE.CylinderGeometry(0.021, 0.024, INBOARD + OUTBOARD - 0.45, 10).rotateZ(Math.PI / 2).translate((OUTBOARD - 0.45 - INBOARD) / 2, 0, 0);
  const grip = new THREE.CylinderGeometry(0.018, 0.018, 0.16, 10).rotateZ(Math.PI / 2).translate(-INBOARD + 0.08, 0, 0);
  const blade = new THREE.BoxGeometry(0.52, 0.012, 0.13).translate(OUTBOARD - 0.26, 0, 0);
  const collar = new THREE.CylinderGeometry(0.028, 0.028, 0.06, 10).rotateZ(Math.PI / 2);
  for (const geo of [shaft, grip, blade, collar]) {
    const m = new THREE.Mesh(geo, woodMat);
    m.castShadow = true;
    g.add(m);
  }
  const feather = g.children[2]; // the blade turns flat on the way back
  return { group: g, blade: feather };
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const smooth = (t) => t * t * (3 - 2 * t);

export function createBoat(scene, { water, fx, audio }) {
  const woodMap = woodTexture();
  const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: woodMap, roughness: 0.78, metalness: 0, side: THREE.FrontSide });
  const woodMat = new THREE.MeshStandardMaterial({ color: '#9c7552', map: woodMap, roughness: 0.72 });
  const root = new THREE.Group(); // at the waterline, heading along +z
  const tilt = new THREE.Group(); // bob / pitch / roll
  root.add(tilt);
  const hull = new THREE.Mesh(buildHull(woodMap), hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  tilt.add(hull);
  // thwarts, floorboards, oarlocks (merged)
  const parts = [];
  // hull half-width at a height `below` the gunwale
  const widthAt = (st, below) => { const ca = Math.pow(Math.min(1, below / depthAt(st)), 0.8); return halfBeam(st) * Math.sqrt(1 - ca * ca); };
  for (const s of [-0.66, SEAT_S, 0.58]) box(2 * (widthAt(s, 0.19) - 0.03), 0.035, 0.24, 0, sheer(s) - 0.19, s * HL, '#8d6746', parts);
  for (const x of [-0.15, 0, 0.15]) box(0.12, 0.02, 1.8, x, sheer(0) - DEPTH + 0.1, -0.2, '#7f5d40', parts);
  box(2 * halfBeam(-1) + 0.02, 0.04, 0.05, 0, sheer(-1) - 0.005, -HL + 0.012, '#6f513a', parts); // transom cap
  for (const sg of [-1, 1]) {
    const x = sg * (halfBeam(LOCK_S) - 0.01);
    box(0.05, 0.05, 0.12, x, sheer(LOCK_S) + 0.02, LOCK_S * HL, '#5a4330', parts);
  }
  const merged = mergeGeos(parts);
  const fittings = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, map: woodMap, roughness: 0.75 }));
  fittings.castShadow = true;
  fittings.receiveShadow = true;
  tilt.add(fittings);
  const oars = [1, -1].map((side) => { // +1 port (+x), −1 starboard
    const o = buildOar(woodMat);
    const lock = new THREE.Group();
    lock.position.set(side * (halfBeam(LOCK_S) - 0.01), sheer(LOCK_S) + 0.05, LOCK_S * HL);
    tilt.add(lock);
    lock.add(o.group);
    return { side, lock, ...o, sweep: 0.15, elev: 0.12, feather: 0, power: 0, inWater: false };
  });
  scene.add(root);

  // moored beside the end of the dock, where the old boat used to bob
  const d = layout.dock;
  const L = 22;
  const st = {
    x: d.x + d.dirX * (L - 5) + Math.cos(d.angle) * 2.8, z: d.z + d.dirZ * (L - 5) - Math.sin(d.angle) * 2.8,
    yaw: d.angle + 0.25, vx: 0, vz: 0, w: 0, phase: 0, rowing: 0, strokeT: 1.25, pitch: 0, roll: 0, t: 0,
    occupied: false,
  };

  const dockBox = () => ({ cx: d.x + d.dirX * (L - 3) / 2, cz: d.z + d.dirZ * (L - 3) / 2, a: d.angle, hw: 1.45, hl: (L + 3) / 2 + 0.2 });
  const inDock = (x, z) => {
    const b = dockBox();
    const dx = x - b.cx, dz = z - b.cz;
    const lx = dx * Math.cos(b.a) - dz * Math.sin(b.a), lz = dx * Math.sin(b.a) + dz * Math.cos(b.a);
    return Math.abs(lx) < b.hw && Math.abs(lz) < b.hl ? { lx, lz, b } : null;
  };
  const toWorld = (lx, ly, lz, out) => {
    const c = Math.cos(st.yaw), s = Math.sin(st.yaw);
    return out.set(st.x + lx * c + lz * s, WATER + ly, st.z - lx * s + lz * c);
  };
  const probes = [[0, HL * 0.95], [0, -HL * 0.95], [HB * 0.8, 0], [-HB * 0.8, 0], [HB * 0.6, HL * 0.55], [-HB * 0.6, HL * 0.55], [HB * 0.7, -HL * 0.6], [-HB * 0.7, -HL * 0.6]];

  function physics(dt, input) {
    const fwd = input ? input.fwd : 0, turn = input ? input.turn : 0, strong = input?.strong;
    // oar powers: turning pulls one oar and backs the other
    const pPort = THREE.MathUtils.clamp(fwd - turn * 0.85, -1, 1), pStar = THREE.MathUtils.clamp(fwd + turn * 0.85, -1, 1);
    const want = Math.abs(pPort) > 0.05 || Math.abs(pStar) > 0.05;
    st.strokeT = strong ? 0.98 : 1.28;
    const prev = st.phase;
    if (want || (st.phase % 1) > 0.02) st.phase += dt / st.strokeT; // finish the stroke before resting
    st.rowing += ((want ? 1 : 0) - st.rowing) * (1 - Math.exp(-dt * 4));
    const ph = st.phase % 1;
    const drive = ph < 0.5 ? Math.sin((ph / 0.5) * Math.PI) : 0; // blades in the water
    for (const o of oars) o.power += ((o.side > 0 ? pPort : pStar) * (want ? 1 : 0) - o.power) * (1 - Math.exp(-dt * 6));
    const pow = strong ? 1.45 : 1;
    const thrust = (oars[0].power + oars[1].power) * 0.5 * drive * 2.6 * pow;
    const torque = (oars[1].power - oars[0].power) * 0.5 * drive * 2.3 * pow;
    // velocity in the boat frame: u along the keel, l sideways
    const hx = Math.sin(st.yaw), hz = Math.cos(st.yaw);
    let u = st.vx * hx + st.vz * hz, l = st.vx * hz - st.vz * hx;
    u += (thrust - 0.22 * u - 0.1 * u * Math.abs(u)) * dt;
    l -= l * Math.min(1, 2.6 * dt);
    st.w += (torque - 1.6 * st.w) * dt;
    st.w *= Math.exp(-dt * 0.6);
    // shallows and the dock: push back and slow down
    let gx = 0, gz = 0, ground = 0;
    for (const [px, pz] of probes) {
      toWorld(px, 0, pz, _v);
      const depth = WATER - heightAt(_v.x, _v.z);
      const dk = inDock(_v.x, _v.z);
      let pen = Math.max(0, 0.2 - depth) * 3;
      if (dk) pen = Math.max(pen, 0.4);
      if (pen > 0) {
        gx += (st.x - _v.x) * pen; gz += (st.z - _v.z) * pen;
        ground = Math.max(ground, pen);
      }
    }
    st.vx = u * hx + l * hz; st.vz = u * hz - l * hx;
    if (ground > 0) {
      const gl = Math.hypot(gx, gz) || 1;
      const nx = gx / gl, nz = gz / gl;
      const into = st.vx * nx + st.vz * nz;
      if (into < 0) { st.vx -= into * nx * 1.2; st.vz -= into * nz * 1.2; }
      st.vx += nx * ground * 3 * dt; st.vz += nz * ground * 3 * dt;
      st.vx *= Math.exp(-dt * 2.5 * ground); st.vz *= Math.exp(-dt * 2.5 * ground);
    }
    st.x += st.vx * dt; st.z += st.vz * dt;
    st.yaw += st.w * dt;
    // strokes: splash and rings where the blades bite, a softer ring where they leave the water
    const crossed = (edge) => Math.floor(prev - edge) !== Math.floor(st.phase - edge);
    if (st.rowing > 0.3 && want) {
      for (const o of oars) {
        if (Math.abs(o.power) < 0.2) continue;
        o.blade.getWorldPosition(_w);
        if (crossed(0.02)) { water?.ring(_w.x, _w.z, 0.9 * Math.abs(o.power)); fx?.splash(_w, 0.35); if (o.side > 0) audio?.footstep('water', 0.45 * pow); }
        if (crossed(0.5)) water?.ring(_w.x, _w.z, 0.45 * Math.abs(o.power));
      }
    }
    return { drive, ph };
  }

  function animateOars(dt, ph) {
    for (const o of oars) {
      const p = Math.abs(o.power), back = o.power < -0.05;
      // catch: blade toward the bow; finish: toward the stern (reversed, and shorter, when backing water)
      const c = back ? 0.32 : 0.72, f = back ? -0.28 : -0.55;
      let sweep, elev, feather;
      if (ph < 0.5) {
        const k = smooth(ph / 0.5);
        sweep = back ? f + (c - f) * k : c + (f - c) * k;
        elev = 0.2; feather = 0;
      } else {
        const k = smooth((ph - 0.5) / 0.5);
        sweep = back ? c + (f - c) * k : f + (c - f) * k;
        elev = 0.05 + 0.03 * Math.sin(k * Math.PI); feather = Math.sin(k * Math.PI) > 0.2 ? 1 : Math.sin(k * Math.PI) * 5;
      }
      // resting: oars trail, blades just touching the water
      const rest = 1 - Math.min(1, st.rowing * 1.4) * Math.min(1, p * 3 + 0.25);
      sweep = sweep + (0.18 - sweep) * rest; elev = elev + (0.1 - elev) * rest; feather *= 1 - rest;
      const k = 1 - Math.exp(-dt * 18);
      o.sweep += (sweep - o.sweep) * k; o.elev += (elev - o.elev) * k; o.feather += (feather - o.feather) * k;
      // the oar points outboard (±x) and turns by sweep; elev dips the blade
      _e.set(0, -o.side * o.sweep, 0, 'YXZ');
      o.group.quaternion.setFromEuler(_e);
      o.group.rotateOnAxis(new THREE.Vector3(0, 0, 1), -o.side * o.elev);
      if (o.side < 0) o.group.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.PI);
      o.blade.rotation.x = (1 - o.feather) * Math.PI / 2; // square in the water, flat on the way back
    }
  }

  const handles = [new THREE.Vector3(), new THREE.Vector3()];
  const api = {
    root, st,
    get x() { return st.x; }, get z() { return st.z; }, get yaw() { return st.yaw; },
    get speed() { return Math.hypot(st.vx, st.vz); },
    update(dt, input) {
      st.t += dt;
      const elapsed = st.t;
      const { drive, ph } = physics(dt, st.occupied ? input : null);
      animateOars(dt, ph);
      // float: gentle bob, pitch with each stroke, roll into turns
      const pitchT = st.occupied ? -0.035 * drive * st.rowing + 0.012 : 0;
      st.pitch += (pitchT - st.pitch) * (1 - Math.exp(-dt * 5));
      st.roll += (-st.w * 0.05 - st.roll) * (1 - Math.exp(-dt * 3));
      const bob = Math.sin(elapsed * 1.25) * 0.025 + Math.sin(elapsed * 0.73 + 1) * 0.015 - (st.occupied ? 0.05 : 0);
      root.position.set(st.x, WATER + bob, st.z);
      root.rotation.set(0, st.yaw, 0);
      tilt.rotation.set(st.pitch + Math.sin(elapsed * 0.9) * 0.012, 0, st.roll + Math.sin(elapsed * 1.1 + 2) * 0.015);
      root.updateMatrixWorld(true);
      water?.hull(st.x, st.z, st.yaw, HL, HB);
      const sp = Math.hypot(st.vx, st.vz);
      if (sp > 0.15) water?.wake(st.x, st.z, st.vx, st.vz, Math.min(1, sp / 2.2), HL * 1.05, HB * 1.1);
    },
    // where the rower sits (world), facing the stern
    seat(out) { return tilt.localToWorld(out.set(0, sheer(SEAT_S) - 0.19 + 0.02, SEAT_S * HL)); },
    floorY() { return tilt.localToWorld(_v.set(0, sheer(0) - DEPTH + 0.11, SEAT_S * HL - 0.35)).y; },
    // where the hands hold the oar handles (world) — [left hand, right hand]
    handles() {
      for (const o of oars) {
        const i = o.side > 0 ? 1 : 0; // facing the stern, the rower's right hand has the port oar
        handles[i].set(-INBOARD + 0.08, 0, 0);
        o.group.localToWorld(handles[i]);
      }
      return handles;
    },
    stroke() { return { phase: st.phase % 1, rowing: st.rowing, pitch: st.pitch }; },
    tilt,
    near(p, r = 2.8) { return Math.hypot(p.x - st.x, p.z - st.z) < r; },
    // somewhere to step out: the dock, dry land, or water shallow enough to wade ashore (drier is better)
    landing(from) {
      let best = null, bd = Infinity;
      for (let ring = 1.3; ring <= 3.6; ring += 0.35) for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        const x = st.x + Math.cos(a) * ring, z = st.z + Math.sin(a) * ring;
        const deck = platformHeight(x, z);
        const g = heightAt(x, z);
        const depth = deck > -Infinity ? 0 : Math.max(0, WATER - g);
        if (depth > 0.55) continue;
        const score = Math.hypot(x - from.x, z - from.z) + depth * 4;
        if (score < bd) { bd = score; best = { x, z, y: Math.max(deck, g) }; }
      }
      return best;
    },
    // a spot in open water beside the hull, for slipping over the side to swim
    overboard(out) {
      const c = Math.cos(st.yaw), s = Math.sin(st.yaw);
      return out.set(st.x + c * 1.3, WATER, st.z - s * 1.3);
    },
  };
  return api;
}

function mergeGeos(list) {
  let n = 0, ni = 0;
  for (const g of list) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(ni);
  let o = 0, oi = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3); uv.set(g.attributes.uv.array, o * 2);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx[oi + i] = ix[i] + o;
    o += g.attributes.position.count; oi += ix.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
