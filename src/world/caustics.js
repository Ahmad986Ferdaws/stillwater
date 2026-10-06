import * as THREE from 'three';
import { WATER } from './terrain.js';
import { waterTextures, CAUSTIC_RANGE } from './waterTextures.js';

// Underwater lighting for any lit built-in material (Standard / Lambert / Phong / Toon):
//  - dancing caustics: two scrolling layers of a photon-traced caustic texture, projected along the
//    refracted sun ray, modulating only the DIRECT sun light (so shadows still hide them), with a faint
//    rainbow fringe, fading in from the waterline and softening/fading with depth
//  - lake-bed detail: cool sand with ripple marks, pebble patches with rounded stones, silt and weed in
//    the deep (colour + bumped normal), only below the water line
//  - (quality 0 only) a depth tint, because the cheap lake shader is alpha-blended over the bed
//  - spray-wet rock around the waterfall (uWetA/uWetB, set by the water module): darker, glossy,
//    with trickles running down it and algae near the bottom; position-gated, so it is safe to
//    apply to shared materials (the falls' rocks use the same material as the dock)
//
// addCaustics(material) wraps whatever onBeforeCompile the material already has (it runs first), and
// keeps working if someone assigns a new onBeforeCompile / customProgramCacheKey later.

// Textures are generated on first use (addCaustics / createWater), not at import.
export const causticsUniforms = {
  uCausticsTex: { value: null },
  uCausticsNoise: { value: null },
  uCausticsTime: { value: 0 },
  uCausticsSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2).normalize() },
  uCausticsStrength: { value: 0.85 }, // 0 = off
  uBedDetail: { value: 1 }, // 0 = leave the terrain's own lake-bed colours untouched
  uUnderwaterTint: { value: 0 }, // set to 1 by the water module at quality 0
  uCausticsAbsorb: { value: new THREE.Vector3(0.46, 0.13, 0.1) },
  uWaterLevel: { value: WATER },
  uWetA: { value: new THREE.Vector4(0, 0, 4, 0) }, // falls x, lip z, half width, lip y
  uWetB: { value: new THREE.Vector4(0, 0, 0, 0) }, // impact z, impact y, lake entry z, strength (0 = off)
};

const VERT_DECL = /* glsl */ `
varying vec3 vCausticsWorld;
`;

const VERT_BODY = /* glsl */ `
  {
    vec4 cwPos = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      cwPos = batchingMatrix * cwPos;
    #endif
    #ifdef USE_INSTANCING
      cwPos = instanceMatrix * cwPos;
    #endif
    vCausticsWorld = ( modelMatrix * cwPos ).xyz;
  }
`;

const FRAG_DECL = /* glsl */ `
varying vec3 vCausticsWorld;
uniform sampler2D uCausticsTex;
uniform sampler2D uCausticsNoise;
uniform float uCausticsTime;
uniform vec3 uCausticsSunDir;
uniform float uCausticsStrength;
uniform float uBedDetail;
uniform float uUnderwaterTint;
uniform vec3 uCausticsAbsorb;
uniform float uWaterLevel;
uniform vec4 uWetA;
uniform vec4 uWetB;

vec3 cwCaustics( vec3 wp, float depth ) {
  // Where did the sunlight reaching this point cross the surface? Follow the refracted sun ray up.
  vec3 T = refract( -uCausticsSunDir, vec3( 0.0, 1.0, 0.0 ), 0.75 );
  vec2 e = wp.xz - T.xz * ( depth / max( -T.y, 0.25 ) );
  float lod = clamp( depth * 0.32 - 0.2, 0.0, 3.0 );
  vec2 uv1 = e * 0.29 + vec2( 0.021, 0.013 ) * uCausticsTime;
  vec2 uv2 = mat2( 0.62, 0.78, -0.78, 0.62 ) * e * 0.34 - vec2( 0.016, -0.019 ) * uCausticsTime + 0.37;
  vec3 a = textureLod( uCausticsTex, uv1, lod ).rgb;
  vec3 b = textureLod( uCausticsTex, uv2, lod ).rgb;
  return min( a * a, b * b ) * ${CAUSTIC_RANGE.toFixed(1)};
}

// Nearest-stone Voronoi: xy = offset to the stone centre, z = cell hash, w = distance to the cell edge.
vec4 cwVoronoi( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 best = vec2( 1.0 );
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 g = vec2( float( x ), float( y ) );
      vec2 c = i + g;
      vec2 h = fract( sin( vec2( dot( c, vec2( 127.1, 311.7 ) ), dot( c, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
      vec2 r = g + 0.15 + h * 0.7 - f;
      float d = dot( r, r );
      if ( d < d1 ) { d2 = d1; d1 = d; best = r; id = h.x; }
      else if ( d < d2 ) { d2 = d; }
    }
  }
  return vec4( best, id, sqrt( d2 ) - sqrt( d1 ) );
}
`;

