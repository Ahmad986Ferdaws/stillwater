import * as THREE from 'three';
import { mulberry32 } from '../noise.js';

// Procedural, tileable textures for the ground, bark and foliage. Generated once at load, no assets.
// Pure generators return typed arrays (testable in node); the cached *Textures() wrappers build
// the THREE textures (array textures for ground + bark, a mip-mapped atlas for leaves).

// ---- colour helpers ------------------------------------------------------------------------
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const L2S = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) L2S[i] = Math.round(l2s(i / 4096) * 255);
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) S2L[i] = s2l(i / 255);
const enc = (v) => L2S[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096 + 0.5) | 0];
const byte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

export function hexLin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [s2l(((n >> 16) & 255) / 255), s2l(((n >> 8) & 255) / 255), s2l((n & 255) / 255)];
}
// The terrain colour maps store linear values in sRGB-flagged textures, so what reaches the screen
// is the palette decoded twice. Ground detail uses the same "effective" colours to keep the look.
export function hexEff(hex) { return hexLin(hex).map(s2l); }
function hexSrgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v) => v - Math.floor(v);

// ---- tileable noise -----------------------------------------------------------------------
function gradTable(rnd, P) {
  const g = new Float32Array(P * P * 2);
  for (let i = 0; i < P * P; i++) { const a = rnd() * Math.PI * 2; g[i * 2] = Math.cos(a); g[i * 2 + 1] = Math.sin(a); }
  return g;
}
// Gradient noise with integer periods P (x) and Q (y); x, y in lattice units. Range ~[-1, 1].
function gnoise(g, P, x, y, Q = P) {
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  const x0 = ((xf % P) + P) % P, y0 = ((yf % Q) + Q) % Q, x1 = x0 + 1 === P ? 0 : x0 + 1, y1 = y0 + 1 === Q ? 0 : y0 + 1;
  const i00 = (y0 * P + x0) * 2, i10 = (y0 * P + x1) * 2, i01 = (y1 * P + x0) * 2, i11 = (y1 * P + x1) * 2;
  const n00 = g[i00] * fx + g[i00 + 1] * fy;
  const n10 = g[i10] * (fx - 1) + g[i10 + 1] * fy;
  const n01 = g[i01] * fx + g[i01 + 1] * (fy - 1);
  const n11 = g[i11] * (fx - 1) + g[i11 + 1] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.41;
}
// fbm field, tileable on [0,1)^2. basePeriod: lattice cells across the tile for the first octave;
// periodY (optional) gives anisotropic cells (e.g. streaks stretched along v).
function field(seed, basePeriod, octaves, gain = 0.5, periodY = basePeriod) {
  const rnd = mulberry32(seed);
  const tabs = [];
  for (let o = 0; o < octaves; o++) { const P = basePeriod << o, Q = periodY << o; tabs.push({ g: gradTable(rnd, Math.max(P, Q)), P, Q }); }
  let norm = 0;
  for (let o = 0, a = 1; o < octaves; o++, a *= gain) norm += a;
  return (u, v) => {
    let s = 0, a = 1;
    for (let o = 0; o < tabs.length; o++) { const t = tabs[o]; s += a * gnoise(t.g, t.P, u * t.P, v * t.Q, t.Q); a *= gain; }
    return s / norm;
  };
}
// Evaluate a field on an n x n grid, then (optionally) bilinearly upsample to S x S with wrap.
function grid(f, n, S = n) {
  const g = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g[y * n + x] = f(x / n, y / n);
  if (S === n) return g;
  const out = new Float32Array(S * S), k = n / S;
  for (let y = 0; y < S; y++) {
    const gy = y * k, y0 = Math.floor(gy), fy = gy - y0, y1 = (y0 + 1) % n;
    for (let x = 0; x < S; x++) {
      const gx = x * k, x0 = Math.floor(gx), fx = gx - x0, x1 = (x0 + 1) % n;
      const a = g[y0 * n + x0], b = g[y0 * n + x1], c = g[y1 * n + x0], d = g[y1 * n + x1];
      out[y * S + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  }
  return out;
}
// Tileable Worley noise: one jittered feature point per cell (cx x cy cells over the tile).
function worleySet(seed, cx, cy = cx) {
  const rnd = mulberry32(seed);
  const pts = new Float32Array(cx * cy * 3);
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const k = (j * cx + i) * 3;
    pts[k] = i + 0.1 + rnd() * 0.8; pts[k + 1] = j + 0.1 + rnd() * 0.8; pts[k + 2] = rnd();
  }
  return { cx, cy, pts, ox: rnd() * cx, oy: rnd() * cy };
}
const W = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
function worley(ws, u, v) {
  const { cx, cy, pts } = ws;
  const x = u * cx + ws.ox, y = v * cy + ws.oy, ix = Math.floor(x), iy = Math.floor(y);
  const ix0 = ((ix % cx) + cx) % cx, iy0 = ((iy % cy) + cy) % cy;
  let f1 = 1e9, f2 = 1e9, id = 0, dx1 = 0, dy1 = 0;
  for (let j = -1; j <= 1; j++) {
    let wy = iy0 + j;
    if (wy < 0) wy += cy; else if (wy >= cy) wy -= cy;
    const oy = iy + j - wy - y;
    for (let i = -1; i <= 1; i++) {
      let wx = ix0 + i;
      if (wx < 0) wx += cx; else if (wx >= cx) wx -= cx;
      const k = (wy * cx + wx) * 3;
      const dx = pts[k] + ix + i - wx - x, dy = pts[k + 1] + oy;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = pts[k + 2]; dx1 = dx; dy1 = dy; } else if (d < f2) f2 = d;
    }
  }
  W.f1 = Math.sqrt(f1); W.f2 = Math.sqrt(f2); W.id = id; W.dx = dx1; W.dy = dy1;
  return W;
}

// Separable wrap-around box blur (used for cavity AO).
function blurWrap(src, S, r) {
  const tmp = new Float32Array(S * S), out = new Float32Array(S * S), n = 2 * r + 1;
  for (let y = 0; y < S; y++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[y * S + ((i + S) % S)];
    for (let x = 0; x < S; x++) {
      tmp[y * S + x] = s / n;
      s += src[y * S + ((x + r + 1) % S)] - src[y * S + ((x - r + S) % S)];
    }
  }
  for (let x = 0; x < S; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[((i + S) % S) * S + x];
    for (let y = 0; y < S; y++) {
      out[y * S + x] = s / n;
      s += tmp[((y + r + 1) % S) * S + x] - tmp[((y - r + S) % S) * S + x];
    }
  }
  return out;
}

// Anti-aliased tapered stroke into float buffers with wrap-around (tileable).
function strokeWrap(S, x0, y0, x1, y1, w0, w1, fn) {
  const minx = Math.floor(Math.min(x0, x1) - Math.max(w0, w1) - 1), maxx = Math.ceil(Math.max(x0, x1) + Math.max(w0, w1) + 1);
  const miny = Math.floor(Math.min(y0, y1) - Math.max(w0, w1) - 1), maxy = Math.ceil(Math.max(y0, y1) + Math.max(w0, w1) + 1);
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1e-6;
  for (let y = miny; y <= maxy; y++) {
    const wy = ((y % S) + S) % S;
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const t = clamp01((px * dx + py * dy) / len2);
      const ex = px - dx * t, ey = py - dy * t;
      const hw = (w0 + (w1 - w0) * t) * 0.5;
      const cov = clamp01(hw - Math.sqrt(ex * ex + ey * ey) + 0.5);
      if (cov <= 0) continue;
      fn(wy * S + (((x % S) + S) % S), cov, t);
    }
  }
}

// Height -> tangent-space normal (wrap), packed into rg. Returns Float32 pairs.
function normalsFromHeight(h, S, strength) {
  const n = new Float32Array(S * S * 2);
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const dx = (h[y * S + xp] - h[y * S + xm]) * 0.5 * strength;
      const dy = (h[yp + x] - h[ym + x]) * 0.5 * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      n[(y * S + x) * 2] = -dx * il; n[(y * S + x) * 2 + 1] = -dy * il;
    }
  }
  return n;
}

// ============================================================================================
// Ground layers: 0 grass-soil, 1 dirt path, 2 rock, 3 sand, 4 lake-bed mud/pebbles.
// Albedo array (RGBA8, linear storage): layer 0 rgb = colour modulation * 0.5 (the grass colour
// comes from the macro grass map), layers 1-4 rgb = sRGB-encoded absolute colour; a = height.
// Normal array: rg = normal xy, b = layer 0: soil mask / others: roughness, a = 1.
// ============================================================================================
export const GROUND_SIZE = 512;
export const GROUND_LAYERS = ['grass', 'dirt', 'rock', 'sand', 'mud'];

