import * as THREE from 'three';
import * as S from './sdf.js';

// Travellers are sculpted from smooth signed-distance shapes into one seamless skinned mesh
// (no visible joints), with real bones, modelled eyes that blink and look around, hair, hats,
// jiggle bones for accessories and simulated cloth (tunic hems, scarves, aprons).
// Proportions follow modern stylised adventure games: long legs, slightly large head.

export const CHAR_SCALE = 1.12;

// ---- materials ---------------------------------------------------------------------
const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([105, 165, 222, 255]), 4, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

function toonMaterial(opts = {}) {
  const m = new THREE.MeshToonMaterial({ gradientMap, ...opts });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <opaque_fragment>', `
      {
        // soft rim light; back faces (inside of cloth) read slightly darker
        float rim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        outgoingLight += diffuseColor.rgb * rim * 0.28;
        outgoingLight *= gl_FrontFacing ? 1.0 : 0.72;
      }
      #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'toon-rim-' + (m.side === THREE.DoubleSide ? 'd' : 's');
  return m;
}
export const bodyMat = toonMaterial({ vertexColors: true });
export const clothMat = toonMaterial({ vertexColors: true, side: THREE.DoubleSide });

export const outlineMat = new THREE.MeshBasicMaterial({ color: '#2b211c', side: THREE.BackSide });
outlineMat.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>
    #ifdef USE_SKINNING
      transformed += normalize(objectNormal) * 0.0085;
    #else
      transformed += normal * 0.0085;
    #endif`);
};
outlineMat.customProgramCacheKey = () => 'outline';

const flatCache = new Map();
export function flat(color, basic = false) {
  const key = color + basic;
  if (!flatCache.has(key)) flatCache.set(key, basic ? new THREE.MeshBasicMaterial({ color }) : toonMaterial({ color }));
  return flatCache.get(key);
}

// ---- helpers -----------------------------------------------------------------------------
const lerp3 = (a, b, t, off = [0, 0, 0]) => [a[0] + (b[0] - a[0]) * t + off[0], a[1] + (b[1] - a[1]) * t + off[1], a[2] + (b[2] - a[2]) * t + off[2]];

function geometryFrom(mesh, colors, skin) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (skin) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.skinWeight, 4));
  }
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return g;
}

function paintRegions(regions, palette) {
  const out = new Float32Array(regions.length * 3);
  const cache = {};
  regions.forEach((r, i) => {
    if (!cache[r]) cache[r] = new THREE.Color(palette[r] || palette.default || '#ff00ff');
    const c = cache[r];
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  });
  return out;
}

// Rigid sculpted piece (hair, hood, bags…) attached to a bone. Coordinates are bind-pose world.
function sculptPiece(parts, min, max, h, palette, bone, origin) {
  const f = S.evaluator(parts);
  const m = S.meshSDF(f, min, max, h, 2);
  const regions = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    f.full(x, y, z);
    let bi = -1, best = Infinity;
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].cut || !parts[p].region) continue;
      const v = Math.abs(f.vals[p]);
      if (v < best) { best = v; bi = p; }
    }
    const reg = parts[bi].region;
    regions.push(typeof reg === 'function' ? reg(x, y, z) : reg);
    m.positions[i] = x - origin[0]; m.positions[i + 1] = y - origin[1]; m.positions[i + 2] = z - origin[2];
  }
  const geo = geometryFrom(m, paintRegions(regions, palette));
  const mesh = new THREE.Mesh(geo, bodyMat);
  mesh.castShadow = true;
  mesh.add(new THREE.Mesh(geo, outlineMat));
  if (bone) bone.add(mesh);
  return mesh;
}

// Find the surface along +z at (x, y) — used to seat eyes, brows and mouths on the face.
function surfaceZ(f, x, y, z0, z1 = -0.3) {
  let a = z0, b = z1;
  if (f(x, y, a) < 0) return a;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (f(x, y, m) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

// ---- skeleton ------------------------------------------------------------------------------
const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL',
  shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  thighL: 'hips', kneeL: 'thighL', footL: 'kneeL',
  thighR: 'hips', kneeR: 'thighR', footR: 'kneeR',
  tail1: 'hips', tail2: 'tail1', tail3: 'tail2',
};

function humanJoints(o = {}) {
  const sw = o.shoulders ?? 1, hw = o.hips ?? 1;
  const J = { hips: [0, 0.97, 0], spine: [0, 1.07, 0], chest: [0, 1.25, 0], neck: [0, 1.47, 0], head: [0, 1.56, 0] };
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    const shx = 0.172 * sw * s;
    J['shoulder' + k] = [shx, 1.415, -0.005];
    J['elbow' + k] = [shx + 0.031 * s, 1.148, -0.012];
    J['hand' + k] = [shx + 0.05 * s, 0.905, 0.002];
    const thx = 0.092 * hw * s;
    J['thigh' + k] = [thx, 0.93, 0];
    J['knee' + k] = [thx + 0.005 * s, 0.52, 0.012];
    J['foot' + k] = [thx + 0.008 * s, 0.095, -0.012];
  }
  return J;
}

