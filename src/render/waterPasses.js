import * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { LAYERS } from '../layers.js';

// Lake pre-pass. It is added as the FIRST pass of the EffectComposer (see setupPost in main.js) and
// renders the textures the lake shader composites itself from:
//   level 0  nothing (the lake uses its cheap single-pass shader)
//   level 1  refraction: LAYERS.WORLD *below* the water plane (oblique near plane = the water), at
//            refrScale, colour (mipmapped, for depth blur) + a 32F depth texture (thickness, contact foam)
//   level 2  + planar reflection: LAYERS.WORLD *above* the water seen from the mirrored camera, at
//            reflScale, every `reflEvery` frames, only while the camera is within reflMaxDist of the water
//            and water covers at least reflMinCover of the screen (else the shader's analytic sky is used)
// Nothing renders while the lake is outside the view frustum. The shadow map is never re-rendered here
// (the main RenderPass does it once per frame). Objects wholly above the water are hidden for the
// refraction render and objects wholly below it for the reflection render, and `exclude` (e.g. grass
// still on the WORLD layer) is hidden for both. Render targets follow composer.setSize()/setPixelRatio
// via setSize(), quantised to 32 px so dynamic resolution does not reallocate them every frame.
// renderer.info is reset at the start of each frame (setupPost turns autoReset off) so the fps
// overlay shows whole-frame totals including these passes.

const REFR_BIAS = 0.2; // refraction keeps geometry up to this far above the water (hides shoreline seams)
// Extra layer the mirror camera renders besides LAYERS.WORLD: the waterfall and its mist (they live on
// WATER / FX for the main view) so they reflect in the lake.
export const MIRROR_LAYER = 5;
const COVER_X = 8, COVER_Y = 6; // screen rays for the water-coverage estimate

const _plane = new THREE.Plane();
const _normal = new THREE.Vector3();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _color = new THREE.Color();
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

