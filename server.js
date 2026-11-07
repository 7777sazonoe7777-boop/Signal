const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const MAX_HISTORY = 500;
const MAX_BODY = 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;


// Серверы: код -> { name, owner (uid или null), channels: [{ id, name, type: 'text' | 'voice' }] }
// Системный сервер «Ночной клуб» менять нельзя (owner = null).
const MAX_CHANNELS = 20;
const MAX_SERVERS_PER_USER = 10;
const MAX_SERVERS = 2000;
const DEFAULT_CHANNELS = [
  { id: 'игровая-комната', name: 'игровая-комната', type: 'text' },
  { id: 'общий', name: 'общий', type: 'text' },
  { id: 'знакомства', name: 'знакомства', type: 'text' },
  { id: 'музыка', name: 'музыка', type: 'text' },
  { id: 'эфир', name: 'Ночной эфир', type: 'voice' }
];
const servers = Object.create(null);
servers[DEFAULT_ROOM] = { name: 'Ночной клуб', owner: null, channels: DEFAULT_CHANNELS.map(c => Object.assign({}, c)) };

// Object.create(null) защищает от ключей вроде "__proto__"
// rooms[код][id текстового канала] = [сообщения]
const rooms = Object.create(null);
getRoom(DEFAULT_ROOM)['игровая-комната'].push({
  author: 'СИСТЕМА',
  time: '00:00',
  text: 'Сервер запущен в публичной сети! Нажмите «Пригласить друга», чтобы получить кликабельную интернет-ссылку.'
});

const emailCodes = Object.create(null);
let clients = [];

// ---------- Постоянные данные: участники комнат, друзья, история ----------
const users = Object.create(null);     // uid (секрет браузера) -> { pid, nick, friends:[pid], incoming:[pid], outgoing:[pid] }
const pidToUid = Object.create(null);  // публичный id -> uid
const members = Object.create(null);   // комната -> [uid]
const MAX_MEMBERS = 500;
const MAX_FRIENDS = 200;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function pidOf(uid) { return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 10); }
function validUid(v) { return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v); }
function validPid(v) { return typeof v === 'string' && /^[a-f0-9]{10}$/.test(v); }
function pidList(a) { return Array.isArray(a) ? a.filter(validPid).slice(0, MAX_FRIENDS) : []; }

// Хранилище: Upstash Redis (если заданы переменные окружения), иначе локальный файл data.json
const REDIS_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const KEY = 'signal:';
const dirtyRooms = new Set();
let loaded = false;
let saveTimer = null;
let saving = false;
let resave = false;

async function redis(commands) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('Upstash ответил кодом ' + res.status);
  const data = await res.json();
  data.forEach(x => { if (x && x.error) throw new Error('Upstash: ' + x.error); });
  return data.map(x => x.result);
}

function usersPart() {
  const o = {};
  Object.keys(users).forEach(uid => {
    const u = users[uid];
    o[uid] = { nick: u.nick, friends: u.friends, incoming: u.incoming, outgoing: u.outgoing, servers: u.servers };
  });
  return o;
}

function serversPart() {
  const o = {};
  Object.keys(servers).forEach(r => {
    if (r === DEFAULT_ROOM) return;
    const sv = servers[r];
    o[r] = { name: sv.name, owner: sv.owner, channels: sv.channels };
  });
  return o;
}

function scheduleSave(room) {
  if (room) dirtyRooms.add(room);
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, USE_REDIS ? 2000 : 1000);
}

async function saveNow() {
  if (!loaded) return; // пока данные не загружены, ничего не записываем, чтобы не затереть сохранённое
  if (saving) { resave = true; return; }
  saving = true;
  try {
    if (USE_REDIS) {
      const rs = Array.from(dirtyRooms);
      dirtyRooms.clear();
      const cmds = [
        ['SET', KEY + 'users', JSON.stringify(usersPart())],
        ['SET', KEY + 'members', JSON.stringify(members)],
        ['SET', KEY + 'rooms', JSON.stringify(Object.keys(rooms))],
        ['SET', KEY + 'servers', JSON.stringify(serversPart())]
      ];
      rs.forEach(r => { if (rooms[r]) cmds.push(['SET', KEY + 'msg:' + r, JSON.stringify(rooms[r])]); });
      try {
        await redis(cmds);
      } catch (e) {
        rs.forEach(r => dirtyRooms.add(r));
        throw e;
      }
    } else {
      const data = { users: usersPart(), servers: serversPart(), members: {}, messages: {} };
      Object.keys(members).forEach(r => { data.members[r] = members[r]; });
      Object.keys(rooms).forEach(r => { data.messages[r] = rooms[r]; });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, DATA_FILE);
    }
  } catch (e) {
    console.log('⚠️ Не удалось сохранить данные: ' + e.message);
  } finally {
    saving = false;
    if (resave) { resave = false; scheduleSave(); }
  }
}

function applyData(d) {
  Object.keys(d.servers || {}).forEach(r => {
    if (r === DEFAULT_ROOM || safeRoom(r) !== r) return;
    const sv = d.servers[r] || {};
    const chans = Array.isArray(sv.channels)
      ? sv.channels
          .filter(c => c && typeof c.id === 'string' && (c.type === 'text' || c.type === 'voice'))
          .slice(0, MAX_CHANNELS)
          .map(c => ({ id: String(c.id).slice(0, 32), name: cleanName(c.name, 24) || 'канал', type: c.type }))
      : [];
    if (!chans.length) return;
    servers[r] = { name: cleanName(sv.name, 24) || r, owner: validUid(sv.owner) ? sv.owner : null, channels: chans };
  });
  Object.keys(d.users || {}).forEach(uid => {
    if (!validUid(uid)) return;
    const u = d.users[uid] || {};
    users[uid] = { pid: pidOf(uid), nick: cleanNick(u.nick), friends: pidList(u.friends), incoming: pidList(u.incoming), outgoing: pidList(u.outgoing), servers: codeList(u.servers) };
    pidToUid[users[uid].pid] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    members[r] = d.members[r].filter(validUid).slice(0, MAX_MEMBERS);
  });
  Object.keys(d.messages || {}).forEach(r => {
    if (safeRoom(r) !== r || !d.messages[r] || !servers[r]) return;
    const room = getRoom(r);
    servers[r].channels.forEach(chn => {
      if (chn.type !== 'text') return;
      const ch = chn.id;
      const list = d.messages[r][ch];
      if (!Array.isArray(list)) return;
      room[ch] = list.slice(-MAX_HISTORY).map(m => ({
        author: String(m.author || '').slice(0, 24),
        time: String(m.time || '').slice(0, 5),
        text: String(m.text || '').slice(0, 1000)
      }));
    });
  });
}

