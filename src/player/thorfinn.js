import * as THREE from 'three';
import { J, BONE_ORDER, EYE, HC, HAIR_CAP, HAIRLINE, eyeCentre, capePins, SEAX, seaxBasis, STRAP, lin, sculptThorfinn } from './thorfinnSculpt.js';
import { realMaterial, useSkyProbe, realAttributes } from '../render/realMaterial.js';

// Thorfinn — the realistic traveller. The sculpt (thorfinnSculpt.js) runs in a worker; here it becomes a
// skinned figure with physically based materials, modelled eyes with moving lids, a simulated wool cloak
// and tunic skirt edged in fur, and a seax and strap end that swing from the belt.

const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  thighL: 'hips', kneeL: 'thighL', footL: 'kneeL', thighR: 'hips', kneeR: 'thighR', footR: 'kneeR',
};

let pending = null;
function sculpt() {
  if (!pending) {
    pending = new Promise((resolve) => {
      let w;
      try { w = new Worker(new URL('./thorfinnWorker.js', import.meta.url), { type: 'module' }); } catch { resolve(sculptThorfinn()); return; }
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.onerror = (e) => { console.warn('sculpt worker failed, sculpting here', e.message); w.terminate(); resolve(sculptThorfinn()); };
    });
  }
  return pending;
}
// Start sculpting early (while the valley loads) so choosing him is instant.
export const prewarmThorfinn = () => { sculpt(); };

// ---- eyes -----------------------------------------------------------------------------------------
function irisTexture() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fib = Array.from({ length: W }, () => rnd());
  const fib2 = Array.from({ length: W }, () => rnd());
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < H; y++) {
    const th = (y / H) * Math.PI; // 0 = front of the eye
    for (let x = 0; x < W; x++) {
      let r, gg, b;
      const f = 0.55 * fib[x] + 0.3 * fib[(x + 7) % W] + 0.15 * fib2[(x * 3) % W];
      if (th < 0.2) { r = 12; gg = 9; b = 8; }
      else if (th < 0.53) {
        const t = (th - 0.2) / 0.33;
        // warm amber around the pupil, brown-red toward the rim, radial fibres, a dark limbal ring
        const inner = [178, 104, 44], outer = [104, 46, 22];
        const k = sm(0.1, 0.75, t);
        r = inner[0] + (outer[0] - inner[0]) * k; gg = inner[1] + (outer[1] - inner[1]) * k; b = inner[2] + (outer[2] - inner[2]) * k;
        const streak = 0.72 + 0.55 * f;
        r *= streak; gg *= streak; b *= streak;
        const collar = Math.exp(-((t - 0.3) ** 2) / 0.004) * 0.35;
        r += 70 * collar; gg += 45 * collar; b += 20 * collar;
        const limb = sm(0.8, 1.0, t);
        r *= 1 - 0.75 * limb; gg *= 1 - 0.78 * limb; b *= 1 - 0.8 * limb;
        const pup = sm(0.08, 0.0, t);
        r = r * (1 - pup) + 20 * pup; gg = gg * (1 - pup) + 12 * pup; b = b * (1 - pup) + 10 * pup;
      } else {
        // sclera: off-white, pinker and darker toward the corners and the back
        const t = sm(0.53, 1.9, th);
        r = 236 - 25 * t; gg = 226 - 45 * t; b = 214 - 45 * t;
        const vein = Math.max(0, fib2[x] - 0.93) * 14 * sm(0.9, 1.5, th);
        gg -= 60 * vein; b -= 60 * vein;
        const edge = sm(0.53, 0.6, th);
        r = r * edge + 60 * (1 - edge); gg = gg * edge + 30 * (1 - edge); b = b * edge + 18 * (1 - edge);
      }
      const o = (y * W + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const occlusionMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `varying vec3 vP;
    void main(){
      vec3 d = normalize(vP);
      float top = smoothstep(-0.08, 0.4, d.y);          // the upper lid shades the eye
      float corners = smoothstep(0.45, 0.85, abs(d.x));  // and the corners sit in shadow
      gl_FragColor = vec4(0.05, 0.02, 0.015, clamp(top * 0.5 + corners * 0.45, 0.0, 0.72));
    }`,
});

function buildEyes(head, bodyMat) {
  const eyeMat = useSkyProbe(new THREE.MeshPhysicalMaterial({ map: irisTexture(), roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.035 }));
  const skinCol = '#dcab8c';
  const eyes = [];
  const R = EYE.r;
  const lidR = R + 0.0009, lidEdge = 0.32; // cap reaches 0.32 rad below the equator
  for (const s of [1, -1]) {
    const c = eyeCentre(s);
    const eye = new THREE.Group();
    eye.position.set(c[0] - J.head[0], c[1] - J.head[1], c[2] - J.head[2]);
    eye.rotation.y = 0.035 * s;
    head.add(eye);
    const gaze = new THREE.Group();
    eye.add(gaze);
    gaze.add(new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28).rotateX(Math.PI / 2), eyeMat));
    const occ = new THREE.Mesh(new THREE.SphereGeometry(R + 0.00035, 32, 20).rotateX(Math.PI / 2), occlusionMat);
    occ.renderOrder = 2;
    eye.add(occ);
    const lid = new THREE.Group();
    eye.add(lid);
    const lidGeo = new THREE.SphereGeometry(lidR, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2 + lidEdge);
    realAttributes(lidGeo, [1, 0, 0, 0], [0, 0, 0, 0], 0.7);
    const col = lin(skinCol), n = lidGeo.attributes.position.count, ca = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ca.set(col, i * 3);
    lidGeo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    lid.add(new THREE.Mesh(lidGeo, bodyMat));
    // lash line along the lid's edge
    const arc = 2.5;
    const lashGeo = new THREE.TorusGeometry(lidR * Math.cos(lidEdge) + 0.0002, 0.00075, 4, 28, arc).rotateZ((Math.PI - arc) / 2).rotateX(Math.PI / 2).translate(0, -lidR * Math.sin(lidEdge), 0);
    lid.add(new THREE.Mesh(lashGeo, new THREE.MeshBasicMaterial({ color: '#2a1810' })));
    const open = -0.66, closed = 0.1;
    lid.rotation.x = open;
    eyes.push({ eye, gaze, lid, open, closed });
  }
  return eyes;
}

