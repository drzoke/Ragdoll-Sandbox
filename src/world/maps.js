import { RANGE } from './range.js';
import { TOWER } from './tower.js';
import { CEMETERY } from './cemetery.js';

/** Every map you can pick in the menu, in menu order (hidden: only for a game mode). */
export const MAPS = [RANGE, TOWER, CEMETERY];
export const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));
