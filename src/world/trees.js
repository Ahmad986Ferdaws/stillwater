import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cellUV, BARK } from './textures.js';

// Procedural trees: branching skeletons -> tapered bark tubes + alpha-tested leaf-cluster cards.
// Every species returns { bark, leaves, far } geometries:
//   bark   : position, normal, color (AO/tint), aBark (u, v, bark layer), aWind      -> barkMaterial
//   leaves : position, normal (canopy-centre biased), uv (atlas), color (AO), aWind  -> leafMaterial
//   far    : one merged low-detail mesh (trunk mapped to the atlas bark swatch + big cards) -> leafMaterial
// aWind = (branch flex, card flutter, phase (+1 for foliage), trunk sway weight).

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const GOLD = Math.PI * (3 - Math.sqrt(5));

function anyPerp(d) {
  const a = Math.abs(d.y) < 0.92 ? UP : V(1, 0, 0);
  return V().crossVectors(d, a).normalize();
}

// ---- geometry accumulator ---------------------------------------------------------------------
class Acc {
  constructor() { this.p = []; this.n = []; this.c = []; this.w = []; this.uv = []; this.bk = []; this.i = []; this.cr = []; }
  get count() { return this.p.length / 3; }
  // corner: camera-facing offset (metres, card plane) for billboard cards; [0, 0] = fixed vertex
  v(p, n, c, w, uv, bk, corner) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.c.push(c[0], c[1], c[2]);
    this.w.push(w[0], w[1], w[2], w[3]);
    if (uv) this.uv.push(uv[0], uv[1]);
    if (bk) this.bk.push(bk[0], bk[1], bk[2]);
    this.cr.push(corner ? corner[0] : 0, corner ? corner[1] : 0);
    return this.count - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.w, 4));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.bk.length) g.setAttribute('aBark', new THREE.Float32BufferAttribute(this.bk, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.cr, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---- skeleton -----------------------------------------------------------------------------------
// o: { start, dir, len, r0, r1, segs, gravity, wiggle, flex0, flexGain, phase, depth, taper }
function grow(rnd, o) {
  const pts = [o.start.clone()], rad = [o.r0], flex = [o.flex0 ?? 0];
  const d = o.dir.clone().normalize();
  const step = o.len / o.segs;
  for (let i = 1; i <= o.segs; i++) {
    const t = i / o.segs;
    d.y += (o.gravity ?? 0) * step;
    const wg = o.wiggle ?? 0.2;
    d.x += (rnd() - 0.5) * wg; d.z += (rnd() - 0.5) * wg; d.y += (rnd() - 0.5) * wg * 0.4;
    d.normalize();
    pts.push(pts[i - 1].clone().addScaledVector(d, step));
    rad.push(o.r0 + (o.r1 - o.r0) * Math.pow(t, o.taper ?? 1));
    flex.push((o.flex0 ?? 0) + (o.flexGain ?? 0.5) * Math.pow(t, 1.5));
  }
  return { pts, rad, flex, phase: o.phase ?? rnd(), depth: o.depth ?? 0, len: o.len, flare: o.flare ?? 0 };
}

function sampleBranch(br, t) {
  const n = br.pts.length - 1;
  const f = clamp01(t) * n, i = Math.min(n - 1, Math.floor(f)), k = f - i;
  const p = br.pts[i].clone().lerp(br.pts[i + 1], k);
  const d = br.pts[i + 1].clone().sub(br.pts[i]).normalize();
  return { p, d, r: br.rad[i] + (br.rad[i + 1] - br.rad[i]) * k, flex: br.flex[i] + (br.flex[i + 1] - br.flex[i]) * k };
}

// Child direction: rotate parent dir away by `ang` around a perpendicular at azimuth `az`.
function childDir(parent, ang, az) {
  const p = anyPerp(parent).applyAxisAngle(parent, az);
  return parent.clone().applyAxisAngle(p, ang).normalize();
}

// Direction at elevation `el` (radians above horizontal) and azimuth `az`.
function dirEA(az, el) { return V(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)); }

// ---- tube (bark) ----------------------------------------------------------------------------------
// sides: radial segments. Near: bark array uv (tiles around, repeating along). Far: atlas swatch.
function tube(acc, br, sides, sp, far) {
  const n = br.pts.length;
  const tang = br.pts.map((_, i) => {
    const a = br.pts[Math.max(0, i - 1)], b = br.pts[Math.min(n - 1, i + 1)];
    return b.clone().sub(a).normalize();
  });
  const nor = anyPerp(tang[0]);
  const C0 = Math.PI * 2 * br.rad[0];
  const tiles = Math.max(1, Math.round(C0 / 0.8));
  const tileH = C0 / tiles;
  const base = acc.count;
  const q = new THREE.Quaternion();
  const cell = far ? cellUV('bark') : null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      q.setFromUnitVectors(tang[i - 1], tang[i]);
      nor.applyQuaternion(q).normalize();
      s += br.pts[i].distanceTo(br.pts[i - 1]);
    }
    const bin = V().crossVectors(tang[i], nor).normalize();
    const flare = br.flare ? 1 + br.flare * Math.exp(-s / 0.45) : 1;
    const r = br.rad[i] * flare;
    const y = br.pts[i].y;
    const ao = (0.5 + 0.5 * smooth(0, 1.4, y)) * (br.depth > 0 ? 0.85 : 1);
    const c = [sp.barkTint[0] * ao, sp.barkTint[1] * ao, sp.barkTint[2] * ao];
    const w = [br.flex[i], 0, br.phase, sway(y, sp.H)];
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const dir = nor.clone().multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
      const p = br.pts[i].clone().addScaledVector(dir, r);
      if (far) {
        acc.v(p, dir, c, w, [cell[0] + (cell[2] - cell[0]) * (j / sides), cell[1] + (cell[3] - cell[1]) * clamp01(s / (br.len * 1.05))]);
      } else {
        acc.v(p, dir, c, w, null, [(j / sides) * tiles, s / tileH, sp.bark]);
      }
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * (sides + 1) + j, b = a + sides + 1;
      acc.tri(a, a + 1, b);
      acc.tri(a + 1, b + 1, b);
    }
  }
}

