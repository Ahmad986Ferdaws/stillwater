import * as THREE from 'three';
import { mulberry32 } from '../noise.js';
import { cyl, merge, paint, prep, jitter, standard } from './geo.js';
import { makeTree, makeGrandmother, makeRock } from './trees.js';
import { leafMaterial, barkMaterial, rockMaterial, useFoliage } from './foliage.js';
import { heightAt, layout, ISLAND, LAKE } from './terrain.js';
import { colliders, platforms } from './colliders.js';

const rnd = mulberry32(4242);
const stoneMat = standard();
// Hero trees: full-detail foliage, no LOD (uLodSide 0). Big trees sway less.
let heroMats, elderMats;
function mats() {
  if (!heroMats) {
    heroMats = { bark: barkMaterial(0, [0.05, 0.06, 0.03]), leaf: leafMaterial(0, [0.05, 0.06, 0.03]) };
    elderMats = { bark: barkMaterial(0, [0.01, 0.05, 0.03]), leaf: leafMaterial(0, [0.01, 0.05, 0.03]) };
  }
}

// Bark + leaves as one group; both cast (alpha-tested) shadows.
function heroTree(t, m, x, y, z, ry = 0, scale = 1) {
  const g = new THREE.Group();
  for (const [geo, mat] of [[t.bark, m.bark], [t.leaves, m.leaf]]) {
    if (!geo || geo.index.count === 0) continue;
    const mesh = useFoliage(new THREE.Mesh(geo, mat), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  g.position.set(x, y, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  return g;
}

function box(w, h, d, color, x, y, z, ry = 0, shade) {
  const g = prep(new THREE.BoxGeometry(w, h, d));
  g.rotateY(ry);
  g.translate(x, y, z);
  return paint(g, color, shade);
}

const mossTop = (base, moss = '#7fa84e') => {
  const b = new THREE.Color(base), m = new THREE.Color(moss);
  return (c, p) => c.copy(b).lerp(m, THREE.MathUtils.clamp((p.y % 3.5) / 3.5 - 0.55, 0, 1) * 0.9);
};

function stoneBlock(w, h, d, x, y, z, ry = 0) {
  const g = prep(new THREE.BoxGeometry(w, h, d, 2, 3, 2));
  jitter(g, 0.12);
  g.rotateY(ry);
  g.translate(x, y + h / 2, z);
  const top = y + h;
  return paint(g, '#b1aa9a', (c, p) => {
    c.set('#b4ad9d').lerp(new THREE.Color('#8f897c'), (Math.sin(p.x * 3 + p.y * 2) + 1) * 0.15);
    if (p.y > top - 0.35) c.lerp(new THREE.Color('#7fa84e'), 0.8);
  });
}

function mesh(geo, mat, x, y, z, ry = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

// ---- Individual landmarks -------------------------------------------------
function dock(group) {
  const d = layout.dock;
  const L = 22, W = 2.6, deckY = 1.05;
  const parts = [];
  for (let s = -3; s < L; s += 0.46) {
    parts.push(box(W, 0.1, 0.4, rnd() < 0.5 ? '#a47d55' : '#94704b', 0, deckY, s));
  }
  for (let s = -2; s < L; s += 4) {
    for (const x of [-W / 2 + 0.1, W / 2 - 0.1]) {
      const wx = d.x + d.dirX * s + Math.cos(d.angle) * x;
      const wz = d.z + d.dirZ * s - Math.sin(d.angle) * x;
      const bottom = heightAt(wx, wz) - 0.4;
      parts.push(cyl(0.12, 0.14, deckY + 0.5 - bottom, 6, '#6b4f36', x, bottom, s));
    }
  }
  // lantern post at the end
  parts.push(cyl(0.07, 0.08, 1.6, 6, '#5c4330', W / 2 - 0.25, deckY, (L - 0.6)));
  parts.push(box(0.26, 0.3, 0.26, '#ffe9b0', W / 2 - 0.25, deckY + 1.7, (L - 0.6)));
  parts.push(box(0.34, 0.06, 0.34, '#4a3526', W / 2 - 0.25, deckY + 1.88, (L - 0.6)));
  const g = merge(parts);
  const m = mesh(g, stoneMat, d.x, 0, d.z, d.angle);
  group.add(m);
  platforms.push({ x: d.x + d.dirX * (L - 3) / 2, z: d.z + d.dirZ * (L - 3) / 2, angle: d.angle, hw: W / 2, hl: (L + 3) / 2, y: deckY + 0.05 });

  // Rowboat bobbing beside the dock
  const hullPts = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; hullPts.push(new THREE.Vector2(Math.sin(t * Math.PI / 2) * 1, -Math.cos(t * Math.PI / 2) * 0.55)); }
  const hull = prep(new THREE.LatheGeometry(hullPts, 14));
  hull.scale(0.75, 1, 1.9);
  paint(hull, '#c86a45', (c, p) => { if (p.y > -0.12) c.set('#f1e6d2'); });
  const boat = mesh(hull, standard({ side: THREE.DoubleSide }), d.x + d.dirX * (L - 5) + Math.cos(d.angle) * 2.8, 0.18, d.z + d.dirZ * (L - 5) - Math.sin(d.angle) * 2.8, d.angle + 0.25);
  group.add(boat);
  return { boat };
}

function isle(group) {
  const y = heightAt(ISLAND.x, ISLAND.z);
  mats();
  group.add(heroTree(makeTree('cherry', mulberry32(9), { hero: true, cards: 1.35 }), heroMats, ISLAND.x, y - 0.1, ISLAND.z, 0.4, 1.7));
  colliders.add(ISLAND.x, ISLAND.z, 0.6);
  // stone lantern
  const lx = ISLAND.x + 3.2, lz = ISLAND.z + 2.4, ly = heightAt(lx, lz);
  const parts = [
    box(0.7, 0.25, 0.7, '#a9a397', 0, 0.12, 0),
    cyl(0.14, 0.18, 0.9, 6, '#b0aa9e', 0, 0.25, 0),
    box(0.6, 0.45, 0.6, '#b8b2a6', 0, 1.35, 0),
    box(0.3, 0.22, 0.62, '#ffe1a0', 0, 1.35, 0),
  ];
  const roof = prep(new THREE.ConeGeometry(0.62, 0.5, 4));
  roof.rotateY(Math.PI / 4); roof.translate(0, 1.82, 0); paint(roof, '#9d978b');
  parts.push(roof);
  group.add(mesh(merge(parts), stoneMat, lx, ly, lz, 0.3));
  colliders.add(lx, lz, 0.45);
}

function ruins(group) {
  const L = layout.landmarks.find((l) => l.id === 'ruins');
  const y = heightAt(L.x, L.z);
  const parts = [];
  // floor
  const floor = prep(new THREE.CylinderGeometry(9, 9.4, 0.5, 20));
  floor.translate(0, 0.0, 0);
  parts.push(paint(floor, '#b8b09f', (c, p) => c.lerp(new THREE.Color('#9a9383'), (Math.sin(p.x * 1.7) * Math.cos(p.z * 1.3) + 1) * 0.3)));
  // arch
  parts.push(stoneBlock(1.5, 6.5, 1.5, -2.6, 0, 0));
  parts.push(stoneBlock(1.5, 6.5, 1.5, 2.6, 0, 0));
  parts.push(stoneBlock(7.2, 1.1, 1.8, 0, 6.5, 0));
  // sun disc in the arch
  const disc = prep(new THREE.TorusGeometry(1.2, 0.18, 8, 24));
  disc.translate(0, 4.5, 0); paint(disc, '#e2c26a');
  parts.push(disc);
  // broken ring of pillars
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const h = 1.2 + rnd() * 3.8;
    const x = Math.cos(a) * 7.5, z = Math.sin(a) * 7.5;
    if (i === 3) {
      const g = stoneBlock(1, 4.2, 1, 0, -2.1, 0);
      g.rotateZ(Math.PI / 2 - 0.1); g.rotateY(a); g.translate(x, 0.5, z);
      parts.push(g);
    } else {
      parts.push(stoneBlock(1.05, h, 1.05, x, 0, z, a));
      colliders.add(L.x + x, L.z + z, 0.85);
    }
  }
  colliders.add(L.x - 2.6, L.z, 1.1);
  colliders.add(L.x + 2.6, L.z, 1.1);
  const m = mesh(merge(parts), stoneMat, L.x, y + 0.05, L.z, 0);
  group.add(m);
  platforms.push({ x: L.x, z: L.z, angle: 0, hw: 6.2, hl: 6.2, y: y + 0.3 });
}

function grandmotherTree(group) {
  const L = layout.landmarks.find((l) => l.id === 'tree');
  const y = heightAt(L.x, L.z);
  // The old blob tree drew 100 numbers from the shared landmark RNG; keep the sequence identical so
  // every landmark after this one stays exactly as it was.
  for (let i = 0; i < 100; i++) rnd();
  mats();
  group.add(heroTree(makeGrandmother(mulberry32(1717)), elderMats, L.x, y - 0.3, L.z, 0.2, 1));
  colliders.add(L.x, L.z, 2.6);
}

function standingStones(group) {
  const L = layout.landmarks.find((l) => l.id === 'stones');
  const parts = [];
  const y0 = heightAt(L.x, L.z);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const x = Math.cos(a) * 9, z = Math.sin(a) * 9;
    const h = 2.6 + rnd() * 1.6;
    const gy = heightAt(L.x + x, L.z + z) - y0 - 0.3;
    const g = stoneBlock(1.3, h, 0.8, x, gy, z, -a + Math.PI / 2);
    g.translate(0, 0, 0);
    parts.push(g);
    colliders.add(L.x + x, L.z + z, 0.85);
  }
  parts.push(stoneBlock(2.6, 0.7, 1.6, 0, -0.2, 0, 0.3));
  colliders.add(L.x, L.z, 1.3);
  group.add(mesh(merge(parts), stoneMat, L.x, y0, L.z));
}

function windmill(group) {
  const L = layout.landmarks.find((l) => l.id === 'windmill');
  const y = heightAt(L.x, L.z) - 0.3;
  const toward = Math.atan2(LAKE.x - L.x, LAKE.z - L.z);
  const tower = cyl(2.0, 2.8, 9, 10, '#efe6d6', 0, 0, 0, '#f7f1e6');
  const roof = prep(new THREE.ConeGeometry(2.5, 3, 10));
  roof.translate(0, 10.5, 0);
  paint(roof, '#b0553d', (c, p) => c.lerp(new THREE.Color('#8e3f2f'), (10.5 - p.y) * 0.1));
  const door = box(1.1, 1.9, 0.3, '#6b4b33', 0, 0.95, 2.7);
  const win = box(0.7, 0.7, 0.3, '#5d7fa0', 0, 5.5, 2.35);
  const parts = [tower, roof, door, win];
  group.add(mesh(merge(parts), stoneMat, L.x, y, L.z, toward));
  colliders.add(L.x, L.z, 3.0);

  // sails
  const sailParts = [];
  for (let i = 0; i < 4; i++) {
    const arm = box(0.2, 5.4, 0.15, '#6b4b33', 0, 2.9, 0);
    const sail = box(1.3, 4.2, 0.06, '#f4ecdc', 0.75, 3.3, 0.05);
    const g = merge([arm, sail]);
    g.rotateZ((i / 4) * Math.PI * 2);
    sailParts.push(g);
  }
  sailParts.push(cyl(0.3, 0.3, 0.6, 8, '#5a4030', 0, -0.3, 0));
  const sails = new THREE.Mesh(merge(sailParts), stoneMat);
  sails.castShadow = true;
  const hub = new THREE.Group();
  hub.position.set(L.x + Math.sin(toward) * 2.8, y + 8, L.z + Math.cos(toward) * 2.8);
  hub.rotation.y = toward;
  hub.add(sails);
  group.add(hub);
  return { sails };
}

function bench(group) {
  const L = layout.landmarks.find((l) => l.id === 'bench');
  const y = heightAt(L.x, L.z);
  const face = Math.atan2(LAKE.x - L.x, LAKE.z - L.z);
  const parts = [
    box(2.2, 0.1, 0.55, '#a07650', 0, 0.5, 0),
    box(2.2, 0.45, 0.08, '#a07650', 0, 0.85, -0.27),
    box(0.1, 0.5, 0.5, '#5a4232', -0.95, 0.25, 0),
    box(0.1, 0.5, 0.5, '#5a4232', 0.95, 0.25, 0),
  ];
  group.add(mesh(merge(parts), stoneMat, L.x, y, L.z, face));
  const tx = L.x - Math.cos(face) * 3.4, tz = L.z + Math.sin(face) * 3.4;
  mats();
  group.add(heroTree(makeTree('oak', mulberry32(12), { hero: true, cards: 1.25 }), heroMats, tx, heightAt(tx, tz) - 0.1, tz, 0, 1.25));
  colliders.add(tx, tz, 0.55);
}

function fallsRocks(group) {
  const f = layout.falls;
  if (!f) return;
  const parts = [];
  for (let i = 0; i < 9; i++) {
    // same three shape draws as the old rock builder -> seed for the new one (positions unchanged)
    const g = makeRock(mulberry32(((rnd() * 1e6) ^ (rnd() * 1e3) ^ (rnd() * 1e9)) >>> 0), 3);
    const s = 0.8 + rnd() * 1.4;
    g.scale(s, s, s);
    const x = f.x + (rnd() - 0.5) * 16, z = (i < 5 ? f.baseZ - 1 : f.topZ - 2) + (rnd() - 0.5) * 4;
    g.translate(x, heightAt(x, z) - 0.2, z);
    parts.push(g);
  }
  group.add(mesh(merge(parts), rockMaterial(), 0, 0, 0));
}

export function buildLandmarks(scene) {
  const group = new THREE.Group();
  const d = dock(group);
  isle(group);
  ruins(group);
  grandmotherTree(group);
  standingStones(group);
  const w = windmill(group);
  bench(group);
  fallsRocks(group);
  scene.add(group);
  return {
    group,
    update(dt, t) {
      w.sails.rotation.z -= dt * 0.35;
      d.boat.position.y = 0.16 + Math.sin(t * 1.1) * 0.05;
      d.boat.rotation.z = Math.sin(t * 0.9) * 0.03;
    },
  };
}
