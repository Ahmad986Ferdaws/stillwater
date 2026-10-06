import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm, ridged, clamp, lerp, smooth, smax } from '../noise.js';
import { groundTextures, noiseTexture, sampleNoise } from './textures.js';

// ---- World layout -------------------------------------------------------
export const WORLD = 1200;
export const HALF = WORLD / 2;
export const GRID = 384;
export const CELL = WORLD / GRID;
export const WATER = 0;
export const BOUND = 505; // walkable radius
export const LAKE = { x: -40, z: -60, r: 150 };
export const ISLAND = { x: 15, z: -95 };
export const PLATEAU = { x: -300, z: -250 };
export const JUNGLE_X = 190;

const rand = mulberry32(20260924);
const nA = createNoise2D(rand);
const nB = createNoise2D(rand);
const nC = createNoise2D(rand);
const nD = createNoise2D(rand);
const nE = createNoise2D(rand);
export const detailNoise = nE;

const hill = (x, z, cx, cz, rad, h) => {
  const t = clamp(1 - Math.hypot(x - cx, z - cz) / rad, 0, 1);
  return h * t * t * (3 - 2 * t);
};

export function biome(x, z) {
  const wx = x + nD(x * 0.004, z * 0.004) * 60;
  const wz = z + nD(x * 0.004 + 50, z * 0.004) * 60;
  const jungle = smooth(JUNGLE_X - 60, JUNGLE_X + 60, wx);
  const dF = Math.hypot(wx - PLATEAU.x, wz - PLATEAU.z);
  const forest = (1 - smooth(150, 280, dF)) * (1 - jungle);
  const r = Math.hypot(x, z);
  const mountain = smooth(440, 540, r + nD(x * 0.01, z * 0.01) * 25);
  return { jungle, forest, mountain, meadow: (1 - jungle) * (1 - forest) * (1 - mountain) };
}

function rawHeight(x, z) {
  const b = biome(x, z);
  let h = 3.5 + fbm(nA, x * 0.0035, z * 0.0035, 4) * 8 + fbm(nB, x * 0.018, z * 0.018, 3) * 1.6;
  h += b.jungle * (fbm(nC, x * 0.012, z * 0.012, 3) * 4 + 2);

  const dP = Math.hypot(x - PLATEAU.x, z - PLATEAU.z) + nC(x * 0.02, z * 0.02) * 12;
  h += (1 - smooth(70, 125, dP)) * 20;
  h += hill(x, z, -250, 210, 75, 13);
  h += hill(x, z, 200, -260, 70, 16);

  // Cliff along the lake's north shore (Whisper Falls pours off it)
  const cliffZ = LAKE.z - LAKE.r - 18;
  const along = 1 - smooth(70, 120, Math.abs(x - LAKE.x));
  h += smooth(cliffZ + 2, cliffZ - 12, z + nB(x * 0.03, 0.5) * 3) * along * 20;

  const m = b.mountain;
  h += m * m * (55 + ridged(nB, x * 0.006, z * 0.006, 4) * 70);

  h = smax(h, 1.3, 2.0);

  const dl = Math.hypot(x - LAKE.x, z - LAKE.z) + nA(x * 0.008 + 10, z * 0.008) * 28;
  const depth = clamp((LAKE.r - dl) / LAKE.r, 0, 1);
  const bottom = -1.2 - 7.5 * Math.sqrt(depth);
  h = lerp(h, bottom, smooth(LAKE.r + 22, LAKE.r - 4, dl));

  const di = Math.hypot(x - ISLAND.x, z - ISLAND.z);
  h = smax(h, 2.6 - (di / 14) ** 2 * 3.2, 1.5);
  return h;
}

// ---- Height grid ---------------------------------------------------------
const N = GRID + 1;
export const heights = new Float32Array(N * N);

// Exact height on the rendered triangle mesh (same split as the index buffer).
export function heightAt(x, z) {
  let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  gx = clamp(gx, 0, GRID - 0.0001); gz = clamp(gz, 0, GRID - 0.0001);
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const a = heights[iz * N + ix], b = heights[iz * N + ix + 1];
  const c = heights[(iz + 1) * N + ix], d = heights[(iz + 1) * N + ix + 1];
  if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}

export function slopeAt(x, z) {
  const e = CELL;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = CELL;
  out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e));
  return out.normalize();
}

// ---- Path network --------------------------------------------------------
export const layout = { spawn: null, spawnYaw: 0, dock: null, falls: null, path: [], landmarks: [] };
let segs = [];

export function pathDist(x, z) {
  let best = 1e9;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const px = x - s[0], pz = z - s[1];
    const t = clamp((px * s[4] + pz * s[5]) * s[6], 0, 1);
    const dx = px - s[4] * t, dz = pz - s[5] * t;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function setPath(polylines) {
  segs = [];
  for (const line of polylines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const dx = bx - ax, dz = bz - az;
      segs.push([ax, az, bx, bz, dx, dz, 1 / (dx * dx + dz * dz)]);
    }
  }
}

function march(ox, oz, dx, dz, test, step = 0.5, max = 400) {
  for (let s = 0; s < max; s += step) {
    const x = ox + dx * s, z = oz + dz * s;
    if (test(heightAt(x, z), x, z)) return { x, z, s };
  }
  return null;
}