const sway = (y, H) => { const t = clamp01(y / H); return t * t; };

// ---- leaf cards --------------------------------------------------------------------------------
// Canopy-centred normals + ellipsoidal AO; crown = { c: Vector3, r: Vector3 }.
function canopyShade(p, crown) {
  const d = V((p.x - crown.c.x) / crown.r.x, (p.y - crown.c.y) / crown.r.y, (p.z - crown.c.z) / crown.r.z);
  const len = d.length();
  const n = V(d.x / crown.r.x, d.y / crown.r.y, d.z / crown.r.z);
  if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
  n.normalize();
  const ao = (0.5 + 0.5 * smooth(0.15, 1.0, len)) * (0.76 + 0.24 * smooth(-0.8, 0.6, d.y));
  return { n, ao };
}

// facing: a camera-facing leaf-cluster billboard centred on the card (roll = its in-plane angle).
// Billboards read full from every direction, fixed cards give the branch structure.
function card(acc, a, up, nrm, size, aspect, cellName, crown, sp, flex, phase, tint, bend = 0, facing = false, roll = 0) {
  const [u0, v0, u1, v1] = cellUV(cellName);
  const side = V().crossVectors(up, nrm).normalize();
  const w = size * aspect * 0.5;
  const b0 = a.clone().addScaledVector(up, -size * 0.06);
  const top = b0.clone().addScaledVector(up, size).addScaledVector(nrm, bend * size);
  const P = [b0.clone().addScaledVector(side, -w), b0.clone().addScaledVector(side, w), top.clone().addScaledVector(side, w), top.clone().addScaledVector(side, -w)];
  const UV = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const FL = [0, 0, 1, 1];
  const centre = b0.clone().addScaledVector(up, size * 0.5);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const CO = [[-w, -size * 0.5], [w, -size * 0.5], [w, size * 0.5], [-w, size * 0.5]].map(([x, y]) => [x * cr - y * sr, x * sr + y * cr]);
  const base = acc.count;
  for (let k = 0; k < 4; k++) {
    const sh = canopyShade(facing ? centre.clone().addScaledVector(side, CO[k][0] * 0.5).addScaledVector(up, CO[k][1] * 0.5) : P[k], crown);
    const n = nrm.clone().multiplyScalar(facing ? 0.1 : 0.22).addScaledVector(sh.n, facing ? 0.9 : 0.78).normalize();
    const ao = sh.ao;
    const pos = facing ? centre : P[k];
    acc.v(pos, n, [tint[0] * ao, tint[1] * ao, tint[2] * ao], [flex, FL[k], 1 + (phase % 1), sway(pos.y, sp.H)], UV[k], null, facing ? CO[k] : null);
  }
  acc.tri(base, base + 1, base + 2);
  acc.tri(base, base + 2, base + 3);
}

function leafTint(rnd) {
  const k = 0.9 + rnd() * 0.2, t = rnd();
  if (t < 0.18) return [k * 1.06, k * 1.02, k * 0.84];
  if (t > 0.86) return [k * 0.9, k * 0.97, k * 1.02];
  return [k, k, k];
}
// Broadleaf crowns (oak, birch, Grandmother Tree, bushes): brightness +-12 % and a continuous hue
// shift from cool blue-green to warm yellow-green, so a crown isn't one flat colour.
function leafTintHue(rnd) {
  const k = 0.88 + rnd() * 0.24, h = rnd() * 2 - 1;
  const w = Math.max(h, 0), c = Math.max(-h, 0);
  return [k * (1 + 0.07 * w - 0.05 * c), k * (1 + 0.025 * w - 0.015 * c), k * (1 - 0.17 * w + 0.05 * c)];
}

// Lumpy crown: a few random lobes push the shell outward so silhouettes are not perfect ellipsoids.
function crownLobes(rnd, n = 6) {
  const lobes = [];
  for (let i = 0; i < n; i++) {
    const u = rnd() * Math.PI * 2, y = 0.9 - rnd() * 1.3, s = Math.sqrt(Math.max(0, 1 - y * y));
    lobes.push({ d: V(Math.cos(u) * s, y, Math.sin(u) * s), w: 0.55 + rnd() * 0.45 });
  }
  return (dir) => {
    let t = 0;
    for (const l of lobes) { const k = Math.max(0, dir.dot(l.d)); t += l.w * k * k * k; }
    return 0.8 + 0.32 * Math.min(1, t);
  };
}

// Card lying on the crown shell and facing outward (instead of a radial "fin" that is seen edge-on
// from outside), rotated and tilted a little so neighbours overlap like real foliage.
function shellCard(rnd, q, crown) {
  const g = V((q.x - crown.c.x) / (crown.r.x * crown.r.x), (q.y - crown.c.y) / (crown.r.y * crown.r.y), (q.z - crown.c.z) / (crown.r.z * crown.r.z));
  if (g.lengthSq() < 1e-10) g.set(0, 1, 0);
  g.normalize();
  let up = UP.clone().addScaledVector(g, -g.dot(UP));
  if (up.lengthSq() < 1e-3) up = anyPerp(g);
  up.normalize().applyAxisAngle(g, (rnd() - 0.5) * 1.7);
  // most cards lie on the shell; some are tilted hard so the silhouette never shows only slivers
  const n = g.clone().applyAxisAngle(up, (rnd() - 0.5) * (rnd() < 0.35 ? 2.4 : 0.8)).normalize();
  up.addScaledVector(n, -up.dot(n)).normalize();
  return { up, n };
}

// Evenly spread points over the crown (Fibonacci shell, few on the underside), a quarter of them
// inside the volume to plug see-through gaps. Returns [{ q, dir, inner }].
function shellPoints(rnd, crown, count, lump, yMin = -0.45) {
  const out = [], a0 = rnd() * 6.28;
  for (let k = 0; k < count; k++) {
    const inner = k % 4 === 3;
    const y = yMin + (1 - (k + 0.5) / count) * (1 - yMin);
    const a = k * 2.39996 + a0, sy = Math.sqrt(Math.max(0, 1 - y * y));
    const dir = V(Math.cos(a) * sy, y, Math.sin(a) * sy);
    const f = lump(dir) * (inner ? 0.45 + 0.25 * rnd() : 0.72 + 0.24 * Math.sqrt(rnd()));
    out.push({ q: V(crown.c.x + dir.x * crown.r.x * f, crown.c.y + dir.y * crown.r.y * f, crown.c.z + dir.z * crown.r.z * f), dir, inner });
  }
  return out;
}