async function loadData() {
  if (USE_REDIS) {
    const first = await redis([['GET', KEY + 'users'], ['GET', KEY + 'members'], ['GET', KEY + 'rooms'], ['GET', KEY + 'servers']]);
    const roomNames = (first[2] ? JSON.parse(first[2]) : []).filter(n => safeRoom(n) === n);
    const msgs = roomNames.length ? await redis(roomNames.map(n => ['GET', KEY + 'msg:' + n])) : [];
    const messages = {};
    roomNames.forEach((n, i) => { if (msgs[i]) messages[n] = JSON.parse(msgs[i]); });
    applyData({ users: first[0] ? JSON.parse(first[0]) : {}, members: first[1] ? JSON.parse(first[1]) : {}, servers: first[3] ? JSON.parse(first[3]) : {}, messages });
  } else if (fs.existsSync(DATA_FILE)) {
    applyData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
  loaded = true;
  console.log('💾 Хранилище: ' + (USE_REDIS ? 'Upstash Redis' : 'файл ' + DATA_FILE) + ', пользователей: ' + Object.keys(users).length);
}

function ensureUser(uid, nick) {
  let u = users[uid];
  const n = cleanNick(nick);
  if (!u) {
    u = users[uid] = { pid: pidOf(uid), nick: n, friends: [], incoming: [], outgoing: [], servers: [] };
    pidToUid[u.pid] = uid;
    scheduleSave();
  } else if (nick && u.nick !== n) {
    u.nick = n;
    scheduleSave();
  }
  return u;
}
function addMember(room, uid) {
  const arr = members[room] || (members[room] = []);
  if (!arr.includes(uid) && arr.length < MAX_MEMBERS) {
    arr.push(uid);
    scheduleSave();
  }
}
function addServerToUser(uid, room) {
  const u = users[uid];
  if (u && !u.servers.includes(room) && u.servers.length < 100) {
    u.servers.push(room);
    scheduleSave();
  }
}
function isOnline(uid) { return clients.some(c => c.uid === uid); }

function socialState(uid) {
  const u = users[uid];
  if (!u) return null;
  const info = pid => {
    const tu = pidToUid[pid];
    return { pid, nick: tu && users[tu] ? users[tu].nick : '?', online: tu ? isOnline(tu) : false };
  };
  return {
    pid: u.pid,
    friends: u.friends.map(info),
    incoming: u.incoming.map(info),
    outgoing: u.outgoing.slice(),
    servers: u.servers.filter(r => servers[r]).map(r => ({ room: r, name: servers[r].name }))
  };
}
function sendSocial(uid) {
  const st = socialState(uid);
  if (!st) return;
  const data = 'data: ' + JSON.stringify({ type: 'social', payload: st }) + '\n\n';
  clients.forEach(c => { if (c.uid === uid) c.res.write(data); });
}
function notifyFriendsOf(uid) {
  const u = users[uid];
  if (!u) return;
  u.friends.forEach(pid => { const f = pidToUid[pid]; if (f) sendSocial(f); });
}
function memberList(room) {
  const online = new Map();
  clients.forEach(c => {
    if (c.room !== room || !c.uid) return;
    const prev = online.get(c.uid) || { inVoice: false, vch: null };
    online.set(c.uid, { inVoice: prev.inVoice || !!c.inVoice, vch: prev.inVoice ? prev.vch : (c.inVoice ? c.vch : null) });
  });
  return (members[room] || []).map(uid => {
    const u = users[uid];
    const o = online.get(uid);
    return { pid: u ? u.pid : pidOf(uid), nick: u ? u.nick : '?', online: !!o, inVoice: !!(o && o.inVoice), vch: o ? o.vch : null };
  });
}


function safeRoom(v) {
  const s = String(v || '').trim();
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(s) ? s : DEFAULT_ROOM;
}
function roomOf(v) {
  const s = String(v || '').trim().toLowerCase();
  return (/^[\p{L}\p{N}_-]{1,32}$/u.test(s) && servers[s]) ? s : null;
}
function findChannel(room, id, type) {
  const sv = servers[room];
  if (!sv || typeof id !== 'string') return null;
  const ch = sv.channels.find(c => c.id === id);
  return ch && (!type || ch.type === type) ? ch : null;
}
function cleanName(v, max) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function codeList(a) {
  return Array.isArray(a) ? a.filter(x => typeof x === 'string' && safeRoom(x) === x).slice(0, 100) : [];
}
function serverInfo(room) {
  const sv = servers[room];
  const o = sv.owner && users[sv.owner];
  return { room, name: sv.name, ownerPid: o ? o.pid : null, channels: sv.channels.map(c => ({ id: c.id, name: c.name, type: c.type })) };
}
function broadcastServer(room) {
  broadcast(room, 'server', serverInfo(room));
}
function cleanNick(v) {
  return String(v || '').trim().slice(0, 24) || 'Гость';
}
function getRoom(room) {
  const r = rooms[room] || (rooms[room] = Object.create(null));
  const sv = servers[room];
  if (sv) sv.channels.forEach(ch => { if (ch.type === 'text' && !r[ch.id]) r[ch.id] = []; });
  return r;
}

function broadcast(room, eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload });
  clients.forEach(c => {
    if (c.room === room) c.res.write('data: ' + data + '\n\n');
  });
}

function broadcastUsers(room) {
  broadcast(room, 'users', memberList(room));
}