// ---- the humanoid sculpt ----------------------------------------------------------------------
function humanParts(J, o) {
  const hs = o.head ?? 1.06, sw = o.shoulders ?? 1, hw = o.hips ?? 1, lw = o.limbs ?? 1;
  const HC = [0, 1.695, 0.012];
  const hp = (dx, dy, dz) => [HC[0] + dx * hs, HC[1] + dy * hs, HC[2] + dz * hs];
  const P = [];
  const add = (d, k, region, bone, extra = {}) => P.push({ d, k, region, bone, ...extra });
  const top = o.topRegion || 'top';

  // torso
  add(S.ellipsoid([0, 0.945, 0], [0.15 * hw, 0.112, 0.112]), 0, o.pelvisRegion || 'pants', 'hips', { sigma: 0.035 });
  add(S.ellipsoid([0, 1.075, 0.006], [0.128 * (sw + hw) / 2, 0.125, 0.098]), 0.06, top, 'spine', { sigma: 0.035 });
  add(S.ellipsoid([0, 1.265, 0.002], [0.158 * sw, 0.16, 0.106]), 0.06, top, 'chest', { sigma: 0.035 });
  add(S.ellipsoid([0, 1.3, 0.034], [0.13 * sw, 0.085, 0.08 * (o.bust ?? 1)]), 0.045, top, 'chest');
  add(S.ellipsoid([0, 1.39, -0.02], [0.12 * sw, 0.07, 0.07]), 0.05, top, 'chest');

  // neck + head
  add(S.roundCone([0, 1.4, -0.004], [0, 1.6, 0.006], 0.057, 0.05), 0.04, o.neckRegion || 'skin', 'neck', { sigma: 0.03 });
  add(S.ellipsoid(hp(0, 0, 0), [0.118 * hs, 0.137 * hs, 0.127 * hs]), 0.02, 'skin', 'head');
  add(S.ellipsoid(hp(0, -0.073, 0.024), [0.085 * hs, 0.067 * hs, 0.094 * hs]), 0.045, o.jawRegion || 'skin', 'head');
  add(S.sphere(hp(0, -0.11, 0.066), 0.03 * hs), 0.03, o.jawRegion || 'skin', 'head');
  for (const s of [1, -1]) add(S.sphere(hp(0.058 * s, -0.052, 0.072), 0.036 * hs), 0.035, o.jawRegion || 'skin', 'head');
  if (!o.snout) add(S.roundCone(hp(0, -0.004, 0.112), hp(0, -0.032, 0.137), 0.011 * hs, 0.0145 * hs), 0.014, 'skin', 'head');
  add(S.ellipsoid(hp(0, 0.022, 0.1), [0.085 * hs, 0.02 * hs, 0.03 * hs]), 0.03, 'skin', 'head');
  for (const s of [1, -1]) P.push({ d: S.ellipsoid(hp(0.043 * s, 0.004, 0.118), [0.026 * hs, 0.019 * hs, 0.018 * hs]), k: 0.012, region: 'skin', sub: true });
  if (o.snout) {
    add(S.ellipsoid(hp(0, -0.045, 0.118), [0.05 * hs, 0.042 * hs, 0.07 * hs]), 0.03, 'furLight', 'head');
    add(S.sphere(hp(0, -0.022, 0.182), 0.019 * hs), 0.01, 'nose', 'head');
    for (const s of [1, -1]) add(S.ellipsoid(hp(0.09 * s, -0.07, 0.03), [0.035 * hs, 0.04 * hs, 0.04 * hs]), 0.03, 'furLight', 'head');
  }
  if (o.ears === 'round') {
    for (const s of [1, -1]) add(S.ellipsoid(hp(0.116 * s, -0.012, -0.004), [0.018 * hs, 0.033 * hs, 0.026 * hs]), 0.012, 'skin', 'head');
  } else if (o.ears === 'point') {
    for (const s of [1, -1]) add(S.roundCone(hp(0.108 * s, -0.005, -0.004), hp(0.176 * s, 0.042, -0.034), 0.021 * hs, 0.004), 0.012, 'skin', 'head');
  }

  // arms
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    const sh = J['shoulder' + k], el = J['elbow' + k], wr = J['hand' + k];
    add(S.sphere([sh[0] - 0.008 * s, sh[1] - 0.01, sh[2]], 0.062 * lw), 0.05, o.shoulderRegion || 'sleeve', null, { bones: [['shoulder' + k, 0.55], ['chest', 0.45]] });
    add(S.roundCone(sh, el, 0.052 * lw, 0.041 * lw), 0.03, 'sleeve', 'shoulder' + k);
    add(S.ellipsoid(lerp3(sh, el, 0.45, [0, 0, 0.012]), [0.044 * lw, 0.085, 0.046 * lw]), 0.03, 'sleeve', 'shoulder' + k);
    add(S.roundCone(el, wr, 0.043 * lw, 0.032 * lw), 0.025, 'forearm', 'elbow' + k);
    add(S.ellipsoid(lerp3(el, wr, 0.3), [0.043 * lw, 0.07, 0.041 * lw]), 0.03, 'forearm', 'elbow' + k);
    if (o.cuffs) add(S.torus(lerp3(el, wr, 0.72), 0.041 * lw, 0.041 * lw, 0.012), 0.006, 'cuff', 'elbow' + k);
    add(S.roundBox([wr[0] + 0.003 * s, wr[1] - 0.062, wr[2] + 0.006], [0.021, 0.047, 0.037], 0.019), 0.022, 'hand', 'hand' + k);
    add(S.roundBox([wr[0] + 0.004 * s, wr[1] - 0.105, wr[2] + 0.012], [0.018, 0.022, 0.032], 0.016), 0.014, 'hand', 'hand' + k);
    add(S.roundCone([wr[0] - 0.006 * s, wr[1] - 0.025, wr[2] + 0.03], [wr[0] - 0.014 * s, wr[1] - 0.068, wr[2] + 0.05], 0.0135, 0.011), 0.01, 'hand', 'hand' + k);
  }

  // legs
  const bootTop = o.bootTop ?? 0.34;
  const lowerLeg = (x, y) => (y < bootTop + 0.01 ? 'boots' : 'pants');
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    const th = J['thigh' + k], kn = J['knee' + k], ft = J['foot' + k];
    add(S.roundCone(th, kn, 0.088 * lw, 0.058 * lw), 0.045, 'pants', 'thigh' + k, { sigma: 0.03 });
    add(S.ellipsoid(lerp3(th, kn, 0.4, [0, 0, 0.018]), [0.068 * lw, 0.14, 0.064 * lw]), 0.04, 'pants', 'thigh' + k);
    add(S.sphere([kn[0], kn[1] + 0.004, kn[2] + 0.018], 0.056 * lw), 0.03, 'pants', null, { bones: [['thigh' + k, 0.5], ['knee' + k, 0.5]] });
    add(S.roundCone(kn, ft, 0.056 * lw, 0.04 * lw), 0.03, lowerLeg, 'knee' + k);
    add(S.ellipsoid([kn[0], kn[1] - 0.14, kn[2] - 0.024], [0.052 * lw, 0.1, 0.052 * lw]), 0.04, lowerLeg, 'knee' + k);
    add(S.roundBox([ft[0], ft[1] - 0.05, ft[2] + 0.055], [0.046, 0.04, 0.108], 0.035), 0.035, 'boots', 'foot' + k);
    add(S.sphere([ft[0], ft[1] - 0.052, ft[2] + 0.13], 0.045), 0.03, 'boots', 'foot' + k);
    if (bootTop > 0.2) {
      const t = (bootTop - ft[1]) / (kn[1] - ft[1]);
      const topP = lerp3(ft, kn, t);
      add(S.roundCone([ft[0], ft[1], ft[2] - 0.004], topP, 0.05 * lw, 0.058 * lw), 0.012, 'boots', 'knee' + k);
      add(S.torus(topP, 0.061 * lw, 0.061 * lw, 0.018), 0.008, 'bootTrim', 'knee' + k);
    }
  }

  // outfit details
  const torsoBase = S.evaluator([P[1], P[2], P[3]]);
  if (o.belt !== false) {
    add(S.torus([0, 1.0, 0.006], 0.148 * hw, 0.113 * hw, 0.02), 0.008, 'belt', 'hips');
    add(S.roundBox([0, 1.0, 0.118 * hw + 0.004], [0.027, 0.022, 0.008], 0.006), 0.004, 'metal', 'hips');
  }
  if (o.collar) add(S.torus([0, 1.455, -0.003], 0.08, 0.074, o.collarThick ?? 0.024), 0.012, 'collar', 'chest');
  if (o.bandolier) add(S.band(torsoBase, 0.01, 0.007, [0.02, 1.22, 0], [0.4, -0.26, 0], 0.021), 0.006, 'strap', 'chest');
  if (o.straps) for (const s of [1, -1]) add(S.band(torsoBase, 0.008, 0.006, [0.085 * s, 1.3, 0], [1, 0, 0], 0.017), 0.005, o.strapRegion || 'strap', 'chest');
  if (o.tail) {
    const t1 = J.tail1, t2 = J.tail2, t3 = J.tail3, tip = [0, 1.02, -0.72];
    add(S.roundCone(t1, t2, 0.05, 0.085), 0.03, 'skin', 'tail1', { sigma: 0.04 });
    add(S.roundCone(t2, t3, 0.088, 0.082), 0.05, 'skin', 'tail2', { sigma: 0.04 });
    add(S.roundCone(t3, tip, 0.082, 0.02), 0.05, (x, y, z) => (z < -0.6 ? 'furLight' : 'skin'), 'tail3', { sigma: 0.04 });
  }
  return { parts: P, HC, hs };
}