// Orientation for a broadleaf cluster card at anchor q (tip dir d) in crown.
function orientCard(rnd, q, d, crown, upBias = 0.35, outBias = 0.55, spin = 1.1) {
  const out = V(q.x - crown.c.x, (q.y - crown.c.y) * 0.4, q.z - crown.c.z);
  if (out.lengthSq() < 1e-6) out.set(rnd() - 0.5, 0.2, rnd() - 0.5);
  out.normalize();
  const up = d.clone().multiplyScalar(0.55).addScaledVector(out, outBias).addScaledVector(UP, upBias).normalize();
  let n = out.clone().addScaledVector(up, -out.dot(up));
  if (n.lengthSq() < 1e-4) n = anyPerp(up);
  n.normalize().applyAxisAngle(up, (rnd() - 0.5) * 2 * spin);
  return { up, n };
}

// Strip along a curved frond (palm / fern): 3 verts across (V-fold), `segs` along.
function frond(acc, rnd, base, az, el0, droop, len, width, segs, cellName, crown, sp, flex0, phase, fold = 0.18) {
  const [u0, v0, u1, v1] = cellUV(cellName);
  const h = V(Math.cos(az), 0, Math.sin(az));
  const side = V().crossVectors(h, UP).normalize();
  const tint = leafTint(rnd);
  let p = base.clone();
  const start = acc.count;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    if (k > 0) {
      const e = el0 - droop * Math.pow((k - 0.5) / segs, 1.4);
      p = p.clone().addScaledVector(h, Math.cos(e) * len / segs).addScaledVector(UP, Math.sin(e) * len / segs);
    }
    const e = el0 - droop * Math.pow(t, 1.4);
    const tan = h.clone().multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e));
    const nUp = V().crossVectors(side, tan).normalize();
    if (nUp.y < 0) nUp.negate();
    const w = width * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, 0.12 + t))) * 0.5;
    for (let j = 0; j < 3; j++) {
      const sx = j - 1;
      const q = p.clone().addScaledVector(side, sx * w).addScaledVector(nUp, -Math.abs(sx) * fold * w * 2);
      const sh = canopyShade(q, crown);
      const n = nUp.clone().multiplyScalar(0.45).addScaledVector(sh.n, 0.55).normalize();
      const ao = sh.ao * (0.85 + 0.15 * t);
      acc.v(q, n, [tint[0] * ao, tint[1] * ao, tint[2] * ao], [flex0 + (1 - flex0) * t, t * (0.5 + 0.5 * Math.abs(sx)), 1 + phase, sway(q.y, sp.H)],
        [u0 + (u1 - u0) * (j / 2), v0 + (v1 - v0) * t]);
    }
  }
  for (let k = 0; k < segs; k++) {
    for (let j = 0; j < 2; j++) {
      const a = start + k * 3 + j, b = a + 3;
      acc.tri(a, a + 1, b);
      acc.tri(a + 1, b + 1, b);
    }
  }
}

