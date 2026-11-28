// Connections between players: WebRTC data channels, set up through PeerJS's free public broker
// (lib/peerjs.min.js, MIT, loaded the first time multiplayer is used). The broker only introduces
// the browsers to each other; game data goes straight between them.
//
// Each link has two channels:
//   - reliable and in order (PeerJS's own channel): events and requests, as JSON text, split into
//     pieces when long;
//   - unreliable and unordered (a second channel on the same connection): body positions and
//     player movement, as binary, many times a second. A lost one is simply replaced by the next.
//
// Tests and self-hosting can point it at another broker: ?peer=host:port (plain ws), ?ice=none.

const PREFIX = 'ragdoll-sandbox-';      // the broker is shared with other apps: room ids are prefixed
const CHUNK = 15000;                    // characters per reliable message (stays under every browser's limit)
const FAST_ID = 7;                      // id of the unreliable channel (PeerJS's own gets 0 or 1)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I mix-ups

let loading = null;
function loadPeerJS() {
  if (window.peerjs?.Peer) return Promise.resolve(window.peerjs.Peer);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../lib/peerjs.min.js', import.meta.url).href;
    s.onload = () => (window.peerjs?.Peer ? resolve(window.peerjs.Peer) : reject(new Error('The multiplayer library did not load')));
    s.onerror = () => { loading = null; reject(new Error('Could not load the multiplayer library (offline?)')); };
    document.head.appendChild(s);
  });
  return loading;
}

