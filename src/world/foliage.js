import * as THREE from 'three';
import { windTime } from './geo.js';
import { leafAtlas, barkTextures, groundTextures, noiseTexture } from './textures.js';

// Materials for trees, bushes, ferns and rocks.
//  - leaves: alpha-tested (+ alpha-to-coverage) leaf-cluster cards from the atlas, canopy-centre
//    normals baked in the geometry (no back-face flip), wrap lighting + back-light translucency.
//  - bark: bark array texture + normal map via screen-space tangent frame.
//  - wind: trunk sway (aWind.w) + branch bend (aWind.x) + card flutter (aWind.y), phase aWind.z
//    (leaf vertices use phase + 1, so aWind.z >= 1 marks foliage).
//  - LOD: per-instance distance to uLodCenter (the player). Near meshes (uLodSide = 1) dissolve out
//    over uLodBand.xy, far meshes (-1) dissolve in over the same band and out again over .zw.
//    Instances outside their range collapse to a point in the vertex shader. Same logic runs in the
//    shadow depth materials so shadows always match what is drawn.
//  - anything close to the camera dithers away (keeps the view clear), like geo.js standard().

export const foliageUniforms = {
  uTime: windTime,
  uWindDir: { value: new THREE.Vector2(0.8, 0.45).normalize() },
  uLodCenter: { value: new THREE.Vector3(0, 0, 0) },
  uLodBand: { value: new THREE.Vector4(64, 72, 560, 600) },
  // small plants (bushes) share the near band but leave much earlier
  uLodBandSmall: { value: new THREE.Vector4(64, 72, 150, 170) },
};

// ---- GLSL -----------------------------------------------------------------------------------
const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform vec3 uLodCenter;
uniform vec4 uLodBand;
uniform float uLodSide;
uniform vec3 uSway;
attribute vec4 aWind;
attribute vec2 aCorner;
varying vec2 vLod;
`;

const WIND_VERT = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
  mat4 swM = modelMatrix * instanceMatrix;
#else
  mat4 swM = modelMatrix;
#endif
vec3 swO = swM[3].xyz;
bool swGone = false;
vLod = vec2(0.0);
if (uLodSide != 0.0) {
  float swDist = length(swO.xz - uLodCenter.xz);
  float kIn = smoothstep(uLodBand.x, uLodBand.y, swDist);
  float kOut = smoothstep(uLodBand.z, uLodBand.w, swDist);
  vLod = vec2(kIn, kOut);
  swGone = uLodSide > 0.0 ? kIn >= 1.0 : (kIn <= 0.0 || kOut >= 1.0);
}
if (swGone) {
  transformed = vec3(0.0);
} else {
  // camera-facing leaf-cluster cards: offset in the view plane (shadow pass: faces the light)
  if (aCorner.x != 0.0 || aCorner.y != 0.0) {
    mat3 swM3 = mat3(swM);
    float swS = length(swM3[0]);
    vec3 swR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 swU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    transformed += transpose(swM3) * (swR * aCorner.x + swU * aCorner.y) / swS;
  }
  vec3 swW = normalize(transpose(mat3(swM)) * vec3(uWindDir.x, 0.0, uWindDir.y));
  float swPh = dot(swO.xz, vec2(0.071, 0.053));
  float swGust = 0.55 + 0.45 * sin(uTime * 0.31 + dot(swO.xz, uWindDir) * 0.021);
  float swSway = (sin(uTime * 0.83 + swPh) * 0.6 + sin(uTime * 1.37 + swPh * 1.7) * 0.3 + 0.5) * swGust;
  float swBend = sin(uTime * 1.9 + swPh * 2.3 + aWind.z * 6.2832) * 0.5 + 0.5;
  vec3 swD = swW * (aWind.w * swSway * uSway.x + aWind.x * (0.3 + 0.7 * swBend) * swGust * uSway.y);
  swD.y -= aWind.x * swBend * swGust * uSway.y * 0.3;
  float swFl = sin(uTime * 7.3 + aWind.z * 40.0 + swPh) * sin(uTime * 3.1 + aWind.z * 17.0 + swPh * 0.7);
  swD += vec3(0.55, 0.85, -0.45) * (swFl * aWind.y * uSway.z * (0.5 + swGust));
  transformed += swD;
}
`;

const DITHER_PARS = /* glsl */ `
uniform float uLodSide;
varying vec2 vLod;
`;

// Camera-near dissolve (as geo.js) + complementary LOD dissolve between near and far meshes.
const DITHER_FRAG = /* glsl */ `
{
  float swIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (swIgn > smoothstep(1.4, 3.6, length(vViewPosition))) discard;
  if (uLodSide > 0.0 && swIgn < vLod.x) discard;
  if (uLodSide < 0.0 && (swIgn >= vLod.x || swIgn < vLod.y)) discard;
}
`;

const LEAF_PARS = /* glsl */ `
varying float vLeaf;
uniform vec3 uTranslCol;
uniform float uTransl, uWrap;
`;

