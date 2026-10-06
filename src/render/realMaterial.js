import * as THREE from 'three';

// Physically based material for the realistic traveller (Thorfinn).
//
// One MeshPhysicalMaterial serves skin, wool, leather, metal, fur, hair and knit: every vertex carries
// material weights (aMat0 = skin, wool, leather, metal · aMat1 = fur, hair, knit, scar), so roughness,
// metalness and sheen change across the one seamless mesh. On top of that:
//  • procedural micro detail (wool twill, leather grain, pores, fur tufts, hammered metal) as bump,
//    computed in the rest pose so it sticks to the body, and faded out before it can shimmer;
//  • ambient occlusion baked from the sculpt's distance field (aAO);
//  • wrap lighting on skin — light bleeds red into the shadow side like subsurface scattering;
//  • image-based light from a small sky probe (see createSkyProbe) for real reflections.

const mats = new Set();
let envTex = null;

export const REAL = {
  iblDiffuse: { value: 0.85 },  // share of sky light coming from the probe…
  hemiScale: { value: 0.32 },   // …and from the scene's hemisphere light (kept low: the probe replaces it)
  objScale: { value: 1.12 },    // rest-pose units → world units, for bump heights
};

const VERT_PARS = /* glsl */ `
attribute vec4 aMat0;
attribute vec4 aMat1;
attribute float aAO;
attribute vec3 aRest;
varying vec4 vMat0;
varying vec4 vMat1;
varying float vAO;
varying vec3 vRest;
varying vec3 vRestN;
#ifdef USE_TANGENT
varying vec3 vRestT;
#endif
`;