// ---- face ------------------------------------------------------------------------------------
function buildFace(headBone, headJoint, f, HC, hs, o) {
  const face = { eyes: [], brows: [], mouth: null };
  const skin = o.palette.skin;
  const re = (o.eyeSize ?? 0.0235) * hs;
  const ex = (o.eyeSpread ?? 0.043) * hs, ey = HC[1] + (o.eyeY ?? 0.004) * hs;
  for (const s of [1, -1]) {
    const zS = surfaceZ(f, ex * s, ey, HC[2] + 0.5);
    const eye = new THREE.Group();
    eye.position.set(ex * s - headJoint[0], ey - headJoint[1], zS - re * 0.72 - headJoint[2]);
    eye.rotation.y = 0.16 * s;
    headBone.add(eye);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(re, 18, 14), flat(o.eyeWhite || '#f7f3ea'));
    ball.scale.set(1, 0.92, 0.9);
    eye.add(ball);
    const gaze = new THREE.Group();
    eye.add(gaze);
    const irisR = re * (o.irisScale ?? 0.66);
    const iris = new THREE.Mesh(new THREE.CircleGeometry(irisR, 24), flat(o.eyeColor || '#5b3a24'));
    iris.position.z = re * 0.9 + 0.0004;
    gaze.add(iris);
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(irisR * 0.52, 20), flat('#120c0a', true));
    pupil.position.z = re * 0.9 + 0.0008;
    gaze.add(pupil);
    const glint = new THREE.Mesh(new THREE.CircleGeometry(irisR * 0.3, 12), flat('#ffffff', true));
    glint.position.set(irisR * 0.35, irisR * 0.42, re * 0.9 + 0.0012);
    gaze.add(glint);
    // upper lid (rotates down to blink) with a dark lash line, and a small lower lid
    const lid = new THREE.Group();
    eye.add(lid);
    lid.add(new THREE.Mesh(new THREE.SphereGeometry(re * 1.08, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), flat(skin)));
    const lash = new THREE.Mesh(new THREE.TorusGeometry(re * 1.09, re * 0.09, 5, 24, Math.PI), flat(o.lashColor || '#2a1d18', true));
    lash.rotation.x = Math.PI / 2;
    lid.add(lash);
    eye.add(new THREE.Mesh(new THREE.SphereGeometry(re * 1.05, 20, 6, 0, Math.PI * 2, Math.PI * 0.8, Math.PI * 0.2), flat(skin)));
    if (o.blush !== false) {
      const cx = (o.cheekX ?? 0.066) * hs * s, cy = HC[1] - 0.045 * hs;
      const cz = surfaceZ(f, cx, cy, HC[2] + 0.5);
      const blush = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: o.blushColor || '#f09a8a', transparent: true, opacity: 0.35, depthWrite: false }));
      blush.scale.set(0.022 * hs, 0.011 * hs, 0.006);
      blush.position.set(cx - headJoint[0], cy - headJoint[1], cz - 0.002 - headJoint[2]);
      blush.rotation.y = 0.35 * s;
      headBone.add(blush);
    }
    const open = o.lidOpen ?? -1.05;
    lid.rotation.x = open;
    face.eyes.push({ eye, gaze, lid, open, closed: 0.55 });
    if (o.brows !== false) {
      const by = HC[1] + 0.036 * hs, bx = 0.046 * hs * s;
      const bz = surfaceZ(f, bx, by, HC[2] + 0.5);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.0045 * hs, 0.03 * hs, 3, 8), flat(o.browColor || o.palette.hair || '#3a2a20'));
      brow.rotation.set(0, 0.18 * s, Math.PI / 2 + 0.12 * s);
      brow.position.set(bx - headJoint[0], by - headJoint[1], bz + 0.002 - headJoint[2]);
      headBone.add(brow);
      face.brows.push({ mesh: brow, y0: brow.position.y });
    }
  }
  // mouth: a small line that can smile or make an "o"
  const my = HC[1] + (o.mouthY ?? -0.07) * hs;
  const mz = surfaceZ(f, 0, my, HC[2] + 0.5);
  const mouth = new THREE.Group();
  mouth.position.set(-headJoint[0], my - headJoint[1], mz + 0.0015 - headJoint[2]);
  headBone.add(mouth);
  const w = (o.mouthW ?? 0.024) * hs;
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-w, 0.002, -0.006), new THREE.Vector3(0, -0.004, 0.002), new THREE.Vector3(w, 0.002, -0.006));
  const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.0021 * hs, 5), flat(o.mouthColor || '#6b3a33', true));
  mouth.add(line);
  const oh = new THREE.Mesh(new THREE.TorusGeometry(0.008 * hs, 0.0026 * hs, 6, 14), flat(o.mouthColor || '#6b3a33', true));
  oh.visible = false;
  mouth.add(oh);
  face.mouth = { group: mouth, line, oh };
  return face;
}

