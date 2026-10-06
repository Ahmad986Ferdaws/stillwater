import * as THREE from 'three';
import { LAKE, WATER, dataTexture, heightAt, normalAt, layout, heights, GRID, CELL, HALF } from './terrain.js';
import { LAYERS } from '../layers.js';
import { waterTextures } from './waterTextures.js';
import { addCaustics, causticsUniforms, updateCaustics } from './caustics.js';
import { lakeVert, lakeFrag, RINGS } from './waterShaders.js';
import { WaterPass } from '../render/waterPasses.js';
import { createWaterfall } from './waterfall.js';

export { addCaustics, causticsUniforms };

// The lake: a flat surface at WATER on LAYERS.WATER whose shader composites refraction (depth-based
// absorption + in-scattering), a planar reflection, procedural ripples, wind gusts, foam, rings and a
// sun glitter path. Quality 0/1/2 pick the shader variant; setupPost() adds the pre-pass that feeds it
// (src/render/waterPasses.js). Also: Whisper Falls (world/waterfall.js) and its plunge pool, a boat
// wake (water.wake), petals drifting on the surface and occasional fish rises. Colour/strength knobs
// live in waterUniforms (live-tunable via window.__water.uniforms).
const WAKE = 20; // boat wake records (bow rings + stern wash)

const WIND = new THREE.Vector2(0.8, 0.45).normalize(); // same breeze as the grass

export const waterUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color() },
  uAmbient: { value: new THREE.Color() },
  uSky: { value: new THREE.Color() },
  uPlayer: { value: new THREE.Vector3() },
  uRipple: { value: 0 },
  uData: { value: null },
  // sky gradient for reflections without a mirror (shared with the sky dome when it is found)
  uZenith: { value: new THREE.Color('#2f6fd0') },
  uHorizon: { value: new THREE.Color('#bfe0f7') },
  uSunRaw: { value: new THREE.Color('#fff1dc') },
  // look
  uAbsorb: { value: new THREE.Vector3(0.46, 0.13, 0.1) }, // extinction /m; red dies first
  uDeepCol: { value: new THREE.Color(0.026, 0.175, 0.27) }, // deep water glow (x light)
  uShallowCol: { value: new THREE.Color(0.1, 0.5, 0.46) }, // shallow water glow (x light)
  uShoreCol: { value: new THREE.Color(0.1, 0.19, 0.08) }, // far shore faked into sky-only reflections
  uDetail: { value: 1 },
  uSpecular: { value: 0.25 },
  uGlint: { value: 0.35 },
  uReflBoost: { value: 0 }, // raised towards golden hour in updateWater
  uRefrAmt: { value: 1 },
  uReflDistort: { value: 0.8 },
  uDownPath: { value: 1 },
  uFoamAmt: { value: 1 },
  uWind: { value: WIND.clone() },
  uFalls: { value: new THREE.Vector4(0, 0, 9, 0) },
  uFallsShape: { value: new THREE.Vector2(1, 0) },
  uWake: { value: Array.from({ length: WAKE }, () => new THREE.Vector4(0, 0, -100, 0)) },
  uWakeCount: { value: 0 },
  uWakeBox: { value: new THREE.Vector4(1, 1, -1, -1) },
  uBoat: { value: new THREE.Vector4(0, 0, 0, 1) },
  uBoatK: { value: new THREE.Vector4(0, 0, 1.9, 0.75) },
  uHull: { value: new THREE.Vector4(0, 0, 0, 1) },  // rowboat: x, z, heading (unit) — no water drawn inside it
  uHullK: { value: new THREE.Vector4(1.7, 0.64, 0, 0) }, // half length, half beam, active
  uRings: { value: Array.from({ length: RINGS }, () => new THREE.Vector4(0, 0, -100, 0)) },
  uRingCount: { value: 0 },
  uRippleTex: { value: null }, // procedural, generated in createWater()
  uFoamTex: { value: null },
  // written by the pre-pass
  uRefrTex: { value: null },
  uDepthTex: { value: null },
  uRefrRow: { value: new THREE.Vector4(0, 0, -1, -0.2) },
  uProjXY: { value: new THREE.Vector2(1, 1) },
  uReflTex: { value: null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflOn: { value: 0 },
};

