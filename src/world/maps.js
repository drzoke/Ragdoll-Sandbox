import { RANGE } from './range.js';
import { TOWER } from './tower.js';

/** Every map you can pick in the menu, in menu order. */
export const MAPS = [RANGE, TOWER];
export const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));