// Before lighting: recolour the bed and prepare a bump slope (world xz).
const FRAG_BED = /* glsl */ `
  float cwDepth = uWaterLevel - vCausticsWorld.y;
  float cwBed = 0.0;
  float cwBump = 0.0;
  float cwWet = 0.0, cwFilm = 0.0;
  vec2 cwSlope = vec2( 0.0 );
  // spray-wet rock around the waterfall
  if ( uWetB.w > 0.0 ) {
    vec3 wq = vCausticsWorld;
    float wx = abs( wq.x - uWetA.x );
    if ( wx < uWetA.z + 10.0 && wq.z > uWetA.y - 3.0 && wq.z < uWetB.z + 2.0 && wq.y > uWaterLevel - 0.05 && wq.y < uWetA.w + 1.0 ) {
      float behind = ( 1.0 - smoothstep( uWetA.z * 0.6, uWetA.z * 0.6 + 3.5, wx ) ) * smoothstep( uWetA.y - 1.5, uWetA.y + 0.5, wq.z );
      float splash = 1.0 - smoothstep( 3.0, 12.0, length( vec2( wx * 0.8, wq.z - uWetB.x ) ) + max( wq.y - uWetB.y, 0.0 ) * 0.45 );
      float wet = max( behind, splash ) * uWetB.w;
      if ( wet > 0.002 ) {
        float trickle = textureLod( uCausticsNoise, vec2( wq.x * 0.9, wq.y * 0.12 + uCausticsTime * 0.45 ), 1.0 ).a;
        float film = smoothstep( 0.35, 0.75, trickle );
        diffuseColor.rgb *= mix( 1.0, 0.42 - 0.1 * film, wet );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.035, 0.07, 0.03 ), wet * 0.3 * ( 1.0 - smoothstep( uWetB.y, uWetB.y + 3.5, wq.y ) ) );
        #ifdef STANDARD
        roughnessFactor = mix( roughnessFactor, mix( 0.34, 0.1, film ), wet );
        #endif
        cwSlope += vec2( ( trickle - 0.5 ) * 0.45, 0.0 );
        cwBump = wet;
        cwWet = wet;
        cwFilm = film;
      }
    }
  }
  vec2 cwDx = dFdx( vCausticsWorld.xz ), cwDy = dFdy( vCausticsWorld.xz ); // outside the branch (waterline)
  if ( cwDepth > 0.0 && uBedDetail > 0.0 ) {
    cwBed = smoothstep( 0.02, 0.45, cwDepth ) * uBedDetail;
    vec2 bp = vCausticsWorld.xz;
    vec4 nz = textureGrad( uCausticsNoise, bp * 0.021, cwDx * 0.021, cwDy * 0.021 );
    vec4 nz2 = textureGrad( uCausticsNoise, bp * 0.13, cwDx * 0.13, cwDy * 0.13 );
    // sand ripple marks in the shallows
    float sAmt = ( 1.0 - smoothstep( 1.2, 3.8, cwDepth ) ) * smoothstep( 0.3, 0.55, nz.g );
    float ph = dot( bp, vec2( 0.83, 0.55 ) ) * 5.4 + nz2.a * 5.0 + nz.b * 7.0;
    cwSlope += vec2( 0.83, 0.55 ) * cos( ph ) * 0.3 * sAmt;
    // pebble patches with rounded stones
    float patchK = smoothstep( 0.46, 0.66, nz.b * 0.8 + nz2.g * 0.45 ) * ( 1.0 - smoothstep( 4.0, 7.0, cwDepth ) );
    vec4 vor = cwVoronoi( bp * 3.3 );
    float stone = smoothstep( 0.05, 0.15, vor.w ) * patchK;
    float big = step( 0.8, nz2.a );
    stone = max( stone, smoothstep( 0.1, 0.22, cwVoronoi( bp * 0.9 + 17.0 ).w ) * big * patchK );
    cwSlope += vor.xy * 1.1 * stone;
    vec3 stoneC = vec3( 0.43, 0.42, 0.39 );
    stoneC = mix( stoneC, vec3( 0.52, 0.43, 0.32 ), step( 0.55, vor.z ) );
    stoneC = mix( stoneC, vec3( 0.34, 0.39, 0.40 ), step( 0.8, vor.z ) );
    stoneC = mix( stoneC, vec3( 0.28, 0.35, 0.19 ), step( 0.3, vor.z ) * ( 1.0 - step( 0.42, vor.z ) ) );
    stoneC *= 0.8 + 0.4 * fract( vor.z * 17.13 );
    vec3 sandC = vec3( 0.62, 0.56, 0.42 ) * ( 0.88 + 0.24 * nz2.a );
    vec3 siltC = vec3( 0.26, 0.29, 0.19 ) * ( 0.85 + 0.3 * nz.b );
    vec3 bedC = mix( sandC, siltC, smoothstep( 2.5, 6.5, cwDepth + ( nz.g - 0.5 ) * 3.0 ) );
    float weed = smoothstep( 0.62, 0.8, nz.b ) * smoothstep( 1.0, 2.6, cwDepth ) * ( 1.0 - patchK );
    bedC = mix( bedC, vec3( 0.14, 0.28, 0.09 ) * ( 0.8 + 0.4 * nz2.a ), weed * 0.75 );
    bedC *= 1.0 - 0.3 * patchK * ( 1.0 - stone ) * ( 1.0 - smoothstep( 0.0, 0.12, vor.w ) );
    bedC = mix( bedC, stoneC, stone );
    diffuseColor.rgb = mix( diffuseColor.rgb, bedC, cwBed * 0.85 );
    cwBump = max( cwBump, cwBed );
  }
`;

