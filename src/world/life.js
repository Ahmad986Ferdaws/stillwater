import * as THREE from 'three';
import { heightAt, biome, WATER } from './terrain.js';
import { softDot } from './water.js';
import { LAYERS } from '../layers.js';

// Small living things: butterflies, birds overhead, drifting petals and pollen, fireflies at dusk.

function wingGeo(w, h) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(w * 0.4, h * 0.9, w * 1.1, h * 0.8, w, h * 0.1);
  s.bezierCurveTo(w * 0.9, -h * 0.6, w * 0.3, -h * 0.7, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  g.rotateX(-Math.PI / 2);
  return g;
}

export function createLife(scene) {
  const tmpM = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);

  // --- Butterflies
  const BN = 28;
  const bMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  const wingL = new THREE.InstancedMesh(wingGeo(0.13, 0.11), bMat, BN);
  const wR = wingGeo(0.13, 0.11); wR.scale(-1, 1, 1);
  const wingR = new THREE.InstancedMesh(wR, bMat, BN);
  const palette = ['#ffd24d', '#ffffff', '#f59ac0', '#8cc8f5', '#ff9a4a', '#c4a4ff'].map((c) => new THREE.Color(c));
  const butterflies = [];
  for (let i = 0; i < BN; i++) {
    const c = palette[i % palette.length];
    wingL.setColorAt(i, c); wingR.setColorAt(i, c);
    butterflies.push({ pos: new THREE.Vector3(0, -100, 0), vel: new THREE.Vector3(), target: new THREE.Vector3(), phase: Math.random() * 10, t: 0 });
  }
  for (const m of [wingL, wingR]) { m.frustumCulled = false; scene.add(m); }

  // --- Birds (a loose flock circling high)
  const BD = 9;
  const birdMat = new THREE.MeshBasicMaterial({ color: '#3a3a44', side: THREE.DoubleSide, fog: true });
  const bw = new THREE.PlaneGeometry(0.9, 0.28); bw.translate(0.45, 0, 0); bw.rotateX(-Math.PI / 2);
  const bwR = bw.clone(); bwR.scale(-1, 1, 1);
  const birdL = new THREE.InstancedMesh(bw, birdMat, BD), birdR = new THREE.InstancedMesh(bwR, birdMat, BD);
  for (const m of [birdL, birdR]) { m.frustumCulled = false; scene.add(m); }
  const birds = Array.from({ length: BD }, (_, i) => ({ off: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 18), ph: Math.random() * 10 }));
  const flock = { center: new THREE.Vector3(-40, 55, -60), angle: 0 };

  // --- Particles: petals, pollen, fireflies
  function cloud(count, size, color, opacity, blending = THREE.NormalBlending) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const m = new THREE.PointsMaterial({ size, color, transparent: true, opacity, map: softDot(), depthWrite: false, blending, sizeAttenuation: true, fog: true });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.layers.set(LAYERS.FX);
    scene.add(pts);
    const seeds = Array.from({ length: count }, () => ({ x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, ph: Math.random() * 10, life: Math.random() }));
    return { pts, seeds, m };
  }
  const petals = cloud(220, 0.16, '#ffc4d6', 0.95);
  const pollen = cloud(260, 0.07, '#fff6d0', 0.8, THREE.AdditiveBlending);
  const flies = cloud(140, 0.28, '#fff08a', 0.0, THREE.AdditiveBlending);

  function respawn(s, c, rad, yMin, yMax) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * rad;
    s.x = c.x + Math.cos(a) * r; s.z = c.z + Math.sin(a) * r;
    s.y = Math.max(heightAt(s.x, s.z), WATER) + yMin + Math.random() * (yMax - yMin);
  }

  return {
    // Nearest butterfly the traveller could watch (for the head look-at).
    nearest(p, radius) {
      let best = null, bd = radius * radius;
      for (const b of butterflies) {
        if (b.pos.y < -50) continue;
        const d = b.pos.distanceToSquared(p);
        if (d < bd) { bd = d; best = b.pos; }
      }
      return best;
    },
    update(dt, time, player, env) {
      // Butterflies wander near the player over land
      butterflies.forEach((b, i) => {
        if (b.pos.distanceTo(player) > 42 || b.pos.y < -50) {
          const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 28;
          b.pos.set(player.x + Math.cos(a) * r, 0, player.z + Math.sin(a) * r);
          const h = heightAt(b.pos.x, b.pos.z);
          if (h < 1.5 || biome(b.pos.x, b.pos.z).mountain > 0.3) { b.pos.y = -100; }
          else b.pos.y = h + 0.8 + Math.random();
          b.t = 0;
        }
        b.t -= dt;
        if (b.t <= 0) {
          b.target.set(b.pos.x + (Math.random() - 0.5) * 8, 0, b.pos.z + (Math.random() - 0.5) * 8);
          b.target.y = heightAt(b.target.x, b.target.z) + 0.5 + Math.random() * 1.6;
          b.t = 1.5 + Math.random() * 2.5;
        }
        const d = p.copy(b.target).sub(b.pos);
        b.vel.lerp(d.normalize().multiplyScalar(1.4), Math.min(1, dt * 1.5));
        b.pos.addScaledVector(b.vel, dt);
        b.pos.y += Math.sin(time * 7 + b.phase) * dt * 0.6;
        const yaw = Math.atan2(b.vel.x, b.vel.z);
        const flap = Math.sin(time * 16 + b.phase) * 1.1;
        for (const [m, s] of [[wingL, 1], [wingR, -1]]) {
          e.set(0, yaw, 0, 'YXZ');
          q.setFromEuler(e);
          const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s * (flap + 0.3));
          q.multiply(qq);
          const hide = b.pos.y < -50 ? 0.0001 : 1;
          tmpM.compose(b.pos, q, sc.setScalar(hide));
          m.setMatrixAt(i, tmpM);
        }
      });
      wingL.instanceMatrix.needsUpdate = wingR.instanceMatrix.needsUpdate = true;

      // Birds circle the lake, drifting
      flock.angle += dt * 0.05;
      flock.center.set(-40 + Math.cos(flock.angle) * 140, 58 + Math.sin(time * 0.1) * 6, -60 + Math.sin(flock.angle) * 140);
      const heading = flock.angle + Math.PI / 2;
      birds.forEach((b, i) => {
        p.copy(flock.center).add(b.off);
        p.x += Math.sin(time * 0.3 + b.ph) * 3; p.y += Math.sin(time * 0.5 + b.ph) * 1.5;
        const flap = Math.sin(time * 5 + b.ph) * 0.6 * (Math.sin(time * 0.4 + b.ph) > 0.3 ? 1 : 0.15);
        for (const [m, s] of [[birdL, 1], [birdR, -1]]) {
          e.set(0, -heading, s * flap, 'YXZ');
          q.setFromEuler(e);
          tmpM.compose(p, q, sc.setScalar(1.6));
          m.setMatrixAt(i, tmpM);
        }
      });
      birdL.instanceMatrix.needsUpdate = birdR.instanceMatrix.needsUpdate = true;

      // Petals fall slowly and spin near the player (more near the lake's cherry trees)
      const pa = petals.pts.geometry.attributes.position.array;
      petals.seeds.forEach((s, i) => {
        s.life -= dt * 0.08;
        if (s.life <= 0 || s.y < heightAt(s.x, s.z) - 0.2 || Math.hypot(s.x - player.x, s.z - player.z) > 34) {
          respawn(s, player, 30, 2, 9); s.life = 1;
          s.vx = 0.35 + Math.random() * 0.3; s.vz = 0.15 + Math.random() * 0.2;
        }
        s.x += (s.vx + Math.sin(time * 1.3 + s.ph) * 0.4) * dt;
        s.z += (s.vz + Math.cos(time * 1.1 + s.ph) * 0.3) * dt;
        s.y -= (0.35 + Math.sin(time * 2 + s.ph) * 0.2) * dt;
        pa[i * 3] = s.x; pa[i * 3 + 1] = s.y; pa[i * 3 + 2] = s.z;
      });
      petals.pts.geometry.attributes.position.needsUpdate = true;

      const po = pollen.pts.geometry.attributes.position.array;
      pollen.seeds.forEach((s, i) => {
        s.life -= dt * 0.1;
        if (s.life <= 0 || Math.hypot(s.x - player.x, s.z - player.z) > 26) { respawn(s, player, 24, 0.3, 5); s.life = 1; }
        s.x += Math.sin(time * 0.5 + s.ph) * 0.15 * dt + 0.1 * dt;
        s.y += Math.sin(time * 0.7 + s.ph * 2) * 0.08 * dt;
        s.z += Math.cos(time * 0.4 + s.ph) * 0.15 * dt;
        po[i * 3] = s.x; po[i * 3 + 1] = s.y; po[i * 3 + 2] = s.z;
      });
      pollen.pts.geometry.attributes.position.needsUpdate = true;
      pollen.m.opacity = 0.35 + 0.45 * (1 - env.golden * 0.5);

      flies.m.opacity = env.golden * 0.95;
      if (env.golden > 0.02) {
        const fa = flies.pts.geometry.attributes.position.array;
        flies.seeds.forEach((s, i) => {
          if (s.y < -50 || Math.hypot(s.x - player.x, s.z - player.z) > 30) respawn(s, player, 28, 0.3, 2.5);
          s.x += Math.sin(time * 0.6 + s.ph) * 0.4 * dt;
          s.z += Math.cos(time * 0.5 + s.ph * 1.3) * 0.4 * dt;
          s.y += Math.sin(time * 0.9 + s.ph) * 0.2 * dt;
          const blink = Math.max(0, Math.sin(time * 1.7 + s.ph * 3));
          fa[i * 3] = s.x; fa[i * 3 + 1] = s.y + (blink > 0.1 ? 0 : -200); fa[i * 3 + 2] = s.z;
        });
        flies.pts.geometry.attributes.position.needsUpdate = true;
      }
    },
  };
}