// ---- assembling a character -------------------------------------------------------------------
function assemble(def) {
  const { J, parts, palette } = def;
  const bones = {};
  const list = [];
  for (const name of Object.keys(PARENT)) {
    if (!J[name]) continue;
    const b = new THREE.Bone();
    b.name = name;
    const p = PARENT[name];
    const jp = J[name], pp = p ? J[p] : [0, 0, 0];
    b.position.set(jp[0] - pp[0], jp[1] - pp[1], jp[2] - pp[2]);
    if (p) bones[p].add(b);
    bones[name] = b;
    list.push(b);
  }
  const root = new THREE.Group();
  const lean = new THREE.Group();
  const squash = new THREE.Group();
  root.add(lean); lean.add(squash); squash.add(bones.hips);

  const f = S.evaluator(parts);
  const m = S.meshSDF(f, def.min, def.max, def.h ?? 0.0125, 2);
  const boneIndex = Object.fromEntries(list.map((b, i) => [b.name, i]));
  const sk = S.skinAndPaint(parts, f, m.positions, boneIndex);
  const geo = geometryFrom(m, paintRegions(sk.regions, palette), sk);
  const body = new THREE.SkinnedMesh(geo, bodyMat);
  body.castShadow = true;
  body.frustumCulled = false;
  root.add(body);
  const skeleton = new THREE.Skeleton(list);
  root.updateMatrixWorld(true);
  body.bind(skeleton);
  const outline = new THREE.SkinnedMesh(geo, outlineMat);
  outline.frustumCulled = false;
  root.add(outline);
  outline.bind(skeleton, body.bindMatrix);

  const rig = {
    root, lean, squash, bones, body, skeleton, f, J,
    hips: bones.hips, spine: bones.spine, chest: bones.chest, neck: bones.neck, head: bones.head,
    shoulders: [bones.shoulderL, bones.shoulderR], elbows: [bones.elbowL, bones.elbowR], hands: [bones.handL, bones.handR],
    thighs: [bones.thighL, bones.thighR], knees: [bones.kneeL, bones.kneeR], feet: [bones.footL, bones.footR],
    jiggles: [], clothDefs: def.cloth || [], face: { eyes: [], brows: [], mouth: null },
    kind: def.kind || 'human',
    tris: m.indices.length / 3,
    P: {
      hipsY: J.hips[1],
      thighLen: Math.hypot(J.thighL[0] - J.kneeL[0], J.thighL[1] - J.kneeL[1], J.thighL[2] - J.kneeL[2]),
      shinLen: Math.hypot(J.kneeL[0] - J.footL[0], J.kneeL[1] - J.footL[1], J.kneeL[2] - J.footL[2]),
      footRest: J.footL[1], stride: def.stride ?? 0.42, sway: def.sway ?? 0.028, armAmp: 1,
      legLen: J.thighL[1] - J.footL[1],
      camHeight: def.camHeight ?? 1.45, swimDepth: def.swimDepth ?? 0.8, sitHips: def.sitHips ?? 0.14,
      sqK: def.sqK ?? 240, sqC: def.sqC ?? 13, land: def.land ?? 0.22, jump: def.jump ?? 1.4,
    },
  };
  rig.jig = (obj, axis, len, k, c, max, opts = {}) => rig.jiggles.push({ obj, axis: new THREE.Vector3(...axis).normalize(), len, k, c, max, g: opts.g || 0, air: opts.air || 0, dynamic: !!opts.dynamic });
  return rig;
}

// ---- humans ------------------------------------------------------------------------------------
function human(o) {
  const J = humanJoints(o);
  if (o.tail) { J.tail1 = [0, 0.95, -0.1]; J.tail2 = [0, 0.86, -0.3]; J.tail3 = [0, 0.9, -0.52]; }
  const { parts, HC, hs } = humanParts(J, o);
  const rig = assemble({ J, parts, palette: o.palette, cloth: o.cloth, min: [-0.38, -0.02, -(o.tail ? 0.8 : 0.24)], max: [0.38, 1.9, 0.3] });
  rig.face = buildFace(rig.head, J.head, rig.f, HC, hs, o);
  rig.jig(rig.neck, [0, 1, 0], 0.26, 170, 14, 0.22, { dynamic: true }); // a little head bobble
  o.extras?.(rig, { J, HC, hs, headJ: J.head });
  if (o.tail) {
    rig.jig(rig.bones.tail1, [0, -0.45, -1], 0.21, 60, 5, 0.8, { dynamic: true, g: 2, air: 1.4 });
    rig.jig(rig.bones.tail2, [0, 0.2, -1], 0.23, 45, 4, 0.8, { dynamic: true, g: 2, air: 1.4 });
    rig.jig(rig.bones.tail3, [0, 0.5, -1], 0.22, 40, 3.5, 0.9, { dynamic: true, g: 2, air: 1.4 });
  }
  return rig;
}