// ---- hair: strand cards over the sculpted scalp ---------------------------------------------------------
function strandTexture() {
  const W = 512, H = 512, COLS = 4;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.lineCap = 'round';
  for (let c = 0; c < COLS; c++) {
    const x0 = (c * W) / COLS, cw = W / COLS;
    const root = g.createLinearGradient(0, 0, 0, H * 0.3);
    root.addColorStop(0, 'rgba(255,255,255,0.9)'); root.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = root; g.fillRect(x0 + 6, 0, cw - 12, H * 0.3);
    for (let i = 0; i < 110; i++) {
      const x = x0 + 5 + rnd() * (cw - 10), len = H * (0.45 + 0.55 * rnd()), wave = (rnd() - 0.5) * 12;
      g.strokeStyle = `rgba(255,255,255,${0.5 + 0.5 * rnd()})`;
      g.lineWidth = 0.8 + rnd() * 1.8;
      g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + wave, len * 0.55, x + wave * 0.4 + (rnd() - 0.5) * 8, len); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

function buildHairCards(holder, mat) {
  const { c, r } = HAIR_CAP;
  const cap = (p) => ((p[0] - c[0]) / r[0]) ** 2 + ((p[1] - c[1]) / r[1]) ** 2 + ((p[2] - c[2]) / r[2]) ** 2;
  const capN = (p) => { const n = [(p[0] - c[0]) / r[0] ** 2, (p[1] - c[1]) / r[1] ** 2, (p[2] - c[2]) / r[2] ** 2]; const l = Math.hypot(...n); return n.map((v) => v / l); };
  const inside = (p) => {
    for (const [pp, n] of HAIRLINE.planes) if ((p[0] - pp[0]) * n[0] + (p[1] - pp[1]) * n[1] + (p[2] - pp[2]) * n[2] > -0.003) return false;
    for (const [ec, er] of HAIRLINE.ears) if (((p[0] - ec[0]) / er[0]) ** 2 + ((p[1] - ec[1]) / er[1]) ** 2 + ((p[2] - ec[2]) / er[2]) ** 2 < 1.4) return false;
    return true;
  };
  let seed = 1109;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const roots = [];
  const N = 1300;
  for (let i = 0; i < N; i++) {
    const y = 1 - ((i + 0.5) / N) * 2, rr = Math.sqrt(1 - y * y), ph = i * 2.39996;
    const d = [Math.cos(ph) * rr, y, Math.sin(ph) * rr];
    const p = [c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]];
    if (inside(p)) roots.push({ p, d });
  }
  const SEG = 6, pos = [], nor = [], uv = [], tan = [], col = [], ao = [], idx = [];
  const cRoot = lin('#7d4520'), cMid = lin('#c27634'), cTip = lin('#dea45a');
  for (const { p, d } of roots) {
    if (rnd() < 0.2) continue;
    const n = capN(p);
    const side = d[0], up = d[1], fwd = d[2];
    // lift = how far a lock stands off the head (messy volume), the rest of it follows the skull
    let dir, L = 0.05 + rnd() * 0.04, lift = 0.12;
    const J = () => [(rnd() - 0.5), (rnd() - 0.5), (rnd() - 0.5)];
    if (fwd > 0.5 && up < 0.75 && rnd() < 0.3) { dir = add([side * 0.6, -0.7, 0.3], J(), 0.45); L *= 0.55; lift = 0.06; } // a few locks over the forehead
    else if (up > 0.45) { dir = add([side * 0.45, 0.12, -0.88], J(), 0.6); L *= 1.2; lift = 0.14 + 0.3 * rnd(); } // crown: swept back, messy volume
    else if (fwd < -0.25) { dir = add([side * 0.3, -0.9, -0.3], J(), 0.3); lift = 0.05; } // back, to the nape
    else { dir = add([Math.sign(side) * 0.2, -0.5, -0.8], J(), 0.4); lift = 0.07; } // sides, back over the ears
    dir = norm(dir);
    const w0 = 0.012 + rnd() * 0.01;
    const colIdx = Math.floor(rnd() * 4);
    const shade = 0.88 + rnd() * 0.24;
    const base = pos.length / 3;
    let q = add(p, n, -0.001), dcur = dir;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      if (i > 0) {
        // follow the skull (drop most of the outward part), keep a little lift, sag at the ends
        const nq = capN(q);
        const dn = dcur[0] * nq[0] + dcur[1] * nq[1] + dcur[2] * nq[2];
        dcur = norm(add(add(add(dcur, nq, -dn * 0.85), nq, lift * (1 - t)), [0, -1, 0], 0.1 * t));
        q = add(q, dcur, L / SEG);
        const k = cap(q);
        if (k < 1.03) q = add(q, capN(q), (1.03 - k) * 0.045); // stay on top of the scalp
      }
      const nn = capN(q);
      const sv = norm(cross(dcur, nn));
      const w = w0 * (1 - 0.55 * t) * 0.5;
      for (const sgn of [-1, 1]) {
        const v = add(q, sv, w * sgn);
        pos.push(v[0] - HC[0], v[1] - HC[1], v[2] - HC[2]);
        nor.push(...norm(add(nn, cross(sv, dcur), 0.35)));
        uv.push((colIdx + (sgn < 0 ? 0.04 : 0.96)) / 4, 1 - t);
        tan.push(dcur[0], dcur[1], dcur[2], 1);
        const cc = t < 0.5 ? cRoot.map((x, j) => x + (cMid[j] - x) * (t / 0.5)) : cMid.map((x, j) => x + (cTip[j] - x) * ((t - 0.5) / 0.5));
        col.push(cc[0] * shade, cc[1] * shade, cc[2] * shade);
        ao.push(0.4 + 0.6 * Math.min(1, t * 1.6));
      }
      if (i < SEG) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('tangent', new THREE.Float32BufferAttribute(tan, 4));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  realAttributes(g, [0, 0, 0, 0], [0, 1, 0, 0], 1);
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  holder.add(m);
  return g.index.count / 3;
}

// Shell fur: layers of the same surface pushed outward, each showing fewer, thinner strands.
function furShells(layers, len, density) {
  const mats = [];
  for (let i = 1; i <= layers; i++) mats.push(realMaterial({ key: 'fur', shell: { t: i / layers, len, density } }));
  return mats;
}
function addShells(mesh, mats) {
  for (const m of mats) {
    const s = new THREE.Mesh(mesh.geometry, m);
    s.receiveShadow = true;
    s.userData.furShell = true;
    mesh.add(s);
  }
}

// ---- assembly ------------------------------------------------------------------------------------
function geometryOf(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(p.color, 3));
  g.setAttribute('aMat0', new THREE.BufferAttribute(p.mat0, 4));
  g.setAttribute('aMat1', new THREE.BufferAttribute(p.mat1, 4));
  g.setAttribute('aAO', new THREE.BufferAttribute(p.ao, 1));
  g.setAttribute('aRest', new THREE.BufferAttribute(p.positions.slice(), 3));
  if (p.tangent) g.setAttribute('tangent', new THREE.BufferAttribute(p.tangent, 4));
  if (p.skinIndex) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(p.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(p.skinWeight, 4));
  }
  g.setIndex(new THREE.BufferAttribute(p.indices, 1));
  return g;
}