function computeLayout() {
  // Spawn + dock on the south shore
  let d = new THREE.Vector2(0.18, 1).normalize();
  const shore = march(LAKE.x, LAKE.z, d.x, d.y, (h) => h > 0.9);
  layout.dock = { x: shore.x, z: shore.z, dirX: -d.x, dirZ: -d.y, angle: Math.atan2(-d.x, -d.y) };
  const sp = { x: shore.x + d.x * 24 + 6, z: shore.z + d.y * 24 };
  layout.spawn = sp;
  layout.spawnYaw = Math.atan2(LAKE.x - sp.x, LAKE.z - sp.z);

  // Waterfall down the north cliff
  const north = march(LAKE.x + 8, LAKE.z, 0, -1, (h) => h > 0.05, 0.25);
  if (north) {
    let top = null;
    for (let s = 0; s < 60; s += 0.5) {
      const z = north.z - s;
      if (heightAt(north.x, z) > 9 && heightAt(north.x, z - 2) - heightAt(north.x, z) < 0.25) { top = { x: north.x, z }; break; }
    }
    if (top) layout.falls = { x: north.x, topZ: top.z + 1.0, baseZ: north.z + 3, topY: heightAt(top.x, top.z) };
  }

  const S = [sp.x, sp.z];
  const F = layout.falls ? [layout.falls.x, layout.falls.topZ - 10] : [LAKE.x, -250];
  const W = [-250, 210], C = [140, 250], G = [330, 40], B = [200, -260], R = [PLATEAU.x, PLATEAU.z];
  const loop = [W, [-140, 170], S, [60, 175], C, [240, 160], [G[0] - 14, G[1] + 16], [265, -110], B, [80, -268], F, [-170, -270], R, [-360, -60], [-335, 95], W];
  const dockEnd = [shore.x + d.x * 3, shore.z + d.y * 3];
  layout.path = [loop, [S, dockEnd]];
  setPath(layout.path);

  layout.landmarks = [
    { id: 'dock', name: 'The Old Dock', x: shore.x - d.x * 8, z: shore.z - d.y * 8, r: 20, clear: 10 },
    { id: 'isle', name: 'Blossom Isle', x: ISLAND.x, z: ISLAND.z, r: 22, clear: 9 },
    { id: 'falls', name: 'Whisper Falls', x: F[0], z: F[1] + 16, r: 30, clear: 12 },
    { id: 'ruins', name: 'Sunstone Arch', x: R[0], z: R[1], r: 30, clear: 18 },
    { id: 'tree', name: 'Grandmother Tree', x: G[0], z: G[1], r: 34, clear: 20 },
    { id: 'stones', name: 'The Standing Stones', x: C[0], z: C[1], r: 26, clear: 16 },
    { id: 'windmill', name: 'Windmill Hill', x: W[0], z: W[1], r: 28, clear: 14 },
    { id: 'bench', name: 'The Quiet Bench', x: B[0], z: B[1], r: 20, clear: 8 },
  ];
}

// ---- Textures + mesh -----------------------------------------------------
const C = (hex) => new THREE.Color(hex);
const COL = {
  meadowA: C('#7fb44a'), meadowB: C('#a6c957'),
  forest: C('#5c9644'), jungleA: C('#3d8436'), jungleB: C('#56a043'),
  sand: C('#ddcb97'), wetSand: C('#b9a878'), lakeBed: C('#5f7852'),
  rock: C('#aca79a'), rockDark: C('#8f8a7f'), snow: C('#f1f3f6'),
  path: C('#d6c296'), pathEdge: C('#b8ad74'),
};

// dataTexture: float RGBA per grid vertex (height, grass density, grass height, flower density).
// normalTexture: RGBA8 per grid vertex (smooth normal xyz, meadow weight) for grass lighting.
// colorTexture / grassTexture: 1024^2 macro colour maps. splatTexture: 1024^2 RGBA8 ground-material
// weights (r = sand incl. lake bed, g = path, b = rock, a = path edge factor); grass is the rest.
// grassTexture alpha = meadow weight (for meadow-only effects in the ground + grass shaders).
// canopyTexture: 1024^2 RGBA8 tree-crown shade over the world (r broadleaf, g conifer), built by
// vegetation.js via setCanopyTexture(); used for shade/leaf litter on the ground, grass and clutter.
// The large meadow colour patches (meadowTint) are baked into colorTexture + grassTexture, so the
// ground, the blades and the clutter all agree without extra texture reads.
export let dataTexture, colorTexture, grassTexture, normalTexture, splatTexture;
export let canopyTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
canopyTexture.needsUpdate = true;
export function setCanopyTexture(t) {
  canopyTexture = t;
  if (groundUniforms) groundUniforms.uTrnCanopy.value = t;
}

