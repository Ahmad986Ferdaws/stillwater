import * as S from './sdf.js';

// Thorfinn, sculpted from signed-distance shapes at realistic adult proportions (about 7.7 heads).
// Pure data in, typed arrays out, so the heavy meshing can run in a Web Worker.
//
// Pieces: body (tunic, trousers, leg wraps, boots, belts) · head (face, scar, brows, ears, neck) ·
// two gloved hands · hair · fur collar · belt buckle · seax · ring brooch · hanging strap end.
// Skinned pieces share one skeleton; rigid pieces ride on a bone. Every vertex gets a colour, material
// weights (skin/wool/leather/metal · fur/hair/knit/scar) and ambient occlusion baked from the
// combined distance field.

// ---- skeleton (bind pose, character metres) ----------------------------------------------------
export const J = { hips: [0, 0.975, 0], spine: [0, 1.1, -0.005], chest: [0, 1.3, -0.012], neck: [0, 1.53, -0.025], head: [0, 1.645, -0.018] };
for (const s of [1, -1]) {
  const k = s > 0 ? 'L' : 'R';
  J['shoulder' + k] = [0.185 * s, 1.49, -0.022];
  J['elbow' + k] = [0.212 * s, 1.18, -0.04];
  J['hand' + k] = [0.232 * s, 0.9, -0.008];
  J['thigh' + k] = [0.092 * s, 0.935, 0.004];
  J['knee' + k] = [0.1 * s, 0.52, 0.018];
  J['foot' + k] = [0.108 * s, 0.085, -0.012];
}
export const BONE_ORDER = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'thighL', 'kneeL', 'footL', 'thighR', 'kneeR', 'footR'];
const BONE_INDEX = Object.fromEntries(BONE_ORDER.map((b, i) => [b, i]));

export const HC = [0, 1.765, -0.012]; // centre of the cranium
const hp = (dx, dy, dz) => [HC[0] + dx, HC[1] + dy, HC[2] + dz];
export const EYE = { r: 0.0122, y: HC[1] - 0.035, z: HC[2] + 0.076, x: 0.031 };
export const eyeCentre = (s) => [EYE.x * s, EYE.y, EYE.z];

// ---- look: colour (sRGB) + material weights [skin, wool, leather, metal] [fur, hair, knit, scar] --------
const LOOK = {
  skin: ['#d8a687', [1, 0, 0, 0], [0, 0, 0, 0]],
  lip: ['#b98272', [1, 0, 0, 0], [0, 0, 0, 0]],
  lipLine: ['#83463c', [1, 0, 0, 0], [0, 0, 0, 0]],
  scar: ['#e6bba6', [0.2, 0, 0, 0], [0, 0, 0, 0.8]],
  brow: ['#a0643a', [0, 0, 0, 0], [0, 1, 0, 0]],
  hair: ['#a4642f', [0, 0, 0, 0], [0, 1, 0, 0]],
  tunic: ['#33383e', [0, 1, 0, 0], [0, 0, 0, 0]],
  seam: ['#23272b', [0, 1, 0, 0], [0, 0, 0, 0]],
  pants: ['#2a2c2f', [0, 1, 0, 0], [0, 0, 0, 0]],
  wrap: ['#5d5348', [0, 1, 0, 0], [0, 0, 0, 0]],
  boot: ['#43301f', [0, 0, 1, 0], [0, 0, 0, 0]],
  sole: ['#241b15', [0, 0, 1, 0], [0, 0, 0, 0]],
  belt: ['#5e3c27', [0, 0, 1, 0], [0, 0, 0, 0]],
  belt2: ['#4c3121', [0, 0, 1, 0], [0, 0, 0, 0]],
  iron: ['#8d8e90', [0, 0, 0, 1], [0, 0, 0, 0]],
  bronze: ['#b08650', [0, 0, 0, 1], [0, 0, 0, 0]],
  fur: ['#c2beb6', [0, 0, 0, 0], [1, 0, 0, 0]],
  glove: ['#a3a7ab', [0, 0, 0.45, 0], [0, 0, 0.55, 0]],
  gloveCuff: ['#6b7075', [0, 0, 0.45, 0], [0, 0, 0.55, 0]],
  sheath: ['#6d452c', [0, 0, 1, 0], [0, 0, 0, 0]],
  grip: ['#3a2a1f', [0, 0, 1, 0], [0, 0, 0, 0]],
};
export const lin = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
};
export const LOOK_LIN = Object.fromEntries(Object.entries(LOOK).map(([k, [c, a, b]]) => [k, { c: lin(c), a, b }]));

// ---- helpers ---------------------------------------------------------------------------------------------
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp3 = (a, b, t, o = [0, 0, 0]) => [a[0] + (b[0] - a[0]) * t + o[0], a[1] + (b[1] - a[1]) * t + o[1], a[2] + (b[2] - a[2]) * t + o[2]];
const withBound = (fn, c, r) => { fn.b = [c[0], c[1], c[2], r]; return fn; };
// keep only the part of d on the negative side of a plane (p, n)
const clip = (d, p, n) => { const pl = S.halfSpace(p, n); const f = (x, y, z) => Math.max(d(x, y, z), pl(x, y, z)); f.b = d.b; return f; };
// squash a shape along z (sz < 1) — still a valid distance bound
const scaleZ = (d, sz) => { const f = (x, y, z) => d(x, y, z / sz) * Math.min(1, sz); if (d.b) f.b = [d.b[0], d.b[1], d.b[2] * sz, d.b[3]]; return f; };
// ring standing up, facing +z (a brooch)
const ringXY = (c, R, r) => withBound((x, y, z) => {
  const q = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2) - R;
  return Math.sqrt(q * q + (z - c[2]) ** 2) - r;
}, c, R + r);

