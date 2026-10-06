import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import { buildTerrain, layout, heightAt, biome, LAKE } from './world/terrain.js';
import { createEnvironment } from './world/sky.js';
import { createGrass, createFlowers, updatePatches } from './world/grass.js';
import { buildVegetation, setVegetationQuality } from './world/vegetation.js';
import { windTime } from './world/geo.js';
import { createWater, updateWater } from './world/water.js';
import { buildLandmarks } from './world/landmarks.js';
import { createLife } from './world/life.js';
import { PRESETS } from './player/characters.js';
import { createFX } from './world/fx.js';
import { Controller } from './player/controller.js';
import { Soundscape } from './audio/audio.js';
import { createFishing } from './world/fishing.js';
import { getSeats } from './world/seats.js';
import { createBoat } from './world/boat.js';
import { createBudget } from './render/budget.js';
import { createSkyProbe, REAL } from './render/realMaterial.js';
import { prewarmThorfinn } from './player/thorfinn.js';
import { CHAR_SCALE } from './player/characters.js';

const $ = (id) => document.getElementById(id);
// Yield so the loading text can paint; don't stall if the tab is in the background (no rAF there).
const frame = () => new Promise((r) => {
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(r, 0); } };
  requestAnimationFrame(go);
  setTimeout(go, 80);
});

// water: 0 = simple shader, 1 = refraction + depth, 2 = + planar reflection
// trees: 0/1/2 foliage detail. grassFar: blades in the far grass ring.
const QUALITY = {
  low: { grass: 23000, grassFar: 0, flowers: 1000, shadow: 1024, pr: 0.85, bloom: false, samples: 0, water: 0, trees: 0, dof: false },
  medium: { grass: 60000, grassFar: 14000, flowers: 4500, shadow: 1536, pr: 1.0, bloom: false, samples: 2, water: 1, trees: 1, dof: true },
  high: { grass: 100000, grassFar: 24000, flowers: 5500, shadow: 2048, pr: 1.25, bloom: true, samples: 4, water: 2, trees: 2, dof: true },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('stillwater.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stillwater.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);
// Shadows are refreshed by the loop (every other frame), not on every render call.
renderer.shadowMap.autoUpdate = false;
const budget = createBudget(renderer);
let fpsCap = +(localStorage.getItem('stillwater.fpsCap') || 60);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2600);
camera.layers.enableAll(); // see src/layers.js

let composer, bloomPass, dofPass = null;
const focusPoint = new THREE.Vector3();

// Depth of field focused on the traveller: the far valley softens, grass right at the lens softens a
// little, the character stays crisp. One pass over the HDR scene; in-focus pixels never bleed outward.
const DofShader = {
  uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 2600 }, uFocus: { value: 6 }, uTexel: { value: new THREE.Vector2(1e-3, 1e-3) }, uRadius: { value: 5 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `#include <packing>
    uniform sampler2D tDiffuse, tDepth; uniform float uNear, uFar, uFocus, uRadius; uniform vec2 uTexel; varying vec2 vUv;
    float dist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    float coc(float z) {
      float far = smoothstep(uFocus * 1.6 + 2.5, uFocus * 10.0 + 40.0, z);
      float near = 1.0 - smoothstep(uFocus * 0.25, uFocus * 0.55, z);
      return max(far, near * 0.7);
    }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float d0 = texture2D(tDepth, vUv).x;
      if (d0 > 0.99995) { gl_FragColor = base; return; } // open sky is soft already
      float c0 = coc(-perspectiveDepthToViewZ(d0, uNear, uFar));
      if (c0 < 0.03) { gl_FragColor = base; return; }
      float R = uRadius * c0;
      vec3 acc = base.rgb; float wsum = 1.0;
      for (int i = 0; i < 10; i++) {
        float a = float(i) * 2.39996, r = sqrt((float(i) + 0.5) / 10.0) * R;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
        float cs = coc(dist(uv));
        float w = clamp(cs / max(c0 * 0.6, 1e-3), 0.0, 1.0);
        acc += texture2D(tDiffuse, uv).rgb * w; wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, base.a);
    }`,
};
class DofPass extends ShaderPass {
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}
// render targets don't resize their depth textures by themselves
function syncDepth() {
  for (const t of [composer?.renderTarget1, composer?.renderTarget2]) {
    const d = t?.depthTexture;
    if (d && (d.image.width !== t.width || d.image.height !== t.height)) { d.dispose(); d.image.width = t.width; d.image.height = t.height; }
  }
}
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.55 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.1);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * uVig;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// ==== RENDER PIPELINE (owned by the water work: setupPost + GradeShader) ====
// Frame: water pre-pass (lake refraction + depth at q.water >= 1; planar reflection at 2, only near
// the lake with water on screen, every other frame, cropped to the water) -> scene -> depth of field
// (q.dof, reads the scene's depth texture) -> bloom -> output -> grade. The pre-pass skips itself while the lake is off-screen, never renders the shadow map
// (a refresh the loop requests is left for the main scene render), follows composer.setSize() and
// resets renderer.info once per frame (whole-frame totals). Knobs: water.pass.refrScale / reflScale /
// reflEvery / reflMaxDist, and waterUniforms in world/water.js. Grass + flowers stay out of the pre-pass.
function setupPost(q) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.pr));
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.samples, depthTexture: q.dof ? new THREE.DepthTexture(size.x, size.y) : null });
  composer?.dispose();
  bloomPass?.dispose();
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(Math.min(devicePixelRatio, q.pr));
  composer.setSize(innerWidth, innerHeight);
  if (water?.pipeline) {
    renderer.info.autoReset = false;
    composer.addPass(water.pipeline(scene, camera, q.water ?? 0, [grass, flowers]));
  }
  composer.addPass(new RenderPass(scene, camera));
  dofPass = q.dof ? new DofPass(DofShader) : null;
  if (dofPass) composer.addPass(dofPass);
  syncDepth();
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.22, 0.55, 0.92);
  if (q.bloom) composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(GradeShader));
}
// ==== END RENDER PIPELINE ====

