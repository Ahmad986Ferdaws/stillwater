import * as THREE from 'three';

// Day runs from soft morning (t=0) to golden hour (t=1), then rests there.
const KEYS = [
  { t: 0.0, sun: '#ffd9b0', sunI: 2.3, zen: '#3f78c4', hor: '#cfe3f2', hemiI: 1.55, fog: '#c9dcea' },
  { t: 0.3, sun: '#fff1dc', sunI: 3.1, zen: '#2f6fd0', hor: '#bfe0f7', hemiI: 1.7, fog: '#c2dcef' },
  { t: 0.6, sun: '#fff4e2', sunI: 3.2, zen: '#2e6cc9', hor: '#c6e2f5', hemiI: 1.7, fog: '#c6dfef' },
  { t: 0.82, sun: '#ffd49a', sunI: 2.8, zen: '#3c6cb8', hor: '#f1dcc0', hemiI: 1.45, fog: '#e3d8c6' },
  { t: 1.0, sun: '#ffa55c', sunI: 2.3, zen: '#4a5f9c', hor: '#ffc28a', hemiI: 1.15, fog: '#eec9a4' },
].map((k) => ({ ...k, sun: new THREE.Color(k.sun), zen: new THREE.Color(k.zen), hor: new THREE.Color(k.hor), fog: new THREE.Color(k.fog) }));

function sample(t, out) {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
  const s = f * f * (3 - 2 * f);
  out.sun.copy(a.sun).lerp(b.sun, s);
  out.zen.copy(a.zen).lerp(b.zen, s);
  out.hor.copy(a.hor).lerp(b.hor, s);
  out.fog.copy(a.fog).lerp(b.fog, s);
  out.sunI = a.sunI + (b.sunI - a.sunI) * s;
  out.hemiI = a.hemiI + (b.hemiI - a.hemiI) * s;
  return out;
}

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const skyFrag = /* glsl */ `
uniform vec3 uSunDir, uSunColor, uZenith, uHorizon;
uniform float uTime;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));
  col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.2, d.y));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 60.0) * 0.35);
  col += uSunColor * smoothstep(0.9993, 0.9997, sd) * 6.0;

  // painterly clouds on a virtual plane
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.12) * 0.9 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(uv * 1.1);
    float c = smoothstep(0.52, 0.78, n) * smoothstep(0.0, 0.18, d.y);
    float shade = smoothstep(0.52, 0.95, fbm(uv * 1.1 + vec2(0.04)));
    vec3 lit = mix(vec3(1.0), uSunColor, 0.35) * 1.05;
    vec3 dark = mix(uHorizon, uZenith, 0.35) * 0.92;
    vec3 cc = mix(lit, dark, shade * 0.6);
    cc += uSunColor * pow(sd, 8.0) * 0.4;
    col = mix(col, cc, c * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function createEnvironment(scene, renderer) {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uTime: { value: 0 },
  };
  const skyMat = new THREE.ShaderMaterial({ uniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -42; sc.right = 42; sc.top = 42; sc.bottom = -42; sc.near = 1; sc.far = 420;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xbfdcff, 0x6d8f4a, 1.1);
  scene.add(hemi);

  scene.fog = new THREE.Fog(0xc9dcea, 70, 820);

  const cur = { sun: new THREE.Color(), zen: new THREE.Color(), hor: new THREE.Color(), fog: new THREE.Color(), sunI: 3, hemiI: 1 };
  const sunDir = new THREE.Vector3();
  const env = {
    t: 0.2,
    duration: 16 * 60, // seconds from morning to golden hour
    sunDir,
    sunColor: new THREE.Color(),
    ambient: new THREE.Color(),
    skyTint: new THREE.Color(),
    zenith: cur.zen,
    horizon: cur.hor,
    golden: 0,
    setShadowSize(size) {
      if (sun.shadow.mapSize.x === size && sun.shadow.map) return;
      sun.shadow.mapSize.set(size, size); sun.shadow.map?.dispose(); sun.shadow.map = null;
    },
    update(dt, focus, elapsed, camPos) {
      env.t = Math.min(1, env.t + dt / env.duration);
      sample(env.t, cur);
      // East in the morning, arcing over the lake side, setting in the west.
      const a = Math.PI * THREE.MathUtils.lerp(0.08, 0.97, env.t);
      const el = Math.sin(Math.PI * THREE.MathUtils.lerp(0.11, 0.955, env.t)) * THREE.MathUtils.degToRad(60);
      let hx = Math.cos(a), hz = -0.6 * Math.sin(a);
      const hl = Math.hypot(hx, hz); hx /= hl; hz /= hl;
      sunDir.set(hx * Math.cos(el), Math.sin(el), hz * Math.cos(el));
      env.golden = THREE.MathUtils.smoothstep(env.t, 0.75, 1.0);

      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uSunColor.value.copy(cur.sun);
      uniforms.uZenith.value.copy(cur.zen);
      uniforms.uHorizon.value.copy(cur.hor);
      uniforms.uTime.value = elapsed;

      sun.color.copy(cur.sun);
      sun.intensity = cur.sunI;
      // Keep the shadow frustum centred on the player and snapped to texels to avoid shimmer.
      const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, focus.y, fz);
      sun.position.set(fx + sunDir.x * 200, focus.y + sunDir.y * 200, fz + sunDir.z * 200);

      hemi.color.copy(cur.zen).lerp(cur.hor, 0.55);
      hemi.groundColor.set('#6d8f4a').lerp(cur.sun, 0.15);
      hemi.intensity = cur.hemiI;
      scene.fog.color.copy(cur.fog);

      env.sunColor.copy(cur.sun).multiplyScalar(cur.sunI / Math.PI);
      env.ambient.copy(hemi.color).multiplyScalar(cur.hemiI / Math.PI);
      env.skyTint.copy(cur.hor).lerp(cur.zen, 0.35);
      sky.position.copy(camPos);
    },
  };
  return env;
}
