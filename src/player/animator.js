import * as THREE from 'three';
import { solveTwoBone } from './ik.js';
import { loadMocap, retarget, sampleClip, BONES } from './mocap.js';

// Procedural, physics-driven character animation on a real skeleton.
//
//  • Locomotion: gait cycle driven by distance travelled, knee bend, toe-off, pelvis twist/drop,
//    counter-swinging arms, run lean. Feet are planted on the actual terrain with two-bone IK and
//    the pelvis drops when a foot needs to reach lower ground.
//  • Body physics: lean into acceleration like an inverted pendulum (atan(a/g)), bank in turns,
//    squash on landing, stretch in the air; a spring-bobbled head.
//  • Jiggle bones for hoods, ears, tails, bags, hats, hair; cloth for hems and scarves.
//  • Modes, all blended with springs: walk/jog, air, breaststroke + front crawl, sit, bench/ledge
//    seats, lying in the grass, waving, and the fishing poses.
//  • Face: eyes track what you look at, blink, get sleepy when resting; smile / "o" expressions.

const H = 1 / 120;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Spring {
  constructor(k, c, x = 0) { this.k = k; this.c = c; this.x = x; this.v = 0; this.target = x; }
  step(h) { this.v += (this.k * (this.target - this.x) - this.c * this.v) * h; this.x += this.v * h; }
}

