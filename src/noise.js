// Seeded RNG + 2D simplex noise. Everything in the world is deterministic from one seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export function createNoise2D(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function (x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = (perm[ii + perm[jj]] & 7) * 2; t0 *= t0; n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2; t1 *= t1; n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2; t2 *= t2; n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
    return 70 * n;
  };
}

export function fbm(noise, x, y, octaves = 4) {
  let a = 1, f = 1, s = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * noise(x * f, y * f);
    norm += a; a *= 0.5; f *= 2.03;
  }
  return s / norm;
}

export function ridged(noise, x, y, octaves = 4) {
  let a = 1, f = 1, s = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const v = 1 - Math.abs(noise(x * f, y * f));
    s += a * v * v;
    norm += a; a *= 0.5; f *= 2.1;
  }
  return s / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smax(a, b, k) {
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
}
