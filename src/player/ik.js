import * as THREE from 'three';

// Analytic two-bone IK (hip → knee → ankle). Keeps the knee bending toward `pole`.

const _H = new THREE.Vector3(), _K = new THREE.Vector3(), _A = new THREE.Vector3();
const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _bq = new THREE.Quaternion();
const _cur = new THREE.Vector3(), _want = new THREE.Vector3(), _bp = new THREE.Vector3();

// Rotate `bone` (minimally) so the direction to its child `childLocal` points at `target`.
export function aimBone(bone, childLocal, target) {
  bone.parent.getWorldQuaternion(_pq);
  _bq.copy(_pq).multiply(bone.quaternion);
  bone.getWorldPosition(_bp);
  _cur.copy(childLocal).normalize().applyQuaternion(_bq);
  _want.subVectors(target, _bp).normalize();
  _q.setFromUnitVectors(_cur, _want);
  _bq.premultiply(_q);
  bone.quaternion.copy(_pq.invert().multiply(_bq));
  bone.updateMatrixWorld(true);
}

// Returns how far (world units) the target was out of reach, so the caller can lower the pelvis.
export function solveTwoBone(upper, lower, end, target, pole) {
  upper.getWorldPosition(_H);
  lower.getWorldPosition(_K);
  end.getWorldPosition(_A);
  const a = _H.distanceTo(_K), b = _K.distanceTo(_A);
  _d.subVectors(target, _H);
  const want = _d.length();
  const dist = THREE.MathUtils.clamp(want, Math.abs(a - b) + 1e-4, a + b - 1e-4);
  _u.copy(_d).divideScalar(want || 1);
  const cosA = THREE.MathUtils.clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _v.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1).addScaledVector(_u, -_u.z);
  _v.normalize();
  const knee = _K.copy(_H).addScaledVector(_u, a * cosA).addScaledVector(_v, a * sinA);
  aimBone(upper, lower.position, knee);
  const reach = _A.copy(_H).addScaledVector(_u, dist);
  aimBone(lower, end.position, reach);
  return Math.max(0, want - (a + b - 1e-4));
}