function findSky(scene) {
  let sky = null;
  scene.traverse((o) => {
    const u = o.material && o.material.uniforms;
    if (!sky && o.isMesh && u && u.uZenith && u.uHorizon && u.uSunColor) sky = o;
  });
  return sky;
}

function lakeMaterial(q) {
  const m = new THREE.ShaderMaterial({
    name: 'Lake' + q,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: lakeVert,
    fragmentShader: lakeFrag,
    defines: { WATER_Q: q, RINGS, WAKE },
    transparent: q === 0,
    fog: true,
  });
  Object.assign(m.uniforms, waterUniforms);
  return m;
}

function petalGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.055);
  s.quadraticCurveTo(0.055, -0.01, 0.012, 0.06);
  s.lineTo(0, 0.045);
  s.lineTo(-0.012, 0.06);
  s.quadraticCurveTo(-0.055, -0.01, 0, -0.055);
  const g = new THREE.ShapeGeometry(s, 5);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---- lake surface mesh --------------------------------------------------------------------------------
// Follows the terrain grid and its diagonal split, so the per-vertex water depth interpolates exactly
// like the terrain itself (the waterline lands where the terrain crosses the surface). Only cells that
// touch water are kept. aShore = distance to the nearest shoreline (vector distance transform).
function buildLakeGeometry() {
  const NV = GRID + 1;
  const reach = LAKE.r + 62;
  const ix0 = Math.max(0, Math.floor((LAKE.x - reach + HALF) / CELL)), ix1 = Math.min(GRID - 1, Math.ceil((LAKE.x + reach + HALF) / CELL));
  const iz0 = Math.max(0, Math.floor((LAKE.z - reach + HALF) / CELL)), iz1 = Math.min(GRID - 1, Math.ceil((LAKE.z + reach + HALF) / CELL));
  const W = ix1 - ix0 + 2, H = iz1 - iz0 + 2; // vertex sub-grid
  const dep = (i, k) => WATER - heights[(iz0 + k) * NV + ix0 + i];

  // Shore distance on the vertex sub-grid: propagate the nearest shoreline point (vector distance
  // transform). Seeds are the sub-cell waterline crossings on grid edges; land vertices seed themselves.
  const sx = new Float32Array(W * H), sz = new Float32Array(W * H), dist = new Float32Array(W * H);
  const gx = (i) => -HALF + (ix0 + i) * CELL, gz = (k) => -HALF + (iz0 + k) * CELL;
  for (let k = 0; k < H; k++) {
    for (let i = 0; i < W; i++) {
      const o = k * W + i, d = dep(i, k);
      let best = 1e9, bx = 0, bz = 0;
      if (d <= 0) { best = 0; bx = gx(i); bz = gz(k); }
      else {
        for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nk = k + dk;
          if (ni < 0 || nk < 0 || ni >= W || nk >= H) continue;
          const dn = dep(ni, nk);
          if (dn > 0) continue;
          const f = d / (d - dn);
          if (f * CELL < best) { best = f * CELL; bx = gx(i) + di * f * CELL; bz = gz(k) + dk * f * CELL; }
        }
      }
      dist[o] = best; sx[o] = bx; sz[o] = bz;
    }
  }
  const relax = (o, n) => {
    if (dist[n] >= 1e9) return;
    const x = gx(o % W), z = gz((o / W) | 0);
    const d = Math.hypot(x - sx[n], z - sz[n]);
    if (d < dist[o]) { dist[o] = d; sx[o] = sx[n]; sz[o] = sz[n]; }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < H; k++) {
      for (let i = 0; i < W; i++) {
        const o = k * W + i;
        if (i > 0) relax(o, o - 1);
        if (k > 0) { relax(o, o - W); if (i > 0) relax(o, o - W - 1); if (i < W - 1) relax(o, o - W + 1); }
      }
    }
    for (let k = H - 1; k >= 0; k--) {
      for (let i = W - 1; i >= 0; i--) {
        const o = k * W + i;
        if (i < W - 1) relax(o, o + 1);
        if (k < H - 1) { relax(o, o + W); if (i < W - 1) relax(o, o + W + 1); if (i > 0) relax(o, o + W - 1); }
      }
    }
  }

  const vid = new Int32Array(W * H).fill(-1);
  const pos = [], depth = [], shore = [], idx = [];
  const bounds = new THREE.Box3();
  const tmp = new THREE.Vector3();
  const vert = (i, k) => {
    const o = k * W + i;
    if (vid[o] < 0) {
      vid[o] = depth.length;
      const x = -HALF + (ix0 + i) * CELL, z = -HALF + (iz0 + k) * CELL;
      pos.push(x, 0, z);
      depth.push(dep(i, k));
      shore.push(Math.min(dist[o], 500));
      if (dep(i, k) > 0) bounds.expandByPoint(tmp.set(x, WATER, z));
    }
    return vid[o];
  };
  for (let k = 0; k < H - 1; k++) {
    for (let i = 0; i < W - 1; i++) {
      if (Math.max(dep(i, k), dep(i + 1, k), dep(i, k + 1), dep(i + 1, k + 1)) <= -0.3) continue;
      const a = vert(i, k), b = vert(i + 1, k), c = vert(i, k + 1), d = vert(i + 1, k + 1);
      idx.push(a, c, b, b, c, d); // same diagonal as the terrain mesh
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  geo.setAttribute('aShore', new THREE.Float32BufferAttribute(shore, 1));
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  if (bounds.isEmpty()) bounds.copy(geo.boundingBox);
  bounds.expandByVector(tmp.set(CELL, 0, CELL));
  return { geo, bounds };
}

// ---- terrain subsets for the pre-pass ------------------------------------------------------------------
// The refraction render only needs the lake bed and the mirror only the land around the lake, but the
// terrain is one 295k-triangle mesh. These copy the needed cells (all attributes, same material) so the
// pre-pass can draw them instead. Returns null if the terrain is not the expected single grid mesh.
function findTerrain(scene) {
  let t = null;
  const n = (GRID + 1) * (GRID + 1);
  scene.traverse((o) => { if (!t && o.isMesh && !o.isInstancedMesh && o.geometry?.index && o.geometry.attributes.position?.count === n) t = o; });
  return t;
}
function terrainSubset(terrain, keepCell) {
  const src = terrain.geometry, NV = GRID + 1;
  const remap = new Int32Array(NV * NV).fill(-1);
  const verts = [], idx = [];
  const use = (v) => { if (remap[v] < 0) { remap[v] = verts.length; verts.push(v); } return remap[v]; };
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      if (!keepCell(ix, iz)) continue;
      const a = iz * NV + ix, b = a + 1, c = a + NV, d = c + 1;
      idx.push(use(a), use(c), use(b), use(b), use(c), use(d));
    }
  }
  const geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const size = attr.itemSize, out = new attr.array.constructor(verts.length * size);
    for (let i = 0; i < verts.length; i++) for (let k = 0; k < size; k++) out[i * size + k] = attr.array[verts[i] * size + k];
    geo.setAttribute(name, new THREE.BufferAttribute(out, size, attr.normalized));
  }
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, terrain.material);
  m.matrixAutoUpdate = terrain.matrixAutoUpdate;
  m.position.copy(terrain.position); m.quaternion.copy(terrain.quaternion); m.scale.copy(terrain.scale);
  m.receiveShadow = terrain.receiveShadow;
  m.castShadow = false;
  m.visible = false; // only shown inside the pre-pass
  m.name = 'terrain.waterSubset';
  return m;
}
function buildTerrainParts(scene, bounds) {
  const terrain = findTerrain(scene);
  if (!terrain) { console.warn('[water] terrain grid mesh not found; pre-pass draws the full terrain'); return null; }
  const NV = GRID + 1;
  const h = (ix, iz) => heights[iz * NV + ix];
  const bed = terrainSubset(terrain, (ix, iz) => Math.min(h(ix, iz), h(ix + 1, iz), h(ix, iz + 1), h(ix + 1, iz + 1)) < WATER + 0.6);
  const R = 320; // land that can show up in the mirror (the mirror's far plane stops ~150 m past the lake)
  const ring = terrainSubset(terrain, (ix, iz) => {
    const x = -HALF + (ix + 0.5) * CELL, z = -HALF + (iz + 0.5) * CELL;
    const dx = Math.max(bounds.min.x - x, 0, x - bounds.max.x), dz = Math.max(bounds.min.z - z, 0, z - bounds.max.z);
    return dx * dx + dz * dz < R * R && Math.max(h(ix, iz), h(ix + 1, iz), h(ix, iz + 1), h(ix + 1, iz + 1)) > WATER - 0.3;
  });
  scene.add(bed, ring);
  return { terrain, bed, ring, geometry: terrain.geometry };
}