// deterministic value noise for fur tufts
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy), fz);
}
// shaggy surface: noise pushed out of a shape, scaled back into a safe distance bound
const furry = (d, amp, freq, amp2 = 0, freq2 = 0) => {
  const lip = 1 + amp * freq * 1.6 + amp2 * freq2 * 1.6;
  const f = (x, y, z) => (d(x, y, z) - amp * (vnoise(x * freq, y * freq, z * freq) - 0.3) - amp2 * (vnoise(x * freq2 + 17, y * freq2, z * freq2) - 0.5)) / lip;
  if (d.b) f.b = [d.b[0], d.b[1], d.b[2], d.b[3] + amp];
  return f;
};
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

// Find the surface along +z at (x, y) by bisection.
function surfaceZ(f, x, y, z0 = 0.3, z1 = -0.3) {
  let a = z0, b = z1;
  if (f(x, y, a) < 0) return a;
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (f(x, y, m) > 0) a = m; else b = m; }
  return (a + b) / 2;
}

// ==================================================================================================
// BODY
// ==================================================================================================
function bodyParts() {
  const P = [];
  const add = (d, k, region, bone, extra = {}) => { P.push({ d, k, region, bone, ...extra }); return P[P.length - 1]; };
  const pelvis = add(S.ellipsoid([0, 0.965, -0.004], [0.158, 0.105, 0.112]), 0, 'tunic', 'hips', { sigma: 0.04 });
  for (const s of [1, -1]) add(S.ellipsoid([0.066 * s, 0.925, -0.048], [0.074, 0.085, 0.07]), 0.05, 'tunic', 'hips');
  const waist = add(S.ellipsoid([0, 1.1, 0.004], [0.14, 0.13, 0.1]), 0.07, 'tunic', 'spine', { sigma: 0.04 });
  const tunicPaint = (x, y, z) => (Math.abs(x) < 0.0045 && z > 0.06 && y > 1.07 && y < 1.47 ? 'seam' : 'tunic');
  const ribs = add(S.ellipsoid([0, 1.3, -0.008], [0.162, 0.175, 0.112]), 0.07, tunicPaint, 'chest', { sigma: 0.04 });
  for (const s of [1, -1]) add(S.ellipsoid([0.066 * s, 1.372, 0.048], [0.075, 0.055, 0.056]), 0.05, tunicPaint, 'chest');
  add(S.ellipsoid([0, 1.36, -0.052], [0.165, 0.12, 0.075]), 0.06, 'tunic', 'chest');
  for (const s of [1, -1]) add(S.roundCone([0.03 * s, 1.55, -0.03], [0.165 * s, 1.5, -0.028], 0.045, 0.04), 0.05, 'tunic', 'chest');
  // the tunic flares over the hips down to the sword belt, where the simulated skirt takes over
  const flare = add(clip(scaleZ(S.roundCone([0, 1.06, 0], [0, 0.9, 0], 0.13, 0.19), 0.8), [0, 0.887, 0], [0, -1, 0]), 0.03, 'tunic', 'hips', { sigma: 0.035 });
  // neck stub: the head piece carries the visible neck
  add(S.roundCone([0, 1.49, -0.026], [0, 1.6, -0.024], 0.052, 0.045), 0.04, 'tunic', 'neck', { sigma: 0.03 });

  // arms in wool sleeves
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    const sh = J['shoulder' + k], el = J['elbow' + k], wr = J['hand' + k];
    add(S.sphere([sh[0] + 0.006 * s, sh[1] - 0.015, sh[2]], 0.062), 0.05, 'tunic', null, { bones: [['shoulder' + k, 0.6], ['chest', 0.4]] });
    add(S.roundCone(sh, el, 0.058, 0.046), 0.03, 'tunic', 'shoulder' + k, { sigma: 0.03 });
    add(S.ellipsoid(lerp3(sh, el, 0.42, [0, 0, 0.006]), [0.052, 0.1, 0.054]), 0.03, 'tunic', 'shoulder' + k);
    add(S.sphere(el, 0.047), 0.03, 'tunic', null, { bones: [['shoulder' + k, 0.5], ['elbow' + k, 0.5]] });
    const wr2 = add3(wr, [0, 0.05, 0]); // sleeve ends inside the glove's cuff
    add(S.roundCone(el, wr2, 0.047, 0.039), 0.025, 'tunic', 'elbow' + k);
    add(S.ellipsoid(lerp3(el, wr, 0.3), [0.049, 0.085, 0.047]), 0.03, 'tunic', 'elbow' + k);
    // soft folds where the sleeve bunches
    for (const [t, rr] of [[0.12, 0.049], [0.62, 0.043]]) {
      const c = lerp3(el, wr, t);
      add(S.torus(c, rr, rr, 0.006), 0.012, 'tunic', 'elbow' + k);
    }
    add(S.torus(lerp3(sh, el, 0.86), 0.05, 0.05, 0.006), 0.012, 'tunic', 'shoulder' + k);
  }

  // legs: wool trousers, wrapped shins, turnshoe boots
  for (const s of [1, -1]) {
    const k = s > 0 ? 'L' : 'R';
    const th = J['thigh' + k], kn = J['knee' + k], ft = J['foot' + k];
    add(S.roundCone(th, kn, 0.098, 0.062), 0.05, 'pants', 'thigh' + k, { sigma: 0.035 });
    add(S.ellipsoid(lerp3(th, kn, 0.38, [0, 0, 0.012]), [0.078, 0.15, 0.076]), 0.04, 'pants', 'thigh' + k);
    add(S.sphere(add3(kn, [0, 0.004, 0.014]), 0.058), 0.03, 'pants', null, { bones: [['thigh' + k, 0.5], ['knee' + k, 0.5]] });
    const wrapPaint = (x, y, z) => {
      if (y > 0.43) return 'pants';
      return 'wrap';
    };
    const shin = add(S.roundCone(kn, add3(ft, [0, 0.07, 0]), 0.058, 0.046), 0.03, wrapPaint, 'knee' + k);
    const calf = add(S.ellipsoid(add3(kn, [0, -0.14, -0.022]), [0.056, 0.1, 0.056]), 0.04, wrapPaint, 'knee' + k);
    // the wraps cross over each other as they spiral up the shin
    const legBase = S.evaluator([{ d: shin.d, k: 0 }, { d: calf.d, k: 0.04 }]);
    for (let i = 0; i < 7; i++) {
      const y = 0.17 + i * 0.037;
      const c = lerp3(kn, ft, (kn[1] - y) / (kn[1] - ft[1]));
      add(withBound(S.band(legBase, 0.0025, 0.004, [c[0], y, c[2]], [0.22 * (i % 2 ? 1 : -1) * s, 1, 0.1], 0.013), [c[0], y, c[2]], 0.09), 0.006, 'wrap', 'knee' + k);
    }
    add(S.roundCone(add3(ft, [0, -0.01, -0.004]), add3(ft, [0, 0.065, -0.002]), 0.052, 0.054), 0.02, 'boot', null, { bones: [['knee' + k, 0.5], ['foot' + k, 0.5]] });
    add(S.torus(add3(ft, [0, 0.07, -0.002]), 0.056, 0.058, 0.0075), 0.006, 'boot', 'knee' + k);
    add(S.roundBox([ft[0], 0.042, ft[2] + 0.058], [0.047, 0.04, 0.1], 0.036), 0.03, 'boot', 'foot' + k);
    add(S.sphere([ft[0], 0.038, ft[2] + 0.14], 0.043), 0.025, 'boot', 'foot' + k);
    add(S.roundBox([ft[0], 0.011, ft[2] + 0.06], [0.051, 0.011, 0.132], 0.009), 0.006, 'sole', 'foot' + k);
  }

  // belts: the main belt at the waist, the sword belt slung low toward the left hip
  const torso = S.evaluator([{ d: pelvis.d, k: 0 }, { d: waist.d, k: 0.07 }, { d: ribs.d, k: 0.07 }, { d: flare.d, k: 0.03 }]);
  add(withBound(S.band(torso, 0.005, 0.0056, [0, 1.035, 0], [0, 1, 0.1], 0.021), [0, 1.035, 0], 0.24), 0.004, 'belt', null, { bones: [['spine', 0.5], ['hips', 0.5]] });
  add(withBound(S.band(torso, 0.006, 0.0052, [0, 0.935, 0], [0.26, 1, 0], 0.016), [0, 0.935, 0], 0.26), 0.004, 'belt2', 'hips');
  return { parts: P, torso };
}