function layerGrass(S, rnd) {
  const px = S * S;
  const rgb = new Float32Array(px * 3), h = new Float32Array(px), extra = new Float32Array(px), cov = new Float32Array(px);
  const lowA = grid(field(101, 4, 3), 128, S), lowB = grid(field(102, 8, 3), 128, S), hi = grid(field(103, 64, 2), S);
  for (let i = 0; i < px; i++) {
    const a = lowA[i], g = hi[i];
    const b = 1 + 0.16 * a + 0.06 * g;
    rgb[i * 3] = b * (1 + 0.1 * a); rgb[i * 3 + 1] = b * (1 + 0.02 * a); rgb[i * 3 + 2] = b * (1 - 0.12 * a);
    h[i] = 0.22 + 0.08 * g;
  }
  const soilArea = (i) => smooth(0.12, 0.42, -lowB[i]);
  const count = Math.round(15000 * (S / 512) ** 2);
  for (let k = 0; k < count; k++) {
    const x = rnd() * S, y = rnd() * S;
    const i0 = ((y | 0) % S) * S + ((x | 0) % S);
    if (rnd() < soilArea(i0) * 0.75) continue;
    const ang = rnd() * Math.PI * 2, len = 5 + rnd() * 9, w = 0.9 + rnd() * 0.8;
    const br = 0.72 + rnd() * 0.62;
    const hue = rnd();
    const cr = hue < 0.3 ? br * 1.16 : hue > 0.8 ? br * 0.86 : br;
    const cg = hue < 0.3 ? br * 1.05 : br;
    const cb = hue < 0.3 ? br * 0.7 : hue > 0.8 ? br * 1.15 : br;
    const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
    strokeWrap(S, x, y, x1, y1, w, w * 0.35, (i, c, t) => {
      const a = c * 0.92;
      rgb[i * 3] += (cr * (0.75 + 0.35 * t) - rgb[i * 3]) * a;
      rgb[i * 3 + 1] += (cg * (0.75 + 0.35 * t) - rgb[i * 3 + 1]) * a;
      rgb[i * 3 + 2] += (cb * (0.75 + 0.35 * t) - rgb[i * 3 + 2]) * a;
      const hh = 0.45 + 0.4 * t;
      if (hh > h[i]) h[i] += (hh - h[i]) * c;
      cov[i] = Math.max(cov[i], c);
    });
  }
  // clover trefoils
  for (let k = 0; k < Math.round(260 * (S / 512) ** 2); k++) {
    const x = rnd() * S, y = rnd() * S, r = 1.8 + rnd() * 1.4, rot = rnd() * 6.28;
    for (let l = 0; l < 3; l++) {
      const a = rot + (l * Math.PI * 2) / 3, cx = x + Math.cos(a) * r, cy = y + Math.sin(a) * r;
      strokeWrap(S, cx, cy, cx + 0.01, cy, r * 1.9, r * 1.9, (i, c) => {
        rgb[i * 3] += (0.72 - rgb[i * 3]) * c; rgb[i * 3 + 1] += (1.06 - rgb[i * 3 + 1]) * c; rgb[i * 3 + 2] += (0.72 - rgb[i * 3 + 2]) * c;
        h[i] = Math.max(h[i], 0.5 * c + h[i] * (1 - c)); cov[i] = Math.max(cov[i], c);
      });
    }
  }
  for (let i = 0; i < px; i++) extra[i] = clamp01((soilArea(i) * 0.9 + 0.12) * (1 - cov[i]) * 1.2);
  return { rgb, h, extra, strength: 2.2, ao: 1.4 };
}

function layerDirt(S, rnd) {
  const px = S * S;
  const rgb = new Float32Array(px * 3), h = new Float32Array(px), extra = new Float32Array(px);
  const base = hexEff('#d6c296'), dark = hexEff('#c4ab7c'), light = hexEff('#e2d3ae');
  const pal = ['#b5b0a5', '#9d978c', '#d9d3c5', '#b69070', '#7c776f', '#c8b89a'].map(hexEff);
  const lowA = grid(field(201, 4, 3), 128, S), lowB = grid(field(202, 8, 3), 128, S), hi = grid(field(203, 128, 1), S);
  const peb = worleySet(204, 40), stone = worleySet(205, 11), crack = worleySet(206, 6);
  for (let y = 0, i = 0; y < S; y++) {
    for (let x = 0; x < S; x++, i++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const a = lowA[i], b = lowB[i], g = hi[i], sp = rnd() - 0.5;
      const t = clamp01(0.5 + a * 0.9);
      let r = dark[0] + (light[0] - dark[0]) * t, gg = dark[1] + (light[1] - dark[1]) * t, bb = dark[2] + (light[2] - dark[2]) * t;
      const m = 0.94 + 0.08 * g + 0.07 * sp;
      r *= m * (1 + 0.05 * b); gg *= m; bb *= m * (1 - 0.06 * b);
      let hh = 0.3 + 0.08 * a + 0.06 * g + 0.03 * sp;
      // cracks in dry patches
      const c = worley(crack, u, v);
      const cw = (c.f2 - c.f1);
      if (b > 0.15 && cw < 0.04) { const k = (1 - cw / 0.04) * smooth(0.15, 0.4, b); r *= 1 - 0.3 * k; gg *= 1 - 0.3 * k; bb *= 1 - 0.27 * k; hh -= 0.14 * k; }
      // larger flat stones
      let w = worley(stone, u, v);
      if (fract(w.id * 13.7) < 0.11 && w.f1 < 0.32 * 1.26 * 1.3) {
        const rr = 0.2 + 0.12 * fract(w.id * 7.3);
        const ang = Math.atan2(w.dy, w.dx), rad = rr * (1 + 0.12 * Math.sin(ang * 2 + w.id * 40) + 0.06 * Math.sin(ang * 3 + w.id * 90));
        if (w.f1 < rad) {
          const q = w.f1 / rad, dome = Math.sqrt(1 - q * q);
          const pc = mix3(pal[(w.id * 97 | 0) % pal.length], [r, gg, bb], 0.3);
          const sh = 0.8 + 0.25 * dome + 0.05 * g;
          const e = smooth(1, 0.85, q);
          r += (pc[0] * sh - r) * e; gg += (pc[1] * sh - gg) * e; bb += (pc[2] * sh - bb) * e;
          hh = Math.max(hh, 0.45 + 0.3 * dome);
        } else if (w.f1 < rad * 1.3) { const k = 1 - (w.f1 - rad) / (rad * 0.3); r *= 1 - 0.25 * k; gg *= 1 - 0.25 * k; bb *= 1 - 0.25 * k; }
      }
      // pebbles
      w = worley(peb, u, v);
      if (fract(w.id * 31.1) < 0.24 && w.f1 < 0.35 * 1.2 * 1.45) {
        const rr = 0.15 + 0.2 * fract(w.id * 5.9);
        const ang = Math.atan2(w.dy, w.dx), rad = rr * (1 + 0.2 * Math.sin(ang * 2 + w.id * 60));
        if (w.f1 < rad) {
          const q = w.f1 / rad, dome = Math.sqrt(1 - q * q);
          const pc = mix3(pal[(w.id * 131 | 0) % pal.length], [r, gg, bb], 0.4);
          const sh = 0.78 + 0.32 * dome;
          const e = smooth(1, 0.8, q);
          r += (pc[0] * sh - r) * e; gg += (pc[1] * sh - gg) * e; bb += (pc[2] * sh - bb) * e;
          hh = Math.max(hh, 0.5 + 0.35 * dome);
        } else if (w.f1 < rad * 1.45) { const k = 1 - (w.f1 - rad) / (rad * 0.45); r *= 1 - 0.2 * k; gg *= 1 - 0.2 * k; bb *= 1 - 0.2 * k; }
      }
      const gv = rnd();
      if (gv < 0.025) { r *= 0.72; gg *= 0.72; bb *= 0.74; hh += 0.08; } else if (gv > 0.97) { r *= 1.22; gg *= 1.2; bb *= 1.22; hh += 0.1; }
      rgb[i * 3] = r; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = bb;
      h[i] = clamp01(hh); extra[i] = 0.95;
    }
  }
  normaliseMean(rgb, base);
  return { rgb, h, extra, strength: 3.5, ao: 1.6 };
}