// ---- create -----------------------------------------------------------------------------------------
export function createWater(scene) {
  const u = waterUniforms;
  u.uData.value = dataTexture;
  const tex = waterTextures();
  u.uRippleTex.value = tex.ripple;
  u.uFoamTex.value = tex.foam;
  causticsUniforms.uCausticsTex.value = tex.caustics;
  causticsUniforms.uCausticsNoise.value = tex.foam;
  const sky = findSky(scene);
  if (sky) {
    u.uZenith = sky.material.uniforms.uZenith;
    u.uHorizon = sky.material.uniforms.uHorizon;
    u.uSunRaw = sky.material.uniforms.uSunColor;
  }

  const { geo: lakeGeo, bounds } = buildLakeGeometry();
  const terrainParts = buildTerrainParts(scene, bounds);
  const mats = [];
  const lake = new THREE.Mesh(lakeGeo, null);
  lake.position.set(0, WATER, 0);
  lake.layers.set(LAYERS.WATER);
  lake.name = 'lake';
  scene.add(lake);

  const out = { lake, bounds, bedDetail: 1, falls: null, waterfall: null, petals: null, pass: null, level: -1, skyShared: !!sky, state: null };

  out.setQuality = (level) => {
    level = Math.max(0, Math.min(2, level | 0));
    if (!mats[level]) mats[level] = lakeMaterial(level);
    lake.material = mats[level];
    // Opaque variants draw right after the sky so everything under the surface is rejected early.
    lake.renderOrder = level === 0 ? 1 : -0.5;
    causticsUniforms.uUnderwaterTint.value = level === 0 ? 1 : 0;
    // Lake-bed detail (sand ripples, pebbles) runs at full resolution in the main pass at quality 0
    // (the bed is seen straight through the alpha-blended lake), but only in the half-res pre-pass above.
    causticsUniforms.uBedDetail.value = level === 0 ? 0 : out.bedDetail;
    out.level = level;
  };
  out.setQuality(0);

  // Called from setupPost(): returns the (persistent) pre-pass configured for this quality level.
  // `exclude`: objects to leave out of the refraction/reflection renders (grass/flowers on layer 0).
  out.pipeline = (sceneArg, camera, level = 0, exclude = null) => {
    if (!out.pass) out.pass = new WaterPass({ lake, uniforms: u, sky, bounds, terrainParts, isWater: (x, z) => heightAt(x, z) < WATER });
    out.pass.attach(sceneArg || scene, camera, exclude);
    out.setQuality(level);
    out.pass.setLevel(out.level);
    return out.pass;
  };

  // Whisper Falls: veil, ropes, talus cascade, whitewater, mist + rainbow, spray (world/waterfall.js),
  // the plunge pool on the lake (uFalls) and spray-wet rock around it (caustics wrapper, uWetA/B).
  const f = layout.falls;
  if (f) {
    const wf = createWaterfall(scene, f, u);
    out.waterfall = wf;
    out.falls = wf.veil;
    const i = wf.info;
    u.uFalls.value.set(i.x, i.entryZ + 1.2, 11, 1);
    u.uFallsShape.value.set(1.7, 0);
    causticsUniforms.uWetA.value.set(i.x, i.lipZ, i.width * 0.5, i.lipY);
    causticsUniforms.uWetB.value.set(i.impactZ, i.impactY, i.entryZ, 1);
    // Rocks and other solid props around the falls get the same wet look (position-gated in the shader).
    const wetBox = new THREE.Box3(new THREE.Vector3(i.x - 16, WATER - 1, i.lipZ - 5), new THREE.Vector3(i.x + 16, i.lipY + 4, i.entryZ + 4));
    const box = new THREE.Box3();
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || o === lake || !(o.material && o.material.isMeshStandardMaterial)) return;
      if (terrainParts && (o === terrainParts.terrain || o === terrainParts.bed || o === terrainParts.ring)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      o.updateWorldMatrix(true, false);
      if (box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).intersectsBox(wetBox)) addCaustics(o.material);
    });
  }

  // Petals and the odd leaf drifting on the surface near the player.
  const PN = 110;
  const petals = new THREE.InstancedMesh(petalGeometry(), new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), PN);
  petals.layers.set(LAYERS.FX);
  petals.frustumCulled = false;
  const pal = ['#ffc4d6', '#ffb3c9', '#ffd6e2', '#fff1f4', '#f7a8c6'].map((c) => new THREE.Color(c));
  const leafPal = ['#9cc25a', '#c9b24a', '#7fae48'].map((c) => new THREE.Color(c));
  const pstate = [];
  for (let i = 0; i < PN; i++) {
    const leaf = i % 9 === 0;
    petals.setColorAt(i, leaf ? leafPal[(i / 9) % 3 | 0] : pal[i % pal.length]);
    pstate.push({ alive: false, x: 0, z: 0, rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.4, s: leaf ? 2.2 + Math.random() * 0.8 : 0.8 + Math.random() * 0.5, ph: Math.random() * 10, tilt: Math.random() });
  }
  petals.instanceColor.needsUpdate = true;
  scene.add(petals);
  out.petals = { mesh: petals, state: pstate };

  out.state = makeState(out);
  // Public: a ripple ring on the surface (fish landing, bobber plop, oar stroke). strength ~0.3..1.5
  out.ring = (x, z, strength = 1, delay = 0) => out.state.ring(x, z, strength, delay);
  // Public: call every frame for a moving boat (world x/z, velocity m/s): V wake, stern wash, bow foam.
  // Optional hull half length / half width (defaults fit the dock rowboat: 1.9 x 0.75 m).
  out.wake = (x, z, vx, vz, strength = 1, halfLength, halfWidth) => out.state.wake(x, z, vx, vz, strength, halfLength, halfWidth);
  // Public: keep the lake surface out of the rowboat's hull (waterline footprint), every frame it floats.
  out.hull = (x, z, heading, halfLength, halfBeam) => {
    u.uHull.value.set(x, z, Math.sin(heading), Math.cos(heading));
    u.uHullK.value.set(halfLength, halfBeam, 1, 0);
  };
  out.uniforms = u;
  if (typeof window !== 'undefined') window.__water = out; // live tuning: __water.uniforms.uAbsorb.value.set(...), __water.pass.reflEvery = 3, ...
  return out;
}