// ==================================================================================================
// HEAD (face, scar, brows, ears, neck)
// ==================================================================================================
const SCARS = [
  [hp(0.05, -0.061, 0), hp(-0.021, -0.036, 0)], // across the nose, left cheek → right of the bridge
  [hp(-0.035, -0.047, 0), hp(-0.043, -0.077, 0)], // down the right cheek
  [hp(0.007, -0.129, 0), hp(0.015, -0.141, 0)], // nick on the chin
];
function segDist2(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  const px = a[0] + dx * t - x, py = a[1] + dy * t - y;
  return px * px + py * py;
}
function headParts() {
  const P = [];
  const add = (d, k, region, bone, extra = {}) => { P.push({ d, k, region, bone: bone === undefined ? 'head' : bone, ...extra }); return P[P.length - 1]; };
  const skin = (x, y, z) => {
    if (z > HC[2] + 0.04) for (const [a, b] of SCARS) if (segDist2(x, y, a, b) < 0.0021 ** 2) return 'scar';
    return 'skin';
  };
  add(S.ellipsoid(hp(0, 0, 0), [0.0755, 0.087, 0.097]), 0, skin);
  add(S.ellipsoid(hp(0, -0.009, 0.086), [0.053, 0.0135, 0.016]), 0.018, skin);
  for (const s of [1, -1]) {
    add(S.ellipsoid(hp(0.047 * s, -0.053, 0.056), [0.022, 0.014, 0.024]), 0.02, skin);
    add(S.ellipsoid(hp(0.029 * s, -0.055, 0.074), [0.02, 0.011, 0.013]), 0.018, skin);
    add(S.ellipsoid(hp(0.042 * s, -0.085, 0.047), [0.024, 0.027, 0.024]), 0.022, skin);
    add(S.ellipsoid(hp(0.023 * s, -0.083, 0.07), [0.017, 0.02, 0.017]), 0.02, skin); // beside the nose and mouth
    add(S.roundCone(hp(0.06 * s, -0.08, -0.004), hp(0.02 * s, -0.137, 0.071), 0.0165, 0.0148), 0.018, skin);
    add(S.sphere(hp(0.053 * s, -0.093, -0.004), 0.0165), 0.016, skin);
  }
  add(S.ellipsoid(hp(0, -0.094, 0.07), [0.029, 0.027, 0.026]), 0.02, skin);
  add(S.ellipsoid(hp(0, -0.136, 0.083), [0.0205, 0.017, 0.0152]), 0.018, skin);
  // nose: bridge, tip, wings
  add(S.roundCone(hp(0, -0.022, 0.089), hp(0, -0.063, 0.108), 0.0068, 0.0088), 0.012, skin);
  add(S.sphere(hp(0, -0.068, 0.1075), 0.0096), 0.008, skin);
  for (const s of [1, -1]) add(S.sphere(hp(0.0118 * s, -0.0728, 0.0965), 0.0072), 0.007, skin);
  // lips
  add(S.ellipsoid(hp(0, -0.0985, 0.0962), [0.019, 0.005, 0.0052]), 0.006, 'lip');
  add(S.ellipsoid(hp(0, -0.1085, 0.0945), [0.0168, 0.0054, 0.0058]), 0.006, 'lip');
  // ears
  for (const s of [1, -1]) {
    add(S.ellipsoid(hp(0.078 * s, -0.036, -0.012), [0.0088, 0.029, 0.018]), 0.006, skin);
    add(S.sphere(hp(0.0775 * s, -0.061, -0.006), 0.0068), 0.005, skin);
  }
  // neck, throat, the muscles that turn the head
  add(S.roundCone([0, 1.535, -0.026], [0, 1.69, -0.03], 0.058, 0.054), 0.03, skin, 'neck', { sigma: 0.03 });
  for (const s of [1, -1]) add(S.roundCone(hp(0.054 * s, -0.07, -0.036), [0.017 * s, 1.556, 0.028], 0.012, 0.0105), 0.02, skin, 'neck');
  add(S.ellipsoid([0, 1.612, 0.031], [0.0085, 0.013, 0.0088]), 0.012, skin, 'neck');
  add(S.ellipsoid([0, 1.6, -0.06], [0.045, 0.06, 0.03]), 0.03, skin, 'neck');
  add(S.ellipsoid([0, 1.626, 0.036], [0.04, 0.02, 0.034]), 0.02, skin); // under the jaw

  // ---- carving ----
  for (const s of [1, -1]) {
    add(S.ellipsoid(hp(0.0835 * s, -0.038, -0.009), [0.004, 0.015, 0.009]), 0.003, skin, null, { sub: true }); // ear bowl
    add(S.ellipsoid(hp(0.0068 * s, -0.0795, 0.1015), [0.0038, 0.0025, 0.0045]), 0.002, skin, null, { sub: true }); // nostril
    add(S.ellipsoid(hp(0.031 * s, -0.034, 0.087), [0.0205, 0.0135, 0.017]), 0.009, skin, null, { sub: true }); // eye socket
  }
  add(S.ellipsoid(hp(0, -0.089, 0.1025), [0.0035, 0.009, 0.0025]), 0.003, skin, null, { sub: true }); // philtrum
  add(S.ellipsoid(hp(0, -0.1035, 0.104), [0.0205, 0.0009, 0.009]), 0.0015, 'lipLine', null, { sub: true }); // lips meet
  // eyelids wrap the eyeballs; the almond opening shows the eye (upper lid a little low: a steady, stern look)
  for (const s of [1, -1]) add(S.sphere(eyeCentre(s), EYE.r + 0.0019), 0.0045, skin);
  for (const s of [1, -1]) add(S.ellipsoid([EYE.x * s, EYE.y - 0.0004, EYE.z + 0.008], [0.0143, 0.0052, 0.011]), 0.0018, skin, null, { sub: true });

  // brows and scars sit on the finished surface
  const base = S.evaluator(P);
  const onSurf = (x, y, dz) => [x, y, surfaceZ(base, x, y) + dz];
  for (const s of [1, -1]) {
    const pts = [[0.011, -0.0172, 0.0036], [0.024, -0.0133, 0.0034], [0.037, -0.011, 0.0029], [0.05, -0.0115, 0.0019]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay, ar] = pts[i], [bx, by, br] = pts[i + 1];
      add(S.roundCone(onSurf(ax * s, HC[1] + ay, -ar + 0.0017), onSurf(bx * s, HC[1] + by, -br + 0.0017), ar, br), 0.003, 'brow');
    }
  }
  for (const [a, b] of SCARS) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const p = lerp3(a, b, i / n), q = lerp3(a, b, (i + 1) / n);
      add(S.capsule(onSurf(p[0], p[1], 0.0008), onSurf(q[0], q[1], 0.0008), 0.0011), 0.0012, 'scar', null, { sub: true }); // a faint crease
    }
  }
  return { parts: P };
}

// ==================================================================================================
// HANDS (gloves) — relaxed, fingers slightly curled
// ==================================================================================================
function handParts(s) {
  const k = s > 0 ? 'L' : 'R';
  const W = J['hand' + k];
  const P = [];
  const add = (d, kk, region, bone, extra = {}) => P.push({ d, k: kk, region, bone, ...extra });
  const at = (x, y, z) => [W[0] + x * s, W[1] + y, W[2] + z];
  add(S.roundBox(at(-0.002, -0.052, 0.004), [0.0135, 0.046, 0.04], 0.012), 0, 'glove', 'hand' + k, { sigma: 0.02 });
  add(S.ellipsoid(at(-0.012, -0.045, 0.024), [0.012, 0.025, 0.017]), 0.012, 'glove', 'hand' + k); // thumb muscle
  // fingers: index (front) … little
  const fingers = [[0.029, 0.045, 0.027, 0.022, 0.0096], [0.01, 0.049, 0.031, 0.024, 0.0098], [-0.01, 0.046, 0.029, 0.023, 0.0093], [-0.028, 0.037, 0.022, 0.02, 0.0083]];
  fingers.forEach(([z, l1, l2, l3, r], i) => {
    let p = at(-0.001, -0.094, z);
    let ang = 0.12, spread = (1.5 - i) * 0.05;
    let rr = r;
    for (const [len, bend] of [[l1, 0.28], [l2, 0.34], [l3, 0.3]]) {
      ang += bend;
      const q = [p[0] - Math.sin(ang) * len * s, p[1] - Math.cos(ang) * len, p[2] + spread * len];
      add(S.roundCone(p, q, rr, rr * 0.9), 0.006, 'glove', 'hand' + k);
      p = q; rr *= 0.9;
    }
  });
  const th = [at(-0.008, -0.028, 0.03), at(-0.02, -0.057, 0.049), at(-0.027, -0.081, 0.052), at(-0.03, -0.099, 0.048)];
  for (let i = 0; i < 3; i++) add(S.roundCone(th[i], th[i + 1], 0.0125 - i * 0.0012, 0.0112 - i * 0.0012), 0.008, 'glove', 'hand' + k);
  // gauntlet cuff over the sleeve end
  add(clip(S.roundCone(at(0, -0.018, 0), at(0.002, 0.062, -0.002), 0.036, 0.047), at(0, 0.066, 0), [0, 1, 0]), 0.016, (x, y) => (y > W[1] + 0.05 ? 'gloveCuff' : 'glove'), null, { bones: [['hand' + k, 0.35], ['elbow' + k, 0.65]] });
  add(S.torus(at(0.002, 0.058, -0.002), 0.046, 0.046, 0.0045), 0.004, 'gloveCuff', null, { bones: [['hand' + k, 0.3], ['elbow' + k, 0.7]] });
  add(S.torus(at(0, 0.004, 0), 0.037, 0.037, 0.0028), 0.003, 'gloveCuff', null, { bones: [['hand' + k, 0.7], ['elbow' + k, 0.3]] });
  return { parts: P };
}

// ==================================================================================================
// HAIR — the sculpt is only the scalp layer under the strand cards (built at runtime in thorfinn.js)
// ==================================================================================================
export const HAIR_CAP = { c: hp(0, 0.011, -0.008), r: [0.0835, 0.0955, 0.1065] };
// the hairline: off the forehead, stops at the nape, clear of the ears
export const HAIRLINE = {
  planes: [[hp(0, 0.03, 0.074), [0, -0.52, 0.85]], [hp(0, -0.075, -0.06), [0, -1, -0.25]]],
  ears: [1, -1].map((s) => [hp(0.082 * s, -0.04, -0.008), [0.026, 0.03, 0.027]]),
};
function hairParts() {
  const P = [{ d: S.ellipsoid(HAIR_CAP.c, HAIR_CAP.r), k: 0, region: 'hair' }];
  for (const [p, n] of HAIRLINE.planes) P.push({ d: S.halfSpace(p, n), k: 0.012, cut: true });
  for (const [c, r] of HAIRLINE.ears) P.push({ d: S.ellipsoid(c, r), k: 0.012, sub: true, region: 'hair' });
  return { parts: P };
}

// ==================================================================================================
// FUR COLLAR of the cloak, the ring brooch, the belt buckle, the strap end, the seax
// ==================================================================================================
function collarParts(smooth = false) {
  // a smooth base; shell layers grow the fur on it at runtime (a little lumpiness reads as clumps)
  const P = [];
  const fur = (d) => (smooth ? d : furry(d, 0.004, 38));
  P.push({ d: fur(S.torus([0, 1.528, -0.02], 0.104, 0.094, 0.03)), k: 0, region: 'fur' });
  P.push({ d: fur(S.ellipsoid([0, 1.565, -0.075], [0.08, 0.032, 0.045])), k: 0.03, region: 'fur' });
  for (const s of [1, -1]) P.push({ d: fur(S.ellipsoid([0.135 * s, 1.515, -0.022], [0.075, 0.03, 0.085])), k: 0.035, region: 'fur' });
  P.push({ d: fur(S.ellipsoid([0, 1.515, -0.1], [0.12, 0.04, 0.045])), k: 0.035, region: 'fur' });
  // the band across the upper chest, from the brooch to the left shoulder
  const band = [[-0.105, 1.45, 0.098], [-0.02, 1.458, 0.118], [0.07, 1.466, 0.114], [0.15, 1.487, 0.076], [0.2, 1.51, 0.018]];
  for (let i = 0; i < band.length - 1; i++) P.push({ d: fur(S.roundCone(band[i], band[i + 1], 0.024, 0.024)), k: 0.025, region: 'fur' });
  return { parts: P };
}

export const BROOCH = [-0.108, 1.455, 0.135];
function broochParts() {
  const c = BROOCH;
  return { parts: [
    { d: ringXY(c, 0.022, 0.0055), k: 0, region: 'bronze' },
    { d: S.capsule([c[0] - 0.03, c[1] - 0.012, c[2] - 0.004], [c[0] + 0.028, c[1] + 0.014, c[2] - 0.002], 0.0026), k: 0.002, region: 'bronze' },
    { d: S.sphere([c[0] - 0.031, c[1] - 0.0125, c[2] - 0.004], 0.0042), k: 0.002, region: 'bronze' },
  ] };
}