// ---- jiggle bones ------------------------------------------------------------------------------
const _pw = new THREE.Quaternion(), _pwi = new THREE.Quaternion(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _P = new THREE.Vector3(), _T = new THREE.Vector3(), _rd = new THREE.Vector3(), _d = new THREE.Vector3();
const _tv = new THREE.Vector3(), _acc = new THREE.Vector3(), _Ti = new THREE.Vector3(), _rel = new THREE.Vector3();

class Jiggle {
  constructor(def) {
    Object.assign(this, def);
    this.rest = def.obj.quaternion.clone();
    this.X = new THREE.Vector3();
    this.V = new THREE.Vector3();
    this.prevT = new THREE.Vector3();
    this.ready = false;
  }
  update(dt, n, scale) {
    const o = this.obj;
    if (this.dynamic) this.rest.copy(o.quaternion);
    o.quaternion.copy(this.rest);
    o.parent.getWorldQuaternion(_pw);
    _P.copy(o.position).applyMatrix4(o.parent.matrixWorld);
    _rd.copy(this.axis).applyQuaternion(this.rest).applyQuaternion(_pw);
    const L = this.len * scale;
    _T.copy(_P).addScaledVector(_rd, L);
    if (!this.ready || this.X.distanceToSquared(_T) > 4) {
      this.X.copy(_T); this.V.set(0, 0, 0); this.prevT.copy(_T); this.ready = true;
    }
    const h = dt / n;
    _tv.subVectors(_T, this.prevT).divideScalar(Math.max(dt, 1e-5));
    for (let i = 0; i < n; i++) {
      _Ti.lerpVectors(this.prevT, _T, (i + 1) / n);
      _acc.subVectors(_Ti, this.X).multiplyScalar(this.k);
      _acc.addScaledVector(_rel.subVectors(this.V, _tv), -this.c);
      _acc.addScaledVector(this.V, -this.air);
      _acc.y -= this.g;
      this.V.addScaledVector(_acc, h);
      this.X.addScaledVector(this.V, h);
    }
    this.prevT.copy(_T);
    _d.subVectors(this.X, _P);
    const dl = _d.length();
    if (dl < 1e-6) _d.copy(_rd); else _d.divideScalar(dl);
    _q.setFromUnitVectors(_rd, _d);
    const ang = _rd.angleTo(_d);
    if (ang > this.max) { _q2.identity().slerp(_q, this.max / ang); _q.copy(_q2); _d.copy(_rd).applyQuaternion(_q); }
    this.X.copy(_P).addScaledVector(_d, L);
    _rel.subVectors(this.V, _tv);
    this.V.addScaledVector(_d, -_rel.dot(_d));
    _pwi.copy(_pw).invert();
    o.quaternion.copy(_pwi).multiply(_q).multiply(_pw).multiply(this.rest);
    o.updateMatrixWorld(true);
  }
}

// ---- poses --------------------------------------------------------------------------------------
const KEYS = ['hy', 'hx', 'hz', 'pp', 'pyaw', 'proll', 'sp', 'ch', 'sr', 'hp', 'hyaw', 'hr',
  't0', 't1', 'k0', 'k1', 'f0', 'f1', 's0', 's1', 'a0', 'a1', 'e0', 'e1', 'o0', 'o1', 'y0', 'y1', 'w0', 'w1'];
const makePose = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
function blend(dst, src, w) {
  if (w <= 0.0005) return;
  w = Math.min(1, w);
  for (const k of KEYS) dst[k] += (src[k] - dst[k]) * w;
}

const _a = new THREE.Vector3(), _hp = new THREE.Vector3(), _fp = new THREE.Vector3(), _tgt = [new THREE.Vector3(), new THREE.Vector3()];
const _pole = new THREE.Vector3(), _thighQ = [new THREE.Quaternion(), new THREE.Quaternion()], _kneeQ = [new THREE.Quaternion(), new THREE.Quaternion()];
const _footQ = new THREE.Quaternion(), _kq = new THREE.Quaternion(), _e = new THREE.Euler(), _hipW = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const WALK = 2.0, RUN = 4.2;
const _qm = new THREE.Quaternion(), _qo = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _hm = new THREE.Vector3(), _ho = new THREE.Vector3();
const _fw = new THREE.Vector3(), _fq = new THREE.Quaternion();
const REST_FOOT_PITCH = Math.atan2(0.065, 0.152);

export class Animator {
  constructor(rig) {
    this.rig = rig;
    const P = rig.P;
    this.jiggles = rig.jiggles.map((d) => new Jiggle(d));
    this.leanX = new Spring(70, 13);
    this.leanZ = new Spring(70, 12);
    this.sq = new Spring(P.sqK, P.sqC);
    this.sq.v = 2.0; // little "pop" when a traveller appears
    this.w = {
      air: new Spring(90, 19), swim: new Spring(40, 12.5), fast: new Spring(30, 11), sit: new Spring(12, 7), seat: new Spring(12, 7),
      lie: new Spring(5, 4.5), fish: new Spring(16, 8), wave: new Spring(22, 9.4), ik: new Spring(30, 11), row: new Spring(14, 7.5),
    };
    this.lookY = new Spring(45, 12);
    this.lookP = new Spring(45, 12);
    this.gazeY = new Spring(160, 25);
    this.gazeP = new Spring(160, 25);
    this.fishPose = makePose();
    this.fishTarget = makePose();
    this.gaitAmp = 0;
    this.phase = 0;
    this.swimPhase = 0;
    this.swimMove = 0;
    this.t = Math.random() * 10;
    this.idle = 0;
    this.airTime = 0;
    this.pelvisDrop = 0;
    this.prevVel = new THREE.Vector3();
    this.accS = new THREE.Vector3();
    this.blink = 1.5 + Math.random() * 3;
    this.blinkT = 0;
    this.glance = 1.5;
    this.glanceY = 0;
    this.glanceP = 0;
    this.saccade = 0;
    this.sacc = [0, 0];
    this.expr = 'neutral';
    this.pose = makePose();
    this.tmp = makePose();
    this.onFootstep = null;
    this.onStroke = null;
    this.cloth = [];
    this.colliders = [];
    // real motion capture for walking, jogging and standing (humanoids); procedural until it loads
    this.mocap = null;
    this.mcPhase = 0;
    this.idlePhase = Math.random();
    this.boneList = BONES.map((b) => rig.bones[b]);
    const mk = () => BONES.map(() => new THREE.Quaternion());
    this.mqA = mk(); this.mqB = mk(); this.mqI = mk();
    this.mhA = new THREE.Vector3(); this.mhB = new THREE.Vector3(); this.mhI = new THREE.Vector3();
    if (rig.kind !== 'puff') loadMocap().then((clips) => { if (clips) this.mocap = retarget(clips, rig); });
  }

  get sitting() { return clamp(Math.max(this.w.sit.x, this.w.seat.x, this.w.lie.x, this.w.row.x), 0, 1); }

  update(dt, s) {
    const r = this.rig, P = r.P, puff = r.kind === 'puff';
    const n = Math.max(1, Math.ceil(dt / H));
    const h = dt / n;
    const scale = r.root.scale.x;
    this.t += dt;
    const W = this.w;
    const mode = s.mode || 'free';

    // ---- state weights ----------------------------------------------------------------------
    const moving = s.speed > 0.2 || s.input;
    this.idle = moving || !s.grounded || s.swimming || mode !== 'free' ? 0 : this.idle + dt;
    this.airTime = s.grounded || s.swimming ? 0 : this.airTime + dt;
    W.air.target = this.airTime > 0.08 ? 1 : 0;
    W.swim.target = s.swimming ? 1 : 0;
    W.fast.target = s.swimming && s.swimFast ? 1 : 0;
    W.sit.target = (mode === 'sit' || (mode === 'free' && this.idle > 8 && !s.noSit)) && !s.swimming ? 1 : 0;
    W.seat.target = mode === 'seat' ? 1 : 0;
    W.lie.target = mode === 'lie' ? 1 : 0;
    W.fish.target = mode === 'fish' ? 1 : 0;
    W.wave.target = mode === 'wave' ? 1 : 0;
    W.row.target = mode === 'row' ? 1 : 0;
    if (s.input && mode === 'free') W.sit.target = 0;
    const ikOn = s.grounded && !s.swimming && !(mode === 'seat' && s.seat?.kind === 'edge') && mode !== 'lie' && mode !== 'row';
    W.ik.target = ikOn ? 1 : 0;

    // ---- body physics ------------------------------------------------------------------------
    _a.subVectors(s.vel, this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.prevVel.copy(s.vel);
    _a.y = 0;
    this.accS.lerp(_a, 1 - Math.exp(-dt * 10));
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const aF = this.accS.x * fx + this.accS.z * fz;
    const aL = this.accS.x * fz - this.accS.z * fx;
    const upright = 1 - clamp(W.swim.x, 0, 1);
    this.leanX.target = clamp(Math.atan(aF / 9.8) * 0.38 + (s.slope || 0) * 0.2 * this.gaitAmp, -0.22, 0.22) * upright * (s.grounded ? 1 : 0.4);
    this.leanZ.target = clamp(-Math.atan(aL / 9.8) * 0.6, -0.28, 0.28) * upright;
    if (s.jumped) this.sq.v += P.jump;
    if (s.landed > 1.5) { this.sq.v -= s.landed * P.land; this.pelvisDrop += Math.min(0.12, s.landed * 0.012); }
    this.sq.target = (!s.grounded && !s.swimming ? clamp(s.vy * 0.01, -0.035, 0.08) : 0) - (puff ? 0.05 * this.sitting : 0);

    // ---- gait -----------------------------------------------------------------------------------
    const v = s.swimming ? 0 : s.speed;
    const runT = smooth(WALK, RUN, v);
    const gaitTarget = s.grounded ? smooth(0.08, 1.3, v) : this.gaitAmp * 0.9;
    this.gaitAmp += (gaitTarget - this.gaitAmp) * (1 - Math.exp(-dt * 9));
    const g = this.gaitAmp;
    const stride = P.stride * scale * (1 + 0.85 * runT);
    const prevPhase = this.phase;
    this.phase += dt * (v / stride);
    const swimTarget = s.swimming ? clamp(s.speed / 2.0, 0, 1) : 0;
    this.swimMove += (swimTarget - this.swimMove) * (1 - Math.exp(-dt * 4));
    const prevSwim = this.swimPhase;
    this.swimPhase += dt * (1.9 + (2.4 + 2.2 * W.fast.x) * this.swimMove);

    // ---- look target -----------------------------------------------------------------------------
    let ly = 0, lp = 0, gazeY = 0, gazeP = 0;
    r.head.getWorldPosition(_hp);
    const look = s.lookAt;
    if (look) {
      _d.subVectors(look, _hp);
      const yawTo = wrap(Math.atan2(_d.x, _d.z) - s.yaw);
      const pitchTo = -Math.atan2(_d.y, Math.hypot(_d.x, _d.z));
      if (Math.abs(yawTo) < 1.9) {
        ly = clamp(yawTo, -1.05, 1.05); lp = clamp(pitchTo, -0.55, 0.45);
        gazeY = clamp(yawTo - ly, -0.4, 0.4); gazeP = clamp(pitchTo - lp, -0.3, 0.3);
      }
    } else if (s.inputYaw != null && !s.swimming) {
      ly = clamp(wrap(s.inputYaw - s.yaw) * 0.7, -0.75, 0.75);
      gazeY = clamp(wrap(s.inputYaw - s.yaw) * 0.3, -0.35, 0.35);
    } else {
      this.glance -= dt;
      if (this.glance <= 0) {
        this.glance = 2.2 + Math.random() * 4;
        const ahead = Math.random() < 0.35;
        this.glanceY = ahead ? 0 : (Math.random() - 0.5) * 1.7;
        this.glanceP = (Math.random() - 0.65) * 0.4;
      }
      ly = this.glanceY; lp = this.glanceP;
      gazeY = this.glanceY * 0.25;
    }
    this.saccade -= dt;
    if (this.saccade <= 0) { this.saccade = 0.6 + Math.random() * 1.8; this.sacc = [(Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.08]; }
    this.lookY.target = ly; this.lookP.target = lp;
    this.gazeY.target = gazeY + this.sacc[0]; this.gazeP.target = gazeP + this.sacc[1];

    for (let i = 0; i < n; i++) {
      this.leanX.step(h); this.leanZ.step(h); this.sq.step(h);
      for (const k in W) W[k].step(h);
      this.lookY.step(h); this.lookP.step(h); this.gazeY.step(h); this.gazeP.step(h);
    }
    const wt = {};
    for (const k in W) wt[k] = clamp(W[k].x, 0, 1);

    // ---- locomotion pose --------------------------------------------------------------------------
    const L = this.pose;
    const idleW = 1 - g;
    const ws = Math.sin(this.t * 0.5);   // slow weight shift
    const br = Math.sin(this.t * 1.6);   // breathing
    for (const k of KEYS) L[k] = 0;
    if (puff) {
      const A = (0.6 + 0.25 * runT) * g;
      for (let i = 0; i < 2; i++) {
        const sn = Math.sin(this.phase + i * Math.PI);
        L['t' + i] = A * sn; L['f' + i] = -0.4 * A * sn;
        L['a' + i] = -0.35 * A * sn;
        L['o' + i] = 0.12 + 0.5 * g * Math.abs(Math.sin(this.phase)) + 0.35 * runT + idleW * 0.05 * br;
      }
      L.hy = g * (0.06 + 0.05 * runT) * Math.abs(Math.sin(this.phase));
      L.proll = 0.16 * g * Math.sin(this.phase) + idleW * 0.03 * ws;
      L.sp = 0.05 * g + 0.12 * runT;
    } else {
      const A = (0.42 + 0.22 * runT) * g;
      for (let i = 0; i < 2; i++) {
        const ph = this.phase + i * Math.PI;
        const sn = Math.sin(ph), cs = Math.cos(ph);
        const th = A * sn + 0.04 * runT * g;
        const kn = g * ((0.9 + 0.75 * runT + (s.wade || 0) * 0.6) * Math.pow(Math.max(0, cs), 1.3) + 0.07 + 0.1 * runT)
          + idleW * (0.05 + 0.15 * Math.max(0, i ? -ws : ws));
        const toeOff = 0.8 * g * Math.max(0, -sn) * Math.max(0, cs);
        L['t' + i] = th; L['k' + i] = kn; L['f' + i] = th - kn + toeOff;
        const arm = -(0.3 + 0.5 * runT) * g * P.armAmp * sn;
        L['a' + i] = arm + idleW * 0.03 * br;
        L['e' + i] = 0.14 + 1.25 * runT * g + 0.25 * Math.max(0, arm) + idleW * 0.1;
        L['o' + i] = 0.06 + 0.1 * runT + idleW * 0.05;
        L['w' + i] = 0.1 + 0.35 * runT * g;
        L['s' + i] = 0.02 + idleW * 0.035;
      }
      const as = Math.abs(Math.sin(this.phase));
      L.hy = -P.legLen * 0.7 * (1 - Math.cos(A * as)) + g * runT * 0.045 * Math.abs(Math.cos(this.phase)) - idleW * 0.006 * (1 + br);
      L.hx = -P.sway * g * (1 - 0.6 * runT) * Math.cos(this.phase) + idleW * 0.03 * ws;
      L.pyaw = -0.18 * A * Math.sin(this.phase);
      L.proll = 0.045 * g * Math.cos(this.phase) + idleW * 0.035 * ws;
      L.pp = 0.05 * runT * g;
      L.sp = 0.04 * Math.min(v / WALK, 1) + 0.17 * runT + idleW * 0.01 * br;
      L.ch = 0.3 * A * Math.sin(this.phase);
      L.sr = -idleW * 0.02 * ws;
    }

    // ---- air ------------------------------------------------------------------------------------------
    if (wt.air > 0.001) {
      const T = this.tmp; Object.assign(T, L);
      const rise = clamp(s.vy / 6, -1, 1), fall = clamp(-s.vy / 9, 0, 1);
      if (puff) {
        T.t0 = 0.35; T.t1 = -0.35; T.f0 = T.f1 = 0.2; T.o0 = T.o1 = 0.7 + 0.5 * fall; T.a0 = T.a1 = 0.2; T.hy = 0; T.proll = 0; T.sp = -0.05 * rise;
      } else {
        T.t0 = 0.85 - 0.55 * fall; T.k0 = 1.35 - 0.9 * fall; T.t1 = -0.25 + 0.35 * fall; T.k1 = 0.75 - 0.3 * fall;
        T.f0 = T.t0 - T.k0 + 0.25; T.f1 = T.t1 - T.k1 + 0.25;
        T.a0 = 0.45; T.a1 = -0.3; T.e0 = T.e1 = 0.5; T.o0 = T.o1 = 0.35 + 0.7 * fall; T.w0 = T.w1 = 0.1;
        T.hy = 0; T.hx = 0; T.pyaw = 0; T.proll = 0; T.pp = 0; T.sp = 0.08 - 0.12 * rise; T.ch = 0;
      }
      T.hp = -0.15 * rise;
      blend(L, T, wt.air);
    }

    // ---- swim -----------------------------------------------------------------------------------------
    if (wt.swim > 0.001) {
      const T = this.tmp; Object.assign(T, L);
      const m = this.swimMove, ps = this.swimPhase, fast = wt.fast;
      const swimHips = puff ? -0.05 - 0.37 * scale : -0.1;
      T.hy = (swimHips - s.rootY) / scale - P.hipsY;
      T.hx = 0; T.hz = 0; T.pyaw = 0; T.ch = 0; T.sr = 0;
      if (puff) {
        T.pp = 0; T.sp = 0.2 * m; T.proll = 0.1 * Math.sin(ps);
        for (let i = 0; i < 2; i++) {
          T['t' + i] = 0.7 * Math.sin(ps * 1.6 + i * Math.PI); T['f' + i] = 0;
          T['o' + i] = 0.6 + 0.45 * Math.sin(ps * 1.6 + i * Math.PI); T['a' + i] = 0.3;
        }
        T.hp = 0;
      } else {
        T.pp = 0.3 + (1.2 + 0.1 * fast) * m;
        T.sp = -0.28 * m;
        T.hp = -0.2 - 0.5 * m;
        T.proll = 0.35 * Math.sin(ps) * m * fast;
        for (let i = 0; i < 2; i++) {
          const sg = i ? Math.PI : 0;
          // treading water
          const ta = 0.6, to = 0.9 + 0.3 * Math.sin(ps * 1.3 + sg), te = 0.7, ty = 0.3 * Math.sin(ps * 1.3 + sg);
          const tt = 0.45 * Math.sin(ps + sg), tk = 0.9 + 0.4 * Math.sin(ps + sg + 1.2);
          // breaststroke
          const ba = 2.35 + 0.55 * Math.cos(ps), bo = 0.65 - 0.55 * Math.cos(ps) + 0.1 * Math.sin(ps), be = 0.95 - 0.85 * Math.cos(ps);
          const bt = 0.45 - 0.45 * Math.cos(ps), bk = 0.9 - 0.8 * Math.cos(ps);
          // front crawl: continuous windmill, elbow high on recovery, flutter kick
          const cph = ((ps + sg) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
          const ca = cph, co = 0.15, ce = 0.9 * Math.max(0, Math.sin(cph));
          const ct = -0.1 + 0.25 * Math.sin(2.5 * ps + sg), ck = 0.2 + 0.25 * Math.max(0, Math.sin(2.5 * ps + sg + 1));
          const mixA = (x, y, z) => (1 - m) * x + m * ((1 - fast) * y + fast * z);
          T['a' + i] = mixA(ta, ba, ca); T['o' + i] = mixA(to, bo, co); T['e' + i] = mixA(te, be, ce);
          T['y' + i] = (1 - m) * ty; T['w' + i] = 0.2;
          T['t' + i] = mixA(tt, bt, ct); T['k' + i] = mixA(tk, bk, ck);
          T['s' + i] = (1 - m) * 0.1 + m * (1 - fast) * (0.18 - 0.15 * Math.cos(ps));
          T['f' + i] = 0.5 * m + 0.2;
        }
        T.hyaw = 0.7 * fast * m * Math.pow(Math.max(0, Math.sin(ps)), 6); // turn to breathe
      }
      blend(L, T, wt.swim);
    }

    // ---- sit on the grass --------------------------------------------------------------------------
    if (wt.sit > 0.001) {
      const T = this.tmp; Object.assign(T, L);
      T.hy = P.sitHips - P.hipsY; T.hx = 0; T.hz = 0; T.pyaw = 0; T.proll = 0; T.ch = 0; T.sr = 0;
      if (puff) {
        T.t0 = T.t1 = 1.1; T.f0 = T.f1 = -0.2; T.sp = -0.12; T.a0 = T.a1 = 0.1; T.o0 = T.o1 = 0.35;
      } else {
        T.pp = -0.05;
        T.t0 = 2.0; T.t1 = 1.85; T.k0 = 1.05; T.k1 = 0.9; T.f0 = T.t0 - T.k0; T.f1 = T.t1 - T.k1; T.s0 = 0.18; T.s1 = 0.15;
        T.a0 = T.a1 = 0.95; T.e0 = T.e1 = 0.4; T.o0 = T.o1 = 0.08; T.y0 = T.y1 = 0; T.w0 = T.w1 = 0.1;
        T.sp = 0.14 + 0.012 * br;
      }
      T.hp = -0.22;
      blend(L, T, wt.sit);
    }

    // ---- seats: bench or the edge of the dock --------------------------------------------------------
    if (wt.seat > 0.001 && s.seat) {
      const T = this.tmp; Object.assign(T, L);
      T.hy = (s.seat.hipsY - s.rootY) / scale - P.hipsY; T.hx = 0; T.hz = 0; T.pyaw = 0; T.proll = 0; T.ch = 0; T.sr = 0;
      if (puff) {
        T.t0 = T.t1 = 1.2; T.f0 = T.f1 = 0; T.a0 = T.a1 = 0.1; T.o0 = T.o1 = 0.4; T.sp = -0.05;
      } else if (s.seat.kind === 'edge') {
        for (let i = 0; i < 2; i++) {
          T['t' + i] = 1.45; T['k' + i] = 1.35 + 0.28 * Math.sin(this.t * 1.3 + i * 2.2); T['f' + i] = 0.35; T['s' + i] = 0.08;
          T['a' + i] = -0.42; T['e' + i] = 0.1; T['o' + i] = 0.3; T['y' + i] = 0; T['w' + i] = -0.6;
        }
        T.pp = -0.12; T.sp = -0.1;
      } else {
        for (let i = 0; i < 2; i++) {
          T['t' + i] = 1.5; T['k' + i] = 1.5; T['f' + i] = 0; T['s' + i] = 0.1;
          T['a' + i] = 0.55; T['e' + i] = 0.95; T['o' + i] = 0.08; T['y' + i] = 0.15; T['w' + i] = 0.1;
        }
        T.pp = 0; T.sp = 0.05 + 0.012 * br;
      }
      T.hp = -0.12;
      blend(L, T, wt.seat);
    }

    // ---- lying in the grass --------------------------------------------------------------------------
    if (wt.lie > 0.001) {
      const T = this.tmp; Object.assign(T, L);
      T.hy = 0; T.hx = 0; T.hz = 0; T.pp = 0; T.pyaw = 0; T.proll = 0; T.sp = 0.02 * br; T.ch = 0; T.sr = 0;
      T.t0 = 0.05; T.k0 = 0.08; T.t1 = 0.8; T.k1 = 1.55; T.f0 = -0.1; T.f1 = T.t1 - T.k1; T.s0 = 0.05; T.s1 = 0.12;
      T.a0 = T.a1 = 2.85; T.e0 = T.e1 = 2.1; T.o0 = T.o1 = 0.55; T.y0 = T.y1 = 0;
      T.hp = 0.12;
      blend(L, T, wt.lie);
    }

    // ---- fishing -----------------------------------------------------------------------------------------
    if (wt.fish > 0.001 && s.fish) this.fishing(L, s.fish, wt.fish, dt, br);

    // ---- rowing: sit on the thwart, reach toward the stern at the catch, lie back as the oars drive ----------
    if (wt.row > 0.001 && s.row) {
      const T = this.tmp; Object.assign(T, L);
      const R = s.row, ph = R.phase;
      const k = ph < 0.5 ? smooth(0, 1, ph / 0.5) : 1 - smooth(0, 1, (ph - 0.5) / 0.5); // 0 catch → 1 finish
      const lean = (0.34 - 0.62 * k) * R.rowing;
      T.hy = (R.hipsY - s.rootY) / scale - P.hipsY; T.hx = 0; T.hz = 0; T.pyaw = 0; T.proll = 0; T.ch = 0; T.sr = 0;
      T.pp = lean * 0.55; T.sp = lean * 0.45 + 0.03 + 0.01 * br;
      for (let i = 0; i < 2; i++) {
        T['t' + i] = 1.32 - 0.12 * k * R.rowing; T['k' + i] = 1.45 + 0.2 * (1 - k) * R.rowing; T['f' + i] = T['t' + i] - T['k' + i] + 0.15; T['s' + i] = 0.14;
        T['a' + i] = 0.9; T['e' + i] = 0.7; T['o' + i] = 0.2; T['y' + i] = 0; T['w' + i] = 0.1;
      }
      T.hp = -lean * 0.55;
      blend(L, T, wt.row);
    }

    // ---- wave ---------------------------------------------------------------------------------------------
    if (wt.wave > 0.001) {
      const T = this.tmp; Object.assign(T, L);
      T.a1 = 2.75; T.o1 = 0.5; T.e1 = 0.35 + 0.35 * Math.sin(this.t * 9); T.y1 = 0.25 * Math.sin(this.t * 9); T.w1 = 0;
      T.hr = 0.08; T.sr = 0.05;
      blend(L, T, wt.wave);
    }

    // ---- head: look + stabilise ------------------------------------------------------------------------
    const lookW = 1 - wt.lie * 0.7;
    L.hyaw += this.lookY.x * 0.75 * lookW;
    L.ch += this.lookY.x * 0.2 * lookW;
    L.hp += (this.lookP.x - (L.sp * 0.6 + L.pp * 0.5 + this.leanX.x * 0.5) * upright * (1 - wt.sit * 0.5)) * lookW;
    L.hr += -this.leanZ.x * 0.4;

    // ---- apply to bones -------------------------------------------------------------------------------
    r.hips.position.set(L.hx, P.hipsY + L.hy, L.hz);
    r.hips.rotation.set(L.pp, L.pyaw, L.proll);
    const twist = L.ch - L.pyaw * 0.8;
    r.spine.rotation.set(L.sp * 0.45, twist * 0.45, L.sr * 0.5);
    r.chest.rotation.set(L.sp * 0.55, twist * 0.55, L.sr * 0.5);
    if (puff) r.head.rotation.set(L.hp * 0.6, L.hyaw * 0.9, 0);
    else {
      r.neck.rotation.set(L.hp * 0.35, L.hyaw * 0.35, L.hr * 0.4);
      r.head.rotation.set(L.hp * 0.65, L.hyaw * 0.65, L.hr * 0.6);
    }
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? 1 : -1;
      r.thighs[i].rotation.set(-L['t' + i], 0, sg * L['s' + i]);
      r.knees[i].rotation.set(L['k' + i], 0, 0);
      r.feet[i].rotation.set(L['f' + i], 0, 0);
      r.shoulders[i].rotation.set(-L['a' + i], sg * L['y' + i], sg * L['o' + i]);
      r.elbows[i].rotation.set(-L['e' + i], 0, 0);
      r.hands[i].rotation.set(-L['w' + i], 0, 0);
    }
    // ---- motion capture locomotion ------------------------------------------------------------------
    let mcActive = false, wLoco = 0;
    const prevMc = this.mcPhase;
    if (this.mocap && !puff) {
      const M = this.mocap;
      wLoco = clamp(1 - Math.max(wt.air * 0.85, wt.swim, wt.sit, wt.seat, wt.lie, wt.fish, wt.row), 0, 1);
      const vLocal = (s.swimming || !s.grounded ? 0 : s.speed) / scale;
      const k = smooth(M.walk.speed * 0.95, M.jog.speed, vLocal); // walk → jog
      const cyc = M.walk.cycle + (M.jog.cycle - M.walk.cycle) * k;
      this.mcPhase += (dt * vLocal) / Math.max(cyc, 0.1);
      this.idlePhase += dt / M.idle.duration;
      if (wLoco > 0.001) {
        mcActive = true;
        sampleClip(M.walk, this.mcPhase, this.mqA, this.mhA);
        sampleClip(M.jog, this.mcPhase, this.mqB, this.mhB);
        sampleClip(M.idle, this.idlePhase, this.mqI, this.mhI);
        for (let j = 0; j < BONES.length; j++) {
          _qm.slerpQuaternions(this.mqA[j], this.mqB[j], k);
          _qo.slerpQuaternions(this.mqI[j], _qm, g);
          this.boneList[j].quaternion.slerp(_qo, wLoco);
        }
        _hm.lerpVectors(this.mhA, this.mhB, k);
        _ho.lerpVectors(this.mhI, _hm, g);
        r.hips.position.lerp(_ho, wLoco);
        // head: look at things + keep the eyes level against the body lean
        const wl = wLoco * lookW;
        const pitch = (this.lookP.x - this.leanX.x * 0.5 * upright) * wl, yaw = this.lookY.x * wl;
        r.neck.quaternion.multiply(_qw.setFromEuler(_e.set(pitch * 0.35, yaw * 0.35, 0, 'YXZ')));
        r.head.quaternion.multiply(_qw.setFromEuler(_e.set(pitch * 0.65, yaw * 0.65, -this.leanZ.x * 0.4 * wLoco, 'YXZ')));
        // a wave rides on top of the captured motion
        if (wt.wave > 0.001) {
          r.shoulders[1].quaternion.slerp(_qw.setFromEuler(_e.set(-2.75, -0.25 * Math.sin(this.t * 9), -0.5, 'XYZ')), wt.wave);
          r.elbows[1].quaternion.slerp(_qw.setFromEuler(_e.set(-(0.35 + 0.35 * Math.sin(this.t * 9)), 0, 0, 'XYZ')), wt.wave);
        }
      }
    }
    this.mcActive = mcActive;

    // whole-body lean (physics) and lying down (rotate onto the back about the feet)
    const lie = wt.lie;
    r.lean.rotation.set(this.leanX.x * (1 - lie) - (Math.PI / 2) * lie, 0, this.leanZ.x * (1 - lie));
    r.lean.position.set(0, 0.14 * lie, 0);
    const q = clamp(this.sq.x, -0.3, 0.3), wq = 1 / Math.sqrt(1 + q);
    r.squash.scale.set(wq, 1 + q, wq);

    // ---- feet on the ground (IK) ------------------------------------------------------------------------
    r.root.updateMatrixWorld(true);
    if (wt.ik > 0.01 && s.groundAt && !puff) this.plantFeet(s, wt.ik, L, scale);
    else this.pelvisDrop *= Math.exp(-dt * 8);
    if (wt.row > 0.01 && s.row?.handles && !puff) this.gripOars(s, wt.row);

    // ---- face ------------------------------------------------------------------------------------------------
    this.face(dt, s, wt);

    // ---- secondary motion ----------------------------------------------------------------------------------
    for (const j of this.jiggles) j.update(dt, n, scale);
    if (this.cloth.length) this.updateCloth(dt, s, scale);

    // ---- events ------------------------------------------------------------------------------------------------
    if (mcActive && this.onFootstep && s.grounded && !s.swimming && g > 0.35) {
      for (let i = 0; i < 2; i++) {
        const off = i * 0.5;
        if (Math.floor(prevMc - off) !== Math.floor(this.mcPhase - off)) {
          r.feet[i].getWorldPosition(_fp);
          this.onFootstep(i, _fp, 0.6 + 0.6 * runT);
        }
      }
    } else if (this.onFootstep && s.grounded && !s.swimming && g > 0.35) {
      for (let i = 0; i < 2; i++) {
        const off = i * Math.PI - Math.PI / 2;
        if (Math.floor((prevPhase + off) / (2 * Math.PI)) !== Math.floor((this.phase + off) / (2 * Math.PI))) {
          r.feet[i].getWorldPosition(_fp);
          this.onFootstep(i, _fp, 0.6 + 0.6 * runT);
        }
      }
    }
    if (this.onStroke && s.swimming && this.swimMove > 0.25) {
      const per = W.fast.x > 0.5 ? Math.PI : Math.PI * 2;
      if (Math.floor(prevSwim / per) !== Math.floor(this.swimPhase / per)) {
        r.head.getWorldPosition(_fp);
        this.onStroke(_fp, W.fast.x > 0.5);
      }
    }
  }

  plantFeet(s, w, L, scale) {
    const r = this.rig, P = r.P;
    const yaw = s.yaw;
    _pole.set(Math.sin(yaw), 0, Math.cos(yaw));
    const rootY = r.root.position.y;
    const rest = P.footRest * scale;
    // captured feet keep their heel–toe roll: remember each foot's pitch before IK moves the leg
    this.fkPitch = this.fkPitch || [0, 0];
    for (let i = 0; i < 2; i++) {
      r.feet[i].getWorldQuaternion(_fq);
      _fw.set(0, -0.065, 0.152).normalize().applyQuaternion(_fq);
      this.fkPitch[i] = Math.atan2(-_fw.y, Math.hypot(_fw.x, _fw.z)) - REST_FOOT_PITCH;
    }
    // targets: keep each foot's lift but measure it from the ground under that foot
    let need = 0;
    for (let i = 0; i < 2; i++) {
      r.feet[i].getWorldPosition(_fp);
      const lift = Math.max(0, _fp.y - (rootY + rest));
      const gy = s.groundAt(_fp.x, _fp.z);
      _tgt[i].set(_fp.x, gy + rest + lift, _fp.z);
      r.thighs[i].getWorldPosition(_hipW);
      r.knees[i].getWorldPosition(_v1);
      const reach = _hipW.distanceTo(_v1) + _v1.distanceTo(_fp);
      need = Math.max(need, _hipW.distanceTo(_tgt[i]) - reach * 0.985);
    }
    // lower the pelvis if a foot can't reach (downhill side, landing), recover smoothly
    this.pelvisDrop = need > this.pelvisDrop ? need : this.pelvisDrop + (need - this.pelvisDrop) * 0.12;
    if (this.pelvisDrop > 0.0005) {
      r.hips.position.y -= (this.pelvisDrop * w) / scale;
      r.root.updateMatrixWorld(true);
    }
    for (let i = 0; i < 2; i++) {
      _thighQ[i].copy(r.thighs[i].quaternion);
      _kneeQ[i].copy(r.knees[i].quaternion);
      solveTwoBone(r.thighs[i], r.knees[i], r.feet[i], _tgt[i], _pole);
      if (w < 0.999) {
        _ikQ.copy(r.thighs[i].quaternion);
        r.thighs[i].quaternion.copy(_thighQ[i]).slerp(_ikQ, w);
        _ikQ.copy(r.knees[i].quaternion);
        r.knees[i].quaternion.copy(_kneeQ[i]).slerp(_ikQ, w);
        r.thighs[i].updateMatrixWorld(true);
      }
      // sole follows the slope under the foot, plus any toe-off from the pose
      r.feet[i].getWorldPosition(_fp);
      const ahead = s.groundAt(_fp.x + _pole.x * 0.18, _fp.z + _pole.z * 0.18);
      const behind = s.groundAt(_fp.x - _pole.x * 0.18, _fp.z - _pole.z * 0.18);
      const slope = Math.atan2(ahead - behind, 0.36);
      const extra = this.mcActive ? this.fkPitch[i] : L['f' + i] - (L['t' + i] - L['k' + i]);
      _e.set(-slope + extra, yaw, 0, 'YXZ');
      _footQ.setFromEuler(_e);
      r.knees[i].updateMatrixWorld(true);
      r.knees[i].getWorldQuaternion(_kq);
      const local = _kq.invert().multiply(_footQ);
      r.feet[i].quaternion.slerp(local, w);
      r.feet[i].updateMatrixWorld(true);
    }
  }

  // Hands on the oar handles: two-bone IK per arm, elbows out and a little down.
  gripOars(s, w) {
    const r = this.rig;
    r.root.updateMatrixWorld(true);
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1; // left arm reaches out on the character's left (+x local)
      _pole.set(fz * side * 0.8 - fx * 0.3, -0.5, -fx * side * 0.8 - fz * 0.3);
      _thighQ[i].copy(r.shoulders[i].quaternion);
      _kneeQ[i].copy(r.elbows[i].quaternion);
      solveTwoBone(r.shoulders[i], r.elbows[i], r.hands[i], s.row.handles[i], _pole);
      if (w < 0.999) {
        _ikQ.copy(r.shoulders[i].quaternion);
        r.shoulders[i].quaternion.copy(_thighQ[i]).slerp(_ikQ, w);
        _ikQ.copy(r.elbows[i].quaternion);
        r.elbows[i].quaternion.copy(_kneeQ[i]).slerp(_ikQ, w);
      }
      r.shoulders[i].updateMatrixWorld(true);
    }
  }

  fishing(L, f, w, dt, br) {
    const T = this.fishTarget;
    Object.assign(T, L);
    const ph = f.pose, t = f.t;
    // stance for all fishing poses: feet apart, knees soft
    T.t0 = 0.12; T.t1 = -0.08; T.k0 = 0.12; T.k1 = 0.1; T.f0 = T.t0 - T.k0; T.f1 = T.t1 - T.k1; T.s0 = T.s1 = 0.08;
    T.hy = -0.01; T.hx = 0; T.pyaw = -0.08; T.proll = 0; T.pp = 0;
    // rod hand (right, index 1) and the helping hand (left, index 0)
    T.a1 = 0.62; T.e1 = 1.05; T.o1 = 0.1; T.y1 = -0.2; T.w1 = -0.35;
    T.a0 = 0.55; T.e0 = 1.35; T.o0 = -0.02; T.y0 = 0.55; T.w0 = 0.2;
    T.sp = 0.06 + 0.01 * br; T.ch = 0.05; T.hp = 0.12;
    if (ph === 'windup') {
      T.a1 = 2.55; T.e1 = 1.5; T.o1 = 0.3; T.y1 = 0; T.w1 = 0.35; T.a0 = 0.45; T.e0 = 0.6; T.y0 = 0.2;
      T.sp = -0.12; T.ch = 0.35; T.hp = -0.12; T.t0 = 0.2; T.t1 = -0.15;
    } else if (ph === 'cast') {
      T.a1 = 1.05; T.e1 = 0.2; T.w1 = -0.1; T.a0 = 0.35; T.e0 = 0.5; T.y0 = 0.1; T.sp = 0.16; T.ch = -0.25; T.hp = 0.0;
    } else if (ph === 'bite') {
      T.sp = 0.12; T.a1 = 0.7; T.w1 = -0.5;
    } else if (ph === 'reel') {
      const om = 11;
      T.a1 = 0.85 + 0.04 * Math.sin(t * 17) * f.tension; T.e1 = 0.75; T.w1 = -0.55; T.y1 = -0.1;
      T.a0 = 0.72 + 0.15 * Math.sin(t * om); T.e0 = 1.25 + 0.22 * Math.cos(t * om); T.y0 = 0.5;
      T.sp = -0.1 + 0.03 * Math.sin(t * 13) * f.tension; T.ch = 0.08 * Math.sin(t * 7) * f.tension; T.pp = -0.04;
      T.t0 = 0.25; T.t1 = -0.2; T.k0 = 0.3; T.f0 = T.t0 - T.k0;
    } else if (ph === 'hold') {
      T.a0 = T.a1 = 1.25; T.e0 = T.e1 = 0.95; T.o0 = T.o1 = -0.12; T.y0 = T.y1 = 0.32; T.w0 = T.w1 = 0.2;
      T.sp = -0.06; T.hp = 0.22; T.ch = 0;
    } else if (ph === 'toss') {
      const k = clamp(t / 0.45, 0, 1);
      T.a0 = T.a1 = 1.3 - 0.9 * k; T.e0 = T.e1 = 0.9 - 0.7 * k; T.o0 = T.o1 = -0.1; T.y0 = T.y1 = 0.3; T.sp = 0.1 * k; T.hp = 0.15;
    }
    // follow the target smoothly so poses flow into each other
    const P = this.fishPose;
    const rate = ph === 'cast' ? 22 : ph === 'toss' ? 14 : 8;
    const k = 1 - Math.exp(-dt * rate);
    for (const key of KEYS) P[key] += (T[key] - P[key]) * k;
    blend(L, P, w);
  }

  face(dt, s, wt) {
    const fc = this.rig.face;
    if (!fc || !fc.eyes.length) return;
    // blink; sleepy eyes after resting a while
    this.blink -= dt;
    if (this.blink <= 0) { this.blinkT = 0.13; this.blink = Math.random() < 0.2 ? 0.28 : 1.8 + Math.random() * 4; }
    this.blinkT -= dt;
    const resting = Math.max(wt.sit, wt.lie, wt.seat);
    const sleepy = resting * smooth(12, 22, this.restTime = (resting > 0.9 ? (this.restTime || 0) + dt : 0)) * 0.55 + wt.lie * 0.25;
    const closed = this.blinkT > 0 ? 1 : Math.min(0.85, sleepy);
    const gy = this.gazeY.x, gp = this.gazeP.x;
    for (const e of fc.eyes) {
      e.lid.rotation.x = e.open + (e.closed - e.open) * closed;
      e.gaze.rotation.set(gp * 0.8, gy * 0.9, 0);
    }
    const expr = s.expression || (wt.wave > 0.5 ? 'smile' : resting > 0.8 ? 'smile' : 'neutral');
    const m = fc.mouth;
    if (m) {
      m.line.visible = expr !== 'o';
      m.oh.visible = expr === 'o';
      const target = expr === 'smile' ? 2.4 : 1;
      m.line.scale.y += (target - m.line.scale.y) * (1 - Math.exp(-dt * 10));
      m.line.scale.x = 1 + (m.line.scale.y - 1) * 0.08;
    }
    for (const b of fc.brows) {
      const up = expr === 'o' ? 0.007 : expr === 'smile' ? 0.002 : 0;
      b.mesh.position.y += (b.y0 + up - b.mesh.position.y) * (1 - Math.exp(-dt * 12));
    }
  }

  updateCloth(dt, s, scale) {
    const r = this.rig;
    const C = this.colliders;
    const defs = r.colliderDefs;
    if (defs) {
      // per-rig capsules: [bone, bind-pose point] pairs, or points on a rigid prop
      if (!C.length) for (const d of defs) C.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, def: d });
      for (const c of C) {
        const d = c.def;
        if (d.obj) {
          c.a.set(d.a[0], d.a[1], d.a[2]).applyMatrix4(d.obj.matrixWorld);
          c.b.set(d.b[0], d.b[1], d.b[2]).applyMatrix4(d.obj.matrixWorld);
        } else {
          const ja = r.J[d.a[0]], jb = r.J[d.b[0]], pa = d.a[1], pb = d.b[1];
          c.a.set(pa[0] - ja[0], pa[1] - ja[1], pa[2] - ja[2]).applyMatrix4(r.bones[d.a[0]].matrixWorld);
          c.b.set(pb[0] - jb[0], pb[1] - jb[1], pb[2] - jb[2]).applyMatrix4(r.bones[d.b[0]].matrixWorld);
        }
        c.r = d.r * scale;
      }
    } else {
      if (!C.length) {
        for (let i = 0; i < 6; i++) C.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 });
      }
      for (let i = 0; i < 2; i++) {
        r.thighs[i].getWorldPosition(C[i * 2].a); r.knees[i].getWorldPosition(C[i * 2].b); C[i * 2].r = 0.105 * scale;
        r.knees[i].getWorldPosition(C[i * 2 + 1].a); r.feet[i].getWorldPosition(C[i * 2 + 1].b); C[i * 2 + 1].r = 0.075 * scale;
      }
      r.hips.getWorldPosition(C[4].a); C[4].b.copy(C[4].a); C[4].a.y += 0.02 * scale; C[4].b.y -= 0.08 * scale; C[4].r = 0.14 * scale;
      r.spine.getWorldPosition(C[5].a); r.neck.getWorldPosition(C[5].b); C[5].r = 0.15 * scale;
    }
    const t = this.t;
    _v2.set(Math.sin(t * 0.7) * 0.8 + Math.sin(t * 2.3) * 0.4, 0, Math.cos(t * 0.5) * 0.5);
    const p = r.root.position;
    const floorY = s.floorY ?? (s.swimming || !s.groundAt ? -Infinity : s.groundAt(p.x, p.z) + 0.012 * scale);
    const waterY = s.waterY ?? -Infinity;
    for (const c of this.cloth) c.update(dt, C, _v2, floorY, waterY);
  }
}
