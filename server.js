const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const MAX_HISTORY = 500;
const MAX_BODY = 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;

const emailCodes = Object.create(null);
let clients = [];

// ---------- Постоянные данные: серверы, каналы, участники, друзья ----------
const users = Object.create(null);     // uid -> { nick, friends:[pid], incoming:[pid], outgoing:[pid] }
const pidToUid = Object.create(null);  // pid -> uid
const members = Object.create(null);   // serverId -> [uid]
const servers = Object.create(null);   // serverId -> { id, name, icon, desc, ownerUid, textChannels:[...], voiceChannels:[...] }
const rooms = Object.create(null);     // serverId -> { channelName: [msgs] }

const MAX_MEMBERS = 500;
const MAX_FRIENDS = 200;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function pidOf(uid) { return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 10); }
function validUid(v) { return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v); }
function validPid(v) { return typeof v === 'string' && /^[a-f0-9]{10}$/.test(v); }
function pidList(a) { return Array.isArray(a) ? a.filter(validPid).slice(0, MAX_FRIENDS) : []; }

function safeServerId(v) {
  const s = String(v || '').trim();
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(s) ? s : DEFAULT_ROOM;
}
function safeChannel(v) {
  const s = String(v || '').trim();
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(s) ? s : 'общий';
}
function cleanNick(v) {
  return String(v || '').trim().slice(0, 24) || 'Гость';
}

function makeDefaultServer(id, name, desc, ownerUid) {
  return {
    id: id,
    name: name || 'Ночной клуб',
    icon: (name || 'НК').slice(0, 2).toUpperCase(),
    desc: desc || 'Пользовательский сервер Сигнал',
    ownerUid: ownerUid || '',
    textChannels: ['игровая-комната', 'общий', 'знакомства', 'музыка'],
    voiceChannels: ['Ночной эфир']
  };
}

function getOrCreateServer(serverId) {
  if (!servers[serverId]) {
    servers[serverId] = makeDefaultServer(serverId, serverId === DEFAULT_ROOM ? 'Ночной клуб' : 'Сервер ' + serverId, 'Открытый узел связи');
  }
  return servers[serverId];
}

function getRoomMessages(serverId, channel) {
  safeServerId(serverId);
  safeChannel(channel);
  if (!rooms[serverId]) rooms[serverId] = Object.create(null);
  if (!rooms[serverId][channel]) rooms[serverId][channel] = [];
  return rooms[serverId][channel];
}

// Хранилище: Upstash Redis или локальный файл data.json[cite: 5]
const REDIS_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const KEY = 'signal:v3:';
const dirtyServers = new Set();
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
    o[uid] = { nick: u.nick, friends: u.friends, incoming: u.incoming, outgoing: u.outgoing };
  });
  return o;
}

function scheduleSave(serverId) {
  if (serverId) dirtyServers.add(serverId);
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, USE_REDIS ? 2000 : 1000);
}

