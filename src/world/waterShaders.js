// GLSL for the lake surface, waterfall and mist. Compiled by three as GLSL ES 3.00.
// The lake shader has three variants (define WATER_Q):
//   0  cheap single pass, alpha-blended over the lake bed (roughly the original look, richer normals)
//   1  opaque; refraction pre-pass + depth: Beer–Lambert absorption, in-scattering, intersection foam
//   2  as 1 + planar reflection (falls back to an analytic sky where the mirror has no data)
// Cost notes: the lake mesh follows the terrain triangulation, so the exact water depth, a smooth
// shore-distance field, wind gusts and the long swells are all per-vertex; the fragment shader keeps
// only the ripple layers, foam, rings and the refraction/reflection lookups.

export const RINGS = 10; // ripple-ring slots (swimmer wake, fish rises, splashes)

const SWELL = /* glsl */ `
vec2 swell(vec2 p) {
  vec2 d1 = uWind;
  vec2 d2 = vec2(0.8 * uWind.x - 0.6 * uWind.y, 0.6 * uWind.x + 0.8 * uWind.y);
  vec2 d3 = vec2(0.8 * uWind.x + 0.6 * uWind.y, -0.6 * uWind.x + 0.8 * uWind.y);
  return d1 * cos(dot(p, d1) * 0.27 - uTime * 1.2) * 0.011
       + d2 * cos(dot(p, d2) * 0.43 - uTime * 1.5 + 1.3) * 0.008
       + d3 * cos(dot(p, d3) * 0.61 - uTime * 1.8 + 4.1) * 0.006;
}`;

export const lakeVert = /* glsl */ `
attribute float aDepth;   // water depth at this vertex (terrain below the surface; negative on land)
attribute float aShore;   // distance to the nearest shoreline in metres
uniform float uTime;
uniform vec2 uWind;
uniform sampler2D uFoamTex;
varying vec3 vWorld;
varying vec4 vClip;
varying float vViewZ;
varying float vDepth;
varying float vShore;
varying float vGust;
varying vec2 vSwell;
#include <fog_pars_vertex>
${SWELL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vDepth = aDepth;
  vShore = aShore;
  vec2 p = wp.xz;
  // wind gusts ("cat's paws"): slow patches of rougher water drifting downwind
  vec2 side = vec2(-uWind.y, uWind.x);
  float gA = textureLod(uFoamTex, p * 0.0105 - uWind * uTime * 0.02, 3.0).b;
  float gB = textureLod(uFoamTex, p * 0.023 - (uWind * 0.6 + side * 0.4) * uTime * 0.03 + 0.37, 3.0).g;
  vGust = smoothstep(0.55, 0.78, gA * 0.72 + gB * 0.42 - 0.07);
  vSwell = swell(p);
  vec4 mvPosition = viewMatrix * wp;
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  vClip = gl_Position;
  #include <fog_vertex>
}`;

