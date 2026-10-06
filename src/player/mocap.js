import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

// Real motion capture (CMU Graphics Lab Motion Capture Database, BVH conversion by Bruce Hahne,
// free for any use) retargeted onto our skeletons.
//
// Retargeting matches bone *directions*, so the T-pose of the capture skeleton and the arms-down
// bind pose of ours line up: for each bone, R_fix turns the source rest direction into ours, and the
// target world rotation is  H · Qsource · R_fix⁻¹  (H removes the actor's travel heading).
// Walk / jog cycles are cut between two left-foot contacts and played by distance travelled, so feet
// plant naturally; the idle is a looped stretch of real standing (weight shifts, breathing).

export const CLIPS = {
  idle: { file: '77_02', kind: 'time', from: 0.6, to: 7.4 },
  walk: { file: '93_07', kind: 'cycle' },
  stroll: { file: '35_01', kind: 'cycle' },
  jog: { file: '35_17', kind: 'cycle' },
  run: { file: '16_35', kind: 'cycle' },
};

// Average forward pitch (degrees) each clip settles to. The idle actor stares at the floor (head ~41°
// down, chest slumped ~18°); we keep their sway but level the gaze and stand them up straight.
const LEVEL = { idle: { chest: 4, neck: 4, head: 1 }, stroll: { head: 2 }, walk: { head: 2 }, jog: { head: 4 }, run: { head: 4 } };
const X = new THREE.Vector3(1, 0, 0);

// our bone → [source bone, source child used for its direction]
const MAP = {
  hips: ['Hips', null], spine: ['Spine', 'Spine1'], chest: ['Spine1', 'Neck1'], neck: ['Neck1', 'Head'], head: ['Head', null],
  shoulderL: ['LeftArm', 'LeftForeArm'], elbowL: ['LeftForeArm', 'LeftHand'], handL: ['LeftHand', 'LeftHandIndex1'],
  shoulderR: ['RightArm', 'RightForeArm'], elbowR: ['RightForeArm', 'RightHand'], handR: ['RightHand', 'RightHandIndex1'],
  thighL: ['LeftUpLeg', 'LeftLeg'], kneeL: ['LeftLeg', 'LeftFoot'], footL: ['LeftFoot', 'LeftToeBase'],
  thighR: ['RightUpLeg', 'RightLeg'], kneeR: ['RightLeg', 'RightFoot'], footR: ['RightFoot', 'RightToeBase'],
};
export const BONES = Object.keys(MAP);
const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  thighL: 'hips', kneeL: 'thighL', footL: 'kneeL', thighR: 'hips', kneeR: 'thighR', footR: 'kneeR',
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

