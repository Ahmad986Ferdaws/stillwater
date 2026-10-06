import * as THREE from 'three';
import * as S from '../player/sdf.js';
import { bodyMat, outlineMat, flat } from '../player/characters.js';
import { heightAt, WATER, ISLAND, LAKE } from './terrain.js';
import { LAYERS } from '../layers.js';

// Calm catch-and-release fishing: cast, wait for a nibble, reel in, admire, let it go.
// Also the fish that live in the lake (visible through the water) and occasionally jump.

export const SPECIES = [
  { id: 'minnow', name: 'Lake Minnow', min: 8, max: 14, w: 30, back: '#6f8a8a', belly: '#eef1ef', fin: '#a3b3ae' },
  { id: 'sunfish', name: 'Sunfish', min: 12, max: 22, w: 24, back: '#3f7f73', belly: '#f2a83b', fin: '#e07b2f', spots: '#2f5f57' },
  { id: 'trout', name: 'Speckled Trout', min: 25, max: 45, w: 16, back: '#5d6b3a', belly: '#f1e4c9', fin: '#8a7a4a', spots: '#2d2a1c', stripe: '#d9728a' },
  { id: 'carp', name: 'Blossom Carp', min: 30, max: 60, w: 9, back: '#f7f1ea', belly: '#ffffff', fin: '#f5b3c3', spots: '#e8603c', isle: true },
  { id: 'perch', name: 'Moonscale Perch', min: 20, max: 35, w: 5, back: '#5c6fa8', belly: '#dfe7f7', fin: '#9fb3e6', stripe: '#2f3d6b', golden: true },
  { id: 'catfish', name: 'Old Whiskers', min: 50, max: 90, w: 4, back: '#4a4038', belly: '#a89880', fin: '#3a322b', whiskers: true, deep: true },
  { id: 'koi', name: 'Golden Koi', min: 40, max: 70, w: 1.2, back: '#f2b233', belly: '#ffe7a3', fin: '#ffd36b', spots: '#ffffff' },
];

// ---- fish models (sculpted once per species, length 1 along +z) ----------------------------
const fishCache = new Map();
function hash3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
export function fishModel(sp) {
  if (!fishCache.has(sp.id)) {
    const fin = (x, y, z) => 'fin';
    const body = (x, y, z) => {
      if (sp.stripe && Math.abs(y - 0.01) < 0.022 && z < 0.3) return 'stripe';
      if (sp.spots && y > -0.02 && hash3(Math.floor(x * 40), Math.floor(y * 40), Math.floor(z * 40)) > 0.82) return 'spot';
      return y > -0.015 ? 'back' : 'belly';
    };
    const parts = [
      { d: S.ellipsoid([0, 0, 0.06], [0.085, 0.15, 0.34]), k: 0, region: body },
      { d: S.roundCone([0, 0, -0.18], [0, 0, -0.36], 0.07, 0.028), k: 0.08, region: body },
      // tail fin: thin fan
      { d: (x, y, z) => Math.max(Math.abs(x) - 0.01, -(z + 0.34), z + 0.52, Math.abs(y) - (-(z + 0.34)) * 1.25 - 0.02), k: 0.02, region: fin },
      // dorsal and belly fins
      { d: (x, y, z) => Math.max(Math.abs(x) - 0.008, -(y - 0.1), y - 0.19 + (z - 0.02) * (z - 0.02) * 3, Math.abs(z + 0.02) - 0.14), k: 0.02, region: fin },
      { d: (x, y, z) => Math.max(Math.abs(x) - 0.007, y + 0.1, -(y + 0.16) - Math.abs(z + 0.12) * 0.5, Math.abs(z + 0.12) - 0.07), k: 0.015, region: fin },
      { d: S.sphere([0.06, 0.035, 0.27], 0.022), k: 0.006, region: 'eye' },
      { d: S.sphere([-0.06, 0.035, 0.27], 0.022), k: 0.006, region: 'eye' },
    ];
    for (const s of [1, -1]) parts.push({ d: S.ellipsoid([0.08 * s, -0.05, 0.14], [0.012, 0.035, 0.06]), k: 0.01, region: fin });
    if (sp.whiskers) for (const s of [1, -1]) parts.push({ d: S.roundCone([0.04 * s, -0.03, 0.36], [0.16 * s, -0.08, 0.3], 0.012, 0.004), k: 0.01, region: 'fin' });
    const f = S.evaluator(parts);
    const m = S.meshSDF(f, [-0.2, -0.24, -0.56], [0.2, 0.24, 0.46], 0.016, 2);
    const pal = { back: sp.back, belly: sp.belly, fin: sp.fin, spot: sp.spots || sp.back, stripe: sp.stripe || sp.back, eye: '#1a1412' };
    const col = new Float32Array(m.positions.length);
    const c = new THREE.Color();
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
      f.full(x, y, z);
      let bi = 0, best = Infinity;
      for (let p = 0; p < parts.length; p++) { const v = Math.abs(f.vals[p]); if (v < best) { best = v; bi = p; } }
      const reg = parts[bi].region;
      c.set(pal[typeof reg === 'function' ? reg(x, y, z) : reg]);
      col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    fishCache.set(sp.id, g);
  }
  const g = fishCache.get(sp.id);
  const mesh = new THREE.Mesh(g, bodyMat);
  mesh.castShadow = true;
  const ol = new THREE.Mesh(g, outlineMat);
  ol.scale.setScalar(1.0);
  mesh.add(ol);
  return mesh;
}