// Поддерживаем SSE-соединения живыми (туннель и прокси обрывают «тихие» соединения)
setInterval(() => {
  clients.forEach(c => c.res.write(': ping\n\n'));
}, 25000);

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>СИГНАЛ — Ночной клуб</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root {
    --bg-darkest: #040609;
    --bg-sidebar: #080d14;
    --bg-main: #0b1118;
    --bg-card: #0f1722;
    --bg-input: #131c28;
    --cyan: #14b8a6;
    --cyan-bright: #2dd4bf;
    --pink: #db2777;
    --pink-border: rgba(219, 39, 119, 0.4);
    --text-main: #f1f5f9;
    --text-muted: #64748b;
    --text-dim: #94a3b8;
    --border: rgba(255, 255, 255, 0.08);
    --cyan-border: rgba(45, 212, 191, 0.35);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background-color: var(--bg-darkest); color: var(--text-main);
    height: 100vh; display: flex; flex-direction: column; overflow: hidden; user-select: none;
  }

  .top-header { height: 38px; background: #030508; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 16px; gap: 12px; font-size: 12px; }
  .top-logo { display: flex; align-items: center; gap: 6px; font-weight: 800; color: #fff; background: #e11d48; padding: 3px 8px; border-radius: 4px; font-size: 11px; }
  .top-logo b { color: #fff; font-size: 10px; opacity: 0.85; }
  .top-sub { color: var(--text-dim); }
  .top-right-group { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  .node-status-badge { background: #064e3b; border: 1px solid #059669; color: #34d399; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .btn-top-invite { background: #9d174d; border: 1px solid #f43f5e; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-top-invite:hover { background: #be185d; }

  .demo-notice { height: 30px; background: #070c14; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; font-size: 11px; color: var(--text-dim); }
  .workspace { flex: 1; display: grid; grid-template-columns: 68px 250px 1fr 240px; overflow: hidden; }

  .servers-rail { background: #030508; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 10px; }
  .bolt-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--cyan-bright); font-size: 18px; margin-bottom: 4px; }
  .srv-ico { width: 42px; height: 42px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .srv-ico.active { background: var(--cyan-bright); color: #042f2e; border-color: var(--cyan-bright); box-shadow: 0 0 12px rgba(45, 212, 191, 0.4); }
  .srv-ico-add { background: transparent; border: 1px dashed var(--border); color: var(--pink); font-size: 18px; border-radius: 12px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; }

  .channels-panel { background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .srv-header { padding: 12px 14px 8px; display: flex; justify-content: space-between; align-items: center; }
  .srv-label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .srv-title { font-size: 16px; font-weight: 800; color: #fff; margin-top: 2px; }
  .btn-code-modal { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }

  .freq-card { margin: 4px 10px 10px; padding: 12px; border-radius: 10px; background: linear-gradient(135deg, #111a24 0%, #0a0f16 100%); border: 1px solid var(--border); }
  .freq-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .freq-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }
  .live-badge { font-size: 9px; background: #9d174d; color: #fff; padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .freq-card h4 { font-size: 15px; font-weight: 800; line-height: 1.2; margin-bottom: 6px; }
  .freq-card p { font-size: 10px; color: var(--text-dim); line-height: 1.35; }

  .channels-scroll { flex: 1; overflow-y: auto; padding: 0 8px; }
  .cat-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }
  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }
  .ch-btn.active .ch-dot { display: block; }

  .voice-ch-box { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
  .off-badge { font-size: 9px; background: rgba(255,255,255,0.05); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; font-weight: 700; }

  .connect-friend-box { margin: 8px; background: #070b12; border: 1px solid var(--border); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .connect-title { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .connect-row { display: flex; gap: 6px; }
  .connect-inp { flex: 1; background: #04060a; border: 1px solid var(--border); padding: 6px 8px; border-radius: 6px; color: #fff; font-size: 11px; outline: none; }
  .btn-connect { background: #0d9488; color: #fff; border: none; padding: 6px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; }
  .btn-copy-mini { background: transparent; border: 1px solid var(--pink-border); color: #f43f5e; padding: 6px; border-radius: 6px; font-size: 10px; font-weight: 700; text-align: center; cursor: pointer; }

  .user-bar { padding: 8px 10px; background: #030508; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .user-info { display: flex; align-items: center; gap: 8px; }
  .user-ava { width: 28px; height: 28px; border-radius: 6px; background: #e11d48; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
  .user-name { font-size: 11px; font-weight: 700; }
  .user-sub { font-size: 9px; color: var(--text-muted); }
  .btn-login-mini { background: transparent; border: 1px solid var(--border); color: var(--cyan-bright); padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; cursor: pointer; }

  .main-chat { background: var(--bg-main); display: flex; flex-direction: column; overflow: hidden; }
  .chat-topbar { height: 48px; padding: 0 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .chat-topbar-left { display: flex; align-items: center; gap: 8px; }
  .hash-large { color: var(--cyan-bright); font-size: 18px; font-weight: 800; }
  .top-ch-name { font-size: 13px; font-weight: 700; }
  .top-ch-desc { font-size: 10px; color: var(--text-muted); }
  .btn-top-right-share { background: #0d9488; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }

  .chat-scroll-area { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
  .hero-banner { background: linear-gradient(135deg, #0f1726 0%, #080e17 100%); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; }
  .hero-banner-left { max-width: 420px; }
  .hash-badge { width: 30px; height: 30px; border-radius: 8px; background: rgba(45, 212, 191, 0.12); border: 1px solid var(--cyan-border); color: var(--cyan-bright); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; margin-bottom: 8px; }
  .welcome-tag { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; margin-bottom: 4px; }
  .hero-banner h2 { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
  .hero-banner p { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; line-height: 1.4; }
  .pill-tags-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill-tag { padding: 3px 8px; border-radius: 999px; font-size: 9px; font-weight: 700; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: #cbd5e1; cursor: pointer; }
  .pill-tag.pink { background: rgba(219,39,119,0.15); border-color: rgba(219,39,119,0.4); color: #f43f5e; }
  .radar-box { width: 110px; height: 110px; display: flex; align-items: center; justify-content: center; }

  .messages-container { display: flex; flex-direction: column; gap: 8px; }
  .msg-item { display: flex; gap: 10px; background: rgba(255,255,255,0.015); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); }
  .msg-ava { width: 28px; height: 28px; border-radius: 6px; background: var(--cyan); color: #042f2e; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .msg-author { font-size: 12px; font-weight: 700; color: #fff; margin-right: 6px; }
  .msg-time { font-size: 9px; color: var(--text-muted); }
  .msg-text { font-size: 12px; color: #e2e8f0; margin-top: 2px; user-select: text; word-break: break-word; }

  .voice-panel { background: rgba(13, 148, 136, 0.06); border: 1px solid var(--cyan-border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
  .voice-panel-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .voice-label { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }
  .voice-title { font-size: 12px; font-weight: 700; margin: 2px 0; }
  .voice-sub { font-size: 10px; color: var(--text-dim); }
  .voice-active-area { display: none; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  .voice-active-area.show { display: flex; }
  .voice-user-card { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); width: fit-content; }
  .vu-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }

  .chat-bottom { padding: 8px 18px 12px; border-top: 1px solid var(--border); background: #070b12; display: flex; flex-direction: column; gap: 6px; }
  .auth-prompt-bar { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 600; }
  .input-row { display: flex; gap: 8px; align-items: center; }
  .chat-inp { flex: 1; background: var(--bg-input); border: 1px solid var(--border); padding: 9px 12px; border-radius: 6px; color: #fff; font-size: 12px; outline: none; }
  .bottom-hint { font-size: 9px; color: var(--text-muted); }

  .right-panel { background: var(--bg-sidebar); border-left: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .right-sec-title { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }
  .online-user-item { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 5px 6px; background: rgba(255,255,255,0.02); border-radius: 6px; }
  .online-dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
  .online-dot.off { background: #475569; }
  .mini-btn { background: transparent; border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; cursor: pointer; }
  .mini-btn:hover { background: rgba(20, 184, 166, 0.12); }
  .srv-ico { overflow: hidden; }
  .ch-del { background: transparent; border: none; color: var(--text-muted); font-size: 11px; cursor: pointer; padding: 0 4px; }
  .ch-del:hover { color: #f43f5e; }
  .add-ch-btn { background: transparent; border: none; color: var(--cyan-bright); font-size: 14px; cursor: pointer; line-height: 1; }
  .voice-ch-box.active { background: rgba(20, 184, 166, 0.12); color: #4ade80; }
  .seg { display: flex; gap: 6px; margin-bottom: 10px; }
  .seg button { flex: 1; background: #04060a; border: 1px solid var(--border); color: var(--text-dim); padding: 7px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .seg button.on { border-color: var(--cyan-bright); color: var(--cyan-bright); background: rgba(20, 184, 166, 0.12); }
  .friend-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }
  .invite-banner-card { background: linear-gradient(135deg, rgba(219,39,119,0.12), rgba(13,148,136,0.06)); border: 1px solid var(--pink-border); border-radius: 10px; padding: 12px; margin-top: auto; }
  .invite-banner-card h5 { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
  .invite-banner-card p { font-size: 10px; color: var(--text-dim); margin-bottom: 8px; }

  .btn-cyan { background: var(--cyan-bright); color: #042f2e; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }
  .btn-danger { background: #ef4444; color: #fff; border: none; padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }
  .btn-mute { background: #1e293b; color: #fff; border: 1px solid var(--border); padding: 7px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; }
  .btn-pink-card { background: #9d174d; color: #fff; border: none; width: 100%; padding: 7px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }

  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 999; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background: var(--bg-card); border: 1px solid var(--cyan-border); border-radius: 12px; padding: 20px; width: 360px; }
  .modal-box input { width: 100%; padding: 8px 10px; background: #04060a; border: 1px solid var(--border); border-radius: 6px; color: #fff; margin-bottom: 10px; font-size: 12px; outline: none; user-select: text; }
  /* Кликабельная ссылка */
  .link-box { background: #030508; border: 1px dashed var(--cyan-bright); padding: 8px; color: var(--cyan-bright); font-size: 11px; word-break: break-all; margin-bottom: 10px; border-radius: 6px; display: block; text-decoration: none; text-align: center; user-select: text; }
  .link-box:hover { background: rgba(20, 184, 166, 0.1); }
</style>
</head>
<body>

  <div class="top-header">
    <div class="top-logo">СИГНАЛ <b>CYBER.NET</b></div>
    <div class="top-sub">МЕСТО ДЛЯ СВОИХ // P2P ПРОТОКОЛ</div>
    <div class="top-right-group">
      <div class="node-status-badge" id="node-badge">Узел активен, cy-4371</div>
      <button class="btn-top-invite" onclick="openInviteModal()">ПРИГЛАСИТЬ ДРУГА</button>
    </div>
  </div>

  <div class="demo-notice">
    <span><b>РЕАЛЬНАЯ СЕТЬ:</b> Скопируйте публичную ссылку и отправьте другу — всё синхронизируется через ваш ПК</span>
    <span style="font-weight:700;color:var(--cyan-bright);" id="room-code-label">Код комнаты: <b>cy-4371</b> НА СВЯЗИ</span>
  </div>

  <div class="workspace">
    <div class="servers-rail">
      <div class="bolt-icon">⚡</div>
      <div id="servers-list" style="display:flex;flex-direction:column;gap:10px;align-items:center;"></div>
      <div class="srv-ico-add" title="Создать сервер" onclick="openCreateServer()">+</div>
    </div>

    <div class="channels-panel">
      <div class="srv-header">
        <div>
          <div class="srv-label">ОТКРЫТЫЙ СЕРВЕР</div>
          <div class="srv-title" id="srv-title">Ночной клуб</div>
        </div>
        <button class="btn-code-modal" onclick="promptRoomCode()">Ввести код</button>
      </div>

      <div class="freq-card">
        <div class="freq-top">
          <span class="freq-tag">ЧАСТОТА 108.4 FM</span>
          <span class="live-badge">LIVE</span>
        </div>
        <h4>Лови свою частоту.</h4>
        <p>Игры, идеи и разговоры после полуночи</p>
      </div>

      <div class="channels-scroll">
        <div class="cat-header"><span>ТЕКСТОВЫЕ КАНАЛЫ</span><button class="add-ch-btn" id="add-text-btn" title="Создать текстовый канал" style="display:none;" onclick="openCreateChannel('text')">+</button></div>
        <div id="text-channels-list"></div>

        <div class="cat-header" style="margin-top: 8px;"><span>ГОЛОСОВЫЕ КАНАЛЫ</span><button class="add-ch-btn" id="add-voice-btn" title="Создать голосовой канал" style="display:none;" onclick="openCreateChannel('voice')">+</button></div>
        <div id="voice-channels-list"></div>
      </div>

      <div class="connect-friend-box">
        <div class="connect-title">СВЯЗЬ С ДРУГОМ <span style="color:var(--cyan-bright);">// P2P</span></div>
        <div class="connect-row">
          <input type="text" id="friend-code-inp" class="connect-inp" placeholder="Код комнаты...">
          <button class="btn-connect" onclick="connectToFriend()">ВОЙТИ</button>
        </div>
        <div class="btn-copy-mini" onclick="openInviteModal()">🔗 СКОПИРОВАТЬ ССЫЛКУ-ПРИГЛАШЕНИЕ</div>
      </div>

      <div class="user-bar">
        <div class="user-info">
          <div class="user-ava" id="user-ava">ГО</div>
          <div>
            <div class="user-name" id="user-name-label">Гость_932</div>
            <div class="user-sub">Рады вас видеть</div>
          </div>
        </div>
        <button class="btn-login-mini" onclick="openAuthModal()">ВОЙТИ</button>
      </div>
    </div>

    <div class="main-chat">
      <div class="chat-topbar">
        <div class="chat-topbar-left">
          <span class="hash-large">#</span>
          <div>
            <div class="top-ch-name" id="top-ch-name">игровая-комната</div>
            <div class="top-ch-desc" id="top-ch-desc">Знакомимся, общаемся, строим планы</div>
          </div>
        </div>
        <button class="btn-top-right-share" onclick="openInviteModal()">🔗 ДАТЬ ССЫЛКУ ДРУГУ</button>
      </div>

      <div class="chat-scroll-area" id="chat-scroll">
        <div class="hero-banner">
          <div class="hero-banner-left">
            <div class="hash-badge">#</div>
            <div class="welcome-tag">НАЧАЛО КАНАЛА // СЕРВЕР ПК</div>
            <h2>Кто сегодня на связи?</h2>
            <p id="banner-desc">Это #игровая-комната на сервере «Ночной клуб». Общайтесь с друзьями через ваш ПК.</p>
            <div class="pill-tags-row">
              <span class="pill-tag">ТЕКСТОМ — ТЕКСТ РАВНО ИГРОК</span>
              <span class="pill-tag pink" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА В КАНАЛ</span>
            </div>
          </div>
          <div class="radar-box">
            <svg width="110" height="110" viewBox="0 0 140 140" fill="none">
              <circle cx="70" cy="70" r="62" stroke="rgba(45,212,191,0.15)" stroke-width="1"/>
              <circle cx="70" cy="70" r="44" stroke="rgba(219,39,119,0.45)" stroke-width="1.5" stroke-dasharray="18 10"/>
              <circle cx="70" cy="70" r="28" stroke="rgba(45,212,191,0.35)" stroke-width="1.5"/>
              <path d="M54 70 H62 L66 58 L74 82 L78 70 H86" stroke="#2dd4bf" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>

        <div class="messages-container" id="messages-list"></div>

        <div class="voice-panel">
          <div class="voice-panel-top">
            <div>
              <div class="voice-label">ГОЛОСОВОЙ КАНАЛ // WEBRTC P2P</div>
              <div class="voice-title" id="voice-title">Общий разговор участников канала</div>
              <div class="voice-sub" id="voice-sub-status">Говорите в микрофон — подключенные друзья слышат вас.</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>
              <button class="btn-cyan" id="connect-voice-btn" onclick="toggleVoiceCall()">ПОДКЛЮЧИТЬСЯ</button>
            </div>
          </div>
          <div class="voice-active-area" id="voice-active-area">
            <div class="voice-user-card">
              <span class="vu-dot"></span>
              <span id="voice-my-name" style="font-size:11px;font-weight:700;">Гость_932 (Вы)</span>
            </div>
            <div id="audio-box"></div>
          </div>
        </div>
      </div>

      <div class="chat-bottom">
        <div class="auth-prompt-bar">
          <span id="auth-bar-text">Вы в сети как <b>Гость_932</b> — сообщения синхронизируются через ваш сервер</span>
          <button class="btn-login-mini" onclick="openAuthModal()">Регистрация по коду</button>
        </div>
        <form class="input-row" onsubmit="sendChatMessage(event)">
          <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">
          <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
        </form>
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • ПУБЛИЧНЫЙ СЕРВЕР</div>
      </div>
    </div>

    <div class="right-panel">
      <div class="right-sec-title">НА ЧАСТОТЕ (<span id="online-count">1</span>)</div>
      <div id="online-users-box"></div>
      <div class="right-sec-title" style="margin-top:6px;">ДРУЗЬЯ (<span id="friends-count">0</span>)</div>
      <div id="requests-box"></div>
      <div id="friends-box"></div>
      <div class="invite-banner-card">
        <h5>Зови друзей в канал</h5>
        <p>Отправьте другу публичную ссылку — он сразу появится в списке участников.</p>
        <button class="btn-pink-card" onclick="openInviteModal()">🔗 СОЗДАТЬ ПРИГЛАШЕНИЕ</button>
      </div>
    </div>
  </div>

  <!-- Модальное окно приглашения с кликабельной ссылкой -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Публичная ссылка для друга</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Нажмите на ссылку, чтобы открыть её, или скопируйте её:</p>
      <a class="link-box" id="public-invite-url" href="#" target="_blank" rel="noopener">Генерация публичного адреса...</a>
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeInviteModal()">Закрыть</button>
    </div>
  </div>

  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServer()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Создать свой сервер</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">В нём сразу будут текстовый и голосовой каналы. Потом вы сможете добавить ещё.</p>
      <input type="text" id="new-server-name" placeholder="Название сервера" maxlength="24" onkeydown="if(event.key==='Enter')submitCreateServer()">
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">Создать</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeCreateServer()">Отмена</button>
    </div>
  </div>

  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannel()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:10px;">Новый канал</h3>
      <div class="seg">
        <button id="seg-text" onclick="setNewChannelType('text')"># Текстовый</button>
        <button id="seg-voice" onclick="setNewChannelType('voice')">🔊 Голосовой</button>
      </div>
      <input type="text" id="new-channel-name" placeholder="Название канала" maxlength="24" onkeydown="if(event.key==='Enter')submitCreateChannel()">
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">Создать</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeCreateChannel()">Отмена</button>
    </div>
  </div>

  <div class="modal-backdrop" id="auth-modal" onclick="if(event.target===this)closeAuthModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Верификация по почте</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Введите ваш Email для получения кода.</p>
      <input type="email" id="email-inp" placeholder="user@mail.com">
      <button class="btn-cyan" style="width:100%;margin-bottom:10px;" onclick="sendEmailCode()">Получить код</button>
      <div id="code-step" style="display:none;flex-direction:column;gap:8px;">
        <div id="demo-code-hint" style="color:#f43f5e;font-size:11px;font-weight:700;text-align:center;"></div>
        <input type="text" id="code-inp" placeholder="Введите 4 цифры кода">
        <input type="text" id="nick-inp" placeholder="Ваш позывной" maxlength="24">
        <button class="btn-cyan" style="width:100%;" onclick="verifyAndLogin()">Подтвердить вход</button>
      </div>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeAuthModal()">Закрыть</button>
    </div>
  </div>

<script>
  const params = new URLSearchParams(window.location.search);
  // Постоянная личность: секретный id браузера + последняя комната (чтобы не пропадать после выхода)
  function makeUid() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  let myUid = null;
  try { myUid = localStorage.getItem('cyber_uid'); } catch (e) {}
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    myUid = makeUid();
    try { localStorage.setItem('cyber_uid', myUid); } catch (e) {}
  }
  let currentRoom = params.get('room');
  if (!currentRoom) { try { currentRoom = localStorage.getItem('cyber_last_room'); } catch (e) {} }
  currentRoom = currentRoom || 'cy-4371';
  try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}
  if (!params.get('room')) {
    try { history.replaceState(null, '', '/?room=' + encodeURIComponent(currentRoom)); } catch (e) {}
  }
  let currentChannel = params.get('channel') || null;
  let serverInfo = null;       // { room, name, ownerPid, channels:[{id,name,type}] }
  let myVoiceChannel = null;   // id голосового канала, в котором вы сейчас
  let myNick = 'Гость_932';
  try { myNick = localStorage.getItem('cyber_nick') || 'Гость_932'; } catch (e) {}
  const clientId = Math.random().toString(36).substring(2, 10);

  // Voice state (объявлено заранее, чтобы обработчики SSE не обращались к необъявленным переменным)
  let localStream = null, peer = null, myPeerId = null, inVoice = false, isMuted = false;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    document.getElementById('user-ava').textContent = myNick.slice(0, 2).toUpperCase();
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    document.getElementById('auth-bar-text').innerHTML = 'Вы в сети как <b>' + escapeHtml(myNick) + '</b> — сообщения синхронизируются через ваш сервер';
  }

  function channelName(id) {
    const c = serverInfo && serverInfo.channels.find(function (x) { return x.id === id; });
    return c ? c.name : id;
  }

  function applyChannelUI() {
    const name = currentChannel ? channelName(currentChannel) : '';
    document.getElementById('top-ch-name').textContent = name;
    document.getElementById('top-ch-desc').textContent = 'Канал сервера «' + (serverInfo ? serverInfo.name : '') + '»';
    document.getElementById('banner-desc').textContent = 'Это #' + name + ' на сервере «' + (serverInfo ? serverInfo.name : '') + '». Общайтесь с друзьями в реальном времени.';
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + name + '...';
    document.querySelectorAll('#text-channels-list .ch-btn').forEach(function (i) {
      i.classList.toggle('active', i.getAttribute('data-ch') === currentChannel);
    });
  }

  applyNickUI();
  document.getElementById('node-badge').textContent = 'Узел активен, ' + currentRoom;
  document.getElementById('room-code-label').innerHTML = 'Код комнаты: <b>' + escapeHtml(currentRoom) + '</b> НА СВЯЗИ';

  const evtSource = new EventSource('/api/events?id=' + clientId + '&uid=' + myUid + '&room=' + encodeURIComponent(currentRoom) + '&nick=' + encodeURIComponent(myNick));

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    if (data.type === 'msg' && data.payload.channel === currentChannel) {
      addMsgToDOM(data.payload.msg);
    } else if (data.type === 'nosuchserver') {
      evtSource.close();
      try { localStorage.removeItem('cyber_last_room'); } catch (e) {}
      alert('Такого сервера не существует. Открываем главный сервер.');
      window.location.href = '/?room=cy-4371';
    } else if (data.type === 'server') {
      onServerInfo(data.payload);
    } else if (data.type === 'users') {
      renderUsers(data.payload);
    } else if (data.type === 'social') {
      myPid = data.payload.pid;
      social = data.payload;
      renderSocial();
      renderUsers(lastMembers);
      renderServers();
      if (serverInfo) renderChannels();
    } else if (data.type === 'voice-join') {
      if (inVoice && peer && localStream && myPeerId && data.payload.vch === myVoiceChannel && data.payload.peerId !== myPeerId) {
        const pid = data.payload.peerId;
        const call = peer.call(pid, localStream);
        if (!call) return;
        call.on('stream', (remoteStream) => playStream(pid, remoteStream));
        call.on('close', () => removeAudio(pid));
        call.on('error', () => removeAudio(pid));
      }
    }
  };

  function loadHistory() {
    const ch = currentChannel;
    if (!ch) return;
    fetch('/api/history?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(ch))
      .then(r => r.json())
      .then(msgs => {
        if (ch !== currentChannel) return; // пользователь уже переключил канал
        const box = document.getElementById('messages-list');
        box.innerHTML = '';
        if (msgs.length === 0) {
          box.innerHTML = '<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>';
          return;
        }
        msgs.forEach(addMsgToDOM);
      })
      .catch(() => {});
  }
  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list');
    const hint = document.getElementById('empty-hint');
    if (hint) hint.remove();
    const author = String(m.author || '?');
    const div = document.createElement('div');
    div.className = 'msg-item';
    div.innerHTML = '<div class="msg-ava">' + escapeHtml(author.charAt(0).toUpperCase()) + '</div>' +
      '<div><div><span class="msg-author">' + escapeHtml(author) + '</span><span class="msg-time">' + escapeHtml(m.time) + '</span></div>' +
      '<div class="msg-text">' + escapeHtml(m.text) + '</div></div>';
    box.appendChild(div);
    const scrollArea = document.getElementById('chat-scroll');
    scrollArea.scrollTop = scrollArea.scrollHeight;
  }

  let myPid = null, lastMembers = [], social = { friends: [], incoming: [], outgoing: [], servers: [] };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function friendAction(action, pid) {
    return fetch('/api/friend', { method: 'POST', body: JSON.stringify({ uid: myUid, action: action, target: pid }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) alert(d.error); })
      .catch(function () { alert('Ошибка соединения с сервером.'); });
  }

  function renderUsers(list) {
    lastMembers = list || [];
    const online = lastMembers.filter(function (u) { return u.online; });
    document.getElementById('online-count').textContent = online.length;
    const box = document.getElementById('online-users-box');
    box.innerHTML = '';
    const sorted = online.concat(lastMembers.filter(function (u) { return !u.online; }));
    const friendPids = social.friends.map(function (f) { return f.pid; });
    sorted.forEach(function (u) {
      const d = el('div', 'online-user-item');
      if (!u.online) d.style.opacity = '0.5';
      d.appendChild(el('span', 'online-dot' + (u.online ? '' : ' off')));
      const name = el('span', '', u.nick + (u.pid === myPid ? ' (вы)' : '') + (u.inVoice ? ' 🔊' + (u.vch ? ' ' + channelName(u.vch) : '') : ''));
      name.style.flex = '1';
      d.appendChild(name);
      if (myPid && u.pid !== myPid) {
        if (friendPids.indexOf(u.pid) >= 0) {
          d.appendChild(el('span', 'friend-tag', 'друг'));
        } else if (social.outgoing.indexOf(u.pid) >= 0) {
          d.appendChild(el('span', 'friend-tag', 'заявка'));
        } else if (social.incoming.some(function (i) { return i.pid === u.pid; })) {
          const b = el('button', 'mini-btn', 'принять');
          b.onclick = function () { friendAction('accept', u.pid); };
          d.appendChild(b);
        } else {
          const b = el('button', 'mini-btn', '+ друг');
          b.onclick = function () { friendAction('request', u.pid); };
          d.appendChild(b);
        }
      }
      box.appendChild(d);
    });
  }

  function renderSocial() {
    document.getElementById('friends-count').textContent = social.friends.length;
    const rq = document.getElementById('requests-box');
    rq.innerHTML = '';
    social.incoming.forEach(function (r) {
      const d = el('div', 'online-user-item');
      const name = el('span', '', r.nick + ' хочет в друзья');
      name.style.flex = '1';
      const ok = el('button', 'mini-btn', '✓');
      ok.onclick = function () { friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕');
      no.onclick = function () { friendAction('decline', r.pid); };
      d.appendChild(name);
      d.appendChild(ok);
      d.appendChild(no);
      rq.appendChild(d);
    });
    const fb = document.getElementById('friends-box');
    fb.innerHTML = '';
    if (social.friends.length === 0) {
      const hint = el('div', '', 'Пока никого. Нажмите «+ друг» рядом с участником.');
      hint.style.cssText = 'font-size:10px;color:var(--text-muted);';
      fb.appendChild(hint);
    }
    social.friends.forEach(function (f) {
      const d = el('div', 'online-user-item');
      if (!f.online) d.style.opacity = '0.5';
      d.appendChild(el('span', 'online-dot' + (f.online ? '' : ' off')));
      const name = el('span', '', f.nick);
      name.style.flex = '1';
      d.appendChild(name);
      const rmb = el('button', 'mini-btn', '✕');
      rmb.title = 'Удалить из друзей';
      rmb.onclick = function () { if (confirm('Удалить ' + f.nick + ' из друзей?')) friendAction('remove', f.pid); };
      d.appendChild(rmb);
      fb.appendChild(d);
    });
  }

  function sendChatMessage(e) {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text) return;
    fetch('/api/message', {
      method: 'POST',
      body: JSON.stringify({ id: clientId, room: currentRoom, channel: currentChannel, author: myNick, text })
    }).catch(() => alert('Не удалось отправить сообщение. Проверьте соединение.'));
    inp.value = '';
  }

  function onServerInfo(info) {
    serverInfo = info;
    document.getElementById('srv-title').textContent = info.name;
    document.title = 'СИГНАЛ — ' + info.name;
    const textChans = info.channels.filter(function (c) { return c.type === 'text'; });
    const prev = currentChannel;
    if (!currentChannel || !textChans.some(function (c) { return c.id === currentChannel; })) {
      currentChannel = textChans.length ? textChans[0].id : null;
    }
    // если вашего голосового канала больше нет — выходим из голоса
    if (inVoice && !info.channels.some(function (c) { return c.id === myVoiceChannel && c.type === 'voice'; })) {
      stopVoice();
    }
    renderChannels();
    applyChannelUI();
    if (currentChannel !== prev) loadHistory();
    renderServers();
  }

  function isOwner() { return !!(serverInfo && serverInfo.ownerPid && serverInfo.ownerPid === myPid); }

  function renderChannels() {
    const owner = isOwner();
    document.getElementById('add-text-btn').style.display = owner ? 'inline' : 'none';
    document.getElementById('add-voice-btn').style.display = owner ? 'inline' : 'none';
    const tl = document.getElementById('text-channels-list');
    const vl = document.getElementById('voice-channels-list');
    tl.innerHTML = '';
    vl.innerHTML = '';
    serverInfo.channels.forEach(function (c) {
      if (c.type === 'text') {
        const d = el('div', 'ch-btn');
        d.setAttribute('data-ch', c.id);
        d.onclick = function () { setChannel(c.id); };
        d.appendChild(el('span', '', '# ' + c.name));
        const right = el('span', '');
        right.style.cssText = 'display:flex;align-items:center;gap:4px;';
        if (owner) right.appendChild(delButton(c));
        right.appendChild(el('span', 'ch-dot'));
        d.appendChild(right);
        tl.appendChild(d);
      } else {
        const d = el('div', 'voice-ch-box' + (inVoice && myVoiceChannel === c.id ? ' active' : ''));
        d.onclick = function () { toggleVoiceCall(c.id); };
        d.appendChild(el('span', '', '🔊 ' + c.name));
        const right = el('span', '');
        right.style.cssText = 'display:flex;align-items:center;gap:4px;';
        if (owner) right.appendChild(delButton(c));
        const on = inVoice && myVoiceChannel === c.id;
        right.appendChild(el('span', 'off-badge', on ? 'ON' : 'OFF'));
        d.appendChild(right);
        vl.appendChild(d);
      }
    });
    updateVoicePanel();
  }

  function delButton(c) {
    const b = el('button', 'ch-del', '✕');
    b.title = 'Удалить канал';
    b.onclick = function (e) {
      e.stopPropagation();
      if (!confirm('Удалить канал «' + c.name + '»?' + (c.type === 'text' ? ' Все сообщения в нём пропадут.' : ''))) return;
      fetch('/api/channel', { method: 'POST', body: JSON.stringify({ uid: myUid, room: currentRoom, action: 'delete', id: c.id }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.error) alert(d.error); })
        .catch(function () { alert('Ошибка соединения с сервером.'); });
    };
    return b;
  }

  function renderServers() {
    const box = document.getElementById('servers-list');
    box.innerHTML = '';
    const list = (social.servers || []).slice();
    if (!list.some(function (x) { return x.room === currentRoom; }) && serverInfo) {
      list.push({ room: currentRoom, name: serverInfo.name });
    }
    list.forEach(function (sv) {
      const d = el('div', 'srv-ico' + (sv.room === currentRoom ? ' active' : ''), (sv.name || '?').slice(0, 2).toUpperCase());
      d.title = sv.name;
      d.onclick = function () {
        if (sv.room !== currentRoom) window.location.href = '/?room=' + encodeURIComponent(sv.room);
      };
      box.appendChild(d);
    });
  }

  function setChannel(ch) {
    currentChannel = ch;
    applyChannelUI();
    loadHistory();
  }

  function openCreateServer() {
    document.getElementById('create-server-modal').classList.add('open');
    const i = document.getElementById('new-server-name');
    i.value = '';
    setTimeout(function () { i.focus(); }, 50);
  }
  function closeCreateServer() { document.getElementById('create-server-modal').classList.remove('open'); }
  function submitCreateServer() {
    const name = document.getElementById('new-server-name').value.trim();
    if (!name) return alert('Введите название сервера');
    fetch('/api/server', { method: 'POST', body: JSON.stringify({ uid: myUid, name: name }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) return alert(d.error);
        window.location.href = '/?room=' + encodeURIComponent(d.room);
      })
      .catch(function () { alert('Ошибка соединения с сервером.'); });
  }

  let newChannelType = 'text';
  function setNewChannelType(t) {
    newChannelType = t;
    document.getElementById('seg-text').classList.toggle('on', t === 'text');
    document.getElementById('seg-voice').classList.toggle('on', t === 'voice');
  }
  function openCreateChannel(type) {
    setNewChannelType(type || 'text');
    document.getElementById('create-channel-modal').classList.add('open');
    const i = document.getElementById('new-channel-name');
    i.value = '';
    setTimeout(function () { i.focus(); }, 50);
  }
  function closeCreateChannel() { document.getElementById('create-channel-modal').classList.remove('open'); }
  function submitCreateChannel() {
    const name = document.getElementById('new-channel-name').value.trim();
    if (!name) return alert('Введите название канала');
    fetch('/api/channel', { method: 'POST', body: JSON.stringify({ uid: myUid, room: currentRoom, action: 'create', type: newChannelType, name: name }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) return alert(d.error);
        closeCreateChannel();
        if (newChannelType === 'text' && d.id) setChannel(d.id);
      })
      .catch(function () { alert('Ошибка соединения с сервером.'); });
  }

  function connectToFriend() {
    const code = document.getElementById('friend-code-inp').value.trim().toLowerCase();
    if (!code) return alert('Введите код комнаты!');
    window.location.href = window.location.origin + '/?room=' + encodeURIComponent(code);
  }

  function promptRoomCode() {
    let code = prompt('Введите код комнаты друга:', 'cy-');
    if (code && code.trim()) {
      code = code.trim().toLowerCase();
      window.location.href = window.location.origin + '/?room=' + encodeURIComponent(code.trim());
    }
  }

  async function refreshInviteLink() {
    const linkEl = document.getElementById('public-invite-url');
    linkEl.textContent = 'Создание интернет-ссылки...';
    linkEl.href = '#';
    let base = window.location.origin;
    try {
      const res = await fetch('/api/invite-info');
      const data = await res.json();
      if (data.publicUrl) base = data.publicUrl;
    } catch (e) {}
    const finalUrl = base + '/?room=' + encodeURIComponent(currentRoom);
    linkEl.textContent = finalUrl;
    linkEl.href = finalUrl;
  }
  function openInviteModal() {
    document.getElementById('invite-modal').classList.add('open');
    refreshInviteLink();
  }
  function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
  async function copyInviteLink() {
    const url = document.getElementById('public-invite-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      alert('Публичная интернет-ссылка скопирована!');
    } catch (e) {
      prompt('Скопируйте ссылку вручную:', url);
    }
  }

  function openAuthModal() { document.getElementById('auth-modal').classList.add('open'); }
  function closeAuthModal() { document.getElementById('auth-modal').classList.remove('open'); }

  async function sendEmailCode() {
    const email = document.getElementById('email-inp').value.trim();
    try {
      const res = await fetch('/api/send-code', { method: 'POST', body: JSON.stringify({ email }) });
      const data = await res.json();
      if (data.error) return alert(data.error);
      document.getElementById('code-step').style.display = 'flex';
      document.getElementById('demo-code-hint').textContent = 'Код подтверждения: ' + data.demoCode;
    } catch (e) {
      alert('Ошибка соединения с сервером.');
    }
  }

  async function verifyAndLogin() {
    const email = document.getElementById('email-inp').value.trim();
    const code = document.getElementById('code-inp').value.trim();
    const nick = document.getElementById('nick-inp').value.trim().slice(0, 24);
    if (!nick) return alert('Введите позывной!');
    try {
      const res = await fetch('/api/verify-code', { method: 'POST', body: JSON.stringify({ id: clientId, email, code, nick }) });
      const data = await res.json();
      if (data.error) return alert(data.error);
      myNick = nick;
      try { localStorage.setItem('cyber_nick', myNick); } catch (e) {}
      applyNickUI();
      closeAuthModal();
      alert('Авторизация успешна!');
    } catch (e) {
      alert('Ошибка соединения с сервером.');
    }
  }

  function postVoiceState(state) {
    return fetch('/api/voice', { method: 'POST', body: JSON.stringify(Object.assign({ id: clientId }, state)) }).catch(() => {});
  }

  function updateVoicePanel() {
    const btn = document.getElementById('connect-voice-btn');
    const sub = document.getElementById('voice-sub-status');
    const hasVoice = serverInfo && serverInfo.channels.some(function (c) { return c.type === 'voice'; });
    document.getElementById('voice-title').textContent = inVoice
      ? 'Голосовой канал «' + channelName(myVoiceChannel) + '»'
      : 'Общий разговор участников канала';
    if (inVoice) {
      btn.textContent = 'ОТКЛЮЧИТЬСЯ';
      btn.className = 'btn-danger';
      document.getElementById('mute-btn').style.display = 'inline-block';
      document.getElementById('voice-active-area').classList.add('show');
      sub.textContent = 'Вы в канале «' + channelName(myVoiceChannel) + '». Говорите в микрофон — подключённые друзья слышат вас.';
    } else {
      btn.textContent = 'ПОДКЛЮЧИТЬСЯ';
      btn.className = 'btn-cyan';
      document.getElementById('mute-btn').style.display = 'none';
      document.getElementById('voice-active-area').classList.remove('show');
      sub.textContent = hasVoice
        ? 'Выберите голосовой канал слева или нажмите «Подключиться».'
        : 'На этом сервере нет голосовых каналов.' + (isOwner() ? ' Создайте его кнопкой «+» слева.' : '');
    }
  }

  function stopVoice() {
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (peer) peer.destroy();
    localStream = null;
    peer = null;
    myPeerId = null;
    inVoice = false;
    isMuted = false;
    myVoiceChannel = null;
    document.getElementById('mute-btn').textContent = '🎤 Микр. вкл';
    document.getElementById('audio-box').innerHTML = '';
    if (serverInfo) renderChannels();
    postVoiceState({ inVoice: false });
  }

  let voiceBusy = false;
  async function toggleVoiceCall(chId) {
    if (voiceBusy) return;
    if (typeof chId !== 'string') chId = null; // вызов из кнопки панели
    const voiceChans = serverInfo ? serverInfo.channels.filter(function (c) { return c.type === 'voice'; }) : [];
    if (inVoice && (!chId || chId === myVoiceChannel)) { stopVoice(); return; }
    const target = chId || (voiceChans[0] && voiceChans[0].id);
    if (!target) return alert('На этом сервере нет голосовых каналов.');
    voiceBusy = true;
    try {
      if (inVoice) stopVoice(); // переход в другой голосовой канал
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        alert('Разрешите доступ к микрофону!');
        return;
      }
      inVoice = true;
      isMuted = false;
      myVoiceChannel = target;
      renderChannels();

      peer = new Peer();
      peer.on('open', function (id) {
        myPeerId = id;
        postVoiceState({ inVoice: true, peerId: id, vch: myVoiceChannel });
      });
      peer.on('call', function (call) {
        call.answer(localStream);
        call.on('stream', function (remoteStream) { playStream(call.peer, remoteStream); });
        call.on('close', function () { removeAudio(call.peer); });
        call.on('error', function () { removeAudio(call.peer); });
      });
      peer.on('error', function (err) {
        console.log('PeerJS error:', err && err.type ? err.type : err);
      });
    } finally {
      voiceBusy = false;
    }
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл';
  }

  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const audio = document.createElement('audio');
    audio.id = 'aud-' + id;
    audio.srcObject = stream;
    audio.autoplay = true;
    document.getElementById('audio-box').appendChild(audio);
  }

  function removeAudio(id) {
    const el = document.getElementById('aud-' + id);
    if (el) el.remove();
  }
</script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        body = '';
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({});
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:' + PORT);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML_PAGE);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = String(url.searchParams.get('id') || '').slice(0, 32);
      const room = roomOf(url.searchParams.get('room'));
      const nick = cleanNick(url.searchParams.get('nick') || 'Гость_932');
      const uid = url.searchParams.get('uid');
      if (!validUid(uid)) { res.writeHead(400); return res.end(); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      if (!room) {
        res.write('data: ' + JSON.stringify({ type: 'nosuchserver' }) + '\n\n');
        return res.end();
      }
      getRoom(room);
      const user = ensureUser(uid, nick);
      addMember(room, uid);
      addServerToUser(uid, room);

      const client = { id, uid, room, nick: user.nick, inVoice: false, vch: null, peerId: null, res };
      clients.push(client);
      res.write('data: ' + JSON.stringify({ type: 'server', payload: serverInfo(room) }) + '\n\n');
      broadcastUsers(room);
      sendSocial(uid);
      notifyFriendsOf(uid);

      req.on('close', () => {
        clients = clients.filter(c => c !== client);
        broadcastUsers(room);
        notifyFriendsOf(uid);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const room = roomOf(url.searchParams.get('room'));
      const chObj = room && findChannel(room, url.searchParams.get('channel'), 'text');
      const list = chObj ? getRoom(room)[chObj.id] : [];
      return sendJson(res, 200, list);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') {
      return sendJson(res, 200, { publicUrl: null });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const room = roomOf(body.room);
      const chObj = room && findChannel(room, body.channel, 'text');
      if (!chObj) return sendJson(res, 400, { error: 'Канал не найден' });
      const channel = chObj.id;
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

      // Ник берём с сервера (по id соединения), чтобы его нельзя было подменить в запросе
      const c = clients.find(x => x.id === body.id);
      const author = c ? c.nick : cleanNick(body.author);

      const now = new Date();
      const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author, time, text };

      const list = getRoom(room)[channel];
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      scheduleSave(room);

      broadcast(room, 'msg', { channel, msg });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/send-code') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return sendJson(res, 400, { error: 'Введите корректный email!' });
      }
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      emailCodes[email] = { code, expires: Date.now() + CODE_TTL_MS };
      // Демо-режим: код возвращается на страницу, т.к. реальная отправка почты не настроена
      return sendJson(res, 200, { demoCode: code });
    }

    if (req.method === 'POST' && url.pathname === '/api/verify-code') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const entry = emailCodes[email];
      if (!entry || entry.expires < Date.now() || entry.code !== String(body.code || '').trim()) {
        return sendJson(res, 400, { error: 'Неверный или просроченный код!' });
      }
      delete emailCodes[email];
      const nick = cleanNick(body.nick);
      const c = clients.find(x => x.id === body.id);
      if (c) {
        if (users[c.uid]) { users[c.uid].nick = nick; scheduleSave(); }
        clients.forEach(x => { if (x.uid === c.uid) x.nick = nick; });
        broadcastUsers(c.room);
        notifyFriendsOf(c.uid);
        sendSocial(c.uid);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/server') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid) || !users[uid]) return sendJson(res, 400, { error: 'Неизвестный пользователь. Обновите страницу.' });
      const name = cleanName(body.name, 24);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера' });
      const mine = Object.keys(servers).filter(r => servers[r].owner === uid).length;
      if (mine >= MAX_SERVERS_PER_USER) return sendJson(res, 400, { error: 'Можно создать не больше ' + MAX_SERVERS_PER_USER + ' серверов' });
      if (Object.keys(servers).length >= MAX_SERVERS) return sendJson(res, 400, { error: 'Достигнут общий лимит серверов' });
      let code;
      do { code = 'srv-' + crypto.randomBytes(4).toString('hex'); } while (servers[code]);
      servers[code] = {
        name,
        owner: uid,
        channels: [
          { id: 'general', name: 'общий', type: 'text' },
          { id: 'voice', name: 'Голосовой', type: 'voice' }
        ]
      };
      getRoom(code);
      addMember(code, uid);
      addServerToUser(uid, code);
      scheduleSave(code);
      sendSocial(uid);
      return sendJson(res, 200, { room: code });
    }

    if (req.method === 'POST' && url.pathname === '/api/channel') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid) || !users[uid]) return sendJson(res, 400, { error: 'Неизвестный пользователь. Обновите страницу.' });
      const room = roomOf(body.room);
      if (!room) return sendJson(res, 400, { error: 'Сервер не найден' });
      const sv = servers[room];
      if (sv.owner !== uid) return sendJson(res, 403, { error: 'Только владелец сервера может менять каналы' });

      if (body.action === 'create') {
        const type = body.type === 'voice' ? 'voice' : 'text';
        let name = cleanName(body.name, 24);
        if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
        if (!name) return sendJson(res, 400, { error: 'Введите название канала' });
        if (sv.channels.length >= MAX_CHANNELS) return sendJson(res, 400, { error: 'Можно создать не больше ' + MAX_CHANNELS + ' каналов' });
        const ch = { id: 'c' + crypto.randomBytes(4).toString('hex'), name, type };
        sv.channels.push(ch);
        getRoom(room);
        scheduleSave(room);
        broadcastServer(room);
        return sendJson(res, 200, { ok: true, id: ch.id });
      }

      if (body.action === 'delete') {
        const ch = sv.channels.find(c => c.id === body.id);
        if (!ch) return sendJson(res, 400, { error: 'Канал не найден' });
        if (ch.type === 'text' && sv.channels.filter(c => c.type === 'text').length <= 1) {
          return sendJson(res, 400, { error: 'Нельзя удалить последний текстовый канал' });
        }
        sv.channels = sv.channels.filter(c => c !== ch);
        if (rooms[room]) delete rooms[room][ch.id];
        clients.forEach(c => {
          if (c.room === room && c.vch === ch.id) { c.inVoice = false; c.vch = null; c.peerId = null; }
        });
        scheduleSave(room);
        broadcastServer(room);
        broadcastUsers(room);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 400, { error: 'Неизвестное действие' });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid) || !users[uid]) return sendJson(res, 400, { error: 'Неизвестный пользователь. Обновите страницу.' });
      const me = users[uid];
      const targetUid = validPid(body.target) ? pidToUid[body.target] : null;
      const target = targetUid ? users[targetUid] : null;
      if (!target || targetUid === uid) return sendJson(res, 400, { error: 'Пользователь не найден' });

      const rm = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };
      let act = String(body.action || '');
      if (act === 'request' && me.incoming.includes(target.pid)) act = 'accept'; // встречная заявка = дружба

      if (act === 'request') {
        if (me.friends.includes(target.pid) || me.outgoing.includes(target.pid)) {
          // уже друзья или заявка уже отправлена
        } else if (me.outgoing.length >= MAX_FRIENDS || target.incoming.length >= MAX_FRIENDS) {
          return sendJson(res, 400, { error: 'Слишком много заявок' });
        } else {
          me.outgoing.push(target.pid);
          target.incoming.push(me.pid);
        }
      } else if (act === 'accept') {
        if (me.incoming.includes(target.pid)) {
          if (me.friends.length >= MAX_FRIENDS || target.friends.length >= MAX_FRIENDS) {
            return sendJson(res, 400, { error: 'Список друзей переполнен' });
          }
          rm(me.incoming, target.pid);
          rm(target.outgoing, me.pid);
          if (!me.friends.includes(target.pid)) me.friends.push(target.pid);
          if (!target.friends.includes(me.pid)) target.friends.push(me.pid);
        }
      } else if (act === 'decline') {
        rm(me.incoming, target.pid);
        rm(target.outgoing, me.pid);
      } else if (act === 'cancel') {
        rm(me.outgoing, target.pid);
        rm(target.incoming, me.pid);
      } else if (act === 'remove') {
        rm(me.friends, target.pid);
        rm(target.friends, me.pid);
      } else {
        return sendJson(res, 400, { error: 'Неизвестное действие' });
      }

      scheduleSave();
      sendSocial(uid);
      sendSocial(targetUid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req);
      const c = clients.find(x => x.id === body.id);
      if (c) {
        const vch = body.inVoice ? findChannel(c.room, body.vch, 'voice') : null;
        c.inVoice = !!(body.inVoice && vch);
        c.vch = c.inVoice ? vch.id : null;
        c.peerId = c.inVoice && body.peerId ? String(body.peerId).slice(0, 64) : null;
        broadcastUsers(c.room);
        if (c.inVoice && c.peerId) broadcast(c.room, 'voice-join', { peerId: c.peerId, vch: c.vch });
      }
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    console.log('Ошибка обработки запроса:', err && err.message ? err.message : err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('❌ Порт ' + PORT + ' уже занят. Закройте другой запущенный сервер и повторите.');
  } else {
    console.log('❌ Ошибка сервера:', err && err.message ? err.message : err);
  }
  process.exit(1);
});

async function boot() {
  for (let i = 1; ; i++) {
    try {
      await loadData();
      break;
    } catch (e) {
      console.log('⚠️ Не удалось загрузить данные (' + i + '/5): ' + e.message);
      if (i >= 5) {
        console.log('❌ Хранилище недоступно. Останавливаемся, чтобы не затереть сохранённые данные.');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================================');
    console.log('⚡ СЕРВЕР ЗАПУЩЕН, порт ' + PORT);
    console.log('====================================================');
  });
}
boot();

// Сохраняем данные при остановке сервера
async function shutdown() {
  setTimeout(() => process.exit(0), 5000).unref();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  for (let i = 0; i < 30 && saving; i++) await new Promise(r => setTimeout(r, 100));
  await saveNow();
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => { process.on(sig, shutdown); });
