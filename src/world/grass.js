import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF, WORLD, GRID, CELL, dataTexture, grassTexture, normalTexture, splatTexture, canopyTexture } from './terrain.js';
import { noiseTexture } from './textures.js';
import { updateFoliage } from './foliage.js';
import { mulberry32 } from '../noise.js';
import { LAYERS } from '../layers.js';

// Grass, flowers and small ground clutter live in square "patches" that follow the player. Each
// instance has a fixed world position modulo the patch size, so nothing slides as you walk; it wraps.
// Grass is three rings: a dense inner ring of thin clumped blades, a mid ring of fewer/wider blades,
// and a sparse far ring of cheap tufts; in some patches part of the blades grow into tall seed
// stems. Rings cross-fade by thinning, and blades shrink and take the ground colour toward every
// edge (ring ends, paths, sand), so the grass never stops in a hard line. Wildflowers grow in
// clumps inside drifts where one species dominates.
// Everything here is on LAYERS.GRASS (no shadow casting, skipped by reflection/refraction passes).

export const shared = {
  uTime: { value: 0 },
  uCenter: { value: new THREE.Vector2() },
  uPlayer: { value: new THREE.Vector3() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color(1, 1, 1) },
  uWindDir: { value: new THREE.Vector2(0.8, 0.45).normalize() },
};

const f1 = (v) => v.toFixed(1), f6 = (v) => v.toFixed(6);