// ---- helpers ---------------------------------------------------------------------------------
const isWater = (x, z, min = 0.6) => heightAt(x, z) < WATER - min;
const rnd = (a, b) => a + Math.random() * (b - a);

function pickSpecies(p, golden) {
  const dIsle = Math.hypot(p.x - ISLAND.x, p.z - ISLAND.z);
  const depth = WATER - heightAt(p.x, p.z);
  const ws = SPECIES.map((s) => s.w * (s.golden ? (golden > 0.4 ? 6 : 0.15) : 1) * (s.isle ? (dIsle < 45 ? 3 : 0.6) : 1) * (s.deep ? (depth > 4.5 ? 2.5 : 0.4) : 1));
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SPECIES.length; i++) { r -= ws[i]; if (r <= 0) return SPECIES[i]; }
  return SPECIES[0];
}

// ---- rod -------------------------------------------------------------------------------------
function buildRod() {
  const root = new THREE.Group();
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.3, 10).translate(0, -0.04, 0), flat('#c9a36b'));
  root.add(cork);
  const reel = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.011, 8, 16), flat('#3a3f45'));
  reel.position.set(0.035, 0.02, 0);
  reel.rotation.y = Math.PI / 2;
  root.add(reel);
  const segs = [];
  let parent = root, y = 0.11;
  const lens = [0.42, 0.38, 0.34, 0.3];
  const radii = [0.011, 0.0085, 0.0062, 0.0045, 0.0028];
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Group();
    seg.position.y = y;
    parent.add(seg);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radii[i + 1], radii[i], lens[i], 7).translate(0, lens[i] / 2, 0), flat(i % 2 ? '#6b4a2e' : '#5a3b26'));
    seg.add(m);
    const guide = new THREE.Mesh(new THREE.TorusGeometry(0.012 - i * 0.002, 0.0018, 4, 10), flat('#c9c9c9'));
    guide.position.set(0, lens[i] * 0.9, 0.012);
    seg.add(guide);
    segs.push(seg);
    parent = seg;
    y = lens[i];
  }
  const tip = new THREE.Object3D();
  tip.position.y = lens[3];
  parent.add(tip);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { root, segs, tip };
}

function buildBobber() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.04, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), flat('#e2453a'));
  const bot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), flat('#f7f3ea'));
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 5).translate(0, 0.05, 0), flat('#2a2420'));
  g.add(top, bot, stick);
  return g;
}