const VERT_MAIN = /* glsl */ `
vMat0 = aMat0; vMat1 = aMat1; vAO = aAO; vRest = aRest; vRestN = normal;
#ifdef USE_TANGENT
vRestT = tangent.xyz;
#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vMat0;
varying vec4 vMat1;
varying float vAO;
varying vec3 vRest;
varying vec3 vRestN;
#ifdef USE_TANGENT
varying vec3 vRestT;
#endif
uniform float uIBLDiffuse;
uniform float uHemiScale;
uniform float uObjScale;
float gSkin = 0.0;

float rHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float rNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rHash(i), rHash(i + vec3(1, 0, 0)), f.x), mix(rHash(i + vec3(0, 1, 0)), rHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(rHash(i + vec3(0, 0, 1)), rHash(i + vec3(1, 0, 1)), f.x), mix(rHash(i + vec3(0, 1, 1)), rHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// light wraps further around skin in red than in blue (cheap subsurface scattering)
vec3 sssWrap(float ndl) {
  vec3 w = vec3(0.52, 0.2, 0.12);
  return clamp((vec3(ndl) + w) / (1.0 + w), 0.0, 1.0) * vec3(0.96, 1.0, 1.0);
}
// Mikkelsen bump without normalised screen derivatives, so relief keeps its real size at any distance
vec3 realBump(vec3 surfPos, vec3 n, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

// material weights, micro detail and albedo variation (runs right after vertex colours)
const FRAG_DETAIL = /* glsl */ `
vec4 mw0 = max(vMat0, 0.0), mw1 = max(vMat1, 0.0);
float mwSum = max(dot(mw0, vec4(1.0)) + dot(mw1, vec4(1.0)), 1e-4);
mw0 /= mwSum; mw1 /= mwSum;
vec3 rp = vRest;
float fp = length(fwidth(rp)) + 1e-7;
#define RFADE(T) (1.0 - smoothstep(0.3 * (T), 0.65 * (T), fp))
float dH = 0.0, dRough = 0.0, alb = 1.0;
if (mw0.x > 0.01) { // skin: pores and a little blotchiness
  float po = (rNoise(rp * 1500.0) - 0.5) * RFADE(1.0 / 1500.0);
  float bl = rNoise(rp * 70.0);
  dH -= mw0.x * 0.00006 * (po + 0.4 * (rNoise(rp * 260.0) - 0.5) * RFADE(1.0 / 260.0));
  alb *= mix(1.0, 0.94 + 0.1 * bl, mw0.x);
  dRough += mw0.x * (0.12 * bl - 0.06);
}
if (mw0.y > 0.01) { // wool: twill ribs + fuzz + heathered yarn
  float tw = sin(dot(rp, vec3(0.62, 0.74, 0.26)) * 1400.0) * RFADE(0.0045);
  float fz = (rNoise(rp * 620.0) - 0.5) * RFADE(1.0 / 620.0);
  float lump = rNoise(rp * 45.0) - 0.5;
  dH += mw0.y * (0.00022 * tw + 0.0003 * fz + 0.0006 * lump);
  alb *= mix(1.0, 0.86 + 0.26 * rNoise(rp * 160.0) * (0.6 + 0.4 * RFADE(1.0 / 160.0)), mw0.y);
}
if (mw0.z > 0.01) { // leather: pebbled grain, creases, worn lighter patches
  float gr = (rNoise(rp * 420.0) - 0.5) * RFADE(1.0 / 420.0);
  float cr = rNoise(rp * vec3(28.0, 90.0, 28.0));
  dH += mw0.z * (0.00018 * gr - 0.00045 * smoothstep(0.55, 0.9, cr));
  float wear = rNoise(rp * 22.0);
  alb *= mix(1.0, 0.78 + 0.38 * wear, mw0.z);
  dRough += mw0.z * (0.22 * (0.5 - wear));
}
if (mw0.w > 0.01) { // metal: hammered, a bit tarnished
  float hm = rNoise(rp * 180.0) - 0.5;
  dH += mw0.w * 0.00016 * hm * RFADE(1.0 / 180.0);
  float tar = rNoise(rp * 55.0);
  alb *= mix(1.0, 0.75 + 0.35 * tar, mw0.w);
  dRough += mw0.w * 0.25 * (tar - 0.4);
}
if (mw1.x > 0.01) { // fur: tufts and strands
  float tuft = rNoise(rp * 110.0);
  float strand = (rNoise(rp * vec3(900.0, 300.0, 900.0)) - 0.5) * RFADE(1.0 / 900.0);
  dH += mw1.x * (0.0016 * (tuft - 0.5) + 0.0005 * strand);
  alb *= mix(1.0, 0.66 + 0.46 * tuft + 0.12 * strand, mw1.x);
}
if (mw1.y > 0.01) { // hair (brows on the face; the hair mesh adds strands along its tangents)
  float s = rNoise(rp * vec3(1400.0, 500.0, 1400.0)) - 0.5;
  #ifdef USE_TANGENT
    vec3 across = normalize(cross(vRestT, vRestN));
    s = rNoise(vec3(dot(rp, across) * 1800.0, dot(rp, vRestT) * 70.0, 0.0)) - 0.5;
  #endif
  s *= RFADE(1.0 / 1500.0);
  dH += mw1.y * 0.00022 * s;
  alb *= mix(1.0, 0.82 + 0.5 * s + 0.12 * rNoise(rp * 90.0), mw1.y);
}
if (mw1.z > 0.01) { // knit / soft glove leather
  float kn = (rNoise(rp * vec3(700.0, 1100.0, 700.0)) - 0.5) * RFADE(1.0 / 700.0);
  dH += mw1.z * 0.00014 * kn;
  alb *= mix(1.0, 0.9 + 0.14 * rNoise(rp * 120.0), mw1.z);
}
#if defined( REAL_DOUBLE ) && !defined( REAL_NO_BACKTINT )
  alb *= gl_FrontFacing ? 1.0 : 0.62; // cloak lining sits in its own shade