// ---- shared GLSL ------------------------------------------------------------------------------
const PATCH_PARS = /* glsl */ `
uniform sampler2D uData;
uniform sampler2D uTNrm;
uniform sampler2D uSplat;
uniform sampler2D uColorMap;
uniform sampler2D uNoise;
uniform sampler2D uCanopy;
uniform float uTime, uPatch, uKind;
uniform vec2 uCenter, uWindDir;
uniform vec3 uPlayer;
uniform vec4 uRing;
uniform vec4 uShape;
attribute vec2 aOffset;
attribute vec4 aRand;
attribute vec2 aClump;
varying vec3 vGCol;
varying float vGTip;
const float G_HALF = ${f1(HALF)};
const float G_CELL = ${f6(CELL)};
const float G_GRID = ${f1(GRID)};
const float G_N = ${f1(GRID + 1)};
const float G_WORLD = ${f1(WORLD)};
// Exact terrain height (same triangle split as the mesh) + bilinear data, from one set of fetches.
void gTerrain(vec2 xz, out float h, out vec4 d) {
  vec2 g = clamp((xz + G_HALF) / G_CELL, vec2(0.0), vec2(G_GRID - 0.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  vec4 a = texelFetch(uData, i, 0), b = texelFetch(uData, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(uData, i + ivec2(0, 1), 0), e = texelFetch(uData, i + ivec2(1, 1), 0);
  h = (f.x + f.y <= 1.0) ? a.r + (b.r - a.r) * f.x + (c.r - a.r) * f.y : e.r + (c.r - e.r) * (1.0 - f.x) + (b.r - e.r) * (1.0 - f.y);
  d = mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
}
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

// Common prologue: wrap into the patch, ring mask, a cheap per-kind EARLY mask (tested before any
// terrain lookup, so dead instances cost little), terrain + splat + crown-shade lookups, density,
// frustum cull. DENS is a per-kind expression using td (data), sp (splat), meadow, shade, bare.
function prologue(early, dens, relocate = '') {
  return /* glsl */ `
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 gPos = vec3(0.0);
vGCol = vec3(0.0);
vGTip = 0.0;
bool gLive = false;
{
  vec2 corner = uCenter - uPatch * 0.5;
  vec2 wp = corner + mod(aOffset - corner, uPatch);
  ${relocate}
  float dist = length(wp - uCenter);
  float ring = smoothstep(uRing.x, uRing.y, dist) * (1.0 - smoothstep(uRing.z, uRing.w, dist));
  vec2 tuv = (wp + G_HALF) / G_WORLD;
  float early = ring > aRand.w ? (${early}) : 0.0;
  if (ring * early > aRand.w) {
    float gh; vec4 td;
    gTerrain(wp, gh, td);
    vec4 sp = textureLod(uSplat, tuv, 0.0);
    vec4 tn = textureLod(uTNrm, ((wp + G_HALF) / G_CELL + 0.5) / G_N, 0.0);
    vec3 tN = normalize(tn.xyz * 2.0 - 1.0);
    float meadow = tn.a;
    float bare = clamp(sp.r + sp.g + sp.b, 0.0, 1.0);
    vec2 can = textureLod(uCanopy, tuv, 0.0).rg;
    float shade = max(can.r, can.g);
    float densRaw = ${dens};
    float keep = densRaw * early * ring * uShape.w - aRand.w;
    if (keep > 0.0) {
      vec4 cp = projectionMatrix * (viewMatrix * vec4(wp.x, gh + 0.3, wp.y, 1.0));
      if (cp.w < -1.0 || abs(cp.x) > cp.w + 1.4 || abs(cp.y) > cp.w + 1.6) keep = -1.0;
    }
    if (keep > 0.0) {
      gLive = true;
`;
}
// Dead instances leave here: every vertex of the instance lands outside the clip volume (so its
// triangles are dropped) and the rest of the vertex shader (normals, shadow coords, fog) is skipped.
const EPILOGUE = /* glsl */ `
    }
  }
}
if (!gLive) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  return;
}
`;

// ragged, gradual edges: per-clump jitter on the path/sand weight, thinner under tree crowns
const GRASS_DENS = /* glsl */ `td.g * (1.0 - smoothstep(0.3, 0.85, bare + (gHash(floor((wp - aClump) * 2.3)) - 0.5) * 0.35)) * (1.0 - 0.5 * shade)`;

const GRASS_BODY = /* glsl */ `
      float grow = smoothstep(0.0, 0.1, keep);
      // outer rings shrink toward their end (the inner ring hands over to the mid ring instead)
      float outerK = uRing.w > 15.0 ? 1.0 - smoothstep(uRing.z, uRing.w, dist) : 1.0;
      bool farR = uRing.w > 50.0;
      vec4 nz = textureLod(uNoise, wp * 0.011, 0.0);
      vec4 nz2 = textureLod(uNoise, wp * 0.07, 0.0);
      float edgeK = 1.0 - smoothstep(0.05, 0.6, bare);
      // seed-head grass in patches: a share of the blades become tall stems carrying a straw ear
      float seedP = smoothstep(0.6, 0.72, nz.g) * smoothstep(0.3, 0.7, meadow) * edgeK * (1.0 - shade);
      bool seed = fract(aRand.x * 7.13) < seedP * 0.26;
      float H = (0.3 + aRand.y * 0.45) * td.b * uShape.x * (0.75 + 0.5 * nz2.r) * (0.25 + 0.75 * edgeK) * (0.2 + 0.8 * smoothstep(0.0, 0.85, td.g));
      if (seed) H = (0.72 + 0.38 * aRand.y) * uShape.x * (0.8 + 0.3 * nz2.r);
      H *= grow * (0.3 + 0.7 * outerK) * (1.0 - 0.25 * shade);
      float y = position.y;
      // seed stems are thin, with a slightly fuller ear at the top
      float W = (0.6 + aRand.z * 0.8) * uShape.y * (seed && !farR ? (y > 0.7 ? 0.62 : 0.38) : 1.0);
      float ang = aRand.x * 6.28318;
      vec2 side = vec2(cos(ang), sin(ang));
      vec2 facing = vec2(-side.y, side.x);
      // wind: rolling waves across the field + drifting gusts + a little per-blade flutter
      float wave = sin(dot(wp, uWindDir) * 0.16 - uTime * 1.6 + nz.g * 3.0) * 0.5 + 0.5;
      float gust = textureLod(uNoise, wp * 0.006 - uWindDir * (uTime * 0.018), 0.0).b;
      float wv = (0.12 + 0.55 * wave * wave) * (0.35 + 1.3 * gust);
      float flick = sin(uTime * 3.7 + aRand.x * 40.0 + wp.x * 0.7) * 0.06;
      vec2 bend = aClump * 1.2 + facing * ((aRand.z - 0.5) * 0.35) + uWindDir * ((wv + flick) * uShape.z * (seed ? 1.3 : 1.0));
      // the traveller pushes blades aside
      vec2 away = wp - uPlayer.xz;
      float pdist = length(away);
      float pnear = (1.0 - smoothstep(0.35, 1.9, pdist)) * (1.0 - smoothstep(0.6, 1.8, uPlayer.y - gh));
      bend += (away / max(pdist, 0.001)) * (pnear * 1.6);
      float bl = length(bend);
      if (bl > 1.3) { bend *= 1.3 / bl; bl = 1.3; }
      gPos = vec3(wp.x, gh, wp.y);
      gPos.xz += side * (position.x * W);
      gPos.xz += bend * (y * y * H);
      gPos.y += y * H * (1.0 - 0.32 * bl * y);
      // lighting normal: mostly the ground's, tilted toward the blade face + rounded across it
      vec3 fN = vec3(facing.x, 0.0, facing.y);
      if (dot(fN, cameraPosition - gPos) < 0.0) fN = -fN;
      objectNormal = normalize(tN * 0.75 + fN * 0.3 + vec3(side.x, 0.0, side.y) * (position.x * 0.25) + vec3(0.0, 0.15, 0.0));
      // colour: macro grass colour (with the meadow patches baked in), sun-bleached areas, darker
      // clumps, straw tips in meadows; shade under crowns; toward the ring end the ground's colour
      vec3 base = textureLod(uColorMap, tuv, 2.5).rgb;
      float cr = gHash(floor((wp - aClump) * 7.0));
      vec3 col = mix(base * vec3(1.0, 1.1, 0.85), base * vec3(1.55, 1.28, 0.6) + vec3(0.012, 0.01, 0.0), smoothstep(0.55, 0.85, nz.r) * (0.25 + 0.6 * meadow));
      col = mix(col, base * vec3(0.72, 0.86, 0.8), smoothstep(0.55, 1.0, cr) * 0.6);
      col *= 0.86 + 0.26 * aRand.y;
      // a little less saturated than the colour map (real blades are waxy, with dry and bluish ones)
      col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))) * vec3(1.05, 1.0, 0.72), 0.22);
      vec3 tip = col * 1.3 + vec3(0.04, 0.06, 0.004);
      float dryK = (smoothstep(0.55, 0.85, nz2.b) * 0.7 + step(0.93, cr) * 0.5) * meadow;
      tip = mix(tip, vec3(0.3, 0.26, 0.08) * (0.85 + 0.3 * aRand.z), dryK * 0.75);
      float ao = mix(farR ? 0.72 : 0.42, 1.0, pow(y, 0.7)) * mix(1.0, 0.82, smoothstep(0.6, 1.0, td.g));
      vGCol = mix(col * ao, tip, smoothstep(0.35, 1.0, y) * 0.9);
      if (seed) {
        // straw, rusty or purplish ears on yellowing stems
        float sv = fract(aRand.x * 13.7);
        vec3 ear = sv < 0.5 ? vec3(0.4, 0.33, 0.14) : (sv < 0.8 ? vec3(0.3, 0.18, 0.12) : vec3(0.3, 0.22, 0.26));
        vGCol = mix(mix(col * ao, base * vec3(1.35, 1.15, 0.6) + vec3(0.04, 0.03, 0.0), 0.45 * y), ear * (0.8 + 0.35 * aRand.z), smoothstep(0.62, 0.85, y));
      }
      vGCol *= 1.0 - 0.3 * shade;
      vGCol = mix(base * vec3(1.06, 1.12, 0.88), vGCol, (0.3 + 0.7 * outerK) * (farR ? 0.5 : 1.0)); // = the ground's grass carpet
      vGTip = y;