const LEAF_RE = /* glsl */ `
void RE_Direct_Foliage(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  float wrapD = saturate((nl + uWrap) / (1.0 + uWrap));
  reflectedLight.directDiffuse += wrapD * directLight.color * BRDF_Lambert(material.diffuseColor);
  float back = pow(saturate(dot(geometryViewDir, -directLight.direction)), 3.0);
  float thin = saturate(-nl) * 0.25;
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uTranslCol * ((back * 0.75 + thin) * uTransl * vLeaf);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`;

const BARK_PARS_F = /* glsl */ `
uniform highp sampler2DArray uBarkAlb;
uniform highp sampler2DArray uBarkNrm;
varying vec3 vBarkUv;
mat3 swTangentFrame(vec3 eyePos, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(eyePos), q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n), q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
`;

const BARK_NORMAL = /* glsl */ `
{
  vec3 bn = texture(uBarkNrm, vBarkUv).xyz * 2.0 - 1.0;
  vec3 bt = vec3(bn.xy * 1.2, sqrt(max(1.0 - dot(bn.xy, bn.xy), 0.0)));
  mat3 btbn = swTangentFrame(-vViewPosition, normal, vBarkUv.xy);
  normal = normalize(btbn * bt);
}
`;

// ---- material factories ---------------------------------------------------------------------
function windUniforms(side, sway, small) {
  return {
    uTime: foliageUniforms.uTime, uWindDir: foliageUniforms.uWindDir,
    uLodCenter: foliageUniforms.uLodCenter, uLodBand: small ? foliageUniforms.uLodBandSmall : foliageUniforms.uLodBand,
    uLodSide: { value: side }, uSway: { value: new THREE.Vector3(...sway) },
  };
}

function depthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS)
      .replace('#include <begin_vertex>', WIND_VERT);
  };
  m.customProgramCacheKey = () => 'sw-foliage-depth-1';
  return m;
}

// side: 1 near LOD, -1 far LOD, 0 hero (no LOD). sway: [trunk, branch, flutter] in metres.
// small: use the short far range (bushes).
export function leafMaterial(side = 1, sway = [0.1, 0.08, 0.035], small = false) {
  const uniforms = {
    ...windUniforms(side, sway, small),
    uTranslCol: { value: new THREE.Color(1.0, 1.1, 0.72) }, uTransl: { value: 0.36 }, uWrap: { value: 0.45 },
  };
  const m = new THREE.MeshLambertMaterial({
    map: leafAtlas(), alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true,
  });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS + 'varying float vLeaf;\n')
      .replace('#include <begin_vertex>', WIND_VERT + 'vLeaf = step(1.0, aWind.z);\n');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DITHER_PARS + LEAF_PARS)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DITHER_FRAG)
      .replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\n' + LEAF_RE)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  m.customProgramCacheKey = () => 'sw-leaf-1';
  m.userData.uniforms = uniforms;
  m.userData.depth = depthMaterial(uniforms);
  return m;
}

export function barkMaterial(side = 1, sway = [0.1, 0.08, 0.035], small = false) {
  const bark = barkTextures();
  const uniforms = { ...windUniforms(side, sway, small), uBarkAlb: { value: bark.albedo }, uBarkNrm: { value: bark.normal } };
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS + 'attribute vec3 aBark;\nvarying vec3 vBarkUv;\n')
      .replace('#include <begin_vertex>', WIND_VERT + 'vBarkUv = aBark;\n');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DITHER_PARS + BARK_PARS_F)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DITHER_FRAG)
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= texture(uBarkAlb, vBarkUv).rgb;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BARK_NORMAL);
  };
  m.customProgramCacheKey = () => 'sw-bark-1';
  m.userData.uniforms = uniforms;
  m.userData.depth = depthMaterial(uniforms);
  return m;
}

// Assign materials + matching shadow depth material to a mesh.
export function useFoliage(mesh, mat) {
  mesh.material = mat;
  mesh.customDepthMaterial = mat.userData.depth;
  return mesh;
}

// ---- rocks ----------------------------------------------------------------------------------
// Triplanar rock detail shared with the terrain (ground layer 2), moss on up-facing surfaces
// (ground layer 0 as texture), vertex colours carry crevice AO.
const ROCK_PARS_V = /* glsl */ `
varying vec3 vRkW;
varying vec3 vRkN;
`;
const ROCK_V = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
  mat4 rkM = modelMatrix * instanceMatrix;
#else
  mat4 rkM = modelMatrix;
#endif
vRkW = (rkM * vec4(transformed, 1.0)).xyz;
vRkN = normalize(mat3(rkM) * objectNormal);
`;
const ROCK_PARS_F = /* glsl */ `
varying vec3 vRkW;
varying vec3 vRkN;
uniform highp sampler2DArray uRkAlb;
uniform highp sampler2DArray uRkNrm;
uniform sampler2D uRkNoise;
uniform vec3 uRkTint, uRkMoss;
uniform float uRkScale;
vec3 rkDecode(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
vec3 rkTN(vec4 n) { vec2 t = n.rg * 2.0 - 1.0; return vec3(t, sqrt(max(1.0 - dot(t, t), 0.0))); }
`;
const ROCK_ALBEDO = /* glsl */ `
vec3 rkN0 = normalize(vRkN);
vec3 rkBW = pow(abs(rkN0), vec3(4.0));
rkBW /= (rkBW.x + rkBW.y + rkBW.z);
vec3 rkS = vec3(rkN0.x < 0.0 ? -1.0 : 1.0, rkN0.y < 0.0 ? -1.0 : 1.0, rkN0.z < 0.0 ? -1.0 : 1.0);
vec3 rkP = vRkW * uRkScale;
vec2 rkUX = vec2(rkP.z * rkS.x, rkP.y), rkUY = vec2(rkP.x * rkS.y, rkP.z), rkUZ = vec2(-rkP.x * rkS.z, rkP.y);
float rkMoss;
{
  vec3 c = rkDecode(texture(uRkAlb, vec3(rkUX, 2.0)).rgb) * rkBW.x
         + rkDecode(texture(uRkAlb, vec3(rkUY, 2.0)).rgb) * rkBW.y
         + rkDecode(texture(uRkAlb, vec3(rkUZ, 2.0)).rgb) * rkBW.z;
  c *= uRkTint;
  c = mix(c, vec3(dot(c, vec3(0.3333))), 0.3);
  float n = texture(uRkNoise, vRkW.xz * 0.09).r;
  rkMoss = smoothstep(0.5, 0.8, rkN0.y + (n - 0.5) * 0.7);
  vec3 moss = uRkMoss * texture(uRkAlb, vec3(vRkW.xz * 0.6, 0.0)).rgb * 2.0;
  diffuseColor.rgb *= mix(c, moss, rkMoss);
}
`;
const ROCK_NORMAL = /* glsl */ `
{
  vec3 tX = rkTN(texture(uRkNrm, vec3(rkUX, 2.0)));
  vec3 tY = rkTN(texture(uRkNrm, vec3(rkUY, 2.0)));
  vec3 tZ = rkTN(texture(uRkNrm, vec3(rkUZ, 2.0)));
  tX.x *= rkS.x; tY.x *= rkS.y; tZ.x *= -rkS.z;
  tX = vec3(tX.xy + rkN0.zy, tX.z * rkN0.x);
  tY = vec3(tY.xy + rkN0.xz, tY.z * rkN0.y);
  tZ = vec3(tZ.xy + rkN0.xy, tZ.z * rkN0.z);
  vec3 nW = normalize(tX.zyx * rkBW.x + tY.xzy * rkBW.y + tZ.xyz * rkBW.z);
  nW = normalize(mix(nW, rkN0, rkMoss * 0.6));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;
const ROCK_FADE = /* glsl */ `
{
  float swIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (swIgn > smoothstep(1.4, 3.6, length(vViewPosition))) discard;
}
`;

let _rock;
export function rockMaterial() {
  if (_rock) return _rock;
  const g = groundTextures();
  const uniforms = {
    uRkAlb: { value: g.albedo }, uRkNrm: { value: g.normal }, uRkNoise: { value: noiseTexture() },
    // terrain rock layer is in "effective" colour space (darker); lift it to the boulders' old tone
    uRkTint: { value: new THREE.Vector3(2.6, 2.75, 3.2) },
    uRkMoss: { value: new THREE.Color('#79a24a').multiplyScalar(0.9) },
    uRkScale: { value: 0.3 },
  };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS_V)
      .replace('#include <begin_vertex>', ROCK_V);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS_F)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + ROCK_FADE)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + ROCK_ALBEDO)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + ROCK_NORMAL);
  };
  m.customProgramCacheKey = () => 'sw-rock-1';
  _rock = m;
  return m;
}

// ---- per-frame + quality ---------------------------------------------------------------------
const listeners = [];
export function onFoliageUpdate(fn) { listeners.push(fn); }

// Called once per frame (from grass.updatePatches) with the player position.
export function updateFoliage(center) {
  foliageUniforms.uLodCenter.value.copy(center);
  for (const fn of listeners) fn(center);
}

// trees: 0/1/2 -> LOD bands [near fade start, near end, far fade start, far end] in metres.
// Far trees stay until the linear fog (70..820 m) has mostly swallowed them; they cost little.
export const LOD_BANDS = [[22, 28, 300, 330], [44, 52, 420, 450], [64, 72, 560, 600]];
const SMALL_FAR = [[70, 85], [110, 125], [150, 170]];
export function setFoliageLod(level) {
  const l = Math.max(0, Math.min(2, level | 0));
  const b = LOD_BANDS[l], s = SMALL_FAR[l];
  foliageUniforms.uLodBand.value.set(b[0], b[1], b[2], b[3]);
  foliageUniforms.uLodBandSmall.value.set(b[0], b[1], s[0], s[1]);
}
