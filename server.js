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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI