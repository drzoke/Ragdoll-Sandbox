// Multiplayer text chat. T or Enter opens the line at the bottom left, Enter sends, Esc closes.
// Messages fade out after a while; with the line open the last ones show again (and scroll).
// The game's keys are off while you type (see main.js), so WASD and the number keys type letters.

const $ = (id) => document.getElementById(id);
const MAX_LEN = 140;
const SHOW_FOR = 12000;        // ms a message stays on screen
const KEEP = 60;               // messages kept in the box

export class Chat {
  constructor({ audio, onSend, onOpenChange }) {
    this.audio = audio; this.onSend = onSend; this.onOpenChange = onOpenChange;
    this.isOpen = false;
    this.el = $('chat');
    this.log = $('chat-log');
    this.input = $('chat-in');
    this.form = $('chat-form');
    this.input.maxLength = MAX_LEN;
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();          // not a game key while typing
      if (e.key === 'Enter') { e.preventDefault(); this.send(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === 'Tab') e.preventDefault();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.send(); });
    $('chat-send').addEventListener('click', (e) => { e.preventDefault(); this.send(); });
    this.input.addEventListener('blur', () => { if (this.isOpen && !this.sending) setTimeout(() => { if (this.isOpen && document.activeElement !== this.input) this.close(); }, 0); });
    setInterval(() => this.fade(), 1000);
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.el.classList.add('open');
    this.input.value = '';
    // the key that opened it (T) mustn't land in the box
    setTimeout(() => { if (this.isOpen) { this.input.value = ''; this.input.focus(); } }, 0);
    this.log.scrollTop = this.log.scrollHeight;
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    this.input.blur();
    this.fade();
    this.onOpenChange?.(false);
  }

  send() {
    const text = this.input.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    this.sending = true;
    if (text) this.onSend?.(text);
    this.input.value = '';
    this.sending = false;
    this.close();
  }

  /** A player's message. */
  add(name, color, text) {
    const line = document.createElement('div');
    line.className = 'cl';
    const who = document.createElement('b');
    who.textContent = name;
    who.style.color = color || '#fff';
    const what = document.createElement('span');
    what.textContent = text;
    line.append(who, what);
    this.push(line);
    this.audio?.play('chat');
  }

  /** A note from the game (someone joined or left, a wave began...). */
  system(text) {
    const line = document.createElement('div');
    line.className = 'cl sys';
    line.textContent = text;
    this.push(line);
  }

  push(line) {
    line.dataset.t = String(performance.now());
    this.log.appendChild(line);
    while (this.log.children.length > KEEP) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this.el.classList.add('has');
  }

  /** Old messages fade (unless the line is open). */
  fade() {
    const now = performance.now();
    let any = false;
    for (const l of this.log.children) {
      const old = now - Number(l.dataset.t) > SHOW_FOR;
      l.classList.toggle('old', old);
      if (!old) any = true;
    }
    this.el.classList.toggle('quiet', !any);
  }

  clear() { this.log.innerHTML = ''; this.el.classList.remove('has'); }
}
