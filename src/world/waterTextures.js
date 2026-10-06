import * as THREE from 'three';
import { mulberry32 } from '../noise.js';

// Procedural, perfectly tileable textures for the lake, generated once at load (no assets).
//  - ripple normals: FFT-synthesised wave spectrum -> slopes + slope variance (for glints / LEAN specular)
//  - foam + noise:   cellular foam lace, two smooth fbm fields, fine detail noise
//  - caustics:       photons refracted through a periodic wave surface and splatted onto a floor,
//                    three depths per colour channel for a faint rainbow fringe
// Pure generators return typed arrays (testable in node); the *Texture() wrappers build THREE textures.

// ---- tiny radix-2 complex FFT ------------------------------------------------------------------
function fft1d(re, im, n, off, stride, inverse) {
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = off + (i + k) * stride, b = a + half * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// In-place inverse 2D FFT (no 1/N^2 scaling; callers normalise).
export function ifft2d(re, im, N) {
  for (let y = 0; y < N; y++) fft1d(re, im, N, y * N, 1, true);
  for (let x = 0; x < N; x++) fft1d(re, im, N, x, N, true);
}

const freq = (i, N) => (i <= N / 2 ? i : i - N);

// Random complex spectrum H(k) for a periodic height field. amp(kx, ky, k) returns the amplitude.
function spectrum(N, seed, amp) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const hr = new Float64Array(N * N), hi = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    const ky = freq(j, N);
    for (let i = 0; i < N; i++) {
      const kx = freq(i, N);
      const k = Math.hypot(kx, ky);
      const a = k > 0 ? amp(kx, ky, k) : 0;
      if (a > 0) { hr[j * N + i] = a * gauss(); hi[j * N + i] = a * gauss(); }
    }
  }
  return { hr, hi };
}

// Real part of IFFT( H * factor(kx, ky) ), factor = (fr + i fi)
function synth(N, H, factor) {
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    const ky = freq(j, N);
    for (let i = 0; i < N; i++) {
      const kx = freq(i, N), o = j * N + i;
      const [fr, fi] = factor(kx, ky);
      re[o] = H.hr[o] * fr - H.hi[o] * fi;
      im[o] = H.hr[o] * fi + H.hi[o] * fr;
    }
  }
  ifft2d(re, im, N);
  return re;
}

// Height + analytic slopes (d/du, d/dv with u,v in tile units) of a periodic field.
export function periodicField(N, seed, amp) {
  const H = spectrum(N, seed, amp);
  const TAU = Math.PI * 2;
  const h = synth(N, H, () => [1, 0]);
  const dx = synth(N, H, (kx) => [0, TAU * kx]);
  const dy = synth(N, H, (kx, ky) => [0, TAU * ky]);
  return { h, dx, dy };
}

function normalise01(a) {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const out = new Float32Array(a.length);
  const s = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - lo) * s;
  return out;
}

// ---- ripple normals -----------------------------------------------------------------------------
// RGBA: slope u, slope v (unit rms), second moment |s|^2 (mip-averaged -> slope variance), height 0..1
export function rippleData(N = 256, seed = 71) {
  const windA = Math.atan2(0.45, 0.8);
  const { h, dx, dy } = periodicField(N, seed, (kx, ky, k) => {
    if (k < 3 || k > N * 0.19) return 0;
    const c = Math.cos(Math.atan2(ky, kx) - windA);
    const dir = 0.35 + 0.65 * c * c; // crests mostly across the wind
    const cut = Math.exp(-((k / (N * 0.16)) ** 4)); // soft high-frequency roll-off (no aliasing at mip 0)
    return Math.pow(k, -2.0) * dir * cut;
  });
  let ss = 0;
  for (let i = 0; i < N * N; i++) ss += dx[i] * dx[i] + dy[i] * dy[i];
  const rms = Math.sqrt(ss / (N * N * 2)) || 1;
  const hn = normalise01(h);
  const out = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const sx = dx[i] / rms, sy = dy[i] / rms;
    out[i * 4] = sx; out[i * 4 + 1] = sy; out[i * 4 + 2] = sx * sx + sy * sy; out[i * 4 + 3] = hn[i];
  }
  return out;
}

// ---- foam + noise -------------------------------------------------------------------------------
function worley(N, cells, seed) {
  const rnd = mulberry32(seed);
  const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) { px[i] = rnd(); py[i] = rnd(); }
  const f1 = new Float32Array(N * N), f2 = new Float32Array(N * N);
  const cs = N / cells;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const gx = (x + 0.5) / cs, gy = (y + 0.5) / cs;
      const cx = Math.floor(gx), cy = Math.floor(gy);
      let d1 = 1e9, d2 = 1e9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ix = cx + ox, iy = cy + oy;
          const wx = ((ix % cells) + cells) % cells, wy = ((iy % cells) + cells) % cells;
          const c = wy * cells + wx;
          const ddx = ix + px[c] - gx, ddy = iy + py[c] - gy;
          const d = ddx * ddx + ddy * ddy;
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
      }
      f1[y * N + x] = Math.sqrt(d1); f2[y * N + x] = Math.sqrt(d2);
    }
  }
  return { f1, f2 };
}

