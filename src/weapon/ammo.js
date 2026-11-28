// Spare ammunition. In the sandbox it never runs out; in VS Undead every round counts: what's
// left in your pouches is shown next to the magazine, and the merchant and supply drops refill it.

export const AMMO_NAMES = {
  pistol: '.45 rounds', rifle: '5.56 rounds', shells: '12 gauge shells', sniper: '7.62 rounds', ball: 'musket balls',
  grenade: 'grenades', mine: 'mines', turret: 'sentry guns',
};

export const AMMO = {
  finite: false,
  pools: { pistol: 0, rifle: 0, shells: 0, sniper: 0, ball: 0, grenade: 0, mine: 0, turret: 0 },
  onChange: null,
  has(type, n = 1) { return !this.finite || (this.pools[type] || 0) >= n; },
  /** Take up to n; returns how many you got. */
  take(type, n) {
    if (!this.finite) return n;
    const got = Math.min(n, this.pools[type] || 0);
    this.pools[type] = (this.pools[type] || 0) - got;
    if (got) this.onChange?.(type);
    return got;
  },
  give(type, n) { this.pools[type] = (this.pools[type] || 0) + n; this.onChange?.(type); },
  count(type) { return this.finite ? this.pools[type] || 0 : Infinity; },
  label(type) { return this.finite ? String(this.pools[type] || 0) : '∞'; },
  reset(finite, start = {}) {
    this.finite = finite;
    for (const k of Object.keys(this.pools)) this.pools[k] = start[k] || 0;
    this.onChange?.(null);
  },
};