function layerRock(S, rnd) {
  const px = S * S;
  const rgb = new Float32Array(px * 3), h = new Float32Array(px), extra = new Float32Array(px);
  const base = hexEff('#aca79a'), dark = hexEff('#8a8579'), light = hexEff('#c4bfb2');
  const lichA = hexEff('#b7c07c'), lichB = hexEff('#d4a05c'), stain = hexEff('#8d8474');
  const warpA = grid(field(301, 4, 3), 128, S), warpB = grid(field(307, 4, 3), 128, S);
  const low = grid(field(302, 2, 4), 128, S), mid = grid(field(308, 12, 3), 256, S), hi = grid(field(303, 64, 2), S);
  const lich = grid(field(304, 6, 4), 128, S), lich2 = grid(field(305, 10, 3), 128, S);
  const facets = worleySet(306, 7, 5), cracks = worleySet(309, 5, 4);
  const K = 5;
  const strata = Array.from({ length: K }, () => ({ b: 0.86 + rnd() * 0.24, h: 0.5 + rnd() * 0.2, hue: rnd() - 0.5 }));
  for (let y = 0, i = 0; y < S; y++) {
    for (let x = 0; x < S; x++, i++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const wu = u + warpA[i] * 0.07, wv = v + warpB[i] * 0.07;
      // fractured facets: each cell is a slightly tilted face with its own tone
      const f = worley(facets, wu, wv);
      const cb = fract(f.id * 7.31), ta = f.id * 6.283;
      // soft per-face tone and tilt, faded out near face borders (no outlined "plates")
      const edge = smooth(0, 0.22, f.f2 - f.f1);
      const tilt = (f.dx * Math.cos(ta) + f.dy * Math.sin(ta)) * 0.16 * edge;
      // soft strata along v
      const sv = wv * K + low[i] * 0.35 + 0.43;
      const kf = Math.floor(sv), fr = sv - kf, st = strata[((kf % K) + K) % K];
      const band = smooth(0, 0.12, fr) * smooth(1, 0.85, fr);
      const t = clamp01(0.5 + 0.5 * low[i] + 0.3 * mid[i] + 0.16 * (cb - 0.5) * edge + 0.25 * (st.b - 1));
      let r = dark[0] + (light[0] - dark[0]) * t, g = dark[1] + (light[1] - dark[1]) * t, b = dark[2] + (light[2] - dark[2]) * t;
      const m = st.b * (0.92 + 0.1 * hi[i]) * (0.82 + 0.18 * band);
      r *= m * (1 + 0.05 * st.hue); g *= m; b *= m * (1 - 0.07 * st.hue);
      let hh = st.h * 0.4 + 0.35 + 0.08 * cb * edge + tilt + 0.16 * mid[i] + 0.07 * hi[i];
      hh -= 0.16 * (1 - band);
      // thin cracks, warped so they meander, only in some regions
      const c = worley(cracks, u + warpB[i] * 0.1, v + warpA[i] * 0.1);
      const cm = smooth(0.15, 0.45, mid[i] + 0.25 * low[i]);
      const cw = c.f2 - c.f1;
      if (cw < 0.018 && cm > 0) { const k = (1 - cw / 0.018) * cm; r *= 1 - 0.38 * k; g *= 1 - 0.38 * k; b *= 1 - 0.34 * k; hh -= 0.22 * k; }
      // rain stains and lichen blotches
      const sk = smooth(0.25, 0.55, -lich2[i]) * 0.35;
      r += (stain[0] * 0.8 - r) * sk; g += (stain[1] * 0.8 - g) * sk; b += (stain[2] * 0.8 - b) * sk;
      const la = smooth(0.3, 0.42, lich[i] + 0.12 * mid[i]) * 0.8, lb = smooth(0.46, 0.56, lich2[i] + 0.1 * hi[i]) * 0.7;
      if (la > 0) { const k = 0.85 + 0.25 * hi[i]; r += (lichA[0] * k - r) * la; g += (lichA[1] * k - g) * la; b += (lichA[2] * k - b) * la; hh += 0.04 * la; }
      if (lb > 0) { r += (lichB[0] - r) * lb; g += (lichB[1] - g) * lb; b += (lichB[2] - b) * lb; hh += 0.03 * lb; }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      h[i] = clamp01(hh); extra[i] = 0.8 + 0.12 * (la + lb);
    }
  }
  normaliseMean(rgb, base);
  return { rgb, h, extra, strength: 6, ao: 1.8 };
}

function layerSand(S, rnd) {
  const px = S * S;
  const rgb = new Float32Array(px * 3), h = new Float32Array(px), extra = new Float32Array(px);
  const base = hexEff('#ddcb97');
  const warp = grid(field(401, 2, 3), 128, S), mask = grid(field(402, 4, 2), 128, S), low = grid(field(403, 8, 2), 128, S);
  const shells = worleySet(404, 18);
  const shellCol = ['#f1ece0', '#e8d9c0', '#b9ada0', '#8f8579'].map(hexEff);
  for (let y = 0, i = 0; y < S; y++) {
    for (let x = 0; x < S; x++, i++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const ph = u * 11 + v * 2 + warp[i] * 1.4;
      const s = fract(ph);
      const prof = s < 0.72 ? smooth(0, 0.72, s) : smooth(1, 0.72, s);
      const rm = smooth(-0.35, 0.25, mask[i]);
      const grain = rnd() - 0.5;
      let hh = 0.35 + 0.28 * prof * rm + 0.06 * grain + 0.05 * low[i];
      let m = 0.95 + 0.07 * (prof - 0.5) * rm + 0.09 * grain + 0.05 * low[i];
      let r = base[0] * m, g = base[1] * m, b = base[2] * m;
      const sp = rnd();
      if (sp < 0.012) { r *= 0.55; g *= 0.55; b *= 0.6; } else if (sp > 0.975) { r *= 1.18; g *= 1.2; b *= 1.3; }
      const w = worley(shells, u, v);
      if (fract(w.id * 17.3) < 0.045) {
        const rad = 0.12 + 0.12 * fract(w.id * 3.1);
        if (w.f1 < rad) {
          const q = w.f1 / rad, pc = shellCol[(w.id * 71 | 0) % shellCol.length];
          const e = smooth(1, 0.8, q);
          r += (pc[0] - r) * e; g += (pc[1] - g) * e; b += (pc[2] - b) * e;
          hh = Math.max(hh, 0.55 + 0.25 * Math.sqrt(1 - q * q));
        }
      }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      h[i] = clamp01(hh); extra[i] = 0.92;
    }
  }
  normaliseMean(rgb, base);
  return { rgb, h, extra, strength: 2.5, ao: 1.0 };
}

function layerMud(S, rnd) {
  const px = S * S;
  const rgb = new Float32Array(px * 3), h = new Float32Array(px), extra = new Float32Array(px);
  const base = hexEff('#5f7852');
  const silt = hexEff('#62725a'), algae = hexEff('#4f7a44');
  const pal = ['#8e9580', '#7d8471', '#a3a08e', '#6f7466', '#978b78'].map(hexEff);
  const low = grid(field(501, 4, 3), 128, S), hi = grid(field(502, 64, 2), S), al = grid(field(503, 6, 3), 128, S);
  const peb = worleySet(504, 26), big = worleySet(505, 9);
  const sets = [[big, 0.25, 0.22, 0.34], [peb, 0.36, 0.2, 0.38]];
  for (let y = 0, i = 0; y < S; y++) {
    for (let x = 0; x < S; x++, i++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const m = 0.9 + 0.12 * low[i] + 0.06 * hi[i] + 0.05 * (rnd() - 0.5);
      let r = silt[0] * m, g = silt[1] * m, b = silt[2] * m;
      const ak = smooth(0.1, 0.45, al[i]) * 0.7;
      r += (algae[0] - r) * ak; g += (algae[1] - g) * ak; b += (algae[2] - b) * ak;
      let hh = 0.25 + 0.06 * low[i] + 0.04 * hi[i];
      for (let si = 0; si < 2; si++) {
        const ws = sets[si][0], prob = sets[si][1], r0 = sets[si][2], r1 = sets[si][3];
        const w = worley(ws, u, v);
        if (fract(w.id * 23.9) > prob || w.f1 > r1 * 1.15 * 1.35) continue;
        const rad = r0 + (r1 - r0) * fract(w.id * 9.7);
        const ang = Math.atan2(w.dy, w.dx), rr = rad * (1 + 0.15 * Math.sin(ang * 2 + w.id * 50));
        if (w.f1 < rr) {
          const q = w.f1 / rr, dome = Math.sqrt(1 - q * q), pc = mix3(pal[(w.id * 113 | 0) % pal.length], [r, g, b], 0.35);
          const sh = 0.75 + 0.35 * dome, e = smooth(1, 0.78, q);
          r += (pc[0] * sh - r) * e; g += (pc[1] * sh - g) * e; b += (pc[2] * sh - b) * e;
          hh = Math.max(hh, 0.45 + 0.4 * dome);
        } else if (w.f1 < rr * 1.35) { const k = 1 - (w.f1 - rr) / (rr * 0.35); r *= 1 - 0.3 * k; g *= 1 - 0.3 * k; b *= 1 - 0.3 * k; }
      }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      h[i] = clamp01(hh); extra[i] = 0.55;
    }
  }
  normaliseMean(rgb, base);
  return { rgb, h, extra, strength: 3, ao: 1.5 };
}

// Scale colours so the tile's mean equals the palette colour (keeps distance fades seamless).
function normaliseMean(rgb, target) {
  const n = rgb.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; }
  const kr = target[0] / (r / n), kg = target[1] / (g / n), kb = target[2] / (b / n);
  for (let i = 0; i < n; i++) { rgb[i * 3] *= kr; rgb[i * 3 + 1] *= kg; rgb[i * 3 + 2] *= kb; }
}

