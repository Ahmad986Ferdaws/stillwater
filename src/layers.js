// Render layers shared by every module.
//  WORLD  – terrain, trees, rocks, landmarks, characters, fish (everything solid). Casts shadows.
//  WATER  – lake + waterfall surfaces. Never drawn into reflection/refraction passes.
//  GRASS  – grass blades, flowers, tiny ground clutter. Skipped by reflection/refraction for speed.
//  FX     – transparent particles, rings, sprites. Skipped by reflection/refraction.
// The main camera sees all layers. The sun's shadow camera only sees WORLD.
export const LAYERS = { WORLD: 0, WATER: 1, GRASS: 2, FX: 3 };
