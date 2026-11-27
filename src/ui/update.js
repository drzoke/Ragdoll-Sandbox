// Tells you when a newer version of the game is online (a tab left open, or a phone that kept the
// page in memory, would otherwise keep running the old one). It reads the version label from the
// live index.html now and then and compares it with the one this page started with.

const label = (root) => {
  const v = root.querySelector('#version');
  return v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
};

export function watchForUpdates({ hud, every = 120 }) {
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  const mine = label(document);
  const note = document.getElementById('update-note');
  let shown = false, busy = false;
  async function check() {
    if (busy || shown || document.hidden) return;
    busy = true;
    try {
      const res = await fetch(`index.html?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const live = label(doc);
      if (live && mine && live !== mine) {
        shown = true;
        const nice = live.replace(/(Alpha [\d.]+) ?(Patch \d+)?/, (m, a, p) => p ? `${a}, ${p}` : a);
        note.querySelector('span').textContent = `A newer version is out (${nice}).`;
        note.classList.remove('hidden');
        hud.toast(`A newer version is out (${nice}). Reload from the menu to get it.`);
      }
    } catch { /* offline */ } finally { busy = false; }
  }
  note.querySelector('button').addEventListener('click', () => location.reload());
  setTimeout(check, 8000);
  setInterval(check, every * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