export const lakeFrag = /* glsl */ `
#define W_PI 3.14159265

uniform float uTime;
uniform float uRipple;
uniform float uDetail;      // ripple normal strength
uniform float uSpecular;    // broad sun highlight
uniform float uGlint;       // crisp sparkles
uniform float uReflBoost;   // extra reflectance (raised a little at golden hour)
uniform float uRefrAmt;     // refraction wobble (1 = ~4x physical, reads well)
uniform float uReflDistort; // screen-space mirror distortion per unit slope
uniform float uDownPath;    // extra absorption path for light going down to the bed (x depth)
uniform float uFoamAmt;
uniform vec3 uSunDir;
uniform vec3 uSunCol;       // sun colour * intensity / PI (env.sunColor)
uniform vec3 uAmbient;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunRaw;       // raw sun colour of the sky dome
uniform vec3 uPlayer;
uniform vec3 uAbsorb;       // extinction per metre (red dies first)
uniform vec3 uDeepCol;      // in-scatter albedo of deep water
uniform vec3 uShallowCol;   // in-scatter albedo of shallow water
uniform vec3 uShoreCol;     // albedo of the far shore faked into sky-only reflections
uniform vec2 uWind;
uniform vec4 uFalls;        // plunge pool centre x, z, radius, strength
uniform vec2 uFallsShape;   // x stretch of the pool (the cascade is wide), -
uniform vec4 uRings[RINGS]; // x, z, birth time, strength (only the first uRingCount are live)
uniform int uRingCount;
uniform vec4 uWake[WAKE];   // boat wake: x, z, birth time, strength (>0 ring from the bow, <0 stern wash)
uniform int uWakeCount;
uniform vec4 uWakeBox;      // xmin, zmin, xmax, zmax of everything the wake touches
uniform vec4 uBoat;         // x, z, heading (unit)
uniform vec4 uBoatK;        // speed m/s, strength (0 = no boat), half length, half width
uniform vec4 uHull;         // rowboat x, z, heading (unit): its inside stays dry
uniform vec4 uHullK;        // half length, half beam, active
uniform sampler2D uRippleTex;
uniform sampler2D uFoamTex;
#if WATER_Q >= 1
uniform sampler2D uRefrTex;
uniform sampler2D uDepthTex;
uniform vec4 uRefrRow;      // 3rd row of the refraction projection (oblique near plane)
uniform vec2 uProjXY;       // projection[0][0], projection[1][1]
#endif
#if WATER_Q >= 2
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
#endif

varying vec3 vWorld;
varying vec4 vClip;
varying float vViewZ;
varying float vDepth;
varying float vShore;
varying float vGust;
varying vec2 vSwell;
#include <fog_pars_fragment>

const mat2 ROT2 = mat2(0.3907, 0.9205, -0.9205, 0.3907);
const mat2 ROT3 = mat2(0.7547, -0.6561, 0.6561, 0.7547);

// One scrolling ripple layer: world-space slope (xy) and the slope variance hidden in its mips (z).
vec3 rippleLayer(vec2 p, mat2 R, float tileM, vec2 vel, float amp) {
  vec4 t = texture(uRippleTex, (R * (p - vel * uTime)) / tileM);
  vec2 s = t.xy * 8.0 - 4.0;
  return vec3((s * R) * amp, max(t.z * 24.0 - dot(s, s), 0.0) * amp * amp);
}

// Expanding ring packets: slope (xy) and a little fresh foam (z).
vec3 ringField(vec2 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < uRingCount; i++) { // uniform bound: keeps the compiler from unrolling it
    vec4 r = uRings[i];
    float age = uTime - r.z;
    vec2 d = p - r.xy;
    float dist = length(d);
    float x = dist - (0.1 + age * 0.9);
    float wdt = 0.3 + age * 0.3;
    if (abs(x) > wdt * 2.6) continue;
    float env = exp(-x * x / (wdt * wdt)) * exp(-age * 0.8) * r.w;
    acc.xy += d / max(dist, 0.001) * cos(x * 10.0 + age * 1.5) * env * 0.16;
    acc.z += env * (1.0 - smoothstep(0.0, 0.7, age));
  }
  return acc;
}

// Boat wake: rings pushed out by the bow (their envelope forms the V) and churned water at the stern.
vec3 wakeField(vec2 p) {
  vec3 acc = vec3(0.0);
  if (uWakeCount == 0 || p.x < uWakeBox.x || p.y < uWakeBox.y || p.x > uWakeBox.z || p.y > uWakeBox.w) return acc;
  for (int i = 0; i < uWakeCount; i++) {
    vec4 r = uWake[i];
    float age = uTime - r.z;
    vec2 d = p - r.xy;
    float dist = length(d);
    if (r.w > 0.0) {
      float x = dist - (0.12 + age * 1.05);
      float wdt = 0.22 + age * 0.2;
      if (abs(x) > wdt * 2.6) continue;
      float env = exp(-x * x / (wdt * wdt)) * exp(-age * 0.5) * r.w;
      float crest = cos(x * 12.0 + age * 2.0);
      acc.xy += d / max(dist, 0.001) * crest * env * 0.22;
      acc.z += env * max(crest, 0.0) * 0.5 * (1.0 - smoothstep(0.5, 2.8, age)); // thin foam on young crests
    } else {
      float rad = 0.65 + age * 0.35;
      if (dist > rad * 1.6) continue;
      float k = (1.0 - smoothstep(rad * 0.3, rad, dist)) * (1.0 - smoothstep(0.3, 3.8, age)) * -r.w;
      acc.z += k * 0.55;
      acc.xy += d / max(dist, 0.001) * sin(dist * 10.0 - age * 7.0) * k * 0.06;
    }
  }
  return acc;
}

// Around a moving hull (ellipse of half length/width uBoatK.zw): white bow crescent + bow wave, and a
// V of crests behind the bow at the wake angle (steady in the boat's frame, like a Kelvin wake).
vec3 boatField(vec2 p) {
  if (uBoatK.y <= 0.0) return vec3(0.0);
  vec2 q = p - uBoat.xy;
  vec2 side = vec2(-uBoat.w, uBoat.z);
  float al = dot(q, uBoat.zw), sd = dot(q, side);
  float sp = clamp(uBoatK.x / 1.6, 0.0, 1.3) * uBoatK.y;
  vec3 acc = vec3(0.0);
  if (abs(al) < uBoatK.z * 2.2 && abs(sd) < uBoatK.w * 3.5) {
    float e = length(vec2(al / uBoatK.z, sd / uBoatK.w)); // 1 on the waterline
    float front = smoothstep(-0.2, 0.8, al / uBoatK.z);
    float ridge = exp(-pow((e - 1.12) / 0.14, 2.0));
    vec2 outward = normalize(uBoat.zw * (al / (uBoatK.z * uBoatK.z)) + side * (sd / (uBoatK.w * uBoatK.w)) + 1e-5);
    acc.xy += outward * sin((e - 1.1) * 14.0) * exp(-max(e - 1.0, 0.0) * 3.0) * 0.05 * sp * front;
    acc.z += ridge * front * sp;
  }
  float behind = uBoatK.z * 0.85 - al; // metres behind the bow
  float tanA = clamp(0.62 / max(uBoatK.x, 0.4), 0.36, 0.75);
  if (sp > 0.02 && behind > 0.0 && behind < 24.0 && abs(sd) < behind * tanA + 4.0) {
    float across = abs(sd) - behind * tanA; // 0 on the arm, >0 outside the V
    float wdt = 0.5 + behind * 0.1;
    float pack = exp(-across * across / (wdt * wdt)) * exp(-behind * 0.06) * sp;
    float crest = cos(across * 7.0 - behind * 0.6);
    vec2 armN = normalize(uBoat.zw * tanA + side * sign(sd)); // outward normal of this arm
    acc.xy += armN * crest * pack * 0.16;
    float cr2 = max(crest, 0.0);
    acc.z += pack * cr2 * cr2 * (0.55 * exp(-behind * 0.2) + 0.6 * exp(-behind * 0.045)); // white lines along the arms
  }
  return acc;
}

// Sky seen in the water when there is no mirror texture: the dome's gradient and sun glow, soft
// clouds from one noise fetch, and the far shore's trees faked in near the horizon.
vec3 fallbackReflect(vec3 R, float sunUp) {
  float up = max(R.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
  float sd = max(dot(R, uSunDir), 0.0);
  c += uSunRaw * (pow(sd, 6.0) * 0.18 + pow(sd, 60.0) * 0.35);
  vec2 q = R.xz / (up + 0.12) * 0.9 + vec2(uTime * 0.004, uTime * 0.0015);
  float cl = smoothstep(0.55, 0.8, textureLod(uFoamTex, q * 0.09, 1.5).g) * smoothstep(0.0, 0.18, up);
  c = mix(c, mix(vec3(1.0), uSunRaw, 0.35) * 1.05, cl * 0.75);
  vec3 shoreLit = uShoreCol * (uAmbient * 1.3 + uSunCol * 0.7 * sunUp);
  return mix(c, shoreLit, (1.0 - smoothstep(0.01, 0.13, R.y)) * 0.75);
}

#if WATER_Q >= 1
// What the refraction pre-pass saw at uv: world position (xyz), 1 if anything was drawn there (w).
vec4 scenePoint(vec2 uv) {
  vec2 sz = vec2(textureSize(uDepthTex, 0));
  float d = texelFetch(uDepthTex, ivec2(clamp(uv * sz, vec2(0.0), sz - 1.0)), 0).r;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 r = vec3(ndc.x / uProjXY.x, ndc.y / uProjXY.y, -1.0);
  float den = (d * 2.0 - 1.0) - uRefrRow.x * r.x - uRefrRow.y * r.y + uRefrRow.z;
  float w = uRefrRow.w / (abs(den) > 1e-7 ? den : 1e-7);
  vec3 wp = cameraPosition + (vec4(r, 0.0) * viewMatrix).xyz * w;
  return vec4(wp, step(d, 0.99999) * step(0.0, w));
}
// Distance from this surface point to anything just under / piercing the surface.
float contactDist(vec4 s, float cur) {
  return (s.w > 0.5 && s.y < 0.06) ? min(cur, distance(s.xyz, vWorld)) : cur;
}
#endif

void main() {
  vec2 p = vWorld.xz;
  if (uHullK.z > 0.5) { // the rowboat's waterline footprint (same plan shape as the hull)
    vec2 q = p - uHull.xy;
    float hx = dot(q, uHull.zw) / uHullK.x, hs = dot(q, vec2(uHull.w, -uHull.z));
    float hb = uHullK.y * (hx > 0.0 ? pow(max(0.0, 1.0 - hx * hx), 0.52) : 1.0 - 0.38 * pow(-hx, 2.6));
    if (abs(hx) < 0.97 && abs(hs) < hb * 0.72) discard;
  }
  vec3 toEye = cameraPosition - vWorld;
  float eyeDist = length(toEye);
  vec3 V = toEye / eyeDist;
  float dT = max(vDepth, 0.0);
  float shoreK = smoothstep(0.0, 0.6, dT);
  float gust = vGust;
  vec2 side = vec2(-uWind.y, uWind.x);
  float t = uTime;

  // ---- surface slopes: ripple layers + swells (per vertex) + rings + swimmer + falls ----
  vec3 L1 = rippleLayer(p, mat2(1.0), 13.0, uWind * 0.42, 0.028);
#if WATER_Q == 0
  vec3 L2 = rippleLayer(p, ROT2, 5.7, uWind * 0.22 + side * 0.16, 0.024 + 0.02 * gust);
  vec3 L3 = vec3(0.0);
#else
  vec3 L2 = rippleLayer(p, ROT2, 5.7, uWind * 0.22 + side * 0.16, 0.024);
  vec3 L3 = rippleLayer(p, ROT3, 2.3, uWind * 0.17 - side * 0.09, 0.012 + 0.026 * gust);
#endif
  vec2 g = (L1.xy + L2.xy + L3.xy) * uDetail + vSwell;
  float sVar = (L1.z + L2.z + L3.z) * uDetail * uDetail;
  vec3 rg = ringField(p);
  g += rg.xy;
  vec2 toP = p - uPlayer.xz;
  float pd = length(toP);
  if (uRipple > 0.01 && pd < 14.0) g += toP / max(pd, 0.001) * sin(pd * 5.5 - t * 5.0) * exp(-pd * 0.55) * uRipple * 0.16;
  vec3 wk = wakeField(p) + boatField(p);
  g += wk.xy;
  // plunge pool: where the falls' whitewater runs into the lake (an ellipse, wide along x)
  vec2 toF = p - uFalls.xy;
  vec2 fq = vec2(toF.x / uFallsShape.x, toF.y);
  float fd = length(fq);
  float fallK = (1.0 - smoothstep(1.0, uFalls.z, fd)) * uFalls.w;
  float churn = 0.0;
  if (fallK > 0.0) {
    float flod = clamp(log2(max(eyeDist, 1.0) / 14.0), 0.0, 4.0);
    vec2 fdir = fq / max(fd, 0.001);
    vec2 fs = textureLod(uRippleTex, p * 0.29 + vec2(0.0, t * 0.5), 1.0).xy * 8.0 - 4.0;
    float wave = sin(fd * 3.1 - t * 5.2) + 0.6 * sin(fd * 5.3 - t * 7.9 + 1.7);
    g += fdir * wave * 0.05 * fallK + fs * 0.022 * fallK;
    sVar += 0.006 * fallK;
    // foam streaming outward, sampled in polar coordinates (5 texture tiles per turn: seamless)
    float fang = atan(fq.y, fq.x) * (5.0 / 6.2831853);
    float fl1 = textureLod(uFoamTex, vec2(fang, fd * 0.3 - t * 0.42), flod).r;
    float fl2 = textureLod(uFoamTex, vec2(fang * 2.0 + 0.5, fd * 0.55 - t * 0.7), flod).a;
    float bub = smoothstep(0.8, 0.95, textureLod(uFoamTex, p * 1.7 + vec2(t * 0.05, -t * 0.08), flod).r);
    float reach = sqrt(fallK); // streaks and bubbles carry further out than the solid churn
    churn = clamp(reach * (fl1 * 0.75 + fl2 * 0.55 + bub * 0.6) + fallK * (1.0 - smoothstep(0.0, 0.45 * uFalls.z, fd)) * 0.8, 0.0, 1.0);
  }
  g *= mix(0.4, 1.0, shoreK);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  F += (1.0 - F) * uReflBoost;
  vec3 R = reflect(-V, N);
  vec3 Rs = vec3(R.x, max(R.y, 0.0), R.z);
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);

  // ---- reflection ----
  vec3 refl;
#if WATER_Q >= 2
  vec4 rc = uReflMatrix * vec4(vWorld, 1.0);
  vec3 tilt = mat3(viewMatrix) * vec3(-g.x, 0.0, -g.y);
  vec2 ruv = rc.xy / rc.w + tilt.xy * uReflDistort;
  float inside = uReflOn * smoothstep(0.0, 0.03, ruv.x) * (1.0 - smoothstep(0.97, 1.0, ruv.x))
               * smoothstep(0.0, 0.03, ruv.y) * (1.0 - smoothstep(0.97, 1.0, ruv.y));
  refl = vec3(0.0);
  if (inside > 0.001) refl = textureLod(uReflTex, clamp(ruv, vec2(0.001), vec2(0.999)), clamp(sVar * 900.0 + gust * 0.8, 0.0, 3.0)).rgb;
  if (inside < 0.999) refl = mix(fallbackReflect(Rs, sunUp), refl, inside);
#else
  refl = fallbackReflect(Rs, sunUp);
#endif
  refl = mix(refl, refl * 0.82 + uZenith * 0.1, gust * 0.5);

  // ---- what is seen through the surface ----
  vec3 col;
  float alpha = 1.0;
  float dC = dT; // distance to the nearest thing at / under the surface (shore, posts, reeds, swimmer)
#if WATER_Q >= 1
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec4 s0 = scenePoint(suv);
  dC = contactDist(s0, dC);
  if (dC < 1.2) {
    // soften the half-res depth where it matters: 4 taps around the pixel
    vec2 px = 0.5 / vec2(textureSize(uDepthTex, 0));
    dC = contactDist(scenePoint(suv + vec2(-px.x, -px.y)), dC);
    dC = contactDist(scenePoint(suv + vec2(px.x, -px.y)), dC);
    dC = contactDist(scenePoint(suv + vec2(-px.x, px.y)), dC);
    dC = contactDist(scenePoint(suv + vec2(px.x, px.y)), dC);
  }
  bool ok0 = s0.w > 0.5 && s0.y < 0.02;
  float dRef = min(ok0 ? max(-s0.y, 0.0) : dT, 2.5);
  vec2 duv = (mat3(viewMatrix) * vec3(-g.x, 0.0, -g.y)).xy * (uRefrAmt * dRef * 0.5) * uProjXY / max(vViewZ, 0.5);
  vec2 ruv2 = clamp(suv + duv, vec2(0.001), vec2(0.999));
  vec4 s1 = scenePoint(ruv2);
  bool ok1 = s1.w > 0.5 && s1.y < 0.02;
  vec2 fuv = ok1 ? ruv2 : suv;
  vec4 sF = ok1 ? s1 : s0;
  bool okF = ok1 || ok0;
  float dBed = okF ? max(-sF.y, 0.0) : dT;
  vec3 bed = textureLod(uRefrTex, fuv, clamp(log2(1.0 + dBed * 0.45), 0.0, 1.6)).rgb;
  #ifdef USE_FOG
  #ifndef FOG_EXP2
  // the pre-pass already fogged the bed; remove it (the surface is fogged again below)
  float wBed = okF ? -(viewMatrix * vec4(sF.xyz, 1.0)).z : vViewZ;
  float fb = min(smoothstep(fogNear, fogFar, wBed), 0.9);
  bed = max((bed - fogColor * fb) / (1.0 - fb), vec3(0.0));
  #endif
  #endif
  vec3 Tr = refract(-V, N, 0.75);
  float path = dBed / max(-Tr.y, 0.3) + dBed * uDownPath;
  vec3 trans = exp(-uAbsorb * path);
  vec3 bodyLight = uAmbient * 1.15 + uHorizon * 0.2 + uSunCol * 0.45 * sunUp; // light scattered in the water body
  vec3 scatter = mix(uShallowCol, uDeepCol, smoothstep(0.4, 5.0, dBed)) * bodyLight;
  col = mix(bed * trans + scatter * (1.0 - trans), refl, F);
#else
  vec3 base = mix(vec3(0.30, 0.78, 0.72), vec3(0.05, 0.28, 0.45), smoothstep(0.0, 6.0, dT)) * (uAmbient * 1.4 + uSunCol * 0.45 * sunUp);
  col = mix(base, refl, clamp(F + 0.08, 0.0, 1.0));
  alpha = mix(0.5, 0.93, smoothstep(0.0, 2.4, dT));
#endif

  // ---- sun: rough-surface highlight (LEAN variance widens it with distance) + crisp glints ----
  vec3 H = normalize(uSunDir + V);
  float nh = clamp(dot(N, H), 0.0, 1.0);
  float nh2 = max(nh * nh, 0.0001);
  float a2 = 0.00045 + 2.0 * sVar + 0.002 * gust;
  float Dm = exp((nh2 - 1.0) / (nh2 * a2)) / (W_PI * a2 * nh2 * nh2);
  float Fh = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, H), 0.0, 1.0), 5.0);
  float spec = min(Dm * Fh / (4.0 * max(NdV, 0.15)), 40.0) * W_PI;
  // glints: the finest ripple layer exaggerated, seen only through a very sharp lobe
  vec3 Ng = normalize(N + vec3(-L3.x - L2.x * 0.5, 0.0, -L3.y - L2.y * 0.5) * 2.5);
  float glint = pow(clamp(dot(Ng, H), 0.0, 1.0), 2600.0) * (1.0 - smoothstep(20.0, 75.0, eyeDist));
  vec3 sunC = uSunCol * (spec * uSpecular + min(glint * 1500.0 * Fh * (0.7 + gust), 30.0) * uGlint) * smoothstep(0.0, 0.06, uSunDir.y);

  // ---- foam: lapping waterline, bands rolling in to the shore, rings, the falls ----
  vec4 fA = texture(uFoamTex, p * 0.21 + uWind * t * 0.012);
#if WATER_Q >= 1
  vec4 fB = texture(uFoamTex, p * 0.57 - uWind * t * 0.025 + side * t * 0.01);
#else
  vec4 fB = fA.gbar;
#endif
  float lace = fA.r * 0.65 + fB.r * 0.5;
  float lap = 0.05 * sin(t * 1.3 + p.x * 0.35 + p.y * 0.27) + 0.03 * sin(t * 2.1 + p.y * 0.6);
  float edge = 1.0 - smoothstep(0.0, 0.1 + 0.12 * fA.g, dC + lap);
  float ph = fract(vShore * 0.42 + t * 0.19 + (fA.g - 0.5) * 0.7);
  float band = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.06, 0.32, ph));
  band *= (1.0 - smoothstep(0.15, 0.95, dT)) * (1.0 - smoothstep(6.0, 14.0, vShore))
        * smoothstep(0.35, 0.62, fB.b + 0.15 * sin(t * 0.4 + p.x * 0.05));
  float foamAmt = max(max(edge, band * 0.75), max(rg.z * 0.9, wk.z));
  foamAmt = max(foamAmt, churn);
  foamAmt = clamp(foamAmt * uFoamAmt, 0.0, 1.0);
  float foam = smoothstep(0.0, 0.25, lace - (1.0 - foamAmt) * 0.9) * smoothstep(0.0, 0.15, foamAmt);
  vec3 foamC = (uSunCol * (0.4 + 0.6 * sunUp) + uAmbient * 1.25) * 0.95;

  col = mix(col, foamC, foam * 0.9);
  col += sunC * (1.0 - foam);
#if WATER_Q == 0
  alpha = max(alpha, foam * 0.9);
  alpha *= smoothstep(-0.25, 0.02, vDepth);
#endif
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}`;

