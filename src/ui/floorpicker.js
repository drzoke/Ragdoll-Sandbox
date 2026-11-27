/**
 * The elevator's floor buttons as a window: opened from the panel inside the car. Frees the mouse
 * like the toolbox; picking a floor closes it and the ride starts.
 */
export class FloorPicker {
  constructor({ audio, onOpenChange }) {
    this.audio = audio;
    this.onOpenChange = onOpenChange;
    this.isOpen = false;
    const el = document.createElement('div');
    el.id = 'floor-picker';
    el.className = 'hidden';
    el.innerHTML = `<div class="fp-card">
      <header><h2>Elevator</h2><span class="desk-only">Click a floor · Esc to close</span><span class="touch-only">Tap a floor</span><button class="fp-x" aria-label="Close">✕</button></header>
      <div class="fp-grid"></div>
      <p class="fp-note">The roof isn't on the elevator: take the ladder on floor 20.</p>
    </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.grid = el.querySelector('.fp-grid');
    el.querySelector('.fp-x').addEventListener('click', () => this.close());
    el.addEventListener('pointerdown', (e) => { if (e.target === el) this.close(); });
    this.grid.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b || !this.opts) return;
      const i = Number(b.dataset.i), pick = this.opts.onPick;
      this.close();
      pick?.(i);
    });
  }

  open(opts) {
    this.opts = opts;
    const { labels, current } = opts;
    // top floor first, the lobby last (like a real panel read top-down)
    const order = labels.map((l, i) => i).reverse();
    this.grid.innerHTML = order.map((i) => `<button data-i="${i}" class="${i === current ? 'here' : ''}${i === 0 ? ' lobby' : ''}">${i === 0 ? 'Lobby' : labels[i]}${i === current ? '<small>You are here</small>' : ''}</button>`).join('');
    this.el.classList.remove('hidden');
    if (!this.isOpen) { this.isOpen = true; this.onOpenChange?.(true); }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.onOpenChange?.(false);
  }
}
