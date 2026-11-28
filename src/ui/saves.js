// Saved scenes, kept in this browser (localStorage), so nothing has to be copied anywhere: the
// Saves panel in the menu lists them with a picture, and Load puts the map, every ragdoll and
// zombie (pose, wounds, missing limbs, health), the vehicles and where you stood back.
// "Last session" is saved by itself when you close or leave the page.

const INDEX = 'ragdollSaves1';
const PREFIX = 'ragdollSave1:';
const MAX_SAVES = 24;
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export class Saves {
  /**
   * game: { capture() -> data, apply(data), thumb(cb), canSave() -> '' or why not, canLoad() -> '' or why not,
   *         mapName(id), audio, hud }
   */
  constructor(game) {
    this.g = game;
    this.el = { list: $('save-list'), name: $('save-name'), btn: $('save-new'), note: $('save-note') };
    this.confirm = null;
    this.el.btn.addEventListener('click', () => this.saveNew());
    this.el.name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.saveNew(); });
    this.el.list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.closest('[data-id]').dataset.id;
      this.g.audio.unlock();
      if (b.dataset.act === 'load') this.load(id);
      else if (b.dataset.act === 'over') this.ask(id, 'over', () => this.save(id));
      else if (b.dataset.act === 'del') this.ask(id, 'del', () => this.remove(id));
    });
  }

  index() {
    try { return JSON.parse(localStorage.getItem(INDEX) || '[]'); } catch { return []; }
  }
  writeIndex(list) { localStorage.setItem(INDEX, JSON.stringify(list)); }

  /** Two clicks for anything that throws a save away. */
  ask(id, act, fn) {
    const key = `${id}|${act}`;
    if (this.confirm === key) { this.confirm = null; fn(); return; }
    this.confirm = key;
    this.g.audio.play('click');
    this.render();
    clearTimeout(this.confirmT);
    this.confirmT = setTimeout(() => { this.confirm = null; this.render(); }, 3000);
  }

  saveNew() {
    const why = this.g.canSave();
    if (why) { this.g.audio.play('deny'); this.g.hud.toast(why); return; }
    const list = this.index().filter((s) => !s.auto);
    if (list.length >= MAX_SAVES) { this.g.audio.play('deny'); this.g.hud.toast(`You have ${MAX_SAVES} saves: delete one (or overwrite it) first.`); return; }
    this.save(null, this.el.name.value.trim().slice(0, 40));
    this.el.name.value = '';
  }

  /** Save the scene as it is now (a new save, or over an old one). */
  save(id = null, name = '', { auto = false, quiet = false } = {}) {
    if (!auto) { const why = this.g.canSave(); if (why) { this.g.audio.play('deny'); this.g.hud.toast(why); return false; } }
    const data = this.g.capture();
    const list = this.index();
    const old = id ? list.find((s) => s.id === id) : null;
    id = id || (auto ? 'auto' : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
    const entry = {
      id, auto, t: Date.now(), map: data.map,
      name: name || old?.name || (auto ? 'Last session' : `${this.g.mapName(data.map)} · ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`),
      n: data.rags.filter((r) => !r.z).length, nz: data.rags.filter((r) => r.z).length, nv: data.vehicles.length,
      thumb: old?.thumb || '',
    };
    const write = (thumb) => {
      if (thumb) entry.thumb = thumb;
      try {
        localStorage.setItem(PREFIX + id, JSON.stringify(data));
        const l = this.index().filter((s) => s.id !== id);
        l.unshift(entry);
        this.writeIndex(l);
      } catch (e) {
        if (!quiet) { this.g.audio.play('deny'); this.g.hud.toast('The browser\'s storage is full: delete a few saves and try again.'); }
        console.warn('[saves]', e);
        return false;
      }
      if (!quiet) { this.g.audio.play('beepGood'); this.g.hud.toast(old ? `Saved over "${entry.name}"` : `Saved "${entry.name}"`); }
      this.render();
      return true;
    };
    // a small picture of the scene, taken right after the next frame is drawn
    if (auto) return write(null);
    this.g.thumb((url) => write(url));
    return true;
  }

  load(id) {
    const why = this.g.canLoad();
    if (why) { this.g.audio.play('deny'); this.g.hud.toast(why); return; }
    let data = null;
    try { data = JSON.parse(localStorage.getItem(PREFIX + id) || 'null'); } catch { data = null; }
    const entry = this.index().find((s) => s.id === id);
    if (!data) { this.g.audio.play('deny'); this.g.hud.toast('That save can\'t be read any more.'); return; }
    this.g.audio.play('click');
    this.g.apply(data);
    this.g.hud.toast(`Loaded "${entry?.name || 'save'}"`);
  }

  remove(id) {
    localStorage.removeItem(PREFIX + id);
    this.writeIndex(this.index().filter((s) => s.id !== id));
    this.g.audio.play('click');
    this.render();
  }

  /** The Saves panel. */
  render() {
    const list = this.index();
    const saveWhy = this.g.canSave(), loadWhy = this.g.canLoad();
    this.el.btn.disabled = !!saveWhy;
    this.el.note.textContent = saveWhy || loadWhy || '';
    this.el.note.classList.toggle('hidden', !(saveWhy || loadWhy));
    if (!list.length) { this.el.list.innerHTML = '<p class="note">No saves yet. Set up a scene, open this menu and press Save.</p>'; return; }
    this.el.list.innerHTML = list.map((s) => {
      const what = [s.n && `${s.n} ragdoll${s.n > 1 ? 's' : ''}`, s.nz && `${s.nz} zombie${s.nz > 1 ? 's' : ''}`, s.nv && `${s.nv} vehicle${s.nv > 1 ? 's' : ''}`].filter(Boolean).join(', ') || 'empty';
      const over = this.confirm === `${s.id}|over`, del = this.confirm === `${s.id}|del`;
      return `<div class="save${s.auto ? ' auto' : ''}" data-id="${esc(s.id)}">
        <div class="pic">${s.thumb ? `<img src="${s.thumb}" alt="">` : ''}</div>
        <div class="txt"><b>${esc(s.name)}</b><span>${esc(this.g.mapName(s.map))} · ${what}</span><small>${ago(s.t)}</small></div>
        <div class="acts"><button data-act="load" class="go" ${loadWhy ? 'disabled' : ''}>Load</button>
          ${s.auto ? '' : `<button data-act="over" ${saveWhy ? 'disabled' : ''} class="${over ? 'warn' : ''}">${over ? 'Sure?' : 'Save over'}</button>`}
          <button data-act="del" class="${del ? 'warn' : ''}">${del ? 'Sure?' : 'Delete'}</button></div></div>`;
    }).join('');
  }
}