// ---- the system --------------------------------------------------------------------------------
export function createFishing(scene, fx, audio, ui) {
  const rod = buildRod();
  rod.root.visible = false;
  const bobber = buildBobber();
  bobber.visible = false;
  scene.add(bobber);
  const LN = 36;
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LN * 3), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#f2f2ee', transparent: true, opacity: 0.75 }));
  line.frustumCulled = false;
  line.visible = false;
  line.layers.set(LAYERS.FX);
  scene.add(line);

  const journal = (() => { try { return JSON.parse(localStorage.getItem('stillwater.fish') || '{}'); } catch { return {}; } })();
  const saveJournal = () => { try { localStorage.setItem('stillwater.fish', JSON.stringify(journal)); } catch { /* private mode */ } };

  // lake fish
  const swimmers = [];
  for (let i = 0; i < 14; i++) {
    const sp = SPECIES[i % 4 === 3 ? 2 : i % 3];
    const m = fishModel(sp);
    const size = rnd(sp.min, sp.max) / 100 * 1.4;
    m.scale.setScalar(size);
    m.visible = false;
    scene.add(m);
    swimmers.push({ m, sp, size, pos: new THREE.Vector3(0, -50, 0), vel: new THREE.Vector3(), target: new THREE.Vector3(), t: 0, jump: -1, ph: Math.random() * 10 });
  }

  const st = {
    active: false, phase: 'off', t: 0, tension: 0, target: new THREE.Vector3(), start: new THREE.Vector3(), vel0: new THREE.Vector3(),
    wait: 0, nibbles: 0, nibbleT: 0, species: null, size: 0, fish: null, visitor: null, reelDur: 2, empty: false,
    shore: new THREE.Vector3(), yaw: 0,
  };
  const tipW = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), handW = [new THREE.Vector3(), new THREE.Vector3()];
  let rig = null;

  function attachRod(r) {
    rig = r;
    rod.root.removeFromParent();
    const hand = r.hands[1];
    hand.add(rod.root);
    const puff = r.kind === 'puff';
    rod.root.position.set(puff ? -0.02 : 0.0, puff ? -0.02 : -0.078, puff ? 0.04 : 0.014);
    rod.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.52, 0.85).normalize());
    rod.root.scale.setScalar(puff ? 0.8 : 1);
  }

  // Look for open water in front of the traveller; returns the cast point or null.
  function findCast(pos, yaw) {
    for (let d = 4.5; d <= 10; d += 0.5) {
      const x = pos.x + Math.sin(yaw) * d, z = pos.z + Math.cos(yaw) * d;
      if (isWater(x, z, 0.9)) return tmp.set(x, WATER, z);
    }
    return null;
  }

  function setPhase(p) { st.phase = p; st.t = 0; }

  function start(pos, yaw) {
    const c = findCast(pos, yaw);
    if (!c) return false;
    st.active = true;
    st.yaw = yaw;
    st.target.copy(c).add(tmp2.set(rnd(-0.8, 0.8), 0, rnd(-0.8, 0.8)));
    if (!isWater(st.target.x, st.target.z, 0.6)) st.target.copy(c);
    // where a caught fish is pulled toward: the water edge in front of us
    for (let d = 1; d < 10; d += 0.25) {
      const x = pos.x + Math.sin(yaw) * d, z = pos.z + Math.cos(yaw) * d;
      if (heightAt(x, z) < WATER - 0.2) { st.shore.set(x, WATER, z); break; }
    }
    rod.root.visible = true;
    rod.root.scale.setScalar(0.001);
    setPhase('ready');
    ui.prompt('E  Cast   ·   move to put the rod away');
    return true;
  }

  function stop() {
    st.active = false;
    setPhase('off');
    bobber.visible = false;
    line.visible = false;
    rod.root.visible = false;
    if (st.fish) { st.fish.removeFromParent(); st.fish = null; }
    if (st.visitor) { st.visitor.removeFromParent(); st.visitor = null; }
    ui.prompt(null);
  }

  function press() {
    if (!st.active) return;
    if (st.phase === 'ready') { setPhase('windup'); ui.prompt(null); }
    else if (st.phase === 'wait') { st.empty = true; st.reelDur = 0.9; setPhase('reel'); ui.prompt(null); }
    else if (st.phase === 'bite') {
      st.empty = false;
      st.reelDur = 1.4 + Math.min(2.2, st.size / 30);
      setPhase('reel');
      ui.prompt(null);
      audio?.reel?.();
    } else if (st.phase === 'hold') setPhase('toss');
  }

  function land(p) {
    fx.splash(p, 0.5);
    audio?.plop?.();
  }

  function catchFish() {
    const sp = st.species;
    const fish = fishModel(sp);
    fish.scale.setScalar((st.size / 100) * 1.25);
    scene.add(fish);
    st.fish = fish;
    const rec = journal[sp.id] || { count: 0, best: 0 };
    const first = rec.count === 0;
    rec.count++;
    const best = st.size > rec.best;
    rec.best = Math.max(rec.best, st.size);
    journal[sp.id] = rec;
    saveJournal();
    ui.toast(first ? 'New catch!' : best ? 'Biggest one yet' : 'You caught', `${sp.name} · ${st.size} cm`);
    audio?.chime?.();
  }

  function lineTo(end, slack) {
    const a = lineGeo.attributes.position.array;
    for (let i = 0; i < LN; i++) {
      const t = i / (LN - 1);
      const x = tipW.x + (end.x - tipW.x) * t, y = tipW.y + (end.y - tipW.y) * t, z = tipW.z + (end.z - tipW.z) * t;
      const sag = Math.sin(t * Math.PI) * slack;
      a[i * 3] = x; a[i * 3 + 1] = y - sag; a[i * 3 + 2] = z;
    }
    lineGeo.attributes.position.needsUpdate = true;
  }

  function bendRod(amount, toward) {
    // bend each segment a little toward `toward` (world)
    for (const seg of rod.segs) seg.rotation.set(0, 0, 0);
    if (amount < 0.001) return;
    rod.root.updateMatrixWorld(true);
    const base = rod.root.getWorldPosition(tmp2.set(0, 0, 0));
    const dirW = tmp.subVectors(toward, base).normalize();
    const inv = new THREE.Quaternion();
    rod.root.getWorldQuaternion(inv).invert();
    const dl = dirW.applyQuaternion(inv);
    const axis = new THREE.Vector3(0, 1, 0).cross(dl);
    if (axis.lengthSq() < 1e-6) return;
    axis.normalize();
    rod.segs.forEach((seg, i) => seg.quaternion.setFromAxisAngle(axis, amount * (0.12 + i * 0.1)));
  }

  function update(dt, time, player, env) {
    // ---- lake fish -----------------------------------------------------------------------
    for (const f of swimmers) {
      if (f.jump >= 0) {
        f.jump += dt;
        const k = f.jump / 0.75;
        f.m.position.copy(f.pos).add(tmp.copy(f.vel).multiplyScalar(k * 1.8));
        f.m.position.y = WATER - 0.15 + Math.sin(k * Math.PI) * 1.1 * f.size / 0.3;
        f.m.rotation.x = -Math.cos(k * Math.PI) * 1.1;
        if (k >= 1) { f.jump = -1; f.pos.copy(f.m.position); f.pos.y = -0.8; land(f.m.position); }
        continue;
      }
      const far = f.pos.distanceTo(player) > 45;
      if (far || f.pos.y < -40) {
        const a = Math.random() * Math.PI * 2, r = rnd(10, 38);
        const x = player.x + Math.cos(a) * r, z = player.z + Math.sin(a) * r;
        if (!isWater(x, z, 1.1)) { f.pos.y = -99; f.m.visible = false; continue; }
        f.pos.set(x, Math.max(heightAt(x, z) + 0.35, WATER - rnd(0.45, 1.3)), z);
        f.t = 0;
      }
      f.m.visible = true;
      f.t -= dt;
      if (f.t <= 0) {
        f.t = rnd(2, 6);
        for (let k = 0; k < 6; k++) {
          const x = f.pos.x + rnd(-7, 7), z = f.pos.z + rnd(-7, 7);
          if (isWater(x, z, 1.0)) { f.target.set(x, Math.max(heightAt(x, z) + 0.35, WATER - rnd(0.45, 1.3)), z); break; }
        }
      }
      tmp.subVectors(f.target, f.pos);
      const d = tmp.length();
      tmp.normalize().multiplyScalar(d > 0.5 ? 0.9 : 0.1);
      f.vel.lerp(tmp, Math.min(1, dt * 0.8));
      f.pos.addScaledVector(f.vel, dt);
      f.m.position.copy(f.pos);
      f.m.rotation.set(0, Math.atan2(f.vel.x, f.vel.z) + Math.sin(time * 6 + f.ph) * 0.12, 0);
      // now and then someone jumps
      if (Math.random() < dt * 0.012 && f.pos.distanceTo(player) < 30 && f.pos.distanceTo(player) > 6) {
        f.jump = 0;
        f.vel.set(Math.sin(f.m.rotation.y), 0, Math.cos(f.m.rotation.y));
        land(f.pos.clone().setY(WATER));
      }
    }

    if (!st.active || !rig) return null;
    st.t += dt;
    rod.root.scale.setScalar(Math.min(1, rod.root.scale.x + dt * 5) * (rig.kind === 'puff' ? 0.8 : 1));
    rig.root.updateMatrixWorld(true);
    rod.tip.getWorldPosition(tipW);
    let pose = 'ready', expression = null, look = null;

    switch (st.phase) {
      case 'ready':
        bobber.visible = false; line.visible = false; bendRod(0);
        break;
      case 'windup':
        pose = 'windup';
        if (st.t > 0.45) {
          setPhase('cast');
          st.start.copy(tipW);
          const T = 0.9;
          st.vel0.subVectors(st.target, st.start).divideScalar(T);
          st.vel0.y += 0.5 * 9.8 * T;
          audio?.whoosh?.();
        }
        break;
      case 'cast': {
        pose = st.t < 0.35 ? 'cast' : 'ready';
        const T = 0.9, k = Math.min(st.t, T);
        bobber.visible = true; line.visible = true;
        bobber.position.copy(st.start).addScaledVector(st.vel0, k);
        bobber.position.y -= 0.5 * 9.8 * k * k;
        lineTo(bobber.position, 0.05);
        if (st.t >= T) {
          bobber.position.copy(st.target).setY(WATER + 0.01);
          land(bobber.position);
          setPhase('wait');
          st.wait = rnd(4, 13);
          st.nibbles = 1 + Math.floor(Math.random() * 3);
          st.nibbleT = 0;
          st.species = null;
          ui.prompt('E  Reel in   ·   move to put the rod away');
        }
        break;
      }
      case 'wait': {
        pose = 'ready';
        look = bobber.position;
        const bob = Math.sin(time * 2.2) * 0.012;
        let dip = 0;
        // a fish swims up to the bobber, nibbles, then bites
        if (st.t > st.wait - 3 && !st.visitor) {
          st.species = pickSpecies(st.target, env.golden);
          st.size = Math.round(rnd(st.species.min, st.species.max) - (st.species.max - st.species.min) * 0.35 * Math.random());
          const v = fishModel(st.species);
          v.scale.setScalar((st.size / 100) * 1.25);
          scene.add(v);
          st.visitor = v;
          const a = Math.random() * Math.PI * 2;
          v.userData.from = new THREE.Vector3(st.target.x + Math.cos(a) * 5, WATER - 0.7, st.target.z + Math.sin(a) * 5);
        }
        if (st.visitor) {
          const k = THREE.MathUtils.clamp((st.t - (st.wait - 3)) / 2.6, 0, 1);
          const e = k * k * (3 - 2 * k);
          st.visitor.position.lerpVectors(st.visitor.userData.from, tmp.copy(st.target).setY(WATER - 0.45), e);
          st.visitor.rotation.set(0, Math.atan2(st.target.x - st.visitor.userData.from.x, st.target.z - st.visitor.userData.from.z) + Math.sin(time * 7) * 0.1, 0);
        }
        if (st.t > st.wait) {
          st.nibbleT += dt;
          if (st.nibbleT > 0.9) {
            st.nibbleT = 0;
            st.nibbles--;
            fx.ring(bobber.position, 0.7, 0.9);
            audio?.tick?.();
            if (st.nibbles < 0) {
              setPhase('bite');
              fx.splash(bobber.position, 0.6);
              audio?.plop?.();
              ui.prompt('E  Reel in!', true);
            }
          }
          dip = Math.max(0, Math.sin(st.nibbleT * Math.PI / 0.25)) * 0.05 * (st.nibbleT < 0.25 ? 1 : 0);
        }
        bobber.position.set(st.target.x, WATER + 0.01 + bob - dip, st.target.z);
        lineTo(bobber.position, 0.35);
        bendRod(0.05, bobber.position);
        break;
      }
      case 'bite': {
        pose = 'bite'; expression = 'o'; look = bobber.position;
        bobber.position.y = WATER - 0.16 + Math.sin(time * 20) * 0.02;
        lineTo(bobber.position, 0.02);
        bendRod(0.35, bobber.position);
        if (st.t > 1.5) {
          ui.prompt('E  Reel in   ·   move to put the rod away');
          ui.toast('', 'It got away…', 2.5);
          if (st.visitor) { st.visitor.removeFromParent(); st.visitor = null; }
          setPhase('wait');
          st.wait = rnd(4, 11);
          st.nibbles = 1 + Math.floor(Math.random() * 3);
        }
        break;
      }
      case 'reel': {
        pose = 'reel'; look = bobber.position;
        const k = Math.min(1, st.t / st.reelDur);
        st.tension = st.empty ? 0.1 : 1 - k * 0.4;
        const wob = st.empty ? 0 : Math.sin(time * 9) * 0.6 * (1 - k);
        tmp.lerpVectors(st.target, st.shore, k);
        tmp.x += Math.cos(st.yaw) * wob; tmp.z -= Math.sin(st.yaw) * wob;
        bobber.position.set(tmp.x, WATER + (st.empty ? 0.01 : -0.05), tmp.z);
        if (st.visitor) { st.visitor.position.copy(bobber.position).setY(WATER - 0.2); st.visitor.rotation.y = st.yaw + Math.PI + Math.sin(time * 14) * 0.5; }
        if (!st.empty && Math.random() < dt * 5) fx.splash(bobber.position, 0.3);
        lineTo(bobber.position, 0.0);
        bendRod(st.empty ? 0.08 : 0.55 * st.tension, bobber.position);
        if (k >= 1) {
          if (st.empty) { setPhase('ready'); bobber.visible = false; line.visible = false; ui.prompt('E  Cast   ·   move to put the rod away'); }
          else {
            if (st.visitor) { st.visitor.removeFromParent(); st.visitor = null; }
            catchFish();
            st.fish.userData.from = bobber.position.clone();
            bobber.visible = false; line.visible = false;
            fx.splash(st.shore, 0.8);
            setPhase('catch');
          }
        }
        break;
      }
      case 'catch':
      case 'hold': {
        pose = 'hold'; expression = 'smile';
        bendRod(0);
        rig.hands[0].getWorldPosition(handW[0]);
        rig.hands[1].getWorldPosition(handW[1]);
        tmp.addVectors(handW[0], handW[1]).multiplyScalar(0.5);
        tmp.y += 0.06;
        const fish = st.fish;
        if (st.phase === 'catch') {
          const k = Math.min(1, st.t / 0.5);
          fish.position.lerpVectors(fish.userData.from, tmp, k);
          fish.position.y += Math.sin(k * Math.PI) * 1.0;
          fish.rotation.set(0, st.yaw + Math.PI / 2, 0);
          if (k >= 1) { setPhase('hold'); ui.prompt('E  Let it go'); }
        } else {
          fish.position.copy(tmp);
          fish.rotation.set(Math.sin(time * 11) * 0.15, st.yaw + Math.PI / 2 + Math.sin(time * 7) * 0.25, Math.sin(time * 9) * 0.3);
          look = fish.position;
          if (st.t > 4) setPhase('toss');
        }
        break;
      }
      case 'toss': {
        pose = 'toss'; expression = 'smile';
        const fish = st.fish;
        if (!fish.userData.tossFrom) {
          fish.userData.tossFrom = fish.position.clone();
          fish.userData.tossTo = st.shore.clone().add(tmp2.set(Math.sin(st.yaw) * 1.5, 0, Math.cos(st.yaw) * 1.5));
          ui.prompt(null);
        }
        const k = Math.min(1, st.t / 0.7);
        fish.position.lerpVectors(fish.userData.tossFrom, fish.userData.tossTo, k);
        fish.position.y += Math.sin(k * Math.PI) * 0.9;
        fish.rotation.x += dt * 8;
        if (k >= 1) {
          land(fish.userData.tossTo);
          fish.removeFromParent();
          st.fish = null;
          setPhase('ready');
          ui.prompt('E  Cast   ·   move to put the rod away');
        }
        break;
      }
    }
    return { pose, t: st.t, tension: st.tension, expression, look, yaw: st.yaw };
  }

  return {
    attachRod, start, stop, press, update,
    get active() { return st.active; },
    canFish: (pos, yaw) => !!findCast(pos, yaw),
    journal: () => SPECIES.map((s) => ({ name: s.name, ...(journal[s.id] || { count: 0, best: 0 }) })),
  };
}