const hood = (color, inner) => (rig, { HC, hs, headJ }) => {
  const hp = (dx, dy, dz) => [HC[0] + dx * hs, HC[1] + dy * hs, HC[2] + dz * hs];
  const parts = [
    { d: S.ellipsoid(hp(0, 0.012, -0.012), [0.15 * hs, 0.167 * hs, 0.158 * hs]), k: 0, region: (x, y, z) => (z > HC[2] + 0.09 ? 'hoodIn' : 'hood') },
    { d: S.ellipsoid(hp(0, 0.004, -0.004), [0.127 * hs, 0.146 * hs, 0.136 * hs]), k: 0.01, region: 'hoodIn', sub: true },
    { d: S.ellipsoid(hp(0, -0.035, 0.15), [0.098 * hs, 0.128 * hs, 0.1 * hs]), k: 0.02, region: 'hoodIn', sub: true },
    { d: S.halfSpace([0, HC[1] - 0.12 * hs, 0], [0, -1, 0]), k: 0.02, cut: true },
  ];
  sculptPiece(parts, [-0.2, HC[1] - 0.16, -0.22], [0.2, HC[1] + 0.2, 0.2], 0.008, { hood: color, hoodIn: inner }, rig.head, headJ);
  const tip = new THREE.Group();
  const base = hp(0, 0.1, -0.12);
  tip.position.set(base[0] - headJ[0], base[1] - headJ[1], base[2] - headJ[2]);
  tip.rotation.x = -2.2;
  rig.head.add(tip);
  sculptPiece([{ d: S.roundCone([0, 0, 0], [0, 0.26, 0], 0.052, 0.012), k: 0, region: 'hood' }], [-0.08, -0.08, -0.08], [0.08, 0.3, 0.08], 0.007, { hood: color }, tip, [0, 0, 0]);
  rig.jig(tip, [0, 1, 0], 0.26, 50, 4, 1.0, { g: 3, air: 2 });
};

const bangs = (color) => (rig, { HC, hs, headJ }) => {
  const hp = (dx, dy, dz) => [HC[0] + dx * hs, HC[1] + dy * hs, HC[2] + dz * hs];
  const parts = [];
  const locks = [[-0.06, 0.1, 0.1, -0.1, 0.03, 0.124], [-0.01, 0.11, 0.11, -0.045, 0.02, 0.13], [0.04, 0.105, 0.108, 0.02, 0.035, 0.13], [0.08, 0.09, 0.09, 0.095, 0.0, 0.105]];
  for (const [ax, ay, az, bx, by, bz] of locks) parts.push({ d: S.roundCone(hp(ax, ay, az), hp(bx, by, bz), 0.024 * hs, 0.006 * hs), k: 0.018, region: 'hair' });
  parts.push({ d: S.ellipsoid(hp(0, 0.075, 0.07), [0.1 * hs, 0.05 * hs, 0.06 * hs]), k: 0.03, region: 'hair' });
  sculptPiece(parts, [-0.16, HC[1] - 0.04, 0], [0.16, HC[1] + 0.2, 0.2], 0.0075, { hair: color }, rig.head, headJ);
};

const bob = (color) => (rig, { HC, hs, headJ }) => {
  const hp = (dx, dy, dz) => [HC[0] + dx * hs, HC[1] + dy * hs, HC[2] + dz * hs];
  const crown = new THREE.Group();
  const cp = hp(0, 0.12, -0.01);
  crown.position.set(cp[0] - headJ[0], cp[1] - headJ[1], cp[2] - headJ[2]);
  rig.head.add(crown);
  const parts = [
    { d: S.ellipsoid(hp(0, 0.012, -0.006), [0.136 * hs, 0.157 * hs, 0.145 * hs]), k: 0, region: 'hair' },
    { d: S.ellipsoid(hp(0, -0.075, -0.02), [0.14 * hs, 0.07 * hs, 0.13 * hs]), k: 0.05, region: 'hair' },
    { d: S.ellipsoid(hp(0, 0.0, 0.004), [0.121 * hs, 0.14 * hs, 0.13 * hs]), k: 0.008, region: 'hair', sub: true },
    { d: S.roundBox(hp(0, -0.06, 0.16), [0.1 * hs, 0.105 * hs, 0.1 * hs], 0.02), k: 0.012, region: 'hair', sub: true },
    { d: S.halfSpace([0, HC[1] - 0.105 * hs, 0], [0, -1, 0]), k: 0.012, cut: true },
  ];
  sculptPiece(parts, [-0.19, HC[1] - 0.14, -0.2], [0.19, HC[1] + 0.19, 0.2], 0.0075, { hair: color }, crown, cp);
  rig.jig(crown, [0, -1, 0], 0.18, 150, 10, 0.12);
};

const curls = (color) => (rig, { HC, hs, headJ }) => {
  const hp = (dx, dy, dz) => [HC[0] + dx * hs, HC[1] + dy * hs, HC[2] + dz * hs];
  const parts = [{ d: S.ellipsoid(hp(0, 0.02, -0.012), [0.128 * hs, 0.146 * hs, 0.136 * hs]), k: 0, region: 'hair' }];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2, e = -0.25 + rnd() * 1.6;
    const x = Math.cos(a) * Math.cos(e), y = Math.sin(e), z = Math.sin(a) * Math.cos(e);
    if (z > 0.55 && y < 0.55) continue; // keep the face clear
    parts.push({ d: S.sphere(hp(x * 0.132, y * 0.15 + 0.02, z * 0.14 - 0.01), (0.03 + rnd() * 0.018) * hs), k: 0.022, region: 'hair' });
  }
  parts.push({ d: S.ellipsoid(hp(0, -0.01, 0.01), [0.119 * hs, 0.137 * hs, 0.128 * hs]), k: 0.006, region: 'hair', sub: true });
  parts.push({ d: S.halfSpace([0, HC[1] - 0.06 * hs, 0], [0, -1, 0]), k: 0.02, cut: true });
  sculptPiece(parts, [-0.21, HC[1] - 0.1, -0.21], [0.21, HC[1] + 0.22, 0.2], 0.008, { hair: color }, rig.head, headJ);
};