#endif
diffuseColor.rgb *= alb;
`;

// Shell fur: each layer is the base mesh pushed out along its normal; strands are where rest-space noise
// beats the layer's height, so they thin toward the tips. Strand size follows the pixel footprint
// (blended between octaves) so fur never turns into shimmering noise far away.
const FRAG_SHELL = /* glsl */ `
{
  float lvl = max(0.0, log2(uFurDensity * fp / 0.4));
  float k0 = floor(lvl), fr = lvl - k0;
  float d0 = uFurDensity / exp2(k0);
  float s0 = rNoise(vRest * d0) * 0.7 + rNoise(vRest * d0 * 2.7 + 5.3) * 0.3;
  float s1 = rNoise(vRest * d0 * 0.5 + 11.7) * 0.7 + rNoise(vRest * d0 * 1.35 + 2.1) * 0.3;
  float strands = mix(s0, s1, fr);
  if (strands < 0.3 + uShell * 0.62) discard;
  diffuseColor.rgb *= mix(0.5, 1.06, uShell);
}
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = dot(mw0, vec4(0.58, 0.93, 0.56, 0.34)) + dot(mw1, vec4(0.86, 0.6, 0.7, 0.36)) + dRough;
roughnessFactor = clamp(roughnessFactor, 0.08, 1.0);
metalnessFactor = clamp(mw0.w * 1.1, 0.0, 1.0);
`;

const FRAG_NORMAL = /* glsl */ `
{
  float hW = dH * uObjScale;
  normal = realBump(-vViewPosition, normal, vec2(dFdx(hW), dFdy(hW)), faceDirection);
}
`;

export function realMaterial(opts = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    sheen: 1,
    sheenColor: new THREE.Color(1, 1, 1),
    sheenRoughness: 0.5,
    side: opts.side ?? THREE.FrontSide,
    ...(opts.params || {}),
  });
  m.envMap = envTex;
  const double = m.side === THREE.DoubleSide;
  const shell = opts.shell; // { t: 0…1 layer height, len: fur length, density: strands per metre }
  const defs = (double ? '#define REAL_DOUBLE\n' : '') + (opts.noBackTint ? '#define REAL_NO_BACKTINT\n' : '') + (shell ? '#define REAL_SHELL\n' : '');
  m.onBeforeCompile = (s) => {
    s.uniforms.uIBLDiffuse = REAL.iblDiffuse;
    s.uniforms.uHemiScale = REAL.hemiScale;
    s.uniforms.uObjScale = REAL.objScale;
    s.uniforms.uShell = { value: shell ? shell.t : 0 };
    s.uniforms.uFurLen = { value: shell ? shell.len : 0 };
    s.uniforms.uFurDensity = { value: shell ? shell.density || 420 : 0 };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', defs + '#include <common>\n' + VERT_PARS + 'uniform float uShell;\nuniform float uFurLen;\n')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        #ifdef REAL_SHELL
          transformed += normalize(objectNormal) * uShell * uFurLen;
          transformed.y -= uShell * uShell * uFurLen * 0.35; // the tips droop
        #endif`);
    // skin: wrap the diffuse term of direct light (specular keeps the true angle)
    const physPars = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );',
      `vec3 wrapI = sssWrap( dot( geometryNormal, directLight.direction ) ) * directLight.color;
      reflectedLight.directDiffuse += mix( irradiance, wrapI, gSkin ) * BRDF_Lambert( material.diffuseContribution );`);
    if (physPars === THREE.ShaderChunk.lights_physical_pars_fragment) console.warn('realMaterial: skin wrap hook not found');
    s.fragmentShader = s.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', physPars)
      .replace('#include <common>', defs + '#include <common>\n' + FRAG_PARS + 'uniform float uShell;\nuniform float uFurDensity;\n')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_DETAIL + (shell ? FRAG_SHELL : ''))
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL)
      .replace('#include <lights_physical_fragment>', `gSkin = mw0.x + mw1.w * 0.8;
        #include <lights_physical_fragment>
        material.specularColor *= 1.0 - 0.4 * mw0.x; // skin: a softer sheen than the default plastic
        material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
        #ifdef USE_SHEEN
          // fabric sheen takes the colour of its fibres
          material.sheenColor *= (mw0.y * 0.22 + mw1.x * 0.75 + mw1.z * 0.3 + mw1.y * 0.12) * mix(vec3(1.0), clamp(diffuseColor.rgb * 3.5, 0.0, 1.0), 0.65);
          material.sheenRoughness = clamp(0.35 + 0.35 * mw1.x + 0.2 * mw0.y, 0.07, 1.0);
        #endif`)
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n#if defined( RE_IndirectDiffuse )\nirradiance *= uHemiScale;\n#endif')
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#if defined( RE_IndirectDiffuse )\niblIrradiance *= uIBLDiffuse;\n#endif')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float occ = clamp(vAO, 0.0, 1.0);
          reflectedLight.indirectDiffuse *= occ;
          reflectedLight.directDiffuse *= mix(1.0, occ, 0.35);
          float nv = saturate(dot(geometryNormal, geometryViewDir));
          reflectedLight.indirectSpecular *= saturate(pow(nv + occ, exp2(-16.0 * material.roughness - 1.0)) - 1.0 + occ);
          #ifdef USE_SHEEN
            sheenSpecularIndirect *= occ;
          #endif
        }`);
  };
  m.customProgramCacheKey = () => 'real-v2-' + defs.replace(/\s+/g, '') + (opts.key || '');
  mats.add(m);
  return m;
}

// Materials that only need the sky probe (eyes).
export function useSkyProbe(m) { m.envMap = envTex; mats.add(m); return m; }

function setEnv(tex) {
  const first = !envTex;
  envTex = tex;
  for (const m of mats) { m.envMap = tex; if (first) m.needsUpdate = true; }
}

// Adds the per-vertex attributes realMaterial expects to plain geometry (eyelids, fur tubes, cloth).
export function realAttributes(geo, mat0, mat1, ao = 1, color = null) {
  const n = geo.attributes.position.count;
  const a0 = new Float32Array(n * 4), a1 = new Float32Array(n * 4), o = new Float32Array(n).fill(ao);
  for (let i = 0; i < n; i++) { a0.set(mat0, i * 4); a1.set(mat1, i * 4); }
  geo.setAttribute('aMat0', new THREE.BufferAttribute(a0, 4));
  geo.setAttribute('aMat1', new THREE.BufferAttribute(a1, 4));
  geo.setAttribute('aAO', new THREE.BufferAttribute(o, 1));
  if (!geo.attributes.aRest) geo.setAttribute('aRest', geo.attributes.position.clone());
  if (color) {
    const c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  return geo;
}

// ---- sky probe: a tiny copy of the sky + ground, rendered to a cube and pre-filtered for reflections ----
const probeVert = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const probeFrag = /* glsl */ `
uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uGround;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.55));
  float sd = max(dot(d, uSunDir), 0.0);
  sky += uSunColor * (pow(sd, 5.0) * 0.25 + pow(sd, 48.0) * 0.6);
  // valley floor: meadow green lit by the sun, a hazy band where it meets the sky
  vec3 ground = uGround * (0.85 + 0.15 * smoothstep(-0.6, -0.05, d.y));
  vec3 col = mix(sky, ground, smoothstep(0.02, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

export function createSkyProbe(renderer) {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
  };
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ uniforms, vertexShader: probeVert, fragmentShader: probeFrag, side: THREE.BackSide, depthWrite: false }));
  scene.add(dome);
  const cubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(0.1, 50, cubeRT);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let target = null, lastT = -1, lastAt = -1e9;
  const grass = new THREE.Color('#68704c');
  return {
    update(env, elapsed, force = false) {
      if (!force && Math.abs(env.t - lastT) < 0.004 && elapsed - lastAt < 6) return;
      lastT = env.t; lastAt = elapsed;
      uniforms.uSunDir.value.copy(env.sunDir);
      uniforms.uSunColor.value.copy(env.sunColor).multiplyScalar(Math.PI * 0.35);
      uniforms.uZenith.value.copy(env.zenith || env.skyTint);
      uniforms.uHorizon.value.copy(env.horizon || env.skyTint);
      // ground radiance ≈ albedo × (sun + sky irradiance) / π
      const sunE = Math.max(0, env.sunDir.y) * Math.PI; // env.sunColor is already divided by π
      uniforms.uGround.value.copy(grass).multiply(new THREE.Color().copy(env.sunColor).multiplyScalar(sunE).add(env.ambient.clone().multiplyScalar(Math.PI * 0.6))).multiplyScalar(0.36);
      cam.update(renderer, scene);
      target = pmrem.fromCubemap(cubeRT.texture, target);
      if (envTex !== target.texture) setEnv(target.texture);
    },
  };
}
