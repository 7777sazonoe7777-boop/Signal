const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const DEFAULT_TEXT_CHANNELS = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
const DEFAULT_VOICE_CHANNELS = ['Ночной эфир'];
const MAX_HISTORY = 500;
const MAX_CHANNELS = 40;
const MAX_SERVERS = 100;
const MAX_BODY = 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;

const serversMeta = Object.create(null);
const rooms = Object.create(null);
const emailCodes = Object.create(null);
let clients = [];

const users = Object.create(null);
const pidToUid = Object.create(null);
const members = Object.create(null);
const MAX_MEMBERS = 500;
const MAX_FRIENDS = 200;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function pidOf(uid) {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 10);
}
function validUid(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
}
function validPid(v) {
  return typeof v === 'string' && /^[a-f0-9]{10}$/.test(v);
}
function pidList(a) {
  return Array.isArray(a) ? a.filter(validPid).slice(0, MAX_FRIENDS) : [];
}

function safeRoom(v) {
  const s = String(v || '').trim();
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(s) ? s : DEFAULT_ROOM;
}
function cleanChannelName(v) {
  const s = String(v || '').trim().replace(/\s+/g, '-').slice(0, 28);
  return /^[\p{L}\p{N}_-]{1,28}$/u.test(s) ? s : '';
}
function cleanNick(v) {
  return String(v || '').trim().slice(0, 24) || 'Гость';
}

function ensureServer(room, name, desc, icon) {
  const r = safeRoom(room);
  if (!serversMeta[r]) {
    const title = String(name || (r === DEFAULT_ROOM ? 'Ночной клуб' : r)).trim().slice(0, 28) || r;
    const shortIcon = String(icon || title.slice(0, 2)).trim().toUpperCase().slice(0, 3) || 'СВ';
    serversMeta[r] = {
      id: r,
      name: title,
      icon: shortIcon,
      desc: String(desc || 'Игры, идеи и разговоры после полуночи').trim().slice(0, 80),
      textChannels: DEFAULT_TEXT_CHANNELS.slice(),
      voiceChannels: DEFAULT_VOICE_CHANNELS.slice()
    };
  }
  if (!rooms[r]) {
    rooms[r] = Object.create(null);
  }
  serversMeta[r].textChannels.forEach(ch => {
    if (!rooms[r][ch]) rooms[r][ch] = [];
  });
  return serversMeta[r];
}

function initDefaultServers() {
  ensureServer(DEFAULT_ROOM, 'Ночной клуб', 'Игры, идеи и разговоры после полуночи', 'НК');
  ensureServer('hc-node', 'Кибер Узел', 'Технологии, код и ночные эфиры', 'HC');
  ensureServer('ma-club', 'Мастерская', 'Музыка, творчество и совместные проекты', 'MA');
  if (rooms[DEFAULT_ROOM]['игровая-комната'].length === 0) {
    rooms[DEFAULT_ROOM]['игровая-комната'].push({
      author: 'СИСТЕМА СИГНАЛ',
      time: '00:00',
      text: 'Добро пожаловать в «Ночной клуб»! Создавайте свои серверы и каналы кнопками «+» слева или приглашайте друзей по прямой ссылке.'
    });
  }
}
initDefaultServers();

function safeChannel(room, ch) {
  const meta = ensureServer(room);
  const s = String(ch || '').trim();
  return meta.textChannels.includes(s) ? s : meta.textChannels[0];
}

function safeVoiceChannel(room, ch) {
  const meta = ensureServer(room);
  const s = String(ch || '').trim();
  return meta.voiceChannels.includes(s) ? s : meta.voiceChannels[0];
}

function getRoom(room) {
  ensureServer(room);
  return rooms[room];
}

// ---------- Хранилище: Upstash Redis или локальный data.json ----------
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
    headers: {
      'Authorization': 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('Upstash ответил кодом ' + res.status);
  const data = await res.json();
  data.forEach(x => {
    if (x && x.error) throw new Error('Upstash: ' + x.error);
  });
  return data.map(x => x.result);
}

function usersPart() {
  const o = {};
  Object.keys(users).forEach(uid => {
    const u = users[uid];
    o[uid] = {
      nick: u.nick,
      friends: u.friends,
      incoming: u.incoming,
      outgoing: u.outgoing
    };
  });
  return o;
}

function scheduleSave(room) {
  if (room) dirtyRooms.add(room);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, USE_REDIS ? 2000 : 1000);
}

