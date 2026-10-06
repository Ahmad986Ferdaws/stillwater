import * as THREE from 'three';
import { clothMat } from './characters.js';

// Verlet cloth pinned to bones: tunic hems, coat tails, aprons, scarves, cloaks.
// It swings with the body, trails in the "wind" you make by moving, collides with the body's capsules,
// rests on the ground and floats up around you in the water. Realistic cloth (def.real) uses the
// physically based material and gets a fur trim: a shaggy tube that follows its free edges.

const H = 1 / 90;
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _bn = new THREE.Vector3(), _p = new THREE.Vector3();

export class Cloth {
  constructor(def, rig, scale) {
    this.rig = rig;
    this.scale = scale;
    this.def = def;
    const J = rig.J;
    const pts = [], colors = [], rest = [];
    let rows, cols, wrap = false;
    const hem = new THREE.Color(def.hemColor || def.color), main = new THREE.Color(def.color);
    if (def.type === 'skirt') {
      rows = def.rows + 1; cols = def.cols; wrap = true;
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        const y = def.topY + (def.hemY - def.topY) * t;
        const rx = def.top[0] + (def.hem[0] - def.top[0]) * t, rz = def.top[1] + (def.hem[1] - def.top[1]) * t;
        for (let c = 0; c < cols; c++) {
          const a = (c / cols) * Math.PI * 2;
          pts.push([Math.sin(a) * rx, y, Math.cos(a) * rz + 0.004]);
          colors.push(r >= rows - 2 ? hem : main);
          rest.push([(c / cols) * 1.3, -t * (def.topY - def.hemY), 0]);
        }
      }
    } else if (def.type === 'cape') {
      // hangs from pins around the shoulders; wider at the hem than at the top so it falls in folds
      rows = def.rows + 1; cols = def.pins.length;
      const az = -0.03;
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        const sx = 1 + def.flare * t;
        for (let c = 0; c < cols; c++) {
          const p = def.pins[c];
          pts.push([p[0] * sx, p[1] - def.length * t, az + (p[2] - az) * sx]);
          colors.push(main);
          rest.push([(c / (cols - 1)) * 0.95 * sx, -t * def.length, 0]);
        }
      }
    } else if (def.type === 'panel') {
      rows = def.rows + 1; cols = def.cols;
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        for (let c = 0; c < cols; c++) {
          const u = c / (cols - 1) - 0.5;
          const w = def.width * (1 + t * 0.15);
          pts.push([u * w, def.topY + (def.hemY - def.topY) * t, def.z + Math.cos(u * 2.4) * 0.02 - 0.02 + t * 0.012]);
          colors.push(r >= rows - 2 ? hem : main);
          rest.push([u * w, -t, 0]);
        }
      }
    } else { // ribbon (scarf tail hanging from the back of the neck)
      rows = def.rows + 1; cols = 2;
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        for (let c = 0; c < cols; c++) {
          pts.push([def.at[0] + (c - 0.5) * def.width, def.at[1] - t * def.length * 0.8, def.at[2] - t * def.length * 0.45]);
          colors.push(r >= rows - 1 ? hem : main);
          rest.push([c * def.width, -t * def.length, 0]);
        }
      }
    }
    this.rows = rows; this.cols = cols; this.wrap = wrap;
    const n = pts.length;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.bindLocal = pts.map((p) => new THREE.Vector3(p[0] - J[def.bone][0], p[1] - J[def.bone][1], p[2] - J[def.bone][2]));
    this.bone = rig.bones[def.bone];
    this.pinned = new Uint8Array(n);
    for (let c = 0; c < cols; c++) this.pinned[c] = 1; // top row
    this.pinPrev = new Float32Array(n * 3);

    // constraints (i, j, rest, stiffness) in bind units → scaled later
    const idx = (r, c) => r * cols + ((c + cols) % cols);
    this.idx = idx;
    // constraint: [i, j, rest, stiffness, slack] — slack links only resist stretching, so a cloak cut
    // wider at the hem can bunch up into folds instead of standing out like a stiff cone
    const cons = [];
    const slack = def.type === 'cape' ? 1 : 0;
    const link = (i, j, k, sl = 0) => cons.push([i, j, 0, k, sl]);
    const bend = def.type === 'cape' ? 0.5 : 0.35; // heavy wool holds its shape a little
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const hasRight = wrap || c < cols - 1;
      if (hasRight) link(idx(r, c), idx(r, c + 1), 1, r > 0 ? slack : 0);
      if (r < rows - 1) link(idx(r, c), idx(r + 1, c), 1);
      if (r < rows - 1 && hasRight) { link(idx(r, c), idx(r + 1, c + 1), 0.6, slack); link(idx(r, c + 1), idx(r + 1, c), 0.6, slack); }
      if (r < rows - 2) link(idx(r, c), idx(r + 2, c), bend);
      if ((wrap || c < cols - 2) && cols > 2) link(idx(r, c), idx(r, c + 2), 0.3, slack);
    }
    for (const k of cons) {
      const [i, j] = k;
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
      k[2] = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
    }
    this.cons = cons;

    // render mesh
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    colors.forEach((c, i) => { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; });
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const tri = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < (wrap ? cols : cols - 1); c++) {
      const a = idx(r, c), b = idx(r, c + 1), d = idx(r + 1, c), e = idx(r + 1, c + 1);
      tri.push(a, d, b, b, d, e);
    }
    geo.setIndex(tri);
    const real = def.real;
    if (real) {
      const a0 = new Float32Array(n * 4), a1 = new Float32Array(n * 4), ao = new Float32Array(n), rp = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        a0.set(real.mat0, i * 4);
        const t = Math.floor(i / cols) / (rows - 1);
        ao[i] = 0.6 + 0.4 * Math.min(1, t * 4); // tucked under the collar at the top
        rp.set(rest[i], i * 3);
        const v = 0.93 + 0.14 * Math.random();
        col[i * 3] *= v; col[i * 3 + 1] *= v; col[i * 3 + 2] *= v;
      }
      geo.setAttribute('aMat0', new THREE.BufferAttribute(a0, 4));
      geo.setAttribute('aMat1', new THREE.BufferAttribute(a1, 4));
      geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
      geo.setAttribute('aRest', new THREE.BufferAttribute(rp, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    }
    this.mesh = new THREE.Mesh(geo, real ? real.material : clothMat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = !!real;
    this.mesh.frustumCulled = false;
    this.ready = false;

    // fur along the free edges
    this.fur = null;
    if (real && real.fur) {
      let chain, closed = false;
      if (def.type === 'skirt') { chain = []; for (let c = 0; c < cols; c++) chain.push(idx(rows - 1, c)); closed = true; }
      else {
        chain = [];
        for (let r = 1; r < rows; r++) chain.push(idx(r, 0));
        for (let c = 1; c < cols; c++) chain.push(idx(rows - 1, c));
        for (let r = rows - 2; r >= 1; r--) chain.push(idx(r, cols - 1));
      }
      this.fur = new FurTrim(this, chain, closed, real.furRadius * scale, real.furMaterial, real.fur);
      this.mesh.add(this.fur.mesh);
      for (const m of real.furShells || []) {
        const sh = new THREE.Mesh(this.fur.mesh.geometry, m);
        sh.frustumCulled = false;
        sh.receiveShadow = true;
        sh.userData.furShell = true;
        sh.userData.trim = true;
        this.fur.mesh.add(sh);
        (rig.furShells ||= []).push(sh);
      }
    }
  }

  anchor(i, out) {
    return out.copy(this.bindLocal[i]).applyMatrix4(this.bone.matrixWorld);
  }

  reset() {
    for (let i = 0; i < this.n; i++) {
      this.anchor(i, _v);
      this.pos[i * 3] = this.prev[i * 3] = this.pinPrev[i * 3] = _v.x;
      this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = this.pinPrev[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = this.pinPrev[i * 3 + 2] = _v.z;
    }
    this.ready = true;
  }

  // colliders: [{ a: Vector3, b: Vector3, r }] capsules in world space
  update(dt, colliders, wind, floorY = -Infinity, waterY = -Infinity) {
    if (!this.ready) this.reset();
    // teleports reset the cloth instead of flinging it across the map
    this.anchor(0, _v);
    if (Math.abs(_v.x - this.pinPrev[0]) + Math.abs(_v.y - this.pinPrev[1]) + Math.abs(_v.z - this.pinPrev[2]) > 1.5) this.reset();
    const steps = Math.min(6, Math.max(1, Math.ceil(dt / H)));
    const h = dt / steps;
    const P = this.pos, Q = this.prev, pins = this.pinned;
    const damp = 0.985;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      for (let i = 0; i < this.n; i++) {
        const o = i * 3;
        if (pins[i]) {
          this.anchor(i, _v);
          const x = this.pinPrev[o] + (_v.x - this.pinPrev[o]) * t, y = this.pinPrev[o + 1] + (_v.y - this.pinPrev[o + 1]) * t, z = this.pinPrev[o + 2] + (_v.z - this.pinPrev[o + 2]) * t;
          Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
          P[o] = x; P[o + 1] = y; P[o + 2] = z;
          continue;
        }
        const vx = (P[o] - Q[o]) * damp, vy = (P[o + 1] - Q[o + 1]) * damp, vz = (P[o + 2] - Q[o + 2]) * damp;
        Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
        // gravity + a little air drag against movement + gentle breeze; in water: nearly weightless, slow
        const wet = P[o + 1] < waterY;
        const drag = (wet ? 7 : 1.6) * h;
        P[o] += vx - vx * drag + (wind.x) * h * h;
        P[o + 1] += vy - vy * drag - (wet ? -0.4 : 9.8) * h * h;
        P[o + 2] += vz - vz * drag + (wind.z) * h * h;
      }
      for (let it = 0; it < 4; it++) {
        for (const [i, j, rest, k, sl] of this.cons) {
          const a = i * 3, b = j * 3;
          const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          if (sl && d < rest) continue;
          const diff = ((d - rest) / d) * k;
          const wi = pins[i] ? 0 : pins[j] ? 1 : 0.5;
          const wj = pins[j] ? 0 : pins[i] ? 1 : 0.5;
          P[a] += dx * diff * wi; P[a + 1] += dy * diff * wi; P[a + 2] += dz * diff * wi;
          P[b] -= dx * diff * wj; P[b + 1] -= dy * diff * wj; P[b + 2] -= dz * diff * wj;
        }
        if (it % 2 === 0 && it < 3 && colliders.length > 8) continue; // big cloth: collide on alternate passes
        for (const cap of colliders) {
          _b.subVectors(cap.b, cap.a);
          const ll = _b.lengthSq() || 1e-6;
          const r2 = cap.r * cap.r;
          for (let i = 0; i < this.n; i++) {
            if (pins[i]) continue;
            const o = i * 3;
            _c.set(P[o] - cap.a.x, P[o + 1] - cap.a.y, P[o + 2] - cap.a.z);
            const tt = Math.max(0, Math.min(1, _c.dot(_b) / ll));
            const dx = _c.x - _b.x * tt, dy = _c.y - _b.y * tt, dz = _c.z - _b.z * tt;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r2) {
              const d = Math.sqrt(d2) || 1e-6;
              const push = (cap.r - d) / d;
              P[o] += dx * push; P[o + 1] += dy * push; P[o + 2] += dz * push;
            }
          }
        }
      }
      // the ground: cloth settles on it and drags a little
      if (floorY > -Infinity) {
        for (let i = 0; i < this.n; i++) {
          const o = i * 3;
          if (P[o + 1] < floorY) { P[o + 1] = floorY; Q[o] += (P[o] - Q[o]) * 0.4; Q[o + 2] += (P[o + 2] - Q[o + 2]) * 0.4; }
        }
      }
    }
    for (let i = 0; i < this.n; i++) if (pins[i]) {
      this.anchor(i, _v);
      this.pinPrev[i * 3] = _v.x; this.pinPrev[i * 3 + 1] = _v.y; this.pinPrev[i * 3 + 2] = _v.z;
    }
    const attr = this.mesh.geometry.attributes.position;
    attr.array.set(P);
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    if (this.fur) this.fur.update();
  }
}

