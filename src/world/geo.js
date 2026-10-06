import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Small helpers for building stylised props out of primitives with vertex colours.

export function prep(g) {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('uv');
  if (!n.attributes.normal) n.computeVertexNormals();
  return n;
}

export function paint(g, color, fn) {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    c.set(color);
    if (fn) fn(c, p, i);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Deterministic per-position hash so duplicated (non-indexed) vertices move together.
function phash(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export function jitter(g, amt, recompute = true) {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const kx = Math.round(x * 1000) / 1000, ky = Math.round(y * 1000) / 1000, kz = Math.round(z * 1000) / 1000;
    pos.setXYZ(i, x + (phash(kx, ky, kz) - 0.5) * amt, y + (phash(ky, kz, kx) - 0.5) * amt, z + (phash(kz, kx, ky) - 0.5) * amt);
  }
  if (recompute) g.computeVertexNormals();
  return g;
}

// Fluffy canopy blob: normals bent outward from the canopy centre so light wraps softly.
export function blob(r, x, y, z, color, center, detail = 2, squash = 1) {
  const g = prep(new THREE.IcosahedronGeometry(r, detail));
  jitter(g, r * 0.16, false);
  g.scale(1, squash, 1);
  g.translate(x, y, z);
  const pos = g.attributes.position, nor = g.attributes.normal;
  const own = new THREE.Vector3(x, y, z);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(center).normalize();
    n.fromBufferAttribute(pos, i).sub(own).normalize().lerp(v, 0.6).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  const top = new THREE.Color(color.top), mid = new THREE.Color(color.mid), bot = new THREE.Color(color.bot);
  return paint(g, color.mid, (c, p) => {
    const t = THREE.MathUtils.clamp((p.y - center.y) / (r * 1.6) + 0.5, 0, 1);
    if (t < 0.5) c.copy(bot).lerp(mid, t * 2); else c.copy(mid).lerp(top, (t - 0.5) * 2);
  });
}

export function cyl(rTop, rBot, h, seg, color, x = 0, y = 0, z = 0, colorTop) {
  const g = prep(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, true));
  g.translate(x, y + h / 2, z);
  const a = new THREE.Color(color), b = new THREE.Color(colorTop || color);
  return paint(g, color, (c, p) => c.copy(a).lerp(b, THREE.MathUtils.clamp((p.y - y) / h, 0, 1)));
}

export function merge(list) {
  return mergeGeometries(list, false);
}

// Anything right in front of the camera dissolves with a screen-space dither instead of
// blocking the view (trees, rocks, ruins).
const FADE = `
  {
    float camD = length(vViewPosition);
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (ign > smoothstep(1.4, 3.6, camD)) discard;
  }`;
function withFade(fs) {
  return fs.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FADE);
}

export function standard(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, ...opts });
  m.onBeforeCompile = (s) => { s.fragmentShader = withFade(s.fragmentShader); };
  m.customProgramCacheKey = () => 'fade-' + m.side;
  return m;
}

// Wind sway for vegetation (works on instanced + plain meshes).
export const windTime = { value: 0 };
export function addWind(mat, strength = 1, flutter = 1) {
  mat.onBeforeCompile = (s) => {
    s.fragmentShader = withFade(s.fragmentShader);
    s.uniforms.uTime = windTime;
    s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      #ifdef USE_INSTANCING
        vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
      #else
        vec2 ip = vec2(modelMatrix[3].x, modelMatrix[3].z);
      #endif
      float hw = max(position.y - 0.8, 0.0);
      float sw = sin(uTime * 0.9 + ip.x * 0.05 + ip.y * 0.037) * 0.65 + sin(uTime * 2.1 + ip.x * 0.11) * 0.2;
      transformed.x += hw * hw * 0.0035 * ${strength.toFixed(2)} * (sw + 0.35);
      transformed.z += hw * hw * 0.0022 * ${strength.toFixed(2)} * sw;
      float fl = sin(uTime * 5.0 + position.x * 2.3 + position.z * 1.7 + ip.x) * 0.018 * ${flutter.toFixed(2)} * step(1.5, position.y);
      transformed += vec3(fl, fl * 0.6, -fl);
    `);
  };
  mat.customProgramCacheKey = () => `wind-${strength}-${flutter}-${mat.side}`;
  return mat;
}