// ---- World ------------------------------------------------------------------
let env, grass, flowers, water, landmarks, life, probe, boat;
REAL.objScale.value = CHAR_SCALE;
const controller = new Controller(camera, renderer.domElement);
const audio = new Soundscape();
let fx = null;
controller.onStep = (surface, p, strength) => { audio.footstep(surface, strength); fx?.step(surface, p, strength); };
controller.onLand = (p, impact, surface) => { audio.footstep(surface, 1.6); fx?.land(p, impact, surface); };
controller.onSplash = (p) => { audio.splash(); fx?.splash(p, 1.2); };
controller.onStroke = (p, fast) => { audio.footstep('water', fast ? 0.7 : 0.5); fx?.splash(p, fast ? 0.5 : 0.35); };
controller.onPrompt = (text) => showPrompt(text);
let fishing = null;
let quality = store.get('quality', 'medium');
if (!store.get('qv2', false)) { if (quality === 'high') quality = 'medium'; store.set('qv2', true); } // cooler default
if (!QUALITY[quality]) quality = 'medium';

// Render resolution = quality's pixel ratio × the budget's dynamic scale.
function applyScale() {
  if (!composer) return;
  const pr = Math.min(devicePixelRatio, QUALITY[quality].pr) * budget.scale;
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  syncDepth();
}