export function genGroundLayers(S = GROUND_SIZE) {
  const gens = [layerGrass, layerDirt, layerRock, layerSand, layerMud];
  const L = gens.length, px = S * S;
  const albedo = new Uint8Array(px * 4 * L), normal = new Uint8Array(px * 4 * L);
  gens.forEach((gen, l) => {
    const d = gen(S, mulberry32(9000 + l * 77));
    const blur = blurWrap(d.h, S, 5);
    const nrm = normalsFromHeight(d.h, S, d.strength);
    const o = px * 4 * l;
    for (let i = 0; i < px; i++) {
      const ao = Math.max(0.45, 1 - Math.max(0, blur[i] - d.h[i]) * d.ao * 2.2);
      const r = d.rgb[i * 3] * ao, g = d.rgb[i * 3 + 1] * ao, b = d.rgb[i * 3 + 2] * ao;
      const k = o + i * 4;
      if (l === 0) { albedo[k] = byte(r * 0.5); albedo[k + 1] = byte(g * 0.5); albedo[k + 2] = byte(b * 0.5); }
      else { albedo[k] = enc(r); albedo[k + 1] = enc(g); albedo[k + 2] = enc(b); }
      albedo[k + 3] = byte(d.h[i]);
      normal[k] = byte(nrm[i * 2] * 0.5 + 0.5); normal[k + 1] = byte(nrm[i * 2 + 1] * 0.5 + 0.5);
      normal[k + 2] = byte(d.extra[i]); normal[k + 3] = 255;
    }
  });
  return { size: S, layers: L, albedo, normal };
}

// ---- small multi-purpose noise texture (RGBA8, tileable) ------------------------------------
export function genNoise(S = 256) {
  const f = [field(601, 4, 4), field(602, 8, 3), field(603, 2, 3), field(604, 32, 2)];
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, k = (y * S + x) * 4;
    for (let c = 0; c < 4; c++) out[k + c] = byte(0.5 + 0.62 * f[c](u, v));
  }
  return { size: S, data: out };
}

// ============================================================================================
// Bark: array texture, 256x256 per layer, tileable. sRGB albedo + linear normal (rg) / gloss (b).
// ============================================================================================
export const BARK = { oak: 0, birch: 1, cherry: 2, pine: 3, jungle: 4, palm: 5, twig: 6, elder: 7 };
export const BARK_SIZE = 256;

function barkLayer(kind, S, rnd) {
  const px = S * S;
  const col = new Float32Array(px * 3), h = new Float32Array(px);
  const put = (i, c, k = 1) => { col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k; };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const f1 = grid(field(700 + kind * 10, 8, 3), 128, S), f2 = grid(field(701 + kind * 10, 16, 3), 128, S), f3 = grid(field(702 + kind * 10, 64, 2), S);
  if (kind === BARK.oak || kind === BARK.elder || kind === BARK.twig) {
    // vertical furrows: ridged noise stretched along v, broken by horizontal cracks
    const rid = field(703 + kind, 8, 3, 0.5, 2);
    const ridA = new Float32Array(px);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      ridA[y * S + x] = 1 - Math.abs(rid(u + f1[y * S + x] * 0.03, v));
    }
    const dk = hexLin(kind === BARK.twig ? '#6a5040' : '#3f3027'), md = hexLin(kind === BARK.twig ? '#8d7058' : '#6e5845'), lt = hexLin(kind === BARK.twig ? '#a8927a' : '#9a8a78');
    const moss = hexLin('#5f7f3a');
    for (let i = 0; i < px; i++) {
      const r = Math.pow(ridA[i], kind === BARK.twig ? 1.5 : 2.5);
      const t = clamp01(r * 1.1 + f3[i] * 0.12);
      let c = t < 0.5 ? lerp3(dk, md, t * 2) : lerp3(md, lt, (t - 0.5) * 2);
      if (kind === BARK.elder) { const mk = smooth(0.15, 0.45, f2[i]) * (1 - t) * 0.9; c = lerp3(c, moss, mk); }
      put(i, c, 0.9 + 0.2 * f2[i]);
      h[i] = 0.15 + 0.7 * r + 0.08 * f3[i];
    }
  } else if (kind === BARK.birch) {
    const white = hexLin('#ece6da'), cream = hexLin('#d9d0bf'), dark = hexLin('#2f2a27'), grey = hexLin('#a39a8e');
    for (let i = 0; i < px; i++) {
      const t = clamp01(0.55 + f1[i] * 0.6);
      put(i, lerp3(cream, white, t), 0.94 + 0.08 * f3[i]);
      h[i] = 0.55 + 0.05 * f3[i];
    }
    // horizontal lenticels (short dark dashes)
    for (let k = 0; k < 520; k++) {
      const x = rnd() * S, y = rnd() * S, len = 4 + rnd() * 16, w = 0.9 + rnd() * 1.4, dk = 0.35 + rnd() * 0.4;
      strokeWrap(S, x, y, x + len, y + (rnd() - 0.5) * 1.5, w, w * 0.7, (i, c) => {
        const k2 = c * dk; col[i * 3] *= 1 - k2 * 0.75; col[i * 3 + 1] *= 1 - k2 * 0.75; col[i * 3 + 2] *= 1 - k2 * 0.72; h[i] -= 0.2 * c;
      });
    }
    // dark rough patches
    const pat = grid(field(711, 6, 4), 128, S);
    for (let i = 0; i < px; i++) {
      const k = smooth(0.32, 0.46, pat[i] + f3[i] * 0.08);
      if (k > 0) { const c = lerp3(grey, dark, smooth(0.4, 0.6, pat[i])); col[i * 3] += (c[0] - col[i * 3]) * k; col[i * 3 + 1] += (c[1] - col[i * 3 + 1]) * k; col[i * 3 + 2] += (c[2] - col[i * 3 + 2]) * k; h[i] -= 0.25 * k - 0.1 * k * f3[i]; }
    }
  } else if (kind === BARK.cherry) {
    const base = hexLin('#5a3a33'), lt = hexLin('#7d5448'), dk = hexLin('#3a2622'), lent = hexLin('#b08a72');
    for (let i = 0; i < px; i++) {
      const t = clamp01(0.5 + f1[i] * 0.6 + f3[i] * 0.1);
      put(i, t < 0.5 ? lerp3(dk, base, t * 2) : lerp3(base, lt, (t - 0.5) * 2));
      h[i] = 0.5 + 0.1 * f3[i] + 0.1 * f1[i];
    }
    for (let k = 0; k < 420; k++) {
      const x = rnd() * S, y = rnd() * S, len = 5 + rnd() * 12, w = 1.2 + rnd() * 1.2;
      strokeWrap(S, x, y, x + len, y, w, w, (i, c) => {
        col[i * 3] += (lent[0] - col[i * 3]) * c * 0.8; col[i * 3 + 1] += (lent[1] - col[i * 3 + 1]) * c * 0.8; col[i * 3 + 2] += (lent[2] - col[i * 3 + 2]) * c * 0.8; h[i] += 0.12 * c;
      });
    }
  } else if (kind === BARK.pine) {
    const plate = hexLin('#6e5242'), plateLt = hexLin('#8d6b55'), fis = hexLin('#241a15'), rust = hexLin('#9a5f3e');
    const ws = worleySet(721, 6, 3);
    const wa = grid(field(722, 4, 3), 128, S), wb = grid(field(723, 4, 3), 128, S);
    for (let y = 0, i = 0; y < S; y++) for (let x = 0; x < S; x++, i++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const w = worley(ws, u + wa[i] * 0.08, v + wb[i] * 0.05);
      const e = w.f2 - w.f1;
      const pk = smooth(0.03, 0.16, e + f3[i] * 0.02);
      const flake = 0.5 + 0.5 * Math.sin((v * 40 + wa[i] * 3) * Math.PI * 2 / 4 + w.id * 20);
      let c = mix3(plate, plateLt, clamp01(fract(w.id * 7.7) * 0.7 + f3[i] * 0.25 + flake * 0.15));
      c = mix3(c, rust, smooth(0.2, 0.5, f2[i]) * 0.35);
      put(i, mix3(fis, c, pk), 0.92 + 0.12 * f2[i]);
      h[i] = 0.1 + 0.6 * pk + 0.08 * f3[i] + 0.12 * fract(w.id * 3.3) + 0.05 * flake * pk;
    }
  } else if (kind === BARK.jungle) {
    const base = hexLin('#8a7b66'), lt = hexLin('#a79a86'), dk = hexLin('#5e5244'), moss = hexLin('#5d8a3a');
    const st = grid(field(741, 16, 3, 0.5, 2), S);
    for (let y = 0, i = 0; y < S; y++) for (let x = 0; x < S; x++, i++) {
      const streak = st[i];
      const t = clamp01(0.5 + streak * 0.9 + f3[i] * 0.15);
      let c = t < 0.5 ? lerp3(dk, base, t * 2) : lerp3(base, lt, (t - 0.5) * 2);
      const mk = smooth(0.2, 0.5, f2[i]) * 0.85;
      c = lerp3(c, moss, mk);
      put(i, c);
      h[i] = 0.45 + 0.15 * t + 0.1 * f3[i] + 0.12 * mk;
    }
  } else if (kind === BARK.palm) {
    const base = hexLin('#8c7456'), dk = hexLin('#5e4a36'), lt = hexLin('#a8906e');
    const rings = 5;
    for (let y = 0, i = 0; y < S; y++) for (let x = 0; x < S; x++, i++) {
      const v = y / S, u = x / S;
      const s = fract(v * rings + f1[i] * 0.05 + Math.sin(u * Math.PI * 2 * 3) * 0.02);
      const ridge = smooth(0, 0.18, s) * smooth(1, 0.55, s);
      const fib = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 24 + f2[i] * 3);
      const t = clamp01(0.22 + ridge * 0.42 + fib * 0.28 + f3[i] * 0.2 + f2[i] * 0.15);
      put(i, t < 0.5 ? lerp3(dk, base, t * 2) : lerp3(base, lt, (t - 0.5) * 2));
      h[i] = 0.3 + 0.35 * ridge + 0.15 * fib + 0.05 * f3[i];
    }
  }
  return { col, h };
}