// ---- species -------------------------------------------------------------------------------
// Each returns { branches, anchors, crown, H } used to emit near + far geometry.
const SPECIES = {
  oak: {
    bark: BARK.oak, barkTint: [1, 1, 1], farTint: [0.62, 0.52, 0.42], cells: ['oak', 'oak2'], card: [1.1, 1.4], farCard: 2.3, farCount: 28, target: 96, shell: true,
    skeleton(rnd) {
      const H = 7.6;
      const br = [];
      const trunk = grow(rnd, { start: V(), dir: V((rnd() - 0.5) * 0.12, 1, (rnd() - 0.5) * 0.12), len: 3.0 + rnd() * 0.5, r0: 0.3, r1: 0.21, segs: 5, wiggle: 0.12, flexGain: 0.05, flare: 0.45 });
      br.push(trunk);
      const top = sampleBranch(trunk, 1);
      const leader = grow(rnd, { start: top.p, dir: top.d, len: 2.4, r0: 0.2, r1: 0.05, segs: 4, gravity: 0.1, wiggle: 0.3, flex0: 0.05, flexGain: 0.35, depth: 1 });
      br.push(leader);
      const anchors = [];
      const prim = 5 + Math.floor(rnd() * 2);
      let az = rnd() * 6.28;
      for (let k = 0; k < prim; k++) {
        az += (Math.PI * 2) / prim * 1.0 + (rnd() - 0.5) * 0.5;
        const onLeader = k >= prim - 2;
        const host = onLeader ? leader : trunk;
        const s = sampleBranch(host, onLeader ? 0.3 + rnd() * 0.4 : 0.62 + (k / prim) * 0.45);
        const d = dirEA(az, 0.55 + rnd() * 0.35);
        const b = grow(rnd, { start: s.p, dir: d, len: 2.7 + rnd() * 0.8, r0: 0.13, r1: 0.035, segs: 5, gravity: 0.12, wiggle: 0.3, flex0: 0.1, flexGain: 0.5, depth: 1 });
        br.push(b);
        const nSec = 3 + Math.floor(rnd() * 2);
        for (let m = 0; m < nSec; m++) {
          const t = 0.35 + (m / nSec) * 0.6 + rnd() * 0.08;
          const q = sampleBranch(b, t);
          const cd = childDir(q.d, 0.55 + rnd() * 0.4, rnd() * 6.28);
          cd.y = Math.max(cd.y, -0.1);
          const c = grow(rnd, { start: q.p, dir: cd, len: 1.1 + rnd() * 0.7, r0: 0.045, r1: 0.014, segs: 3, gravity: 0.15, wiggle: 0.35, flex0: q.flex, flexGain: 0.35, depth: 2 });
          br.push(c);
          anchors.push(tip(c), mid(c, 0.55));
        }
        anchors.push(tip(b));
      }
      anchors.push(tip(leader), mid(leader, 0.7));
      return { branches: br, anchors, crown: { c: V(0, 5.2, 0), r: V(3.7, 2.6, 3.7) }, H };
    },
    cardsPerAnchor: 0.6,
  },
  birch: {
    bark: BARK.birch, barkTint: [1, 1, 1], farTint: [1.25, 1.22, 1.16], cells: ['birch'], card: [0.9, 1.1], farCard: 1.8, farCount: 26, target: 88, shell: true,
    skeleton(rnd) {
      const H = 7.4;
      const br = [];
      const trunk = grow(rnd, { start: V(), dir: V((rnd() - 0.5) * 0.14, 1, (rnd() - 0.5) * 0.14), len: 6.8 + rnd() * 0.5, r0: 0.17, r1: 0.035, segs: 7, wiggle: 0.1, flexGain: 0.3, flare: 0.3 });
      br.push(trunk);
      const anchors = [];
      const n = 10 + Math.floor(rnd() * 3);
      let az = rnd() * 6.28;
      for (let k = 0; k < n; k++) {
        az += GOLD + (rnd() - 0.5) * 0.3;
        const t = 0.34 + (k / n) * 0.6;
        const s = sampleBranch(trunk, t);
        const L = (1.0 + 1.0 * Math.sin(Math.PI * (k + 0.5) / n)) * (0.85 + rnd() * 0.3);
        const b = grow(rnd, { start: s.p, dir: dirEA(az, 0.75 + rnd() * 0.3), len: L, r0: 0.045, r1: 0.012, segs: 4, gravity: -0.35, wiggle: 0.25, flex0: s.flex, flexGain: 0.55, depth: 1 });
        br.push(b);
        for (let m = 0; m < 2; m++) {
          const q = sampleBranch(b, 0.45 + m * 0.35);
          const c = grow(rnd, { start: q.p, dir: childDir(q.d, 0.7, rnd() * 6.28), len: 0.6 + rnd() * 0.35, r0: 0.014, r1: 0.006, segs: 2, gravity: -0.9, wiggle: 0.3, flex0: q.flex, flexGain: 0.3, depth: 2 });
          anchors.push(tip(c));
        }
        anchors.push(tip(b), mid(b, 0.6));
      }
      anchors.push(tip(trunk));
      return { branches: br, anchors, crown: { c: V(0, 5.1, 0), r: V(1.95, 2.7, 1.95) }, H };
    },
    cardsPerAnchor: 0.6,
  },
  cherry: {
    bark: BARK.cherry, barkTint: [1, 1, 1], farTint: [0.55, 0.42, 0.38], cells: ['cherry'], card: [1.0, 1.3], farCard: 2.2, farCount: 22, target: 84,
    skeleton(rnd) {
      const H = 5.6;
      const br = [];
      const trunk = grow(rnd, { start: V(), dir: V((rnd() - 0.5) * 0.3, 1, (rnd() - 0.5) * 0.3), len: 1.6 + rnd() * 0.4, r0: 0.25, r1: 0.19, segs: 3, wiggle: 0.15, flexGain: 0.03, flare: 0.4 });
      br.push(trunk);
      const top = sampleBranch(trunk, 1);
      const anchors = [];
      const limbs = 4 + Math.floor(rnd() * 2);
      let az = rnd() * 6.28;
      for (let k = 0; k < limbs; k++) {
        az += (Math.PI * 2) / limbs + (rnd() - 0.5) * 0.5;
        const b = grow(rnd, { start: top.p, dir: dirEA(az, 0.5 + rnd() * 0.35), len: 2.5 + rnd() * 0.7, r0: 0.14, r1: 0.04, segs: 5, gravity: -0.04, wiggle: 0.35, flex0: 0.05, flexGain: 0.45, depth: 1 });
        br.push(b);
        const nSec = 3 + Math.floor(rnd() * 2);
        for (let m = 0; m < nSec; m++) {
          const q = sampleBranch(b, 0.3 + (m / nSec) * 0.65);
          const cd = childDir(q.d, 0.5 + rnd() * 0.5, rnd() * 6.28);
          cd.y = Math.abs(cd.y) * 0.8 + 0.1;
          const c = grow(rnd, { start: q.p, dir: cd, len: 1.0 + rnd() * 0.6, r0: 0.04, r1: 0.012, segs: 3, gravity: 0.05, wiggle: 0.4, flex0: q.flex, flexGain: 0.35, depth: 2 });
          br.push(c);
          anchors.push(tip(c), mid(c, 0.5));
        }
        anchors.push(tip(b));
      }
      return { branches: br, anchors, crown: { c: V(0, 3.95, 0), r: V(3.4, 1.75, 3.4) }, H };
    },
    cardsPerAnchor: 1.2,
  },
  pine: {
    bark: BARK.pine, barkTint: [1, 1, 1], farTint: [0.55, 0.42, 0.34], cells: ['pine'], card: [1.0, 1.25], farCard: 1.9, farCount: 20, conifer: true, target: 0,
    skeleton(rnd, fir) {
      const H = 8.6;
      const br = [];
      const trunk = grow(rnd, { start: V(), dir: V((rnd() - 0.5) * 0.05, 1, (rnd() - 0.5) * 0.05), len: 8.4, r0: 0.24, r1: 0.02, segs: 8, wiggle: 0.05, flexGain: 0.35, flare: 0.35 });
      br.push(trunk);
      const anchors = [];
      let az = rnd() * 6.28;
      const step = fir ? 0.56 : 0.66;
      for (let h = 1.5; h < 8.0; h += step * (0.85 + rnd() * 0.3)) {
        const t = h / 8.4;
        const per = 4;
        az += GOLD;
        for (let k = 0; k < per; k++) {
          const a = az + (k / per) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
          const L = (2.5 * (1 - (h - 1.5) / 7.0) + 0.35) * (0.85 + rnd() * 0.3);
          const el = (fir ? -0.25 : -0.12) + 0.45 * t + (rnd() - 0.5) * 0.15;
          const s = sampleBranch(trunk, t);
          const b = grow(rnd, { start: s.p, dir: dirEA(a, el), len: L, r0: 0.05 * (0.5 + L / 2.8), r1: 0.012, segs: 3, gravity: fir ? 0.05 : -0.06, wiggle: 0.15, flex0: s.flex, flexGain: 0.45, depth: 1 });
          br.push(b);
          const nS = Math.max(1, Math.round(L / 0.7));
          for (let m = 0; m < nS; m++) anchors.push({ ...sampleBranch(b, 1 - m * (0.62 / nS)), spray: true });
        }
      }
      const tp = sampleBranch(trunk, 1);
      anchors.push({ p: tp.p.clone().addScaledVector(UP, -0.5), d: UP.clone(), r: 0.02, flex: tp.flex, spray: false });
      return { branches: br, anchors, crown: { c: V(0, 4.1, 0), r: V(2.6, 4.3, 2.6) }, H };
    },
    cardsPerAnchor: 1.0,
  },
  jungle: {
    bark: BARK.jungle, barkTint: [1, 1, 1], farTint: [0.6, 0.55, 0.47], cells: ['jungle', 'jungle2'], card: [1.25, 1.65], farCard: 2.8, farCount: 24, target: 118,
    skeleton(rnd) {
      const H = 11;
      const br = [];
      const trunk = grow(rnd, { start: V(), dir: V((rnd() - 0.5) * 0.1, 1, (rnd() - 0.5) * 0.1), len: 8.4 + rnd() * 0.6, r0: 0.42, r1: 0.26, segs: 6, wiggle: 0.08, flexGain: 0.1, flare: 0.35 });
      br.push(trunk);
      // buttress roots
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + rnd() * 0.5;
        const start = V(Math.cos(a) * 0.2, 1.3 + rnd() * 0.4, Math.sin(a) * 0.2);
        br.push(grow(rnd, { start, dir: dirEA(a, -0.75), len: 1.7 + rnd() * 0.4, r0: 0.22, r1: 0.05, segs: 3, gravity: -0.2, wiggle: 0.1, depth: 1, flexGain: 0 }));
      }
      const anchors = [];
      const limbs = 6 + Math.floor(rnd() * 2);
      let az = rnd() * 6.28;
      for (let k = 0; k < limbs; k++) {
        az += (Math.PI * 2) / limbs + (rnd() - 0.5) * 0.4;
        const s = sampleBranch(trunk, 0.8 + rnd() * 0.2);
        const b = grow(rnd, { start: s.p, dir: dirEA(az, 0.35 + rnd() * 0.3), len: 3.4 + rnd() * 0.9, r0: 0.15, r1: 0.04, segs: 4, gravity: -0.08, wiggle: 0.25, flex0: s.flex, flexGain: 0.4, depth: 1 });
        br.push(b);
        for (let m = 0; m < 3; m++) {
          const q = sampleBranch(b, 0.45 + m * 0.25);
          const cd = childDir(q.d, 0.6 + rnd() * 0.3, rnd() * 6.28);
          cd.y = Math.abs(cd.y) * 0.4 + 0.08;
          const c = grow(rnd, { start: q.p, dir: cd, len: 1.2 + rnd() * 0.6, r0: 0.045, r1: 0.014, segs: 2, gravity: -0.1, wiggle: 0.3, flex0: q.flex, flexGain: 0.3, depth: 2 });
          br.push(c);
          anchors.push(tip(c));
        }
        anchors.push(tip(b), mid(b, 0.7));
      }
      anchors.push(tip(trunk));
      return { branches: br, anchors, crown: { c: V(0, 9.2, 0), r: V(5.2, 2.2, 5.2) }, H };
    },
    cardsPerAnchor: 1.2,
  },
};
function tip(b) { const s = sampleBranch(b, 1); return s; }
function mid(b, t) { return sampleBranch(b, t); }