async function build() {
  const say = async (t) => { $('loadText').textContent = t; await frame(); };
  prewarmThorfinn(); // sculpted on another thread while the valley loads
  await say('Shaping the valley…');
  const terrain = await buildTerrain(say);
  scene.add(terrain);
  import('./world/caustics.js').then((m) => m.addCaustics(terrain.material)); // underwater caustics + lake-bed detail (wraps any onBeforeCompile)
  env = createEnvironment(scene, renderer);
  probe = createSkyProbe(renderer); // sky reflections for the realistic materials
  await say('Planting the trees…');
  buildVegetation(scene);
  landmarks = buildLandmarks(scene);
  await say('Filling the lake…');
  water = createWater(scene);
  life = createLife(scene);
  fx = createFX(scene, camera, renderer);
  fishing = createFishing(scene, fx, audio, { prompt: showPrompt, toast });
  controller.fishing = fishing;
  controller.seats = getSeats();
  boat = createBoat(scene, { water, fx, audio });
  controller.boat = boat;
  controller.onBoard = (on) => { if (on) toast('W / S row · A / D turn · Shift pull harder · E by the shore to step out', 'The rowboat', 7); };
  // the rowboat replaces the little decorative boat that used to bob at the dock
  landmarks.group.children.forEach((m) => { if (m.isMesh && m.position.y < 0.5 && Math.hypot(m.position.x - boat.x, m.position.z - boat.z) < 1) m.visible = false; });
  await say('Letting the grass grow…');
  applyQuality(quality);
}

function applyQuality(name) {
  quality = name;
  store.set('quality', name);
  const q = QUALITY[name];
  if (grass) { scene.remove(grass, flowers); grass.traverse((o) => o.geometry?.dispose()); flowers.geometry.dispose(); }
  grass = createGrass(q.grass, q.grassFar, Math.round(q.flowers * 1.2));
  flowers = createFlowers(q.flowers);
  scene.add(grass, flowers);
  setVegetationQuality(q);
  env.setShadowSize(q.shadow);
  setupPost(q);
  budget.reset(1);
  applyScale();
  // Build the shadow map right away so no pass (e.g. the water pre-pass) ever samples a missing one.
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
}

// ---- Characters -------------------------------------------------------------
if (!store.get('tv4', false)) { store.set('traveller', 'thorfinn'); store.set('tv4', true); } // meet the new traveller once
let charIndex = Math.max(0, PRESETS.findIndex((p) => p.id === store.get('traveller', 'thorfinn')));
let rig = null;
const rigCache = new Map();
let charToken = 0;
// Some travellers are sculpted asynchronously; the current one stays until the next is ready.
function setCharacter(i) {
  charIndex = (i + PRESETS.length) % PRESETS.length;
  const p = PRESETS[charIndex];
  const token = ++charToken;
  $('cName').textContent = p.name;
  $('cRole').textContent = p.title;
  $('cBlurb').textContent = p.blurb;
  [...$('dots').children].forEach((d, k) => d.classList.toggle('on', k === charIndex));
  store.set('traveller', p.id);
  const show = (built) => {
    if (token !== charToken) return;
    if (rig) scene.remove(rig.root);
    rig = built;
    scene.add(rig.root);
    controller.setRig(rig, scene);
    rig.root.position.copy(controller.pos);
    $('cBlurb').textContent = p.blurb;
  };
  if (!rigCache.has(p.id)) rigCache.set(p.id, p.build());
  const r = rigCache.get(p.id);
  if (r && typeof r.then === 'function') {
    $('cBlurb').textContent = 'Arriving…';
    return r.then((built) => { rigCache.set(p.id, built); show(built); });
  }
  show(r);
  return Promise.resolve();
}

