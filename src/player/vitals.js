import { clamp } from '../core/util.js';

/**
 * Your own health (Alpha 0.9): zombies claw you, long falls and explosions hurt. It comes back
 * slowly once you stop getting hurt. At 0 you go down: a short death screen, then you respawn at
 * the map's start.
 */
export class PlayerVitals {
  constructor({ player, audio, onDeath, onRespawn }) {
    this.player = player; this.audio = audio; this.onDeath = onDeath; this.onRespawn = onRespawn;
    this.max = 100; this.hp = 100;
    this.dead = false; this.deadT = 0;
    this.sinceHurt = 99; this.flash = 0; this.beatT = 0;
    this.god = false;   // tests / debugging
    this.armor = 0;     // VS Undead: body armour soaks up most of a hit until it is used up
    this.regen = 7;     // health back per second, a few seconds after the last hit
    this.lockRespawn = '';   // VS Undead, with friends: no respawning until the wave is cleared
    const hud = document.getElementById('hud');
    this.bar = document.createElement('div');
    this.bar.id = 'health';
    this.bar.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.2 5.2 3 1.6-1.8 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z" fill="currentColor"/></svg><div class="hb"><i></i><u></u><s></s></div><b>100</b>';
    hud.appendChild(this.bar);
    this.hurtEl = document.createElement('div');
    this.hurtEl.id = 'hurt';
    document.body.insertBefore(this.hurtEl, hud);
    this.deathEl = document.createElement('div');
    this.deathEl.id = 'death';
    this.deathEl.className = 'hidden';
    this.deathEl.innerHTML = '<div class="dc"><h2>You died</h2><p class="cause"></p><button type="button">Respawn</button><small class="desk-only">or press Space</small></div>';
    document.body.appendChild(this.deathEl);
    this.deathEl.querySelector('button').addEventListener('click', () => this.respawn());
    this.hideDeathScreen = false;   // VS Undead alone: its own game-over screen instead
    this.ui = { fill: this.bar.querySelector('.hb i'), lag: this.bar.querySelector('.hb u'), arm: this.bar.querySelector('.hb s'), num: this.bar.querySelector('b'), cause: this.deathEl.querySelector('.cause'), btn: this.deathEl.querySelector('button'), h2: this.deathEl.querySelector('h2'), small: this.deathEl.querySelector('small') };
    this.lagHp = 100;
  }

  /** Take damage. kind: 'zombie' | 'fall' | 'blast'. */
  hurt(amount, { kind = 'hit' } = {}) {
    if (this.dead || this.god || amount <= 0) return;
    if (this.armor > 0) {
      const soak = Math.min(this.armor, amount * 0.65);
      this.armor -= soak; amount -= soak;
      if (this.armor <= 0) { this.armor = 0; this.audio.play('clink'); }
    }
    this.hp = Math.max(0, this.hp - amount);
    this.sinceHurt = 0;
    this.flash = Math.min(1, this.flash + 0.35 + amount / 40);
    this.player.shake = Math.min(1, (this.player.shake || 0) + 0.4 + amount / 50);
    this.audio.play(kind === 'zombie' ? 'bite' : 'hurt', kind === 'zombie' ? 0.7 : 1);
    if (kind === 'zombie') this.audio.play('hurt', 0.7);
    if (this.hp <= 0) this.die(kind);
  }

  die(kind) {
    this.dead = true; this.deadT = 0;
    this.ui.cause.textContent = (kind === 'zombie' ? 'The zombies got you.' : kind === 'fall' ? 'You fell too far.' : kind === 'blast' ? 'You were too close to the blast.' : 'You were killed.') + (this.lockRespawn ? ` ${this.lockRespawn}` : '');
    this.ui.h2.textContent = this.lockRespawn ? 'You\'re down' : 'You died';
    this.ui.btn.classList.toggle('hidden', !!this.lockRespawn);
    this.ui.small.classList.toggle('hidden', !!this.lockRespawn);

    this.audio.play('flatline', 0.8);
    document.body.classList.add('dead');
    this.onDeath?.(kind);
  }

  respawn(force = false) {
    if (!this.dead) return;
    if (this.lockRespawn && !force) return;
    this.dead = false; this.hp = this.max; this.lagHp = this.max; this.flash = 0; this.sinceHurt = 99;
    this.player.down = 0;
    this.deathEl.classList.add('hidden');
    document.body.classList.remove('dead');
    this.onRespawn?.();
  }

  /** Full health again (map change, cleanup). */
  reset() { if (this.dead) this.respawn(); this.hp = this.max; this.lagHp = this.max; this.flash = 0; }

  update(dt, { input, playing, show }) {
    this.sinceHurt += dt;
    if (this.dead) {
      this.deadT += dt;
      this.player.down = Math.min(1, this.deadT / 0.9);
      if (this.deadT > 1.1 && !this.hideDeathScreen) this.deathEl.classList.remove('hidden');
      if (this.deadT > 1.3 && playing && !this.lockRespawn && !this.hideDeathScreen && input.wasPressed('Space')) this.respawn();
    } else if (this.sinceHurt > 5 && this.hp < this.max) this.hp = Math.min(this.max, this.hp + dt * this.regen);
    // heartbeat when badly hurt
    if (!this.dead && this.hp < 30 && playing) {
      this.beatT -= dt;
      if (this.beatT <= 0) { this.beatT = 0.65 + this.hp / 60; this.audio.play('heartbeat', 0.8); }
    }
    this.flash = Math.max(0, this.flash - dt * 1.6);
    const low = this.dead ? 0.9 : clamp((45 - this.hp) / 45) * (0.55 + 0.15 * Math.sin(performance.now() / 260));
    const op = Math.max(this.flash, low);
    this.hurtEl.style.opacity = op.toFixed(3);
    // the bar: shown in a level with zombies, or while you're hurt
    this.lagHp += (this.hp - this.lagHp) * Math.min(1, dt * (this.lagHp > this.hp ? 2.5 : 20));
    const vis = show || this.hp < this.max || this.dead;
    this.bar.classList.toggle('off', !vis);
    if (vis) {
      this.ui.fill.style.transform = `scaleX(${(this.hp / this.max).toFixed(3)})`;
      this.ui.lag.style.transform = `scaleX(${(this.lagHp / this.max).toFixed(3)})`;
      const n = String(Math.ceil(this.hp));
      if (this.ui.num.textContent !== n) this.ui.num.textContent = n;
      this.bar.classList.toggle('low', this.hp < 30);
      this.ui.arm.style.transform = `scaleX(${(this.armor / 100).toFixed(3)})`;
      this.bar.classList.toggle('armored', this.armor > 0);
    }
  }
}