function emitTree(sp, sk, rnd, opts) {
  const near = new Acc(), leaves = new Acc(), far = new Acc();
  const mul = opts.cards ?? 1;
  // bark
  for (const b of sk.branches) {
    const r = b.rad[0];
    let sides = r >= 0.3 ? (opts.hero ? 12 : 9) : r >= 0.18 ? (opts.hero ? 10 : 8) : r >= 0.09 ? 6 : r >= 0.04 ? 4 : 3;
    if (sp.conifer && b.depth > 0) sides = 3;
    if (b.depth === 2 && !opts.hero && r < 0.02) continue;
    tube(near, b, sides, sp, false);
    if (b.depth === 0 || (b.depth === 1 && r >= 0.1)) tube(far, { ...b, pts: thin(b.pts), rad: thin(b.rad), flex: thin(b.flex) }, b.depth === 0 ? 5 : 3, { ...sp, barkTint: sp.farTint }, true);
  }
  // skeleton points for attaching fill cards (wind phase + flex)
  const pts = [];
  for (const b of sk.branches) if (b.depth > 0 || sp.conifer) b.pts.forEach((p, i) => { if (i > 0) pts.push({ p, flex: b.flex[i], phase: b.phase }); });
  const nearest = (q) => { let best = pts[0], bd = 1e9; for (const e of pts) { const d = e.p.distanceToSquared(q); if (d < bd) { bd = d; best = e; } } return best; };
  const cards = [];
  // (conifers, cherry and jungle keep their original random sequence and tints)
  const emit = (pos, up, n, size, cell, flex, phase, facing = false) => {
    const tint = sp.shell ? leafTintHue(rnd) : leafTint(rnd), roll = sp.shell ? (rnd() - 0.5) * 1.2 : 0;
    card(leaves, pos, up, n, size, 1, cell, sk.crown, sp, flex, phase, tint, 0.06, facing, roll);
    cards.push({ pos, up, n, size, cell, flex, phase, tint, facing, roll });
  };
  const cellOf = () => sp.cells[Math.floor(rnd() * sp.cells.length)];
  const sizeOf = () => sp.card[0] + rnd() * (sp.card[1] - sp.card[0]);
  for (const a of sk.anchors) {
    const count = Math.max(1, Math.round((sp.cardsPerAnchor ?? 1) * mul * (0.75 + rnd() * 0.5)));
    for (let k = 0; k < count; k++) {
      const size = sizeOf();
      if (sp.conifer && a.spray) {
        const up = a.d.clone().setY(a.d.y * 0.6).normalize();
        const n = UP.clone().applyAxisAngle(up, (k % 2 ? 1 : -1) * (0.35 + rnd() * 0.3));
        emit(a.p.clone().addScaledVector(up, -size * 0.55), up, n, size, cellOf(), a.flex, rnd());
      } else {
        const o = orientCard(rnd, a.p, a.d, sk.crown, sp.conifer ? 0.9 : 0.35);
        const pos = a.p.clone().addScaledVector(o.up, -size * 0.18).add(V((rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.25));
        emit(pos, o.up, o.n, size, cellOf(), a.flex, rnd());
      }
    }
  }
  // fill the crown so the silhouette is full whatever the skeleton did
  const target = Math.round((sp.target ?? 0) * mul);
  const cr = sk.crown;
  if (sp.shell) {
    for (const s of shellPoints(rnd, cr, Math.max(0, target - cards.length), crownLobes(rnd, 6))) {
      const att = nearest(s.q);
      const o = shellCard(rnd, s.q, cr);
      const size = sizeOf() * (s.inner ? 0.9 : 1);
      emit(s.q.clone().addScaledVector(o.up, -size * 0.5), o.up, o.n, size, cellOf(), Math.max(att.flex, 0.5), att.phase + rnd() * 0.3, true);
    }
  }
  for (let k = cards.length; k < target; k++) {
    const u = rnd() * Math.PI * 2, cy = 1 - 2 * Math.pow(rnd(), 0.8);
    const sy = Math.sqrt(1 - cy * cy);
    const dir = V(Math.cos(u) * sy, cy, Math.sin(u) * sy);
    const f = 0.5 + 0.42 * Math.sqrt(rnd());
    const q = V(cr.c.x + dir.x * cr.r.x * f, cr.c.y + dir.y * cr.r.y * f, cr.c.z + dir.z * cr.r.z * f);
    const att = nearest(q);
    q.lerp(att.p, 0.3);
    const d = q.clone().sub(att.p);
    if (d.lengthSq() < 1e-6) d.copy(dir);
    const o = orientCard(rnd, q, d.normalize(), cr, 0.3, 0.7);
    const size = sizeOf();
    emit(q.clone().addScaledVector(o.up, -size * 0.4), o.up, o.n, size, cellOf(), Math.max(att.flex, 0.5), att.phase + rnd() * 0.3);
  }
  if (sp.conifer) {
    // far: layered whorls of big sprays keep the cone solid from a distance
    let az = rnd() * 6.28;
    const y0 = 1.6, y1 = sk.H - 0.9;
    for (let y = y0; y < y1; y += 0.95) {
      const t = (y - y0) / (y1 - y0), rad = (sp.coneR ?? 2.6) * (1 - t) + 0.45;
      az += 0.8;
      for (let k = 0; k < 4; k++) {
        const a = az + (k / 4) * Math.PI * 2;
        const up = V(Math.cos(a), -0.12 + 0.2 * t, Math.sin(a)).normalize();
        const n = UP.clone().applyAxisAngle(up, (k % 2 ? 1 : -1) * 0.85);
        const size = rad * 1.2;
        card(far, V(Math.cos(a) * 0.1, y, Math.sin(a) * 0.1), up, n, size, 1, sp.cells[0], sk.crown, sp, 0.4 + 0.4 * t, rnd(), leafTint(rnd), 0.05);
      }
    }
    for (let k = 0; k < 2; k++) {
      const n = V(Math.cos(k * 1.57), 0, Math.sin(k * 1.57));
      card(far, V(0, y1 - 0.4, 0), UP.clone(), n, 1.6, 1, sp.cells[0], sk.crown, sp, 0.8, rnd(), leafTint(rnd), 0);
    }
    return { bark: near.geometry(), leaves: leaves.geometry(), far: far.geometry(), cards: cards.length, height: sk.H };
  }
  // far: fewer, larger cards spread over the crown (farthest-point pick)
  const pick = [];
  const pool = cards.slice();
  if (pool.length) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  while (pick.length < Math.min(sp.farCount, cards.length) && pool.length) {
    let best = 0, bd = -1;
    for (let i = 0; i < pool.length; i++) {
      let dmin = 1e9;
      for (const p of pick) dmin = Math.min(dmin, p.pos.distanceToSquared(pool[i].pos));
      if (dmin > bd) { bd = dmin; best = i; }
    }
    pick.push(pool.splice(best, 1)[0]);
  }
  for (const c of pick) {
    const s2 = sp.farCard * (0.9 + rnd() * 0.2);
    const pos = c.pos.clone().addScaledVector(c.up, (c.size - s2) * 0.45);
    card(far, pos, c.up, c.n, s2, 1, c.cell, sk.crown, sp, c.flex, c.phase % 1, c.tint, 0.05, !!sp.shell, c.roll ?? 0);
  }
  return { bark: near.geometry(), leaves: leaves.geometry(), far: far.geometry(), cards: cards.length, height: sk.H };
}
function thin(arr) {
  if (arr.length <= 3) return arr.slice();
  const out = [];
  for (let i = 0; i < arr.length; i += 2) out.push(arr[i]);
  if ((arr.length - 1) % 2) out.push(arr[arr.length - 1]);
  return out;
}

// species: oak | birch | cherry | pine | fir | jungle. opts: { hero, cards }
export function makeTree(species, rnd, opts = {}) {
  const fir = species === 'fir';
  const sp = SPECIES[fir ? 'pine' : species];
  const sk = sp.skeleton(rnd, fir);
  const spx = { ...sp, H: sk.H, ...(fir ? { cells: ['fir'], card: [0.9, 1.1], farTint: [0.5, 0.4, 0.33] } : {}) };
  return emitTree(spx, sk, rnd, opts);
}

// ---- palm ----------------------------------------------------------------------------------
export function makePalm(rnd, opts = {}) {
  const sp = { bark: BARK.palm, barkTint: [1, 1, 1], farTint: [0.7, 0.6, 0.48], H: 8 };
  const near = new Acc(), leaves = new Acc(), far = new Acc();
  const lean = 0.12 + rnd() * 0.1, az = rnd() * 6.28;
  const trunk = grow(rnd, { start: V(), dir: V(Math.cos(az) * lean, 1, Math.sin(az) * lean), len: 7.0 + rnd() * 0.6, r0: 0.21, r1: 0.15, segs: 7, gravity: -0.02, wiggle: 0.05, flexGain: 0.4, flare: 0.25 });
  // curve the trunk: bend more toward the top
  trunk.pts.forEach((p, i) => { const t = i / (trunk.pts.length - 1); p.x += Math.cos(az) * t * t * 0.9; p.z += Math.sin(az) * t * t * 0.9; });
  tube(near, trunk, opts.hero ? 9 : 7, sp, false);
  tube(far, { ...trunk, pts: thin(trunk.pts), rad: thin(trunk.rad), flex: thin(trunk.flex) }, 4, { ...sp, barkTint: sp.farTint }, true);
  const top = trunk.pts[trunk.pts.length - 1];
  const crown = { c: top.clone().add(V(0, 0.2, 0)), r: V(3, 1.4, 3) };
  const n = 11;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd() * 0.3;
    const len = 3.3 + rnd() * 0.6, el = 0.5 + rnd() * 0.35, droop = 1.3 + rnd() * 0.5;
    const phase = rnd();
    frond(leaves, rnd, top, a, el, droop, len, 1.2, opts.hero ? 8 : 6, 'palm', crown, sp, 0.35, phase, 0.12);
    if (k % 1 === 0) frond(far, rnd, top, a, el, droop, len, 1.25, 3, 'palm', crown, sp, 0.35, phase, 0.1);
  }
  return { bark: near.geometry(), leaves: leaves.geometry(), far: far.geometry(), height: 8 };
}