function strawHat(rig, { HC, hs, headJ }, color, band) {
  const hp = new THREE.Group();
  hp.position.set(-headJ[0], HC[1] + 0.105 * hs - headJ[1], HC[2] - 0.01 - headJ[2]);
  hp.rotation.x = -0.12;
  rig.head.add(hp);
  // profile runs from the brim's underside, out to the rim, then up over the crown (normals face out)
  const prof = [[0.112, -0.006], [0.19, -0.022], [0.232, -0.038], [0.235, -0.03], [0.2, -0.012], [0.115, 0.004], [0.108, 0.02], [0.1, 0.085], [0.07, 0.1], [0.001, 0.1]]
    .map(([x, y]) => new THREE.Vector2(x * hs, y * hs));
  const g = new THREE.LatheGeometry(prof, 32);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, toonMaterial({ color, side: THREE.DoubleSide }));
  m.castShadow = true;
  m.add(new THREE.Mesh(g, outlineMat));
  hp.add(m);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.111 * hs, 0.113 * hs, 0.028 * hs, 32, 1, true), flat(band));
  ring.position.y = 0.022 * hs;
  hp.add(ring);
  const bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.02 * hs, 1), flat('#f7a8c6'));
  bloom.position.set(0.1 * hs, 0.03 * hs, 0.04 * hs);
  hp.add(bloom);
  rig.jig(hp, [0, 1, 0], 0.1, 160, 10, 0.22);
}

function satchel(rig, { J }) {
  const p = new THREE.Group();
  const at = [0.165, 1.02, 0.03];
  p.position.set(at[0] - J.hips[0], at[1] - J.hips[1], at[2] - J.hips[2]);
  rig.hips.add(p);
  sculptPiece([
    { d: S.roundBox([0.03, -0.1, 0.0], [0.03, 0.075, 0.1], 0.025), k: 0, region: 'leather' },
    { d: S.roundBox([0.058, -0.06, 0.0], [0.006, 0.04, 0.095], 0.005), k: 0.004, region: 'leatherDark' },
    { d: S.sphere([0.066, -0.085, 0.0], 0.009), k: 0.003, region: 'metal' },
  ], [-0.04, -0.2, -0.13], [0.1, 0.02, 0.13], 0.0065, { leather: '#8a5c3a', leatherDark: '#6a4329', metal: '#d9b45a' }, p, [0, 0, 0]);
  rig.jig(p, [0, -1, 0], 0.12, 70, 5, 0.55, { g: 2 });
}

function backpack(rig, { J }) {
  const p = new THREE.Group();
  const at = [0, 1.42, -0.12];
  p.position.set(at[0] - J.chest[0], at[1] - J.chest[1], at[2] - J.chest[2]);
  rig.chest.add(p);
  sculptPiece([
    { d: S.roundBox([0, -0.17, -0.06], [0.12, 0.14, 0.065], 0.045), k: 0, region: 'pack' },
    { d: S.roundBox([0, -0.2, -0.125], [0.085, 0.07, 0.012], 0.01), k: 0.01, region: 'packDark' },
    { d: S.capsule([-0.15, 0.0, -0.07], [0.15, 0.0, -0.07], 0.05), k: 0.01, region: 'roll' },
    { d: S.torus([0.0, 0.0, -0.07], 0.052, 0.052, 0.008), k: 0.003, region: 'packDark' },
  ], [-0.22, -0.34, -0.2], [0.22, 0.08, 0.02], 0.0075, { pack: '#7d6a4f', packDark: '#5d4e38', roll: '#c95b4a' }, p, [0, 0, 0]);
  rig.jig(p, [0, -1, 0], 0.2, 80, 7, 0.35, { g: 2 });
}

function foxEars(rig, { HC, hs, headJ }, fur, inner) {
  for (const s of [1, -1]) {
    const p = new THREE.Group();
    p.position.set(0.075 * s * hs - headJ[0], HC[1] + 0.105 * hs - headJ[1], HC[2] - 0.02 - headJ[2]);
    p.rotation.z = -0.3 * s;
    rig.head.add(p);
    sculptPiece([
      { d: S.roundCone([0, 0, 0], [0, 0.13, 0], 0.048, 0.008), k: 0, region: 'fur' },
      { d: S.roundCone([0, 0.01, 0.03], [0, 0.11, 0.022], 0.03, 0.004), k: 0.006, region: 'inner', sub: true },
    ], [-0.07, -0.05, -0.07], [0.07, 0.16, 0.07], 0.006, { fur, inner }, p, [0, 0, 0]);
    rig.jig(p, [0, 1, 0], 0.12, 120, 7, 0.5, { air: 0.5 });
  }
}