async function saveNow() {
  if (!loaded) return;
  if (saving) {
    resave = true;
    return;
  }
  saving = true;
  try {
    if (USE_REDIS) {
      const rs = Array.from(dirtyRooms);
      dirtyRooms.clear();
      const cmds = [
        ['SET', KEY + 'users', JSON.stringify(usersPart())],
        ['SET', KEY + 'members', JSON.stringify(members)],
        ['SET', KEY + 'rooms', JSON.stringify(Object.keys(rooms))],
        ['SET', KEY + 'servers', JSON.stringify(serversMeta)]
      ];
      rs.forEach(r => {
        if (rooms[r]) cmds.push(['SET', KEY + 'msg:' + r, JSON.stringify(rooms[r])]);
      });
      try {
        await redis(cmds);
      } catch (e) {
        rs.forEach(r => dirtyRooms.add(r));
        throw e;
      }
    } else {
      const data = {
        users: usersPart(),
        members: {},
        servers: serversMeta,
        messages: {}
      };
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
    if (resave) {
      resave = false;
      scheduleSave();
    }
  }
}

function applyData(d) {
  if (d.servers && typeof d.servers === 'object') {
    Object.keys(d.servers).forEach(r => {
      if (safeRoom(r) !== r) return;
      const sm = d.servers[r] || {};
      const meta = ensureServer(r, sm.name, sm.desc, sm.icon);
      if (Array.isArray(sm.textChannels)) {
        const tc = sm.textChannels.map(cleanChannelName).filter(Boolean).slice(0, MAX_CHANNELS);
        if (tc.length) meta.textChannels = Array.from(new Set(tc));
      }
      if (Array.isArray(sm.voiceChannels)) {
        const vc = sm.voiceChannels.map(v => String(v || '').trim().slice(0, 28)).filter(Boolean).slice(0, MAX_CHANNELS);
        if (vc.length) meta.voiceChannels = Array.from(new Set(vc));
      }
      meta.textChannels.forEach(ch => {
        if (!rooms[r][ch]) rooms[r][ch] = [];
      });
    });
  }
  Object.keys(d.users || {}).forEach(uid => {
    if (!validUid(uid)) return;
    const u = d.users[uid] || {};
    users[uid] = {
      pid: pidOf(uid),
      nick: cleanNick(u.nick),
      friends: pidList(u.friends),
      incoming: pidList(u.incoming),
      outgoing: pidList(u.outgoing)
    };
    pidToUid[users[uid].pid] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    ensureServer(r);
    members[r] = d.members[r].filter(validUid).slice(0, MAX_MEMBERS);
  });
  Object.keys(d.messages || {}).forEach(r => {
    if (safeRoom(r) !== r || !d.messages[r]) return;
    const meta = ensureServer(r);
    const room = getRoom(r);
    Object.keys(d.messages[r]).forEach(ch => {
      const cleanCh = cleanChannelName(ch);
      if (!cleanCh) return;
      if (!meta.textChannels.includes(cleanCh) && meta.textChannels.length < MAX_CHANNELS) {
        meta.textChannels.push(cleanCh);
      }
      const list = d.messages[r][ch];
      if (!Array.isArray(list)) return;
      room[cleanCh] = list.slice(-MAX_HISTORY).map(m => ({
        author: String(m.author || '').slice(0, 24),
        time: String(m.time || '').slice(0, 5),
        text: String(m.text || '').slice(0, 1000)
      }));
    });
  });
}

async function loadData() {
  if (USE_REDIS) {
    const first = await redis([
      ['GET', KEY + 'users'],
      ['GET', KEY + 'members'],
      ['GET', KEY + 'rooms'],
      ['GET', KEY + 'servers']
    ]);
    const roomNames = (first[2] ? JSON.parse(first[2]) : []).filter(n => safeRoom(n) === n);
    const msgs = roomNames.length ? await redis(roomNames.map(n => ['GET', KEY + 'msg:' + n])) : [];
    const messages = {};
    roomNames.forEach((n, i) => {
      if (msgs[i]) messages[n] = JSON.parse(msgs[i]);
    });
    applyData({
      users: first[0] ? JSON.parse(first[0]) : {},
      members: first[1] ? JSON.parse(first[1]) : {},
      servers: first[3] ? JSON.parse(first[3]) : {},
      messages
    });
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
    u = users[uid] = { pid: pidOf(uid), nick: n, friends: [], incoming: [], outgoing: [] };
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

function isOnline(uid) {
  return clients.some(c => c.uid === uid);
}

function socialState(uid) {
  const u = users[uid];
  if (!u) return null;
  const info = pid => {
    const tu = pidToUid[pid];
    return {
      pid,
      nick: tu && users[tu] ? users[tu].nick : '?',
      online: tu ? isOnline(tu) : false
    };
  };
  return {
    pid: u.pid,
    friends: u.friends.map(info),
    incoming: u.incoming.map(info),
    outgoing: u.outgoing.slice()
  };
}

function sendSocial(uid) {
  const st = socialState(uid);
  if (!st) return;
  const data = 'data: ' + JSON.stringify({ type: 'social', payload: st }) + '\n\n';
  clients.forEach(c => {
    if (c.uid === uid) c.res.write(data);
  });
}

function notifyFriendsOf(uid) {
  const u = users[uid];
  if (!u) return;
  u.friends.forEach(pid => {
    const f = pidToUid[pid];
    if (f) sendSocial(f);
  });
}

function memberList(room) {
  const online = new Map();
  clients.forEach(c => {
    if (c.room !== room || !c.uid) return;
    const prev = online.get(c.uid);
    online.set(c.uid, {
      inVoice: !!(prev && prev.inVoice) || !!c.inVoice,
      voiceChannel: c.inVoice ? c.voiceChannel : (prev ? prev.voiceChannel : null)
    });
  });
  return (members[room] || []).map(uid => {
    const u = users[uid];
    const o = online.get(uid);
    return {
      pid: u ? u.pid : pidOf(uid),
      nick: u ? u.nick : '?',
      online: !!o,
      inVoice: !!(o && o.inVoice),
      voiceChannel: o && o.voiceChannel ? o.voiceChannel : null
    };
  });
}

function broadcast(room, eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload });
  clients.forEach(c => {
    if (c.room === room) c.res.write('data: ' + data + '\n\n');
  });
}

function broadcastAll(eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload });
  clients.forEach(c => {
    c.res.write('data: ' + data + '\n\n');
  });
}