// RGBA 0..1: R foam lace (1 on bubble walls), G smooth fbm (large), B smooth fbm (other seed), A fine noise
export function foamData(N = 256, seed = 5) {
  const w1 = worley(N, 12, seed), w2 = worley(N, 26, seed + 1);
  const smoothAmp = (lo, hi, p) => (kx, ky, k) => (k >= lo && k <= hi ? Math.pow(k, -p) : 0);
  const g = normalise01(periodicField(N, seed + 2, smoothAmp(1, 24, 1.6)).h);
  const b = normalise01(periodicField(N, seed + 3, smoothAmp(1, 24, 1.6)).h);
  const a = normalise01(periodicField(N, seed + 4, smoothAmp(6, 60, 1.1)).h);
  const out = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const lace1 = 1 - Math.min(1, (w1.f2[i] - w1.f1[i]) / 0.16);
    const lace2 = 1 - Math.min(1, (w2.f2[i] - w2.f1[i]) / 0.2);
    const bubble = Math.min(1, w2.f1[i] * 1.6); // round holes
    const foam = Math.min(1, Math.max(lace1 * 0.85, lace2 * 0.7) + (1 - bubble) * 0.12);
    out[i * 4] = foam; out[i * 4 + 1] = g[i]; out[i * 4 + 2] = b[i]; out[i * 4 + 3] = a[i];
  }
  return out;
}

// ---- caustics -----------------------------------------------------------------------------------
// Photons fall straight down through a periodic wave surface, bend by (1 - 1/1.33) * slope and land
// on a floor `depth` below. Density of landed photons = caustic intensity (mean 1).
export function causticsData(N = 256, seed = 11, opts = {}) {
  const G = 256; // gradient grid
  const { dx, dy } = periodicField(G, seed, (kx, ky, k) => (k >= 2 && k <= 7.5 ? Math.pow(k, -1.2) * Math.exp(-((k / 6) ** 2)) : 0));
  let ss = 0;
  for (let i = 0; i < G * G; i++) ss += dx[i] * dx[i] + dy[i] * dy[i];
  const rms = Math.sqrt(ss / (G * G * 2)) || 1;
  const gx = new Float32Array(G * G), gy = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) { gx[i] = dx[i] / rms; gy[i] = dy[i] / rms; }
  const focus = opts.focus ?? 0.017; // landing offset per unit rms slope, in tile units (sets line sharpness)
  const spread = [1.0, 1.045, 1.09]; // blue bends a little more
  const SS = opts.supersample ?? 3;
  const P = G * SS;
  const acc = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N)];
  for (let py = 0; py < P; py++) {
    const v = (py + 0.5) / P;
    const fy = v * G - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    const r0 = ((y0 % G) + G) % G, r1 = (r0 + 1) % G;
    for (let px = 0; px < P; px++) {
      const u = (px + 0.5) / P;
      const fx = u * G - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const c0 = ((x0 % G) + G) % G, c1 = (c0 + 1) % G;
      const i00 = r0 * G + c0, i01 = r0 * G + c1, i10 = r1 * G + c0, i11 = r1 * G + c1;
      const sgx = (gx[i00] * (1 - tx) + gx[i01] * tx) * (1 - ty) + (gx[i10] * (1 - tx) + gx[i11] * tx) * ty;
      const sgy = (gy[i00] * (1 - tx) + gy[i01] * tx) * (1 - ty) + (gy[i10] * (1 - tx) + gy[i11] * tx) * ty;
      for (let c = 0; c < 3; c++) {
        const lx = (u - sgx * focus * spread[c]) * N - 0.5, ly = (v - sgy * focus * spread[c]) * N - 0.5;
        const ix = Math.floor(lx), iy = Math.floor(ly), wx = lx - ix, wy = ly - iy;
        const ax = ((ix % N) + N) % N, bx = (ax + 1) % N, ay = ((iy % N) + N) % N, by = (ay + 1) % N;
        const A = acc[c];
        A[ay * N + ax] += (1 - wx) * (1 - wy); A[ay * N + bx] += wx * (1 - wy);
        A[by * N + ax] += (1 - wx) * wy; A[by * N + bx] += wx * wy;
      }
    }
  }
  const mean = (P * P) / (N * N);
  const out = new Float32Array(N * N * 4);
  for (let c = 0; c < 3; c++) {
    const A = acc[c];
    // light 3x3 blur (tent) with wrap to hide photon noise
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const w = (ox === 0 ? 2 : 1) * (oy === 0 ? 2 : 1);
            s += w * A[((y + oy + N) % N) * N + ((x + ox + N) % N)];
          }
        }
        out[(y * N + x) * 4 + c] = s / 16 / mean;
      }
    }
  }
  for (let i = 0; i < N * N; i++) out[i * 4 + 3] = 1;
  return out;
}

// ---- THREE wrappers -----------------------------------------------------------------------------
// Ripple texels are stored linearly in RGBA8 so mip averaging stays exact (slopes and second moments
// average linearly): R,G = 0.5 + slope / 8, B = |slope|^2 / 24, A = height. Decode in GLSL with
// s = t.xy * 8.0 - 4.0 and m2 = t.z * 24.0 (slope variance = m2 - dot(s, s)).
export function encodeRipple(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 0.5 + data[i] / 8; out[i + 1] = 0.5 + data[i + 1] / 8; out[i + 2] = data[i + 2] / 24; out[i + 3] = data[i + 3];
  }
  return out;
}
function byteTexture(data, N, encode = (v) => v) {
  const b = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) b[i] = Math.max(0, Math.min(255, Math.round(encode(data[i]) * 255)));
  return new THREE.DataTexture(b, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
}
function tile(t, aniso = 1) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Caustic intensity (mean 1, peaks ~20) is stored as sqrt(I / CAUSTIC_RANGE): decode with t * t * CAUSTIC_RANGE.
export const CAUSTIC_RANGE = 9;

let _tex = null;
export function waterTextures() {
  if (_tex) return _tex;
  const N = 256;
  _tex = {
    ripple: tile(byteTexture(encodeRipple(rippleData(N)), N), 4),
    foam: tile(byteTexture(foamData(N), N), 4),
    caustics: tile(byteTexture(causticsData(N), N, (v) => Math.sqrt(Math.max(v, 0) / CAUSTIC_RANGE)), 1),
  };
  return _tex;
}