export const PRESETS = [
  {
    id: 'ren', name: 'Ren', title: 'the Wanderer', blurb: 'Follows the path wherever it bends.',
    build: () => human({
      ears: 'point', collar: true, collarThick: 0.03, bandolier: true, cuffs: true, eyeColor: '#3d6a8a',
      palette: { skin: '#f1c7a1', top: '#3f8a4e', sleeve: '#3f8a4e', forearm: '#dcc9a4', hand: '#7a5234', cuff: '#7a5234', pants: '#e6dcc2', boots: '#6f4a2f', bootTrim: '#8a5c3a', belt: '#5a3b26', metal: '#d9b45a', collar: '#2f6d3c', strap: '#6a4329', hair: '#7a4a2a' },
      bootTop: 0.36,
      extras: (rig, ctx) => { hood('#3f8a4e', '#2f6d3c')(rig, ctx); bangs('#7a4a2a')(rig, ctx); satchel(rig, ctx); },
      cloth: [{ type: 'skirt', bone: 'hips', topY: 1.0, top: [0.157, 0.122], hemY: 0.7, hem: [0.21, 0.18], rows: 6, cols: 20, color: '#3f8a4e', hemColor: '#2f6d3c' }],
    }),
  },
  {
    id: 'mo', name: 'Mo', title: 'the Botanist', blurb: 'Knows every flower by its first name.',
    build: () => human({
      ears: 'round', straps: true, strapRegion: 'overall', pelvisRegion: 'overall', shoulders: 1.05, limbs: 1.05, eyeColor: '#3b2416',
      topRegion: (x, y, z) => (z > 0.035 && y < 1.36 && Math.abs(x) < 0.12 ? 'overall' : 'top'),
      palette: { skin: '#8d5a3b', top: '#f3efe4', sleeve: '#f3efe4', forearm: '#8d5a3b', hand: '#6f9a4a', pants: '#4f78b0', overall: '#4f78b0', boots: '#6a5040', bootTrim: '#57402f', belt: '#4f78b0', metal: '#d9b45a', hair: '#231815' },
      belt: false, bootTop: 0.3, browColor: '#231815',
      extras: (rig, ctx) => { curls('#231815')(rig, ctx); strawHat(rig, ctx, '#e6c77a', '#c65a4a'); },
      cloth: [{ type: 'panel', bone: 'hips', topY: 1.04, width: 0.26, z: 0.125, hemY: 0.66, rows: 6, cols: 6, color: '#6f9a4a', hemColor: '#5a8038' }],
    }),
  },
  {
    id: 'juniper', name: 'Juniper', title: 'the Scout', blurb: 'Has a map. Prefers not to use it.',
    build: () => human({
      ears: 'round', collar: true, hips: 1.04, shoulders: 0.95, limbs: 0.94, bust: 1.08, eyeColor: '#2f6b4f', cuffs: true,
      palette: { skin: '#f6d6bd', top: '#f2c14e', sleeve: '#f2c14e', forearm: '#f2c14e', cuff: '#d9a53a', hand: '#f6d6bd', pants: '#3d4f6b', boots: '#b8452f', bootTrim: '#8f3322', belt: '#8f6a3a', metal: '#c9c9c9', collar: '#d8504a', hair: '#27222c' },
      bootTop: 0.42, browColor: '#27222c',
      extras: (rig, ctx) => { bob('#27222c')(rig, ctx); backpack(rig, ctx); },
      cloth: [
        { type: 'skirt', bone: 'hips', topY: 1.02, top: [0.16, 0.125], hemY: 0.64, hem: [0.22, 0.19], rows: 7, cols: 20, color: '#f2c14e', hemColor: '#d9a53a' },
        { type: 'ribbon', bone: 'chest', at: [0.06, 1.45, -0.075], length: 0.5, width: 0.09, rows: 8, color: '#d8504a' },
      ],
    }),
  },
  {
    id: 'kit', name: 'Kit', title: 'the Fox', blurb: 'Quiet paws, curious nose.',
    build: () => human({
      snout: true, ears: 'none', tail: true, blush: false, jawRegion: 'furLight', neckRegion: 'furLight', eyeSize: 0.026, eyeColor: '#2a1a10', irisScale: 0.72, mouthY: -0.1, mouthW: 0.016,
      topRegion: (x, y, z) => (Math.abs(x) < 0.04 && z > 0.02 ? 'furLight' : 'vest'), shoulderRegion: 'vest',
      palette: { skin: '#e08845', furLight: '#fbf1e3', nose: '#241814', vest: '#5a7fb8', top: '#5a7fb8', sleeve: '#e08845', forearm: '#e08845', hand: '#3b2a22', pants: '#e08845', boots: '#3b2a22', bootTrim: '#3b2a22', belt: '#6a4329', metal: '#d9b45a', collar: '#f0d24a', hair: '#e08845' },
      collar: true, bootTop: 0.3, browColor: '#b8652f', eyeWhite: '#fff6e8',
      extras: (rig, ctx) => foxEars(rig, ctx, '#e08845', '#3b2a22'),
      cloth: [{ type: 'ribbon', bone: 'chest', at: [0.05, 1.45, -0.075], length: 0.46, width: 0.085, rows: 8, color: '#f0d24a' }],
    }),
  },
  { id: 'pip', name: 'Pip', title: 'the Puff', blurb: 'Round, soft, and in no hurry at all.', build: () => pip() },
  { id: 'moss', name: 'Moss', title: 'the Forest Spirit', blurb: 'Older than the trees. Still curious.', build: () => moss() },
];

// ---- Pip: a soft round creature ------------------------------------------------------------------
function pip() {
  const J = {
    hips: [0, 0.1, 0], spine: [0, 0.14, 0], chest: [0, 0.47, 0], neck: [0, 0.47, 0], head: [0, 0.47, 0],
    shoulderL: [0.4, 0.47, 0], elbowL: [0.43, 0.42, 0.01], handL: [0.45, 0.38, 0.02],
    shoulderR: [-0.4, 0.47, 0], elbowR: [-0.43, 0.42, 0.01], handR: [-0.45, 0.38, 0.02],
    thighL: [0.17, 0.2, 0], kneeL: [0.17, 0.16, 0.01], footL: [0.17, 0.1, 0.02],
    thighR: [-0.17, 0.2, 0], kneeR: [-0.17, 0.16, 0.01], footR: [-0.17, 0.1, 0.02],
  };
  const parts = [
    { d: S.ellipsoid([0, 0.47, 0], [0.43, 0.41, 0.42]), k: 0, region: 'skin', bone: 'spine', sigma: 0.05 },
    { d: S.ellipsoid([0, 0.2, 0.0], [0.3, 0.12, 0.28]), k: 0.12, region: 'skin', bone: 'hips' },
  ];
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    parts.push({ d: S.ellipsoid([0.43 * s, 0.42, 0.02], [0.085, 0.12, 0.1]), k: 0.035, region: 'skin', bone: 'shoulder' + k, sigma: 0.03 });
    parts.push({ d: S.ellipsoid([0.17 * s, 0.07, 0.06], [0.13, 0.075, 0.17]), k: 0.03, region: 'feet', bone: 'foot' + k, sigma: 0.03 });
  }
  const rig = assemble({ J, parts, palette: { skin: '#ffd2b0', feet: '#d9674f' }, min: [-0.58, -0.02, -0.45], max: [0.58, 0.92, 0.48], h: 0.015, kind: 'puff', camHeight: 0.95, swimDepth: 0.2, stride: 0.26, sqK: 150, sqC: 5.5, land: 0.4, jump: 2.2 });
  rig.P.sitHips = rig.P.hipsY;
  // face lives on a head bone at the ball's centre so the eyes can slide around it
  rig.face = buildFace(rig.head, J.head, rig.f, [0, 0.49, 0], 1, {
    palette: { skin: '#ffd2b0' }, eyeSize: 0.058, eyeSpread: 0.11, eyeY: 0.02, eyeWhite: '#231a18', eyeColor: '#231a18', irisScale: 0.5,
    brows: false, blush: false, mouthY: -0.09, mouthW: 0.03, lidOpen: -1.1, lashColor: '#231a18',
  });
  for (const s of [1, -1]) {
    const blush = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: '#ff9d9d', transparent: true, opacity: 0.6 }));
    blush.scale.set(0.06, 0.032, 0.012);
    const z = surfaceZ(rig.f, 0.22 * s, 0.42, 0.6);
    blush.position.set(0.22 * s, 0.42 - J.head[1], z - 0.004);
    blush.rotation.y = 0.5 * s;
    rig.head.add(blush);
  }
  const sp = new THREE.Group();
  sp.position.set(0, 0.395, -0.02);
  rig.head.add(sp);
  sp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.13, 6).translate(0, 0.065, 0), flat('#5b8a3a')));
  for (const s of [1, -1]) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), flat('#79b84e'));
    leaf.scale.set(0.085, 0.018, 0.045);
    leaf.position.set(0.07 * s, 0.14, 0);
    leaf.rotation.z = 0.4 * s;
    sp.add(leaf);
  }
  rig.jig(sp, [0, 1, 0], 0.15, 40, 2.6, 0.9, { air: 0.8 });
  rig.jig(rig.spine, [0, 1, 0], 0.66, 75, 5, 0.3, { dynamic: true }); // the whole ball wobbles
  return rig;
}

