// Signed-distance sculpting for characters.
// Shapes are blended with smooth unions into one seamless surface, meshed with surface nets,
// snapped onto the exact surface with a few Newton steps, then given skin weights and colours
// from whichever shape each vertex belongs to.

export const smin = (a, b, k) => {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
};
export const smax = (a, b, k) => -smin(-a, -b, k);

// ---- primitives: each returns (x, y, z) => signed distance -------------------------
// Each primitive carries a bounding sphere `.b = [cx, cy, cz, r]` so far-away parts can be skipped.
const bound = (fn, c, r) => { fn.b = [c[0], c[1], c[2], r]; return fn; };
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const len2 = (x, y) => Math.sqrt(x * x + y * y);

export const sphere = (c, r) => bound((x, y, z) => len3(x - c[0], y - c[1], z - c[2]) - r, c, r);

export function ellipsoid(c, r) {
  const [rx, ry, rz] = r;
  return bound((x, y, z) => {
    const px = x - c[0], py = y - c[1], pz = z - c[2];
    const k0 = len3(px / rx, py / ry, pz / rz);
    const k1 = len3(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  }, c, Math.max(rx, ry, rz));
}

// Inigo Quilez's exact round cone (capsule whose radius goes r1 → r2).
export function roundCone(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return bound((x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  }, mid, Math.sqrt(l2) / 2 + Math.max(r1, r2));
}
export const capsule = (a, b, r) => roundCone(a, b, r, r);

export function roundBox(c, half, r) {
  const [hx, hy, hz] = half;
  return bound((x, y, z) => {
    const qx = Math.abs(x - c[0]) - hx + r, qy = Math.abs(y - c[1]) - hy + r, qz = Math.abs(z - c[2]) - hz + r;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return len3(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }, c, Math.hypot(hx, hy, hz));
}

// Horizontal ring with radii rx/rz (ellipse), tube radius r.
export function torus(c, rx, rz, r) {
  const avg = (rx + rz) / 2;
  return bound((x, y, z) => {
    const q = (len2((x - c[0]) / rx, (z - c[2]) / rz) - 1) * avg;
    return len2(q, y - c[1]) - r;
  }, c, Math.max(rx, rz) + r);
}

// A band that hugs another surface: the shell of `base` grown by `off`, kept `thick` thick,
// limited to a slab of half-width `w` around the plane through p with normal n. Straps, trims.
export function band(base, off, thick, p, n, w) {
  const nl = Math.hypot(n[0], n[1], n[2]);
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
  return (x, y, z) => {
    const shell = Math.abs(base(x, y, z) - off) - thick;
    const slab = Math.abs((x - p[0]) * nx + (y - p[1]) * ny + (z - p[2]) * nz) - w;
    return Math.max(shell, slab);
  };
}

export const halfSpace = (p, n) => {
  const nl = Math.hypot(n[0], n[1], n[2]);
  return (x, y, z) => ((x - p[0]) * n[0] + (y - p[1]) * n[1] + (z - p[2]) * n[2]) / nl;
};

// ---- a sculpt = list of parts --------------------------------------------------------
// part: { d: fn, k: blend radius, region: string | (x,y,z)=>string, bone: string, sub: bool,
//         cut: bool (intersect instead of union), sigma: skin blend width }
export function evaluator(parts) {
  const n = parts.length;
  const vals = new Float64Array(n);
  // Fast version: skips parts whose bounding sphere proves they can't change the result.
  const f = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      const k = p.k || 0;
      const b = p.d.b;
      if (b && !p.cut && d !== Infinity) {
        const dx = x - b[0], dy = y - b[1], dz = z - b[2];
        const lb = Math.sqrt(dx * dx + dy * dy + dz * dz) - b[3];
        if (p.sub ? lb + d > k : lb > d + k) continue;
      }
      const v = p.d(x, y, z);
      if (p.sub) d = smax(d, -v, k);
      else if (p.cut) d = smax(d, v, k);
      else d = smin(d, v, k);
    }
    return d;
  };
  // Full version: evaluates everything and records each part's distance (for skinning/colours).
  f.full = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      const v = p.d(x, y, z);
      vals[i] = v;
      if (p.sub) d = smax(d, -v, p.k || 0);
      else if (p.cut) d = smax(d, v, p.k || 0);
      else d = smin(d, v, p.k || 0);
    }
    return d;
  };
  f.vals = vals;
  return f;
}

// ---- surface nets --------------------------------------------------------------------
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [];
for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) { const k = i ^ (1 << j); if (k > i) EDGES.push([i, k]); }