// ---- per-frame state (rings, petals, falls particles) ------------------------------------------------
function makeState(water) {
  const u = waterUniforms;
  // Live rings (a ring may be scheduled slightly in the future); packed into the uniform each frame.
  const live = [];
  const addRing = (x, z, strength, time) => {
    if (live.length >= RINGS * 2) live.shift();
    live.push({ x, z, t0: time, s: strength });
  };
  const packRings = (time) => {
    for (let i = live.length - 1; i >= 0; i--) if (time - live[i].t0 > 7) live.splice(i, 1);
    const out = u.uRings.value;
    let n = 0;
    for (let i = live.length - 1; i >= 0 && n < RINGS; i--) { // newest first
      const r = live[i];
      if (r.t0 > time) continue;
      out[n++].set(r.x, r.z, r.t0, r.s);
    }
    u.uRingCount.value = n;
  };
  // Boat wake: bow rings (their envelope makes the V) + stern wash, packed like the rings.
  const wakeLive = [];
  const boat = { x: 0, z: 0, hx: 0, hz: 1, speed: 0, k: 0, last: -1e9, travel: 0, washTravel: 0, lastEmit: -1e9, lastWash: -1e9, hl: 1.9, hw: 0.75 };
  const pushWake = (x, z, t0, s) => { if (wakeLive.length >= WAKE * 2) wakeLive.shift(); wakeLive.push({ x, z, t0, s }); };
  const packWake = (time) => {
    for (let i = wakeLive.length - 1; i >= 0; i--) {
      const r = wakeLive[i];
      if (time - r.t0 > (r.s > 0 ? 7 : 4)) wakeLive.splice(i, 1);
    }
    const out = u.uWake.value, box = u.uWakeBox.value;
    let n = 0, x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let i = wakeLive.length - 1; i >= 0 && n < WAKE; i--) { // newest first
      const r = wakeLive[i], age = Math.max(time - r.t0, 0);
      out[n++].set(r.x, r.z, r.t0, r.s);
      const rad = r.s > 0 ? 0.12 + age * 1.05 + 2.6 * (0.22 + age * 0.2) : (0.65 + age * 0.35) * 1.6;
      x0 = Math.min(x0, r.x - rad); z0 = Math.min(z0, r.z - rad); x1 = Math.max(x1, r.x + rad); z1 = Math.max(z1, r.z + rad);
    }
    u.uWakeCount.value = n;
    box.set(x0, z0, x1, z1);
    if (!n) box.set(1, 1, -1, -1);
    const fade = Math.max(0, 1 - (time - boat.last) / 0.3);
    u.uBoat.value.set(boat.x, boat.z, boat.hx, boat.hz);
    u.uBoatK.value.set(boat.speed, boat.k * fade, boat.hl, boat.hw);
  };
  const last = new THREE.Vector3();
  let first = true, wasSwimming = false, wakeT = 0, riseT = 4, now = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pv = new THREE.Vector3(), sv = new THREE.Vector3();

  function spawnPetal(p, player) {
    for (let k = 0; k < 8; k++) {
      const a = Math.random() * Math.PI * 2, r = 4 + Math.sqrt(Math.random()) * 36;
      const x = player.x + Math.cos(a) * r, z = player.z + Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < WATER - 0.08 && h > WATER - 3.5) { p.x = x; p.z = z; p.alive = true; return; }
    }
    p.alive = false;
  }

  return {
    ring(x, z, strength, delay) { addRing(x, z, strength, now + delay); },
    wake(x, z, vx, vz, strength, hl, hw) {
      const sp = Math.hypot(vx, vz);
      if (sp > 0.05) { boat.hx = vx / sp; boat.hz = vz / sp; } // keep the last heading when stopped
      const dtc = boat.last > -1e8 ? Math.min(0.2, Math.max(0, now - boat.last)) : 0;
      boat.last = now;
      boat.travel += sp * dtc;
      boat.washTravel += sp * dtc;
      boat.x = x; boat.z = z; boat.speed = sp; boat.k = strength;
      if (hl) boat.hl = hl;
      if (hw) boat.hw = hw;
      const k = strength * Math.min(1.3, sp / 1.6);
      if (sp > 0.25 && (boat.travel > 1.0 || now - boat.lastEmit > 0.6)) { // diverging ring off the bow (their envelope is the V)
        boat.travel = 0;
        boat.lastEmit = now;
        pushWake(x + boat.hx * boat.hl * 0.85, z + boat.hz * boat.hl * 0.85, now, k);
      }
      if (sp > 0.25 && (boat.washTravel > 0.9 || now - boat.lastWash > 0.5)) { // churned water behind the stern
        boat.washTravel = 0;
        boat.lastWash = now;
        pushWake(x - boat.hx * boat.hl * 0.9, z - boat.hz * boat.hl * 0.9, now, -k * 0.8);
      }
    },
    update(dt, time, env, player, swimming) {
      now = time;
      // --- swimmer wake + entry splash
      const speed = first ? 0 : Math.min(6, Math.hypot(player.x - last.x, player.z - last.z) / Math.max(dt, 1e-4));
      last.copy(player);
      first = false;
      if (swimming && !wasSwimming) { addRing(player.x, player.z, 1.2, time); addRing(player.x, player.z, 0.7, time + 0.25); }
      if (swimming && speed > 0.3) {
        wakeT -= dt;
        if (wakeT <= 0) { addRing(player.x, player.z, 0.3 + Math.min(speed, 3) * 0.12, time); wakeT = 0.32; }
      }
      wasSwimming = swimming;
      packRings(time);

      const nearLake = Math.hypot(player.x - LAKE.x, player.z - LAKE.z) < LAKE.r + 90;

      // --- fish rising somewhere out on the lake
      riseT -= dt;
      if (riseT <= 0) {
        riseT = 2.5 + Math.random() * 6;
        if (nearLake) {
          for (let k = 0; k < 8; k++) {
            const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 62;
            const x = player.x + Math.cos(a) * r, z = player.z + Math.sin(a) * r;
            if (heightAt(x, z) < WATER - 1.4) {
              addRing(x, z, 0.65 + Math.random() * 0.4, time);
              if (Math.random() < 0.6) addRing(x, z, 0.35, time + 0.3);
              break;
            }
          }
        }
      }

      // --- petals drifting on the surface
      const P = water.petals;
      if (P) {
        P.mesh.visible = nearLake;
        if (nearLake) {
          for (let i = 0; i < P.state.length; i++) {
            const p = P.state[i];
            if (!p.alive || Math.hypot(p.x - player.x, p.z - player.z) > 46) spawnPetal(p, player);
            if (p.alive) {
              const cx = (p.x - LAKE.x) / LAKE.r, cz = (p.z - LAKE.z) / LAKE.r;
              let vx = WIND.x * 0.08 - cz * 0.05 + Math.sin(time * 0.3 + p.ph) * 0.03;
              let vz = WIND.y * 0.08 + cx * 0.05 + Math.cos(time * 0.27 + p.ph) * 0.03;
              const dx = p.x - player.x, dz = p.z - player.z, d = Math.hypot(dx, dz);
              if (swimming && d < 1.8 && d > 1e-3) { const k = (1.8 - d) * 1.6; vx += (dx / d) * k; vz += (dz / d) * k; }
              p.x += vx * dt;
              p.z += vz * dt;
              p.rot += p.spin * dt;
              if (heightAt(p.x, p.z) > WATER - 0.03) p.alive = false;
            }
            const bob = Math.sin(time * 1.4 + p.ph) * 0.006;
            e.set(Math.sin(time * 1.1 + p.ph) * 0.08 * p.tilt, p.rot, Math.cos(time * 0.9 + p.ph) * 0.08 * p.tilt, 'YXZ');
            q.setFromEuler(e);
            pv.set(p.x, WATER + 0.02 + bob, p.z);
            sv.setScalar(p.alive ? p.s : 0.0001);
            P.mesh.setMatrixAt(i, m4.compose(pv, q, sv));
          }
          P.mesh.instanceMatrix.needsUpdate = true;
        }
      }

      if (water.waterfall) water.waterfall.update(dt, time, player);
      packWake(time);
    },
  };
}

let _dot;
export function softDot() {
  if (_dot) return _dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

export function updateWater(water, dt, time, env, player, swimming) {
  const u = waterUniforms;
  u.uTime.value = time;
  u.uSunDir.value.copy(env.sunDir);
  u.uSunCol.value.copy(env.sunColor);
  u.uAmbient.value.copy(env.ambient);
  u.uSky.value.copy(env.skyTint);
  if (!water || !water.skyShared) {
    u.uHorizon.value.copy(env.skyTint);
    u.uZenith.value.copy(env.skyTint).multiplyScalar(0.7);
    u.uSunRaw.value.copy(env.sunColor).multiplyScalar(Math.PI / 3);
  }
  u.uPlayer.value.copy(player);
  u.uRipple.value += ((swimming ? 1 : 0) - u.uRipple.value) * Math.min(1, dt * 3);
  u.uReflBoost.value = 0.06 * (env.golden || 0);
  updateCaustics(time, env);
  if (water && water.state) water.state.update(dt, time, env, player, swimming);
}