// ---- Moss: a small forest spirit ------------------------------------------------------------------
function moss() {
  const J = {
    hips: [0, 0.53, 0], spine: [0, 0.6, 0], chest: [0, 0.72, 0], neck: [0, 0.84, 0], head: [0, 0.88, 0],
    shoulderL: [0.115, 0.8, 0], elbowL: [0.14, 0.64, 0], handL: [0.155, 0.49, 0.01],
    shoulderR: [-0.115, 0.8, 0], elbowR: [-0.14, 0.64, 0], handR: [-0.155, 0.49, 0.01],
    thighL: [0.06, 0.5, 0], kneeL: [0.064, 0.29, 0.01], footL: [0.068, 0.075, -0.005],
    thighR: [-0.06, 0.5, 0], kneeR: [-0.064, 0.29, 0.01], footR: [-0.068, 0.075, -0.005],
  };
  const HC = [0, 1.01, 0.01];
  const parts = [
    { d: S.ellipsoid([0, 0.54, 0], [0.105, 0.08, 0.09]), k: 0, region: 'moss', bone: 'hips', sigma: 0.03 },
    { d: S.ellipsoid([0, 0.68, 0.0], [0.125, 0.15, 0.105]), k: 0.05, region: 'moss', bone: 'chest', sigma: 0.04 },
    { d: S.roundCone([0, 0.8, 0], [0, 0.92, 0.0], 0.04, 0.035), k: 0.03, region: 'wood', bone: 'neck' },
    { d: S.ellipsoid(HC, [0.15, 0.14, 0.135]), k: 0.02, region: (x, y, z) => (z > 0.02 ? 'mask' : 'moss'), bone: 'head' },
    { d: S.ellipsoid([0, HC[1] - 0.02, HC[2] + 0.02], [0.14, 0.12, 0.13]), k: 0.03, region: 'mask', bone: 'head' },
  ];
  for (const s of [1, -1]) parts.push({ d: S.ellipsoid([0.05 * s, HC[1] + 0.012, HC[2] + 0.13], [0.026, 0.034, 0.03]), k: 0.008, region: 'hole', sub: true });
  parts.push({ d: S.ellipsoid([0, HC[1] - 0.06, HC[2] + 0.13], [0.014, 0.017, 0.03]), k: 0.006, region: 'hole', sub: true });
  for (let i = 0; i < 9; i++) {
    const a = i * 2.2, y = 0.58 + (i % 4) * 0.05;
    parts.push({ d: S.sphere([Math.cos(a) * 0.1, y, Math.sin(a) * 0.08], 0.035), k: 0.03, region: 'moss2', bone: 'chest' });
  }
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    parts.push({ d: S.roundCone(J['shoulder' + k], J['elbow' + k], 0.026, 0.022), k: 0.03, region: 'wood', bone: 'shoulder' + k });
    parts.push({ d: S.roundCone(J['elbow' + k], J['hand' + k], 0.022, 0.018), k: 0.012, region: 'wood', bone: 'elbow' + k });
    parts.push({ d: S.sphere([J['hand' + k][0] + 0.005 * s, J['hand' + k][1] - 0.03, J['hand' + k][2] + 0.01], 0.034), k: 0.012, region: 'leafy', bone: 'hand' + k });
    parts.push({ d: S.roundCone(J['thigh' + k], J['knee' + k], 0.032, 0.025), k: 0.03, region: 'wood', bone: 'thigh' + k });
    parts.push({ d: S.roundCone(J['knee' + k], J['foot' + k], 0.025, 0.021), k: 0.012, region: 'wood', bone: 'knee' + k });
    parts.push({ d: S.roundBox([J['foot' + k][0], 0.035, 0.02], [0.03, 0.03, 0.06], 0.025), k: 0.015, region: 'wood', bone: 'foot' + k });
  }
  const rig = assemble({
    J, parts, kind: 'spirit', min: [-0.24, -0.02, -0.2], max: [0.24, 1.18, 0.2], h: 0.0095,
    palette: { moss: '#6fa75a', moss2: '#5a9147', wood: '#7a5a3f', mask: '#f4efe2', hole: '#2a2420', leafy: '#8fcf5e' },
    camHeight: 0.95, swimDepth: 0.5, stride: 0.3, sitHips: 0.1,
  });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const lp = new THREE.Group();
    lp.position.set(Math.cos(a) * 0.09, HC[1] + 0.1 - J.head[1], Math.sin(a) * 0.08 + HC[2] - 0.01);
    lp.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
    rig.head.add(lp);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), flat(i % 2 ? '#8fcf5e' : '#5fa446'));
    leaf.scale.set(0.045, 0.13, 0.025);
    leaf.position.y = 0.1;
    leaf.rotation.y = -a;
    leaf.castShadow = true;
    lp.add(leaf);
    rig.jig(lp, [0, 1, 0], 0.14, 65, 4, 0.7, { air: 0.6 });
  }
  rig.jig(rig.neck, [0, 1, 0], 0.18, 160, 12, 0.25, { dynamic: true });
  return rig;
}