// Replace the near plane of cam's projection with a world-space plane (Lengyel's oblique frustum).
// The kept half-space is the plane's positive side; the camera must be on its negative side.
export function obliqueClip(cam, plane, clipBias = 0) {
  _plane.copy(plane).applyMatrix4(cam.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const e = cam.projectionMatrix.elements;
  _q.x = (Math.sign(_clip.x) + e[8]) / e[0];
  _q.y = (Math.sign(_clip.y) + e[9]) / e[5];
  _q.z = -1.0;
  _q.w = (1.0 + e[10]) / e[14];
  _clip.multiplyScalar(2.0 / _clip.dot(_q));
  e[2] = _clip.x;
  e[6] = _clip.y;
  e[10] = _clip.z + 1.0 - clipBias;
  e[14] = _clip.w;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

function worldBox(o) {
  let bb = null;
  if (o.isInstancedMesh || o.isBatchedMesh) {
    if (o.boundingBox === null) o.computeBoundingBox();
    bb = o.boundingBox;
  } else if (o.geometry) {
    if (o.geometry.boundingBox === null) o.geometry.computeBoundingBox();
    bb = o.geometry.boundingBox;
  }
  if (!bb || bb.isEmpty()) return null;
  return _box.copy(bb).applyMatrix4(o.matrixWorld);
}

// Instanced props whose single-instance geometry is under ~2.4 m tall (bushes, ferns, rocks, reeds,
// lilies, mushrooms): barely readable in a rippled mirror, but many triangles.
const _smallCache = new WeakMap();
function isSmallProp(o) {
  if (!o.isInstancedMesh) return false;
  const g = o.geometry;
  let v = _smallCache.get(g);
  if (v === undefined) {
    if (g.boundingBox === null) g.computeBoundingBox();
    v = g.boundingBox.max.y - g.boundingBox.min.y < 2.4;
    _smallCache.set(g, v);
  }
  return v;
}

function makeTarget(withDepth) {
  const rt = new THREE.WebGLRenderTarget(32, 32, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    samples: 0,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthTexture: withDepth ? new THREE.DepthTexture(32, 32, THREE.FloatType) : null,
  });
  rt.texture.name = withDepth ? 'water.refraction' : 'water.reflection';
  return rt;
}

const quant = (v) => Math.max(32, Math.round(v / 32) * 32);

export class WaterPass extends Pass {
  /**
   * @param {object} o
   * @param {THREE.Mesh} o.lake         lake surface
   * @param {object} o.uniforms         shared lake uniforms (receives textures + matrices each frame)
   * @param {THREE.Mesh} [o.sky]        sky dome, skipped in the refraction render
   * @param {THREE.Box3} [o.bounds]     world box of the actual water (defaults to the lake mesh bounds)
   * @param {Function} [o.isWater]      (x, z) => true where there is water (for the coverage estimate)
   * @param {object} [o.terrainParts]   { terrain, bed, ring }: the terrain mesh and two subsets of it (lake
   *                                    bed / land around the lake) drawn instead of it in these renders
   */
  constructor({ lake, uniforms, sky = null, bounds = null, isWater = null, terrainParts = null }) {
    super();
    this.needsSwap = false;
    this.clear = false;
    this.lake = lake;
    this.u = uniforms;
    this.sky = sky;
    this.bounds = bounds;
    this.isWater = isWater;
    this.terrainParts = terrainParts;
    this.scene = null;
    this.camera = null;
    this.level = 0;
    // --- cost knobs
    this.refrScale = 0.5; // refraction resolution relative to the composer target
    this.reflScale = 0.4; // reflection resolution
    this.reflEvery = 2; // render the mirror every Nth frame (it is sampled with its own matrix)
    this.reflMaxDist = 170; // metres from the camera to the nearest water beyond which the mirror is skipped
    this.reflMinCover = 0.04; // fraction of the screen that must be water for the mirror to be worth it
    this.reflCrop = true; // render the mirror only for the part of the screen where water is
    this.reflSmallProps = false; // include small instanced props (bushes, ferns, rocks, reeds) in the mirror
    this.reflBeyond = 150; // metres past the far side of the lake that still get mirrored
    this.exclude = []; // hidden in both renders (grass/flowers still on the WORLD layer)
    // ---
    this.width = 2;
    this.height = 2;
    this.refrRT = null;
    this.reflRT = null;
    this.refrCam = new THREE.PerspectiveCamera();
    this.reflCam = new THREE.PerspectiveCamera();
    this.refrCam.layers.set(LAYERS.WORLD);
    this.reflCam.layers.set(LAYERS.WORLD);
    this.reflCam.layers.enable(MIRROR_LAYER);
    this.clearColor = new THREE.Color(0.02, 0.11, 0.13); // "deep water" behind anything clipped away
    this.frustum = new THREE.Frustum();
    this.lakeBox = new THREE.Box3();
    this.lakeInView = false;
    this.coverage = 0;
    this.stats = { refraction: false, reflection: false, reflectionOn: false, hiddenBelow: 0, hiddenAbove: 0 };
    this._frame = 0;
    this._sinceRefl = 1e9; // frames since the mirror was last rendered
    this._cov = new THREE.Vector4(); // water's NDC box on screen from the coverage rays (x0, y0, x1, y1)
    this._small = [];
    this._reflHold = 0;
    this._reflValid = false;
    this._objs = [];
    this._minY = [];
    this._maxY = [];
    this._hidden = [];
    this._excluded = [];
  }

  attach(scene, camera, exclude) {
    this.scene = scene;
    this.camera = camera;
    if (exclude) this.exclude = exclude.filter(Boolean);
    return this;
  }

  setLevel(level) {
    this.level = level;
    if (level >= 1 && !this.refrRT) this.refrRT = makeTarget(true);
    if (level < 1 && this.refrRT) { this.refrRT.depthTexture?.dispose(); this.refrRT.dispose(); this.refrRT = null; }
    if (level >= 2 && !this.reflRT) this.reflRT = makeTarget(false);
    if (level < 2 && this.reflRT) { this.reflRT.dispose(); this.reflRT = null; }
    this.u.uRefrTex.value = this.refrRT ? this.refrRT.texture : null;
    this.u.uDepthTex.value = this.refrRT ? this.refrRT.depthTexture : null;
    this.u.uReflTex.value = this.reflRT ? this.reflRT.texture : null;
    this.u.uReflOn.value = 0;
    this._reflValid = false;
    this._resize();
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this._resize();
  }

  _resize() {
    const refr = this.refrRT, refl = this.reflRT;
    if (refr) {
      const w = quant(this.width * this.refrScale), h = quant(this.height * this.refrScale);
      if (refr.width !== w || refr.height !== h) {
        refr.setSize(w, h);
        // RenderTarget.setSize (r184) doesn't reallocate an attached depth texture; a stale one leaves
        // the framebuffer incomplete (mismatched attachment sizes), so drop it and let three rebuild it.
        if (refr.depthTexture) {
          refr.depthTexture.dispose();
          refr.depthTexture.image.width = w;
          refr.depthTexture.image.height = h;
          refr.depthTexture.needsUpdate = true;
        }
      }
    }
    if (refl) {
      const w = quant(this.width * this.reflScale), h = quant(this.height * this.reflScale);
      if (refl.width !== w || refl.height !== h) { refl.setSize(w, h); this._reflValid = false; }
    }
  }

  dispose() {
    this.setLevel(0);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime = 1 / 60) {
    if (renderer.info.autoReset === false) renderer.info.reset();
    this.stats.refraction = this.stats.reflection = false;
    this._frame++;
    const scene = this.scene, cam = this.camera;
    if (this.level < 1 || !scene || !cam || !this.lake) return;
    this._resize(); // picks up scale knob changes; no-op otherwise

    cam.updateMatrixWorld();
    if (this.bounds) this.lakeBox.copy(this.bounds);
    else {
      this.lake.updateMatrixWorld();
      const g = this.lake.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      this.lakeBox.copy(g.boundingBox).applyMatrix4(this.lake.matrixWorld);
    }
    this.lakeBox.min.y -= 0.5;
    this.lakeBox.max.y += 0.5;
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m);
    this.lakeInView = this.lake.visible && this.frustum.intersectsBox(this.lakeBox);
    if (!this.lakeInView) { this._reflHold = 0; this.u.uReflOn.value = 0; return; }

    this.lake.updateMatrixWorld();
    const waterY = this.lake.matrixWorld.elements[13];

    // Is a mirror worth it this frame? (near the water and enough of it on screen; short hold to avoid popping)
    let reflNow = false;
    if (this.level >= 2) {
      this.coverage = this._coverage(cam, waterY);
      const near = this.lakeBox.distanceToPoint(cam.position) < this.reflMaxDist;
      if (near && this.coverage >= this.reflMinCover) this._reflHold = 0.75;
      else this._reflHold -= deltaTime;
      const on = this._reflHold > 0;
      if (!on) this._reflValid = false;
      // Every `reflEvery` frames, preferring frames where the loop does not refresh the shadow map, so
      // the two heavier jobs alternate instead of piling onto the same frame.
      const shadowFrame = renderer.shadowMap.autoUpdate || renderer.shadowMap.needsUpdate;
      this._sinceRefl++;
      reflNow = on && (!this._reflValid || this._sinceRefl >= this.reflEvery + (shadowFrame && this.reflEvery > 1 ? 1 : 0) || (this._sinceRefl >= this.reflEvery && !shadowFrame));
      this.stats.reflectionOn = on;
    }

    scene.updateMatrixWorld();
    this._scan(scene);

    const autoMatrix = scene.matrixWorldAutoUpdate;
    const autoShadow = renderer.shadowMap.autoUpdate;
    const needShadow = renderer.shadowMap.needsUpdate;
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(_color);
    const prevAlpha = renderer.getClearAlpha();
    const excluded = this._excluded;
    excluded.length = 0;
    for (const o of this.exclude) if (o.visible) { o.visible = false; excluded.push(o); }
    scene.matrixWorldAutoUpdate = false; // updated once above for both renders
    // Never render the shadow map here: these renders hide objects, so a refresh requested for this
    // frame (shadowMap.needsUpdate) is left for the main RenderPass, which sees the whole scene.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    try {
      this._refraction(renderer, scene, cam, waterY);
      if (reflNow) this._reflection(renderer, scene, cam, waterY);
    } finally {
      for (const o of excluded) o.visible = true;
      excluded.length = 0;
      scene.matrixWorldAutoUpdate = autoMatrix;
      renderer.shadowMap.autoUpdate = autoShadow;
      renderer.shadowMap.needsUpdate = needShadow;
      renderer.setClearColor(_color, prevAlpha);
      renderer.setRenderTarget(prevTarget);
    }
    this.u.uReflOn.value = this.level >= 2 && this._reflHold > 0 && this._reflValid ? 1 : 0;
  }

  // Fraction of a coarse grid of screen rays that hit actual water (ignores occlusion by hills); also
  // records the screen box of those rays (+ one cell of margin) for cropping the mirror.
  _coverage(cam, waterY) {
    const b = this.lakeBox;
    let hits = 0, i0 = COVER_X, i1 = -1, j0 = COVER_Y, j1 = -1;
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    if (oy <= waterY) return 0;
    for (let j = 0; j < COVER_Y; j++) {
      for (let i = 0; i < COVER_X; i++) {
        _v.set(((i + 0.5) / COVER_X) * 2 - 1, ((j + 0.5) / COVER_Y) * 2 - 1, 0.5).unproject(cam);
        const dx = _v.x - ox, dy = _v.y - oy, dz = _v.z - oz;
        if (dy >= -1e-6) continue;
        const t = (waterY - oy) / dy;
        const x = ox + dx * t, z = oz + dz * t;
        if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
        if (this.isWater && !this.isWater(x, z)) continue;
        hits++;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
    }
    if (hits) {
      this._cov.set(
        Math.max(-1, ((i0 - 1) / COVER_X) * 2 - 1), Math.max(-1, ((j0 - 1) / COVER_Y) * 2 - 1),
        Math.min(1, ((i1 + 2) / COVER_X) * 2 - 1), Math.min(1, ((j1 + 2) / COVER_Y) * 2 - 1),
      );
    } else this._cov.set(-1, -1, 1, 1);
    return hits / (COVER_X * COVER_Y);
  }

  // World-space vertical extent of every culled WORLD-layer drawable, once per frame.
  _scan(scene) {
    const objs = this._objs, minY = this._minY, maxY = this._maxY, small = this._small;
    objs.length = minY.length = maxY.length = small.length = 0;
    const mask = this.refrCam.layers;
    scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints) || !o.frustumCulled || !o.layers.test(mask)) return;
      const bb = worldBox(o);
      if (!bb) return;
      objs.push(o);
      minY.push(bb.min.y);
      maxY.push(bb.max.y);
      small.push(isSmallProp(o));
    });
  }

  // Hide objects entirely above `above` (if not null) or entirely below `below` (if not null), and
  // optionally small instanced props.
  _hide(above, below, hideSmall = false) {
    const hidden = this._hidden;
    hidden.length = 0;
    for (let i = 0; i < this._objs.length; i++) {
      if ((above !== null && this._minY[i] > above) || (below !== null && this._maxY[i] < below) || (hideSmall && this._small[i])) {
        hidden.push(this._objs[i]);
        this._objs[i].visible = false;
      }
    }
    return hidden.length;
  }

  _unhide() {
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
  }

  // Draw `part` (a subset of the terrain) instead of the whole terrain. Returns an undo function state.
  _swapTerrain(part) {
    const tp = this.terrainParts;
    if (!tp || !part || !tp.terrain.visible || tp.terrain.parent === null || tp.terrain.geometry !== tp.geometry) return false;
    part.material = tp.terrain.material; // follow any material swap on the terrain
    tp.terrain.visible = false;
    part.visible = true;
    return true;
  }
  _restoreTerrain(part, swapped) {
    if (!swapped) return;
    part.visible = false;
    this.terrainParts.terrain.visible = true;
  }

  _renderTo(renderer, scene, cam, rt, clearColor) {
    renderer.setRenderTarget(rt);
    if (clearColor) renderer.setClearColor(clearColor, 1);
    if (!renderer.autoClear) renderer.clear();
    renderer.render(scene, cam);
  }

  _lakeFar(cam) {
    const b = this.lakeBox;
    let far = 0;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      far = Math.max(far, _v.distanceTo(cam.position));
    }
    return far + 20;
  }

  _refraction(renderer, scene, cam, waterY) {
    const rc = this.refrCam;
    rc.position.copy(cam.position);
    rc.quaternion.copy(cam.quaternion);
    rc.scale.copy(cam.scale);
    rc.fov = cam.fov;
    rc.aspect = cam.aspect;
    rc.zoom = cam.zoom;
    rc.near = cam.near;
    rc.far = Math.max(cam.near * 10, Math.min(cam.far, this._lakeFar(cam)));
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld();
    const top = waterY + Math.min(REFR_BIAS, cam.position.y - waterY - 0.15);
    if (top > waterY + 0.01) {
      _plane.setFromNormalAndCoplanarPoint(_normal.set(0, -1, 0), _v.set(0, top, 0));
      obliqueClip(rc, _plane, 0);
    }
    this.stats.hiddenAbove = this._hide(top + 0.05, null);
    const skyWasVisible = this.sky ? this.sky.visible : false;
    if (this.sky) this.sky.visible = false;
    const bed = this.terrainParts && this.terrainParts.bed;
    const swapped = this._swapTerrain(bed);
    try {
      this._renderTo(renderer, scene, rc, this.refrRT, this.clearColor);
    } finally {
      this._restoreTerrain(bed, swapped);
      if (this.sky) this.sky.visible = skyWasVisible;
      this._unhide();
    }
    const e = rc.projectionMatrix.elements;
    this.u.uRefrRow.value.set(e[2], e[6], e[10], e[14]);
    this.u.uProjXY.value.set(e[0], e[5]);
    this.u.uRefrTex.value = this.refrRT.texture;
    this.u.uDepthTex.value = this.refrRT.depthTexture;
    this.stats.refraction = true;
  }

  _reflection(renderer, scene, cam, waterY) {
    const rc = this.reflCam;
    // Mirror the eye, view direction and up vector across the water plane (a proper camera, no flip).
    _v.setFromMatrixPosition(cam.matrixWorld);
    rc.position.set(_v.x, 2 * waterY - _v.y, _v.z);
    _v2.set(0, 0, -1).transformDirection(cam.matrixWorld);
    _v2.y = -_v2.y;
    rc.up.set(0, 1, 0).transformDirection(cam.matrixWorld);
    rc.up.y = -rc.up.y;
    rc.lookAt(rc.position.x + _v2.x, rc.position.y + _v2.y, rc.position.z + _v2.z);
    rc.fov = cam.fov;
    rc.aspect = cam.aspect;
    rc.zoom = cam.zoom;
    rc.near = cam.near;
    // Far scenery is nearly fog/horizon coloured anyway: stop a little past the lake (the sky dome
    // ignores far, it is drawn at depth 1 via xyww).
    rc.far = Math.min(cam.far, this._lakeFar(cam) + this.reflBeyond);
    if (scene.fog && scene.fog.isFog) rc.far = Math.min(rc.far, scene.fog.far + 80);
    // Only the part of the view where water is on screen (mirrored horizontally in this camera).
    const c = this._cov;
    if (this.reflCrop && (c.x > -1 || c.y > -1 || c.z < 1 || c.w < 1)) {
      const u0 = (1 - c.z) * 0.5, u1 = (1 - c.x) * 0.5, v0 = (c.y + 1) * 0.5, v1 = (c.w + 1) * 0.5;
      rc.setViewOffset(1, 1, u0, 1 - v1, u1 - u0, v1 - v0);
    } else if (rc.view !== null) rc.clearViewOffset();
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld();
    this.u.uReflMatrix.value.copy(BIAS).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    _plane.setFromNormalAndCoplanarPoint(_normal.set(0, 1, 0), _v.set(0, waterY, 0));
    obliqueClip(rc, _plane, 0);
    this.stats.hiddenBelow = this._hide(null, waterY - 0.05, !this.reflSmallProps);
    const ring = this.terrainParts && this.terrainParts.ring;
    const swapped = this._swapTerrain(ring);
    try {
      this._renderTo(renderer, scene, rc, this.reflRT, null);
    } finally {
      this._restoreTerrain(ring, swapped);
      this._unhide();
    }
    this.u.uReflTex.value = this.reflRT.texture;
    this._reflValid = true;
    this._sinceRefl = 0;
    this.stats.reflection = true;
  }
}
