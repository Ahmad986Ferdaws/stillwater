// Circle colliders in a spatial hash (trees, rocks, landmark pillars).
const CELL = 8;
const map = new Map();
const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;

export const colliders = {
  add(x, z, r) {
    const c = { x, z, r };
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = key(cx, cz);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
  },
  // Push a circle (px, pz, pr) out of any overlapping collider. Returns the corrected position.
  resolve(pos, pr) {
    const list = map.get(key(Math.floor(pos.x / CELL), Math.floor(pos.z / CELL)));
    if (!list) return pos;
    for (const c of list) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + pr;
      if (d < min && d > 1e-5) { pos.x = c.x + (dx / d) * min; pos.z = c.z + (dz / d) * min; }
    }
    return pos;
  },
};

// Walkable platforms (the dock deck, bench base...). Oriented rectangles.
export const platforms = [];
export function platformHeight(x, z) {
  let best = -Infinity;
  for (const p of platforms) {
    const dx = x - p.x, dz = z - p.z;
    const lx = dx * Math.cos(p.angle) - dz * Math.sin(p.angle);
    const lz = dx * Math.sin(p.angle) + dz * Math.cos(p.angle);
    if (Math.abs(lx) <= p.hw && Math.abs(lz) <= p.hl) best = Math.max(best, p.y);
  }
  return best;
}
