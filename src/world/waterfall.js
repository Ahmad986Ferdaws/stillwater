import * as THREE from 'three';
import { heightAt, normalAt, WATER } from './terrain.js';
import { LAYERS } from '../layers.js';
import { veilVert, veilFrag, partVert, partFrag } from './waterShaders.js';
import { MIRROR_LAYER } from '../render/waterPasses.js';

// Whisper Falls. The cliff below layout.falls is a ~63° rock face over a gentle talus, so the water
// leaves the lip with some speed and free-falls in front of the face (each column's landing point is
// solved against the real terrain), then runs down the talus as whitewater into a churning plunge
// pool on the lake (drawn by the lake shader, see uFalls). Pieces:
//  - veil: back / main / front sheets + separate falling ropes, one draw call, parameterised by
//    time of flight so streaks move with the water and stretch as it accelerates
//  - cascade: whitewater draped over the talus (same draw call)
//  - boil: churning whitewater sprites where the veil lands and where the cascade meets the lake
//  - mist: billowing, sun-lit (forward scattering) puffs drifting with the wind, with a physically
//    placed rainbow (42° around the antisolar point, faint secondary at 51°)
//  - spray: fine droplets
// Everything is frustum-culled with fixed bounds; particle simulation stops when the falls are far
// away and have not been drawn for a while. The falls and mist are also drawn in the lake's mirror
// (MIRROR_LAYER) so they reflect.

