import * as THREE from 'three';
import { mulberry32 } from '../noise.js';
import { cyl, merge, paint, prep, standard, addWind } from './geo.js';
import { HALF, WORLD, LAKE, heightAt, slopeAt, normalAt, pathDist, biome, layout, detailNoise, setGroundDetail, setCanopyTexture } from './terrain.js';
import { sampleNoise } from './textures.js';
import { colliders } from './colliders.js';
import { makeTree, makePalm, makeBush, makeFern, makeRock } from './trees.js';
import { leafMaterial, barkMaterial, rockMaterial, useFoliage, onFoliageUpdate, setFoliageLod, foliageUniforms } from './foliage.js';

// Scatter + chunked instancing for trees, bushes, ferns, rocks and shoreline props.
// Trees are split into a near LOD (bark tubes + leaf cards) and a far LOD (one merged low-card
// mesh); the switch is per instance in the shaders (dithered), whole chunks are shown/hidden per
// frame by distance (cheap: one loop over ~150 chunk records, no per-instance work).
// Near chunks cast shadows; far meshes do not.

export { makeRock };

// Old API kept for anything that still wants a rock geometry.
export function rockGeo(rnd) { return makeRock(rnd, 3); }

// ---- small props (unchanged style) -----------------------------------------------------------
export function reedGeo(rnd) {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const h = 1.2 + rnd() * 0.8;
    const x = (rnd() - 0.5) * 0.7, z = (rnd() - 0.5) * 0.7;
    const s = cyl(0.015, 0.025, h, 4, '#6f9446', x, 0, z, '#9cbc5c');
    s.rotateZ((rnd() - 0.5) * 0.2);
    parts.push(s);
    if (i % 2 === 0) parts.push(cyl(0.045, 0.045, 0.28, 6, '#6a4630', x, h - 0.3, z));
  }
  return merge(parts);
}

export function mushroomGeo(rnd) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const s = 0.6 + rnd() * 0.6;
    const x = (rnd() - 0.5) * 0.6, z = (rnd() - 0.5) * 0.6;
    parts.push(cyl(0.05 * s, 0.07 * s, 0.25 * s, 6, '#f1ead8', x, 0, z));
    const cap = prep(new THREE.SphereGeometry(0.17 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2));
    cap.translate(x, 0.22 * s, z);
    paint(cap, '#d8483a', (c, p) => { if (Math.sin(p.x * 60) * Math.sin(p.z * 60) > 0.75) c.set('#fff6ea'); });
    parts.push(cap);
  }
  return merge(parts);
}

export function lilyGeo(rnd) {
  const g = prep(new THREE.CircleGeometry(0.55, 14, 0.3, Math.PI * 1.8));
  g.rotateX(-Math.PI / 2);
  paint(g, '#5d9c44', (c, p) => c.lerp(new THREE.Color('#86bd5a'), Math.hypot(p.x, p.z) * 1.2));
  const parts = [g];
  if (rnd() < 0.35) {
    const f = prep(new THREE.ConeGeometry(0.14, 0.16, 6, 1, true));
    f.translate(0.1, 0.08, 0.05);
    paint(f, '#f7a8c6', (c, p) => c.lerp(new THREE.Color('#fff2f6'), p.y * 5));
    parts.push(f);
  }
  return merge(parts);
}

// ---- scatter ----------------------------------------------------------------------------------
const NEAR_CHUNK = 100, FAR_CHUNK = 300, PROP_CHUNK = 150;
// Number of random draws the previous geometry builders consumed before scattering. Burning the
// same count keeps every tree, bush and rock exactly where it was.
const LEGACY_BUILDER_DRAWS = 414;

// quality level (trees 0/1/2) -> [rock cull, rock shadow radius, prop cull]
const DIST = [[280, 40, 70], [360, 55, 100], [440, 65, 130]];

const state = { chunks: [], level: 2, root: null };