// ---- Discovery --------------------------------------------------------------
const found = new Set(store.get('found', []));
let toastTimer = 0;
function showPrompt(text, urgent = false) {
  const el = $('prompt');
  if (!text) { el.classList.remove('show'); return; }
  const [key, ...rest] = text.split('  ');
  el.innerHTML = rest.length ? `<kbd>${key}</kbd> ${rest.join('  ')}` : text;
  el.classList.toggle('urgent', urgent);
  el.classList.add('show');
}
function toast(small, big, secs = 5) {
  $('toastSmall').textContent = small;
  $('toastBig').textContent = big;
  $('toast').classList.add('show');
  toastTimer = secs;
}
function renderPlaces() {
  $('places').innerHTML = layout.landmarks.map((l) => `<div class="${found.has(l.id) ? 'found' : ''}">${found.has(l.id) ? l.name : 'Somewhere…'}</div>`).join('');
  $('pauseSub').textContent = `${found.size} of ${layout.landmarks.length} quiet places found.`;
  if (fishing) {
    const j = fishing.journal();
    const caught = j.filter((f) => f.count > 0).length;
    $('journal').innerHTML = `<div class="jhead">Fish journal · ${caught} of ${j.length}</div>` +
      j.map((f) => `<div class="${f.count ? 'found' : ''}">${f.count ? `${f.name} <span>${f.best} cm</span>` : '?'}</div>`).join('');
  }
}
function checkDiscovery() {
  for (const l of layout.landmarks) {
    if (found.has(l.id)) continue;
    if (Math.hypot(controller.pos.x - l.x, controller.pos.z - l.z) < l.r) {
      found.add(l.id);
      store.set('found', [...found]);
      toast(found.size === layout.landmarks.length ? 'Every quiet place found' : 'Discovered', l.name, 6);
      audio.chime();
    }
  }
}

// ---- State ------------------------------------------------------------------
let state = 'loading';
const titleCam = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
let trans = 1;
let hintTimer = 0;

function titlePose(out) {
  const p = controller.pos;
  const toLake = new THREE.Vector3(LAKE.x - p.x, 0, LAKE.z - p.z).normalize();
  const side = new THREE.Vector3(-toLake.z, 0, toLake.x);
  const eye = p.clone().addScaledVector(toLake, -6.2).addScaledVector(side, 1.9);
  eye.y = Math.max(heightAt(eye.x, eye.z) + 0.6, p.y + 2.05);
  camera.position.copy(eye);
  const look = p.clone().add(new THREE.Vector3(0, 1.2, 0));
  const fwd = look.clone().sub(eye).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  look.addScaledVector(right, -1.55);
  camera.lookAt(look);
  out.pos.copy(camera.position);
  out.quat.copy(camera.quaternion);
}

function showTitle() {
  state = 'title';
  controller.enabled = false;
  $('title').classList.remove('hidden');
  $('pause').classList.add('hidden');
  $('clickToLook').classList.add('hidden');
  $('hint').classList.remove('show');
  audio.pause(false);
}

function begin() {
  audio.start();
  audio.pause(false);
  $('title').classList.add('hidden');
  titlePose(titleCam);
  // Face away from the camera so the walk starts looking out over the lake.
  const toLake = Math.atan2(LAKE.x - controller.pos.x, LAKE.z - controller.pos.z);
  controller.yaw = toLake;
  controller.camYaw = toLake + Math.PI;
  controller.camPitch = 0.22;
  trans = 0;
  state = 'play';
  controller.enabled = true;
  hintTimer = 12;
  $('hint').classList.add('show');
  immersive();
}

// Go truly fullscreen (not just the tab) and capture the mouse. Must run inside a click/keypress.
// Keyboard Lock (Chromium) lets a short Esc reach the game (to rest) while holding Esc leaves fullscreen.
function immersive() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => navigator.keyboard?.lock?.(['Escape']))
      .catch(() => {});
  }
  lock();
}

function lock() {
  const p = renderer.domElement.requestPointerLock?.();
  if (p && p.catch) p.catch(() => { if (state === 'play') $('clickToLook').classList.remove('hidden'); });
}

function pause() {
  if (state !== 'play') return;
  state = 'paused';
  controller.enabled = false;
  controller.keys.clear();
  $('tod').value = env.t;
  renderPlaces();
  $('pause').classList.remove('hidden');
  $('hint').classList.remove('show');
  audio.pause(true);
}