function broadcastUsers(room) {
  broadcast(room, 'users', memberList(room));
}

function broadcastServers() {
  broadcastAll('servers', {
    list: Object.values(serversMeta)
  });
}

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

  .servers-rail { background: #030508; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 10px; overflow-y: auto; }
  .bolt-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--cyan-bright); font-size: 18px; margin-bottom: 4px; flex-shrink: 0; }
  .srv-ico { width: 42px; height: 42px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: 0.15s; }
  .srv-ico:hover { border-color: var(--cyan-bright); color: #fff; }
  .srv-ico.active { background: var(--cyan-bright); color: #042f2e; border-color: var(--cyan-bright); box-shadow: 0 0 12px rgba(45, 212, 191, 0.4); }
  .srv-ico-add { background: transparent; border: 1px dashed var(--border); color: var(--pink); font-size: 18px; border-radius: 12px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: 0.15s; }
  .srv-ico-add:hover { border-color: var(--pink); background: rgba(219, 39, 119, 0.12); color: #fff; }

  .channels-panel { background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .srv-header { padding: 12px 14px 8px; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .srv-label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .srv-title { font-size: 16px; font-weight: 800; color: #fff; margin-top: 2px; word-break: break-word; }
  .btn-code-modal { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; padding: 4px 8px; border-radius: 4px; cursor: pointer; flex-shrink: 0; }
  .btn-code-modal:hover { border-color: var(--cyan-bright); color: #fff; }

  .freq-card { margin: 4px 10px 10px; padding: 12px; border-radius: 10px; background: linear-gradient(135deg, #111a24 0%, #0a0f16 100%); border: 1px solid var(--border); }
  .freq-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .freq-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }
  .live-badge { font-size: 9px; background: #9d174d; color: #fff; padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .freq-card h4 { font-size: 15px; font-weight: 800; line-height: 1.2; margin-bottom: 6px; }
  .freq-card p { font-size: 10px; color: var(--text-dim); line-height: 1.35; }

  .channels-scroll { flex: 1; overflow-y: auto; padding: 0 8px; }
  .cat-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
  .cat-add-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--cyan-bright); width: 18px; height: 18px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; cursor: pointer; line-height: 1; }
  .cat-add-btn:hover { background: rgba(45, 212, 191, 0.2); color: #fff; border-color: var(--cyan-bright); }

  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }
  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }
  .ch-btn.active .ch-dot { display: block; }

  .voice-ch-box { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .voice-ch-box:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .voice-ch-box.active { background: rgba(20, 184, 166, 0.12); color: #4ade80; font-weight: 600; }
  .off-badge { font-size: 9px; background: rgba(255,255,255,0.05); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .off-badge.on { background: #064e3b; color: #34d399; }

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
    <span><b>РЕАЛЬНАЯ СЕТЬ:</b> Создавайте свои серверы, текстовые и голосовые каналы и приглашайте друзей по прямой ссылке</span>
    <span style="font-weight:700;color:var(--cyan-bright);" id="room-code-label">Код комнаты: <b>cy-4371</b> НА СВЯЗИ</span>
  </div>

  <div class="workspace">
    <div class="servers-rail" id="servers-rail">
      <div class="bolt-icon">⚡</div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;"></div>
      <div class="srv-ico-add" title="Создать новый сервер" onclick="openCreateServerModal()">+</div>
    </div>

    <div class="channels-panel">
      <div class="srv-header">
        <div>
          <div class="srv-label">ОТКРЫТЫЙ СЕРВЕР</div>
          <div class="srv-title" id="srv-title-label">Ночной клуб</div>
        </div>
        <button class="btn-code-modal" onclick="openJoinCodeModal()">Ввести код</button>
      </div>

      <div class="freq-card">
        <div class="freq-top">
          <span class="freq-tag">ЧАСТОТА 108.4 FM</span>
          <span class="live-badge">LIVE</span>
        </div>
        <h4>Лови свою частоту.</h4>
        <p id="srv-desc-label">Игры, идеи и разговоры после полуночи</p>
      </div>

      <div class="channels-scroll">
        <div class="cat-header">
          <span>ТЕКСТОВЫЕ КАНАЛЫ</span>
          <button class="cat-add-btn" title="Создать текстовый канал" onclick="openCreateChannelModal('text')">+</button>
        </div>
        <div id="text-channels-list"></div>

        <div class="cat-header" style="margin-top: 8px;">
          <span>ГОЛОСОВЫЕ КАНАЛЫ</span>
          <button class="cat-add-btn" title="Создать голосовой канал" onclick="openCreateChannelModal('voice')">+</button>
        </div>
        <div id="voice-channels-list"></div>
      </div>

      <div class="connect-friend-box">
        <div class="connect-title">СВЯЗЬ С ДРУГОМ <span style="color:var(--cyan-bright);">// P2P</span></div>
        <div class="connect-row">
          <input type="text" id="friend-code-inp" class="connect-inp" placeholder="Код сервера (cy-...)">
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
            <div class="welcome-tag">НАЧАЛО КАНАЛА // P2P СИНХРОНИЗАЦИЯ</div>
            <h2>Кто сегодня на связи?</h2>
            <p id="banner-desc">Это #игровая-комната на сервере «Ночной клуб». Делитесь мыслями, знакомьтесь и приглашайте друзей по прямой ссылке.</p>
            <div class="pill-tags-row">
              <span class="pill-tag" onclick="document.getElementById('chat-input').focus()">ТЕКСТОМ — ТЕКСТ РАВНО ИГРОК</span>
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
              <div class="voice-title" id="voice-panel-title">Общий разговор участников канала («Ночной эфир»)</div>
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
          <span id="auth-bar-text">Вы в сети как <b>Гость_932</b> — сообщения мгновенно доставляются всем подключенным друзьям</span>
          <button class="btn-login-mini" onclick="openAuthModal()">Регистрация по коду</button>
        </div>
        <form class="input-row" onsubmit="sendChatMessage(event)">
          <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">
          <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
        </form>
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • СООБЩЕНИЯ И ГОЛОС ИДУТ МЕЖДУ УЧАСТНИКАМИ • P2P ONLINE</div>
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
        <p>Отправьте другу прямую ссылку или код комнаты — он сразу появится в этом списке, и вы сможете общаться текстом и голосом.</p>
        <button class="btn-pink-card" onclick="openInviteModal()">🔗 СОЗДАТЬ ПРИГЛАШЕНИЕ</button>
      </div>
    </div>
  </div>

  <!-- Модальное окно приглашения -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Публичная ссылка для друга</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Нажмите на ссылку, чтобы открыть её, или скопируйте для отправки другу:</p>
      <a class="link-box" id="public-invite-url" href="#" target="_blank" rel="noopener">Генерация публичного адреса...</a>
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeInviteModal()">Закрыть</button>
    </div>
  </div>

  <!-- Модальное окно верификации по почте -->
  <div class="modal-backdrop" id="auth-modal" onclick="if(event.target===this)closeAuthModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Верификация по почте</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Введите ваш Email для получения защищённого кода.</p>
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

  <!-- Модальное окно создания нового сервера -->
  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Создать свой сервер</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Любой участник может создать собственный сервер с текстовыми и голосовыми каналами.</p>
      <input type="text" id="new-srv-name" placeholder="Название сервера (например, Кибер База)" maxlength="28">
      <input type="text" id="new-srv-desc" placeholder="Описание сервера" maxlength="80">
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">Создать сервер</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeCreateServerModal()">Закрыть</button>
    </div>
  </div>

  <!-- Модальное окно создания текстового или голосового канала -->
  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannelModal()">
    <div class="modal-box">
      <h3 id="create-ch-title" style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Создать канал</h3>
      <p id="create-ch-sub" style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Введите название нового канала на этом сервере.</p>
      <input type="text" id="new-ch-name" placeholder="Например: флудилка или общий-голос" maxlength="28">
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">Создать канал</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeCreateChannelModal()">Закрыть</button>
    </div>
  </div>

  <!-- Модальное окно входа по коду -->
  <div class="modal-backdrop" id="join-code-modal" onclick="if(event.target===this)closeJoinCodeModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Перейти на сервер по коду</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Введите код сервера друга (например, cy-4371):</p>
      <input type="text" id="join-code-inp" placeholder="cy-4371" maxlength="32">
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitJoinCode()">Войти на сервер</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeJoinCodeModal()">Закрыть</button>
    </div>
  </div>

<script>
  const params = new URLSearchParams(window.location.search);

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

  let currentRoom = params.get('room') || params.get('server');
  if (!currentRoom) {
    try { currentRoom = localStorage.getItem('cyber_last_room'); } catch (e) {}
  }
  currentRoom = currentRoom || 'cy-4371';
  try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}

  let currentChannel = params.get('channel') || 'игровая-комната';
  let currentVoiceChannel = 'Ночной эфир';
  let myNick = 'Гость_932';
  try { myNick = localStorage.getItem('cyber_nick') || 'Гость_932'; } catch (e) {}
  const clientId = Math.random().toString(36).substring(2, 10);

  let serversList = [];
  let currentServerMeta = {
    id: currentRoom,
    name: 'Ночной клуб',
    icon: 'НК',
    desc: 'Игры, идеи и разговоры после полуночи',
    textChannels: ['игровая-комната', 'общий', 'знакомства', 'музыка'],
    voiceChannels: ['Ночной эфир']
  };

  let localStream = null, peer = null, myPeerId = null, inVoice = false, isMuted = false;
  let myPid = null, lastMembers = [], social = { friends: [], incoming: [], outgoing: [] };
  let pendingChannelType = 'text';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    document.getElementById('user-ava').textContent = myNick.slice(0, 2).toUpperCase();
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    document.getElementById('auth-bar-text').innerHTML = 'Вы в сети как <b>' + escapeHtml(myNick) + '</b> — сообщения мгновенно доставляются всем подключенным друзьям';
  }

  function renderServersRail() {
    const box = document.getElementById('servers-list-box');
    box.innerHTML = '';
    const list = serversList.length ? serversList : [currentServerMeta];
    list.forEach(function (srv) {
      const btn = el('div', 'srv-ico' + (srv.id === currentRoom ? ' active' : ''), srv.icon || srv.name.slice(0, 2).toUpperCase());
      btn.title = srv.name + ' (' + srv.id + ')';
      btn.onclick = function () {
        if (srv.id !== currentRoom) switchServer(srv.id);
      };
      box.appendChild(btn);
    });
  }

  function renderServerChannels() {
    document.getElementById('srv-title-label').textContent = currentServerMeta.name || currentRoom;
    document.getElementById('srv-desc-label').textContent = currentServerMeta.desc || 'Игры, идеи и разговоры после полуночи';
    document.getElementById('node-badge').textContent = 'Узел активен, ' + currentRoom;
    document.getElementById('room-code-label').innerHTML = 'Код комнаты: <b>' + escapeHtml(currentRoom) + '</b> НА СВЯЗИ';

    const tList = currentServerMeta.textChannels || ['игровая-комната'];
    if (tList.indexOf(currentChannel) === -1) {
      currentChannel = tList[0] || 'игровая-комната';
    }
    const vList = currentServerMeta.voiceChannels || ['Ночной эфир'];
    if (vList.indexOf(currentVoiceChannel) === -1) {
      currentVoiceChannel = vList[0] || 'Ночной эфир';
    }

    const tBox = document.getElementById('text-channels-list');
    tBox.innerHTML = '';
    tList.forEach(function (ch) {
      const row = el('div', 'ch-btn' + (ch === currentChannel ? ' active' : ''));
      row.setAttribute('data-ch', ch);
      const span = el('span', '', '# ' + ch);
      const dot = el('span', 'ch-dot');
      row.appendChild(span);
      row.appendChild(dot);
      row.onclick = function () { setChannel(ch); };
      tBox.appendChild(row);
    });

    const vBox = document.getElementById('voice-channels-list');
    vBox.innerHTML = '';
    vList.forEach(function (vch) {
      const isAct = inVoice && currentVoiceChannel === vch;
      const row = el('div', 'voice-ch-box' + (isAct ? ' active' : ''));
      const span = el('span', '', '🔊 ' + vch);
      const badge = el('span', 'off-badge' + (isAct ? ' on' : ''), isAct ? 'ON' : 'OFF');
      row.appendChild(span);
      row.appendChild(badge);
      row.onclick = function () { selectVoiceChannel(vch); };
      vBox.appendChild(row);
    });

    applyChannelUI(currentChannel);
    updateVoicePanelUI();
  }

  function applyChannelUI(ch) {
    const srvName = currentServerMeta.name || 'Ночной клуб';
    document.getElementById('top-ch-name').textContent = ch;
    document.getElementById('top-ch-desc').textContent = 'Канал сервера «' + srvName + '»';
    document.getElementById('banner-desc').textContent = 'Это #' + ch + ' на сервере «' + srvName + '». Делитесь мыслями, знакомьтесь и приглашайте друзей по прямой ссылке.';
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(function (i) {
      i.classList.toggle('active', i.getAttribute('data-ch') === ch);
    });
  }

  function updateVoicePanelUI() {
    document.getElementById('voice-panel-title').textContent = 'Общий разговор участников канала («' + currentVoiceChannel + '»)';
  }

  function switchServer(roomId) {
    const clean = String(roomId || '').trim();
    if (!clean) return;
    try { localStorage.setItem('cyber_last_room', clean); } catch (e) {}
    window.location.href = window.location.origin + '/?room=' + encodeURIComponent(clean);
  }

  applyNickUI();
  renderServersRail();
  renderServerChannels();

  const evtSource = new EventSource('/api/events?id=' + clientId + '&uid=' + myUid + '&room=' + encodeURIComponent(currentRoom) + '&nick=' + encodeURIComponent(myNick));

  evtSource.onmessage = function (e) {
    let data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    if (data.type === 'server-meta') {
      currentServerMeta = data.payload.current;
      serversList = data.payload.list || [currentServerMeta];
      renderServersRail();
      renderServerChannels();
      loadHistory();
    } else if (data.type === 'servers') {
      serversList = data.payload.list || [];
      const found = serversList.find(function (s) { return s.id === currentRoom; });
      if (found) currentServerMeta = found;
      renderServersRail();
      renderServerChannels();
    } else if (data.type === 'msg' && data.payload.channel === currentChannel) {
      addMsgToDOM(data.payload.msg);
    } else if (data.type === 'users') {
      renderUsers(data.payload);
    } else if (data.type === 'social') {
      myPid = data.payload.pid;
      social = data.payload;
      renderSocial();
      renderUsers(lastMembers);
    } else if (data.type === 'voice-join') {
      if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId && data.payload.voiceChannel === currentVoiceChannel) {
        const pid = data.payload.peerId;
        const call = peer.call(pid, localStream);
        if (!call) return;
        call.on('stream', function (remoteStream) { playStream(pid, remoteStream); });
        call.on('close', function () { removeAudio(pid); });
        call.on('error', function () { removeAudio(pid); });
      }
    }
  };

  function loadHistory() {
    const ch = currentChannel;
    fetch('/api/history?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(ch))
      .then(function (r) { return r.json(); })
      .then(function (msgs) {
        if (ch !== currentChannel) return;
        const box = document.getElementById('messages-list');
        box.innerHTML = '';
        if (!Array.isArray(msgs) || msgs.length === 0) {
          box.innerHTML = '<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>';
          return;
        }
        msgs.forEach(addMsgToDOM);
      })
      .catch(function () {});
  }
  loadHistory();

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

  function friendAction(action, pid) {
    return fetch('/api/friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: myUid, action: action, target: pid })
    })
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
      const voiceTag = u.inVoice ? (' 🔊' + (u.voiceChannel ? ' ' + u.voiceChannel : '')) : '';
      const name = el('span', '', u.nick + (u.pid === myPid ? ' (вы)' : '') + voiceTag);
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
      rmb.onclick = function () {
        if (confirm('Удалить ' + f.nick + ' из друзей?')) friendAction('remove', f.pid);
      };
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, room: currentRoom, channel: currentChannel, author: myNick, text: text })
    }).catch(function () { alert('Не удалось отправить сообщение. Проверьте соединение.'); });
    inp.value = '';
  }

  function setChannel(ch) {
    currentChannel = ch;
    applyChannelUI(ch);
    loadHistory();
  }

  function selectVoiceChannel(vch) {
    currentVoiceChannel = vch;
    updateVoicePanelUI();
    renderServerChannels();
    if (!inVoice) {
      toggleVoiceCall();
    } else {
      postVoiceState({ inVoice: true, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    }
  }

  // Модалка создания сервера
  function openCreateServerModal() {
    document.getElementById('new-srv-name').value = '';
    document.getElementById('new-srv-desc').value = '';
    document.getElementById('create-server-modal').classList.add('open');
    document.getElementById('new-srv-name').focus();
  }
  function closeCreateServerModal() {
    document.getElementById('create-server-modal').classList.remove('open');
  }
  async function submitCreateServer() {
    const name = document.getElementById('new-srv-name').value.trim();
    const desc = document.getElementById('new-srv-desc').value.trim();
    if (!name) return alert('Введите название сервера!');
    try {
      const res = await fetch('/api/server/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: myUid, name: name, desc: desc })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      closeCreateServerModal();
      switchServer(data.serverId);
    } catch (e) {
      alert('Ошибка создания сервера.');
    }
  }

  // Модалка создания текстового или голосового канала
  function openCreateChannelModal(type) {
    pendingChannelType = type === 'voice' ? 'voice' : 'text';
    document.getElementById('create-ch-title').textContent = pendingChannelType === 'voice' ? 'Создать голосовой канал' : 'Создать текстовый канал';
    document.getElementById('create-ch-sub').textContent = pendingChannelType === 'voice' ? 'Участники смогут созваниваться в этом канале:' : 'Участники смогут переписываться в этом канале:';
    document.getElementById('new-ch-name').value = '';
    document.getElementById('create-channel-modal').classList.add('open');
    document.getElementById('new-ch-name').focus();
  }
  function closeCreateChannelModal() {
    document.getElementById('create-channel-modal').classList.remove('open');
  }
  async function submitCreateChannel() {
    const name = document.getElementById('new-ch-name').value.trim();
    if (!name) return alert('Введите название канала!');
    try {
      const res = await fetch('/api/channel/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: myUid, room: currentRoom, type: pendingChannelType, name: name })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      closeCreateChannelModal();
      if (pendingChannelType === 'text' && data.channel) {
        currentChannel = data.channel;
        renderServerChannels();
        loadHistory();
      } else if (pendingChannelType === 'voice' && data.channel) {
        currentVoiceChannel = data.channel;
        renderServerChannels();
      }
    } catch (e) {
      alert('Ошибка создания канала.');
    }
  }

  // Переход по коду
  function openJoinCodeModal() {
    document.getElementById('join-code-inp').value = '';
    document.getElementById('join-code-modal').classList.add('open');
    document.getElementById('join-code-inp').focus();
  }
  function closeJoinCodeModal() {
    document.getElementById('join-code-modal').classList.remove('open');
  }
  function submitJoinCode() {
    const code = document.getElementById('join-code-inp').value.trim();
    if (!code) return alert('Введите код сервера!');
    closeJoinCodeModal();
    switchServer(code);
  }

  function connectToFriend() {
    const code = document.getElementById('friend-code-inp').value.trim();
    if (!code) return alert('Введите код сервера!');
    switchServer(code);
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
    const finalUrl = base + '/?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel);
    linkEl.textContent = finalUrl;
    linkEl.href = finalUrl;
  }
  function openInviteModal() {
    document.getElementById('invite-modal').classList.add('open');
    refreshInviteLink();
  }
  function closeInviteModal() {
    document.getElementById('invite-modal').classList.remove('open');
  }
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
      const res = await fetch('/api/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      });
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
      const res = await fetch('/api/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clientId, email: email, code: code, nick: nick })
      });
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
    return fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ id: clientId }, state))
    }).catch(function () {});
  }

  function resetVoiceUI() {
    document.getElementById('connect-voice-btn').textContent = 'ПОДКЛЮЧИТЬСЯ';
    document.getElementById('connect-voice-btn').className = 'btn-cyan';
    document.getElementById('mute-btn').style.display = 'none';
    document.getElementById('mute-btn').textContent = '🎤 Микр. вкл';
    document.getElementById('voice-active-area').classList.remove('show');
    document.getElementById('audio-box').innerHTML = '';
    renderServerChannels();
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
      if (peer) peer.destroy();
      localStream = null;
      peer = null;
      myPeerId = null;
      inVoice = false;
      isMuted = false;
      resetVoiceUI();
      postVoiceState({ inVoice: false });
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Разрешите доступ к микрофону!');
      return;
    }
    inVoice = true;
    isMuted = false;
    document.getElementById('connect-voice-btn').textContent = 'ОТКЛЮЧИТЬСЯ';
    document.getElementById('connect-voice-btn').className = 'btn-danger';
    document.getElementById('mute-btn').style.display = 'inline-block';
    document.getElementById('mute-btn').textContent = '🎤 Микр. вкл';
    document.getElementById('voice-active-area').classList.add('show');
    renderServerChannels();

    peer = new Peer();
    peer.on('open', function (id) {
      myPeerId = id;
      postVoiceState({ inVoice: true, peerId: id, voiceChannel: currentVoiceChannel });
    });
    peer.on('call', function (call) {
      call.answer(localStream);
      call.on('stream', function (remoteStream) { playStream(call.peer, remoteStream); });
      call.on('close', function () { removeAudio(call.peer); });
      call.on('error', function () { removeAudio(call.peer); });
    });
    peer.on('error', function () {});
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
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
      const room = safeRoom(url.searchParams.get('room'));
      const nick = cleanNick(url.searchParams.get('nick') || 'Гость_932');
      const uid = url.searchParams.get('uid');
      if (!validUid(uid)) {
        res.writeHead(400);
        return res.end();
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      const meta = ensureServer(room);
      const user = ensureUser(uid, nick);
      addMember(room, uid);

      const client = { id, uid, room, nick: user.nick, inVoice: false, peerId: null, voiceChannel: null, res };
      clients.push(client);

      res.write('data: ' + JSON.stringify({
        type: 'server-meta',
        payload: { current: meta, list: Object.values(serversMeta) }
      }) + '\n\n');

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
      const room = safeRoom(url.searchParams.get('room'));
      const channel = safeChannel(room, url.searchParams.get('channel'));
      const list = (rooms[room] && rooms[room][channel]) ? rooms[room][channel] : [];
      return sendJson(res, 200, list);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') {
      return sendJson(res, 200, { publicUrl: null });
    }

    // Создание нового сервера
    if (req.method === 'POST' && url.pathname === '/api/server/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Обновите страницу' });
      if (Object.keys(serversMeta).length >= MAX_SERVERS) {
        return sendJson(res, 400, { error: 'Достигнут лимит серверов' });
      }
      const name = String(body.name || '').trim().slice(0, 28);
      const desc = String(body.desc || '').trim().slice(0, 80);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера!' });

      const newId = 'cy-' + crypto.randomBytes(2).toString('hex');
      ensureServer(newId, name, desc);
      rooms[newId]['игровая-комната'].push({
        author: 'СИСТЕМА СИГНАЛ',
        time: '00:00',
        text: 'Сервер «' + name + '» создан! Приглашайте друзей по прямой ссылке.'
      });
      scheduleSave(newId);
      broadcastServers();
      return sendJson(res, 200, { ok: true, serverId: newId });
    }

    // Создание нового текстового или голосового канала
    if (req.method === 'POST' && url.pathname === '/api/channel/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Обновите страницу' });
      const room = safeRoom(body.room);
      const meta = ensureServer(room);
      const type = body.type === 'voice' ? 'voice' : 'text';

      if (type === 'text') {
        const ch = cleanChannelName(body.name).toLowerCase();
        if (!ch) return sendJson(res, 400, { error: 'Используйте буквы, цифры или дефис!' });
        if (meta.textChannels.length >= MAX_CHANNELS) return sendJson(res, 400, { error: 'Лимит каналов достигнут' });
        if (!meta.textChannels.includes(ch)) meta.textChannels.push(ch);
        if (!rooms[room][ch]) rooms[room][ch] = [];
        scheduleSave(room);
        broadcastServers();
        return sendJson(res, 200, { ok: true, channel: ch });
      } else {
        const vch = String(body.name || '').trim().slice(0, 28);
        if (!vch) return sendJson(res, 400, { error: 'Введите название голосового канала!' });
        if (meta.voiceChannels.length >= MAX_CHANNELS) return sendJson(res, 400, { error: 'Лимит каналов достигнут' });
        if (!meta.voiceChannels.includes(vch)) meta.voiceChannels.push(vch);
        scheduleSave(room);
        broadcastServers();
        return sendJson(res, 200, { ok: true, channel: vch });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const room = safeRoom(body.room);
      const channel = safeChannel(room, body.channel);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

      const c = clients.find(x => x.id === body.id);
      const author = c ? c.nick : cleanNick(body.author);

      const now = new Date();
      const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author, time, text };

      const rObj = getRoom(room);
      if (!rObj[channel]) rObj[channel] = [];
      const list = rObj[channel];
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
        if (users[c.uid]) {
          users[c.uid].nick = nick;
          scheduleSave();
        }
        clients.forEach(x => {
          if (x.uid === c.uid) x.nick = nick;
        });
        broadcastUsers(c.room);
        notifyFriendsOf(c.uid);
        sendSocial(c.uid);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid) || !users[uid]) {
        return sendJson(res, 400, { error: 'Неизвестный пользователь. Обновите страницу.' });
      }
      const me = users[uid];
      const targetUid = validPid(body.target) ? pidToUid[body.target] : null;
      const target = targetUid ? users[targetUid] : null;
      if (!target || targetUid === uid) return sendJson(res, 400, { error: 'Пользователь не найден' });

      const rm = (a, x) => {
        const i = a.indexOf(x);
        if (i >= 0) a.splice(i, 1);
      };
      let act = String(body.action || '');
      if (act === 'request' && me.incoming.includes(target.pid)) act = 'accept';

      if (act === 'request') {
        if (me.friends.includes(target.pid) || me.outgoing.includes(target.pid)) {
          // уже друзья или заявка отправлена
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
        c.inVoice = !!body.inVoice;
        c.peerId = body.peerId ? String(body.peerId).slice(0, 64) : null;
        c.voiceChannel = c.inVoice ? safeVoiceChannel(c.room, body.voiceChannel) : null;
        broadcastUsers(c.room);
        if (c.inVoice && c.peerId) {
          broadcast(c.room, 'voice-join', { peerId: c.peerId, voiceChannel: c.voiceChannel });
        }
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

async function shutdown() {
  setTimeout(() => process.exit(0), 5000).unref();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  for (let i = 0; i < 30 && saving; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  await saveNow();
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => { process.on(sig, shutdown); });