export function genBark(S = BARK_SIZE) {
  const L = 8, px = S * S;
  const albedo = new Uint8Array(px * 4 * L), normal = new Uint8Array(px * 4 * L);
  for (let l = 0; l < L; l++) {
    const d = barkLayer(l, S, mulberry32(7100 + l));
    const nrm = normalsFromHeight(d.h, S, l === BARK.birch ? 2 : l === BARK.palm ? 4 : 6);
    const blur = blurWrap(d.h, S, 3);
    const o = px * 4 * l;
    for (let i = 0; i < px; i++) {
      const ao = Math.max(0.5, 1 - Math.max(0, blur[i] - d.h[i]) * 3);
      const k = o + i * 4;
      albedo[k] = enc(d.col[i * 3] * ao); albedo[k + 1] = enc(d.col[i * 3 + 1] * ao); albedo[k + 2] = enc(d.col[i * 3 + 2] * ao); albedo[k + 3] = 255;
      normal[k] = byte(nrm[i * 2] * 0.5 + 0.5); normal[k + 1] = byte(nrm[i * 2 + 1] * 0.5 + 0.5); normal[k + 2] = 128; normal[k + 3] = 255;
    }
  }
  return { size: S, layers: L, albedo, normal };
}

// ============================================================================================
// Leaf atlas (1024^2, sRGB, alpha-tested). Cells are 256^2 (palm + fern 256x512). Clusters grow
// from the bottom-centre of their cell (v = v0) toward the top, so a card's attach point is v0.
// ============================================================================================
export const ATLAS_SIZE = 1024;
const C = 256;
export const LEAF_CELLS = {
  oak: [0, 0, 1, 1], oak2: [1, 0, 1, 1], birch: [2, 0, 1, 1], cherry: [3, 0, 1, 1],
  pine: [0, 1, 1, 1], fir: [1, 1, 1, 1], jungle: [2, 1, 1, 1], jungle2: [3, 1, 1, 1],
  palm: [0, 2, 1, 2], fern: [1, 2, 1, 2], bush: [2, 2, 1, 1], bushWhite: [3, 2, 1, 1],
  bushPink: [2, 3, 1, 1], bark: [3, 3, 1, 1],
};
// UV rectangle [u0, v0, u1, v1] with a half-texel inset.
export function cellUV(name) {
  const [cx, cy, w, h] = LEAF_CELLS[name];
  const e = 1.5 / ATLAS_SIZE;
  return [cx * C / ATLAS_SIZE + e, cy * C / ATLAS_SIZE + e, (cx + w) * C / ATLAS_SIZE - e, (cy + h) * C / ATLAS_SIZE - e];
}

class Painter {
  constructor(S) { this.S = S; this.rgb = new Float32Array(S * S * 3); this.a = new Float32Array(S * S); }
  setCell(name) { const [cx, cy, w, h] = LEAF_CELLS[name]; this.ox = cx * C; this.oy = cy * C; this.w = w * C; this.h = h * C; }
  fill(c) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = (this.oy + y) * this.S + this.ox + x;
      this.rgb[i * 3] = c[0]; this.rgb[i * 3 + 1] = c[1]; this.rgb[i * 3 + 2] = c[2]; this.a[i] = 0;
    }
  }
  over(x, y, c, cov, opaque = true) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || cov <= 0) return;
    const i = (this.oy + y) * this.S + this.ox + x;
    const a0 = this.a[i];
    this.rgb[i * 3] += (c[0] - this.rgb[i * 3]) * (a0 > 0 ? cov : 1);
    this.rgb[i * 3 + 1] += (c[1] - this.rgb[i * 3 + 1]) * (a0 > 0 ? cov : 1);
    this.rgb[i * 3 + 2] += (c[2] - this.rgb[i * 3 + 2]) * (a0 > 0 ? cov : 1);
    if (opaque) this.a[i] = a0 + cov * (1 - a0);
  }
  // Leaf: base (x, y), direction ang, length len, width wid; shape(t) in [0,1]; shade(t, s) -> colour.
  leaf(x0, y0, ang, len, wid, shape, shade) {
    const ax = Math.cos(ang), ay = Math.sin(ang);
    const hw0 = wid * 0.5 + 2, ex = Math.abs(ay) * hw0, ey = Math.abs(ax) * hw0;
    const x1 = x0 + ax * len, y1 = y0 + ay * len;
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - ex - 1)), maxx = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + ex + 1));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - ey - 1)), maxy = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + ey + 1));
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
      const u = dx * ax + dy * ay, v = -dx * ay + dy * ax;
      if (u < -1 || u > len + 1) continue;
      const t = clamp01(u / len);
      const hw = wid * 0.5 * shape(t);
      const cov = clamp01(hw - Math.abs(v) + 0.5) * clamp01(u + 0.5) * clamp01(len - u + 0.5);
      if (cov <= 0) continue;
      this.over(x, y, shade(t, hw > 0 ? v / hw : 0, u, v), cov);
    }
  }
  line(x0, y0, x1, y1, w0, w1, c) {
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - w0 - 1)), maxx = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + w0 + 1));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - w0 - 1)), maxy = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + w0 + 1));
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-6;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const t = clamp01((px * dx + py * dy) / l2);
      const ex = px - dx * t, ey = py - dy * t;
      const cov = clamp01((w0 + (w1 - w0) * t) * 0.5 - Math.sqrt(ex * ex + ey * ey) + 0.5);
      if (cov > 0) this.over(x, y, typeof c === 'function' ? c(t) : c, cov);
    }
  }
  disc(x0, y0, rad, c) { this.line(x0, y0, x0 + 0.01, y0, rad * 2, rad * 2, c); }
}

const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const SH = {
  oak: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.8) * (0.66 + 0.34 * Math.abs(Math.cos(t * Math.PI * 3.6))),
  ovate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.65)), 0.9) * (1 - 0.07 * (0.5 + 0.5 * Math.sin(t * 46))),
  lance: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.7),
  heart: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.55) * smooth(0, 0.06, t),
  pinna: (t) => Math.pow(Math.sin(Math.PI * t), 0.45),
  petal: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.55) * (t > 0.86 ? 0.75 + 0.25 * Math.abs(Math.cos((t - 0.86) * 20)) : 1),
  lobed: (t) => Math.pow(Math.sin(Math.PI * t), 0.6) * (0.72 + 0.28 * Math.abs(Math.sin(t * Math.PI * 6))),
};
// Standard leaf shading: darker base, lighter tip, pale midrib, folded halves, faint veins.
function leafShade(col, rnd, opts = {}) {
  const k = 0.8 + rnd() * 0.36, tint = rnd() - 0.5;
  const c = [col[0] * k * (1 + tint * 0.12), col[1] * k, col[2] * k * (1 - tint * 0.2)];
  const fold = opts.fold ?? 0.08, rib = opts.rib ?? 0.1, vein = opts.vein ?? 10;
  return (t, s, u) => {
    let m = 0.78 + 0.34 * t;
    m *= s > 0 ? 1 - fold : 1 + fold * 0.5;
    if (Math.abs(s) < rib) m *= 1.18;
    else if (vein > 0 && Math.sin((u - Math.abs(s) * 6) * vein * 0.1) > 0.9) m *= 1.07;
    m *= 1 - 0.18 * Math.abs(s) * Math.abs(s);
    return [Math.min(1, c[0] * m), Math.min(1, c[1] * m), Math.min(1, c[2] * m)];
  };
}