`;

// ---- flowers: one mesh, the species chosen per clump from the drift field -----------------------
// Species 0 daisy, 1 buttercup, 2 poppy, 3 cornflower, 4 lupine. Every species uses the same vertex
// layout (3 stems, 1 leaf, 3 six-petal heads), so the shapes live in a small float texture (row =
// species) and each clump becomes whichever species' drift it stands in: no instance is wasted on
// a species that does not grow there. Drift values are the same functions as the ground's flower
// wash in terrain.js (daisy r, buttercup g, poppy 1 - r, cornflower 1 - g, lupine (a + b) / 2).
const FLOWER_PARS = /* glsl */ `
uniform highp sampler2D uFlowerGeo;
attribute vec4 aSeed;
void fSpecies(vec4 n, out float k, out float v) {
  vec4 v4 = vec4(n.rg, 1.0 - n.rg);
  float v5 = 0.5 * (n.a + n.b);
  k = 0.0; v = v4.x;
  if (v4.y > v) { k = 1.0; v = v4.y; }
  if (v4.z > v) { k = 2.0; v = v4.z; }
  if (v4.w > v) { k = 3.0; v = v4.w; }
  if (v5 > v) { k = 4.0; v = v5; }
}
`;
const FLOWER_DENS = /* glsl */ `clamp(td.a * 1.6 + 0.9 * meadow * td.g, 0.0, 1.0) * (1.0 - smoothstep(0.1, 0.5, bare)) * (1.0 - 0.7 * shade)`;
// A clump near a drift moves into it: its centre and two per-clump random spots within +-4.5 m are
// tried and the strongest drift wins (a little per-clump jitter makes species borders ragged).
const FLOWER_RELOCATE = /* glsl */ `
  float fStr = 0.0, fK = 0.0;
  if (length(wp - uCenter) < uRing.w + 6.0) {
    vec2 cb = wp - aClump, bc = cb;
    vec2 c1 = cb + (aSeed.xy - 0.5) * 9.0, c2 = cb + (aSeed.zw - 0.5) * 9.0;
    vec4 jit = (aSeed.wzyx - 0.5) * 0.06;
    float k0, v0, k1, v1, k2, v2;
    fSpecies(textureLod(uNoise, cb * 0.0115 + vec2(0.23, 0.57), 0.0) + jit, k0, v0);
    fSpecies(textureLod(uNoise, c1 * 0.0115 + vec2(0.23, 0.57), 0.0) + jit, k1, v1);
    fSpecies(textureLod(uNoise, c2 * 0.0115 + vec2(0.23, 0.57), 0.0) + jit, k2, v2);
    float fv = v0;
    fK = k0;
    if (v1 > fv) { fv = v1; fK = k1; bc = c1; }
    if (v2 > fv) { fv = v2; fK = k2; bc = c2; }
    wp = bc + aClump;
    fStr = smoothstep(0.585, 0.7, fv);
  }`;
const FLOWER_BODY = /* glsl */ `
      vec4 fg = texelFetch(uFlowerGeo, ivec2(gl_VertexID, int(fK + 0.5)), 0);
      vec3 fp = fg.xyz;
      float fPart = fg.w;
      float sc = (0.9 + aRand.y * 0.5) * smoothstep(0.0, 0.1, keep) * (1.0 - 0.35 * smoothstep(uRing.z, uRing.w, dist));
      float ang = aRand.x * 6.28318;
      float c = cos(ang), s = sin(ang);
      vec3 p = fp * sc;
      p.xz = mat2(c, -s, s, c) * p.xz;
      float sway = sin(uTime * 1.6 + wp.x * 0.3 + wp.y * 0.2 + aRand.x * 3.0) * 0.06;
      p.xz += uWindDir * (sway * fp.y * 3.0 * sc);
      vec2 away = wp - uPlayer.xz;
      float pdist = length(away);
      p.xz += (away / max(pdist, 0.001)) * ((1.0 - smoothstep(0.3, 1.5, pdist)) * fp.y * 1.2);
      gPos = vec3(wp.x, gh - 0.01, wp.y) + p;
      objectNormal = normalize(tN + vec3(0.0, 0.6, 0.0));
      vec3 base = textureLod(uColorMap, tuv, 2.5).rgb;
      vec3 petal = vec3(0.93, 0.92, 0.87), centre = vec3(1.0, 0.72, 0.12);
      float v = aRand.z;
      if (fK > 0.5 && fK < 1.5) { petal = vec3(1.0, 0.76, 0.06); centre = vec3(0.95, 0.6, 0.05); }
      else if (fK > 1.5 && fK < 2.5) { petal = v < 0.8 ? vec3(0.82, 0.06, 0.035) : vec3(0.95, 0.36, 0.05); centre = vec3(0.04, 0.03, 0.03); }
      else if (fK > 2.5 && fK < 3.5) { petal = v < 0.7 ? vec3(0.16, 0.3, 0.95) : vec3(0.45, 0.3, 0.92); centre = vec3(0.2, 0.18, 0.5); }
      else if (fK > 3.5) {
        float lv = textureLod(uNoise, wp * 0.03 + vec2(0.7, 0.1), 0.0).a;
        petal = lv < 0.42 ? vec3(0.45, 0.25, 0.86) : (lv < 0.6 ? vec3(0.9, 0.4, 0.66) : vec3(0.9, 0.88, 0.96));
        centre = petal * 0.75;
      }
      petal *= 0.9 + 0.2 * v;
      vGCol = fPart < 0.5 ? base * (0.55 + 0.6 * clamp(fp.y / 0.3, 0.0, 1.0)) : (fPart < 1.999 ? petal * (0.68 + 0.32 * (fPart - 1.0)) : centre);
      vGTip = fPart > 0.5 ? 0.8 : 0.25;
