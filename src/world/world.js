// The map that is loaded right now, for code that has no map of its own (ragdoll brains, casings).
// Before a map loads, the ground is flat at y = 0.
export const WORLD = {
  map: null,
  actor: 0,          // multiplayer, hosting: the friend whose action is being run right now (0 = you)
  /** Height of the walkable floor under (x, z), highest one at or below y. */
  groundAt(x, z, y = 1e9) { return this.map ? this.map.groundAt(x, z, y) : 0; },
  /** Top of whatever is under a falling thing at (x, y, z): floors, desks, props or the ground. */
  surfaceHeight(x, y, z) { return this.map ? this.map.surfaceHeight(x, y, z) : 0; },
  /** Keep a point inside the play area (and inside the building it is in, where the map says so). */
  clampXZ(v, margin = 0, y = v.y) {
    const b = this.map?.areaAt?.(v.x, y, v.z) || this.map?.bounds;
    if (!b) return v;
    v.x = Math.min(b.maxX - margin, Math.max(b.minX + margin, v.x));
    v.z = Math.min(b.maxZ - margin, Math.max(b.minZ + margin, v.z));
    return v;
  },
};