// ---- bush ----------------------------------------------------------------------------------
export function makeBush(rnd, flower = null) {
  const sp = { bark: BARK.twig, barkTint: [0.9, 0.85, 0.8], farTint: [0.45, 0.38, 0.3], H: 1.6 };
  const near = new Acc(), leaves = new Acc(), far = new Acc();
  const crown = { c: V(0, 0.6, 0), r: V(0.95, 0.66, 0.95) };
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rnd();
    tube(near, grow(rnd, { start: V(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05), dir: dirEA(a, 1.05 + rnd() * 0.25), len: 0.55 + rnd() * 0.2, r0: 0.03, r1: 0.012, segs: 2, wiggle: 0.3, flexGain: 0.5, depth: 1 }), 3, sp, false);
  }
  const N = 34;
  const cards = [];
  for (let k = 0; k < N; k++) {
    const u = rnd() * 6.28, cy = 1 - 1.7 * Math.pow(rnd(), 0.9);
    const sy = Math.sqrt(Math.max(0, 1 - cy * cy));
    const dir = V(Math.cos(u) * sy, cy, Math.sin(u) * sy);
    const f = 0.45 + 0.4 * rnd();
    const p = crown.c.clone().add(V(dir.x * crown.r.x * f, dir.y * crown.r.y * f, dir.z * crown.r.z * f));
    p.y = Math.max(p.y, 0.12);
    const cell = flower && rnd() < 0.55 ? (Array.isArray(flower) ? flower[k % flower.length] : flower) : 'bush';
    const o = orientCard(rnd, p, dir, crown, 0.4, 0.7, 1.3);
    const size = 0.6 + rnd() * 0.22;
    const pos = p.clone().addScaledVector(o.up, -size * 0.35);
    pos.y = Math.max(pos.y, 0.02);
    const phase = rnd(), tint = leafTintHue(rnd), facing = rnd() < 0.7, roll = (rnd() - 0.5) * 1.4;
    card(leaves, pos, o.up, o.n, size, 1, cell, crown, sp, 0.5, phase, tint, 0.06, facing, roll);
    cards.push({ pos, up: o.up, n: o.n, size, cell, phase, tint, roll });
  }
  for (let k = 0; k < 10; k++) {
    const c = cards[Math.floor(k * N / 10)];
    card(far, c.pos, c.up, c.n, 1.05, 1, c.cell, crown, sp, 0.5, c.phase, c.tint, 0.05, true, c.roll);
  }
  return { bark: near.geometry(), leaves: leaves.geometry(), far: far.geometry(), height: 1.3 };
}