// ---- waterfall: veil sheets, ropes and talus cascade (one mesh) -------------------------------------
export const veilVert = /* glsl */ `
attribute vec4 aFall;   // layer (0 back, 1 main, 2 front, 3 rope, 4 talus cascade), progress 0..1, seed, -
uniform float uTime;
varying vec2 vUv;       // across 0..1, time of flight (s)
varying vec4 vFall;
varying vec3 vWorld;
varying vec3 vNrm;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vFall = aFall;
  vec3 pos = position;
  // ropes sway and flutter as they fall; the free edges of the sheets flutter a little
  float isRope = step(2.5, aFall.x) * (1.0 - step(3.5, aFall.x));
  float edgeK = (1.0 - step(3.5, aFall.x)) * (1.0 - isRope) * smoothstep(0.3, 0.5, abs(uv.x - 0.5));
  pos.x += sin(uv.y * 3.1 + uTime * 2.3 + aFall.z * 6.28) * (0.22 * isRope + 0.08 * edgeK) * aFall.y;
  pos.z += cos(uv.y * 2.3 + uTime * 1.7 + aFall.z * 4.0) * 0.12 * isRope * aFall.y;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

export const veilFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbient;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform sampler2D uFoamTex;
varying vec2 vUv;
varying vec4 vFall;
varying vec3 vWorld;
varying vec3 vNrm;
#include <fog_pars_fragment>
void main() {
  float layer = vFall.x, prog = vFall.y, seed = vFall.z;
  float rope = step(2.5, layer) * (1.0 - step(3.5, layer));
  float casc = step(3.5, layer);
  float u = vUv.x, t = vUv.y;
  // Streaks live in time-of-flight space: they travel with the water and stretch as it speeds up.
  float flow = t - uTime * mix(0.9, 1.25, casc);
  vec4 n1 = texture(uFoamTex, vec2(u * mix(1.1, 0.35, rope) + seed, flow * 0.45));
  vec4 n2 = texture(uFoamTex, vec2(u * mix(2.7, 0.8, rope) + seed * 1.7, flow * 0.95 + 0.31));
  vec4 n3 = texture(uFoamTex, vec2(u * 5.5 - seed, flow * 1.9 + 0.77));
  float streak = n1.a * 0.45 + n2.g * 0.42 + n3.r * 0.3;
  float aer = max(smoothstep(0.0, 1.3, t), casc);   // air mixed in as it falls
  float white = smoothstep(0.62 - 0.34 * aer - 0.08 * min(layer, 2.0), 0.9 - 0.2 * aer, streak);
  white = max(white, (1.0 - smoothstep(0.0, 0.22, t)) * (0.55 + 0.45 * n2.r) * (1.0 - casc)); // aerated lip
  white = max(white, casc * smoothstep(0.35, 0.7, streak + 0.12));                         // talus whitewater
  white = mix(white, 1.0, rope * 0.35);
  // Opacity: thin glassy water where dark, dense where white; ragged, tearing edges.
  float edge = min(u, 1.0 - u);
  float rag = (n1.g - 0.5) * 0.22 + (n3.a - 0.5) * 0.14;
  float edgeW = mix(0.07 + 0.14 * aer, 0.45, rope);
  float a = smoothstep(0.0, edgeW, edge + rag * (0.35 + aer) * (1.0 - rope * 0.5));
  float body = layer < 0.5 ? 0.3 : (layer < 1.5 ? 0.55 : (layer < 2.5 ? 0.38 : 0.55));
  body = mix(body, 0.45, casc);
  a *= mix(body, 0.96, white);
  a *= smoothstep(0.0, 0.05, t + casc);
  // ropes break into droplets towards the bottom; sheets open up where they land
  a *= 1.0 - rope * smoothstep(0.35, 0.95, prog) * (1.0 - smoothstep(0.42, 0.6, n3.g + n2.a * 0.3));
  a *= 1.0 - (1.0 - casc) * (1.0 - rope) * smoothstep(0.82, 1.0, prog) * (1.0 - smoothstep(0.3, 0.6, n2.g));
  a *= 1.0 - casc * smoothstep(0.8, 1.0, prog);   // the cascade fades into the lake
  if (a < 0.004) discard;
  // Light: foam scatters (wrapped diffuse); thin water shows the sky and glows with the sun behind it.
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNrm);
  N = dot(N, V) < 0.0 ? -N : N;
  N = normalize(N + vec3(n2.g - 0.5, 0.0, n1.a - 0.5) * 0.5);
  float sunUp = smoothstep(0.0, 0.08, uSunDir.y);
  vec3 lit = uSunCol * (0.5 + 0.5 * max(dot(N, uSunDir), 0.0)) * sunUp + uAmbient * 1.45;
  vec3 glassy = mix(vec3(0.2, 0.47, 0.5) * lit * 1.3, mix(uHorizon, uZenith, 0.4) * 0.9, 0.35 + 0.35 * (1.0 - max(dot(N, V), 0.0)));
  vec3 col = mix(glassy, lit * (0.92 + 0.12 * n3.a), white);
  float back = pow(max(dot(-V, uSunDir), 0.0), 4.0) * sunUp;
  col += uSunCol * back * (0.5 + 1.3 * (1.0 - white));
  vec3 H = normalize(uSunDir + V);
  col += uSunCol * pow(max(dot(N, H), 0.0), 80.0) * (1.0 - white) * 3.0 * sunUp;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

// ---- waterfall particles: mist (0), churning whitewater (1), spray (2) ------------------------------
// Instanced camera-facing quads (not gl.POINTS: point sprites are capped at 64-511 px on many GPUs).
export const partVert = /* glsl */ `
attribute vec3 aCenter;  // world position
attribute float aSize;   // world-space diameter
attribute float aAlpha;
attribute float aSeed;
varying vec2 vPc;        // -1..1 across the quad
varying float vAlpha;
varying float vSeed;
varying vec3 vView;      // view-space position of this fragment
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
  float dist = max(-mvPosition.z, 0.1);
  // Fade what would fill the view: near the lens, and anything covering most of the screen (overdraw).
  float screenFrac = aSize * projectionMatrix[1][1] / (2.0 * dist);
  vAlpha = aAlpha * smoothstep(0.6, 1.0 + aSize * 0.6, dist) * (1.0 - smoothstep(0.3, 0.6, screenFrac));
  vSeed = aSeed;
  vPc = position.xy;
  mvPosition.xy += position.xy * aSize * 0.5;
  vView = mvPosition.xyz;
  gl_Position = vAlpha < 0.002 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * mvPosition; // skip invisible quads
  #include <fog_vertex>
}`;

export const partFrag = /* glsl */ `
uniform float uTime;
uniform float uMode;
uniform float uBow;      // rainbow strength
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbient;
uniform sampler2D uFoamTex;
varying vec2 vPc;
varying float vAlpha;
varying float vSeed;
varying vec3 vView;
#include <fog_pars_fragment>