// ---- source side: sample, align heading, cut the loop ------------------------------------------
export function prepare(text, def) {
  const res = new BVHLoader().parse(text);
  const bones = res.skeleton.bones;
  const byName = (n) => bones.find((b) => b.name === n);
  const root = new THREE.Group();
  root.add(bones[0]);
  root.updateMatrixWorld(true);

  // rest directions (rest rotations are identity, so world direction = child offset)
  const restDir = {};
  for (const [ours, [src, child]] of Object.entries(MAP)) {
    if (!child) { restDir[ours] = new THREE.Vector3(0, 1, 0); continue; }
    const c = byName(child), s = byName(src);
    const d = c.getWorldPosition(new THREE.Vector3()).sub(s.getWorldPosition(new THREE.Vector3()));
    // a zero-length child (e.g. Neck at the Spine1 joint) → fall back to the grandchild
    if (d.lengthSq() < 1e-8 && c.children[0]) d.copy(c.children[0].position);
    restDir[ours] = d.normalize();
  }
  const upLeg = byName('LeftLeg').position.length() + byName('LeftFoot').position.length();

  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(res.clip).play();
  const src = BONES.map((b) => byName(MAP[b][0]));
  const lf = byName('LeftFoot'), rf = byName('RightFoot');
  const FPS = 60;
  const n = Math.floor(res.clip.duration * FPS);
  const raw = [];
  for (let i = 0; i <= n; i++) {
    mixer.setTime(i / FPS);
    root.updateMatrixWorld(true);
    raw.push({
      q: src.map((b) => b.getWorldQuaternion(new THREE.Quaternion())),
      hip: src[0].getWorldPosition(new THREE.Vector3()),
      lf: lf.getWorldPosition(new THREE.Vector3()),
      rf: rf.getWorldPosition(new THREE.Vector3()),
    });
  }

  // choose the frames we keep
  let i0 = 0, i1 = raw.length - 1;
  let heading;
  if (def.kind === 'cycle') {
    const disp = _v.subVectors(raw[raw.length - 1].hip, raw[0].hip).setY(0);
    heading = Math.atan2(disp.x, disp.z);
    const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    // left-foot contact ≈ the left foot furthest ahead of the hips
    const ahead = raw.map((r) => _v2.subVectors(r.lf, r.hip).dot(dir));
    const peaks = [];
    for (let i = 3; i < ahead.length - 3; i++) {
      if (ahead[i] >= ahead[i - 1] && ahead[i] > ahead[i + 1] && ahead[i] >= Math.max(...ahead.slice(i - 3, i + 4))) {
        if (!peaks.length || i - peaks[peaks.length - 1] > 12) peaks.push(i);
      }
    }
    if (peaks.length >= 2) {
      const k = Math.max(0, Math.floor((peaks.length - 2) / 2));
      i0 = peaks[k]; i1 = peaks[k + 1];
    }
  } else {
    i0 = Math.round(def.from * FPS); i1 = Math.min(raw.length - 1, Math.round(def.to * FPS));
    // face along the average hip forward
    const f = new THREE.Vector3();
    for (let i = i0; i <= i1; i++) f.add(_v.set(0, 0, 1).applyQuaternion(raw[i].q[0]).setY(0));
    heading = Math.atan2(f.x, f.z);
  }
  const H = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);

  const frames = raw.slice(i0, i1 + 1);
  const dur = (frames.length - 1) / FPS;
  const p0 = frames[0].hip, p1 = frames[frames.length - 1].hip;
  const vel = _v.subVectors(p1, p0).divideScalar(Math.max(dur, 1e-3)).setY(0).clone();
  // ankle height while standing on a foot, for hip height above the ground
  let ankle = 0;
  for (const f of frames) ankle += Math.min(f.lf.y, f.rf.y);
  ankle /= frames.length;

  // resample to a fixed count; hip offsets are relative to the straight-line path
  const N = def.kind === 'cycle' ? 64 : Math.round(dur * 30);
  const out = { name: def.file, kind: def.kind, restDir, upLeg, N, duration: dur, speed: vel.length(), q: [], hip: [] };
  for (let s = 0; s < N; s++) {
    const t = (s / N) * (frames.length - 1);
    const a = Math.floor(t), b = Math.min(frames.length - 1, a + 1), w = t - a;
    const qs = BONES.map((_, j) => new THREE.Quaternion().slerpQuaternions(frames[a].q[j], frames[b].q[j], w).premultiply(H));
    const hip = new THREE.Vector3().lerpVectors(frames[a].hip, frames[b].hip, w);
    const path = new THREE.Vector3().copy(p0).addScaledVector(vel, (t / FPS));
    const rel = hip.clone().sub(path).setY(0).applyQuaternion(H);
    out.q.push(qs);
    out.hip.push(new THREE.Vector3(rel.x, hip.y - ankle, rel.z));
  }
  // smooth the loop seam: ease the last frames toward the first
  const blendN = Math.min(8, Math.floor(N / 6));
  for (let s = N - blendN; s < N; s++) {
    const w = (s - (N - blendN) + 1) / (blendN + 1);
    out.q[s].forEach((q, j) => q.slerp(out.q[0][j], w * w));
    out.hip[s].lerp(out.hip[0], w * w);
  }
  return out;
}

let cache = null;
export function loadMocap(base = 'mocap/') {
  if (!cache) {
    cache = Promise.all(Object.entries(CLIPS).map(async ([name, def]) => {
      const r = await fetch(base + def.file + '.bvh');
      if (!r.ok) throw new Error('mocap ' + def.file);
      return [name, prepare(await r.text(), def)];
    })).then((list) => Object.fromEntries(list)).catch((e) => { console.warn('mocap unavailable, using procedural animation', e); return null; });
  }
  return cache;
}