export const BUCKLE = [-0.036, 1.033];
function buckleParts(torso) {
  // sits on the belt's outer surface
  const bz = surfaceZ(torso, BUCKLE[0], BUCKLE[1]) + 0.011;
  const c = [BUCKLE[0], BUCKLE[1], bz];
  const parts = [
    { d: S.roundBox(c, [0.024, 0.024, 0.0042], 0.0028), k: 0, region: 'iron' },
    { d: S.roundBox([c[0], c[1], c[2] + 0.004], [0.0155, 0.0155, 0.0075], 0.002), k: 0.0012, region: 'belt', sub: true },
    { d: S.capsule([c[0] - 0.016, c[1], c[2] + 0.001], [c[0] + 0.008, c[1], c[2] + 0.0032], 0.0022), k: 0.001, region: 'iron' }, // prong
    { d: S.roundBox([c[0] + 0.043, c[1], c[2] - 0.004], [0.02, 0.019, 0.0028], 0.0018), k: 0.002, region: 'belt' }, // tongue end
  ];
  // bronze fittings riveted along the sword belt
  const fittings = [];
  for (const x of [-0.12, 0.04, 0.1]) {
    const y = 0.935 - 0.26 * x;
    const z = surfaceZ(torso, x, y) + 0.012;
    fittings.push({ d: S.roundBox([x, y, z], [0.009, 0.014, 0.0028], 0.002), k: 0, region: 'bronze' });
  }
  return { parts, c, fittings };
}

export const STRAP = [-0.09, 1.02, 0.112];
function strapParts() {
  const c = STRAP;
  return { parts: [
    { d: S.roundBox([c[0], c[1] - 0.11, c[2]], [0.013, 0.11, 0.0026], 0.002), k: 0, region: 'belt' },
    { d: S.roundBox([c[0], c[1] - 0.225, c[2]], [0.0145, 0.014, 0.0038], 0.002), k: 0.002, region: 'bronze' },
    { d: S.sphere([c[0], c[1] - 0.012, c[2] + 0.003], 0.0035), k: 0.001, region: 'bronze' },
  ] };
}

// The seax is sculpted in its own frame: blade down −y, flat faces toward ±x, edge toward +z.
export const SEAX = { pivot: [0.168, 0.912, 0.088], down: [-0.12, -0.95, 0.29], out: [1, 0, 0.18] };
function seaxParts() {
  const P = [];
  const add = (d, k, region) => P.push({ d, k, region });
  add(S.roundBox([0, -0.2, 0.0], [0.009, 0.2, 0.024], 0.007), 0, 'sheath');
  add(S.roundCone([0, -0.39, 0.006], [0, -0.47, 0.014], 0.021, 0.006), 0.02, 'sheath');
  add(S.roundBox([0, -0.012, 0], [0.0115, 0.013, 0.027], 0.003), 0.002, 'bronze'); // throat
  add(S.roundBox([0, -0.2, 0], [0.011, 0.007, 0.0255], 0.0025), 0.002, 'bronze'); // band
  add(S.roundCone([0, -0.44, 0.012], [0, -0.472, 0.0145], 0.0105, 0.006), 0.003, 'bronze'); // chape
  for (let i = 0; i < 7; i++) add(S.sphere([0.009, -0.04 - i * 0.052, -0.02], 0.0026), 0.001, 'bronze'); // rivets
  add(S.roundBox([0, 0.008, 0], [0.012, 0.0055, 0.024], 0.002), 0.002, 'iron'); // guard
  add(S.roundCone([0, 0.012, -0.002], [0, 0.105, -0.005], 0.0135, 0.0125), 0.004, 'grip');
  for (let i = 0; i < 5; i++) add(S.torus([0, 0.025 + i * 0.018, -0.003], 0.0138, 0.0138, 0.0018), 0.002, 'grip');
  add(S.ellipsoid([0, 0.114, -0.005], [0.013, 0.011, 0.02]), 0.004, 'iron'); // pommel
  // loops that hang it from the sword belt
  add(S.roundBox([0, 0.012, 0.03], [0.004, 0.028, 0.006], 0.002), 0.003, 'belt2');
  add(S.roundBox([0, -0.05, -0.028], [0.004, 0.03, 0.006], 0.002), 0.003, 'belt2');
  return { parts: P };
}
// orthonormal frame for the seax (columns: x = out, y = up (−down), z = edge)
export function seaxBasis() {
  const n = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
  const up = n(SEAX.down.map((c) => -c));
  let x = n(SEAX.out);
  const d = x[0] * up[0] + x[1] * up[1] + x[2] * up[2];
  x = n([x[0] - up[0] * d, x[1] - up[1] * d, x[2] - up[2] * d]);
  const z = [x[1] * up[2] - x[2] * up[1], x[2] * up[0] - x[0] * up[2], x[0] * up[1] - x[1] * up[0]];
  return { x, y: up, z };
}

// ==================================================================================================
// Cloth: the cloak (pinned around the shoulders, open at the front) and the tunic skirt
// ==================================================================================================
export function capePins(n = 24) {
  // left shoulder front → over the left shoulder → around the back of the neck → right shoulder front
  const path = [[0.175, 1.47, 0.075], [0.215, 1.515, 0.0], [0.19, 1.545, -0.08], [0.1, 1.568, -0.128], [0, 1.575, -0.138],
    [-0.1, 1.568, -0.128], [-0.19, 1.545, -0.08], [-0.215, 1.515, 0.0], [-0.165, 1.47, 0.08]];
  const seg = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) { const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]); seg.push(l); total += l; }
  const out = [];
  for (let k = 0; k < n; k++) {
    let d = (k / (n - 1)) * total, i = 0;
    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
    out.push(lerp3(path[i], path[i + 1], Math.min(1, d / seg[i])));
  }
  return out;
}