// ---- fern (near only) -----------------------------------------------------------------------
export function makeFern(rnd) {
  const sp = { H: 1.2 };
  const leaves = new Acc();
  const crown = { c: V(0, 0.35, 0), r: V(1, 0.6, 1) };
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd() * 0.5;
    frond(leaves, rnd, V(0, 0.02, 0), a, 0.95 + rnd() * 0.35, 1.5 + rnd() * 0.5, 0.95 + rnd() * 0.45, 0.46, 4, 'fern', crown, sp, 0.2, rnd(), 0.15);
  }
  return { leaves: leaves.geometry(), height: 1 };
}

// ---- rocks ---------------------------------------------------------------------------------
// Layered displacement (fbm + strata terraces), flattened bottom; vertex colour = crevice AO.
function hash3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r * 2 - 1;
}
export function makeRock(rnd, detail = 3) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const seed = rnd() * 100;
  const sx = 1.15 + rnd() * 0.5, sy = 0.62 + rnd() * 0.3, sz = 0.95 + rnd() * 0.4;
  const strata = 5 + rnd() * 4, tilt = (rnd() - 0.5) * 0.5;
  const disp = new Float32Array(pos.count);
  const p = V();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let d = 0, a = 0.3, f = 1.3;
    for (let o = 0; o < 4; o++) { d += a * vnoise3(p.x * f + seed, p.y * f + seed * 0.7, p.z * f - seed); a *= 0.5; f *= 2.1; }
    // facets: quantise the radial offset a little for chiselled planes
    let r = 1 + d;
    let y = p.y * r * sy;
    const layer = (y + p.x * tilt) * strata;
    const terr = (Math.round(layer) - layer) / strata;
    y += terr * 0.35;
    const q = V(p.x * r * sx, y, p.z * r * sz);
    // flatten the bottom so rocks sit on the ground
    if (q.y < -0.22) q.y = -0.22 + (q.y + 0.22) * 0.18;
    pos.setXYZ(i, q.x, q.y, q.z);
    disp[i] = d;
  }
  g.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ao = 0.62 + 0.38 * smooth(-0.22, 0.12, disp[i]) * (0.7 + 0.3 * smooth(-0.3, 0.4, pos.getY(i)));
    col[i * 3] = ao; col[i * 3 + 1] = ao; col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---- the Grandmother Tree (landmark) -------------------------------------------------------
