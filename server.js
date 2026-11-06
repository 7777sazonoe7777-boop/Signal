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

const users = Object.create(null);
const pidToUid = Object.create(null);
const members = Object.create(null);
const servers = Object.create(null);
const rooms = Object.create(null);

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

const HTML_PAGE = '<!DOCTYPE html>\n' +
'<html lang="ru">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>СИГНАЛ — Свои серверы и каналы</title>\n' +
'<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"><\/script>\n' +
'<style>\n' +
'  :root {\n' +
'    --bg-darkest: #040609;\n' +
'    --bg-sidebar: #080d14;\n' +
'    --bg-main: #0b1118;\n' +
'    --bg-card: #0f1722;\n' +
'    --bg-input: #131c28;\n' +
'    --cyan: #14b8a6;\n' +
'    --cyan-bright: #2dd4bf;\n' +
'    --pink: #db2777;\n' +
'    --pink-border: rgba(219, 39, 119, 0.4);\n' +
'    --text-main: #f1f5f9;\n' +
'    --text-muted: #64748b;\n' +
'    --text-dim: #94a3b8;\n' +
'    --border: rgba(255, 255, 255, 0.08);\n' +
'    --cyan-border: rgba(45, 212, 191, 0.35);\n' +
'  }\n' +
'  * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'  body {\n' +
'    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
'    background-color: var(--bg-darkest); color: var(--text-main);\n' +
'    height: 100vh; display: flex; flex-direction: column; overflow: hidden; user-select: none;\n' +
'  }\n' +
'  .top-header { height: 38px; background: #030508; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 16px; gap: 12px; font-size: 12px; }\n' +
'  .top-logo { display: flex; align-items: center; gap: 6px; font-weight: 800; color: #fff; background: #e11d48; padding: 3px 8px; border-radius: 4px; font-size: 11px; }\n' +
'  .top-logo b { color: #fff; font-size: 10px; opacity: 0.85; }\n' +
'  .top-sub { color: var(--text-dim); }\n' +
'  .top-right-group { margin-left: auto; display: flex; align-items: center; gap: 12px; }\n' +
'  .node-status-badge { background: #064e3b; border: 1px solid #059669; color: #34d399; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; }\n' +
'  .btn-top-invite { background: #9d174d; border: 1px solid #f43f5e; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }\n' +
'  .demo-notice { height: 30px; background: #070c14; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; font-size: 11px; color: var(--text-dim); }\n' +
'  .workspace { flex: 1; display: grid; grid-template-columns: 68px 250px 1fr 240px; overflow: hidden; }\n' +
'  .servers-rail { background: #030508; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 10px; }\n' +
'  .bolt-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--cyan-bright); font-size: 18px; margin-bottom: 4px; }\n' +
'  .srv-ico { width: 42px; height: 42px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; }\n' +
'  .srv-ico.active { background: var(--cyan-bright); color: #042f2e; border-color: var(--cyan-bright); box-shadow: 0 0 12px rgba(45, 212, 191, 0.4); }\n' +
'  .srv-ico-add { background: transparent; border: 1px dashed var(--border); color: var(--pink); font-size: 18px; border-radius: 12px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; }\n' +
'  .channels-panel { background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }\n' +
'  .srv-header { padding: 12px 14px 8px; display: flex; justify-content: space-between; align-items: center; }\n' +
'  .srv-label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }\n' +
'  .srv-title { font-size: 15px; font-weight: 800; color: #fff; margin-top: 2px; }\n' +
'  .btn-code-modal { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }\n' +
'  .freq-card { margin: 4px 10px 10px; padding: 12px; border-radius: 10px; background: linear-gradient(135deg, #111a24 0%, #0a0f16 100%); border: 1px solid var(--border); }\n' +
'  .freq-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }\n' +
'  .freq-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }\n' +
'  .live-badge { font-size: 9px; background: #9d174d; color: #fff; padding: 1px 6px; border-radius: 4px; font-weight: 700; }\n' +
'  .freq-card h4 { font-size: 14px; font-weight: 800; line-height: 1.2; margin-bottom: 4px; }\n' +
'  .freq-card p { font-size: 10px; color: var(--text-dim); line-height: 1.35; }\n' +
'  .channels-scroll { flex: 1; overflow-y: auto; padding: 0 8px; }\n' +
'  .cat-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }\n' +
'  .cat-add-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px; font-weight: bold; }\n' +
'  .cat-add-btn:hover { color: #fff; }\n' +
'  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }\n' +
'  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }\n' +
'  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }\n' +
'  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }\n' +
'  .ch-btn.active .ch-dot { display: block; }\n' +
'  .connect-friend-box { margin: 8px; background: #070b12; border: 1px solid var(--border); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }\n' +
'  .connect-title { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }\n' +
'  .connect-row { display: flex; gap: 6px; }\n' +
'  .connect-inp { flex: 1; background: #04060a; border: 1px solid var(--border); padding: 6px 8px; border-radius: 6px; color: #fff; font-size: 11px; outline: none; }\n' +
'  .btn-connect { background: #0d9488; color: #fff; border: none; padding: 6px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; }\n' +
'  .user-bar { padding: 8px 10px; background: #030508; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }\n' +
'  .user-info { display: flex; align-items: center; gap: 8px; }\n' +
'  .user-ava { width: 28px; height: 28px; border-radius: 6px; background: #e11d48; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }\n' +
'  .user-name { font-size: 11px; font-weight: 700; }\n' +
'  .user-sub { font-size: 9px; color: var(--text-muted); }\n' +
'  .btn-login-mini { background: transparent; border: 1px solid var(--border); color: var(--cyan-bright); padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; cursor: pointer; }\n' +
'  .main-chat { background: var(--bg-main); display: flex; flex-direction: column; overflow: hidden; }\n' +
'  .chat-topbar { height: 48px; padding: 0 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }\n' +
'  .chat-topbar-left { display: flex; align-items: center; gap: 8px; }\n' +
'  .hash-large { color: var(--cyan-bright); font-size: 18px; font-weight: 800; }\n' +
'  .top-ch-name { font-size: 13px; font-weight: 700; }\n' +
'  .top-ch-desc { font-size: 10px; color: var(--text-muted); }\n' +
'  .btn-top-right-share { background: #0d9488; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }\n' +
'  .chat-scroll-area { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }\n' +
'  .hero-banner { background: linear-gradient(135deg, #0f1726 0%, #080e17 100%); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; }\n' +
'  .hero-banner-left { max-width: 420px; }\n' +
'  .hash-badge { width: 30px; height: 30px; border-radius: 8px; background: rgba(45, 212, 191, 0.12); border: 1px solid var(--cyan-border); color: var(--cyan-bright); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; margin-bottom: 8px; }\n' +
'  .welcome-tag { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; margin-bottom: 4px; }\n' +
'  .hero-banner h2 { font-size: 22px; font-weight: 800; margin-bottom: 6px; }\n' +
'  .hero-banner p { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; line-height: 1.4; }\n' +
'  .pill-tags-row { display: flex; gap: 6px; flex-wrap: wrap; }\n' +
'  .pill-tag { padding: 3px 8px; border-radius: 999px; font-size: 9px; font-weight: 700; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: #cbd5e1; cursor: pointer; }\n' +
'  .pill-tag.pink { background: rgba(219,39,119,0.15); border-color: rgba(219,39,119,0.4); color: #f43f5e; }\n' +
'  .radar-box { width: 110px; height: 110px; display: flex; align-items: center; justify-content: center; }\n' +
'  .messages-container { display: flex; flex-direction: column; gap: 8px; }\n' +
'  .msg-item { display: flex; gap: 10px; background: rgba(255,255,255,0.015); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); }\n' +
'  .msg-ava { width: 28px; height: 28px; border-radius: 6px; background: var(--cyan); color: #042f2e; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\n' +
'  .msg-author { font-size: 12px; font-weight: 700; color: #fff; margin-right: 6px; }\n' +
'  .msg-time { font-size: 9px; color: var(--text-muted); }\n' +
'  .msg-text { font-size: 12px; color: #e2e8f0; margin-top: 2px; user-select: text; word-break: break-word; }\n' +
'  .voice-panel { background: rgba(13, 148, 136, 0.06); border: 1px solid var(--cyan-border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }\n' +
'  .voice-panel-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }\n' +
'  .voice-label { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }\n' +
'  .voice-title { font-size: 12px; font-weight: 700; margin: 2px 0; }\n' +
'  .voice-sub { font-size: 10px; color: var(--text-dim); }\n' +
'  .voice-active-area { display: none; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }\n' +
'  .voice-active-area.show { display: flex; }\n' +
'  .voice-user-card { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); width: fit-content; }\n' +
'  .vu-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }\n' +
'  .chat-bottom { padding: 8px 18px 12px; border-top: 1px solid var(--border); background: #070b12; display: flex; flex-direction: column; gap: 6px; }\n' +
'  .auth-prompt-bar { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 600; }\n' +
'  .input-row { display: flex; gap: 8px; align-items: center; }\n' +
'  .chat-inp { flex: 1; background: var(--bg-input); border: 1px solid var(--border); padding: 9px 12px; border-radius: 6px; color: #fff; font-size: 12px; outline: none; }\n' +
'  .bottom-hint { font-size: 9px; color: var(--text-muted); }\n' +
'  .right-panel { background: var(--bg-sidebar); border-left: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }\n' +
'  .right-sec-title { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }\n' +
'  .online-user-item { display: flex; align-items: center; justify-content: space-between; font-size: 11px; padding: 5px 8px; background: rgba(255,255,255,0.02); border-radius: 6px; }\n' +
'  .online-user-left { display: flex; align-items: center; gap: 6px; }\n' +
'  .online-dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }\n' +
'  .online-dot.off { background: #475569; }\n' +
'  .mini-btn { background: transparent; border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; cursor: pointer; }\n' +
'  .mini-btn:hover { background: rgba(20, 184, 166, 0.12); }\n' +
'  .friend-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }\n' +
'  .friends-section { border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }\n' +
'  .btn-cyan { background: var(--cyan-bright); color: #042f2e; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }\n' +
'  .btn-danger { background: #ef4444; color: #fff; border: none; padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }\n' +
'  .btn-mute { background: #1e293b; color: #fff; border: 1px solid var(--border); padding: 7px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; }\n' +
'  .btn-pink-card { background: #9d174d; color: #fff; border: none; width: 100%; padding: 7px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }\n' +
'  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 999; }\n' +
'  .modal-backdrop.open { display: flex; }\n' +
'  .modal-box { background: var(--bg-card); border: 1px solid var(--cyan-border); border-radius: 12px; padding: 20px; width: 360px; }\n' +
'  .modal-box input { width: 100%; padding: 8px 10px; background: #04060a; border: 1px solid var(--border); border-radius: 6px; color: #fff; margin-bottom: 10px; font-size: 12px; outline: none; user-select: text; }\n' +
'  .link-box { background: #030508; border: 1px dashed var(--cyan-bright); padding: 8px; color: var(--cyan-bright); font-size: 11px; word-break: break-all; margin-bottom: 10px; border-radius: 6px; display: block; text-decoration: none; text-align: center; user-select: text; }\n' +
'  .link-box:hover { background: rgba(20, 184, 166, 0.1); }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'  <div class="top-header">\n' +
'    <div class="top-logo">СИГНАЛ <b>CYBER.NET</b></div>\n' +
'    <div class="top-sub">МЕСТО ДЛЯ СВОИХ // СВОИ СЕРВЕРЫ</div>\n' +
'    <div class="top-right-group">\n' +
'      <div class="node-status-badge" id="node-badge">Узел активен</div>\n' +
'      <button class="btn-top-invite" onclick="openInviteModal()">ПРИГЛАСИТЬ ДРУГА</button>\n' +
'    </div>\n' +
'  </div>\n' +
'  <div class="demo-notice">\n' +
'    <span><b>СЕТЬ СЕРВЕРОВ:</b> Создавайте свои серверы, текстовые и голосовые каналы, добавляйте друзей</span>\n' +
'    <span style="font-weight:700;color:var(--cyan-bright);" id="room-code-label">Комната: <b>...</b></span>\n' +
'  </div>\n' +
'  <div class="workspace">\n' +
'    <div class="servers-rail" id="servers-rail">\n' +
'      <div class="bolt-icon">⚡</div>\n' +
'      <div class="srv-ico active" data-id="neon-club" onclick="switchServer(\'neon-club\', this)" title="Ночной клуб">НК</div>\n' +
'      <div class="srv-ico-add" onclick="openCreateServerModal()" title="Создать сервер">+</div>\n' +
'    </div>\n' +
'    <div class="channels-panel">\n' +
'      <div class="srv-header">\n' +
'        <div>\n' +
'          <div class="srv-label">СЕРВЕР</div>\n' +
'          <div class="srv-title" id="sidebar-server-name">Ночной клуб</div>\n' +
'        </div>\n' +
'        <button class="btn-code-modal" onclick="promptRoomCode()">Код</button>\n' +
'      </div>\n' +
'      <div class="freq-card">\n' +
'        <div class="freq-top">\n' +
'          <span class="freq-tag" id="server-freq-tag">ЧАСТОТА 108.4 FM</span>\n' +
'          <span class="live-badge">LIVE</span>\n' +
'        </div>\n' +
'        <h4 id="server-card-title">Лови свою частоту.</h4>\n' +
'        <p id="server-card-desc">Игры, идеи и разговоры после полуночи</p>\n' +
'      </div>\n' +
'      <div class="channels-scroll">\n' +
'        <div class="cat-header">\n' +
'          <span>ТЕКСТОВЫЕ КАНАЛЫ</span>\n' +
'          <button class="cat-add-btn" onclick="createChannel(\'text\')" title="Создать текстовый канал">+</button>\n' +
'        </div>\n' +
'        <div id="text-channels-list"></div>\n' +
'        <div class="cat-header" style="margin-top: 12px;">\n' +
'          <span>ГОЛОСОВЫЕ КАНАЛЫ</span>\n' +
'          <button class="cat-add-btn" onclick="createChannel(\'voice\')" title="Создать голосовой канал">+</button>\n' +
'        </div>\n' +
'        <div id="voice-channels-list"></div>\n' +
'      </div>\n' +
'      <div class="connect-friend-box">\n' +
'        <div class="connect-title">СВЯЗЬ С ДРУГОМ <span style="color:var(--cyan-bright);">// P2P</span></div>\n' +
'        <div class="connect-row">\n' +
'          <input type="text" id="friend-code-inp" class="connect-inp" placeholder="Код сервера...">\n' +
'          <button class="btn-connect" onclick="connectToFriend()">ВОЙТИ</button>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="user-bar">\n' +
'        <div class="user-info">\n' +
'          <div class="user-ava" id="user-ava">ГО</div>\n' +
'          <div>\n' +
'            <div class="user-name" id="user-name-label">Гость</div>\n' +
'            <div class="user-sub">Онлайн</div>\n' +
'          </div>\n' +
'        </div>\n' +
'        <button class="btn-login-mini" onclick="openAuthModal()">ПРОФИЛЬ</button>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div class="main-chat">\n' +
'      <div class="chat-topbar">\n' +
'        <div class="chat-topbar-left">\n' +
'          <span class="hash-large" id="chat-prefix">#</span>\n' +
'          <div>\n' +
'            <div class="top-ch-name" id="top-ch-name">игровая-комната</div>\n' +
'            <div class="top-ch-desc" id="top-ch-desc">Канал сервера</div>\n' +
'          </div>\n' +
'        </div>\n' +
'        <button class="btn-top-right-share" onclick="openInviteModal()">🔗 ДАТЬ ССЫЛКУ ДРУГУ</button>\n' +
'      </div>\n' +
'      <div class="chat-scroll-area" id="chat-scroll">\n' +
'        <div class="hero-banner" id="chat-hero-banner">\n' +
'          <div class="hero-banner-left">\n' +
'            <div class="hash-badge" id="banner-hash">#</div>\n' +
'            <div class="welcome-tag">НАЧАЛО КАНАЛА</div>\n' +
'            <h2 id="banner-h2">Кто сегодня на связи?</h2>\n' +
'            <p id="banner-desc">Общайтесь с друзьями в реальном времени.</p>\n' +
'            <div class="pill-tags-row">\n' +
'              <span class="pill-tag pink" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА</span>\n' +
'            </div>\n' +
'          </div>\n' +
'          <div class="radar-box">\n' +
'            <svg width="110" height="110" viewBox="0 0 140 140" fill="none">\n' +
'              <circle cx="70" cy="70" r="62" stroke="rgba(45,212,191,0.15)" stroke-width="1"/>\n' +
'              <circle cx="70" cy="70" r="44" stroke="rgba(219,39,119,0.45)" stroke-width="1.5" stroke-dasharray="18 10"/>\n' +
'              <circle cx="70" cy="70" r="28" stroke="rgba(45,212,191,0.35)" stroke-width="1.5"/>\n' +
'              <path d="M54 70 H62 L66 58 L74 82 L78 70 H86" stroke="#2dd4bf" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>\n' +
'            </svg>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="messages-container" id="messages-list"></div>\n' +
'        <div class="voice-panel" id="voice-panel-box" style="display:none;">\n' +
'          <div class="voice-panel-top">\n' +
'            <div>\n' +
'              <div class="voice-label">ГОЛОСОВОЙ КАНАЛ // WEBRTC P2P</div>\n' +
'              <div class="voice-title" id="active-voice-title">Голосовой эфир</div>\n' +
'              <div class="voice-sub">Говорите в микрофон — участники канала слышат вас.</div>\n' +
'            </div>\n' +
'            <div style="display:flex;gap:6px;align-items:center;">\n' +
'              <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>\n' +
'              <button class="btn-cyan" id="connect-voice-btn" onclick="toggleVoiceCall()">ПОДКЛЮЧИТЬСЯ</button>\n' +
'            </div>\n' +
'          </div>\n' +
'          <div class="voice-active-area" id="voice-active-area">\n' +
'            <div class="voice-user-card">\n' +
'              <span class="vu-dot"></span>\n' +
'              <span id="voice-my-name" style="font-size:11px;font-weight:700;">Гость (Вы)</span>\n' +
'            </div>\n' +
'            <div id="audio-box"></div>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="chat-bottom" id="chat-bottom-area">\n' +
'        <form class="input-row" onsubmit="sendChatMessage(event)">\n' +
'          <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">\n' +
'          <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>\n' +
'        </form>\n' +
'        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • СВОИ СЕРВЕРЫ И КАНАЛЫ</div>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div class="right-panel">\n' +
'      <div class="right-sec-title">НА СВЯЗИ (<span id="online-count">1</span>)</div>\n' +
'      <div id="online-users-box"></div>\n' +
'      <div class="friends-section">\n' +
'        <div class="right-sec-title">ДРУЗЬЯ (<span id="friends-count">0</span>)</div>\n' +
'        <div id="requests-box"></div>\n' +
'        <div id="friends-box" style="font-size:11px; color:var(--text-dim);">Нет друзей</div>\n' +
'      </div>\n' +
'      <div class="invite-banner-card" style="margin-top:auto; background:linear-gradient(135deg, rgba(219,39,119,0.12), rgba(13,148,136,0.06)); border:1px solid var(--pink-border); border-radius:10px; padding:10px;">\n' +
'        <h5 style="font-size:11px; font-weight:700; margin-bottom:3px;">Свой сервер</h5>\n' +
'        <p style="font-size:10px; color:var(--text-dim); margin-bottom:8px;">Создайте уникальное пространство для друзей.</p>\n' +
'        <button class="btn-pink-card" onclick="openCreateServerModal()">+ СОЗДАТЬ СЕРВЕР</button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">\n' +
'    <div class="modal-box">\n' +
'      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Пригласить на сервер</h3>\n' +
'      <a class="link-box" id="public-invite-url" href="#" target="_blank" rel="noopener">Генерация ссылки...</a>\n' +
'      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button>\n' +
'      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeInviteModal()">Закрыть</button>\n' +
'    </div>\n' +
'  </div>\n' +
'  <div class="modal-backdrop" id="auth-modal" onclick="if(event.target===this)closeAuthModal()">\n' +
'    <div class="modal-box">\n' +
'      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Сменить позывной</h3>\n' +
'      <input type="text" id="new-nick-inp" placeholder="Ваш новый позывной" maxlength="24">\n' +
'      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="saveMyNick()">Сохранить</button>\n' +
'      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeAuthModal()">Закрыть</button>\n' +
'    </div>\n' +
'  </div>\n' +
'  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">\n' +
'    <div class="modal-box">\n' +
'      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Создать свой сервер</h3>\n' +
'      <input type="text" id="new-srv-name" placeholder="Название сервера (например, Клан Аниме)" maxlength="32">\n' +
'      <input type="text" id="new-srv-desc" placeholder="Описание или тема" maxlength="64">\n' +
'      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">Создать</button>\n' +
'      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeCreateServerModal()">Отмена</button>\n' +
'    </div>\n' +
'  </div>\n' +
'<script>\n' +
'  const params = new URLSearchParams(window.location.search);\n' +
'  function makeUid() {\n' +
'    const a = new Uint8Array(16);\n' +
'    (window.crypto || window.msCrypto).getRandomValues(a);\n' +
'    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");\n' +
'  }\n' +
'  let myUid = null;\n' +
'  try { myUid = localStorage.getItem("cyber_uid"); } catch (e) {}\n' +
'  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {\n' +
'    myUid = makeUid();\n' +
'    try { localStorage.setItem("cyber_uid", myUid); } catch (e) {}\n' +
'  }\n' +
'  let currentServerId = params.get("server");\n' +
'  if (!currentServerId) { try { currentServerId = localStorage.getItem("cyber_last_server"); } catch (e) {} }\n' +
'  currentServerId = currentServerId || "cy-4371";\n' +
'  try { localStorage.setItem("cyber_last_server", currentServerId); } catch (e) {}\n' +
'  let currentChannel = params.get("channel") || "игровая-комната";\n' +
'  let channelType = params.get("type") || "text";\n' +
'  let myNick = "Гость_932";\n' +
'  try { myNick = localStorage.getItem("cyber_nick") || "Гость_932"; } catch (e) {}\n' +
'  document.getElementById("user-name-label").textContent = myNick;\n' +
'  document.getElementById("user-ava").textContent = myNick.slice(0, 2).toUpperCase();\n' +
'  document.getElementById("voice-my-name").textContent = myNick + " (Вы)";\n' +
'  document.getElementById("room-code-label").innerHTML = "Сервер: <b>" + escapeHtml(currentServerId) + "</b>";\n' +
'  const evtSource = new EventSource("/api/events?id=" + Math.random().toString(36).substring(2,10) + "&uid=" + myUid + "&server=" + encodeURIComponent(currentServerId) + "&nick=" + encodeURIComponent(myNick));\n' +
'  let globalServersData = {};\n' +
'  let globalUserData = { friends: [], requests: [] };\n' +
'  let myPid = null;\n' +
'  let lastMembers = [];\n' +
'  let social = { friends: [], incoming: [], outgoing: [] };\n' +
'  function escapeHtml(s) {\n' +
'    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\x27/g, "&#39;");\n' +
'  }\n' +
'  evtSource.onmessage = (e) => {\n' +
'    let data;\n' +
'    try { data = JSON.parse(e.data); } catch (err) { return; }\n' +
'    if (data.type === "state") {\n' +
'      globalServersData = data.payload.servers || {};\n' +
'      globalUserData = data.payload.user || { friends: [], requests: [] };\n' +
'      renderServersList();\n' +
'      renderCurrentServer();\n' +
'      renderUsers(data.payload.users);\n' +
'      renderSocial();\n' +
'    } else if (data.type === "social") {\n' +
'      myPid = data.payload.pid;\n' +
'      social = data.payload;\n' +
'      renderSocial();\n' +
'      renderUsers(lastMembers);\n' +
'    } else if (data.type === "voice-join") {\n' +
'      if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId) {\n' +
'        const pid = data.payload.peerId;\n' +
'        const call = peer.call(pid, localStream);\n' +
'        if (!call) return;\n' +
'        call.on("stream", (remoteStream) => playStream(pid, remoteStream));\n' +
'        call.on("close", () => removeAudio(pid));\n' +
'        call.on("error", () => removeAudio(pid));\n' +
'      }\n' +
'    }\n' +
'  };\n' +
'  function renderServersList() {\n' +
'    const rail = document.getElementById("servers-rail");\n' +
'    rail.querySelectorAll(".custom-srv").forEach(el => el.remove());\n' +
'    const addBtn = rail.querySelector(".srv-ico-add");\n' +
'    for (let sId in globalServersData) {\n' +
'      const s = globalServersData[sId];\n' +
'      const div = document.createElement("div");\n' +
'      div.className = "srv-ico custom-srv" + (sId === currentServerId ? " active" : "");\n' +
'      div.textContent = s.icon || s.name.slice(0, 2).toUpperCase();\n' +
'      div.title = s.name;\n' +
'      div.onclick = () => {\n' +
'        currentServerId = sId;\n' +
'        try { localStorage.setItem("cyber_last_server", currentServerId); } catch (e) {}\n' +
'        const tChs = s.textChannels || ["общий"];\n' +
'        currentChannel = tChs[0];\n' +
'        channelType = "text";\n' +
'        updateUrlAndReload();\n' +
'      };\n' +
'      rail.insertBefore(div, addBtn);\n' +
'    }\n' +
'  }\n' +
'  function renderCurrentServer() {\n' +
'    const s = globalServersData[currentServerId];\n' +
'    if (!s) return;\n' +
'    document.getElementById("sidebar-server-name").textContent = s.name;\n' +
'    document.getElementById("server-card-title").textContent = s.name;\n' +
'    document.getElementById("server-card-desc").textContent = s.desc || "";\n' +
'    const tChs = s.textChannels || [];\n' +
'    const vChs = s.voiceChannels || [];\n' +
'    if (channelType === "text" && !tChs.includes(currentChannel) && tChs.length > 0) {\n' +
'      currentChannel = tChs[0];\n' +
'    } else if (channelType === "voice" && !vChs.includes(currentChannel) && vChs.length > 0) {\n' +
'      currentChannel = vChs[0];\n' +
'    }\n' +
'    const textList = document.getElementById("text-channels-list");\n' +
'    textList.innerHTML = "";\n' +
'    tChs.forEach(ch => {\n' +
'      const div = document.createElement("div");\n' +
'      div.className = "ch-btn" + (channelType === "text" && currentChannel === ch ? " active" : "");\n' +
'      div.innerHTML = "<span># " + escapeHtml(ch) + "</span><span class=\"ch-dot\"></span>";\n' +
'      div.onclick = () => {\n' +
'        currentChannel = ch;\n' +
'        channelType = "text";\n' +
'        updateUIChannel();\n' +
'      };\n' +
'      textList.appendChild(div);\n' +
'    });\n' +
'    const voiceList = document.getElementById("voice-channels-list");\n' +
'    voiceList.innerHTML = "";\n' +
'    vChs.forEach(ch => {\n' +
'      const div = document.createElement("div");\n' +
'      div.className = "ch-btn" + (channelType === "voice" && currentChannel === ch ? " active" : "");\n' +
'      div.innerHTML = "<span>🔊 " + escapeHtml(ch) + "</span><span class=\"ch-dot\"></span>";\n' +
'      div.onclick = () => {\n' +
'        currentChannel = ch;\n' +
'        channelType = "voice";\n' +
'        updateUIChannel();\n' +
'      };\n' +
'      voiceList.appendChild(div);\n' +
'    });\n' +
'    updateUIChannel();\n' +
'  }\n' +
'  function updateUIChannel() {\n' +
'    document.getElementById("top-ch-name").textContent = currentChannel;\n' +
'    document.getElementById("chat-prefix").textContent = channelType === "text" ? "#" : "🔊";\n' +
'    document.getElementById("top-ch-desc").textContent = channelType === "text" ? "Текстовый канал" : "Голосовой канал";\n' +
'    if (channelType === "text") {\n' +
'      document.getElementById("chat-scroll").style.display = "flex";\n' +
'      document.getElementById("chat-bottom-area").style.display = "flex";\n' +
'      document.getElementById("voice-panel-box").style.display = "none";\n' +
'      loadHistory();\n' +
'    } else {\n' +
'      document.getElementById("chat-scroll").style.display = "flex";\n' +
'      document.getElementById("chat-bottom-area").style.display = "none";\n' +
'      document.getElementById("voice-panel-box").style.display = "flex";\n' +
'      document.getElementById("active-voice-title").textContent = "Голосовой канал: " + currentChannel;\n' +
'    }\n' +
'  }\n' +
'  function loadHistory() {\n' +
'    const ch = currentChannel;\n' +
'    fetch("/api/history?server=" + encodeURIComponent(currentServerId) + "&channel=" + encodeURIComponent(ch))\n' +
'      .then(r => r.json())\n' +
'      .then(msgs => {\n' +
'        if (ch !== currentChannel) return;\n' +
'        const box = document.getElementById("messages-list");\n' +
'        box.innerHTML = "";\n' +
'        if (!msgs || msgs.length === 0) {\n' +
'          box.innerHTML = \'<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>\';\n' +
'          return;\n' +
'        }\n' +
'        msgs.forEach(addMsgToDOM);\n' +
'      })\n' +
'      .catch(() => {});\n' +
'  }\n' +
'  function addMsgToDOM(m) {\n' +
'    const box = document.getElementById("messages-list");\n' +
'    const hint = document.getElementById("empty-hint");\n' +
'    if (hint) hint.remove();\n' +
'    const author = String(m.author || "?");\n' +
'    const div = document.createElement("div");\n' +
'    div.className = "msg-item";\n' +
'    div.innerHTML = \'<div class="msg-ava">\' + escapeHtml(author.charAt(0).toUpperCase()) + \'</div>\' +\n' +
'      \'<div><div><span class="msg-author">\' + escapeHtml(author) + \'</span><span class="msg-time">\' + escapeHtml(m.time) + \'</span></div>\' +\n' +
'      \'<div class="msg-text">\' + escapeHtml(m.text) + \'</div></div>\';\n' +
'    box.appendChild(div);\n' +
'    const scrollArea = document.getElementById("chat-scroll");\n' +
'    scrollArea.scrollTop = scrollArea.scrollHeight;\n' +
'  }\n' +
'  function sendChatMessage(e) {\n' +
'    e.preventDefault();\n' +
'    const inp = document.getElementById("chat-input");\n' +
'    const text = inp.value.trim();\n' +
'    if (!text) return;\n' +
'    fetch("/api/message", {\n' +
'      method: "POST",\n' +
'      headers: { "Content-Type": "application/json" },\n' +
'      body: JSON.stringify({ uid: myUid, serverId: currentServerId, channel: currentChannel, author: myNick, text })\n' +
'    }).catch(() => alert("Не удалось отправить сообщение."));\n' +
'    inp.value = "";\n' +
'  }\n' +
'  function el(tag, cls, text) {\n' +
'    const e = document.createElement(tag);\n' +
'    if (cls) e.className = cls;\n' +
'    if (text !== undefined) e.textContent = text;\n' +
'    return e;\n' +
'  }\n' +
'  function friendAction(action, pid) {\n' +
'    return fetch("/api/friend", { method: "POST", body: JSON.stringify({ uid: myUid, action: action, target: pid }) })\n' +
'      .then(function (r) { return r.json(); })\n' +
'      .then(function (d) { if (d.error) alert(d.error); })\n' +
'      .catch(function () { alert("Ошибка соединения."); });\n' +
'  }\n' +
'  function renderUsers(list) {\n' +
'    lastMembers = list || [];\n' +
'    const online = lastMembers.filter(function (u) { return u.online; });\n' +
'    document.getElementById("online-count").textContent = online.length;\n' +
'    const box = document.getElementById("online-users-box");\n' +
'    box.innerHTML = "";\n' +
'    const sorted = online.concat(lastMembers.filter(function (u) { return !u.online; }));\n' +
'    const friendPids = social.friends.map(function (f) { return f.pid; });\n' +
'    sorted.forEach(function (u) {\n' +
'      const d = el("div", "online-user-item");\n' +
'      if (!u.online) d.style.opacity = "0.5";\n' +
'      d.appendChild(el("span", "online-dot" + (u.online ? "" : " off")));\n' +
'      const name = el("span", "", u.nick + (u.pid === myPid ? " (вы)" : "") + (u.inVoice ? " 🔊" : ""));\n' +
'      name.style.flex = "1";\n' +
'      d.appendChild(name);\n' +
'      if (myPid && u.pid !== myPid) {\n' +
'        if (friendPids.indexOf(u.pid) >= 0) {\n' +
'          d.appendChild(el("span", "friend-tag", "друг"));\n' +
'        } else if (social.outgoing.indexOf(u.pid) >= 0) {\n' +
'          d.appendChild(el("span", "friend-tag", "заявка"));\n' +
'        } else if (social.incoming.some(function (i) { return i.pid === u.pid; })) {\n' +
'          const b = el("button", "mini-btn", "принять");\n' +
'          b.onclick = function () { friendAction("accept", u.pid); };\n' +
'          d.appendChild(b);\n' +
'        } else {\n' +
'          const b = el("button", "mini-btn", "+ друг");\n' +
'          b.onclick = function () { friendAction("request", u.pid); };\n' +
'          d.appendChild(b);\n' +
'        }\n' +
'      }\n' +
'      box.appendChild(d);\n' +
'    });\n' +
'  }\n' +
'  function renderSocial() {\n' +
'    document.getElementById("friends-count").textContent = social.friends.length;\n' +
'    const rq = document.getElementById("requests-box");\n' +
'    rq.innerHTML = "";\n' +
'    social.incoming.forEach(function (r) {\n' +
'      const d = el("div", "online-user-item");\n' +
'      const name = el("span", "", r.nick + " хочет в друзья");\n' +
'      name.style.flex = "1";\n' +
'      const ok = el("button", "mini-btn", "✓");\n' +
'      ok.onclick = function () { friendAction("accept", r.pid); };\n' +
'      const no = el("button", "mini-btn", "✕");\n' +
'      no.onclick = function () { friendAction("decline", r.pid); };\n' +
'      d.appendChild(name);\n' +
'      d.appendChild(ok);\n' +
'      d.appendChild(no);\n' +
'      rq.appendChild(d);\n' +
'    });\n' +
'    const fb = document.getElementById("friends-box");\n' +
'    fb.innerHTML = "";\n' +
'    if (social.friends.length === 0) {\n' +
'      const hint = el("div", "", "Пока никого.");\n' +
'      hint.style.cssText = "font-size:10px;color:var(--text-muted);";\n' +
'      fb.appendChild(hint);\n' +
'    }\n' +
'    social.friends.forEach(function (f) {\n' +
'      const d = el("div", "online-user-item");\n' +
'      if (!f.online) d.style.opacity = "0.5";\n' +
'      d.appendChild(el("span", "online-dot" + (f.online ? "" : " off")));\n' +
'      const name = el("span", "", f.nick);\n' +
'      name.style.flex = "1";\n' +
'      d.appendChild(name);\n' +
'      const rmb = el("button", "mini-btn", "✕");\n' +
'      rmb.title = "Удалить из друзей";\n' +
'      rmb.onclick = function () { if (confirm("Удалить " + f.nick + " из друзей?")) friendAction("remove", f.pid); };\n' +
'      d.appendChild(rmb);\n' +
'      fb.appendChild(d);\n' +
'    });\n' +
'  }\n' +
'  function createChannel(type) {\n' +
'    const tName = type === "text" ? "текстового" : "голосового";\n' +
'    const name = prompt("Введите название нового " + tName + " канала:");\n' +
'    if (!name || !name.trim()) return;\n' +
'    const clean = name.trim().toLowerCase().replace(/\\s+/g, "-").slice(0, 32);\n' +
'    fetch("/api/channel/create", {\n' +
'      method: "POST",\n' +
'      headers: { "Content-Type": "application/json" },\n' +
'      body: JSON.stringify({ uid: myUid, serverId: currentServerId, type: type, name: clean })\n' +
'    }).then(r => r.json()).then(d => {\n' +
'      if (d.error) alert(d.error);\n' +
'      else {\n' +
'        currentChannel = clean;\n' +
'        channelType = type;\n' +
'        updateUrlAndReload();\n' +
'      }\n' +
'    }).catch(() => alert("Ошибка соединения."));\n' +
'  }\n' +
'  function openCreateServerModal() { document.getElementById("create-server-modal").classList.add("open"); }\n' +
'  function closeCreateServerModal() { document.getElementById("create-server-modal").classList.remove("open"); }\n' +
'  function submitCreateServer() {\n' +
'    const name = document.getElementById("new-srv-name").value.trim();\n' +
'    const desc = document.getElementById("new-srv-desc").value.trim();\n' +
'    if (!name) return alert("Введите название!");\n' +
'    fetch("/api/server/create", {\n' +
'      method: "POST",\n' +
'      headers: { "Content-Type": "application/json" },\n' +
'      body: JSON.stringify({ uid: myUid, name: name, desc: desc })\n' +
'    }).then(r => r.json()).then(d => {\n' +
'      if (d.error) alert(d.error);\n' +
'      else if (d.success) {\n' +
'        currentServerId = d.serverId;\n' +
'        try { localStorage.setItem("cyber_last_server", currentServerId); } catch (e) {}\n' +
'        currentChannel = "общий";\n' +
'        channelType = "text";\n' +
'        updateUrlAndReload();\n' +
'      }\n' +
'    }).catch(() => alert("Ошибка соединения."));\n' +
'  }\n' +
'  function updateUrlAndReload() {\n' +
'    window.location.href = window.location.origin + "/?server=" + encodeURIComponent(currentServerId) + "&channel=" + encodeURIComponent(currentChannel) + "&type=" + encodeURIComponent(channelType);\n' +
'  }\n' +
'  function connectToFriend() {\n' +
'    const code = document.getElementById("friend-code-inp").value.trim();\n' +
'    if (!code) return alert("Введите ID сервера!");\n' +
'    currentServerId = code;\n' +
'    try { localStorage.setItem("cyber_last_server", currentServerId); } catch (e) {}\n' +
'    updateUrlAndReload();\n' +
'  }\n' +
'  function promptRoomCode() {\n' +
'    const code = prompt("ID текущего сервера:", currentServerId);\n' +
'    if (code && code.trim()) {\n' +
'      try {\n' +
'        navigator.clipboard.writeText(code.trim());\n' +
'        alert("ID скопирован в буфер обмена: " + code.trim());\n' +
'      } catch (e) {\n' +
'        prompt("Скопируйте ID:", code.trim());\n' +
'      }\n' +
'    }\n' +
'  }\n' +
'  async function openInviteModal() {\n' +
'    document.getElementById("invite-modal").classList.add("open");\n' +
'    const linkEl = document.getElementById("public-invite-url");\n' +
'    linkEl.textContent = "Создание ссылки...";\n' +
'    linkEl.href = "#";\n' +
'    let base = window.location.origin;\n' +
'    try {\n' +
'      const res = await fetch("/api/invite-info");\n' +
'      const data = await res.json();\n' +
'      if (data.publicUrl) base = data.publicUrl;\n' +
'    } catch (e) {}\n' +
'    const finalUrl = base + "/?server=" + encodeURIComponent(currentServerId);\n' +
'    linkEl.textContent = finalUrl;\n' +
'    linkEl.href = finalUrl;\n' +
'  }\n' +
'  function closeInviteModal() { document.getElementById("invite-modal").classList.remove("open"); }\n' +
'  async function copyInviteLink() {\n' +
'    const url = document.getElementById("public-invite-url").textContent;\n' +
'    try {\n' +
'      await navigator.clipboard.writeText(url);\n' +
'      alert("Ссылка скопирована!");\n' +
'    } catch (e) {\n' +
'      prompt("Скопируйте ссылку вручную:", url);\n' +
'    }\n' +
'  }\n' +
'  function openAuthModal() { document.getElementById("auth-modal").classList.add("open"); }\n' +
'  function closeAuthModal() { document.getElementById("auth-modal").classList.remove("open"); }\n' +
'  function saveMyNick() {\n' +
'    const val = document.getElementById("new-nick-inp").value.trim().slice(0, 24);\n' +
'    if (val) {\n' +
'      myNick = val;\n' +
'      try { localStorage.setItem("cyber_nick", myNick); } catch (e) {}\n' +
'      fetch("/api/nick", {\n' +
'        method: "POST",\n' +
'        headers: { "Content-Type": "application/json" },\n' +
'        body: JSON.stringify({ uid: myUid, nick: myNick })\n' +
'      }).then(() => location.reload()).catch(() => location.reload());\n' +
'    }\n' +
'  }\n' +
'  let localStream = null, peer = null, myPeerId = null, inVoice = false;\n' +
'  async function toggleVoiceCall() {\n' +
'    if (inVoice) {\n' +
'      if (localStream) localStream.getTracks().forEach(t => t.stop());\n' +
'      if (peer) peer.destroy();\n' +
'      localStream = null;\n' +
'      peer = null;\n' +
'      myPeerId = null;\n' +
'      inVoice = false;\n' +
'      document.getElementById("connect-voice-btn").textContent = "ПОДКЛЮЧИТЬСЯ";\n' +
'      document.getElementById("connect-voice-btn").className = "btn-cyan";\n' +
'      document.getElementById("mute-btn").style.display = "none";\n' +
'      document.getElementById("voice-active-area").classList.remove("show");\n' +
'      fetch("/api/voice", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ uid: myUid, serverId: currentServerId, inVoice: false }) });\n' +
'      return;\n' +
'    }\n' +
'    try {\n' +
'      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });\n' +
'    } catch (e) {\n' +
'      alert("Разрешите доступ к микрофону!");\n' +
'      return;\n' +
'    }\n' +
'    inVoice = true;\n' +
'    document.getElementById("connect-voice-btn").textContent = "ОТКЛЮЧИТЬСЯ";\n' +
'    document.getElementById("connect-voice-btn").className = "btn-danger";\n' +
'    document.getElementById("mute-btn").style.display = "inline-block";\n' +
'    document.getElementById("voice-active-area").classList.add("show");\n' +
'    peer = new Peer();\n' +
'    peer.on("open", (id) => {\n' +
'      myPeerId = id;\n' +
'      fetch("/api/voice", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ uid: myUid, serverId: currentServerId, inVoice: true, peerId: id }) });\n' +
'    });\n' +
'    peer.on("call", (call) => {\n' +
'      call.answer(localStream);\n' +
'      call.on("stream", (remoteStream) => playStream(call.peer, remoteStream));\n' +
'      call.on("close", () => removeAudio(call.peer));\n' +
'      call.on("error", () => removeAudio(call.peer));\n' +
'    });\n' +
'    peer.on("error", () => {});\n' +
'  }\n' +
'  let isMuted = false;\n' +
'  function toggleMute() {\n' +
'    if (!localStream) return;\n' +
'    isMuted = !isMuted;\n' +
'    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);\n' +
'    document.getElementById("mute-btn").textContent = isMuted ? "🔇 Микр. выкл" : "🎤 Микр. вкл";\n' +
'  }\n' +
'  function playStream(id, stream) {\n' +
'    if (document.getElementById("aud-" + id)) return;\n' +
'    const audio = document.createElement("audio");\n' +
'    audio.id = "aud-" + id;\n' +
'    audio.srcObject = stream;\n' +
'    audio.autoplay = true;\n' +
'    document.getElementById("audio-box").appendChild(audio);\n' +
'  }\n' +
'  function removeAudio(id) {\n' +
'    const el = document.getElementById("aud-" + id);\n' +
'    if (el) el.remove();\n' +
'  }\n' +
'</script>\n' +
'</body>\n' +
'</html>';

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; body = ''; }
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
      const serverId = safeServerId(url.searchParams.get('server'));
      const nick = cleanNick(url.searchParams.get('nick'));
      const uid = url.searchParams.get('uid');
      if (!validUid(uid)) { res.writeHead(400); return res.end(); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      getOrCreateServer(serverId);
      const user = ensureUser(uid, nick);
      addMember(serverId, uid);

      const client = { id, uid, serverId, nick: user.nick, inVoice: false, peerId: null, res };
      clients.push(client);

      const usersList = memberList(serverId);
      res.write('data: ' + JSON.stringify({ type: 'state', payload: { servers: servers, user: { friends: user.friends, incoming: user.incoming, outgoing: user.outgoing }, users: usersList } }) + '\n\n');

      broadcastUsers(serverId);
      sendSocial(uid);
      notifyFriendsOf(uid);

      req.on('close', () => {
        clients = clients.filter(c => c !== client);
        broadcastUsers(serverId);
        notifyFriendsOf(uid);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const sId = safeServerId(url.searchParams.get('server'));
      const channel = safeChannel(url.searchParams.get('channel'));
      const list = getRoomMessages(sId, channel);
      return sendJson(res, 200, list);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') {
      return sendJson(res, 200, { publicUrl: null });
    }

    // Создание сервера
    if (req.method === 'POST' && url.pathname === '/api/server/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Необходима авторизация' });
      const name = String(body.name || '').trim().slice(0, 32);
      const desc = String(body.desc || '').trim().slice(0, 64);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера' });

      const sId = 'srv_' + crypto.randomBytes(3).toString('hex');
      servers[sId] = makeDefaultServer(sId, name, desc, uid);
      rooms[sId] = Object.create(null);
      rooms[sId]['общий'] = [{ author: 'СИСТЕМА', time: '00:00', text: 'Сервер «' + name + '» успешно создан!' }];

      scheduleSave(sId);
      return sendJson(res, 200, { success: true, serverId: sId });
    }

    // Создание канала (текстового или голосового)
    if (req.method === 'POST' && url.pathname === '/api/channel/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Необходима авторизация' });
      const serverId = safeServerId(body.serverId);
      const type = body.type === 'voice' ? 'voice' : 'text';
      const name = String(body.name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
      if (!name) return sendJson(res, 400, { error: 'Введите название канала' });

      const s = getOrCreateServer(serverId);
      if (type === 'text') {
        if (!s.textChannels.includes(name)) s.textChannels.push(name);
        const rMsgs = rooms[serverId] || (rooms[serverId] = Object.create(null));
        if (!rMsgs[name]) rMsgs[name] = [];
      } else {
        if (!s.voiceChannels.includes(name)) s.voiceChannels.push(name);
      }

      scheduleSave(serverId);

      clients.forEach(c => {
        if (c.serverId === serverId) {
          const u = users[c.uid] || { friends: [], incoming: [], outgoing: [] };
          const usersList = memberList(serverId);
          c.res.write('data: ' + JSON.stringify({ type: 'state', payload: { servers: servers, user: { friends: u.friends, incoming: u.incoming, outgoing: u.outgoing }, users: usersList } }) + '\n\n');
        }
      });

      return sendJson(res, 200, { success: true });
    }

    // Сообщения
    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const uid = body.uid;
      const serverId = safeServerId(body.serverId);
      const channel = safeChannel(body.channel);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

      let author = cleanNick(body.author);
      if (validUid(uid) && users[uid]) author = users[uid].nick;

      const now = new Date();
      const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author, time, text };

      const list = getRoomMessages(serverId, channel);
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      scheduleSave(serverId);

      broadcast(serverId, 'msg', { channel, msg });
      return sendJson(res, 200, { success: true });
    }

    // Смена позывного
    if (req.method === 'POST' && url.pathname === '/api/nick') {
      const body = await readBody(req);
      const uid = body.uid;
      const nick = cleanNick(body.nick);
      if (validUid(uid)) {
        ensureUser(uid, nick);
        clients.forEach(c => { if (c.uid === uid) { c.nick = nick; broadcastUsers(c.room || c.serverId); } });
      }
      return sendJson(res, 200, { success: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid) || !users[uid]) return sendJson(res, 400, { error: 'Неизвестный пользователь' });
      const me = users[uid];
      const targetUid = validPid(body.target) ? pidToUid[body.target] : null;
      const target = targetUid ? users[targetUid] : null;
      if (!target || targetUid === uid) return sendJson(res, 400, { error: 'Пользователь не найден' });

      const rm = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };
      let act = String(body.action || '');
      if (act === 'request' && me.incoming.includes(target.pid)) act = 'accept';

      if (act === 'request') {
        if (!me.friends.includes(target.pid) && !me.outgoing.includes(target.pid)) {
          me.outgoing.push(target.pid);
          target.incoming.push(me.pid);
        }
      } else if (act === 'accept') {
        if (me.incoming.includes(target.pid)) {
          rm(me.incoming, target.pid);
          rm(target.outgoing, me.pid);
          if (!me.friends.includes(target.pid)) me.friends.push(target.pid);
          if (!target.friends.includes(me.pid)) target.friends.push(me.pid);
        }
      } else if (act === 'decline') {
        rm(me.incoming, target.pid);
        rm(target.outgoing, me.pid);
      } else if (act === 'remove') {
        rm(me.friends, target.pid);
        rm(target.friends, me.pid);
      }

      scheduleSave();
      sendSocial(uid);
      sendSocial(targetUid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req);
      const serverId = safeServerId(body.serverId);
      const c = clients.find(x => x.uid === body.uid);
      if (c) {
        c.inVoice = !!body.inVoice;
        c.peerId = body.peerId ? String(body.peerId).slice(0, 64) : null;
        broadcastUsers(serverId);
        if (c.inVoice && c.peerId) broadcast(serverId, 'voice-join', { peerId: c.peerId });
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
    console.log('❌ Порт ' + PORT + ' уже занят.');
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
        console.log('❌ Хранилище недоступно.');
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

async function shutdown() {
  setTimeout(() => process.exit(0), 5000).unref();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  for (let i = 0; i < 30 && saving; i++) await new Promise(r => setTimeout(r, 100));
  await saveNow();
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => { process.on(sig, shutdown); });