// How two browsers find a way to each other:
//  - STUN: each one asks a public server what its address looks like from the internet. Enough for
//    most home networks, and the game data then goes straight between the two computers.
//  - TURN: a relay for when a direct path can't be made (phone hotspots, some home routers, school
//    and office networks that block it). The game data then goes through the relay. Two free public
//    relays are listed: Metered's Open Relay (ports 80 and 443, plain and over TLS, which gets
//    through most firewalls; it signs short-lived logins with a published shared secret) and PeerJS's.
const OPEN_RELAY = 'staticauth.openrelay.metered.ca';
const OPEN_RELAY_SECRET = 'openrelayprojectsecret';
async function relayLogin() {
  // the standard TURN "REST API" login: user = expiry time, password = HMAC-SHA1(secret, user)
  const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:ragdoll-sandbox`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(OPEN_RELAY_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username)));
  return { username, credential: btoa(String.fromCharCode(...sig)) };
}
async function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  try {
    const login = await relayLogin();
    list.push({ urls: [`turn:${OPEN_RELAY}:80`, `turn:${OPEN_RELAY}:80?transport=tcp`, `turn:${OPEN_RELAY}:443`, `turns:${OPEN_RELAY}:443?transport=tcp`], ...login });
  } catch (e) { console.warn('[net] no relay login', e); }
  list.push({ urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' });
  return list;
}

async function peerOptions() {
  const q = new URLSearchParams(location.search);
  const o = { debug: 0 };
  const srv = q.get('peer');
  if (srv) {
    const [host, port] = srv.split(':');
    Object.assign(o, { host, port: Number(port) || 9000, path: '/', secure: false });
  }
  o.config = { iceServers: q.get('ice') === 'none' ? [] : await iceServers(), sdpSemantics: 'unified-plan' };
  return o;
}

export function randomCode(n = 5) {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(n));
  for (let i = 0; i < n; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

/** Plain-language text for PeerJS errors. */
export function errorText(err) {
  switch (err?.type) {
    case 'peer-unavailable': return 'No room with that code. Check the code, and that your friend is still hosting.';
    case 'unavailable-id': return 'That room code is taken.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return "Couldn't reach the matchmaking server. Check your internet connection.";
    case 'browser-incompatible': return "This browser can't do peer-to-peer connections (WebRTC).";
    case 'webrtc': case 'ice-failed':
      return "Couldn't find a way between your computer and your friend's (even through the relay). A strict network (school, office, some phone hotspots) can block it: try another network.";
    default: return err?.message || String(err || 'Connection failed');
  }
}

/**
 * One connection to another player. onMessage(obj) for reliable messages, onFast(ArrayBuffer)
 * for the unreliable ones, onClose() once.
 */
export class Link {
  constructor(conn) {
    this.conn = conn;
    this.peerId = conn.peer;
    this.open = false;
    this.closed = false;
    this.fast = null;
    this.parts = new Map();          // pieces of long messages being put back together
    this.nextChunk = 1;
    this.lastHeard = performance.now();
    this.rtt = 0;
    this.sentBytes = 0; this.recvBytes = 0;
    this.onMessage = null; this.onFast = null; this.onClose = null; this.onOpen = null;
    conn.on('open', () => this.opened());
    conn.on('data', (d) => this.received(d));
    conn.on('close', () => this.close());
    conn.on('error', () => this.close());
    if (conn.open) this.opened();
  }

  opened() {
    if (this.open) return;
    this.open = true;
    this.lastHeard = performance.now();
    try {
      const dc = this.conn.peerConnection.createDataChannel('fast', { negotiated: true, id: FAST_ID, ordered: false, maxRetransmits: 0 });
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (e) => { this.lastHeard = performance.now(); this.recvBytes += e.data.byteLength || 0; this.onFast?.(e.data); };
      this.fast = dc;
    } catch (err) { console.warn('[net] no unreliable channel, using the reliable one', err); }
    // a peer that vanished without closing (tab killed, network gone) is noticed by the silence
    this.watch = setInterval(() => {
      if (performance.now() - this.lastHeard > 9000) this.close();
      else this.send({ t: 'ping', ts: performance.now() });
    }, 1000);
    this.onOpen?.();
  }

  received(d) {
    this.lastHeard = performance.now();
    if (typeof d !== 'string') { this.recvBytes += d.byteLength || 0; this.onFast?.(d); return; }   // fast data on the slow path (fallback)
    this.recvBytes += d.length;
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.$c) {
      // a piece of a long message
      let p = this.parts.get(m.$c);
      if (!p) { p = { n: m.n, got: 0, s: new Array(m.n) }; this.parts.set(m.$c, p); }
      if (p.s[m.i] === undefined) { p.s[m.i] = m.d; p.got++; }
      if (p.got < p.n) return;
      this.parts.delete(m.$c);
      try { m = JSON.parse(p.s.join('')); } catch { return; }
    }
    if (m.t === 'ping') { this.send({ t: 'pong', ts: m.ts }); return; }
    if (m.t === 'pong') { const r = performance.now() - m.ts; this.rtt = this.rtt ? this.rtt + (r - this.rtt) * 0.2 : r; return; }
    this.onMessage?.(m);
  }

  /** Bytes waiting to go out on the reliable channel. */
  get backlog() { return this.conn.dataChannel?.bufferedAmount || 0; }

  /** Reliable, in order. */
  send(obj) {
    if (!this.open || this.closed) return;
    const s = JSON.stringify(obj);
    try {
      if (s.length <= CHUNK) { this.conn.send(s); this.sentBytes += s.length; return; }
      const id = this.nextChunk++, n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) this.conn.send(JSON.stringify({ $c: id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
      this.sentBytes += s.length;
    } catch (err) { console.warn('[net] send failed', err); }
  }

  /** Unreliable: dropped when the channel is backed up (the next one replaces it anyway). */
  sendFast(buf) {
    if (!this.open || this.closed) return;
    const dc = this.fast;
    try {
      if (dc && dc.readyState === 'open') {
        if (dc.bufferedAmount > 256 * 1024) return;
        dc.send(buf);
      } else {
        const raw = this.conn.dataChannel;
        if (!raw || raw.readyState !== 'open' || raw.bufferedAmount > 256 * 1024) return;
        raw.send(buf);
      }
      this.sentBytes += buf.byteLength;
    } catch { /* closing */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    clearInterval(this.watch);
    try { this.fast?.close(); } catch { /* already */ }
    try { this.conn.close(); } catch { /* already */ }
    this.onClose?.();
  }
}

/**
 * Open a room as its host. Resolves with { peer, code }; onLink(link) for each player joining.
 * Tries a few codes if one is taken.
 */
export async function openRoom(onLink, code = null) {
  const Peer = await loadPeerJS();
  const opts = await peerOptions();
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = code || randomCode();
    try {
      const peer = await new Promise((resolve, reject) => {
        const p = new Peer(PREFIX + c, opts);
        const fail = (e) => { p.destroy(); reject(e); };
        p.once('open', () => { p.off('error', fail); resolve(p); });
        p.once('error', fail);
      });
      peer.on('connection', (conn) => onLink(new Link(conn)));
      // lost the broker (not the players): keep the room joinable
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500); });
      peer.on('error', (e) => console.warn('[net] broker', e?.type || e));
      return { peer, code: c };
    } catch (e) {
      lastErr = e;
      if (e?.type !== 'unavailable-id' || code) break;
    }
  }
  throw lastErr;
}

/** Join a room by its code. Resolves with { peer, link } once the connection is open. */
export async function joinRoom(code) {
  const Peer = await loadPeerJS();
  const opts = await peerOptions();
  const peer = await new Promise((resolve, reject) => {
    const p = new Peer(undefined, opts);
    const fail = (e) => { p.destroy(); reject(e); };
    p.once('open', () => { p.off('error', fail); resolve(p); });
    p.once('error', fail);
  });
  try {
    const link = await new Promise((resolve, reject) => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
      // a relayed connection can take a while to set up
      const timer = setTimeout(() => reject({ type: 'timeout', message: "The host's computer didn't answer. Check the code; if it's right, one of your networks may be blocking the connection: try another network." }), 30000);
      peer.once('error', (e) => { clearTimeout(timer); reject(e); });
      // no way through at all: say so straight away instead of waiting for the timeout
      const watchIce = () => {
        const pc = conn.peerConnection;
        if (!pc) { setTimeout(watchIce, 200); return; }
        pc.addEventListener('iceconnectionstatechange', () => {
          if (pc.iceConnectionState === 'failed') { clearTimeout(timer); reject({ type: 'ice-failed' }); }
        });
      };
      watchIce();
      const link = new Link(conn);
      link.onOpen = () => { clearTimeout(timer); resolve(link); };
    });
    // once connected, the broker is no longer needed
    peer.on('error', (e) => console.warn('[net] broker', e?.type || e));
    return { peer, link };
  } catch (e) {
    peer.destroy();
    throw e;
  }
}