export function buildVegetation(scene) {
  const rnd = mulberry32(777);
  for (let i = 0; i < LEGACY_BUILDER_DRAWS; i++) rnd();
  // Geometry randomness (independent of the scatter). Every variant starts at a fixed place of one
  // seeded stream - the offsets the generators had when they drew from a single shared stream - so
  // changing one species' generator never re-rolls the shapes of the others.
  const geoRnd = (n) => mulberry32((4711 + Math.imul(n, 0x6d2b79f5)) >>> 0);
  const GEO_AT = {
    oak: [0, 1297], cherry: [2594, 3763], pine: [4881, 6335], birch: [7912, 9103], jungle: [10218, 11759], palm: [13248],
    bush: [13372, 13674], fern: [14010], rock: [14066, 14072, 14078], reed: [14084], mushroom: [14108],
  };

  const swayTree = [0.09, 0.07, 0.03], swayPalm = [0.15, 0.11, 0.05], swayBush = [0.015, 0.045, 0.03];
  const mats = {
    tree: { bark: barkMaterial(1, swayTree), leaf: leafMaterial(1, swayTree), far: leafMaterial(-1, swayTree) },
    palm: { bark: barkMaterial(1, swayPalm), leaf: leafMaterial(1, swayPalm), far: leafMaterial(-1, swayPalm) },
    bush: { bark: barkMaterial(1, swayBush, true), leaf: leafMaterial(1, swayBush, true), far: leafMaterial(-1, swayBush, true) },
  };
  const frondMat = addWind(standard({ side: THREE.DoubleSide }), 1.3, 1.6);
  const stiffMat = standard();
  const lilyMat = standard({ side: THREE.DoubleSide });
  const rockMat = rockMaterial();

  const tree = (name) => (r) => makeTree(name, r);
  const TYPES = {
    // few variants on purpose: every variant is one more draw call per chunk (instances vary by
    // rotation, scale and tint anyway)
    oak: { v: [tree('oak'), tree('oak')], mats: mats.tree, trunk: 0.45 },
    cherry: { v: [tree('cherry'), tree('cherry')], mats: mats.tree, trunk: 0.35 },
    pine: { v: [tree('pine'), tree('fir')], mats: mats.tree, trunk: 0.4 },
    birch: { v: [tree('birch'), tree('birch')], mats: mats.tree, trunk: 0.25 },
    jungle: { v: [tree('jungle'), tree('jungle')], mats: mats.tree, trunk: 0.7 },
    palm: { v: [(r) => makePalm(r)], mats: mats.palm, trunk: 0.3 },
    bush: { v: [(r) => makeBush(r, null), (r) => makeBush(r, ['bushWhite', 'bushPink'])], mats: mats.bush },
    fern: { v: [(r) => makeFern(r)], mats: mats.palm, nearOnly: true },
    // small plants on the lake cliff's ledges: the bush/fern shapes, no shadow casting
    ledgeBush: { share: 'bush', mats: mats.bush, noShadow: true },
    ledgeFern: { share: 'fern', mats: mats.palm, nearOnly: true, noShadow: true },
    rock: { n: 3, rock: true },
    reed: { n: 1, prop: [() => reedGeo(geoRnd(GEO_AT.reed[0]))], mat: frondMat },
    mushroom: { n: 1, prop: [() => mushroomGeo(geoRnd(GEO_AT.mushroom[0]))], mat: stiffMat },
    lily: { n: 2, prop: [() => lilyGeo(() => 1), () => lilyGeo(() => 0)], mat: lilyMat, flat: true },
  };
  // build geometries
  for (const [name, T] of Object.entries(TYPES)) {
    if (T.v) T.geo = T.v.map((fn, i) => fn(geoRnd(GEO_AT[name][i])));
    if (T.rock) T.geo = [0, 1, 2].map((i) => makeRock(geoRnd(GEO_AT.rock[i]), 3));
    if (T.prop) T.geo = T.prop.map((fn) => fn());
    if (T.share) T.geo = TYPES[T.share].geo;
    T.n = T.geo.length;
  }

  const records = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  function place(type, x, z, scale, y) {
    const T = TYPES[type];
    const vi = Math.min(T.n - 1, Math.floor(rnd() * T.n));
    const gy = y ?? heightAt(x, z);
    e.set(T.flat ? 0 : (rnd() - 0.5) * 0.08, rnd() * Math.PI * 2, T.flat ? 0 : (rnd() - 0.5) * 0.08);
    q.setFromEuler(e);
    s.setScalar(scale);
    p.set(x, gy - (T.rock ? 0.25 * scale : 0.05), z);
    records.push({ type, vi, x, z, s: scale, m: m.compose(p, q, s).clone() });
    if (T.trunk) colliders.add(x, z, T.trunk * scale);
    if (T.rock && scale > 0.7) colliders.add(x, z, 1.1 * scale);
  }

  const clear = layout.landmarks;
  const nearLandmark = (x, z) => clear.some((l) => Math.hypot(x - l.x, z - l.z) < l.clear + 4);
  const spawn = layout.spawn;

  const STEP = 7;
  for (let gz = -HALF; gz < HALF; gz += STEP) {
    for (let gx = -HALF; gx < HALF; gx += STEP) {
      const x = gx + rnd() * STEP, z = gz + rnd() * STEP;
      const r = Math.hypot(x, z);
      if (r > 590) continue;
      const h = heightAt(x, z);
      if (h < 1.9) continue;
      const sl = slopeAt(x, z);
      if (sl > 0.85) continue;
      if (pathDist(x, z) < 4.2 || nearLandmark(x, z)) continue;
      if (Math.hypot(x - spawn.x, z - spawn.z) < 9) continue;
      const b = biome(x, z);
      const k = rnd();
      const clump = detailNoise(x * 0.018, z * 0.018);
      const lakeD = Math.hypot(x - LAKE.x, z - LAKE.z);

      if (b.mountain > 0.35) {
        if (h > 70) { if (k < 0.04) place('rock', x, z, 1.5 + rnd() * 2.5); continue; }
        if (k < 0.12 * (1 - b.mountain) + 0.03) place('pine', x, z, 0.9 + rnd() * 0.6);
        else if (k < 0.2) place('rock', x, z, 1 + rnd() * 2.2);
      } else if (b.jungle > 0.5) {
        if (k < 0.2) place('jungle', x, z, 0.85 + rnd() * 0.5);
        else if (k < 0.32) place('palm', x, z, 0.85 + rnd() * 0.4);
        else if (k < 0.46) place('bush', x, z, 1 + rnd() * 0.8);
        else if (k < 0.5) place('rock', x, z, 0.5 + rnd() * 0.8);
      } else if (b.forest > 0.5) {
        if (k < 0.26 + clump * 0.1) place('pine', x, z, 0.8 + rnd() * 0.7);
        else if (k < 0.4) place('birch', x, z, 0.85 + rnd() * 0.4);
        else if (k < 0.46) place('bush', x, z, 0.8 + rnd() * 0.5);
        else if (k < 0.5) place('mushroom', x, z, 1);
        else if (k < 0.53) place('rock', x, z, 0.5 + rnd() * 1.1);
      } else {
        const grove = Math.max(clump - 0.25, 0) * 0.55;
        if (lakeD < LAKE.r + 75 && k < 0.07) place('cherry', x, z, 0.85 + rnd() * 0.4);
        else if (k < 0.018 + grove) place(rnd() < 0.72 ? 'oak' : 'birch', x, z, 0.8 + rnd() * 0.55);
        else if (k < 0.04 + grove * 1.2) place('bush', x, z, 0.7 + rnd() * 0.6);
        else if (k < 0.05 + grove * 1.2) place('rock', x, z, 0.4 + rnd() * 0.9);
      }
    }
  }

  // Jungle undergrowth
  for (let i = 0; i < 9000; i++) {
    const x = 150 + rnd() * 380, z = -HALF + rnd() * 1000;
    if (Math.hypot(x, z) > 500) continue;
    const b = biome(x, z);
    if (b.jungle < 0.55 || heightAt(x, z) < 2) continue;
    if (pathDist(x, z) < 2.8 || nearLandmark(x, z)) continue;
    if (rnd() < 0.55) place('fern', x, z, 0.8 + rnd() * 0.7);
  }

  // Shoreline reeds and lily pads
  for (let i = 0; i < 26000; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * (LAKE.r + 40);
    const x = LAKE.x + Math.cos(a) * d, z = LAKE.z + Math.sin(a) * d;
    const h = heightAt(x, z);
    if (Math.hypot(x - layout.dock.x, z - layout.dock.z) < 26) continue;
    if (h > -0.5 && h < 0.45 && rnd() < 0.3) place('reed', x, z, 0.8 + rnd() * 0.5);
    else if (h < -1.0 && h > -3.2 && rnd() < 0.05) place('lily', x, z, 0.8 + rnd() * 0.7, 0.03);
  }

  // ---- crown shade map: soft discs under every crown (r broadleaf, g conifer) -------------------
  // Grounds the trees: darker, littered soil and thinner, shaded grass under them (terrain + grass).
  {
    const CAN = 1024, texel = WORLD / CAN;
    const can = new Uint8Array(CAN * CAN * 4);
    const crownR = { oak: 3.9, birch: 2.2, cherry: 3.5, jungle: 5.3, palm: 2.6, pine: 2.7, bush: 1.1 };
    for (const r of records) {
      const R0 = crownR[r.type];
      if (!R0) continue;
      const R = R0 * r.s, ch = r.type === 'pine' ? 1 : 0, k = r.type === 'bush' ? 0.55 : 1;
      const cx = (r.x + HALF) / texel, cz = (r.z + HALF) / texel, rt = R / texel + 1;
      for (let iz = Math.max(0, Math.floor(cz - rt)); iz <= Math.min(CAN - 1, Math.ceil(cz + rt)); iz++) {
        for (let ix = Math.max(0, Math.floor(cx - rt)); ix <= Math.min(CAN - 1, Math.ceil(cx + rt)); ix++) {
          const d = Math.hypot(ix + 0.5 - cx, iz + 0.5 - cz) * texel;
          const t = Math.min(1, Math.max(0, (R * 1.05 - d) / (R * 0.75)));
          const v = t * t * (3 - 2 * t) * 255 * k;
          const o = (iz * CAN + ix) * 4 + ch;
          if (v > can[o]) can[o] = v;
        }
      }
    }
    const tex = new THREE.DataTexture(can, CAN, CAN, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    setCanopyTexture(tex);
  }

  // ---- small bushes and ferns on the lake cliff's ledges -------------------------------------
  // The rock beds are painted by the ground shader (terrain.js, steep faces); same bed maths here,
  // so the plants sit on ledge tops. Placed last (after the crown shade map) with their own random
  // stream for positions, so nothing else in the scatter changes.
  {
    const crnd = mulberry32(7331), wn = [0, 0, 0, 0], f = layout.falls;
    for (let x = LAKE.x - 105; x < LAKE.x + 105; x += 1.7) {
      if (f && Math.abs(x - f.x) < 11) continue;
      for (let z = LAKE.z - LAKE.r - 3; z > LAKE.z - LAKE.r - 38; z -= 0.6) {
        if (slopeAt(x, z) < 1.1) continue;
        const y = heightAt(x, z);
        if (y < 4 || y > 23) continue;
        sampleNoise(x * 0.019 + 0.61, z * 0.019 + 0.29, wn);
        const sy = y + 0.045 * x + 0.02 * z + (wn[0] - 0.5) * 3.4 + (wn[3] - 0.5) * 0.7;
        const bed = sy * 0.3 + 0.1 * Math.sin(sy * 0.61) + 0.05 * Math.sin(sy * 1.37 + 1.3);
        const fb = bed - Math.floor(bed);
        if (fb < 0.74 || fb > 0.86 || crnd() > 0.16) continue;
        const n = normalAt(x, z);
        const px = x + n.x * 0.4, pz = z + n.z * 0.4;
        if (crnd() < 0.7) place('ledgeBush', px, pz, 0.5 + crnd() * 0.4, y - 0.15);
        else place('ledgeFern', px, pz, 0.6 + crnd() * 0.4, y - 0.05);
      }
    }
  }

  // ---- chunked instancing ----------------------------------------------------------------------
  const root = new THREE.Group();
  root.name = 'vegetation';
  const chunkMap = new Map();
  const getChunk = (kind, size, x, z) => {
    const cx = Math.floor((x + HALF) / size), cz = Math.floor((z + HALF) / size);
    const key = `${kind}|${cx}|${cz}`;
    let c = chunkMap.get(key);
    if (!c) {
      const x0 = -HALF + cx * size, z0 = -HALF + cz * size;
      c = { kind, x0, z0, x1: x0 + size, z1: z0 + size, buckets: new Map(), group: new THREE.Group(), meshes: [] };
      chunkMap.set(key, c);
      root.add(c.group);
    }
    return c;
  };
  const push = (c, key, rec) => { if (!c.buckets.has(key)) c.buckets.set(key, []); c.buckets.get(key).push(rec); };
  for (const rec of records) {
    const T = TYPES[rec.type];
    if (T.v || T.share) {
      push(getChunk('near', NEAR_CHUNK, rec.x, rec.z), `${rec.type}|${rec.vi}`, rec);
      if (!T.nearOnly) push(getChunk('far', FAR_CHUNK, rec.x, rec.z), `${rec.type}|${rec.vi}`, rec);
    } else if (T.rock) push(getChunk('rock', PROP_CHUNK, rec.x, rec.z), `rock|${rec.vi}`, rec);
    else push(getChunk('prop', PROP_CHUNK, rec.x, rec.z), `${rec.type}|${rec.vi}`, rec);
  }
  // per-instance tint from the position, so a tree keeps its shade across the LOD switch
  const tint = (r) => { const h = Math.sin(r.x * 12.9898 + r.z * 78.233) * 43758.5453; return 0.88 + 0.22 * (h - Math.floor(h)); };
  let meshCount = 0, instanceCount = 0;
  const instanced = (geo, mat, recs, matrixAttr, colorAttr) => {
    const im = new THREE.InstancedMesh(geo, mat, recs.length);
    if (matrixAttr) { im.instanceMatrix = matrixAttr; im.instanceColor = colorAttr; }
    else {
      recs.forEach((r, i) => im.setMatrixAt(i, r.m));
      const c = new THREE.Color();
      recs.forEach((r, i) => im.setColorAt(i, c.setScalar(tint(r))));
    }
    im.computeBoundingSphere();
    meshCount++;
    return im;
  };
  for (const c of chunkMap.values()) {
    for (const [key, recs] of c.buckets) {
      const [type, vis] = key.split('|');
      const T = TYPES[type], vi = +vis;
      instanceCount += recs.length;
      if (c.kind === 'near') {
        const g = T.geo[vi];
        let first = null;
        if (g.bark && g.bark.index.count > 0) {
          first = instanced(g.bark, T.mats.bark, recs);
          useFoliage(first, T.mats.bark);
          first.castShadow = !T.noShadow; first.receiveShadow = true;
          c.group.add(first);
        }
        const lv = instanced(g.leaves, T.mats.leaf, recs, first?.instanceMatrix, first?.instanceColor);
        useFoliage(lv, T.mats.leaf);
        lv.castShadow = !T.noShadow; lv.receiveShadow = true;
        c.group.add(lv);
      } else if (c.kind === 'far') {
        const im = instanced(T.geo[vi].far, T.mats.far, recs);
        useFoliage(im, T.mats.far);
        im.castShadow = false; im.receiveShadow = true;
        c.group.add(im);
      } else if (c.kind === 'rock') {
        const im = instanced(T.geo[vi], rockMat, recs);
        im.castShadow = true; im.receiveShadow = true;
        c.group.add(im);
        c.meshes.push(im);
      } else {
        const im = instanced(T.geo[vi], T.mat, recs);
        im.castShadow = false; im.receiveShadow = false;
        c.group.add(im);
      }
    }
    c.buckets = null;
  }
  scene.add(root);

  state.chunks = [...chunkMap.values()];
  state.root = root;
  state.stats = { meshes: meshCount, instances: instanceCount, chunks: state.chunks.length };
  onFoliageUpdate(updateChunks);
  return { group: root, types: TYPES, stats: state.stats };
}

// Per frame: show/hide whole chunks by 2D distance to the player (no per-instance work).
function updateChunks(center) {
  const b = foliageUniforms.uLodBand.value;
  const [rockCull, rockShadow, propCull] = DIST[state.level];
  for (const c of state.chunks) {
    const dx = Math.max(c.x0 - center.x, 0, center.x - c.x1), dz = Math.max(c.z0 - center.z, 0, center.z - c.z1);
    const d = Math.hypot(dx, dz);
    if (c.kind === 'near') c.group.visible = d < b.y + 2;
    else if (c.kind === 'far') {
      const fx = Math.max(Math.abs(center.x - c.x0), Math.abs(center.x - c.x1)), fz = Math.max(Math.abs(center.z - c.z0), Math.abs(center.z - c.z1));
      c.group.visible = d < b.w + 2 && Math.hypot(fx, fz) > b.x - 2;
    } else if (c.kind === 'rock') {
      c.group.visible = d < rockCull;
      const cast = d < rockShadow;
      if (c.cast !== cast) { c.cast = cast; for (const im of c.meshes) im.castShadow = cast; }
    } else c.group.visible = d < propCull;
  }
}

// Quality hook (main.js applyQuality): trees 0/1/2 -> LOD distances, far cull, ground detail range.
export function setVegetationQuality(q) {
  const level = Math.max(0, Math.min(2, (q && q.trees) ?? 2));
  state.level = level;
  setFoliageLod(level);
  setGroundDetail(level);
  updateChunks(foliageUniforms.uLodCenter.value);
}