function resume() {
  $('pause').classList.add('hidden');
  $('clickToLook').classList.add('hidden');
  state = 'play';
  controller.enabled = true;
  audio.pause(false);
  immersive();
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement) $('clickToLook').classList.add('hidden');
  else if (state === 'play') pause();
});
document.addEventListener('pointerlockerror', () => { if (state === 'play') $('clickToLook').classList.remove('hidden'); });
renderer.domElement.addEventListener('click', () => { if (state === 'play' && !document.pointerLockElement) lock(); });
$('clickToLook').addEventListener('click', immersive);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { navigator.keyboard?.unlock?.(); if (state === 'play') pause(); }
});

$('prev').onclick = () => setCharacter(charIndex - 1);
$('next').onclick = () => setCharacter(charIndex + 1);
$('begin').onclick = begin;
$('resume').onclick = resume;
$('change').onclick = () => { $('pause').classList.add('hidden'); showTitle(); };
$('music').value = store.get('music', 0.8);
$('nature').value = store.get('nature', 0.9);
audio.musicVol = +$('music').value;
audio.natureVol = +$('nature').value;
$('music').oninput = (e) => { audio.setMusic(+e.target.value); store.set('music', +e.target.value); };
$('nature').oninput = (e) => { audio.setNature(+e.target.value); store.set('nature', +e.target.value); };
$('tod').oninput = (e) => { env.t = +e.target.value; };
$('quality').onchange = (e) => applyQuality(e.target.value);
$('fpsCap').value = String(fpsCap);
$('fpsCap').onchange = (e) => { fpsCap = +e.target.value; try { localStorage.setItem('stillwater.fpsCap', fpsCap); } catch { /* private mode */ } };

addEventListener('keydown', (e) => {
  if (state === 'title') {
    if (e.code === 'ArrowLeft') setCharacter(charIndex - 1);
    if (e.code === 'ArrowRight') setCharacter(charIndex + 1);
    if (e.code === 'Enter') begin();
  }
  if (e.code === 'KeyM' && audio.started) {
    const v = audio.musicVol > 0 ? 0 : store.get('music', 0.8) || 0.8;
    audio.setMusic(v); $('music').value = v;
  }
  if (e.code === 'Backquote') $('fps').classList.toggle('hidden');
  // With Keyboard Lock active the browser no longer releases the mouse on Esc, so rest here.
  if (e.code === 'Escape' && state === 'play') { document.exitPointerLock?.(); pause(); }
  else if (e.code === 'Escape' && state === 'paused') resume();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
  syncDepth();
});

// ---- Loop -------------------------------------------------------------------
const clock = new THREE.Timer();
let elapsed = 0, fpsAcc = 0, fpsN = 0, ringTimer = 0;
const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion();

function audioInfo() {
  const p = controller.pos;
  let wet = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (heightAt(p.x + Math.cos(a) * 7, p.z + Math.sin(a) * 7) < 0.1) wet += 1;
    if (heightAt(p.x + Math.cos(a) * 16, p.z + Math.sin(a) * 16) < 0.1) wet += 0.5;
  }
  const b = biome(p.x, p.z);
  const f = layout.falls;
  return {
    height: p.y, swimming: controller.swimming, shore: Math.min(1, wet / 6), golden: env.golden,
    trees: Math.min(1, b.jungle + b.forest * 0.9 + 0.25), jungle: b.jungle,
    fallDist: f ? Math.hypot(p.x - f.x, p.z - f.baseZ, p.y - 4) : 999,
  };
}