function twigs(p, rnd, x0, y0, len, spread, n, col, width = 3) {
  // A main twig plus n side twigs fanning out; returns attach points [{x, y, ang}] for leaves.
  const pts = [];
  const a0 = Math.PI / 2 + (rnd() - 0.5) * 0.2;
  const x1 = x0 + Math.cos(a0) * len, y1 = y0 + Math.sin(a0) * len;
  p.line(x0, y0, x1, y1, width, width * 0.4, col);
  for (let i = 0; i < 14; i++) { const t = 0.2 + (i / 13) * 0.8; pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, ang: a0, t }); }
  for (let k = 0; k < n; k++) {
    const t = 0.12 + (k / Math.max(1, n - 1)) * 0.72 + (rnd() - 0.5) * 0.08;
    const sx = x0 + (x1 - x0) * t, sy = y0 + (y1 - y0) * t;
    const side = k % 2 ? 1 : -1;
    const a = a0 + side * spread * (0.75 + rnd() * 0.45) * (1 - t * 0.35);
    const l = len * (0.55 + rnd() * 0.3) * (1 - t * 0.45);
    let ex = sx + Math.cos(a) * l, ey = sy + Math.sin(a) * l;
    ex = Math.min(p.w - 14, Math.max(14, ex)); ey = Math.min(p.h - 14, Math.max(8, ey));
    p.line(sx, sy, ex, ey, width * 0.7, width * 0.3, col);
    const ang = Math.atan2(ey - sy, ex - sx);
    for (let i = 0; i < 8; i++) { const tt = 0.25 + (i / 7) * 0.75; pts.push({ x: sx + (ex - sx) * tt, y: sy + (ey - sy) * tt, ang, t: tt }); }
  }
  return pts;
}

function placeLeaf(p, q, rnd, lenR, widR, spreadAng = 1) {
  const side = rnd() < 0.5 ? -1 : 1;
  const ang = q.ang + side * (0.3 + rnd() * 0.8) * spreadAng + (rnd() - 0.5) * 0.3;
  let len = lenR[0] + rnd() * (lenR[1] - lenR[0]);
  const wid = len * (widR[0] + rnd() * (widR[1] - widR[0]));
  for (let tries = 0; tries < 4; tries++) {
    const ex = q.x + Math.cos(ang) * (len + 3), ey = q.y + Math.sin(ang) * (len + 3), m = wid * 0.5 + 2;
    const inside = (x, y) => x > m && x < p.w - m && y > m && y < p.h - m;
    if (inside(ex, ey) && inside(q.x + Math.cos(ang) * len * 0.5, q.y + Math.sin(ang) * len * 0.5)) return { x: q.x, y: q.y, ang, len, wid: len * (wid / len) };
    len *= 0.72;
  }
  return null;
}

function paintBroadleaf(p, rnd, pal, shape, n, lenR, widR, twigCol, opts = {}) {
  p.fill(mul(pal[0], 0.9));
  const pts = twigs(p, rnd, p.w / 2 + (rnd() - 0.5) * 10, 2, p.h * (opts.twigLen ?? 0.66), opts.spread ?? 0.9, opts.sides ?? 5, twigCol, opts.twigW ?? 3);
  // back layer: darker leaves give the cluster depth
  for (const [count, dark] of [[Math.round(n * 0.45), 0.7], [n, 1]]) {
    for (let i = 0; i < count; i++) {
      const q = pts[Math.floor(rnd() * pts.length)];
      const l = placeLeaf(p, q, rnd, lenR, widR, opts.leafSpread ?? 1);
      if (!l) continue;
      const col = mul(pal[Math.floor(rnd() * pal.length)], dark);
      p.line(l.x, l.y, l.x + Math.cos(l.ang) * 4, l.y + Math.sin(l.ang) * 4, 1.6, 1.2, twigCol);
      p.leaf(l.x + Math.cos(l.ang) * 3, l.y + Math.sin(l.ang) * 3, l.ang, l.len, l.wid, shape, leafShade(col, rnd, opts));
    }
  }
}

// Dense, rounded leaf cluster (~60-70 % opaque): twigs fan from the bottom centre into an
// elliptical region, then three passes of leaves (dark core, mid, bright rim) pointing outward so
// a single card already reads as a leafy volume with depth.
function paintCluster(p, rnd, pal, shape, n, lenR, widR, twigCol, opts = {}) {
  p.fill(mul(pal[0], 0.85));
  const cx = p.w / 2, cy = p.h * (opts.cy ?? 0.55), rx = p.w * (opts.rx ?? 0.44), ry = p.h * (opts.ry ?? 0.42);
  twigs(p, rnd, cx + (rnd() - 0.5) * 8, 2, p.h * (opts.twigLen ?? 0.72), opts.spread ?? 1.0, opts.sides ?? 6, twigCol, opts.twigW ?? 3);
  const passes = [[0.4, 0.6, 0.78], [0.32, 0.8, 0.95], [0.28, 1.0, 1.02]];
  for (const [frac, bright, rs] of passes) {
    const cnt = Math.round(n * frac);
    for (let i = 0; i < cnt; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), bright > 0.95 ? 0.35 : 0.6) * rs;
      const x = cx + Math.cos(a) * rx * rr, y = cy + Math.sin(a) * ry * rr;
      const ang = Math.atan2(y - cy + ry * 0.3, x - cx) + (rnd() - 0.5) * 1.2;
      let len = lenR[0] + rnd() * (lenR[1] - lenR[0]);
      const wid = len * (widR[0] + rnd() * (widR[1] - widR[0]));
      let bx = 0, by = 0, ok = false;
      for (let tries = 0; tries < 4 && !ok; tries++) {
        bx = x - Math.cos(ang) * len * 0.45; by = y - Math.sin(ang) * len * 0.45;
        const tx = bx + Math.cos(ang) * (len + 2), ty = by + Math.sin(ang) * (len + 2), m = wid * 0.5 + 2;
        ok = tx > m && tx < p.w - m && ty > m && ty < p.h - m && bx > 2 && bx < p.w - 2 && by > 2 && by < p.h - 2;
        if (!ok) len *= 0.75;
      }
      if (!ok) continue;
      const col = mul(pal[Math.floor(rnd() * pal.length)], bright * (0.92 + rnd() * 0.16));
      p.line(bx, by, bx + Math.cos(ang) * 3, by + Math.sin(ang) * 3, 1.3, 1.0, twigCol);
      p.leaf(bx + Math.cos(ang) * 2, by + Math.sin(ang) * 2, ang, len, wid, shape, leafShade(col, rnd, opts));
    }
  }
}

function paintFlowers(p, rnd, n, petal, centre, size, area, spots = 5) {
  for (let i = 0; i < n; i++) {
    const x = area.x + rnd() * area.w, y = area.y + rnd() * area.h;
    const rot = rnd() * 6.28, s = size * (0.8 + rnd() * 0.4);
    for (let k = 0; k < spots; k++) {
      const a = rot + (k / spots) * Math.PI * 2;
      const pc = mix3(petal[0], petal[1], rnd());
      p.leaf(x, y, a, s, s * 0.95, SH.petal, (t) => mix3(mul(pc, 0.86), pc, Math.min(1, t * 1.4)));
    }
    p.disc(x, y, s * 0.28, centre);
  }
}

