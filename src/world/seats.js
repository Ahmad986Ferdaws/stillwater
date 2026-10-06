import { heightAt, layout, LAKE } from './terrain.js';

// Places you can sit: the bench on the hill, and the end of the old dock (legs over the water).
// Numbers mirror the geometry in landmarks.js (bench seat top ≈ 0.55 m, dock deck ≈ 1.1 m).
export function getSeats() {
  const seats = [];
  const b = layout.landmarks.find((l) => l.id === 'bench');
  if (b) {
    const face = Math.atan2(LAKE.x - b.x, LAKE.z - b.z);
    const g = heightAt(b.x, b.z);
    seats.push({ kind: 'bench', label: 'Sit on the bench', x: b.x + Math.sin(face) * 0.16, z: b.z + Math.cos(face) * 0.16, y: g, yaw: face, hipsY: g + 0.66, reach: 1.9 });
  }
  const d = layout.dock;
  if (d) {
    const L = 21.6;
    const x = d.x + d.dirX * L, z = d.z + d.dirZ * L;
    seats.push({ kind: 'edge', label: 'Sit on the edge', x, z, y: 1.1, yaw: Math.atan2(d.dirX, d.dirZ), hipsY: 1.2, reach: 2.2 });
  }
  return seats;
}