let frameNo = 0, lastFrameAt = 0;
function loop(now = performance.now()) {
  requestAnimationFrame(loop);
  // 60 fps while walking (or 30 in battery saver), 30 on the title screen, 15 behind the rest menu
  const cap = state === 'play' ? fpsCap : state === 'paused' ? 15 : 30;
  if (!budget.shouldRender(now, cap)) return;
  const frameMs = now - lastFrameAt;
  lastFrameAt = now;
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  windTime.value = elapsed;

  if (state === 'play' || state === 'paused') {
    if (state === 'play') {
      controller.lookAt = life.nearest(controller.pos, 7);
      controller.update(dt);
      if (!controller.inBoat) boat.update(dt, null);
      controller.fishState = fishing.update(dt, elapsed, controller.pos, env);
      if (controller.swimming) {
        ringTimer -= dt;
        if (ringTimer <= 0) { fx.ring(controller.pos, controller.speed > 0.5 ? 1.8 : 1.3); ringTimer = controller.speed > 0.5 ? 0.45 : 1.1; }
      }
    }
    controller.updateCamera(dt);
    if (trans < 1) {
      trans = Math.min(1, trans + dt / 2.2);
      const k = trans * trans * (3 - 2 * trans);
      tmpPos.copy(camera.position); tmpQuat.copy(camera.quaternion);
      camera.position.lerpVectors(titleCam.pos, tmpPos, k);
      camera.quaternion.slerpQuaternions(titleCam.quat, tmpQuat, k);
    }
    if (state === 'play') checkDiscovery();
  } else if (state === 'title') {
    rig.root.position.copy(controller.pos);
    boat.update(dt, null);
    titlePose(titleCam);
    // Stand three-quarters on to the camera and keep an eye on it.
    const toCam = Math.atan2(camera.position.x - controller.pos.x, camera.position.z - controller.pos.z);
    controller.idle(dt, toCam - 0.55, window.__lookAt || camera.position); // __lookAt: debugging
  }

  window.__camHook?.(camera, dt); // debugging: frame shots from the console
  env.update(state === 'paused' ? 0 : dt, controller.pos, elapsed, camera.position);
  probe.update(env, elapsed);
  updatePatches(elapsed, controller.pos, env);
  updateWater(water, dt, elapsed, env, controller.pos, controller.swimming);
  life.update(dt, elapsed, controller.pos, env);
  fx.update(dt);
  landmarks.update(dt, elapsed);
  if (audio.started) audio.update(dt, audioInfo());

  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('show'); }
  if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) $('hint').classList.remove('show'); }

  renderer.shadowMap.needsUpdate = frameNo++ % 2 === 0;
  if (rig) { rig.head.getWorldPosition(focusPoint); rig.lod?.(camera.position.distanceTo(focusPoint), quality !== 'low'); }
  if (dofPass) {
    // focus on the traveller's head, wherever the camera is
    const u = dofPass.uniforms;
    u.uFocus.value = Math.max(1.2, camera.position.distanceTo(focusPoint));
    u.uNear.value = camera.near; u.uFar.value = camera.far;
    u.uRadius.value = 5 * Math.min(1.6, renderer.getPixelRatio() * innerHeight / 1100);
  }
  budget.begin();
  composer.render(dt);
  budget.end();
  if (state === 'play' && budget.adapt(dt, frameMs, 1000 / cap)) applyScale();

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    const g = budget.gpuMs;
    $('fps').textContent = `${Math.round(fpsN / fpsAcc)} fps · GPU busy ${g ? g.toFixed(1) + ' ms' : '–'} · res ${Math.round(budget.scale * 100)}% · ${renderer.getContext().drawingBufferWidth}×${renderer.getContext().drawingBufferHeight}`;
    fpsAcc = 0; fpsN = 0;
  }
}

// ---- Boot -------------------------------------------------------------------
(async () => {
  await build();
  $('quality').value = quality;
  $('dots').innerHTML = PRESETS.map(() => '<span></span>').join('');
  controller.place(layout.spawn.x, layout.spawn.z, layout.spawnYaw);
  $('loadText').textContent = 'Waiting for the traveller…';
  await setCharacter(charIndex);
  showTitle();
  $('loading').classList.add('fade');
  $('loading').style.opacity = 0;
  setTimeout(() => $('loading').classList.add('hidden'), 1300);
  window.__sw = { scene, camera, renderer, controller, layout, env, audio, budget, boat, get composer() { return composer; } };
  loop();
})();
