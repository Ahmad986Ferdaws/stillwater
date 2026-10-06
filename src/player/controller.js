import * as THREE from 'three';
import { heightAt, pathDist, BOUND, WATER } from '../world/terrain.js';
import { colliders, platformHeight } from '../world/colliders.js';
import { CHAR_SCALE } from './characters.js';
import { Animator } from './animator.js';
import { Cloth } from './cloth.js';

// Movement physics + the traveller's modes.
//  free  – walk / jog (Shift) / hop (Space); swim with breaststroke, Shift for a fast front crawl
//  sit   – C: sit in the grass (also happens by itself when you stand still for a while)
//  lie   – Z: lie back and watch the sky
//  wave  – V: say hello
//  seat  – E near the bench or the end of the dock
//  fish  – E facing open water
//  boat  – E beside the rowboat: W/S row, A/D turn, Shift pull harder, E near land to step out
// Any movement key gets you back up.

const WALK = 2.0, RUN = 4.2, SWIM = 1.8, SWIM_FAST = 3.8, GRAV = 20, JUMP = 6.2; // speeds matched to the motion capture
const RADIUS = 0.42;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _probe = new THREE.Vector3();
const _want = new THREE.Vector3();
const _hips = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _boatQ = new THREE.Quaternion(), _turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export function groundAt(x, z) {
  return Math.max(heightAt(x, z), platformHeight(x, z));
}

export class Controller {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.camYaw = 0;
    this.camPitch = 0.24;
    this.camDist = 5.2;
    this.distTarget = 5.2;
    this.target = new THREE.Vector3();
    this.grounded = true;
    this.swimming = false;
    this.wade = 0;
    this.slope = 0;
    this.speed = 0;
    this.time = 0;
    this.rig = null;
    this.animator = null;
    this.enabled = false;
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.jumped = false;
    this.landed = 0;
    this.lookAt = null;
    this.fovKick = 0;
    this.mode = 'free';
    this.modeT = 0;
    this.seat = null;
    this.seats = [];
    this.fishing = null;
    this.fishState = null;
    this.boat = null;
    this.boatInput = { fwd: 0, turn: 0, strong: false };
    this.onBoard = null;
    this.mouseT = 0;
    this.prompt = null;
    this.onStep = null;
    this.onSplash = null;
    this.onLand = null;
    this.onStroke = null;
    this.onPrompt = null;

    addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' && this.enabled) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this.camYaw -= e.movementX * 0.0022;
      this.camPitch = clamp(this.camPitch + e.movementY * 0.0018, -0.3, 1.25);
      this.mouseT = 0;
    });
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.distTarget = clamp(this.distTarget * (e.deltaY > 0 ? 1.1 : 0.9), 2.4, 14);
    }, { passive: true });
  }

  setRig(rig, scene) {
    if (this.rig?.cloth) for (const c of this.rig.cloth) c.mesh.removeFromParent();
    this.rig = rig;
    rig.root.scale.setScalar(CHAR_SCALE);
    rig.root.position.copy(this.pos);
    rig.root.rotation.y = this.yaw;
    rig.root.updateMatrixWorld(true);
    this.animator = new Animator(rig);
    if (rig.furShells) rig.furShells = rig.furShells.filter((s) => !s.userData.trim); // trims belong to the old cloth
    rig.lodOn = undefined;
    rig.cloth = rig.clothDefs.map((d) => new Cloth(d, rig, CHAR_SCALE));
    for (const c of rig.cloth) scene.add(c.mesh);
    this.animator.cloth = rig.cloth;
    this.animator.onFootstep = (i, p, strength) => this.onStep && this.onStep(this.surfaceAt(p), p, strength);
    this.animator.onStroke = (p, fast) => this.onStroke && this.onStroke(p, fast);
    this.fishing?.attachRod(rig);
    if (this.mode === 'fish') this.setMode('free');
  }

  place(x, z, yaw) {
    this.pos.set(x, groundAt(x, z), z);
    this.yaw = yaw;
    this.camYaw = yaw + Math.PI;
    this.target.copy(this.pos).add(new THREE.Vector3(0, 1.6, 0));
    this.vel.set(0, 0, 0);
    this.setMode('free');
  }

  get inBoat() { return this.mode === 'boat'; }

  setMode(m, data) {
    if (this.mode === 'fish' && m !== 'fish') this.fishing?.stop();
    if (this.mode === 'boat' && m !== 'boat' && this.boat) this.boat.st.occupied = false;
    this.mode = m;
    this.modeT = 0;
    this.seat = m === 'seat' ? data : null;
  }

  surfaceAt(p) {
    const ter = heightAt(p.x, p.z), plat = platformHeight(p.x, p.z);
    if (plat > ter && this.pos.y >= plat - 0.25) return 'wood';
    if (this.swimming || ter < WATER - 0.04) return 'water';
    if (pathDist(p.x, p.z) < 1.8) return 'path';
    if (ter < 1.7) return 'sand';
    return 'grass';
  }

  swimY() { return WATER - (this.rig ? this.rig.P.swimDepth : 0.8) * CHAR_SCALE; }

  // What E would do right now (shown as a prompt).
  findInteraction() {
    if (this.mode === 'boat') {
      const spot = this.boat.landing(this.pos);
      if (spot) return { label: 'Step out', run: () => this.leaveBoat(spot) };
      const p = this.boat.overboard(_seat);
      return { label: 'Slip into the water', run: () => this.leaveBoat({ x: p.x, y: this.swimY(), z: p.z }) };
    }
    if (this.mode === 'free' && this.boat && (this.grounded || this.swimming) && this.boat.near(this.pos, this.swimming ? 2.2 : 2.9)) {
      return { label: 'Get in the boat', run: () => this.board() };
    }
    if (this.mode !== 'free' || !this.grounded || this.swimming) return null;
    for (const s of this.seats) {
      if (Math.hypot(this.pos.x - s.x, this.pos.z - s.z) < s.reach && Math.abs(this.pos.y - s.y) < 0.6) return { label: s.label, run: () => this.sitOn(s) };
    }
    if (this.fishing && this.fishing.canFish(this.pos, this.yaw)) return { label: 'Fish', run: () => { if (this.fishing.start(this.pos, this.yaw)) this.setMode('fish'); } };
    return null;
  }

  board() {
    this.setMode('boat');
    this.boat.st.occupied = true;
    this.vel.set(0, 0, 0);
    this.swimming = false;
    this.grounded = true;
    // camera over the stern, looking where the boat will go
    this.camYaw = this.boat.yaw + Math.PI;
    this.camPitch = 0.3;
    this.onBoard?.(true);
  }

  leaveBoat(spot) {
    const away = Math.atan2(spot.x - this.boat.x, spot.z - this.boat.z);
    this.setMode('free');
    this.pos.set(spot.x, spot.y, spot.z);
    this.yaw = away;
    this.vel.set(0, 0, 0);
    this.onBoard?.(false);
  }

  sitOn(seat) {
    this.setMode('seat', seat);
    this.vel.set(0, 0, 0);
  }

  update(dt) {
    const k = this.keys;
    const pressed = this.pressed;
    this.time += dt;
    this.modeT += dt;
    let ix = 0, iz = 0;
    if (this.enabled) {
      if (k.has('KeyW') || k.has('ArrowUp')) iz += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) iz -= 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) ix -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) ix += 1;
    }
    const running = k.has('ShiftLeft') || k.has('ShiftRight');
    const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);
    let dx = fx * iz - fz * ix, dz = fz * iz + fx * ix;
    const len = Math.hypot(dx, dz);
    let hasInput = len > 0;
    if (hasInput) { dx /= len; dz /= len; }

    // ---- modes & interactions ----
    if (this.enabled) {
      if (hasInput && this.mode !== 'free' && this.mode !== 'wave' && this.mode !== 'boat') this.setMode('free');
      if (pressed.has('KeyE')) {
        if (this.mode === 'boat') { const it = this.findInteraction(); if (it) it.run(); }
        else if (this.mode === 'fish') this.fishing?.press();
        else if (this.mode === 'seat') this.setMode('free');
        else { const it = this.findInteraction(); if (it) it.run(); }
      }
      if (pressed.has('KeyC') && this.grounded && !this.swimming && this.mode !== 'boat') this.setMode(this.mode === 'sit' ? 'free' : 'sit');
      if (pressed.has('KeyZ') && this.grounded && !this.swimming && this.mode !== 'boat') this.setMode(this.mode === 'lie' ? 'free' : 'lie');
      if (pressed.has('KeyV') && this.mode === 'free' && !this.swimming) this.setMode('wave');
    }
    if (this.mode === 'wave' && this.modeT > 2.2) this.setMode('free');
    if (this.mode === 'fish' && !this.fishing?.active) this.setMode('free');
    // ---- rowing: the boat takes the keys; the traveller sits on the thwart facing the stern ----
    if (this.mode === 'boat' && this.boat) {
      pressed.clear();
      const bi = this.boatInput;
      bi.fwd = this.enabled ? (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) : 0;
      bi.turn = this.enabled ? (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) : 0;
      bi.strong = running;
      this.boat.update(dt, bi);
      this.rowBoat(dt);
      return;
    }
    const locked = this.mode === 'seat' || this.mode === 'fish' || this.mode === 'lie' || this.mode === 'sit';
    if (locked) hasInput = false;

    const space = this.enabled && k.has('Space') && !locked;
    if (pressed.has('Space') && !locked) this.jumpBuffer = 0.15;
    this.jumpBuffer -= dt;
    pressed.clear();

    // ---- horizontal: finite acceleration toward the wanted velocity ----
    const ter = heightAt(this.pos.x, this.pos.z);
    const g0 = groundAt(this.pos.x, this.pos.z);
    const onPlatform = platformHeight(this.pos.x, this.pos.z) > ter + 0.05 && this.pos.y >= g0 - 0.3;
    const depth = WATER - ter;
    this.wade = !this.swimming && !onPlatform && depth > 0.12 ? clamp(depth / 1.1, 0, 1) : 0;

    let maxSpeed = hasInput ? (this.swimming ? (running ? SWIM_FAST : SWIM) : running ? RUN : WALK) : 0;
    if (hasInput && this.grounded) {
      const ahead = groundAt(this.pos.x + dx * 0.9, this.pos.z + dz * 0.9);
      this.slope = clamp((ahead - g0) / 0.9, -1, 1);
      maxSpeed *= clamp(1 - this.slope * 0.35, 0.6, 1.12);
    } else this.slope *= 0.9;
    maxSpeed *= 1 - 0.45 * this.wade;
    const sit = this.animator ? this.animator.sitting : 0;
    maxSpeed *= 1 - 0.85 * sit; // stand up before walking off

    const accel = this.swimming ? (running ? 7 : 5) : this.grounded ? (hasInput ? 17 : 22) : 6;
    let ddx = dx * maxSpeed - this.vel.x, ddz = dz * maxSpeed - this.vel.z;
    const dl = Math.hypot(ddx, ddz), maxd = accel * dt;
    if (dl > maxd) { ddx *= maxd / dl; ddz *= maxd / dl; }
    this.vel.x += ddx; this.vel.z += ddz;

    if (this.mode === 'seat' && this.seat) {
      // glide onto the seat
      const s = this.seat, kk = 1 - Math.exp(-dt * 6);
      this.pos.x += (s.x - this.pos.x) * kk; this.pos.z += (s.z - this.pos.z) * kk;
      this.vel.x = this.vel.z = 0;
    } else {
      const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
      const hNext = groundAt(nx, nz);
      const step = Math.hypot(nx - this.pos.x, nz - this.pos.z);
      const rise = step > 1e-5 ? (hNext - g0) / step : 0;
      if (rise < 1.25 || !this.grounded || this.swimming) { this.pos.x = nx; this.pos.z = nz; }
      else { this.vel.x *= 0.2; this.vel.z *= 0.2; }
      colliders.resolve(this.pos, RADIUS);
      // swim around the rowboat, not through it
      if (this.boat && this.swimming) {
        const b = this.boat, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const dx = this.pos.x - b.x, dz = this.pos.z - b.z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        const e = Math.hypot(lx / 0.95, lz / 2.0);
        if (e < 1) { const k = 1 / Math.max(e, 0.05); this.pos.x = b.x + (lx * k) * c + (lz * k) * s; this.pos.z = b.z - (lx * k) * s + (lz * k) * c; }
      }
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > BOUND) { this.pos.x *= BOUND / r; this.pos.z *= BOUND / r; }
    }

    // ---- vertical ----
    this.jumped = false;
    this.landed = 0;
    const ground = groundAt(this.pos.x, this.pos.z);
    const terHere = heightAt(this.pos.x, this.pos.z);
    const swimY = this.swimY();
    const wasSwimming = this.swimming;
    const platHere = platformHeight(this.pos.x, this.pos.z);
    this.swimming = terHere < swimY - 0.25 && this.pos.y <= swimY + 0.45 && !(platHere > terHere && this.pos.y > platHere - 0.3);
    if (this.swimming) {
      if (this.mode !== 'free') this.setMode('free');
      const bob = Math.sin(this.time * 2.1) * 0.04;
      this.pos.y += (swimY + bob - this.pos.y) * (1 - Math.exp(-dt * 5));
      this.vel.y = 0;
      this.grounded = false;
      this.coyote = 0;
      if (!wasSwimming && this.onSplash) this.onSplash(this.pos);
    } else {
      if (this.grounded) this.coyote = 0.12; else this.coyote -= dt;
      if (this.enabled && this.jumpBuffer > 0 && this.coyote > 0 && sit < 0.5 && !locked) {
        this.vel.y = JUMP; this.grounded = false; this.coyote = 0; this.jumpBuffer = 0; this.jumped = true;
      }
      const gmul = this.vel.y < 0 ? 1.6 : space ? 1 : 2.2;
      this.vel.y -= GRAV * gmul * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= ground) {
        if (!this.grounded) {
          this.landed = -this.vel.y;
          if (this.landed > 3 && this.onLand) this.onLand(this.pos, this.landed, this.surfaceAt(this.pos));
        }
        this.pos.y = ground; this.vel.y = 0; this.grounded = true;
      } else if (this.grounded && this.vel.y <= 0 && this.pos.y - ground < 0.5) {
        this.pos.y = ground;
      } else {
        this.grounded = false;
      }
    }

    // ---- facing ----
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed = hs;
    let want = this.yaw;
    if (this.mode === 'seat' && this.seat) want = this.seat.yaw;
    else if (this.mode === 'fish' && this.fishState) want = this.fishState.yaw;
    else if (hs > 0.25) want = Math.atan2(this.vel.x, this.vel.z);
    else if (hasInput) want = Math.atan2(dx, dz);
    const turn = (this.swimming ? 3.5 : this.grounded ? 11 : 5) * dt;
    this.yaw += clamp(wrap(want - this.yaw) * (1 - Math.exp(-dt * 14)), -turn, turn);

    // ---- prompt ----
    const it = this.enabled ? this.findInteraction() : null;
    const label = this.mode === 'seat' ? 'E  Stand up' : it ? `E  ${it.label}` : null;
    if (this.mode !== 'fish' && label !== this.prompt) { this.prompt = label; this.onPrompt?.(label); }
    if (this.mode === 'fish') this.prompt = '__fish';

    if (this.rig) {
      this.rig.root.position.copy(this.pos);
      this.rig.root.rotation.set(0, this.yaw, 0);
      const fs = this.fishState;
      this.animator.update(dt, {
        vel: this.vel, speed: hs, yaw: this.yaw, grounded: this.grounded, vy: this.vel.y, swimming: this.swimming,
        swimFast: running && hasInput, wade: this.wade, landed: this.landed, jumped: this.jumped, input: hasInput,
        inputYaw: hasInput ? Math.atan2(dx, dz) : null, slope: this.slope,
        lookAt: fs?.look || this.lookAt, mode: this.mode, seat: this.seat, fish: this.mode === 'fish' ? fs : null,
        expression: fs?.expression, rootY: this.pos.y, groundAt, waterY: WATER,
      });
    }
  }

  rowBoat(dt) {
    const b = this.boat;
    b.seat(_seat);
    const floor = b.floorY();
    this.pos.set(_seat.x, floor, _seat.z);
    this.yaw = b.yaw + Math.PI;
    this.vel.set(b.st.vx, 0, b.st.vz);
    this.speed = 0;
    this.grounded = true;
    this.swimming = false;
    this.slope = 0;
    const it = this.enabled ? this.findInteraction() : null;
    const label = it ? `E  ${it.label}` : null;
    if (label !== this.prompt) { this.prompt = label; this.onPrompt?.(label); }
    // let the camera settle behind the stern while rowing, unless the mouse is steering it
    this.mouseT += dt;
    const rowing = Math.abs(this.boatInput.fwd) + Math.abs(this.boatInput.turn) > 0;
    if (rowing && this.mouseT > 1.2) this.camYaw += wrap(b.yaw + Math.PI - this.camYaw) * (1 - Math.exp(-dt * 1.2));
    if (!this.rig) return;
    this.rig.root.position.copy(this.pos);
    b.tilt.getWorldQuaternion(_boatQ);
    this.rig.root.quaternion.copy(_boatQ).multiply(_turn);
    const st = b.stroke();
    this.animator.update(dt, {
      vel: this.vel, speed: 0, yaw: this.yaw, grounded: true, vy: 0, swimming: false, wade: 0, landed: 0, jumped: false, input: false,
      inputYaw: null, slope: 0, lookAt: this.lookAt, mode: 'row', rootY: floor, groundAt, floorY: floor + 0.01, waterY: -Infinity,
      row: { hipsY: _seat.y + 0.1, handles: b.handles(), phase: st.phase, rowing: st.rowing },
    });
  }

  // Idle in place (title screen): breathe, blink, look at the camera.
  idle(dt, yaw, lookAt) {
    if (!this.rig) return;
    this.yaw = yaw;
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.set(0, yaw, 0);
    this.vel.set(0, 0, 0);
    this.animator.update(dt, {
      vel: this.vel, speed: 0, yaw, grounded: true, vy: 0, swimming: false, wade: 0, landed: 0, jumped: false,
      input: false, inputYaw: null, slope: 0, lookAt, noSit: true, mode: 'free', rootY: this.pos.y, groundAt, waterY: WATER,
    });
  }

  updateCamera(dt) {
    this.camDist += (this.distTarget - this.camDist) * (1 - Math.exp(-dt * 6));
    const an = this.animator;
    const sit = an ? an.sitting : 0;
    const lie = an ? clamp(an.w.lie.x, 0, 1) : 0;
    const base = (this.rig ? this.rig.P.camHeight : 1.45) * CHAR_SCALE;
    const head = (this.swimming ? base * 0.45 : base) - sit * 0.55;
    _want.set(this.pos.x, this.pos.y + head, this.pos.z);
    if (lie > 0.01 && this.rig) {
      this.rig.hips.getWorldPosition(_hips);
      _want.lerp(_hips.setY(_hips.y + 0.35), lie);
    }
    this.target.lerp(_want, 1 - Math.exp(-dt * 10));
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const cam = this.camera.position;
    const dist = this.camDist * (1 + lie * 0.25);
    cam.set(
      this.target.x + Math.sin(this.camYaw) * cp * dist,
      this.target.y + sp * dist,
      this.target.z + Math.cos(this.camYaw) * cp * dist,
    );
    const ox = cam.x - this.target.x, oz = cam.z - this.target.z;
    for (let d = 0.8; d < dist; d += 0.4) {
      const t = d / dist;
      _probe.set(this.target.x + ox * t, 0, this.target.z + oz * t);
      const px = _probe.x, pz = _probe.z;
      colliders.resolve(_probe, 0.25);
      if (_probe.x !== px || _probe.z !== pz) {
        const kk = Math.max(0.8, d - 0.4) / dist;
        cam.set(this.target.x + ox * kk, this.target.y + (cam.y - this.target.y) * kk, this.target.z + oz * kk);
        break;
      }
    }
    const minY = Math.max(groundAt(cam.x, cam.z), WATER) + 0.45;
    if (cam.y < minY) cam.y = minY;
    this.camera.lookAt(this.target.x, this.target.y + 0.1, this.target.z);

    const runT = this.swimming ? 0 : clamp((this.speed - WALK) / (RUN - WALK), 0, 1);
    this.fovKick += (runT * 4.5 - this.fovKick) * (1 - Math.exp(-dt * 3));
    const fov = 55 + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}