`;

// ---- clutter: 0 rosette weeds, 1 clover, 2 dandelion clocks, 3 pebbles, 4 twigs, 5 leaf litter,
//      6 pine cones, 7 stones --------------------------------------------------------------------
const CLUTTER_EARLY = /* glsl */ `uKind > 4.5 && uKind < 6.5 ? smoothstep(0.08, 0.4, uKind < 5.5 ? textureLod(uCanopy, tuv, 0.0).r : textureLod(uCanopy, tuv, 0.0).g) : 1.0`;
const CLUTTER_DENS = /* glsl */ `
  uKind < 0.5 ? td.g * (0.3 + 0.7 * meadow) * smoothstep(0.35, 0.6, textureLod(uNoise, wp * 0.05, 0.0).g) * (1.0 - smoothstep(0.3, 0.6, bare)) :
  uKind < 1.5 ? td.g * meadow * smoothstep(0.45, 0.65, textureLod(uNoise, wp * 0.08 + 0.3, 0.0).r) * (1.0 - smoothstep(0.2, 0.5, bare)) :
  uKind < 2.5 ? td.a * 0.8 * (1.0 - shade) :
  uKind < 3.5 ? clamp(sp.g * 0.9 + sp.r * 0.5 * step(0.0, gh) + sp.b * 0.7 + (1.0 - td.g) * 0.25 * step(1.2, gh), 0.0, 1.0) * smoothstep(0.75, 0.9, tN.y) :
  uKind < 4.5 ? td.g * (1.0 - meadow) * 0.6 * step(1.6, gh) + shade * 0.3 :
  uKind < 5.5 ? 0.9 * step(0.5, gh) * (1.0 - sp.g) :
  uKind < 6.5 ? 0.6 * step(0.5, gh) :
  (0.12 * meadow * td.g + sp.g * (1.0 - sp.g) * 0.8 + sp.b * 0.25) * step(0.5, gh) * smoothstep(0.7, 0.85, tN.y)
`;
const CLUTTER_BODY = /* glsl */ `
      float sc = (0.65 + aRand.y * 0.75) * smoothstep(0.0, 0.1, keep);
      float ang = aRand.x * 6.28318;
      float c = cos(ang), s = sin(ang);
      vec3 p = position * sc;
      p.xz = mat2(c, -s, s, c) * p.xz;
      if (uKind > 2.5 && uKind < 3.5) p.y -= 0.35 * sc * 0.08;
      if (uKind > 6.5) p.y -= 0.3 * sc * 0.1;
      float sway = uKind > 1.5 && uKind < 2.5 ? sin(uTime * 1.8 + wp.x * 0.4 + wp.y * 0.3) * 0.04 * position.y * 3.0 : 0.0;
      p.xz += uWindDir * sway;
      gPos = vec3(wp.x, gh, wp.y) + p;
      vec3 base = textureLod(uColorMap, tuv, 2.5).rgb;
      vec3 nObj = normal;
      nObj.xz = mat2(c, -s, s, c) * nObj.xz;
      objectNormal = normalize(mix(tN, nObj, 0.5) + vec3(0.0, 0.2, 0.0));
      float t = aPart;
      if (uKind < 0.5) vGCol = base * vec3(0.72, 0.95, 0.62) * (0.55 + 0.6 * t);
      else if (uKind < 1.5) vGCol = base * vec3(0.8, 1.08, 0.8) * (0.6 + 0.55 * t);
      else if (uKind < 2.5) vGCol = t > 0.5 ? vec3(0.9, 0.9, 0.86) * (0.8 + 0.2 * aRand.z) : base * 0.75;
      else if (uKind < 3.5) vGCol = mix(vec3(0.2, 0.18, 0.15), vec3(0.42, 0.39, 0.33), aRand.z) * (0.75 + 0.35 * t);
      else if (uKind < 4.5) vGCol = vec3(0.2, 0.14, 0.085) * (0.75 + 0.4 * aRand.z) * (0.7 + 0.3 * t);
      else if (uKind < 5.5) {
        float h2 = gHash(floor(wp * 9.0) + floor(position.xz * 20.0));
        vGCol = mix(vec3(0.3, 0.17, 0.065), vec3(0.44, 0.34, 0.08), h2) * (0.62 + 0.4 * t);
        if (h2 > 0.86) vGCol = base * 0.9;
      }
      else if (uKind < 6.5) vGCol = vec3(0.16, 0.09, 0.05) * (0.7 + 0.5 * t);
      else {
        vGCol = mix(vec3(0.2, 0.19, 0.17), vec3(0.34, 0.33, 0.3), aRand.z) * (0.7 + 0.35 * t);
        vGCol = mix(vGCol, base * 0.8, smoothstep(0.55, 0.9, nObj.y) * 0.7);
      }
      vGCol *= 1.0 - 0.25 * shade;
      vGTip = uKind > 1.5 && uKind < 2.5 ? 0.9 * t : (uKind > 2.5 ? 0.0 : 0.35 * t);