// After the base normal: bump the bed.
const FRAG_NORMAL = /* glsl */ `
  if ( cwBump > 0.0 ) {
    vec3 cwN = ( viewMatrix * vec4( -cwSlope.x, 0.0, -cwSlope.y, 0.0 ) ).xyz;
    normal = normalize( normal + cwN * cwBump );
  }
`;

// After direct + indirect light: caustics on the direct sun light, optional depth tint.
const FRAG_LIGHT = /* glsl */ `
  if ( cwDepth > 0.0 ) {
    float ck = uCausticsStrength * smoothstep( 0.03, 0.7, cwDepth ) * ( 1.0 - 0.75 * smoothstep( 4.0, 12.0, cwDepth ) )
      * smoothstep( 0.02, 0.2, uCausticsSunDir.y );
    if ( ck > 0.0 ) {
      vec3 cc = cwCaustics( vCausticsWorld, cwDepth );
      reflectedLight.directDiffuse *= mix( vec3( 1.0 ), 0.5 + cc * 0.85, ck );
    }
    vec3 cwTint = mix( vec3( 1.0 ), exp( -uCausticsAbsorb * cwDepth * 1.6 ), uUnderwaterTint * smoothstep( 0.0, 0.3, cwDepth ) );
    reflectedLight.directDiffuse *= cwTint;
    reflectedLight.indirectDiffuse *= cwTint;
  }
  if ( cwWet > 0.0 ) {
    // wet rock glistens even in shade: a Fresnel sheen of the sky and glints running down the film
    vec3 cwSky = vec3( 0.45, 0.6, 0.8 );
    #if NUM_HEMI_LIGHTS > 0
      cwSky = hemisphereLights[ 0 ].skyColor;
    #endif
    float cwFres = pow( 1.0 - clamp( dot( normal, geometryViewDir ), 0.0, 1.0 ), 4.0 );
    vec2 cwG = vec2( vCausticsWorld.x * 16.0 + vCausticsWorld.z * 11.0, vCausticsWorld.y * 16.0 + uCausticsTime * 6.0 );
    float cwH = fract( sin( dot( floor( cwG ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float cwGlint = step( 0.975, cwH ) * ( 1.0 - smoothstep( 0.08, 0.3, length( fract( cwG ) - 0.5 ) ) ) * cwFilm
      * ( 1.0 - smoothstep( 20.0, 45.0, length( vViewPosition ) ) );
    reflectedLight.indirectSpecular += cwSky * cwWet * ( ( 0.05 + 0.45 * cwFres ) * ( 0.35 + 0.65 * cwFilm ) + cwGlint * 1.6 );
  }
`;