export function meshSDF(f, min, max, h, refine = 3) {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const sxy = nx * ny;
  const F = new Float32Array(nx * ny * nz);

  // Sample, skipping exact evaluation for blocks that are clearly far from the surface.
  const B = 4, far = 4.5 * h;
  for (let bz = 0; bz < nz; bz += B) for (let by = 0; by < ny; by += B) for (let bx = 0; bx < nx; bx += B) {
    const ex = Math.min(bx + B, nx), ey = Math.min(by + B, ny), ez = Math.min(bz + B, nz);
    const dc = f(min[0] + ((bx + ex - 1) / 2) * h, min[1] + ((by + ey - 1) / 2) * h, min[2] + ((bz + ez - 1) / 2) * h);
    const skip = Math.abs(dc) > far;
    for (let z = bz; z < ez; z++) for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
      F[x + y * nx + z * sxy] = skip ? dc : f(min[0] + x * h, min[1] + y * h, min[2] + z * h);
    }
  }

  // One vertex per cell that the surface crosses.
  const cw = nx - 1, ch = ny - 1, cd = nz - 1;
  const cell = new Int32Array(cw * ch * cd).fill(-1);
  const pos = [];
  const quads = [];
  const g = new Float64Array(8);
  for (let z = 0; z < cd; z++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = F[(x + CORNERS[c][0]) + (y + CORNERS[c][1]) * nx + (z + CORNERS[c][2]) * sxy];
      g[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (const [a, b] of EDGES) {
      const da = g[a], db = g[b];
      if ((da < 0) === (db < 0)) continue;
      const t = da / (da - db);
      ax += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
      ay += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
      az += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
      cnt++;
    }
    const ci = x + y * cw + z * cw * ch;
    cell[ci] = pos.length / 3;
    pos.push(min[0] + (x + ax / cnt) * h, min[1] + (y + ay / cnt) * h, min[2] + (z + az / cnt) * h);

    // Faces: for each axis whose edge from corner 0 crosses the surface, join the 4 cells around it.
    const cc = [x, y, z];
    const R = [1, cw, cw * ch];
    for (let i = 0; i < 3; i++) {
      if (((mask & 1) !== 0) === ((mask & (1 << (1 << i))) !== 0)) continue;
      const iu = (i + 1) % 3, iv = (i + 2) % 3;
      if (cc[iu] === 0 || cc[iv] === 0) continue;
      const du = R[iu], dv = R[iv];
      if (mask & 1) quads.push(ci, ci - du, ci - du - dv, ci - dv);
      else quads.push(ci, ci - dv, ci - du - dv, ci - du);
    }
  }

  // Snap vertices onto the true surface and take normals from the gradient. A tetrahedral stencil
  // gives both the gradient and the distance from four samples.
  const nv = pos.length / 3;
  const P = new Float32Array(pos);
  const N = new Float32Array(nv * 3);
  const e = h * 0.35;
  for (let i = 0; i < nv; i++) {
    let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    let gx = 0, gy = 1, gz = 0;
    for (let it = 0; it <= refine; it++) {
      const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d4 = f(x + e, y + e, z + e);
      gx = a - b - c + d4; gy = -a - b + c + d4; gz = -a + b - c + d4;
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (!(gl > 1e-9)) { gx = 0; gy = 1; gz = 0; } else { gx /= gl; gy /= gl; gz /= gl; }
      if (it === refine) break;
      let d = (a + b + c + d4) * 0.25;
      if (d > h) d = h; else if (d < -h) d = -h;
      x -= gx * d; y -= gy * d; z -= gz * d;
    }
    P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    N[i * 3] = gx; N[i * 3 + 1] = gy; N[i * 3 + 2] = gz;
  }

  // Quads → triangles (split along the shorter diagonal), then make winding face outward.
  const idx = [];
  const d2 = (a, b) => { const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2]; return dx * dx + dy * dy + dz * dz; };
  for (let q = 0; q < quads.length; q += 4) {
    const a = cell[quads[q]], b = cell[quads[q + 1]], c = cell[quads[q + 2]], d = cell[quads[q + 3]];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    if (d2(a, c) < d2(b, d)) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  }
  let agree = 0;
  for (let t = 0; t < Math.min(idx.length, 3000); t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    agree += Math.sign(fx * N[a * 3] + fy * N[a * 3 + 1] + fz * N[a * 3 + 2]);
  }
  if (agree < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  return { positions: P, normals: N, indices: nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}

// Per-vertex skin weights (up to 4 bones) and region, from which parts are nearest.
export function skinAndPaint(parts, f, positions, boneIndex, sigmaDefault = 0.022) {
  const nv = positions.length / 3;
  const skinIndex = new Uint16Array(nv * 4);
  const skinWeight = new Float32Array(nv * 4);
  const regions = new Array(nv);
  const acc = new Map();
  for (let i = 0; i < nv; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    f.full(x, y, z);
    const vals = f.vals;
    let best = Infinity, bi = 0, near = Infinity;
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].sub || parts[p].cut) continue;
      if (vals[p] < best) best = vals[p];
    }
    // colour comes from whichever surface the vertex actually lies on (carved holes included)
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].cut || !parts[p].region) continue;
      const a = Math.abs(vals[p]);
      if (a < near) { near = a; bi = p; }
    }
    const reg = parts[bi].region;
    regions[i] = typeof reg === 'function' ? reg(x, y, z) : reg;
    acc.clear();
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.sub || part.cut || part.noSkin) continue;
      const s = part.sigma || sigmaDefault;
      const dd = vals[p] - best;
      if (dd > s * 5) continue;
      const w = Math.exp(-dd / s);
      const bones = part.bones || [[part.bone, 1]];
      for (const [bn, bw] of bones) acc.set(bn, (acc.get(bn) || 0) + w * bw);
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, t) => s + t[1], 0) || 1;
    top.forEach(([bn, w], k) => { skinIndex[i * 4 + k] = boneIndex[bn]; skinWeight[i * 4 + k] = w / sum; });
  }
  return { skinIndex, skinWeight, regions };
}