// ---- target side: per-rig retarget into local bone rotations -------------------------------------
export function retarget(clips, rig) {
  const J = rig.J;
  const tDir = {};
  const dirTo = (a, b) => new THREE.Vector3(J[b][0] - J[a][0], J[b][1] - J[a][1], J[b][2] - J[a][2]).normalize();
  tDir.hips = new THREE.Vector3(0, 1, 0);
  tDir.spine = dirTo('spine', 'chest'); tDir.chest = dirTo('chest', 'neck'); tDir.neck = dirTo('neck', 'head');
  tDir.head = new THREE.Vector3(0, 1, 0);
  for (const s of ['L', 'R']) {
    tDir['shoulder' + s] = dirTo('shoulder' + s, 'elbow' + s);
    tDir['elbow' + s] = dirTo('elbow' + s, 'hand' + s);
    tDir['hand' + s] = new THREE.Vector3(0, -1, 0.12).normalize();
    tDir['thigh' + s] = dirTo('thigh' + s, 'knee' + s);
    tDir['knee' + s] = dirTo('knee' + s, 'foot' + s);
    tDir['foot' + s] = new THREE.Vector3(0, -0.065, 0.152).normalize();
  }
  const legLen = rig.P.thighLen + rig.P.shinLen;
  const out = {};
  for (const [name, c] of Object.entries(clips)) {
    const fixInv = BONES.map((b) => new THREE.Quaternion().setFromUnitVectors(c.restDir[b], tDir[b]).invert());
    const corr = BONES.map(() => new THREE.Quaternion());
    for (const [b, deg] of Object.entries(LEVEL[name] || {})) {
      const j = BONES.indexOf(b);
      let sum = 0;
      for (let f = 0; f < c.N; f++) {
        _v.set(0, 0, 1).applyQuaternion(_q.copy(c.q[f][j]).multiply(fixInv[j]));
        sum += Math.asin(Math.max(-1, Math.min(1, -_v.y)));
      }
      corr[j].setFromAxisAngle(X, (deg * Math.PI) / 180 - sum / c.N);
    }
    const s = legLen / c.upLeg;
    const local = new Float32Array(c.N * BONES.length * 4);
    const world = BONES.map(() => new THREE.Quaternion());
    for (let f = 0; f < c.N; f++) {
      BONES.forEach((b, j) => world[j].copy(c.q[f][j]).multiply(fixInv[j]).premultiply(corr[j]));
      BONES.forEach((b, j) => {
        const p = PARENT[b];
        const q = p ? _q.copy(world[BONES.indexOf(p)]).invert().multiply(world[j]) : _q.copy(world[j]);
        local.set([q.x, q.y, q.z, q.w], (f * BONES.length + j) * 4);
      });
    }
    const hip = new Float32Array(c.N * 3);
    c.hip.forEach((h, f) => { hip[f * 3] = h.x * s; hip[f * 3 + 1] = h.y * s + rig.P.footRest; hip[f * 3 + 2] = h.z * s; });
    calibrate(rig, local, hip, c.N);
    out[name] = { N: c.N, local, hip, speed: c.speed * s, cycle: c.kind === 'cycle' ? c.speed * s * c.duration : 0, duration: c.duration, kind: c.kind };
  }
  return out;
}

// Run the clip through the rig once and shift the hips so the lowest (standing) foot sits exactly at
// the rig's resting ankle height; capture skeletons and ours measure ankles differently.
function calibrate(rig, local, hip, N) {
  const bones = BONES.map((b) => rig.bones[b]);
  const saved = bones.map((b) => b.quaternion.clone());
  const savedHip = rig.bones.hips.position.clone();
  const lean = [rig.lean.quaternion.clone(), rig.lean.position.clone(), rig.squash.scale.clone()];
  rig.lean.quaternion.identity(); rig.lean.position.set(0, 0, 0); rig.squash.scale.set(1, 1, 1);
  const feet = [rig.bones.footL, rig.bones.footR];
  let low = Infinity;
  for (let f = 0; f < N; f += 2) {
    bones.forEach((b, j) => { const o = (f * bones.length + j) * 4; b.quaternion.set(local[o], local[o + 1], local[o + 2], local[o + 3]); });
    rig.bones.hips.position.set(hip[f * 3], hip[f * 3 + 1], hip[f * 3 + 2]);
    rig.root.updateMatrixWorld(true);
    for (const ft of feet) low = Math.min(low, rig.root.worldToLocal(ft.getWorldPosition(_v)).y);
  }
  const corr = rig.P.footRest - low;
  for (let f = 0; f < N; f++) hip[f * 3 + 1] += corr;
  bones.forEach((b, j) => b.quaternion.copy(saved[j]));
  rig.bones.hips.position.copy(savedHip);
  rig.lean.quaternion.copy(lean[0]); rig.lean.position.copy(lean[1]); rig.squash.scale.copy(lean[2]);
  rig.root.updateMatrixWorld(true);
}

// Sample a retargeted clip at phase [0,1) into quaternions (array per bone) and a hip offset.
export function sampleClip(clip, phase, qs, hip) {
  const x = (((phase % 1) + 1) % 1) * clip.N;
  const a = Math.floor(x) % clip.N, b = (a + 1) % clip.N, w = x - Math.floor(x);
  const L = clip.local, nb = BONES.length;
  for (let j = 0; j < nb; j++) {
    const ia = (a * nb + j) * 4, ib = (b * nb + j) * 4;
    _q.set(L[ia], L[ia + 1], L[ia + 2], L[ia + 3]);
    _q2.set(L[ib], L[ib + 1], L[ib + 2], L[ib + 3]);
    qs[j].slerpQuaternions(_q, _q2, w);
  }
  const H = clip.hip;
  hip.set(H[a * 3] + (H[b * 3] - H[a * 3]) * w, H[a * 3 + 1] + (H[b * 3 + 1] - H[a * 3 + 1]) * w, H[a * 3 + 2] + (H[b * 3 + 2] - H[a * 3 + 2]) * w);
}