// ==================================================================================================
// build
// ==================================================================================================
function regionsOf(parts, f, pos) {
  const out = new Array(pos.length / 3);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    f.full(x, y, z);
    let bi = -1, best = Infinity;
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].cut || !parts[p].region) continue;
      const v = Math.abs(f.vals[p]);
      if (v < best) { best = v; bi = p; }
    }
    const reg = parts[bi].region;
    out[i / 3] = { region: typeof reg === 'function' ? reg(x, y, z) : reg, part: bi };
  }
  return out;
}

function makePiece(name, parts, box, h, opt = {}) {
  const f = S.evaluator(parts);
  const m = S.meshSDF(f, box[0], box[1], h, 3);
  const nv = m.positions.length / 3;
  let regions, skin = null;
  if (opt.skinned) {
    skin = S.skinAndPaint(parts, f, m.positions, BONE_INDEX, opt.sigma);
    regions = skin.regions.map((r) => ({ region: r, part: -1 }));
  } else regions = regionsOf(parts, f, m.positions);
  const color = new Float32Array(nv * 3), mat0 = new Float32Array(nv * 4), mat1 = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const L = LOOK_LIN[regions[i].region] || LOOK_LIN.skin;
    color.set(L.c, i * 3); mat0.set(L.a, i * 4); mat1.set(L.b, i * 4);
  }
  const bb = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  for (let i = 0; i < m.positions.length; i += 3) for (let a = 0; a < 3; a++) { bb[0][a] = Math.min(bb[0][a], m.positions[i + a]); bb[1][a] = Math.max(bb[1][a], m.positions[i + a]); }
  return { name, parts, f, positions: m.positions, normals: m.normals, indices: m.indices, regions, color, mat0, mat1, skinIndex: skin?.skinIndex, skinWeight: skin?.skinWeight, bbox: bb, ...opt };
}

// ambient occlusion from the whole figure's distance field
function bakeAO(pieces, fields) {
  const pad = 0.075;
  const fAll = (x, y, z) => {
    let d = 1;
    for (const fl of fields) {
      const b = fl.bbox;
      if (x < b[0][0] - pad || y < b[0][1] - pad || z < b[0][2] - pad || x > b[1][0] + pad || y > b[1][1] + pad || z > b[1][2] + pad) continue;
      const v = fl.f(x, y, z);
      if (v < d) d = v;
    }
    return d;
  };
  const steps = [0.01, 0.022, 0.038, 0.06];
  for (const pc of pieces) {
    const P = pc.worldPositions || pc.positions, N = pc.worldNormals || pc.normals;
    const nv = P.length / 3;
    const ao = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      let occ = 0, w = 1;
      for (const hh of steps) {
        const d = fAll(x + nx * hh, y + ny * hh, z + nz * hh);
        occ += Math.max(0, hh - d) * w;
        w *= 0.72;
      }
      ao[i] = Math.max(0.15, Math.min(1, 1 - occ * 12));
    }
    pc.ao = ao;
  }
}