export function genLeafAtlas() {
  const S = ATLAS_SIZE;
  const p = new Painter(S);
  const rnd = mulberry32(31337);
  // The dense clusters use their own random streams; the shared stream is advanced exactly as the
  // previous painter did (on a dummy canvas) so every other cell keeps its current look.
  const dummy = { w: C, h: C, fill() {}, line() {}, leaf() {}, disc() {} };
  const cluster = (seed, pal, shape, n, lenR, widR, twig, opts, legacy) => {
    paintBroadleaf(dummy, rnd, ...legacy);
    paintCluster(p, mulberry32(seed), pal, shape, n, lenR, widR, twig, opts);
  };
  const X = hexSrgb;
  const bark = X('#5e4636');

  const oakPal = ['#6fa843', '#5b9639', '#86b84e', '#4f8a33', '#94c257'].map(X), oak2Pal = ['#76ad44', '#62a03e', '#8fbf52', '#548f36', '#9dc75a'].map(X);
  const birchPal = ['#9dcb58', '#8abd4c', '#b0d466', '#79ad44', '#bddb6e'].map(X);
  p.setCell('oak');
  cluster(701, oakPal, SH.oak, 112, [40, 62], [0.5, 0.62], bark, { sides: 6, rx: 0.47, ry: 0.45 },
    [oakPal, SH.oak, 40, [44, 68], [0.5, 0.62], bark, { sides: 6 }]);
  p.setCell('oak2');
  cluster(702, oak2Pal, SH.oak, 104, [44, 66], [0.52, 0.64], bark, { sides: 5, spread: 1.05, rx: 0.47, ry: 0.45 },
    [oak2Pal, SH.oak, 36, [48, 72], [0.52, 0.64], bark, { sides: 5, spread: 1.05 }]);
  p.setCell('birch');
  cluster(703, birchPal, SH.ovate, 235, [22, 34], [0.6, 0.72], X('#4a3a30'), { sides: 7, spread: 1.15, twigW: 2, twigLen: 0.74, cy: 0.52, rx: 0.46, ry: 0.46 },
    [birchPal, SH.ovate, 72, [24, 36], [0.6, 0.72], X('#4a3a30'), { sides: 7, spread: 1.15, twigW: 2, twigLen: 0.74 }]);
  // cherry blossom
  p.setCell('cherry');
  {
    p.fill(X('#f3bfd0'));
    const tw = X('#4e342e');
    const pts = twigs(p, rnd, p.w / 2, 2, p.h * 0.7, 1.0, 6, tw, 3.2);
    const leafPal = ['#8a9a4a', '#a0a85a', '#7a8c44'].map(X);
    for (let i = 0; i < 7; i++) {
      const q = pts[Math.floor(rnd() * pts.length)];
      const a = q.ang + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6);
      p.leaf(q.x, q.y, a, 22 + rnd() * 10, 13, SH.ovate, leafShade(leafPal[i % 3], rnd));
    }
    const petals = [[X('#f6b7cb'), X('#ffe3ec')], [X('#f7c4d4'), X('#fff1f5')], [X('#ec9dba'), X('#ffd6e4')]];
    for (let i = 0; i < 88; i++) {
      const q = pts[Math.floor(rnd() * pts.length)];
      const x = q.x + (rnd() - 0.5) * 40, y = q.y + (rnd() - 0.5) * 34;
      const pr = petals[Math.floor(rnd() * 3)];
      const s = 11 + rnd() * 5, rot = rnd() * 6.28;
      if (x < s + 2 || x > p.w - s - 2 || y < s + 2 || y > p.h - s - 2) continue;
      for (let k = 0; k < 5; k++) {
        const a = rot + (k / 5) * Math.PI * 2 + (rnd() - 0.5) * 0.2;
        p.leaf(x, y, a, s, s * 0.9, SH.petal, (t, sd) => mix3(mul(pr[0], 0.92), pr[1], Math.min(1, t * 1.25 + Math.abs(sd) * 0.1)));
      }
      p.disc(x, y, 2.6, X('#e0708f'));
      for (let k = 0; k < 6; k++) { const a = rnd() * 6.28; p.disc(x + Math.cos(a) * 3.2, y + Math.sin(a) * 3.2, 0.9, X('#f2cf6a')); }
    }
  }
  // pine: needle sprays along twigs
  const needles = (name, pal, needleLen, density, planar) => {
    p.setCell(name);
    p.fill(mul(pal[0], 0.9));
    const tw = X('#5a4030');
    const segs = [];
    const main = { x0: p.w / 2, y0: 2, x1: p.w / 2 + (rnd() - 0.5) * 16, y1: p.h - 18 };
    segs.push(main);
    const nside = planar ? 9 : 6;
    for (let k = 0; k < nside; k++) {
      const t = 0.12 + (k / nside) * 0.7;
      const sx = main.x0 + (main.x1 - main.x0) * t, sy = main.y0 + (main.y1 - main.y0) * t;
      const side = k % 2 ? 1 : -1;
      const a = Math.PI / 2 + side * (planar ? 1.0 + rnd() * 0.2 : 0.55 + rnd() * 0.3);
      const l = (planar ? 100 : 110) * (1 - t * 0.5) * (0.8 + rnd() * 0.3);
      segs.push({ x0: sx, y0: sy, x1: sx + Math.cos(a) * l, y1: sy + Math.sin(a) * l });
    }
    for (const s of segs) p.line(s.x0, s.y0, s.x1, s.y1, 2.6, 1.2, tw);
    for (const s of segs) {
      const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), a0 = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
      const n = Math.floor(L / density);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const x = s.x0 + (s.x1 - s.x0) * t, y = s.y0 + (s.y1 - s.y0) * t;
        for (const side of [-1, 1]) {
          const a = a0 + side * (planar ? 1.35 + (rnd() - 0.5) * 0.3 : 0.55 + rnd() * 0.5);
          const l = needleLen * (0.75 + rnd() * 0.4) * (1 - 0.45 * Math.max(0, t - 0.6) / 0.4);
          const c = pal[Math.floor(rnd() * pal.length)];
          const ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
          if (ex < 1 || ex > p.w - 2 || ey < 1 || ey > p.h - 2) continue;
          p.line(x, y, ex, ey, 1.5, 0.8, (tt) => mul(c, 0.75 + 0.45 * tt));
        }
      }
    }
  };
  needles('pine', ['#2f5e36', '#3a6d3f', '#46794a', '#2a5431', '#5a8a55'].map(X), 40, 1.6, false);
  needles('fir', ['#2c5a3a', '#35664a', '#417552', '#264f33', '#557f5c'].map(X), 21, 1.4, true);
  // jungle: big lanceolate leaves fanning from the base
  p.setCell('jungle');
  {
    p.fill(X('#3f8a36'));
    const pal = ['#3f8a36', '#347a2f', '#4f9a40', '#2f6e2c'].map(X);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const ang = Math.PI / 2 + ((i / (n - 1)) - 0.5) * 1.5 + (rnd() - 0.5) * 0.15;
      const len = 150 + rnd() * 60, wid = len * (0.3 + rnd() * 0.06);
      const x0 = p.w / 2 + (rnd() - 0.5) * 12, y0 = 4;
      p.line(x0, y0, x0 + Math.cos(ang) * 16, y0 + Math.sin(ang) * 16, 3.5, 2.5, X('#4d6b2e'));
      p.leaf(x0 + Math.cos(ang) * 14, y0 + Math.sin(ang) * 14, ang, Math.min(len, 230), wid, SH.lance, leafShade(pal[i % pal.length], rnd, { fold: 0.16, rib: 0.05, vein: 16 }));
    }
  }
  p.setCell('jungle2');
  {
    p.fill(X('#3b8534'));
    const pal = ['#3b8534', '#2f7430', '#4c963c'].map(X);
    for (let i = 0; i < 3; i++) {
      const ang = Math.PI / 2 + (i - 1) * 0.62 + (rnd() - 0.5) * 0.2;
      const len = 125 + rnd() * 40, wid = len * 0.78;
      const x0 = p.w / 2 + (i - 1) * 30, y0 = 6;
      p.line(p.w / 2, 2, x0 + Math.cos(ang) * 10, y0 + Math.sin(ang) * 10, 4, 3, X('#557a33'));
      const base = leafShade(pal[i], rnd, { fold: 0.14, rib: 0.04, vein: 12 });
      // splits in the blade (monstera-like)
      const splits = [0.3, 0.45, 0.6, 0.74].map((t) => t + (rnd() - 0.5) * 0.05);
      p.leaf(x0 + Math.cos(ang) * 8, y0 + Math.sin(ang) * 8, ang, len, wid, (t) => SH.heart(t), base);
      const ax = Math.cos(ang), ay = Math.sin(ang);
      for (const t of splits) for (const sd of [-1, 1]) {
        const bx = x0 + ax * (8 + len * t), by = y0 + ay * (8 + len * t);
        const hw = wid * 0.5 * SH.heart(t);
        const px0 = bx - ay * sd * hw * 0.35, py0 = by + ax * sd * hw * 0.35;
        const px1 = bx - ay * sd * (hw + 4) + ax * 8, py1 = by + ax * sd * (hw + 4) + ay * 8;
        cut(p, px0, py0, px1, py1, 2.2);
      }
    }
  }
  // palm frond (256 x 512)
  p.setCell('palm');
  {
    p.fill(X('#62a846'));
    const pal = ['#6fb24a', '#5da342', '#7fbe56', '#4f8f3a'].map(X);
    const pts = [];
    for (let i = 0; i <= 60; i++) { const t = i / 60; pts.push({ x: p.w / 2 + Math.sin(t * 2.2) * 10, y: 4 + t * (p.h - 12) }); }
    for (let i = 0; i < 60; i++) p.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 4.5 * (1 - i / 70), 4.5 * (1 - (i + 1) / 70), X('#9a9458'));
    for (let i = 3; i < 58; i++) {
      const t = i / 60, q = pts[i];
      const L = 112 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.65);
      for (const side of [-1, 1]) {
        const a = Math.PI / 2 + side * (1.0 + (rnd() - 0.5) * 0.12) - side * 0.15 * t;
        let len = L * (0.9 + rnd() * 0.2);
        const ex = q.x + Math.cos(a) * len;
        if (ex < 4) len *= (q.x - 4) / (q.x - ex);
        if (ex > p.w - 4) len *= (p.w - 4 - q.x) / (ex - q.x);
        p.leaf(q.x, q.y, a, len, 8.5, SH.pinna, leafShade(pal[Math.floor(rnd() * pal.length)], rnd, { rib: 0.18, vein: 0, fold: 0.18 }));
      }
    }
  }
  // fern frond (256 x 512)
  p.setCell('fern');
  {
    p.fill(X('#5da342'));
    const pal = ['#5da342', '#4f9238', '#6fb24e', '#467f33'].map(X);
    const pts = [];
    for (let i = 0; i <= 50; i++) { const t = i / 50; pts.push({ x: p.w / 2 + Math.sin(t * 3.1) * 6, y: 4 + t * (p.h - 10) }); }
    for (let i = 0; i < 50; i++) p.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 3 * (1 - i / 60), 3 * (1 - (i + 1) / 60), X('#557a33'));
    for (let i = 2; i < 49; i += 1) {
      const t = i / 50, q = pts[i];
      const L = 104 * Math.pow(Math.sin(Math.PI * (0.06 + 0.94 * t)), 0.75) * (1 - 0.25 * t);
      for (const side of [-1, 1]) {
        const a = Math.PI / 2 + side * (1.25 + (rnd() - 0.5) * 0.1) - side * 0.25 * t;
        let len = L * (0.92 + rnd() * 0.14);
        const ex = q.x + Math.cos(a) * len;
        if (ex < 3) len *= (q.x - 3) / (q.x - ex);
        if (ex > p.w - 3) len *= (p.w - 3 - q.x) / (ex - q.x);
        if (i % 2 === 0) p.leaf(q.x, q.y, a, len, 11, SH.lobed, leafShade(pal[Math.floor(rnd() * pal.length)], rnd, { rib: 0.12, vein: 0 }));
      }
    }
  }
  // bushes
  const bushPal = ['#65a042', '#4f8a36', '#8cc052', '#5a9a3c', '#77b04a'].map(X);
  const bushOpts = { sides: 7, spread: 1.25, twigW: 2.4, twigLen: 0.7 };
  p.setCell('bush');
  cluster(704, bushPal, SH.ovate, 240, [22, 34], [0.62, 0.78], X('#4a3a2c'), bushOpts, [bushPal, SH.ovate, 80, [24, 36], [0.62, 0.78], X('#4a3a2c'), bushOpts]);
  p.setCell('bushWhite');
  cluster(705, bushPal, SH.ovate, 215, [22, 32], [0.62, 0.78], X('#4a3a2c'), bushOpts, [bushPal, SH.ovate, 70, [24, 34], [0.62, 0.78], X('#4a3a2c'), bushOpts]);
  paintFlowers(p, rnd, 26, [X('#f4ede4'), X('#fffaf4')], X('#f2c94a'), 9, { x: 30, y: 44, w: 196, h: 186 });
  p.setCell('bushPink');
  cluster(706, bushPal, SH.ovate, 215, [22, 32], [0.62, 0.78], X('#4a3a2c'), bushOpts, [bushPal, SH.ovate, 70, [24, 34], [0.62, 0.78], X('#4a3a2c'), bushOpts]);
  paintFlowers(p, rnd, 26, [X('#ea7aa8'), X('#f8a9c8')], X('#ffe08a'), 9, { x: 30, y: 44, w: 196, h: 186 });
  // bark swatch for far trunks (tinted by vertex colour), fully opaque
  p.setCell('bark');
  {
    const f = field(811, 8, 3, 0.5, 2), g = field(812, 32, 2);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const u = x / p.w, v = y / p.h;
      const r = 1 - Math.abs(f(u, v));
      const k = 0.62 + 0.3 * r * r + 0.06 * g(u, v);
      const i = (p.oy + y) * S + p.ox + x;
      p.rgb[i * 3] = k * 0.8; p.rgb[i * 3 + 1] = k * 0.8; p.rgb[i * 3 + 2] = k * 0.8; p.a[i] = 1;
    }
  }
  return buildAtlasMips(p);
}

