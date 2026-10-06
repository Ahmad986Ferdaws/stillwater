import * as THREE from 'three';
import { softDot } from './water.js';
import { WATER } from './terrain.js';
import { LAYERS } from '../layers.js';

// Small pooled effects that make movement feel physical: dust puffs, grass flicks,
// water droplets and expanding rings on the lake.

const vert = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const frag = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
}`;

const COLORS = {
  path: new THREE.Color('#e2d0a6'), sand: new THREE.Color('#efe2bd'), grass: new THREE.Color('#dfe9c4'),
  bits: new THREE.Color('#79b24a'), water: new THREE.Color('#f2fbff'), wood: new THREE.Color('#d8c3a0'),
};

export function createFX(scene, camera, renderer) {
  const N = 600;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N), col = new Float32Array(N * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 800 }, uMap: { value: null } }]),
    vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, fog: true,
  });
  mat.uniforms.uMap.value = softDot();
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.layers.set(LAYERS.FX);
  scene.add(points);

  const P = Array.from({ length: N }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s0: 0, s1: 0, a0: 0, g: 0, drag: 0, c: null }));
  let head = 0;
  function spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, c, g, drag) {
    const p = P[head]; head = (head + 1) % N;
    Object.assign(p, { life, max: life, x, y, z, vx, vy, vz, s0, s1, a0, c, g, drag });
  }
  const rnd = (a, b) => a + Math.random() * (b - a);

  function puff(p, count, color, spread = 0.9, sizeMul = 1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(0.3, spread);
      spawn(p.x + Math.cos(a) * 0.15, p.y + 0.05, p.z + Math.sin(a) * 0.15, Math.cos(a) * sp, rnd(0.35, 0.9), Math.sin(a) * sp,
        rnd(0.6, 1.0), 0.28 * sizeMul, rnd(0.7, 1.0) * sizeMul, 0.42, color, 0.4, 2.6);
    }
  }
  function bits(p, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(0.4, 1.1);
      spawn(p.x, p.y + 0.08, p.z, Math.cos(a) * sp, rnd(1.6, 2.8), Math.sin(a) * sp, rnd(0.45, 0.7), 0.09, 0.07, 1, COLORS.bits, 9, 0.6);
    }
  }
  function drops(p, count, power = 1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(0.6, 1.7) * power;
      spawn(p.x + Math.cos(a) * 0.2, WATER + 0.05, p.z + Math.sin(a) * 0.2, Math.cos(a) * sp, rnd(2.0, 3.8) * power, Math.sin(a) * sp,
        rnd(0.5, 0.8), rnd(0.1, 0.17), 0.08, 0.9, COLORS.water, 12, 0.3);
    }
  }

  // Rings on the water surface
  const rings = [];
  const ringGeo = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, fog: true }));
    m.visible = false;
    m.renderOrder = 2;
    m.layers.set(LAYERS.FX);
    scene.add(m);
    rings.push({ m, life: 0, max: 1, size: 1 });
  }
  let ringHead = 0;
  function ring(p, sizeTo = 1.6, life = 1.5) {
    const r = rings[ringHead]; ringHead = (ringHead + 1) % rings.length;
    r.m.position.set(p.x, WATER + 0.03, p.z);
    r.life = r.max = life; r.size = sizeTo; r.m.visible = true;
  }

  const size2 = new THREE.Vector2();
  return {
    step(surface, p, strength) {
      if (surface === 'water') { drops(p, Math.round(4 + 4 * strength), 0.7); ring(p, 1.1 + strength * 0.6); return; }
      if (surface === 'wood') return;
      if (surface === 'path' || surface === 'sand') puff(p, Math.round(2 + 4 * strength), COLORS[surface], 0.6 + 0.5 * strength, 0.7 + 0.4 * strength);
      else if (strength > 0.9) { puff(p, 2, COLORS.grass, 0.7, 0.7); bits(p, 3); }
      else if (Math.random() < 0.5) bits(p, 1);
    },
    land(p, impact, surface) {
      const k = Math.min(1.6, impact / 8);
      if (surface === 'water') { drops(p, 14, 1 + k * 0.4); ring(p, 2.4); ring(p, 1.4, 1.2); return; }
      const c = COLORS[surface] || COLORS.grass;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3, sp = rnd(1.4, 2.6) * (0.7 + k * 0.5);
        spawn(p.x + Math.cos(a) * 0.25, p.y + 0.06, p.z + Math.sin(a) * 0.25, Math.cos(a) * sp, rnd(0.2, 0.6), Math.sin(a) * sp,
          rnd(0.7, 1.0), 0.35, 1.1, surface === 'grass' ? 0.3 : 0.5, c, 0.3, 3.2);
      }
      if (surface === 'grass') bits(p, 6);
    },
    splash(p, strength = 1) {
      drops(p, Math.round(8 + 10 * strength), 0.8 + strength * 0.4);
      ring(p, 1.4 + strength); ring(p, 0.9 + strength * 0.5, 1.1);
    },
    ring,
    update(dt) {
      renderer.getDrawingBufferSize(size2);
      mat.uniforms.uScale.value = size2.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
      for (let i = 0; i < N; i++) {
        const p = P[i];
        if (p.life <= 0) { alpha[i] = 0; size[i] = 0; continue; }
        p.life -= dt;
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.g * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.c === COLORS.water && p.y < WATER) p.life = 0;
        const t = 1 - Math.max(p.life, 0) / p.max;
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        size[i] = p.s0 + (p.s1 - p.s0) * t;
        alpha[i] = p.a0 * (1 - t) * (1 - t);
        col[i * 3] = p.c.r; col[i * 3 + 1] = p.c.g; col[i * 3 + 2] = p.c.b;
      }
      geo.attributes.position.needsUpdate = geo.attributes.aSize.needsUpdate = geo.attributes.aAlpha.needsUpdate = geo.attributes.aColor.needsUpdate = true;
      for (const r of rings) {
        if (r.life <= 0) { r.m.visible = false; continue; }
        r.life -= dt;
        const t = 1 - Math.max(r.life, 0) / r.max;
        r.m.scale.setScalar(0.25 + (r.size - 0.25) * (1 - (1 - t) * (1 - t)));
        r.m.material.opacity = 0.5 * (1 - t) * (1 - t);
      }
    },
  };
}