// A huge buttressed jungle tree with a broad layered crown and hanging vines.
export function makeGrandmother(rnd) {
  const sp = { bark: BARK.elder, barkTint: [1, 1, 1], farTint: [0.6, 0.55, 0.45], H: 26 };
  const bark = new Acc(), leaves = new Acc();
  const br = [];
  const trunk = grow(rnd, { start: V(0, -0.3, 0), dir: V(0.03, 1, -0.02), len: 17.5, r0: 2.0, r1: 1.05, segs: 9, wiggle: 0.06, flexGain: 0.05, flare: 0.3 });
  br.push(trunk);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + rnd() * 0.3;
    br.push(grow(rnd, { start: V(Math.cos(a) * 1.2, 3.4 + rnd() * 1.2, Math.sin(a) * 1.2), dir: dirEA(a, -0.62), len: 5.5 + rnd() * 1.5, r0: 0.95, r1: 0.12, segs: 5, gravity: -0.05, wiggle: 0.12, depth: 1, flexGain: 0 }));
  }
  const anchors = [];
  const limbs = 7;
  for (let k = 0; k < limbs; k++) {
    const a = (k / limbs) * Math.PI * 2 + rnd() * 0.4;
    const s = sampleBranch(trunk, 0.66 + rnd() * 0.3);
    const b = grow(rnd, { start: s.p, dir: dirEA(a, 0.35 + rnd() * 0.25), len: 8 + rnd() * 2.5, r0: 0.62, r1: 0.14, segs: 6, gravity: -0.03, wiggle: 0.18, flex0: 0.02, flexGain: 0.25, depth: 1 });
    br.push(b);
    for (let m = 0; m < 5; m++) {
      const q = sampleBranch(b, 0.3 + m * 0.16);
      const cd = childDir(q.d, 0.55 + rnd() * 0.4, rnd() * 6.28);
      cd.y = Math.abs(cd.y) * 0.5 + 0.12;
      const c = grow(rnd, { start: q.p, dir: cd, len: 3 + rnd() * 1.6, r0: 0.16, r1: 0.04, segs: 3, gravity: -0.03, wiggle: 0.3, flex0: q.flex, flexGain: 0.3, depth: 2 });
      br.push(c);
      anchors.push(tip(c), mid(c, 0.5));
    }
    anchors.push(tip(b));
  }
  const crown = { c: V(0, 20.6, 0), r: V(12.5, 4.8, 12.5) };
  for (const b of br) tube(bark, b, b.depth === 0 ? 16 : b.depth === 1 ? 9 : 5, sp, false);
  const cellOf = () => (rnd() < 0.6 ? 'jungle' : 'jungle2');
  for (const a of anchors) {
    for (let k = 0; k < 2; k++) {
      const size = 2.5 + rnd() * 1.0;
      const o = orientCard(rnd, a.p, a.d, crown, 0.45, 0.5, 1.2);
      const pos = a.p.clone().addScaledVector(o.up, -size * 0.25).add(V((rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.0, (rnd() - 0.5) * 1.6));
      card(leaves, pos, o.up, o.n, size, 1, cellOf(), crown, sp, a.flex, rnd(), leafTint(rnd), 0.06);
    }
  }
  // fill the broad crown shell (cards hang off the nearest limb for wind)
  const pts = [];
  for (const b of br) if (b.depth > 0 && b.pts[0].y > 8) b.pts.forEach((p, i) => pts.push({ p, flex: b.flex[i], phase: b.phase }));
  // outward-facing shell over a lumpy crown (+ a quarter inside), dense clusters mixed with big leaves
  for (const sp2 of shellPoints(rnd, crown, 380 - anchors.length * 2, crownLobes(rnd, 8), -0.35)) {
    let att = pts[0], bd = 1e9;
    for (const e of pts) { const dd = e.p.distanceToSquared(sp2.q); if (dd < bd) { bd = dd; att = e; } }
    const o = shellCard(rnd, sp2.q, crown);
    const size = (sp2.inner ? 2.2 : 2.6) + rnd() * 0.9;
    card(leaves, sp2.q.clone().addScaledVector(o.up, -size * 0.5), o.up, o.n, size, 1, rnd() < 0.55 ? 'oak2' : cellOf(), crown, sp, Math.max(att.flex, 0.4), att.phase, leafTintHue(rnd), 0.06, true, (rnd() - 0.5) * 1.2);
  }
  // hanging vines: thin tubes with small leaf cards along them
  for (let k = 0; k < 22; k++) {
    const a = rnd() * Math.PI * 2, r = 4.5 + rnd() * 7;
    const top = V(Math.cos(a) * r, 16.5 + rnd() * 2.5, Math.sin(a) * r);
    const len = 3 + rnd() * 6;
    const vine = grow(rnd, { start: top, dir: V((rnd() - 0.5) * 0.1, -1, (rnd() - 0.5) * 0.1), len, r0: 0.05, r1: 0.03, segs: 4, wiggle: 0.08, flex0: 0.3, flexGain: 0.7, depth: 2 });
    tube(bark, vine, 3, { ...sp, bark: BARK.twig, barkTint: [0.55, 0.7, 0.4] }, false);
    const nl = Math.floor(len / 0.8);
    for (let m = 0; m < nl; m++) {
      const q = sampleBranch(vine, (m + 0.5) / nl);
      const ang = rnd() * 6.28;
      const up = V(Math.cos(ang) * 0.6, -0.8, Math.sin(ang) * 0.6).normalize();
      const n = anyPerp(up).applyAxisAngle(up, rnd() * 6.28);
      card(leaves, q.p, up, n, 0.7 + rnd() * 0.3, 1, 'bush', crown, sp, q.flex, rnd(), leafTint(rnd), 0.04);
    }
  }
  return { bark: bark.geometry(), leaves: leaves.geometry(), height: 26 };
}