async function saveNow() {
  if (!loaded) return;
  if (saving) { resave = true; return; }
  saving = true;
  try {
    if (USE_REDIS) {
      const rs = Array.from(dirtyServers);
      dirtyServers.clear();
      const cmds = [
        ['SET', KEY + 'users', JSON.stringify(usersPart())],
        ['SET', KEY + 'members', JSON.stringify(members)],
        ['SET', KEY + 'servers', JSON.stringify(servers)]
      ];
      rs.forEach(r => { if (rooms[r]) cmds.push(['SET', KEY + 'msg:' + r, JSON.stringify(rooms[r])]); });
      try {
        await redis(cmds);
      } catch (e) {
        rs.forEach(r => dirtyServers.add(r));
        throw e;
      }
    } else {
      const data = { users: usersPart(), members: {}, servers: servers, messages: {} };
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
  Object.keys(d.users || {}).forEach(uid => {
    if (!validUid(uid)) return;
    const u = d.users[uid] || {};
    users[uid] = { pid: pidOf(uid), nick: cleanNick(u.nick), friends: pidList(u.friends), incoming: pidList(u.incoming), outgoing: pidList(u.outgoing) };
    pidToUid[users[uid].pid] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeServerId(r) !== r || !Array.isArray(d.members[r])) return;
    members[r] = d.members[r].filter(validUid).slice(0, MAX_MEMBERS);
  });
  if (d.servers && typeof d.servers === 'object') {
    Object.keys(d.servers).forEach(sId => {
      const s = d.servers[sId];
      if (s && s.id) servers[sId] = s;
    });
  }
  Object.keys(d.messages || {}).forEach(r => {
    if (safeServerId(r) !== r || !d.messages[r]) return;
    const rMsgs = rooms[r] || (rooms[r] = Object.create(null));
    Object.keys(d.messages[r]).forEach(ch => {
      const list = d.messages[r][ch];
      if (!Array.isArray(list)) return;
      rMsgs[ch] = list.slice(-MAX_HISTORY).map(m => ({
        author: String(m.author || '').slice(0, 24),
        time: String(m.time || '').slice(0, 5),
        text: String(m.text || '').slice(0, 1000)
      }));
    });
  });
}

async function loadData() {
  getOrCreateServer(DEFAULT_ROOM);
  if (USE_REDIS) {
    const first = await redis([['GET', KEY + 'users'], ['GET', KEY + 'members'], ['GET', KEY + 'servers']]);
    const srvs = first[2] ? JSON.parse(first[2]) : {};
    const srvIds = Object.keys(srvs).filter(n => safeServerId(n) === n);
    const msgs = srvIds.length ? await redis(srvIds.map(n => ['GET', KEY + 'msg:' + n])) : [];
    const messages = {};
    srvIds.forEach((n, i) => { if (msgs[i]) messages[n] = JSON.parse(msgs[i]); });
    applyData({ users: first[0] ? JSON.parse(first[0]) : {}, members: first[1] ? JSON.parse(first[1]) : {}, servers: srvs, messages });
  } else if (fs.existsSync(DATA_FILE)) {
    applyData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
  loaded = true;
  console.log('💾 Хранилище загружено, серверов: ' + Object.keys(servers).length);
}

function ensureUser(uid, nick) {
  let u = users[uid];
  const n = cleanNick(nick);
  if (!u) {
    u = users[uid] = { pid: pidOf(uid), nick: n, friends: [], incoming: [], outgoing: [] };
    pidToUid[u.pid] = uid;
    scheduleSave();
  } else if (nick && u.nick !== n) {
    u.nick = n;
    scheduleSave();
  }
  return u;
}

function addMember(serverId, uid) {
  const arr = members[serverId] || (members[serverId] = []);
  if (!arr.includes(uid) && arr.length < MAX_MEMBERS) {
    arr.push(uid);
    scheduleSave(serverId);
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
  return { pid: u.pid, friends: u.friends.map(info), incoming: u.incoming.map(info), outgoing: u.outgoing.slice() };
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

function memberList(serverId) {
  const online = new Map();
  clients.forEach(c => {
    if (c.serverId !== serverId || !c.uid) return;
    const prev = online.get(c.uid);
    online.set(c.uid, { inVoice: !!(prev && prev.inVoice) || !!c.inVoice });
  });
  return (members[serverId] || []).map(uid => {
    const u = users[uid];
    const o = online.get(uid);
    return { pid: u ? u.pid : pidOf(uid), nick: u ? u.nick : '?', online: !!o, inVoice: !!(o && o.inVoice) };
  });
}

function broadcast(serverId, eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload });
  clients.forEach(c => {
    if (c.serverId === serverId) c.res.write('data: ' + data + '\n\n');
  });
}

function broadcastUsers(serverId) {
  broadcast(serverId, 'users', memberList(serverId));
}

setInterval(() => {
  clients.forEach(c => c.res.write(': ping\n\n'));
}, 25000);

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>СИГНАЛ — Свои серверы и каналы</title>
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
  .demo-notice { height: 30px; background: #070c14; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; font-size: 11px; color: var(--text-dim); }
  .workspace { flex: 1; display: grid; grid-template-columns: 68px 250px 1fr 240px; overflow: hidden; }
  .servers-rail { background: #030508; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 10px; }
  .bolt-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--cyan-bright); font-size: 18px; margin-bottom: 4px; }
  .srv-ico { width: 42px; height: 42px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; }
  .srv-ico.active { background: var(--cyan-bright); color: #042f2e; border-color: var(--cyan-bright); box-shadow: 0 0 12px rgba(45, 212, 191, 0.4); }
  .srv-ico-add { background: transparent; border: 1px dashed var(--border); color: var(--pink); font-size: 18px; border-radius: 12px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .channels-panel { background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .srv-header { padding: 12px 14px 8px; display: flex; justify-content: space-between; align-items: center; }
  .srv-label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .srv-title { font-size: 15px; font-weight: 800; color: #fff; margin-top: 2px; }
  .btn-code-modal { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
  .freq-card { margin: 4px 10px 10px; padding: 12px; border-radius: 10px; background: linear-gradient(135deg, #111a24 0%, #0a0f16 100%); border: 1px solid var(--border); }
  .freq-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .freq-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }
  .live-badge { font-size: 9px; background: #9d174d; color: #fff; padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .freq-card h4 { font-size: 14px; font-weight: 800; line-height: 1.2; margin-bottom: 4px; }
  .freq-card p { font-size: 10px; color: var(--text-dim); line-height: 1.35; }
  .channels-scroll { flex: 1; overflow-y: auto; padding: 0 8px; }
  .cat-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
  .cat-add-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px; font-weight: bold; }
  .cat-add-btn:hover { color: #fff; }
  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }
  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }
  .ch-btn.active .ch-dot { display: block; }
  .connect-friend-box { margin: 8px; background: #070b12; border: 1px solid var(--border); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .connect-title { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .connect-row { display: flex; gap: 6px; }
  .connect-inp { flex: 1; background: #04060a; border: 1px solid var(--border); padding: 6px 8px; border-radius: 6px; color: #fff; font-size: 11px; outline: none; }
  .btn-connect { background: #0d9488; color: #fff; border: none; padding: 6px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; }
  .user-bar { padding: 8px 10px; background: #030508; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .user-info { display: flex; align-items: center; gap: 8px; }
  .user-ava { width: 28px; height: 28px; border-radius: 6px; background: #e11d48; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
  .user-name { font-size: 11px; font-weight: 700; }
  .user-sub { font-size: 9px; color: var(--text-muted); }
  .btn-login-mini { background: transparent; border: 1px solid var(--border); color: var(--cyan-bright); padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; cursor: pointer; }
  .main-chat { background: var(--bg-main); display: flex; flex-direction: column; overflow: hidden; }
  .chat-topbar { height: 48px; padding: 0 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .chat-topbar-left { display: flex; align-items: center; gap: 8px; }
  .hash-large { color: var(--cyan-bright); font-size: 18px; font-weight: 800;