// A thick, shaggy roll of fur that follows a chain of cloth particles (Catmull-Rom smoothed).
class FurTrim {
  constructor(cloth, chain, closed, radius, material, color) {
    this.cloth = cloth; this.chain = chain; this.closed = closed; this.r = radius;
    const S = this.S = 3, K = this.K = 8;
    const n = chain.length;
    const M = this.M = closed ? n * S : (n - 1) * S + 1;
    const nv = M * K;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    const col = new Float32Array(nv * 3), a0 = new Float32Array(nv * 4), a1 = new Float32Array(nv * 4), ao = new Float32Array(nv), rp = new Float32Array(nv * 3);
    const base = new THREE.Color(color);
    this.jag = new Float32Array(nv);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let m = 0; m < M; m++) for (let k = 0; k < K; k++) {
      const i = m * K + k;
      this.jag[i] = 0.62 + 0.62 * rnd() * (k % 2 ? 1 : 0.7);
      const v = 0.8 + 0.3 * rnd();
      col[i * 3] = base.r * v; col[i * 3 + 1] = base.g * v; col[i * 3 + 2] = base.b * v;
      a1[i * 4] = 1;
      ao[i] = 0.72 + 0.28 * Math.max(0, Math.cos((k / K) * Math.PI * 2));
      rp.set([m * 0.012, (k / K) * radius * 6.3, 0], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMat0', new THREE.BufferAttribute(a0, 4));
    g.setAttribute('aMat1', new THREE.BufferAttribute(a1, 4));
    g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    g.setAttribute('aRest', new THREE.BufferAttribute(rp, 3));
    const idx = [];
    const rings = closed ? M : M - 1;
    for (let m = 0; m < rings; m++) {
      const m2 = (m + 1) % M;
      for (let k = 0; k < K; k++) {
        const k2 = (k + 1) % K;
        const a = m * K + k, b = m * K + k2, c = m2 * K + k, d = m2 * K + k2;
        idx.push(a, c, b, b, c, d);
      }
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  update() {
    const P = this.cloth.pos, N = this.cloth.mesh.geometry.attributes.normal.array;
    const ch = this.chain, n = ch.length, S = this.S, K = this.K;
    const pos = this.mesh.geometry.attributes.position.array, nor = this.mesh.geometry.attributes.normal.array;
    const at = (j) => (this.closed ? ch[((j % n) + n) % n] : ch[Math.max(0, Math.min(n - 1, j))]);
    for (let m = 0; m < this.M; m++) {
      const u = m / S, i = Math.min(Math.floor(u), this.closed ? n - 1 : n - 2), f = u - i;
      const i0 = at(i - 1) * 3, i1 = at(i) * 3, i2 = at(i + 1) * 3, i3 = at(i + 2) * 3;
      const f2 = f * f, f3 = f2 * f;
      for (let a = 0; a < 3; a++) {
        const p0 = P[i0 + a], p1 = P[i1 + a], p2 = P[i2 + a], p3 = P[i3 + a];
        _p.setComponent(a, 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3));
        _t.setComponent(a, 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f2));
        _n.setComponent(a, N[i1 + a] * (1 - f) + N[i2 + a] * f);
      }
      _t.normalize();
      _n.addScaledVector(_t, -_n.dot(_t));
      if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
      _n.normalize();
      _bn.crossVectors(_t, _n);
      for (let k = 0; k < K; k++) {
        const ang = (k / K) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
        const j = m * K + k;
        const dx = _n.x * c + _bn.x * s, dy = _n.y * c + _bn.y * s, dz = _n.z * c + _bn.z * s;
        const rr = this.r * this.jag[j];
        pos[j * 3] = _p.x + dx * rr; pos[j * 3 + 1] = _p.y + dy * rr; pos[j * 3 + 2] = _p.z + dz * rr;
        nor[j * 3] = dx; nor[j * 3 + 1] = dy; nor[j * 3 + 2] = dz;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.normal.needsUpdate = true;
  }
}