// Large meadow colour patches (sun-warmed yellow-green, deep lush green, cool blue-green):
// colour' = colour * m + a (linear), from two samples of the shared noise texture (bilinear, repeat).
function meadowTinter() {
  const n1 = [0, 0, 0, 0], n2 = [0, 0, 0, 0];
  const sst = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const W = [1.08, 1.04, 0.8], L = [0.74, 0.9, 0.84], Cc = [0.9, 0.97, 1.12], A = [0.024, 0.02, 0];
  const out = { m: [1, 1, 1], a: [0, 0, 0] };
  return (x, z, meadow) => {
    sampleNoise(x * 0.0043 + 0.37, z * 0.0043 + 0.61, n1);
    sampleNoise(x * 0.019 + 0.13, z * 0.019 + 0.77, n2);
    const warm = sst(0.5, 0.76, n1[0] * 0.65 + n2[1] * 0.35) * (0.3 + 0.7 * meadow);
    const lush = sst(0.5, 0.78, n1[1] * 0.6 + n2[0] * 0.4) * (1 - warm);
    const cool = sst(0.54, 0.78, n1[2] * 0.7 + n2[2] * 0.3) * (1 - warm) * 0.7;
    for (let k = 0; k < 3; k++) {
      let v = 1 + (W[k] - 1) * warm;
      v += (L[k] - v) * lush * 0.8;
      v += (Cc[k] - v) * cool;
      out.m[k] = v; out.a[k] = A[k] * warm;
    }
    return out;
  };
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LIN8 = new Float32Array(256).map((_, i) => toLin(i / 255));
const SRGB12 = new Uint8Array(4097).map((_, i) => Math.round(toSrgb(i / 4096) * 255));
// Byte of an sRGB texture that stores v (0..1): the GPU decodes it to LIN8[byte]; tint that by
// weight w and re-encode (lookup tables keep the 1024^2 bake fast).
const tintByte = (v, m, a, w) => {
  const b = v >= 1 ? 255 : v <= 0 ? 0 : Math.floor(v * 255);
  if (w <= 0) return b;
  const l = LIN8[b], t = l + (l * m + a - l) * w;
  return SRGB12[t >= 1 ? 4096 : t <= 0 ? 0 : Math.round(t * 4096)];
};

export async function buildTerrain(onStep) {
  for (let iz = 0; iz < N; iz++) {
    const z = -HALF + iz * CELL;
    for (let ix = 0; ix < N; ix++) heights[iz * N + ix] = rawHeight(-HALF + ix * CELL, z);
  }
  // Level the ground under built landmarks so floors and stones sit flush.
  for (const [cx, cz, r] of [[PLATEAU.x, PLATEAU.z, 11], [140, 250, 12], [-250, 210, 5], [200, -260, 4]]) {
    const hc = heights[Math.round((cz + HALF) / CELL) * N + Math.round((cx + HALF) / CELL)];
    for (let iz = 0; iz < N; iz++) {
      const z = -HALF + iz * CELL;
      if (Math.abs(z - cz) > r + 12) continue;
      for (let ix = 0; ix < N; ix++) {
        const x = -HALF + ix * CELL;
        const d = Math.hypot(x - cx, z - cz);
        if (d > r + 12) continue;
        const i = iz * N + ix;
        heights[i] = lerp(heights[i], hc, smooth(r + 12, r, d));
      }
    }
  }
  computeLayout();
  await onStep('Painting the meadow…');

  // Data texture at grid resolution: height, grass density, grass height, flower density
  const data = new Float32Array(N * N * 4);
  const aux = new Uint8Array(N * N * 4);
  const nrm = new THREE.Vector3();
  const clearings = layout.landmarks;
  for (let iz = 0; iz < N; iz++) {
    const z = -HALF + iz * CELL;
    for (let ix = 0; ix < N; ix++) {
      const x = -HALF + ix * CELL;
      const i = (iz * N + ix) * 4;
      const h = heights[iz * N + ix];
      const b = biome(x, z);
      const sl = slopeAt(x, z);
      const pd = pathDist(x, z);
      let dens = smooth(1.5, 2.4, h) * (1 - smooth(0.55, 0.85, sl)) * smooth(1.2, 2.6, pd);
      dens *= 1 - smooth(0.25, 0.75, b.mountain);
      dens *= 0.62 + 0.38 * smooth(-0.5, 0.3, nC(x * 0.03, z * 0.03));
      for (const l of clearings) {
        if (l.id === 'stones' || l.id === 'ruins') {
          const dd = Math.hypot(x - l.x, z - l.z);
          dens *= 0.55 + 0.45 * smooth(l.clear * 0.3, l.clear, dd);
        }
      }
      const gh = (0.95 * b.meadow + 1.1 * b.jungle + 0.75 * b.forest + 0.5 * b.mountain) * (0.8 + 0.4 * (nB(x * 0.05, z * 0.05) * 0.5 + 0.5));
      const fl = smooth(0.15, 0.55, nD(x * 0.012 + 7, z * 0.012)) * b.meadow * dens;
      data[i] = h; data[i + 1] = dens; data[i + 2] = gh; data[i + 3] = fl;
      normalAt(x, z, nrm);
      aux[i] = (nrm.x * 0.5 + 0.5) * 255; aux[i + 1] = (nrm.y * 0.5 + 0.5) * 255; aux[i + 2] = (nrm.z * 0.5 + 0.5) * 255;
      aux[i + 3] = b.meadow * 255;
    }
  }
  dataTexture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  dataTexture.minFilter = dataTexture.magFilter = THREE.NearestFilter;
  dataTexture.needsUpdate = true;
  normalTexture = new THREE.DataTexture(aux, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  normalTexture.minFilter = normalTexture.magFilter = THREE.LinearFilter;
  normalTexture.needsUpdate = true;
  await onStep('Mixing the colours…');

  // Color map (sRGB)
  const S = 1024;
  const px = new Uint8Array(S * S * 4);
  const gpx = new Uint8Array(S * S * 4);
  const spx = new Uint8Array(S * S * 4);
  const tmp = new THREE.Color();
  const tmp2 = new THREE.Color();
  const meadowTint = meadowTinter();
  const tintRow = new Float32Array((S >> 1) * 6), tintAt = { m: [1, 1, 1], a: [0, 0, 0] };
  for (let py = 0; py < S; py++) {
    const z = -HALF + ((py + 0.5) / S) * WORLD;
    for (let pxi = 0; pxi < S; pxi++) {
      const x = -HALF + ((pxi + 0.5) / S) * WORLD;
      const h = heightAt(x, z);
      const b = biome(x, z);
      const sl = slopeAt(x, z);
      const n1 = nE(x * 0.02, z * 0.02) * 0.5 + 0.5;
      const n2 = nE(x * 0.11 + 30, z * 0.11) * 0.5 + 0.5;
      tmp.copy(COL.meadowA).lerp(COL.meadowB, n1 * 0.8 + n2 * 0.2);
      tmp.lerp(COL.forest, b.forest);
      tmp2.copy(COL.jungleA).lerp(COL.jungleB, n1);
      tmp.lerp(tmp2, b.jungle);
      // (the tint varies over metres: evaluated on every second texel/row, reused for 2 x 2)
      const tc = (pxi >> 1) * 6;
      if (!(py & 1) && !(pxi & 1)) {
        const t = meadowTint(x, z, b.meadow);
        tintRow[tc] = t.m[0]; tintRow[tc + 1] = t.m[1]; tintRow[tc + 2] = t.m[2];
        tintRow[tc + 3] = t.a[0]; tintRow[tc + 4] = t.a[1]; tintRow[tc + 5] = t.a[2];
      }
      const tint = tintAt; tint.m[0] = tintRow[tc]; tint.m[1] = tintRow[tc + 1]; tint.m[2] = tintRow[tc + 2];
      tint.a[0] = tintRow[tc + 3]; tint.a[1] = tintRow[tc + 4]; tint.a[2] = tintRow[tc + 5];
      {
        const o = (py * S + pxi) * 4;
        gpx[o] = tintByte(tmp.r, tint.m[0], tint.a[0], 1); gpx[o + 1] = tintByte(tmp.g, tint.m[1], tint.a[1], 1); gpx[o + 2] = tintByte(tmp.b, tint.m[2], tint.a[2], 1);
        gpx[o + 3] = b.meadow * 255;
      }
      // shore sand
      const sandT = 1 - smooth(1.4, 2.3, h + n2 * 0.5);
      tmp.lerp(COL.sand, sandT);
      if (h < 0.4) tmp.lerp(COL.wetSand, smooth(0.4, -0.4, h));
      if (h < -0.5) tmp.lerp(COL.lakeBed, smooth(-0.5, -4, h));
      // rock on steep slopes / mountains
      const rockT = Math.max(smooth(0.6, 0.95, sl + n2 * 0.1), smooth(0.35, 0.8, b.mountain) * smooth(20, 55, h) * smooth(0.25, 0.55, sl + n1 * 0.2));
      tmp2.copy(COL.rock).lerp(COL.rockDark, n2);
      tmp.lerp(tmp2, rockT);
      tmp.lerp(COL.snow, smooth(92, 100, h + n1 * 8) * smooth(0.5, 0.2, sl));
      // path
      const pd = pathDist(x, z) + (n2 - 0.5) * 0.9;
      tmp2.copy(COL.path).lerp(COL.pathEdge, smooth(0.8, 1.7, pd));
      const pathT = 1 - smooth(1.4, 2.1, pd);
      tmp.lerp(tmp2, pathT);
      {
        const o = (py * S + pxi) * 4;
        spx[o] = sandT * (1 - rockT) * (1 - pathT) * 255;
        spx[o + 1] = pathT * 255;
        spx[o + 2] = rockT * (1 - pathT) * 255;
        spx[o + 3] = smooth(0.8, 1.7, pd) * 255;
      }
      // subtle mottling; meadow patches where grass shows (same weight as the ground shader's)
      const m = 0.92 + 0.16 * n2;
      const o = (py * S + pxi) * 4;
      const wG = Math.max(1 - spx[o] / 255 - spx[o + 1] / 255 - spx[o + 2] / 255, 0);
      px[o] = tintByte(tmp.r * m, tint.m[0], tint.a[0], wG);
      px[o + 1] = tintByte(tmp.g * m, tint.m[1], tint.a[1], wG);
      px[o + 2] = tintByte(tmp.b * m, tint.m[2], tint.a[2], wG);
      px[o + 3] = 255;
    }
  }
  colorTexture = new THREE.DataTexture(px, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  colorTexture.generateMipmaps = true;
  colorTexture.minFilter = THREE.LinearMipmapLinearFilter;
  colorTexture.magFilter = THREE.LinearFilter;
  colorTexture.anisotropy = 8;
  colorTexture.needsUpdate = true;
  grassTexture = new THREE.DataTexture(gpx, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  grassTexture.colorSpace = THREE.SRGBColorSpace;
  grassTexture.generateMipmaps = true;
  grassTexture.minFilter = THREE.LinearMipmapLinearFilter;
  grassTexture.magFilter = THREE.LinearFilter;
  grassTexture.needsUpdate = true;
  splatTexture = new THREE.DataTexture(spx, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  splatTexture.generateMipmaps = true;
  splatTexture.minFilter = THREE.LinearMipmapLinearFilter;
  splatTexture.magFilter = THREE.LinearFilter;
  splatTexture.needsUpdate = true;
  await onStep('Raising the hills…');

  // Mesh
  const pos = new Float32Array(N * N * 3);
  const uv = new Float32Array(N * N * 2);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      pos[i * 3] = -HALF + ix * CELL;
      pos[i * 3 + 1] = heights[i];
      pos[i * 3 + 2] = -HALF + iz * CELL;
      uv[i * 2] = ix / GRID;
      uv[i * 2 + 1] = iz / GRID;
    }
  }
  const idx = new Uint32Array(GRID * GRID * 6);
  let k = 0;
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const a = iz * N + ix, b = a + 1, c = a + N, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, terrainMaterial());
  mesh.receiveShadow = true;
  return mesh;
}

// ---- Ground material ------------------------------------------------------------------------
// MeshStandardMaterial (macro colour map) + detail: five tileable layers (grass-soil, dirt path,
// rock, sand, lake-bed) splatted from splatTexture with height-aware blending, two rotated scales
// against tiling, triplanar rock on steep ground, detail normals and roughness. The detail fades
// back to the macro colour map with distance; its brightness is matched to the macro map so the
// fade is invisible. Only standard chunks are extended (nothing removed), so other patches can
// wrap onBeforeCompile (call the previous one first).
const TRN_PARS = /* glsl */ `
varying vec3 vTrnW;
varying vec3 vTrnN;
uniform sampler2D uTrnSplat;
uniform sampler2D uTrnGrass;
uniform sampler2D uTrnNoise;
uniform highp sampler2DArray uTrnAlb;
uniform highp sampler2DArray uTrnNrm;
uniform vec3 uTrnPath, uTrnPathEdgeK, uTrnRock, uTrnRockDarkK, uTrnSand, uTrnWetK, uTrnMud, uTrnSoil, uTrnSnow;
uniform vec2 uTrnFade;
uniform sampler2D uTrnCanopy;
uniform vec2 uTrnFill;
uniform float uTrnQ;
vec3 trnDecode(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
float trnLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 trnTN(vec4 n) { vec2 t = n.rg * 2.0 - 1.0; return vec3(t, sqrt(max(1.0 - dot(t, t), 0.0))); }
const mat2 TRN_ROT = mat2(0.8, 0.6, -0.6, 0.8);
// Two differently scaled and rotated samples of one layer blended by a noise mask (anti-tiling).
vec4 trnAlb2(float layer, vec2 xz, vec2 dx, vec2 dy, float s1, float s2, float ab) {
  vec4 a = textureGrad(uTrnAlb, vec3(xz * s1, layer), dx * s1, dy * s1);
  vec4 b = textureGrad(uTrnAlb, vec3(TRN_ROT * xz * s2 + 0.37, layer), TRN_ROT * dx * s2, TRN_ROT * dy * s2);
  return mix(a, b, ab);
}
// Same for the normal layer; returns the world-xz perturbation (rotated sample rotated back).
vec2 trnNrm2(float layer, vec2 xz, vec2 dx, vec2 dy, float s1, float s2, float ab, out float extra) {
  vec4 a = textureGrad(uTrnNrm, vec3(xz * s1, layer), dx * s1, dy * s1);
  vec4 b = textureGrad(uTrnNrm, vec3(TRN_ROT * xz * s2 + 0.37, layer), TRN_ROT * dx * s2, TRN_ROT * dy * s2);
  extra = mix(a.b, b.b, ab);
  return mix(a.rg * 2.0 - 1.0, (b.rg * 2.0 - 1.0) * TRN_ROT, ab);
}
`;

const TRN_ALBEDO = /* glsl */ `
vec3 trnNW = normalize(vTrnN);
float trnK = 1.0 - smoothstep(uTrnFade.x, uTrnFade.y, length(vTrnW - cameraPosition));
float trnRough = 0.95;
vec3 trnDX = dFdx(vTrnW), trnDY = dFdy(vTrnW);
vec2 trnUvDX = dFdx(vMapUv), trnUvDY = dFdy(vMapUv);
// shared by near + far: ground weights, grass colour (alpha = meadow), crown shade, meadow patches
vec4 trnSp = texture(uTrnSplat, vMapUv);
vec4 trnGc = texture(uTrnGrass, vMapUv);
vec2 trnCan = uTrnQ > 0.5 ? texture(uTrnCanopy, vMapUv).rg : vec2(0.0);
float trnWG = max(1.0 - trnSp.r - trnSp.g - trnSp.b, 0.0);
diffuseColor.rgb *= 1.0 - 0.3 * max(trnCan.r, trnCan.g);
if (trnK > 0.002) {
  vec3 N0 = trnNW;
  vec2 xz = vTrnW.xz, dx = trnDX.xz, dy = trnDY.xz;
  vec4 sp = trnSp;
  vec4 nz = textureGrad(uTrnNoise, xz * 0.0137, dx * 0.0137, dy * 0.0137);
  vec3 gBase = trnGc.rgb;
  float mudF = smoothstep(-0.5, -4.0, vTrnW.y);
  float wetF = smoothstep(0.4, -0.4, vTrnW.y);
  float wS = sp.r * (1.0 - mudF), wM = sp.r * mudF, wP = sp.g, wR = sp.b;
  float wG = max(1.0 - sp.r - sp.g - sp.b, 0.0);
  float ab = smoothstep(0.3, 0.7, nz.g);
  vec4 aG = vec4(0.5), aP = vec4(0.5), aR = vec4(0.5), aS = vec4(0.5), aM = vec4(0.5);
  if (wG > 0.002) aG = trnAlb2(0.0, xz, dx, dy, 0.38, 0.137, ab);
  if (wP > 0.002) aP = trnAlb2(1.0, xz, dx, dy, 0.45, 0.17, ab);
  if (wS > 0.002) aS = trnAlb2(3.0, xz, dx, dy, 0.33, 0.123, ab);
  if (wM > 0.002) aM = trnAlb2(4.0, xz, dx, dy, 0.4, 0.15, ab);
  // rock: triplanar projection (UVs mirrored per side so the texture never flips)
  vec3 bw = pow(abs(N0), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec3 sg = vec3(N0.x < 0.0 ? -1.0 : 1.0, N0.y < 0.0 ? -1.0 : 1.0, N0.z < 0.0 ? -1.0 : 1.0);
  vec3 rp = vTrnW * 0.18, rdx = trnDX * 0.18, rdy = trnDY * 0.18;
  vec2 uvX = vec2(rp.z * sg.x, rp.y), uvY = vec2(rp.x * sg.y, rp.z), uvZ = vec2(-rp.x * sg.z, rp.y);
  vec2 dxX = vec2(rdx.z * sg.x, rdx.y), dyX = vec2(rdy.z * sg.x, rdy.y);
  vec2 dxY = vec2(rdx.x * sg.y, rdx.z), dyY = vec2(rdy.x * sg.y, rdy.z);
  vec2 dxZ = vec2(-rdx.x * sg.z, rdx.y), dyZ = vec2(-rdy.x * sg.z, rdy.y);
  if (wR > 0.002) {
    aR = textureGrad(uTrnAlb, vec3(uvX, 2.0), dxX, dyX) * bw.x
       + textureGrad(uTrnAlb, vec3(uvY, 2.0), dxY, dyY) * bw.y
       + textureGrad(uTrnAlb, vec3(uvZ, 2.0), dxZ, dyZ) * bw.z;
  }
  // height-aware blend: pebbles and rock ledges win over soil where layers meet
  float sG = wG > 0.002 ? wG + aG.a * 0.6 : -9.0;
  float sP = wP > 0.002 ? wP + aP.a * 0.6 : -9.0;
  float sR = wR > 0.002 ? wR + aR.a * 0.6 : -9.0;
  float sS = wS > 0.002 ? wS + aS.a * 0.6 : -9.0;
  float sM = wM > 0.002 ? wM + aM.a * 0.6 : -9.0;
  float mx = max(max(max(sG, sP), max(sR, sS)), sM) - 0.16;
  float bG = max(sG - mx, 0.0), bP = max(sP - mx, 0.0), bR = max(sR - mx, 0.0), bS = max(sS - mx, 0.0), bM = max(sM - mx, 0.0);
  float bSum = bG + bP + bR + bS + bM;
  bG /= bSum; bP /= bSum; bR /= bSum; bS /= bSum; bM /= bSum;
  vec3 kP = mix(vec3(1.0), uTrnPathEdgeK, sp.a);
  vec3 kR = mix(vec3(1.0), uTrnRockDarkK, nz.b);
  vec3 kS = mix(vec3(1.0), uTrnWetK, wetF);
  vec3 flt = wG * gBase + wP * uTrnPath * kP + wR * uTrnRock * kR + wS * uTrnSand * kS + wM * uTrnMud;
  float mott = clamp(trnLuma(diffuseColor.rgb) / max(trnLuma(flt), 1e-4), 0.55, 1.7);
  vec3 col = vec3(0.0);
  vec2 nt = vec2(0.0);
  float rough = 0.0, ex = 0.0;
  if (bG > 0.002) {
    vec2 t = trnNrm2(0.0, xz, dx, dy, 0.38, 0.137, ab, ex);
    // beyond the dense grass the ground reads as a grass carpet (less soil, blade-coloured), so
    // the blades' outer edge never shows against bare-looking ground
    float cpt = smoothstep(8.0, 26.0, length(xz - cameraPosition.xz)) * (1.0 - max(trnCan.r, trnCan.g));
    vec3 c = mix(gBase * aG.rgb * 2.0, uTrnSoil * (0.55 + 0.9 * aG.g), ex * (0.85 - 0.25 * trnGc.a) * (1.0 - 0.8 * cpt));
    c = mix(c, gBase * vec3(1.06, 1.12, 0.88), 0.45 * cpt);
    // wildflower drifts read as a colour wash from afar (same drift noise as grass.js flowers)
    if (uTrnQ > 0.5) {
      vec4 fd = textureLod(uTrnNoise, xz * 0.0115 + vec2(0.23, 0.57), 0.0);
      vec4 fv = vec4(fd.rg, 1.0 - fd.rg);
      float fl = 0.5 * (fd.a + fd.b), fm = max(max(max(fv.x, fv.y), max(fv.z, fv.w)), fl);
      // the strongest species' colour (grass.js: each clump takes the species with the strongest drift)
      vec3 fw = fm == fv.x ? vec3(0.93, 0.92, 0.87) : (fm == fv.y ? vec3(1.0, 0.76, 0.06) : (fm == fv.z ? vec3(0.82, 0.06, 0.035) : (fm == fv.w ? vec3(0.2, 0.32, 0.95) : vec3(0.55, 0.3, 0.8))));
      float fs = smoothstep(0.585, 0.7, fm);
      c = mix(c, fw * 0.32, (0.04 + 0.12 * cpt) * fs * trnGc.a * trnWG);
    }
    // leaf / needle litter under crowns
    c = mix(c, vec3(0.1, 0.066, 0.03) * (0.55 + 0.9 * aG.r), trnCan.r * 0.5);
    c = mix(c, vec3(0.085, 0.05, 0.03) * (0.55 + 0.9 * aG.r), trnCan.g * 0.45);
    col += bG * c; nt += bG * t; rough += bG * 0.93;
  }
  if (bP > 0.002) {
    vec2 t = trnNrm2(1.0, xz, dx, dy, 0.45, 0.17, ab, ex);
    col += bP * trnDecode(aP.rgb) * kP; nt += bP * t; rough += bP * ex;
  }
  if (bS > 0.002) {
    vec2 t = trnNrm2(3.0, xz, dx, dy, 0.33, 0.123, ab, ex);
    col += bS * trnDecode(aS.rgb) * kS; nt += bS * t * (1.0 - 0.6 * wetF); rough += bS * mix(ex, 0.42, wetF * 0.85);
  }
  if (bM > 0.002) {
    vec2 t = trnNrm2(4.0, xz, dx, dy, 0.4, 0.15, ab, ex);
    col += bM * trnDecode(aM.rgb); nt += bM * t; rough += bM * ex;
  }
  vec3 nR = N0;
  if (bR > 0.002) {
    vec3 tX = trnTN(textureGrad(uTrnNrm, vec3(uvX, 2.0), dxX, dyX));
    vec3 tY = trnTN(textureGrad(uTrnNrm, vec3(uvY, 2.0), dxY, dyY));
    vec3 tZ = trnTN(textureGrad(uTrnNrm, vec3(uvZ, 2.0), dxZ, dyZ));
    tX.x *= sg.x; tY.x *= sg.y; tZ.x *= -sg.z;
    tX = vec3(tX.xy + N0.zy, tX.z * N0.x);
    tY = vec3(tY.xy + N0.xz, tY.z * N0.y);
    tZ = vec3(tZ.xy + N0.xy, tZ.z * N0.z);
    nR = normalize(tX.zyx * bw.x + tY.xzy * bw.y + tZ.xyz * bw.z);
    col += bR * trnDecode(aR.rgb) * kR;
    rough += bR * 0.82;
  }
  col *= mott;
  float slope = sqrt(max(1.0 - N0.y * N0.y, 0.0)) / max(N0.y, 0.05);
  float snowT = smoothstep(92.0, 100.0, vTrnW.y + (nz.r - 0.5) * 16.0) * smoothstep(0.5, 0.2, slope);
  col = mix(col, uTrnSnow * (0.9 + 0.1 * nz.a), snowT);
  vec3 nTop = normalize(N0 + vec3(nt.x, 0.0, nt.y));
  trnNW = normalize(mix(nTop, nR, bR));
  trnRough = mix(rough, 0.6, snowT);
  diffuseColor.rgb = mix(diffuseColor.rgb, col, trnK);
}
// Steep rock faces (cliffs, crags): lighter warm stone in ~2 m beds with ledges, cracks, moss on the
// ledges and wet green streaks below them. Independent of the detail fade, so a cliff keeps its form
// from across the lake; the ledge normals + a bounce/sky fill (TRN_FILL) light a backlit face.
vec3 trnCliffN = vec3(0.0);
float trnSteep = 0.0;
{
  vec3 Ng = normalize(vTrnN);
  float camD = length(vTrnW - cameraPosition);
  trnSteep = trnSp.b * smoothstep(0.8, 0.55, Ng.y) * (1.0 - smoothstep(280.0, 420.0, camD));
  if (trnSteep > 0.01) {
    vec2 hn = normalize(Ng.xz + vec2(1e-5));
    vec4 wn = textureLod(uTrnNoise, vTrnW.xz * 0.019 + vec2(0.61, 0.29), 0.0);
    // beds of uneven thickness (~2-6 m), warped so they undulate and pinch out; each bed is a
    // rounded, weathered layer: undercut (facing down) at its base, rounded top edge facing up
    float sy = vTrnW.y + dot(vTrnW.xz, vec2(0.045, 0.02)) + (wn.r - 0.5) * 3.4 + (wn.a - 0.5) * 0.7;
    float bed = sy * 0.3 + 0.1 * sin(sy * 0.61) + 0.05 * sin(sy * 1.37 + 1.3);
    float fb = fract(bed), bh = fract(sin(floor(bed) * 12.9898 + 4.1) * 43758.5453);
    // hard beds (sandstone) stand out with a ledge; soft beds (shale) are recessed, darker, cooler
    float near = 1.0 - smoothstep(120.0, 280.0, camD);
    float hard = smoothstep(0.3, 0.7, bh);
    float prof = mix(-0.5, 0.55, smoothstep(0.02, 0.88, fb)) * (1.0 - smoothstep(0.9, 1.0, fb)) * near * (0.3 + 0.7 * hard);
    float ledge = smoothstep(0.62, 0.9, fb) * (1.0 - smoothstep(0.9, 1.0, fb)) * near * hard;
    float under = (1.0 - smoothstep(0.0, 0.18, fb)) * near;
    float parting = (1.0 - smoothstep(0.0, 0.06, abs(fract(sy * 1.1 + wn.g) - 0.5) - 0.44)) * 0.5 * near;
    // face-aligned noise for vertical features (x- and z-facing projections blended); the low
    // preset (uTrnQ 0) keeps only the beds
    float crack = 0.0, streak = 0.0;
    if (uTrnQ > 0.5) {
      float cyy = vTrnW.y * 0.012;
      vec4 cn = mix(textureLod(uTrnNoise, vec2(vTrnW.z * 0.06 + 0.5, cyy), 0.0), textureLod(uTrnNoise, vec2(vTrnW.x * 0.06, cyy), 0.0), hn.y * hn.y);
      crack = (1.0 - smoothstep(0.0, 0.035, abs(cn.g - 0.5))) * smoothstep(0.3, 0.62, wn.b) * (1.0 - smoothstep(50.0, 160.0, camD));
      streak = smoothstep(0.5, 0.7, cn.b * 0.6 + cn.a * 0.4);
    }
    vec3 stone = diffuseColor.rgb * mix(vec3(1.7, 1.66, 1.6), vec3(2.05, 1.9, 1.62), hard) * (0.86 + 0.28 * fract(bh * 7.3));
    stone *= 1.0 + 0.1 * ledge - 0.3 * under - 0.12 * parting - 0.38 * crack;
    vec3 moss = vec3(0.085, 0.13, 0.03) * (0.75 + 0.55 * wn.g);
    float mossK = clamp(ledge * smoothstep(0.42, 0.7, wn.g) * 0.85 + streak * (0.7 - 0.35 * fb) * (0.5 + 0.5 * wn.b), 0.0, 0.85);
    stone = mix(stone, moss, mossK);
    diffuseColor.rgb = mix(diffuseColor.rgb, stone, trnSteep);
    // ledge tops tilt up (sky + a backlighting sun catch them), undercuts tilt down
    trnCliffN = vec3(-hn.x * 0.3 * max(prof, 0.0), prof, -hn.y * 0.3 * max(prof, 0.0));
  }
}
`;

// Added as a delta so other patches that bump the normal before this point keep their effect.
const TRN_NORMAL = /* glsl */ `
if (trnK > 0.002) normal = normalize(normal + (viewMatrix * vec4(trnNW - normalize(vTrnN), 0.0)).xyz * trnK);
if (trnSteep > 0.01) normal = normalize(normal + (viewMatrix * vec4(trnCliffN, 0.0)).xyz * trnSteep);
`;
// Steep faces: bounce light from the sunlit ground / lake in front of them plus open sky, stronger
// when the sun is behind the face, so a backlit cliff still shows its beds and ledges.
const TRN_FILL = /* glsl */ `
#if NUM_DIR_LIGHTS > 0 && NUM_HEMI_LIGHTS > 0
if (trnSteep > 0.01) {
  vec3 trnUpV = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  float trnSunUp = max(dot(directionalLights[0].direction, trnUpV), 0.0);
  float trnBack = smoothstep(0.2, -0.4, dot(normal, directionalLights[0].direction));
  vec3 trnFill = directionalLights[0].color * (trnSunUp * uTrnFill.x) + hemisphereLights[0].skyColor * uTrnFill.y;
  reflectedLight.indirectDiffuse += BRDF_Lambert(diffuseColor.rgb) * trnFill * (trnSteep * (0.35 + 0.65 * trnBack));
}
#endif
`;

// Detail fade distances per quality level (trees 0/1/2): [full detail until, macro only from].
const GROUND_FADE = [[35, 70], [60, 115], [95, 180]];
let groundUniforms = null;
export function setGroundDetail(level) {
  const f = GROUND_FADE[Math.max(0, Math.min(2, level | 0))];
  if (groundUniforms) { groundUniforms.uTrnFade.value.set(f[0], f[1]); groundUniforms.uTrnQ.value = level > 0 ? 1 : 0; }
}

function terrainMaterial() {
  const g = groundTextures();
  // The macro maps hold linear values in sRGB textures (decoded twice on the GPU); match that.
  const eff = (c) => c.clone().convertSRGBToLinear();
  const ratio = (a, b) => new THREE.Vector3(a.r / b.r, a.g / b.g, a.b / b.b);
  const path = eff(COL.path), rock = eff(COL.rock), sand = eff(COL.sand);
  const uniforms = {
    uTrnSplat: { value: splatTexture }, uTrnGrass: { value: grassTexture }, uTrnNoise: { value: noiseTexture() },
    uTrnAlb: { value: g.albedo }, uTrnNrm: { value: g.normal },
    uTrnPath: { value: path }, uTrnPathEdgeK: { value: ratio(eff(COL.pathEdge), path) },
    uTrnRock: { value: rock }, uTrnRockDarkK: { value: ratio(eff(COL.rockDark), rock) },
    uTrnSand: { value: sand }, uTrnWetK: { value: ratio(eff(COL.wetSand), sand) },
    uTrnMud: { value: eff(COL.lakeBed) }, uTrnSoil: { value: eff(C('#b09a6a')).multiplyScalar(0.62) },
    uTrnSnow: { value: eff(COL.snow) },
    uTrnFade: { value: new THREE.Vector2(95, 180) },
    uTrnCanopy: { value: canopyTexture },
    uTrnFill: { value: new THREE.Vector2(0.24, 0.34) },
    uTrnQ: { value: 1 },
  };
  const mat = new THREE.MeshStandardMaterial({ map: colorTexture, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTrnW;\nvarying vec3 vTrnN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTrnW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vTrnN = normalize(mat3(modelMatrix) * objectNormal);');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TRN_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + TRN_ALBEDO)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, trnRough, trnK);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TRN_NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRN_FILL);
  };
  mat.customProgramCacheKey = () => 'stillwater-terrain-detail-4';
  mat.userData.detailUniforms = uniforms;
  groundUniforms = uniforms;
  return mat;
}

// GLSL: exact terrain height from the data texture (matches heightAt).
export const GLSL_TERRAIN = /* glsl */ `
uniform sampler2D uData;
const float T_HALF = ${HALF.toFixed(1)};
const float T_CELL = ${CELL.toFixed(6)};
const float T_GRID = ${GRID.toFixed(1)};
vec4 tFetch(int x, int z) { return texelFetch(uData, ivec2(x, z), 0); }
float terrainHeight(vec2 xz) {
  vec2 g = clamp((xz + T_HALF) / T_CELL, vec2(0.0), vec2(T_GRID - 0.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  float a = tFetch(i.x, i.y).r, b = tFetch(i.x + 1, i.y).r;
  float c = tFetch(i.x, i.y + 1).r, d = tFetch(i.x + 1, i.y + 1).r;
  if (f.x + f.y <= 1.0) return a + (b - a) * f.x + (c - a) * f.y;
  return d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
}
vec4 terrainData(vec2 xz) {
  vec2 g = clamp((xz + T_HALF) / T_CELL, vec2(0.0), vec2(T_GRID - 0.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  vec4 a = tFetch(i.x, i.y), b = tFetch(i.x + 1, i.y);
  vec4 c = tFetch(i.x, i.y + 1), d = tFetch(i.x + 1, i.y + 1);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;