// Fallback if the lighting chunks were replaced: add caustic light on top of the final colour.
const FRAG_LIGHT_FALLBACK = /* glsl */ `
  if ( cwDepth > 0.0 ) {
    float ck = uCausticsStrength * smoothstep( 0.03, 0.7, cwDepth ) * ( 1.0 - 0.75 * smoothstep( 4.0, 12.0, cwDepth ) )
      * smoothstep( 0.02, 0.2, uCausticsSunDir.y );
    vec3 cc = cwCaustics( vCausticsWorld, cwDepth );
    outgoingLight *= mix( vec3( 1.0 ), 0.7 + cc * 0.6, ck );
  }
`;

const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn('[caustics] ' + msg);
}

function insertAfter(src, anchors, code) {
  for (const a of anchors) {
    const i = src.indexOf(a);
    if (i >= 0) return src.slice(0, i + a.length) + '\n' + code + src.slice(i + a.length);
  }
  return null;
}
function insertBefore(src, anchors, code) {
  for (const a of anchors) {
    const i = src.indexOf(a);
    if (i >= 0) return src.slice(0, i) + code + '\n' + src.slice(i);
  }
  return null;
}

function inject(shader) {
  if (shader.fragmentShader.includes('vCausticsWorld')) return; // already patched
  const vs = insertAfter(shader.vertexShader, ['#include <project_vertex>', '#include <worldpos_vertex>'], VERT_BODY);
  if (!vs) { warnOnce('no vertex anchor found; caustics skipped'); return; }
  let fs = shader.fragmentShader;
  // The bed code declares cwDepth/cwBed/cwSlope; everything below must come after it.
  const bedAnchors = ['#include <normal_fragment_begin>', '#include <emissivemap_fragment>', '#include <lights_physical_fragment>', '#include <lights_lambert_fragment>'];
  const usedBed = bedAnchors.find((a) => fs.includes(a));
  if (!usedBed) { warnOnce('no fragment anchor for the lake bed; caustics skipped'); return; }
  fs = insertBefore(fs, [usedBed], FRAG_BED);
  if (usedBed === bedAnchors[0]) fs = insertAfter(fs, ['#include <normal_fragment_maps>'], FRAG_NORMAL) || fs;
  const lit = insertAfter(fs, ['#include <lights_fragment_end>'], FRAG_LIGHT);
  if (lit) fs = lit;
  else {
    const fb = insertBefore(fs, ['#include <opaque_fragment>', '#include <output_fragment>'], FRAG_LIGHT_FALLBACK);
    if (fb) { fs = fb; warnOnce('lights_fragment_end not found; using additive fallback'); } else warnOnce('no light anchor; caustics skipped');
  }
  Object.assign(shader.uniforms, causticsUniforms);
  shader.vertexShader = VERT_DECL + vs;
  shader.fragmentShader = FRAG_DECL + fs;
}

const patched = new WeakSet();
const baseCompile = THREE.Material.prototype.onBeforeCompile;

export function addCaustics(material) {
  if (!material || patched.has(material)) return material;
  patched.add(material);
  const tex = waterTextures();
  causticsUniforms.uCausticsTex.value = tex.caustics;
  causticsUniforms.uCausticsNoise.value = tex.foam;
  let inner = material.onBeforeCompile;
  let innerKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  let busy = false, busyKey = false; // someone may wrap *our* wrapper and assign it back: don't recurse
  function wrapped(shader, renderer) {
    if (busy) return;
    busy = true;
    try { if (inner && inner !== baseCompile && inner !== wrapped) inner.call(material, shader, renderer); } finally { busy = false; }
    inject(shader);
  }
  function key() {
    if (busyKey) return '';
    busyKey = true;
    let k = '';
    try { k = innerKey && innerKey !== key ? String(innerKey.call(material)) : inner && inner !== baseCompile && inner !== wrapped ? inner.toString() : ''; } finally { busyKey = false; }
    return k + '|caustics2';
  }
  Object.defineProperty(material, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get: () => wrapped,
    set: (fn) => { inner = fn; material.needsUpdate = true; },
  });
  Object.defineProperty(material, 'customProgramCacheKey', {
    configurable: true,
    enumerable: true,
    get: () => key,
    set: (fn) => { innerKey = fn; material.needsUpdate = true; },
  });
  material.needsUpdate = true;
  return material;
}

export function updateCaustics(time, env) {
  const u = causticsUniforms;
  u.uCausticsTime.value = time;
  if (env) u.uCausticsSunDir.value.copy(env.sunDir);
}