`;

const GRASS_FRAG_PARS = /* glsl */ `
varying vec3 vGCol;
varying float vGTip;
uniform float uGTransl, uGSheen, uGWrap;
`;
const GRASS_RE = /* glsl */ `
void RE_Direct_Grass(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  reflectedLight.directDiffuse += saturate((nl + uGWrap) / (1.0 + uGWrap)) * directLight.color * BRDF_Lambert(material.diffuseColor);
  float back = pow(saturate(dot(geometryViewDir, -directLight.direction)), 3.0);
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * vec3(1.0, 1.15, 0.55) * (back * vGTip * uGTransl);
  vec3 hv = normalize(directLight.direction + geometryViewDir);
  reflectedLight.directDiffuse += directLight.color * (pow(saturate(dot(geometryNormal, hv)), 18.0) * uGSheen * vGTip);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
`;

// One program per kind family (grass, flowers, clutter); per-mesh values (patch size, ring, shape,
// uKind) live in each clone's own uniforms so the clones still share the compiled program.
function patchMaterial(key, extraPars, body) {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, shared, {
      uData: { value: dataTexture }, uTNrm: { value: normalTexture }, uSplat: { value: splatTexture },
      uColorMap: { value: grassTexture }, uNoise: { value: noiseTexture() }, uCanopy: { value: canopyTexture },
      uGTransl: { value: 0.18 }, uGSheen: { value: 0.045 }, uGWrap: { value: 0.3 },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + PATCH_PARS + extraPars)
      .replace('#include <beginnormal_vertex>', body)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GRASS_FRAG_PARS)
      .replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\n' + GRASS_RE)
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vGCol;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  mat.customProgramCacheKey = () => 'sw-patch2-' + key;
  return mat;
}
const MATS = {};
function variant(key, extraPars, body, u) {
  if (!MATS[key]) MATS[key] = patchMaterial(key, extraPars, body);
  const tpl = MATS[key];
  const mat = tpl.clone();
  const uniforms = {
    uPatch: { value: u.patch }, uRing: { value: new THREE.Vector4(...u.ring) },
    uShape: { value: new THREE.Vector4(...(u.shape || [1, 1, 1, 1])) }, uKind: { value: u.kind || 0 },
  };
  mat.onBeforeCompile = (s, r) => { tpl.onBeforeCompile(s, r); Object.assign(s.uniforms, uniforms); };
  mat.customProgramCacheKey = tpl.customProgramCacheKey;
  return mat;
}

// Instances: clumps on a jittered grid (even coverage, cache-friendly order). aOffset = position
// in the patch, aClump = offset from the clump centre (blades lean outward), aRand = (angle, height,
// width/tint, rank). Rank is shared by a clump so thinning removes whole clumps.
function instanced(base, count, patch, seed, clumpSize, clumpR, clumpSeed = false) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
  const rnd = mulberry32(seed);
  const off = new Float32Array(count * 2), cl = new Float32Array(count * 2), r = new Float32Array(count * 4);
  const cs = clumpSeed ? new Float32Array(count * 4) : null;
  const clumps = Math.max(1, Math.ceil(count / clumpSize));
  const n = Math.ceil(Math.sqrt(clumps)), cell = patch / n;
  let i = 0;
  for (let k = 0; k < n * n && i < count; k++) {
    const cx = ((k % n) + rnd()) * cell, cz = (Math.floor(k / n) + rnd()) * cell;
    const rank = rnd();
    const s4 = cs ? [rnd(), rnd(), rnd(), rnd()] : null;
    for (let j = 0; j < clumpSize && i < count; j++, i++) {
      if (cs) cs.set(s4, i * 4);
      const a = rnd() * Math.PI * 2, d = clumpR * Math.sqrt(rnd());
      const ox = Math.cos(a) * d, oz = Math.sin(a) * d;
      off[i * 2] = (((cx + ox) % patch) + patch) % patch; off[i * 2 + 1] = (((cz + oz) % patch) + patch) % patch;
      cl[i * 2] = ox; cl[i * 2 + 1] = oz;
      r[i * 4] = rnd(); r[i * 4 + 1] = rnd(); r[i * 4 + 2] = rnd(); r[i * 4 + 3] = Math.min(0.999, rank * 0.75 + rnd() * 0.25);
    }
  }
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
  geo.setAttribute('aClump', new THREE.InstancedBufferAttribute(cl, 2));
  geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(r, 4));
  if (cs) geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(cs, 4));
  geo.instanceCount = i;
  return geo;
}

function patchMesh(geo, mat) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.layers.set(LAYERS.GRASS);
  return mesh;
}

function toGeometry(pos, part, idx, nrm) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm || pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  if (part) g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

// ---- Grass --------------------------------------------------------------------------------------
// x in [-1, 1] (scaled by the blade half-width), y in [0, 1] along the blade.
function bladeGeometry(rows) {
  const pos = [], idx = [];
  for (const [y, w] of rows) pos.push(-w, y, 0, w, y, 0);
  pos.push(0, 1, 0);
  const n = rows.length;
  for (let k = 0; k < n - 1; k++) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  idx.push((n - 1) * 2, (n - 1) * 2 + 1, n * 2);
  return toGeometry(pos, null, idx);
}
const BLADE_NEAR = [[0, 1], [0.3, 0.9], [0.58, 0.66], [0.82, 0.36]];
const BLADE_MID = [[0, 1], [0.42, 0.8], [0.76, 0.42]];
const BLADE_FAR = [[0, 1], [0.55, 0.62]];

const grassBody = () => prologue('1.0', GRASS_DENS) + GRASS_BODY + EPILOGUE;
function ring(count, patch, rows, seed, clumpSize, clumpR, ringV, shape) {
  return patchMesh(instanced(bladeGeometry(rows), count, patch, seed, clumpSize, clumpR), variant('grass', '', grassBody(), { patch, ring: ringV, shape }));
}

// count: near blades (inner + mid rings); in seed-grass patches some of them grow tall stems + ears.
// farCount: far ring tufts. clutter: weeds, pebbles, twigs, litter, stones.
// Returns one Mesh (the mid ring) with the other rings + clutter as children: remove it from the
// scene and dispose with grass.traverse((o) => o.geometry?.dispose()).
export function createGrass(count, farCount = 0, clutter = 0) {
  let root;
  if (count >= 70000) {
    root = ring(Math.round(count * 0.6), 66, BLADE_MID, 12, 5, 0.28, [8, 12, 21, 33], [1, 0.022, 1, 1]);
    root.add(ring(Math.round(count * 0.4), 26, BLADE_NEAR, 11, 6, 0.2, [-2, -1, 9, 13], [1, 0.016, 1, 1]));
  } else if (count >= 35000) {
    root = ring(Math.round(count * 0.62), 58, BLADE_MID, 12, 5, 0.3, [7, 11, 18, 29], [1, 0.028, 1, 1]);
    root.add(ring(Math.round(count * 0.38), 22, BLADE_NEAR, 11, 5, 0.22, [-2, -1, 8, 11], [1, 0.02, 1, 1]));
  } else {
    root = ring(Math.max(1000, count), 50, BLADE_MID, 12, 4, 0.3, [-2, -1, 15, 25], [1, 0.034, 1, 1]);
  }
  if (farCount > 0) {
    const hi = count >= 70000;
    root.add(ring(farCount, hi ? 200 : 150, BLADE_FAR, 13, 1, 0, hi ? [19, 30, 80, 98] : [16, 26, 58, 73], [0.9, 0.1, 0.8, 1]));
  }
  if (clutter > 0) for (const m of createClutter(clutter, count >= 35000)) root.add(m);
  return root;
}

// ---- Flowers ------------------------------------------------------------------------------------
// Shape per species, all with the same layout: 3 stem ribbons, 1 leaf, 3 heads of 6 petals (a star
// fan: centre, 6 outer + 6 inner ring vertices). Heads tilt so they read from eye height.
// stems [x1, y1, z1, width] from the root; leaf [y, angle, length, width];
// heads [x, y, z, radius, inner radius, cup (petal tip lift), tilt, tilt direction]
const FLOWER_SPECIES = [
  { // oxeye daisies
    stems: [[0.03, 0.36, 0, 0.005], [-0.035, 0.29, 0.03, 0.005], [0.004, 0.32, -0.04, 0.005]], leaf: [0.05, 0.9, 0.08, 0.018],
    heads: [[0.03, 0.36, 0, 0.048, 0.014, 0.006, 0.42, 0.2], [-0.035, 0.29, 0.03, 0.048, 0.014, 0.006, 0.42, 2.5], [0.004, 0.32, -0.04, 0.048, 0.014, 0.006, 0.42, 4.4]],
  },
  { // buttercups: small cupped heads
    stems: [[0.05, 0.36, 0.012, 0.0045], [-0.04, 0.3, 0.04, 0.0045], [0.006, 0.4, -0.05, 0.0045]], leaf: [0.05, 1.2, 0.07, 0.022],
    heads: [[0.05, 0.36, 0.012, 0.026, 0.02, 0.012, 0.35, 0.2], [-0.04, 0.3, 0.04, 0.026, 0.02, 0.012, 0.35, 2.3], [0.006, 0.4, -0.05, 0.026, 0.02, 0.012, 0.35, 4.6]],
  },
  { // poppies: two open cups and a nodding bud
    stems: [[0.035, 0.46, 0.01, 0.005], [-0.04, 0.37, 0.03, 0.004], [0.012, 0.3, -0.045, 0.0035]], leaf: [0.08, 2.2, 0.08, 0.016],
    heads: [[0.035, 0.46, 0.01, 0.054, 0.042, 0.026, 0.3, 0.3], [-0.04, 0.37, 0.03, 0.047, 0.036, 0.022, 0.4, 2.6], [0.014, 0.29, -0.05, 0.015, 0.013, 0.016, 1.3, 4.7]],
  },
  { // cornflowers: ragged blue heads on wiry stems
    stems: [[-0.01, 0.42, 0.01, 0.004], [0.04, 0.35, 0.03, 0.004], [-0.03, 0.31, -0.035, 0.004]], leaf: [0.1, 0.9, 0.07, 0.008],
    heads: [[-0.01, 0.42, 0.01, 0.033, 0.011, 0.009, 0.38, 1.0], [0.04, 0.35, 0.03, 0.033, 0.011, 0.009, 0.38, 0.3], [-0.03, 0.31, -0.035, 0.033, 0.011, 0.009, 0.38, 3.9]],
  },
  { // lupines: a tapering spike of three dense, drooping whorls; two basal leaf stalks
    stems: [[0, 0.68, 0, 0.007], [0.07, 0.12, 0.02, 0.012], [-0.05, 0.1, -0.05, 0.012]], leaf: [0.1, 2.4, 0.09, 0.013],
    heads: [[0, 0.47, 0, 0.034, 0.027, -0.05, 0, 0], [0, 0.55, 0, 0.028, 0.022, -0.044, 0, 0.5], [0, 0.625, 0, 0.02, 0.016, -0.036, 0, 1.0]],
  },
];
const FLOWER_VERTS = 3 * 4 + 4 + 3 * 13;
let flowerShapes = null;
function buildFlowerShapes() {
  const data = new Float32Array(FLOWER_VERTS * FLOWER_SPECIES.length * 4);
  let index = null;
  FLOWER_SPECIES.forEach((sp, row) => {
    const pos = [], idx = [];
    const add = (x, y, z, p) => { pos.push(x, y, z, p); return pos.length / 4 - 1; };
    for (const [x1, y1, z1, w] of sp.stems) {
      const dx = 0.7071 * w, dz = 0.7071 * w;
      const a = add(-dx, 0, -dz, 0), b = add(dx, 0, dz, 0), c = add(x1 - dx * 0.7, y1, z1 - dz * 0.7, 0), d = add(x1 + dx * 0.7, y1, z1 + dz * 0.7, 0);
      idx.push(a, b, c, c, b, d);
    }
    {
      const [y, ang, len, wid] = sp.leaf, ca = Math.cos(ang), sa = Math.sin(ang);
      const a = add(0, y, 0, 0), t = add(ca * len, y + len * 0.35, sa * len, 0);
      const l = add(ca * len * 0.45 - sa * wid, y + len * 0.2, sa * len * 0.45 + ca * wid, 0), r = add(ca * len * 0.45 + sa * wid, y + len * 0.2, sa * len * 0.45 - ca * wid, 0);
      idx.push(a, l, t, a, t, r);
    }
    for (const [cx, cy, cz, r, rIn, cup, tilt, dir] of sp.heads) {
      const ct = Math.cos(tilt), st = Math.sin(tilt), cd = Math.cos(dir), sd = Math.sin(dir);
      const P = (u, h, v, p) => {
        const al = u * cd + v * sd, pe = -u * sd + v * cd;
        const a2 = al * ct - h * st, h2 = al * st + h * ct;
        return add(cx + a2 * cd - pe * sd, cy + h2, cz + a2 * sd + pe * cd, p);
      };
      const c0 = P(0, 0.004, 0, 2), ring = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + dir, outer = i % 2 === 0;
        ring.push(P(Math.cos(a) * (outer ? r : rIn), outer ? cup : cup * 0.3, Math.sin(a) * (outer ? r : rIn), outer ? 1.95 : 1.2));
      }
      for (let i = 0; i < 12; i++) idx.push(c0, ring[i], ring[(i + 1) % 12]);
    }
    if (pos.length / 4 !== FLOWER_VERTS) throw new Error('flower layout');
    if (!index) index = idx;
    data.set(pos, row * FLOWER_VERTS * 4);
  });
  const tex = new THREE.DataTexture(data, FLOWER_VERTS, FLOWER_SPECIES.length, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return { tex, index };
}

// One draw for every wildflower: clumps of plants on a patch (~45 m) that follows the player; a
// few clumps stay outside the drifts (EARLY floor), the rest gather into them.
export function createFlowers(count, patch = 42) {
  if (!flowerShapes) flowerShapes = buildFlowerShapes();
  const body = prologue('clamp(fStr * 1.6, 0.05, 1.0)', FLOWER_DENS, FLOWER_RELOCATE) + FLOWER_BODY + EPILOGUE;
  const mat = variant('flowers', FLOWER_PARS, body, { patch, ring: [-2, -1, patch * 0.32, patch * 0.46] });
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { inner(sh, r); sh.uniforms.uFlowerGeo = { value: flowerShapes.tex }; };
  // (positions come from the shape texture; the position attribute only sizes the draw)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(FLOWER_VERTS * 3), 3));
  geo.setIndex(flowerShapes.index);
  return patchMesh(instanced(geo, Math.max(1, count), patch, 23, 8, 0.85, true), mat);
}

// ---- Ground clutter -----------------------------------------------------------------------------
function clutterGeometry(kind) {
  const pos = [], nrm = [], part = [], idx = [];
  const add = (x, y, z, t, n = [0, 1, 0]) => { pos.push(x, y, z); nrm.push(...n); part.push(t); return pos.length / 3 - 1; };
  if (kind === 0) {
    // rosette weed: 7 leaves lying flat, tips curling up
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2, L = 0.13 + (k % 3) * 0.025, w = 0.028;
      const ca = Math.cos(a), sa = Math.sin(a);
      const b = add(0, 0.006, 0, 0), l = add(ca * L * 0.45 - sa * w, 0.014, sa * L * 0.45 + ca * w, 0.5);
      const t = add(ca * L, 0.035, sa * L, 1), r = add(ca * L * 0.45 + sa * w, 0.014, sa * L * 0.45 - ca * w, 0.5);
      idx.push(b, l, t, b, t, r);
    }
  } else if (kind === 1) {
    // clover: short stem, three round leaflets
    const h = 0.07;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const a = add(-0.004 * dx, 0, -0.004 * dz, 0), b = add(0.004 * dx, 0, 0.004 * dz, 0);
      const c = add(-0.003 * dx, h, -0.003 * dz, 0.3), d = add(0.003 * dx, h, 0.003 * dz, 0.3);
      idx.push(a, b, c, c, b, d);
    }
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const c = add(0, h, 0, 0.4);
      const ringV = [];
      for (let j = 0; j < 5; j++) {
        const b = a + (j / 4 - 0.5) * 1.6, r = 0.03 * (j === 0 || j === 4 ? 0.6 : 1);
        ringV.push(add(ca * 0.012 + Math.cos(b) * r, h + 0.004 + 0.006 * Math.sin((j / 4) * Math.PI), sa * 0.012 + Math.sin(b) * r, 1));
      }
      for (let j = 0; j < 4; j++) idx.push(c, ringV[j], ringV[j + 1]);
    }
  } else if (kind === 2) {
    // dandelion clock: stem + fluffy sphere
    const h = 0.3;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const a = add(-0.004 * dx, 0, -0.004 * dz, 0), b = add(0.004 * dx, 0, 0.004 * dz, 0);
      const c = add(-0.003 * dx, h, -0.003 * dz, 0.2), d = add(0.003 * dx, h, 0.003 * dz, 0.2);
      idx.push(a, b, c, c, b, d);
    }
    let ico = new THREE.IcosahedronGeometry(0.038, 0);
    ico.deleteAttribute('uv'); ico.deleteAttribute('normal');
    ico = mergeVertices(ico);
    const p = ico.attributes.position;
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i); const n = v.clone().normalize(); add(v.x, v.y + h + 0.03, v.z, 1, [n.x, n.y, n.z]); }
    for (let i = 0; i < ico.index.count; i++) idx.push(base + ico.index.array[i]);
  } else if (kind === 3 || kind === 6) {
    // pebble: squashed, jittered octahedron / pine cone: tall, brown
    const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const j = [1.1, 0.9, 1, 1, 0.8, 1.2];
    const base = pos.length / 3;
    const sx = kind === 6 ? 0.03 : 0.07, sy = kind === 6 ? 0.03 : 0.035, sz = kind === 6 ? 0.055 : 0.06;
    v.forEach(([x, y, z], i) => add(x * sx * j[i], y * sy + (kind === 6 ? 0.028 : 0.012), z * sz * j[(i + 2) % 6], y > 0 ? 1 : 0.4, [x, y + 0.3, z]));
    for (const [a, b, c] of [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]) idx.push(base + a, base + b, base + c);
  } else if (kind === 4) {
    // twig: thin triangular prism with a side stub
    const L = 0.36, r = 0.009;
    const seg = (x0, z0, x1, z1, y0) => {
      const base = pos.length / 3;
      for (const [x, z, t] of [[x0, z0, 0], [x1, z1, 1]]) for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2, dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
        const px = -dz / l, pz = dx / l;
        add(x + px * Math.cos(a) * r, y0 + r + Math.sin(a) * r, z + pz * Math.cos(a) * r, t, [px * Math.cos(a), Math.sin(a), pz * Math.cos(a)]);
      }
      for (let k = 0; k < 3; k++) { const a = base + k, b = base + (k + 1) % 3; idx.push(a, b, a + 3, b, b + 3, a + 3); }
    };
    seg(-L / 2, 0, L / 2, 0.02, 0);
    seg(0.02, 0.004, 0.12, 0.08, 0.004);
  } else if (kind === 5) {
    // fallen leaves: four small curled ovals scattered over ~30 cm
    const spots = [[0, 0, 0.3], [0.11, 0.06, 2.1], [-0.09, 0.08, 4.0], [0.04, -0.11, 5.3]];
    for (const [x, z, a] of spots) {
      const ca = Math.cos(a), sa = Math.sin(a), L = 0.07, w = 0.028;
      const b = add(x, 0.004, z, 0), t = add(x + ca * L, 0.012, z + sa * L, 1);
      const l = add(x + ca * L * 0.5 - sa * w, 0.009, z + sa * L * 0.5 + ca * w, 0.6), r = add(x + ca * L * 0.5 + sa * w, 0.006, z + sa * L * 0.5 - ca * w, 0.6);
      idx.push(b, l, t, b, t, r);
    }
  } else {
    // stone: squashed, jittered icosahedron; mossy on top (by normal in the shader)
    let g = new THREE.IcosahedronGeometry(1, 0);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g);
    const p = g.attributes.position;
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const k = 0.85 + 0.3 * (Math.sin(i * 12.9898) * 0.5 + 0.5);
      const q = new THREE.Vector3(v.x * 0.16 * k, v.y * 0.09 * k + 0.03, v.z * 0.13 * k);
      add(q.x, q.y, q.z, v.y > 0 ? 1 : 0.35, [v.x, v.y, v.z]);
    }
    for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.array[i]);
  }
  return toGeometry(pos, part, idx, nrm);
}

// share of the clutter budget, clump size, clump radius
const CLUTTER_MIX = [[0.2, 2, 0.6], [0.14, 4, 0.25], [0.08, 2, 0.6], [0.16, 2, 0.6], [0.08, 2, 0.6], [0.2, 3, 0.7], [0.05, 2, 0.5], [0.09, 2, 0.8]];
// full: all kinds (medium/high); otherwise the low preset keeps weeds, clover, clocks, pebbles, twigs
function createClutter(total, full) {
  const body = prologue(CLUTTER_EARLY, CLUTTER_DENS) + CLUTTER_BODY + EPILOGUE;
  const patch = 56;
  return (full ? CLUTTER_MIX : CLUTTER_MIX.slice(0, 5)).map(([share, clump, cr], kind) =>
    patchMesh(instanced(clutterGeometry(kind), Math.max(1, Math.round(total * share)), patch, 40 + kind, clump, cr),
      variant('clutter', 'attribute float aPart;\n', body, { patch, ring: [-2, -1, 20, 27], kind })));
}

export function updatePatches(time, player, env) {
  shared.uTime.value = time;
  shared.uCenter.value.set(player.x, player.z);
  shared.uPlayer.value.copy(player);
  shared.uSunDir.value.copy(env.sunDir);
  shared.uSunCol.value.copy(env.sunColor);
  updateFoliage(player);
}