export async function buildThorfinn() {
  const data = await sculpt();
  const bones = {}, list = [];
  for (const name of BONE_ORDER) {
    const b = new THREE.Bone();
    b.name = name;
    const p = PARENT[name];
    const jp = J[name], pp = p ? J[p] : [0, 0, 0];
    b.position.set(jp[0] - pp[0], jp[1] - pp[1], jp[2] - pp[2]);
    if (p) bones[p].add(b);
    bones[name] = b;
    list.push(b);
  }
  const root = new THREE.Group(), lean = new THREE.Group(), squash = new THREE.Group();
  root.add(lean); lean.add(squash); squash.add(bones.hips);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);

  const bodyMat = realMaterial({ key: 'body' });
  const hairMat = realMaterial({ key: 'hair', params: { anisotropy: 0.75, anisotropyRotation: Math.PI / 2 } });
  const cardMat = realMaterial({ key: 'hairCards', side: THREE.DoubleSide, noBackTint: true, params: { alphaMap: strandTexture(), alphaTest: 0.38, alphaToCoverage: true, anisotropy: 0.5, anisotropyRotation: Math.PI / 2, specularIntensity: 0.55 } });
  const collarShells = furShells(5, 0.02, 430);
  const trimShells = furShells(4, 0.018, 430);
  let bindMatrix = null, body = null, tris = 0;
  const rigid = {};
  for (const p of data.pieces) {
    const g = geometryOf(p);
    tris += p.indices.length / 3;
    const mat = p.name === 'hair' ? hairMat : bodyMat;
    let mesh;
    if (p.skinned) {
      mesh = new THREE.SkinnedMesh(g, mat);
      mesh.frustumCulled = false;
      root.add(mesh);
      if (!bindMatrix) { mesh.bind(skeleton); bindMatrix = mesh.bindMatrix; body = mesh; } else mesh.bind(skeleton, bindMatrix);
    } else if (p.local) {
      // the seax hangs from a pivot on the sword belt, turned by its own frame
      const B = seaxBasis();
      const pivot = new THREE.Group();
      pivot.position.set(SEAX.pivot[0] - J.hips[0], SEAX.pivot[1] - J.hips[1], SEAX.pivot[2] - J.hips[2]);
      pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...B.x), new THREE.Vector3(...B.y), new THREE.Vector3(...B.z)));
      bones.hips.add(pivot);
      mesh = new THREE.Mesh(g, mat);
      pivot.add(mesh);
      rigid[p.name] = pivot;
    } else {
      // pivot: the strap swings from the belt, the hair settles about the skull
      const o = p.name === 'strap' ? STRAP : p.name === 'hair' ? HC : J[p.bone];
      g.translate(-o[0], -o[1], -o[2]);
      const holder = new THREE.Group();
      const jb = J[p.bone];
      holder.position.set(o[0] - jb[0], o[1] - jb[1], o[2] - jb[2]);
      bones[p.bone].add(holder);
      mesh = new THREE.Mesh(g, mat);
      holder.add(mesh);
      rigid[p.name] = holder;
    }
    // small metalwork and the hands don't need to cast shadows
    mesh.castShadow = !['buckle', 'fittings', 'brooch', 'strap', 'handL', 'handR'].includes(p.name);
    mesh.receiveShadow = true;
    if (p.name === 'collar') addShells(mesh, collarShells);
  }
  tris += buildHairCards(rigid.hair, cardMat);

  // buttons down the tunic front
  const btnGeo = realAttributes(new THREE.SphereGeometry(0.0052, 12, 8).scale(1, 1, 0.6), [0, 0, 1, 0], [0, 0, 0, 0], 0.8);
  const bc = lin('#2e241d'), bn = btnGeo.attributes.position.count, bcol = new Float32Array(bn * 3);
  for (let i = 0; i < bn; i++) bcol.set(bc, i * 3);
  btnGeo.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
  for (const b of data.buttons) {
    const bone = b[1] > 1.2 ? 'chest' : 'spine';
    const m = new THREE.Mesh(btnGeo, bodyMat);
    m.position.set(b[0] - J[bone][0], b[1] - J[bone][1], b[2] - J[bone][2]);
    bones[bone].add(m);
  }

  const rig = {
    root, lean, squash, bones, body, skeleton, J,
    hips: bones.hips, spine: bones.spine, chest: bones.chest, neck: bones.neck, head: bones.head,
    shoulders: [bones.shoulderL, bones.shoulderR], elbows: [bones.elbowL, bones.elbowR], hands: [bones.handL, bones.handR],
    thighs: [bones.thighL, bones.thighR], knees: [bones.kneeL, bones.kneeR], feet: [bones.footL, bones.footR],
    jiggles: [], face: { eyes: [], brows: [], mouth: null }, kind: 'human', realistic: true, tris,
    P: {
      hipsY: J.hips[1],
      thighLen: Math.hypot(J.thighL[0] - J.kneeL[0], J.thighL[1] - J.kneeL[1], J.thighL[2] - J.kneeL[2]),
      shinLen: Math.hypot(J.kneeL[0] - J.footL[0], J.kneeL[1] - J.footL[1], J.kneeL[2] - J.footL[2]),
      footRest: J.footL[1], stride: 0.44, sway: 0.02, armAmp: 0.9, legLen: J.thighL[1] - J.footL[1],
      camHeight: 1.56, swimDepth: 0.86, sitHips: 0.14,
      // a grown man: barely any cartoon squash
      sqK: 420, sqC: 34, land: 0.035, jump: 0.2,
    },
  };
  rig.jig = (obj, axis, len, k, c, max, opts = {}) => rig.jiggles.push({ obj, axis: new THREE.Vector3(...axis).normalize(), len, k, c, max, g: opts.g || 0, air: opts.air || 0, dynamic: !!opts.dynamic });
  rig.face.eyes = buildEyes(bones.head, bodyMat);

  // fur shells only where they can be seen (they cost more than they show from far away)
  rig.lod = (camDist, fur = true) => { const on = fur && camDist < 8.5; if (on !== rig.lodOn) { rig.lodOn = on; for (const s of rig.furShells) s.visible = on; } };
  rig.furShells = [];
  root.traverse((o) => { if (o.userData.furShell) rig.furShells.push(o); });
  rig.jig(bones.neck, [0, 1, 0], 0.22, 320, 26, 0.08, { dynamic: true });
  rig.jig(rigid.seax, [0, -1, 0], 0.3, 60, 6, 0.4, { g: 2.5 });
  rig.jig(rigid.strap, [0, -1, 0], 0.2, 40, 3.5, 0.8, { g: 3 });
  rig.jig(rigid.hair, [0, 1, 0], 0.1, 300, 18, 0.025);

  // cloth: the heavy wool cloak around the shoulders, and the tunic's skirt below the sword belt
  const clothMat = realMaterial({ key: 'cloth', side: THREE.DoubleSide });
  const furMat = realMaterial({ key: 'fur' });
  rig.clothDefs = [
    { type: 'cape', bone: 'chest', pins: capePins(24), rows: 17, length: 1.3, flare: 0.75, color: '#2b2e32', real: { material: clothMat, furMaterial: furMat, furShells: trimShells, mat0: [0, 1, 0, 0], fur: '#c2beb6', furRadius: 0.022 } },
    { type: 'skirt', bone: 'hips', topY: 0.892, top: [0.19, 0.152], hemY: 0.62, hem: [0.225, 0.192], rows: 6, cols: 26, color: '#33383e', real: { material: clothMat, furMaterial: furMat, furShells: trimShells, mat0: [0, 1, 0, 0], fur: '#c2beb6', furRadius: 0.018 } },
  ];
  // capsules the cloth rests on and slides around: [bone, bind-pose point] pairs + radius
  rig.colliderDefs = [
    { a: ['spine', [0, 1.08, -0.02]], b: ['chest', [0, 1.4, -0.03]], r: 0.15 },
    { a: ['chest', [0.15, 1.47, -0.03]], b: ['chest', [-0.15, 1.47, -0.03]], r: 0.085 },
    { a: ['hips', [0, 0.98, -0.01]], b: ['hips', [0, 0.9, -0.015]], r: 0.19 },
    { a: ['hips', [0, 0.93, -0.06]], b: ['hips', [0, 0.84, -0.07]], r: 0.15 },
    ...['L', 'R'].flatMap((k) => [
      { a: ['shoulder' + k, J['shoulder' + k]], b: ['elbow' + k, J['elbow' + k]], r: 0.068 },
      { a: ['elbow' + k, J['elbow' + k]], b: ['hand' + k, J['hand' + k]], r: 0.058 },
      { a: ['hand' + k, J['hand' + k]], b: ['hand' + k, [J['hand' + k][0], J['hand' + k][1] - 0.13, J['hand' + k][2] + 0.01]], r: 0.05 },
      { a: ['thigh' + k, J['thigh' + k]], b: ['knee' + k, J['knee' + k]], r: 0.108 },
      { a: ['knee' + k, J['knee' + k]], b: ['foot' + k, J['foot' + k]], r: 0.078 },
    ]),
    { obj: rigid.seax, a: [0, 0.1, 0], b: [0, -0.45, 0.012], r: 0.032 },
  ];
  return rig;
}