vec3 wfSpectrum(float h) { // 0 = red .. 1 = violet
  vec3 c = clamp(vec3(1.0 - abs(h * 3.0 - 0.2), 1.0 - abs(h * 3.0 - 1.35), 1.0 - abs(h * 3.0 - 2.5)), 0.0, 1.0);
  c.r += clamp(1.0 - abs(h * 3.0 - 3.1), 0.0, 1.0) * 0.45;
  return c;
}
// Primary bow 40-42.4 deg from the antisolar point (red outside), faint secondary 50.4-53.6 (reversed).
vec3 wfRainbow(float ang) {
  float p = (42.4 - ang) / 2.4;
  vec3 c = wfSpectrum(p) * smoothstep(-0.12, 0.1, p) * (1.0 - smoothstep(0.88, 1.1, p));
  float s = (ang - 50.4) / 3.2;
  c += wfSpectrum(s) * smoothstep(-0.12, 0.1, s) * (1.0 - smoothstep(0.88, 1.1, s)) * 0.36;
  return c;
}

void main() {
  vec2 pc = vPc;
  float r2 = dot(pc, pc);
  if (r2 >= 1.0) discard;
  float soft = 1.0 - r2;
  float sunUp = smoothstep(0.0, 0.06, uSunDir.y);
  vec3 col;
  float a;
  if (uMode < 0.5) {
    // billowing mist: soft puff broken up by noise that slowly evolves
    // wispy puff: the edge follows a rotated noise field instead of a circle
    float ang = vSeed * 6.2831853;
    vec2 q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * pc;
    float n = textureLod(uFoamTex, q * 0.22 + vec2(vSeed, vSeed * 1.37) + uTime * 0.002, 0.0).g;
    float n2 = textureLod(uFoamTex, q * 0.5 + vec2(vSeed * 2.3, vSeed) - uTime * 0.004, 0.0).b;
    a = smoothstep(0.18, 0.7, soft * (n * 0.8 + n2 * 0.4)) * soft * vAlpha;
    // per-fragment view ray (world) through this part of the sprite
    vec3 dir = normalize((vec4(vView, 0.0) * viewMatrix).xyz);
    float mu = dot(dir, uSunDir);
    float hg = 0.64 / pow(1.36 - 1.2 * mu, 1.5); // Henyey-Greenstein g = 0.6 (x 4 pi): bright when backlit
    col = uAmbient * 1.5 + uSunCol * (0.55 + 0.45 * hg) * sunUp; // dense spray scatters a lot even away from the sun
    if (-mu > 0.55 && -mu < 0.8) col += uSunCol * wfRainbow(degrees(acos(-mu))) * uBow * sunUp; // 37-57 deg from the antisolar point
  } else if (uMode < 1.5) {
    // churning whitewater: a burst of foam lace that tears apart as it expands
    vec4 f = textureLod(uFoamTex, pc * 0.3 + vec2(vSeed * 3.1, vSeed * 1.7 + uTime * 0.07), 0.0);
    float lace = f.r * 0.8 + f.a * 0.45;
    a = smoothstep(0.05, 0.6, soft) * smoothstep(0.38, 0.78, lace + soft * 0.35) * vAlpha;
    col = (uSunCol * (0.75 + 0.25 * sunUp) + uAmbient * 1.35) * (0.85 + 0.2 * f.a);
  } else {
    // spray droplet
    a = smoothstep(0.0, 0.7, soft) * vAlpha;
    col = (uSunCol * sunUp + uAmbient * 1.5) * 1.1;
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;