export function sculptThorfinn() {
  const t0 = Date.now();
  const timings = {};
  const tick = (k) => { timings[k] = Date.now() - (tick.t || t0); tick.t = Date.now(); };

  const { parts: bodyP, torso } = bodyParts();
  const body = makePiece('body', bodyP, [[-0.31, -0.01, -0.21], [0.31, 1.62, 0.22]], 0.0088, { skinned: true, sigma: 0.022 });
  tick('body');
  const head = makePiece('head', headParts().parts, [[-0.1, 1.5, -0.13], [0.1, 1.86, 0.125]], 0.0037, { skinned: true, sigma: 0.012 });
  tick('head');
  const hands = [1, -1].map((s) => {
    const W = J[s > 0 ? 'handL' : 'handR'];
    return makePiece(s > 0 ? 'handL' : 'handR', handParts(s).parts, [[W[0] - 0.075, W[1] - 0.2, W[2] - 0.075], [W[0] + 0.075, W[1] + 0.08, W[2] + 0.085]], 0.0039, { skinned: true, sigma: 0.015 });
  });
  tick('hands');

  const hair = makePiece('hair', hairParts().parts, [[-0.1, 1.66, -0.13], [0.1, 1.88, 0.115]], 0.0048, { bone: 'head' });
  // strand direction for the scalp: flows out from the crown
  {
    const nv = hair.positions.length / 3;
    const tan = new Float32Array(nv * 4);
    const whorl = hp(0.01, 0.07, -0.05);
    for (let i = 0; i < nv; i++) {
      const x = hair.positions[i * 3], y = hair.positions[i * 3 + 1], z = hair.positions[i * 3 + 2];
      const nx = hair.normals[i * 3], ny = hair.normals[i * 3 + 1], nz = hair.normals[i * 3 + 2];
      const d = [x - whorl[0], y - whorl[1] - 0.02, z - whorl[2]];
      const dn = d[0] * nx + d[1] * ny + d[2] * nz;
      const tx = d[0] - nx * dn, ty = d[1] - ny * dn, tz = d[2] - nz * dn;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tan.set([tx / tl, ty / tl, tz / tl, 1], i * 4);
    }
    hair.tangent = tan;
  }
  tick('hair');

  const collar = makePiece('collar', collarParts().parts, [[-0.25, 1.41, -0.19], [0.25, 1.62, 0.17]], 0.0075, { bone: 'chest' });
  const collarAO = { f: S.evaluator(collarParts(true).parts), bbox: collar.bbox }; // tufts shade through the shader, not the bake
  // fur tips lighter, the undercoat grey
  for (let i = 0; i < collar.color.length / 3; i++) {
    const x = collar.positions[i * 3], y = collar.positions[i * 3 + 1], z = collar.positions[i * 3 + 2];
    const v = 0.85 + 0.25 * vnoise(x * 60, y * 60, z * 60);
    for (let a = 0; a < 3; a++) collar.color[i * 3 + a] *= v;
  }
  const brooch = makePiece('brooch', broochParts().parts, [[BROOCH[0] - 0.04, BROOCH[1] - 0.035, BROOCH[2] - 0.015], [BROOCH[0] + 0.04, BROOCH[1] + 0.035, BROOCH[2] + 0.015]], 0.0016, { bone: 'chest' });
  const bk = buckleParts(torso);
  const buckle = makePiece('buckle', bk.parts, [[bk.c[0] - 0.035, bk.c[1] - 0.03, bk.c[2] - 0.014], [bk.c[0] + 0.07, bk.c[1] + 0.03, bk.c[2] + 0.014]], 0.0017, { bone: 'spine' });
  const fittings = makePiece('fittings', bk.fittings, [[-0.145, 0.88, 0.02], [0.125, 0.99, 0.2]], 0.002, { bone: 'hips' });
  const strap = makePiece('strap', strapParts().parts, [[STRAP[0] - 0.025, STRAP[1] - 0.25, STRAP[2] - 0.012], [STRAP[0] + 0.025, STRAP[1] + 0.012, STRAP[2] + 0.012]], 0.0028, { bone: 'hips' });
  const seax = makePiece('seax', seaxParts().parts, [[-0.02, -0.49, -0.038], [0.02, 0.135, 0.036]], 0.0037, { bone: 'hips', local: true });
  tick('small');

  // ---- ambient occlusion (bind pose, everything together) ----
  const B = seaxBasis();
  const toSeax = (x, y, z) => {
    const px = x - SEAX.pivot[0], py = y - SEAX.pivot[1], pz = z - SEAX.pivot[2];
    return [px * B.x[0] + py * B.x[1] + pz * B.x[2], px * B.y[0] + py * B.y[1] + pz * B.y[2], px * B.z[0] + py * B.z[1] + pz * B.z[2]];
  };
  const seaxWorld = { f: (x, y, z) => { const q = toSeax(x, y, z); return seax.f(q[0], q[1], q[2]); }, bbox: [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]] };
  {
    const nv = seax.positions.length / 3;
    seax.worldPositions = new Float32Array(nv * 3); seax.worldNormals = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const p = seax.positions.subarray(i * 3, i * 3 + 3), n = seax.normals.subarray(i * 3, i * 3 + 3);
      for (let a = 0; a < 3; a++) {
        seax.worldPositions[i * 3 + a] = SEAX.pivot[a] + B.x[a] * p[0] + B.y[a] * p[1] + B.z[a] * p[2];
        seax.worldNormals[i * 3 + a] = B.x[a] * n[0] + B.y[a] * n[1] + B.z[a] * n[2];
        seaxWorld.bbox[0][a] = Math.min(seaxWorld.bbox[0][a], seax.worldPositions[i * 3 + a]);
        seaxWorld.bbox[1][a] = Math.max(seaxWorld.bbox[1][a], seax.worldPositions[i * 3 + a]);
      }
    }
  }
  const pieces = [body, head, ...hands, hair, collar, brooch, buckle, fittings, strap, seax];
  bakeAO(pieces, [body, head, ...hands, hair, collarAO, seaxWorld]); // the small metalwork hardly shades anything
  tick('ao');

  // skin tone: warmer nose, cheeks and ears, a shade deeper in the eye sockets
  {
    const warm = [[hp(0, -0.068, 0.11), 0.018, 0.08], [hp(0.045, -0.07, 0.07), 0.028, 0.045], [hp(-0.045, -0.07, 0.07), 0.028, 0.045], [hp(0.08, -0.04, -0.01), 0.03, 0.09], [hp(-0.08, -0.04, -0.01), 0.03, 0.09]];
    const red = lin('#c98a74');
    for (let i = 0; i < head.color.length / 3; i++) {
      if (head.regions[i].region !== 'skin') continue;
      const x = head.positions[i * 3], y = head.positions[i * 3 + 1], z = head.positions[i * 3 + 2];
      let w = 0;
      for (const [c, r, k] of warm) w += k * Math.exp(-((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / (r * r));
      w = Math.min(0.14, w);
      for (let a = 0; a < 3; a++) head.color[i * 3 + a] += (red[a] - head.color[i * 3 + a]) * w;
    }
  }

  // body positions for the buttons down the tunic front
  const buttons = [1.43, 1.35, 1.27, 1.19, 1.11].map((y) => [0, y, surfaceZ(S.evaluator(bodyP), 0, y) + 0.001]);

  const out = pieces.map((p) => ({
    name: p.name, skinned: !!p.skinned, bone: p.bone || null, local: !!p.local,
    positions: p.positions, normals: p.normals, indices: p.indices, color: p.color, mat0: p.mat0, mat1: p.mat1, ao: p.ao,
    skinIndex: p.skinIndex || null, skinWeight: p.skinWeight || null, tangent: p.tangent || null,
  }));
  timings.total = Date.now() - t0;
  return { pieces: out, buttons, timings };
}

export function transferList(data) {
  const list = [];
  for (const p of data.pieces) for (const k of ['positions', 'normals', 'indices', 'color', 'mat0', 'mat1', 'ao', 'skinIndex', 'skinWeight', 'tangent']) if (p[k]) list.push(p[k].buffer);
  return list;
}