const G = 9.8;
const rand = (() => { let s = 1234567; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

function lipAt(x, zFrom, zTo) {
  for (let z = zFrom; z < zTo; z += 0.2) {
    if (heightAt(x, z) - heightAt(x, z + 0.5) > 0.55) return { z, y: heightAt(x, z) };
  }
  return null;
}

// Time until a ballistic jet from (x0, y0, z0) with horizontal speed v0 (+z) meets the ground.
function landTime(x0, y0, z0, v0, dxdt) {
  for (let t = 0.1; t < 3.2; t += 0.01) {
    if (y0 - 0.5 * G * t * t <= heightAt(x0 + dxdt * t, z0 + v0 * t) + 0.1) return t;
  }
  return 3.2;
}

export function analyseFalls(f) {
  const lip = lipAt(f.x, f.topZ - 6, f.baseZ) || { z: f.topZ + 1.5, y: heightAt(f.x, f.topZ + 1.5) };
  const v0 = 4.9;
  const tl = landTime(f.x, lip.y + 0.12, lip.z, v0, 0);
  const impactZ = lip.z + v0 * tl, impactY = heightAt(f.x, impactZ);
  let entryZ = impactZ;
  while (entryZ < f.baseZ + 12 && heightAt(f.x, entryZ) > WATER - 0.35) entryZ += 0.25;
  return { x: f.x, lipZ: lip.z, lipY: lip.y, v0, fallTime: tl, impactZ, impactY, entryZ, width: 8 };
}

// ---- geometry -----------------------------------------------------------------------------------------
class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.fall = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(p, n, u, t, layer, prog, seed) {
    this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.uv.push(u, t); this.fall.push(layer, prog, seed, 0);
  }
  grid(cols, rows, fn) { // fn(u, s) -> writes a vertex; returns nothing
    const base = this.count;
    for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) fn(j / (cols - 1), i / (rows - 1), j, i);
    for (let j = 0; j < cols - 1; j++) {
      for (let i = 0; i < rows - 1; i++) {
        const a = base + j * rows + i, b = a + rows;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aFall', new THREE.Float32BufferAttribute(this.fall, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function buildVeil(info) {
  const b = new Builder();
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  const { x: fx, width: W } = info;
  // Sheets, back to front (drawn in this order inside one draw call).
  const sheets = [
    { layer: 0, v0: 4.35, w: W * 0.94, zoff: -0.45, bow: 0.25, spread: 0.1, seed: 0.13 },
    { layer: 1, v0: 4.9, w: W, zoff: 0.0, bow: 0.45, spread: 0.12, seed: 0.51 },
    { layer: 2, v0: 5.35, w: W * 0.82, zoff: 0.35, bow: 0.6, spread: 0.16, seed: 0.87 },
  ];
  const lipCache = new Map();
  const lipFor = (x) => {
    const k = Math.round(x * 4);
    if (!lipCache.has(k)) lipCache.set(k, lipAt(x, info.lipZ - 5, info.lipZ + 5) || { z: info.lipZ, y: info.lipY });
    return lipCache.get(k);
  };
  let maxT = 0;
  for (const s of sheets) {
    const cols = 17, rows = 46;
    const colT = [], colV = [], colLip = [];
    for (let j = 0; j < cols; j++) {
      const u = j / (cols - 1);
      const x0 = fx + (u - 0.5) * s.w;
      const lip = lipFor(x0);
      const v0 = s.v0 * (0.93 + 0.14 * rand());
      colLip.push(lip); colV.push(v0);
      colT.push(landTime(x0, lip.y + 0.12, lip.z + s.zoff, v0, (u - 0.5) * s.w * s.spread));
    }
    b.grid(cols, rows, (u, sN, j) => {
      const t = sN * colT[j];
      maxT = Math.max(maxT, t);
      const lip = colLip[j], v0 = colV[j];
      const bow = s.bow * (1 - (2 * u - 1) ** 2);
      P.set(fx + (u - 0.5) * s.w * (1 + s.spread * t), lip.y + 0.12 - 0.5 * G * t * t, lip.z + s.zoff + bow + v0 * t);
      N.set(0, v0, G * t).normalize();
      b.vert(P, N, u, t, s.layer, sN, s.seed);
    });
  }
  // Ropes: narrow falling strands, each a cross of two strips so they read from the side too.
  const ropes = [-0.49, -0.27, -0.08, 0.15, 0.33, 0.5];
  ropes.forEach((r, k) => {
    const x0 = fx + r * W, lip = lipFor(x0);
    const v0 = 4.5 + rand() * 0.9, w = 0.28 + rand() * 0.4, seed = rand();
    const zo = (rand() - 0.3) * 0.7;
    const T = landTime(x0, lip.y + 0.1, lip.z + zo, v0, 0);
    const across = new THREE.Vector3();
    for (let strip = 0; strip < 2; strip++) {
      b.grid(2, 34, (u, sN) => {
        const t = sN * T;
        const c = new THREE.Vector3(x0 + Math.sin(t * 2.3 + k) * 0.12, lip.y + 0.1 - 0.5 * G * t * t, lip.z + zo + v0 * t);
        N.set(0, v0, G * t).normalize();
        if (strip === 0) across.set(1, 0, 0); else across.copy(N);
        const wid = w * (1 + t * 0.35);
        P.copy(c).addScaledVector(across, (u - 0.5) * wid);
        const n = strip === 0 ? N : across.set(1, 0, 0);
        b.vert(P, n, u, t, 3, sN, seed + strip * 0.37);
      });
    }
  });
  // Talus cascade: whitewater draped over the ground from the landing zone into the lake.
  {
    const cols = 15, rows = 26;
    const z0 = info.impactZ - 1.2, z1 = info.entryZ + 1.6;
    const tn = new THREE.Vector3();
    b.grid(cols, rows, (u, sN) => {
      const z = z0 + (z1 - z0) * sN;
      const wid = W * (1.12 + 0.4 * sN);
      const x = fx + (u - 0.5) * wid;
      normalAt(x, z, tn);
      const lift = 0.16 + 0.12 * (1 - sN);
      P.set(x + tn.x * lift, heightAt(x, z) + tn.y * lift, z + tn.z * lift);
      b.vert(P, tn, u, (z - z0) / 3.4, 4, sN, 0.29);
    });
  }
  return { geo: b.geometry(), maxT };
}

// Instanced camera-facing quads; per-instance centre / size / alpha / seed.
function particles(count, bounds) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const dyn = (n, k) => new THREE.InstancedBufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aCenter', dyn(count, 3));
  g.setAttribute('aSize', dyn(count, 1));
  g.setAttribute('aAlpha', dyn(count, 1));
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = rand();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  g.instanceCount = count;
  g.boundingSphere = bounds.clone(); // particles move; fixed bounds keep frustum culling working
  return g;
}

// ---- create ---------------------------------------------------------------------------------------------
export function createWaterfall(scene, f, u) {
  const info = analyseFalls(f);
  const group = new THREE.Group();
  group.name = 'waterfall';

  const { geo } = buildVeil(info);
  const fog = THREE.UniformsLib.fog;
  const veilMat = new THREE.ShaderMaterial({
    name: 'WaterfallVeil',
    uniforms: THREE.UniformsUtils.merge([fog]),
    vertexShader: veilVert, fragmentShader: veilFrag,
    transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: true,
  });
  for (const k of ['uTime', 'uSunDir', 'uSunCol', 'uAmbient', 'uHorizon', 'uZenith', 'uFoamTex']) veilMat.uniforms[k] = u[k];
  const veil = new THREE.Mesh(geo, veilMat);
  veil.renderOrder = 2;

  // Fixed bounds for the particle systems (mist can drift ~25 m downwind).
  const cz = (info.impactZ + info.entryZ) / 2;
  const bounds = new THREE.Sphere(new THREE.Vector3(info.x + 6, info.impactY + 6, cz + 6), 34);
  const partMat = (mode, blending = THREE.NormalBlending) => {
    const m = new THREE.ShaderMaterial({
      name: 'WaterfallParticles',
      uniforms: THREE.UniformsUtils.merge([fog, { uMode: { value: mode }, uBow: { value: 0.85 } }]),
      vertexShader: partVert, fragmentShader: partFrag,
      transparent: true, depthWrite: false, fog: true, blending,
    });
    for (const k of ['uTime', 'uSunDir', 'uSunCol', 'uAmbient', 'uFoamTex']) m.uniforms[k] = u[k];
    return m;
  };
  const MIST = 48, BOIL = 40, SPRAY = 110;
  const mist = new THREE.Mesh(particles(MIST, bounds), partMat(0));
  const boil = new THREE.Mesh(particles(BOIL, bounds), partMat(1));
  const spray = new THREE.Mesh(particles(SPRAY, bounds), partMat(2));
  mist.renderOrder = 6; boil.renderOrder = 4; spray.renderOrder = 5;

  veil.layers.set(LAYERS.WATER);
  for (const p of [mist, boil, spray]) p.layers.set(LAYERS.FX);
  for (const o of [veil, mist, boil, spray]) { o.layers.enable(MIRROR_LAYER); group.add(o); }
  scene.add(group);

  // Particle state
  const ms = Array.from({ length: MIST }, () => ({ t: rand(), life: 6 + rand() * 4, x: 0, y: 0, z: 0, s: 1, src: 0 }));
  // whitewater bursts: short-lived churning foam thrown up where the veil lands and where it meets the lake
  const bs = Array.from({ length: BOIL }, (_, i) => ({ t: rand(), life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 1, src: i < 28 ? 0 : 1 }));
  const respawnBoil = (b) => {
    const top = b.src === 0;
    b.x = info.x + (rand() - 0.5) * info.width * (top ? 0.95 : 1.35);
    b.z = (top ? info.impactZ - 0.4 : info.entryZ + 0.2) + (rand() - 0.5) * (top ? 1.6 : 2.2);
    b.y = Math.max(heightAt(b.x, b.z), WATER) + (top ? 0.2 : 0.05);
    b.vx = (rand() - 0.5) * 0.8; b.vy = top ? 1.2 + rand() * 1.6 : 0.4 + rand() * 0.6; b.vz = top ? 0.5 + rand() * 1.0 : 0.3 + rand() * 0.6;
    b.s = top ? 1.3 + rand() * 1.5 : 1.1 + rand() * 1.1;
    b.life = top ? 0.9 + rand() * 0.8 : 1.2 + rand() * 1.0;
  };
  bs.forEach((b) => { respawnBoil(b); b.t = rand(); });
  const sp = Array.from({ length: SPRAY }, () => ({ life: 0, max: 1, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, s: 0.08 }));
  // Sources: in front of the landing zone (billows up), over the lake entry, and along the veil's face.
  const respawnMist = (m) => {
    const r = rand();
    m.src = r < 0.55 ? 0 : r < 0.85 ? 1 : 2;
    const W = info.width;
    if (m.src === 0) {
      m.x = info.x + (rand() - 0.5) * W * 1.2; m.z = info.impactZ + 0.8 + rand() * 3.5;
      m.y = Math.max(heightAt(m.x, m.z), WATER) + 1.4 + rand() * 1.5;
    } else if (m.src === 1) {
      m.x = info.x + (rand() - 0.5) * W * 1.6; m.z = info.entryZ + 0.5 + rand() * 4;
      m.y = WATER + 0.8 + rand();
    } else {
      m.x = info.x + (rand() - 0.5) * W * 0.9; m.y = info.lipY - 3 - rand() * (info.lipY - info.impactY - 5);
      m.z = info.lipZ + info.v0 * Math.sqrt(Math.max(info.lipY - m.y, 0) / (0.5 * G)) + 1.2 + rand() * 1.5;
    }
    m.s = 0.8 + rand() * 0.6;
    m.life = 8 + rand() * 6;
  };
  ms.forEach((m) => { respawnMist(m); m.t = rand(); });

  let seen = 0; // seconds since the falls were last drawn
  veil.onBeforeRender = () => { seen = 0; };
  mist.onBeforeRender = () => { seen = 0; };
  const wind = u.uWind.value;

  return {
    group, info, veil, mist, boil, spray,
    update(dt, time, player) {
      seen += dt;
      const far = Math.hypot(player.x - info.x, player.z - cz) > 260;
      if (seen > 1.0 && far) return; // nobody is looking: stop simulating
      // --- mist
      const mp = mist.geometry.attributes.aCenter.array, msz = mist.geometry.attributes.aSize.array, mal = mist.geometry.attributes.aAlpha.array;
      for (let i = 0; i < MIST; i++) {
        const m = ms[i];
        m.t += dt / m.life;
        if (m.t >= 1) { m.t -= 1; respawnMist(m); }
        const t = m.t, age = t * m.life;
        const rise = (m.src === 0 ? 0.55 : m.src === 1 ? 0.22 : 0.15) * age * (1 - t * 0.35);
        const drift = age * (m.src === 0 ? 0.55 : 0.4);
        mp[i * 3] = m.x + wind.x * drift + Math.sin(time * 0.4 + i) * 0.6;
        mp[i * 3 + 1] = m.y + rise + Math.sin(time * 0.3 + i * 1.7) * 0.3;
        mp[i * 3 + 2] = m.z + wind.y * drift + age * 0.3 + Math.cos(time * 0.35 + i) * 0.6;
        msz[i] = (m.src === 2 ? 2.5 + t * 4.5 : 3.5 + t * 8.5) * m.s;
        mal[i] = (m.src === 0 ? 0.075 : m.src === 1 ? 0.05 : 0.045) * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (1 - t * 0.3);
      }
      mist.geometry.attributes.aCenter.needsUpdate = mist.geometry.attributes.aSize.needsUpdate = mist.geometry.attributes.aAlpha.needsUpdate = true;
      // --- whitewater bursts
      const bp = boil.geometry.attributes.aCenter.array, bsz = boil.geometry.attributes.aSize.array, bal = boil.geometry.attributes.aAlpha.array;
      for (let i = 0; i < BOIL; i++) {
        const b = bs[i];
        b.t += dt / b.life;
        if (b.t >= 1) { b.t -= 1; respawnBoil(b); }
        const age = b.t * b.life;
        bp[i * 3] = b.x + b.vx * age;
        bp[i * 3 + 1] = b.y + b.vy * age - 1.6 * age * age;
        bp[i * 3 + 2] = b.z + b.vz * age;
        bsz[i] = b.s * (0.55 + 1.1 * b.t);
        bal[i] = (b.src === 0 ? 0.8 : 0.7) * Math.sin(Math.PI * Math.min(1, b.t * 1.6)) * (1 - b.t * 0.6);
      }
      boil.geometry.attributes.aCenter.needsUpdate = boil.geometry.attributes.aSize.needsUpdate = boil.geometry.attributes.aAlpha.needsUpdate = true;
      // --- spray
      const pp = spray.geometry.attributes.aCenter.array, psz = spray.geometry.attributes.aSize.array, pal = spray.geometry.attributes.aAlpha.array;
      for (let i = 0; i < SPRAY; i++) {
        const s = sp[i];
        s.life -= dt;
        if (s.life <= 0) {
          const top = rand() < 0.72;
          const a = rand() * Math.PI * 2, spd = 1.2 + rand() * 3.2;
          s.x = info.x + (rand() - 0.5) * info.width * (top ? 1 : 1.3);
          s.z = (top ? info.impactZ : info.entryZ) + (rand() - 0.5);
          s.y = Math.max(heightAt(s.x, s.z), WATER) + 0.2;
          s.vx = Math.cos(a) * spd * 0.7; s.vz = Math.abs(Math.sin(a)) * spd + 0.4; s.vy = 2.2 + rand() * (top ? 4.5 : 2.5);
          s.life = s.max = 0.7 + rand() * 0.8;
          s.s = 0.05 + rand() * 0.09;
        }
        s.vy -= G * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        if (s.y < heightAt(s.x, s.z) || s.y < WATER) s.life = 0;
        const k = Math.max(s.life, 0) / s.max;
        pp[i * 3] = s.x; pp[i * 3 + 1] = s.y; pp[i * 3 + 2] = s.z;
        psz[i] = s.s * (1.2 - 0.4 * k);
        pal[i] = 0.85 * k;
      }
      spray.geometry.attributes.aCenter.needsUpdate = spray.geometry.attributes.aSize.needsUpdate = spray.geometry.attributes.aAlpha.needsUpdate = true;
    },
  };
}