function cut(p, x0, y0, x1, y1, w) {
  const minx = Math.max(0, Math.floor(Math.min(x0, x1) - w - 1)), maxx = Math.min(p.w - 1, Math.ceil(Math.max(x0, x1) + w + 1));
  const miny = Math.max(0, Math.floor(Math.min(y0, y1) - w - 1)), maxy = Math.min(p.h - 1, Math.ceil(Math.max(y0, y1) + w + 1));
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-6;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const px = x + 0.5 - x0, py = y + 0.5 - y0;
    const t = clamp01((px * dx + py * dy) / l2);
    const d = Math.hypot(px - dx * t, py - dy * t);
    const k = clamp01(w * 0.5 - d + 0.5);
    if (k > 0) { const i = (p.oy + y) * p.S + p.ox + x; p.a[i] *= 1 - k; }
  }
}

// Mip chain with per-cell alpha-coverage preservation (so distant foliage keeps its density),
// alpha-weighted colour averaging in linear space.
function buildAtlasMips(p) {
  const S = p.S;
  let rgb = p.rgb, a = p.a, size = S;
  const levels = [];
  const pack = (rgb, a, n) => {
    const out = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      out[i * 4] = byte(rgb[i * 3]); out[i * 4 + 1] = byte(rgb[i * 3 + 1]); out[i * 4 + 2] = byte(rgb[i * 3 + 2]); out[i * 4 + 3] = byte(a[i]);
    }
    return out;
  };
  levels.push({ data: pack(rgb, a, size), width: size, height: size });
  const cells = Object.values(LEAF_CELLS);
  const coverage = (a, n, cell, k, scale) => {
    const [cx, cy, w, h] = cell, cs = C >> k;
    let hit = 0, tot = 0;
    for (let y = cy * cs; y < (cy + h) * cs; y++) for (let x = cx * cs; x < (cx + w) * cs; x++) { tot++; if (a[y * n + x] * scale >= 0.5) hit++; }
    return hit / tot;
  };
  const target = cells.map((cell) => coverage(a, S, cell, 0, 1));
  let k = 0;
  while (size > 1) {
    const n = size >> 1;
    const r2 = new Float32Array(n * n * 3), a2 = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, pr = 0, pg = 0, pb = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const q = (y * 2 + j) * size + x * 2 + i;
        const al = a[q];
        const lr = S2L[byte(rgb[q * 3])], lg = S2L[byte(rgb[q * 3 + 1])], lb = S2L[byte(rgb[q * 3 + 2])];
        sr += lr * al; sg += lg * al; sb += lb * al; sa += al; pr += lr; pg += lg; pb += lb;
      }
      const o = y * n + x;
      if (sa > 1e-4) { r2[o * 3] = l2s(sr / sa); r2[o * 3 + 1] = l2s(sg / sa); r2[o * 3 + 2] = l2s(sb / sa); }
      else { r2[o * 3] = l2s(pr / 4); r2[o * 3 + 1] = l2s(pg / 4); r2[o * 3 + 2] = l2s(pb / 4); }
      a2[o] = sa / 4;
    }
    k++;
    if ((C >> k) >= 4) {
      cells.forEach((cell, ci) => {
        if (target[ci] > 0.999) return;
        let lo = 0.5, hi = 4;
        for (let it = 0; it < 10; it++) { const mid = (lo + hi) / 2; if (coverage(a2, n, cell, k, mid) < target[ci]) lo = mid; else hi = mid; }
        const s = (lo + hi) / 2;
        const [cx, cy, w, h] = cell, cs = C >> k;
        for (let y = cy * cs; y < (cy + h) * cs; y++) for (let x = cx * cs; x < (cx + w) * cs; x++) a2[y * n + x] = Math.min(1, a2[y * n + x] * s);
      });
    }
    rgb = r2; a = a2; size = n;
    levels.push({ data: pack(rgb, a, size), width: size, height: size });
  }
  return { size: S, mipmaps: levels };
}

// ============================================================================================
// THREE wrappers (cached)
// ============================================================================================
let _ground, _bark, _leaf, _noise;

function arrayTex(data, S, L, srgb) {
  const t = new THREE.DataArrayTexture(data, S, S, L);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function groundTextures() {
  if (!_ground) {
    const d = genGroundLayers();
    _ground = { albedo: arrayTex(d.albedo, d.size, d.layers, false), normal: arrayTex(d.normal, d.size, d.layers, false) };
  }
  return _ground;
}

export function barkTextures() {
  if (!_bark) {
    const d = genBark();
    _bark = { albedo: arrayTex(d.albedo, d.size, d.layers, true), normal: arrayTex(d.normal, d.size, d.layers, false) };
    _bark.albedo.anisotropy = 4; _bark.normal.anisotropy = 4;
  }
  return _bark;
}

export function leafAtlas() {
  if (!_leaf) {
    const d = genLeafAtlas();
    const t = new THREE.DataTexture(d.mipmaps[0].data, d.size, d.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.mipmaps = d.mipmaps;
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false; t.anisotropy = 4;
    t.needsUpdate = true;
    _leaf = t;
  }
  return _leaf;
}

// CPU twin of textureLod(noiseTexture(), uv, 0.0): bilinear, repeat wrap, texel centres; 0..1.
let _noiseImg = null;
export function sampleNoise(u, v, out = [0, 0, 0, 0]) {
  const img = _noiseImg || (_noiseImg = noiseTexture().image), D = img.data, NS = img.width;
  const x = u * NS - 0.5, y = v * NS - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const X0 = ((x0 % NS) + NS) % NS, Y0 = ((y0 % NS) + NS) % NS, X1 = (X0 + 1) % NS, Y1 = (Y0 + 1) % NS;
  const a = (Y0 * NS + X0) * 4, b = (Y0 * NS + X1) * 4, c = (Y1 * NS + X0) * 4, d = (Y1 * NS + X1) * 4;
  for (let k = 0; k < 4; k++) {
    const t = D[a + k] + (D[b + k] - D[a + k]) * fx, t2 = D[c + k] + (D[d + k] - D[c + k]) * fx;
    out[k] = (t + (t2 - t) * fy) / 255;
  }
  return out;
}

export function noiseTexture() {
  if (!_noise) {
    const d = genNoise();
    const t = new THREE.DataTexture(d.data, d.size, d.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    _noise = t;
  }
  return _noise;
}
