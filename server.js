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

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBotUsername = '';
let tgUpdateOffset = 0;

const serversMeta = Object.create(null);
const rooms = Object.create(null);
const tgCodes = Object.create(null);
const pendingTgTokens = Object.create(null);
let clients = [];

const users = Object.create(null);      // uid -> { pid, nick, tgId, tgUsername, passHash, verified, bio, interests, customStatus, presence, bannerColor, avatarColor, friends:[pid], incoming:[pid], outgoing:[pid], servers:[room] }
const pidToUid = Object.create(null);   // pid -> uid
const tgIdToUid = Object.create(null);  // String(tgId) -> uid
const nickToUid = Object.create(null);  // nick.toLowerCase() -> uid
const members = Object.create(null);    // room -> [uid]
const MAX_MEMBERS = 500;
const MAX_FRIENDS = 200;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function pidOf(uid) {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 10);
}
function uidFromTgId(tgId) {
  return crypto.createHash('sha256').update('signal-tg:' + String(tgId)).digest('hex').slice(0, 32);
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
function roomList(a) {
  return Array.isArray(a) ? a.filter(r => safeRoom(r) === r).slice(0, MAX_SERVERS) : [];
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 32).toString('hex');
  return s + ':' + h;
}
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const parts = stored.split(':');
  const salt = parts[0];
  const origHash = parts[1];
  const testHash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(origHash, 'hex'), Buffer.from(testHash, 'hex'));
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
function cleanText(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen || 160);
}
function cleanColor(v, fallback) {
  const s = String(v || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}
function cleanPresence(v) {
  const s = String(v || '').trim();
  return ['online', 'idle', 'dnd', 'invisible'].includes(s) ? s : 'online';
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
      text: 'Добро пожаловать в «Ночной клуб»! Настройте свой профиль, интересы, микрофон и веб-камеру по кнопке «Профиль / ⚙️» слева внизу.'
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

// ---------- Интеграция с Telegram Bot API ----------
async function tgApi(method, bodyObj) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj || {}),
    signal: AbortSignal.timeout(35000)
  });
  return await res.json();
}

function generateTgCode(tgId, firstName, username) {
  Object.keys(tgCodes).forEach(k => {
    if (tgCodes[k].tgId === String(tgId) || tgCodes[k].expires < Date.now()) {
      delete tgCodes[k];
    }
  });
  let code = '';
  for (let i = 0; i < 20; i++) {
    const candidate = Math.floor(1000 + Math.random() * 9000).toString();
    if (!tgCodes[candidate]) {
      code = candidate;
      break;
    }
  }
  if (!code) code = Math.floor(1000 + Math.random() * 9000).toString();
  tgCodes[code] = {
    tgId: String(tgId),
    firstName: String(firstName || '').trim(),
    username: String(username || '').trim(),
    expires: Date.now() + CODE_TTL_MS
  };
  return code;
}

async function handleTelegramMessage(msg) {
  if (!msg || !msg.from || !msg.chat) return;
  const chatId = msg.chat.id;
  const tgId = String(msg.from.id);
  const firstName = String(msg.from.first_name || msg.from.username || 'Странник').trim();
  const username = String(msg.from.username || '').trim();
  const text = String(msg.text || '').trim();

  const code = generateTgCode(tgId, firstName, username);

  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const param = parts[1] || '';
    if (param.startsWith('auth_')) {
      const token = param.slice(5);
      const pending = pendingTgTokens[token];
      if (pending && pending.expires > Date.now()) {
        pending.completed = { tgId, firstName, username, code };
      }
    }
  }

  const replyText =
    '⚡ *СИГНАЛ // CYBER.NET*\n\n' +
    '✅ Ваш аккаунт подтверждён!\n' +
    '🔑 Ваш код для входа: *' + code + '*\n\n' +
    'Вернитесь в браузер — вход выполнится автоматически (или введите эти 4 цифры на сайте). Повторный вход больше не потребуется.';

  try {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: replyText,
      parse_mode: 'Markdown'
    });
  } catch (e) {}
}

async function startTelegramBotPolling() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('ℹ️ TELEGRAM_BOT_TOKEN не задан. Доступен вход по паролю или через Telegram после добавления токена.');
    return;
  }
  try {
    await tgApi('deleteWebhook', { drop_pending_updates: false });
    const me = await tgApi('getMe', {});
    if (me && me.ok && me.result && me.result.username) {
      telegramBotUsername = me.result.username;
      console.log('🤖 Telegram-бот авторизации активен: @' + telegramBotUsername);
    } else {
      console.log('⚠️ Не удалось получить имя Telegram-бота. Проверьте TELEGRAM_BOT_TOKEN.');
      return;
    }
  } catch (e) {
    console.log('⚠️ Ошибка инициализации Telegram-бота: ' + e.message);
    return;
  }

  (async function pollLoop() {
    while (true) {
      try {
        const data = await tgApi('getUpdates', {
          offset: tgUpdateOffset,
          timeout: 25,
          allowed_updates: ['message']
        });
        if (data && data.ok && Array.isArray(data.result)) {
          for (const upd of data.result) {
            tgUpdateOffset = upd.update_id + 1;
            if (upd.message) {
              await handleTelegramMessage(upd.message);
            }
          }
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
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
      tgId: u.tgId || '',
      tgUsername: u.tgUsername || '',
      passHash: u.passHash || '',
      verified: !!u.verified,
      bio: u.bio || '',
      interests: u.interests || '',
      customStatus: u.customStatus || '',
      presence: u.presence || 'online',
      bannerColor: u.bannerColor || '#0d9488',
      avatarColor: u.avatarColor || '#e11d48',
      friends: u.friends,
      incoming: u.incoming,
      outgoing: u.outgoing,
      servers: u.servers || []
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
    const tgId = String(u.tgId || '').trim();
    const tgUsername = String(u.tgUsername || '').trim();
    const nick = cleanNick(u.nick);
    const passHash = String(u.passHash || '');
    const verified = !!u.verified || !!tgId || !!passHash;
    users[uid] = {
      pid: pidOf(uid),
      nick: nick,
      tgId: tgId,
      tgUsername: tgUsername,
      passHash: passHash,
      verified: verified,
      bio: cleanText(u.bio, 220),
      interests: cleanText(u.interests, 160),
      customStatus: cleanText(u.customStatus, 60),
      presence: cleanPresence(u.presence),
      bannerColor: cleanColor(u.bannerColor, '#0d9488'),
      avatarColor: cleanColor(u.avatarColor, '#e11d48'),
      friends: pidList(u.friends),
      incoming: pidList(u.incoming),
      outgoing: pidList(u.outgoing),
      servers: roomList(u.servers)
    };
    pidToUid[users[uid].pid] = uid;
    if (tgId) tgIdToUid[tgId] = uid;
    if (verified && nick) nickToUid[nick.toLowerCase()] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    ensureServer(r);
    members[r] = d.members[r].filter(validUid).slice(0, MAX_MEMBERS);
    members[r].forEach(uid => {
      if (users[uid] && !users[uid].servers.includes(r)) {
        users[uid].servers.push(r);
      }
    });
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

function ensureUser(uid, nick, verifiedFlag) {
  let u = users[uid];
  const n = cleanNick(nick);
  if (!u) {
    u = users[uid] = {
      pid: pidOf(uid),
      nick: n,
      tgId: '',
      tgUsername: '',
      passHash: '',
      verified: !!verifiedFlag,
      bio: '',
      interests: '',
      customStatus: '',
      presence: 'online',
      bannerColor: '#0d9488',
      avatarColor: '#e11d48',
      friends: [],
      incoming: [],
      outgoing: [],
      servers: []
    };
    pidToUid[u.pid] = uid;
    if (u.verified && n) nickToUid[n.toLowerCase()] = uid;
    scheduleSave();
  } else {
    if (verifiedFlag && !u.verified) {
      u.verified = true;
      scheduleSave();
    }
    if (nick && !u.verified && u.nick !== n) {
      u.nick = n;
      scheduleSave();
    }
  }
  return u;
}

function addMember(room, uid) {
  const r = safeRoom(room);
  const arr = members[r] || (members[r] = []);
  let changed = false;
  if (!arr.includes(uid) && arr.length < MAX_MEMBERS) {
    arr.push(uid);
    changed = true;
  }
  if (users[uid] && !users[uid].servers.includes(r)) {
    users[uid].servers.push(r);
    changed = true;
  }
  if (changed) scheduleSave();
}

function mergeAccount(prevUid, finalUid, nick, tgId, tgUsername, passHash) {
  let u = users[finalUid];
  const cleanN = cleanNick(nick);
  if (!u) {
    if (prevUid && users[prevUid]) {
      const oldUser = users[prevUid];
      u = users[finalUid] = {
        pid: pidOf(finalUid),
        nick: cleanN,
        tgId: tgId || oldUser.tgId || '',
        tgUsername: tgUsername || oldUser.tgUsername || '',
        passHash: passHash || oldUser.passHash || '',
        verified: true,
        bio: oldUser.bio || '',
        interests: oldUser.interests || '',
        customStatus: oldUser.customStatus || '',
        presence: oldUser.presence || 'online',
        bannerColor: oldUser.bannerColor || '#0d9488',
        avatarColor: oldUser.avatarColor || '#e11d48',
        friends: oldUser.friends || [],
        incoming: oldUser.incoming || [],
        outgoing: oldUser.outgoing || [],
        servers: oldUser.servers || []
      };
      if (prevUid !== finalUid) {
        delete users[prevUid];
        Object.keys(members).forEach(r => {
          const idx = members[r].indexOf(prevUid);
          if (idx >= 0) {
            if (!members[r].includes(finalUid)) members[r][idx] = finalUid;
            else members[r].splice(idx, 1);
          }
        });
      }
    } else {
      u = users[finalUid] = {
        pid: pidOf(finalUid),
        nick: cleanN,
        tgId: tgId || '',
        tgUsername: tgUsername || '',
        passHash: passHash || '',
        verified: true,
        bio: '',
        interests: '',
        customStatus: '',
        presence: 'online',
        bannerColor: '#0d9488',
        avatarColor: '#e11d48',
        friends: [],
        incoming: [],
        outgoing: [],
        servers: []
      };
    }
  } else {
    if (nick && (!u.verified || nick !== 'Гость')) u.nick = cleanN;
    if (tgId) u.tgId = tgId;
    if (tgUsername) u.tgUsername = tgUsername;
    if (passHash) u.passHash = passHash;
    u.verified = true;
    if (prevUid && prevUid !== finalUid) {
      Object.keys(members).forEach(r => {
        const idx = members[r].indexOf(prevUid);
        if (idx >= 0) members[r].splice(idx, 1);
      });
      if (users[prevUid] && !users[prevUid].verified) delete users[prevUid];
    }
  }
  pidToUid[u.pid] = finalUid;
  if (u.tgId) tgIdToUid[u.tgId] = finalUid;
  if (u.nick) nickToUid[u.nick.toLowerCase()] = finalUid;
  return u;
}

function isOnline(uid) {
  const u = users[uid];
  if (u && u.presence === 'invisible') return false;
  return clients.some(c => c.uid === uid);
}

function publicProfileOf(uid) {
  const u = users[uid];
  if (!u) return null;
  const rawConn = clients.some(c => c.uid === uid);
  const effectiveOnline = rawConn && u.presence !== 'invisible';
  return {
    pid: u.pid,
    nick: u.nick,
    tgUsername: u.tgUsername || '',
    verified: !!u.verified,
    online: effectiveOnline,
    presence: effectiveOnline ? (u.presence || 'online') : 'offline',
    bio: u.bio || '',
    interests: u.interests || '',
    customStatus: u.customStatus || '',
    bannerColor: u.bannerColor || '#0d9488',
    avatarColor: u.avatarColor || '#e11d48'
  };
}

function socialState(uid) {
  const u = users[uid];
  if (!u) return null;
  const info = pid => {
    const tu = pidToUid[pid];
    if (!tu || !users[tu]) return { pid, nick: '?', online: false, presence: 'offline' };
    return publicProfileOf(tu);
  };
  return {
    pid: u.pid,
    nick: u.nick,
    tgUsername: u.tgUsername || '',
    verified: !!u.verified,
    bio: u.bio || '',
    interests: u.interests || '',
    customStatus: u.customStatus || '',
    presence: u.presence || 'online',
    bannerColor: u.bannerColor || '#0d9488',
    avatarColor: u.avatarColor || '#e11d48',
    servers: u.servers || [],
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

function notifyAllRoomsOfUser(uid) {
  Object.keys(members).forEach(r => {
    if (members[r] && members[r].includes(uid)) {
      broadcastUsers(r);
    }
  });
}

function memberList(room) {
  const online = new Map();
  clients.forEach(c => {
    if (!c.uid) return;
    const prev = online.get(c.uid);
    const inThisRoom = c.room === room;
    online.set(c.uid, {
      inRoom: !!(prev && prev.inRoom) || inThisRoom,
      inVoice: !!(prev && prev.inVoice) || (inThisRoom && !!c.inVoice),
      inScreen: !!(prev && prev.inScreen) || (inThisRoom && !!c.inScreen),
      inCam: !!(prev && prev.inCam) || (inThisRoom && !!c.inCam),
      voiceChannel: (inThisRoom && c.inVoice) ? c.voiceChannel : (prev ? prev.voiceChannel : null)
    });
  });
  return (members[room] || []).map(uid => {
    const u = users[uid];
    const o = online.get(uid);
    const effectiveOnline = !!o && (!u || u.presence !== 'invisible');
    return {
      pid: u ? u.pid : pidOf(uid),
      nick: u ? u.nick : '?',
      verified: !!(u && u.verified),
      online: effectiveOnline,
      presence: effectiveOnline ? (u ? (u.presence || 'online') : 'online') : 'offline',
      customStatus: u ? (u.customStatus || '') : '',
      bio: u ? (u.bio || '') : '',
      interests: u ? (u.interests || '') : '',
      bannerColor: u ? (u.bannerColor || '#0d9488') : '#0d9488',
      avatarColor: u ? (u.avatarColor || '#e11d48') : '#e11d48',
      inVoice: !!(o && o.inVoice),
      inScreen: !!(o && o.inScreen),
      inCam: !!(o && o.inCam),
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
    --chat-font-size: 12px;
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
  .top-right-group { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .btn-top-settings { background: rgba(255,255,255,0.06); border: 1px solid var(--border); color: var(--text-main); padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .btn-top-settings:hover { border-color: var(--cyan-bright); color: var(--cyan-bright); }
  .btn-top-invite { background: #9d174d; border: 1px solid #f43f5e; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-top-invite:hover { background: #be185d; }

  .workspace { flex: 1; display: grid; grid-template-columns: 68px 250px 1fr 260px; overflow: hidden; }

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

  /* Нижняя панель пользователя в стиле Discord */
  .user-bar { padding: 8px 10px; background: #030508; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .user-info { display: flex; align-items: center; gap: 8px; overflow: hidden; cursor: pointer; padding: 3px 5px; border-radius: 6px; flex: 1; }
  .user-info:hover { background: rgba(255,255,255,0.04); }
  .user-ava-wrap { position: relative; flex-shrink: 0; }
  .user-ava { width: 30px; height: 30px; border-radius: 8px; background: #e11d48; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; }
  .user-presence-dot { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; border: 2px solid #030508; }
  .user-presence-dot.idle { background: #eab308; }
  .user-presence-dot.dnd { background: #ef4444; }
  .user-presence-dot.invisible, .user-presence-dot.offline { background: #64748b; }
  .user-name { font-size: 11px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; }
  .user-sub { font-size: 9px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-bar-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .btn-icon-bar { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text-dim); width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 13px; cursor: pointer; transition: 0.15s; }
  .btn-icon-bar:hover { color: var(--cyan-bright); border-color: var(--cyan-bright); background: rgba(45,212,191,0.1); }
  .btn-login-mini { background: transparent; border: 1px solid var(--border); color: var(--cyan-bright); padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
  .btn-login-mini:hover { border-color: var(--cyan-bright); background: rgba(45,212,191,0.1); }

  .main-chat { background: var(--bg-main); display: flex; flex-direction: column; overflow: hidden; }
  .chat-topbar { height: 48px; padding: 0 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .chat-topbar-left { display: flex; align-items: center; gap: 8px; }
  .hash-large { color: var(--cyan-bright); font-size: 18px; font-weight: 800; }
  .top-ch-name { font-size: 13px; font-weight: 700; }
  .top-ch-desc { font-size: 10px; color: var(--text-muted); }
  .btn-top-right-share { background: #0d9488; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }

  .chat-scroll-area { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
  .hero-banner { background: linear-gradient(135deg, #0f1726 0%, #080e17 100%); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; }
  .hero-banner-left { max-width: 440px; }
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
  body.compact-chat .msg-item { padding: 4px 8px; align-items: center; }
  body.compact-chat .msg-ava { width: 20px; height: 20px; font-size: 9px; }
  .msg-ava { width: 28px; height: 28px; border-radius: 6px; background: var(--cyan); color: #042f2e; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .msg-author { font-size: 12px; font-weight: 700; color: #fff; margin-right: 6px; }
  .msg-time { font-size: 9px; color: var(--text-muted); }
  .msg-text { font-size: var(--chat-font-size); color: #e2e8f0; margin-top: 2px; user-select: text; word-break: break-word; }

  .voice-panel { background: rgba(13, 148, 136, 0.06); border: 1px solid var(--cyan-border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
  .voice-panel-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .voice-label { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }
  .voice-title { font-size: 12px; font-weight: 700; margin: 2px 0; }
  .voice-sub { font-size: 10px; color: var(--text-dim); }
  .voice-active-area { display: none; flex-direction: column; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
  .voice-active-area.show { display: flex; }
  .voice-user-card { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); width: fit-content; }
  .vu-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }

  /* Сетка видеопотоков (Веб-камеры и Экраны) */
  .screen-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; width: 100%; }
  .screen-grid:empty { display: none; }
  .screen-card { background: #05080d; border: 1px solid var(--cyan-border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .screen-card-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(15, 23, 34, 0.95); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--cyan-bright); }
  .screen-live-pill { background: #e11d48; color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .screen-live-pill.cam { background: #0d9488; }
  .screen-video-wrap { position: relative; width: 100%; background: #000; display: flex; align-items: center; justify-content: center; min-height: 170px; max-height: 400px; }
  .screen-video-wrap video { width: 100%; max-height: 400px; object-fit: contain; background: #000; display: block; }
  .btn-fs { background: rgba(255,255,255,0.08); border: 1px solid var(--border); color: #fff; padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 600; cursor: pointer; }
  .btn-fs:hover { border-color: var(--cyan-bright); color: var(--cyan-bright); }

  .chat-bottom { padding: 8px 18px 12px; border-top: 1px solid var(--border); background: #070b12; display: flex; flex-direction: column; gap: 6px; }
  .input-row { display: flex; gap: 8px; align-items: center; }
  .chat-inp { flex: 1; background: var(--bg-input); border: 1px solid var(--border); padding: 9px 12px; border-radius: 6px; color: #fff; font-size: 12px; outline: none; }
  .chat-inp:focus { border-color: var(--cyan-bright); }
  .bottom-hint { font-size: 9px; color: var(--text-muted); }

  .right-panel { background: var(--bg-sidebar); border-left: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  .right-sec-title { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
  .online-user-item { display: flex; align-items: center; gap: 7px; font-size: 11px; padding: 6px 7px; background: rgba(255,255,255,0.02); border-radius: 7px; border: 1px solid transparent; cursor: pointer; transition: 0.15s; }
  .online-user-item:hover { background: rgba(255,255,255,0.05); border-color: var(--border); }
  .online-user-item.is-online { border-color: rgba(34, 197, 94, 0.14); }
  .online-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; flex-shrink: 0; }
  .online-dot.idle { background: #eab308; box-shadow: 0 0 6px #eab308; }
  .online-dot.dnd { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
  .online-dot.off, .online-dot.offline { background: #475569; box-shadow: none; }
  .member-text-col { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .member-nick-row { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .member-status-sub { font-size: 9px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status-pill { font-size: 8px; padding: 1px 5px; border-radius: 4px; font-weight: 700; text-transform: uppercase; flex-shrink: 0; }
  .status-pill.on { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .status-pill.off { background: rgba(255, 255, 255, 0.05); color: #64748b; }
  .mini-btn { background: transparent; border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; cursor: pointer; flex-shrink: 0; }
  .mini-btn:hover { background: rgba(20, 184, 166, 0.15); color: #fff; }
  .friend-tag { font-size: 9px; color: var(--cyan-bright); font-weight: 700; flex-shrink: 0; }
  .invite-banner-card { background: linear-gradient(135deg, rgba(219,39,119,0.12), rgba(13,148,136,0.06)); border: 1px solid var(--pink-border); border-radius: 10px; padding: 12px; margin-top: auto; }
  .invite-banner-card h5 { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
  .invite-banner-card p { font-size: 10px; color: var(--text-dim); margin-bottom: 8px; }

  .btn-cyan { background: var(--cyan-bright); color: #042f2e; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }
  .btn-danger { background: #ef4444; color: #fff; border: none; padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; }
  .btn-mute { background: #1e293b; color: #fff; border: 1px solid var(--border); padding: 7px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; }
  .btn-mute.active-screen { background: rgba(219, 39, 119, 0.22); border-color: #f43f5e; color: #fda4af; }
  .btn-mute.active-cam { background: rgba(20, 184, 166, 0.22); border-color: var(--cyan-bright); color: var(--cyan-bright); }
  .btn-pink-card { background: #9d174d; color: #fff; border: none; width: 100%; padding: 7px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-tg { background: #229ED9; color: #fff; border: none; width: 100%; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; margin-bottom: 10px; }
  .btn-tg:hover { background: #1d8ec4; box-shadow: 0 0 14px rgba(34, 158, 217, 0.45); }

  .modal-backdrop { position: fixed; inset: 0; background: rgba(2, 4, 8, 0.86); backdrop-filter: blur(5px); display: none; align-items: center; justify-content: center; z-index: 999; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background: var(--bg-card); border: 1px solid var(--cyan-border); border-radius: 12px; padding: 22px; width: 390px; max-width: 94vw; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
  .modal-box input[type="text"], .modal-box input[type="password"], .modal-box textarea, .modal-box select { width: 100%; padding: 9px 11px; background: #04060a; border: 1px solid var(--border); border-radius: 6px; color: #fff; margin-bottom: 10px; font-size: 12px; outline: none; user-select: text; font-family: inherit; }
  .modal-box input:focus, .modal-box textarea:focus, .modal-box select:focus { border-color: var(--cyan-bright); }
  .link-box { background: #030508; border: 1px dashed var(--cyan-bright); padding: 8px; color: var(--cyan-bright); font-size: 11px; word-break: break-all; margin-bottom: 10px; border-radius: 6px; display: block; text-decoration: none; text-align: center; user-select: text; }
  .auth-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 12px; background: #06090f; padding: 4px; border-radius: 8px; border: 1px solid var(--border); }
  .auth-tab { padding: 6px 8px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 6px; cursor: pointer; color: var(--text-dim); }
  .auth-tab.active { background: rgba(34, 158, 217, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }

  /* ---------- Панель Профиля и Настроек в стиле Discord ---------- */
  .settings-modal-box { background: #0b1119; border: 1px solid var(--cyan-border); border-radius: 14px; width: 780px; max-width: 96vw; height: 560px; max-height: 92vh; display: grid; grid-template-columns: 210px 1fr; overflow: hidden; box-shadow: 0 25px 70px rgba(0,0,0,0.85); }
  .settings-nav { background: #060a0f; border-right: 1px solid var(--border); padding: 16px 10px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .settings-nav-label { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--text-muted); padding: 6px 10px 4px; letter-spacing: 0.8px; }
  .settings-nav-btn { padding: 8px 10px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 8px; transition: 0.15s; }
  .settings-nav-btn:hover { background: rgba(255,255,255,0.04); color: #fff; }
  .settings-nav-btn.active { background: rgba(45, 212, 191, 0.14); color: var(--cyan-bright); border: 1px solid var(--cyan-border); }
  .settings-content { padding: 20px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .settings-pane { display: none; flex-direction: column; gap: 14px; }
  .settings-pane.active { display: flex; }
  .settings-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
  .settings-head h3 { font-size: 16px; font-weight: 800; color: #fff; }
  .field-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-bottom: 4px; display: block; letter-spacing: 0.5px; }
  .settings-card { background: #070b11; border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-title { font-size: 12px; font-weight: 600; color: #f1f5f9; }
  .toggle-sub { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
  .color-swatches { display: flex; gap: 8px; flex-wrap: wrap; }
  .color-swatch { width: 26px; height: 26px; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
  .color-swatch.active { border-color: #fff; transform: scale(1.1); }
  .mic-meter-wrap { width: 100%; height: 10px; background: #04060a; border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
  .mic-meter-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #22c55e, #2dd4bf, #ec4899); transition: width 0.06s linear; }

  /* Карточка профиля в стиле Discord */
  .discord-profile-card { background: #070b11; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .dp-banner { height: 74px; background: #0d9488; position: relative; }
  .dp-body { padding: 34px 16px 16px; position: relative; }
  .dp-ava { width: 58px; height: 58px; border-radius: 14px; background: #e11d48; border: 4px solid #070b11; position: absolute; top: -29px; left: 16px; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 800; color: #fff; }
  .dp-nick { font-size: 16px; font-weight: 800; color: #fff; }
  .dp-status { font-size: 11px; color: var(--cyan-bright); margin-top: 2px; }
  .dp-sec { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  .dp-sec-title { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; letter-spacing: 0.6px; }
  .dp-bio { font-size: 12px; color: #cbd5e1; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .dp-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .dp-tag { background: rgba(45, 212, 191, 0.12); border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
</style>
</head>
<body>

  <div class="top-header">
    <div class="top-logo">СИГНАЛ <b>CYBER.NET</b></div>
    <div class="top-sub">МЕСТО ДЛЯ СВОИХ // ГОЛОС, КАМЕРА И СТРИМЫ</div>
    <div class="top-right-group">
      <button class="btn-top-settings" onclick="openSettingsModal('profile')">👤 Мой профиль</button>
      <button class="btn-top-settings" onclick="openSettingsModal('voice')">⚙️ Настройки</button>
      <button class="btn-top-invite" onclick="openInviteModal()">ПРИГЛАСИТЬ ДРУГА</button>
    </div>
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
          <div class="srv-label">СЕРВЕР СООБЩЕСТВА</div>
          <div class="srv-title" id="srv-title-label">Ночной клуб</div>
        </div>
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

      <div class="user-bar">
        <div class="user-info" onclick="openSettingsModal('profile')" title="Настроить профиль, статус и интересы">
          <div class="user-ava-wrap">
            <div class="user-ava" id="user-ava">ГО</div>
            <div class="user-presence-dot" id="user-presence-dot"></div>
          </div>
          <div style="overflow:hidden;">
            <div class="user-name" id="user-name-label">Гость</div>
            <div class="user-sub" id="user-email-label">Настроить профиль</div>
          </div>
        </div>
        <div class="user-bar-actions">
          <button class="btn-login-mini" onclick="openSettingsModal('profile')">Профиль</button>
          <button class="btn-icon-bar" onclick="openSettingsModal('voice')" title="Настройки голоса, камеры и звука">⚙️</button>
        </div>
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
            <p id="banner-desc">Это #игровая-комната на сервере «Ночной клуб». Делитесь мыслями, включайте камеру или демонстрацию экрана и приглашайте друзей.</p>
            <div class="pill-tags-row">
              <span class="pill-tag" onclick="openSettingsModal('profile')">👤 ЗАПОЛНИТЬ ПРОФИЛЬ И ИНТЕРЕСЫ</span>
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
              <div class="voice-label">ГОЛОСОВОЙ КАНАЛ, КАМЕРА И СТРИМ // WEBRTC P2P</div>
              <div class="voice-title" id="voice-panel-title">Общий разговор участников канала («Ночной эфир»)</div>
              <div class="voice-sub" id="voice-sub-status">Подключайтесь голосом, включайте веб-камеру «📷 Камера» или трансляцию «🖥️ Экран».</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>
              <button class="btn-mute" id="deafen-btn" style="display:none;" onclick="toggleDeafen()" title="Отключить весь входящий звук">🎧 Звук вкл</button>
              <button class="btn-mute" id="cam-btn" onclick="toggleWebcam()" title="Включить веб-камеру при разговоре">📷 Камера</button>
              <button class="btn-mute" id="screen-btn" onclick="toggleScreenShare()" title="Транслировать экран, окно или вкладку">🖥️ Экран</button>
              <button class="btn-mute" onclick="openSettingsModal('voice')" title="Настройки микрофона, звука и камеры">⚙️</button>
              <button class="btn-cyan" id="connect-voice-btn" onclick="toggleVoiceCall()">ПОДКЛЮЧИТЬСЯ</button>
            </div>
          </div>
          <div class="voice-active-area" id="voice-active-area">
            <div class="voice-user-card">
              <span class="vu-dot"></span>
              <span id="voice-my-name" style="font-size:11px;font-weight:700;">Гость (Вы)</span>
            </div>
            <div class="screen-grid" id="screen-grid"></div>
            <div id="audio-box"></div>
          </div>
        </div>
      </div>

      <div class="chat-bottom">
        <form class="input-row" onsubmit="sendChatMessage(event)">
          <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">
          <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
        </form>
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • НАЖМИТЕ НА УЧАСТНИКА СПРАВА, ЧТОБЫ ПОСМОТРЕТЬ ЕГО ПРОФИЛЬ И ИНТЕРЕСЫ</div>
      </div>
    </div>

    <div class="right-panel">
      <div class="right-sec-title">
        <span>УЧАСТНИКИ СЕРВЕРА</span>
        <span>В СЕТИ: <b id="online-count">1</b> / <span id="total-members-count">1</span></span>
      </div>
      <div id="online-users-box"></div>

      <div class="right-sec-title" style="margin-top:8px;">
        <span>ДРУЗЬЯ</span>
        <span><b id="friends-count">0</b></span>
      </div>
      <div id="requests-box"></div>
      <div id="friends-box"></div>

      <div class="invite-banner-card">
        <h5>Зови друзей в канал</h5>
        <p>Отправьте другу ссылку на сервер — он останется в списке участников навсегда, и вы сможете общаться с веб-камерой и демонстрацией экрана.</p>
        <button class="btn-pink-card" onclick="openInviteModal()">🔗 СОЗДАТЬ ПРИГЛАШЕНИЕ</button>
      </div>
    </div>
  </div>

  <!-- Большое окно Профиля и Настроек в стиле Discord -->
  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Настройки пользователя</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">👤 Мой профиль</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🛡️ Учётная запись</div>
        <div class="settings-nav-label" style="margin-top:8px;">Настройки приложения</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и видео</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid var(--border);">
          <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeSettingsModal()">✕ Закрыть (ESC)</button>
        </div>
      </div>

      <div class="settings-content">
        <!-- Вкладка 1: Мой профиль (как в Discord) -->
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head">
            <h3>Мой профиль</h3>
            <button class="btn-cyan" onclick="saveProfileSettings()">Сохранить профиль</button>
          </div>

          <!-- Живое превью карточки профиля -->
          <div class="discord-profile-card">
            <div class="dp-banner" id="preview-banner"></div>
            <div class="dp-body">
              <div class="dp-ava" id="preview-ava">ГО</div>
              <div class="dp-nick" id="preview-nick">Гость</div>
              <div class="dp-status" id="preview-status">✨ Ловлю ночную частоту</div>
              <div class="dp-sec">
                <div class="dp-sec-title">О СЕБЕ</div>
                <div class="dp-bio" id="preview-bio">Расскажите о себе, во что играете и чем увлекаетесь...</div>
              </div>
              <div class="dp-sec">
                <div class="dp-sec-title">ИНТЕРЕСЫ</div>
                <div class="dp-tags" id="preview-tags"></div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label class="field-label">Отображаемый позывной</label>
                <input type="text" id="prof-nick-inp" maxlength="24" placeholder="Ваш позывной" oninput="updateProfilePreview()">
              </div>
              <div>
                <label class="field-label">Статус активности</label>
                <select id="prof-presence-sel">
                  <option value="online">🟢 В сети</option>
                  <option value="idle">🌙 Не активен</option>
                  <option value="dnd">⛔ Не беспокоить</option>
                  <option value="invisible">⚪ Невидимка</option>
                </select>
              </div>
            </div>

            <div>
              <label class="field-label">Кастомный статус (под вашим ником в списке)</label>
              <input type="text" id="prof-status-inp" maxlength="60" placeholder="Например: 🎮 Играю в Cyberpunk // Пишу код" oninput="updateProfilePreview()">
            </div>

            <div>
              <label class="field-label">О себе</label>
              <textarea id="prof-bio-inp" rows="3" maxlength="220" placeholder="Расскажите о себе, своих проектах, любимых играх или музыке..." oninput="updateProfilePreview()"></textarea>
            </div>

            <div>
              <label class="field-label">Интересы и увлечения (через запятую)</label>
              <input type="text" id="prof-interests-inp" maxlength="160" placeholder="Киберпанк, Игры, Музыка, Программирование, Аниме" oninput="updateProfilePreview()">
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label class="field-label">Цвет баннера профиля</label>
                <div class="color-swatches" id="banner-swatches">
                  <div class="color-swatch" data-color="#0d9488" style="background:#0d9488;" onclick="selectBannerColor('#0d9488')"></div>
                  <div class="color-swatch" data-color="#db2777" style="background:#db2777;" onclick="selectBannerColor('#db2777')"></div>
                  <div class="color-swatch" data-color="#7c3aed" style="background:#7c3aed;" onclick="selectBannerColor('#7c3aed')"></div>
                  <div class="color-swatch" data-color="#2563eb" style="background:#2563eb;" onclick="selectBannerColor('#2563eb')"></div>
                  <div class="color-swatch" data-color="#ea580c" style="background:#ea580c;" onclick="selectBannerColor('#ea580c')"></div>
                </div>
              </div>
              <div>
                <label class="field-label">Цвет аватара</label>
                <div class="color-swatches" id="ava-swatches">
                  <div class="color-swatch" data-color="#e11d48" style="background:#e11d48;" onclick="selectAvatarColor('#e11d48')"></div>
                  <div class="color-swatch" data-color="#14b8a6" style="background:#14b8a6;" onclick="selectAvatarColor('#14b8a6')"></div>
                  <div class="color-swatch" data-color="#8b5cf6" style="background:#8b5cf6;" onclick="selectAvatarColor('#8b5cf6')"></div>
                  <div class="color-swatch" data-color="#3b82f6" style="background:#3b82f6;" onclick="selectAvatarColor('#3b82f6')"></div>
                  <div class="color-swatch" data-color="#f59e0b" style="background:#f59e0b;" onclick="selectAvatarColor('#f59e0b')"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Вкладка 2: Голос и видео (РАБОЧИЕ настройки звука и веб-камеры) -->
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head">
            <h3>Настройки голоса и видео</h3>
            <button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 Обновить устройства</button>
          </div>

          <div class="settings-card">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label class="field-label">Устройство ввода (Микрофон)</label>
                <select id="set-mic-select" onchange="saveAudioVideoSettings()"></select>
              </div>
              <div>
                <label class="field-label">Устройство вывода (Динамики / Наушники)</label>
                <select id="set-spk-select" onchange="saveAudioVideoSettings()"></select>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
              <div>
                <label class="field-label">Громкость микрофона: <span id="lbl-mic-vol">100%</span></label>
                <input type="range" id="set-mic-vol" min="0" max="200" value="100" style="width:100%;" oninput="onAudioSlidersChange()">
              </div>
              <div>
                <label class="field-label">Громкость собеседников: <span id="lbl-out-vol">100%</span></label>
                <input type="range" id="set-out-vol" min="0" max="200" value="100" style="width:100%;" oninput="onAudioSlidersChange()">
              </div>
            </div>

            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <label class="field-label" style="margin:0;">Проверка микрофона</label>
                <button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ Проверить микрофон</button>
              </div>
              <div class="mic-meter-wrap">
                <div class="mic-meter-bar" id="mic-test-bar"></div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label class="field-label">Веб-камера</label>
                <select id="set-cam-select" onchange="saveAudioVideoSettings()"></select>
              </div>
              <div>
                <label class="field-label">Качество видео веб-камеры</label>
                <select id="set-cam-res" onchange="saveAudioVideoSettings()">
                  <option value="720">HD 720p (1280×720, 30 fps)</option>
                  <option value="480">SD 480p (854×480, плавный эфир)</option>
                </select>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Шумоподавление (Noise Suppression)</div>
                <div class="toggle-sub">Фильтрует фоновый шум вентиляторов и клавиатуры</div>
              </div>
              <input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()">
            </div>
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Эхоподавление (Echo Cancellation)</div>
                <div class="toggle-sub">Предотвращает повтор звука из динамиков в микрофон</div>
              </div>
              <input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()">
            </div>
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Авторегулировка усиления (Auto Gain Control)</div>
                <div class="toggle-sub">Автоматически выравнивает громкость вашего голоса</div>
              </div>
              <input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()">
            </div>
          </div>
        </div>

        <!-- Вкладка 3: Внешний вид -->
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head">
            <h3>Внешний вид (как в Discord)</h3>
          </div>
          <div class="settings-card">
            <div>
              <label class="field-label">Неоновый акцент интерфейса</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
                <button class="btn-login-mini" onclick="setAccentTheme('#14b8a6', '#2dd4bf')">Бирюзовый Кибер</button>
                <button class="btn-login-mini" onclick="setAccentTheme('#db2777', '#f43f5e')">Розовый Неон</button>
                <button class="btn-login-mini" onclick="setAccentTheme('#7c3aed', '#a78bfa')">Фиолетовый Синт</button>
                <button class="btn-login-mini" onclick="setAccentTheme('#d97706', '#fbbf24')">Золотой Кибер</button>
              </div>
            </div>
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Компактный режим сообщений</div>
                <div class="toggle-sub">Уменьшает отступы в чате, чтобы помещалось больше текста</div>
              </div>
              <input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()">
            </div>
            <div>
              <label class="field-label">Масштаб шрифта чата</label>
              <select id="sel-font-size" onchange="applyAppearanceSettings()">
                <option value="11px">Маленький (11px)</option>
                <option value="12px" selected>Стандартный (12px)</option>
                <option value="14px">Крупный (14px)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Вкладка 4: Уведомления -->
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head">
            <h3>Звуки и уведомления</h3>
          </div>
          <div class="settings-card">
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Звук при новом сообщении в чате</div>
                <div class="toggle-sub">Воспроизводить мягкий кибер-сигнал при входящем сообщении</div>
              </div>
              <input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()">
            </div>
            <div class="toggle-row">
              <div>
                <div class="toggle-title">Звук подключения к голосовому каналу</div>
                <div class="toggle-sub">Звуковой сигнал при входе/выходе из голосового эфира</div>
              </div>
              <input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()">
            </div>
            <div>
              <button class="btn-login-mini" onclick="playUiBeep(660, 0.08)">🔊 Проверить звук уведомления</button>
            </div>
          </div>
        </div>

        <!-- Вкладка 5: Учётная запись -->
        <div class="settings-pane" id="pane-account">
          <div class="settings-head">
            <h3>Учётная запись и сессия</h3>
          </div>
          <div class="settings-card">
            <div style="font-size:12px;color:#cbd5e1;line-height:1.5;">
              Ваш аккаунт автоматически сохранён в этом браузере — повторный вход при перезагрузке страницы не требуется.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn-cyan" onclick="closeSettingsModal();openAuthModal(false)">Сменить аккаунт / Привязать Telegram</button>
              <button class="btn-danger" onclick="logoutAccount()">Выйти из аккаунта</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Модальное окно просмотра чужого профиля (при клике на участника справа) -->
  <div class="modal-backdrop" id="view-profile-modal" onclick="if(event.target===this)closeViewProfileModal()">
    <div class="modal-box" style="padding:0;overflow:hidden;width:360px;">
      <div class="discord-profile-card" style="border:none;">
        <div class="dp-banner" id="vp-banner"></div>
        <div class="dp-body">
          <div class="dp-ava" id="vp-ava">УЧ</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="dp-nick" id="vp-nick">Участник</div>
            <span class="status-pill on" id="vp-online-pill">в сети</span>
          </div>
          <div class="dp-status" id="vp-status"></div>
          <div class="dp-sec">
            <div class="dp-sec-title">О СЕБЕ</div>
            <div class="dp-bio" id="vp-bio">Участник пока ничего о себе не указал.</div>
          </div>
          <div class="dp-sec">
            <div class="dp-sec-title">ИНТЕРЕСЫ</div>
            <div class="dp-tags" id="vp-tags"></div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn-cyan" id="vp-friend-btn" style="flex:1;">+ Добавить в друзья</button>
            <button class="btn-login-mini" onclick="closeViewProfileModal()">Закрыть</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Модальное окно приглашения -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Ссылка-приглашение на сервер</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Нажмите на ссылку или скопируйте её для отправки другу:</p>
      <a class="link-box" id="public-invite-url" href="#" target="_blank" rel="noopener">Генерация публичного адреса...</a>
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeInviteModal()">Закрыть</button>
    </div>
  </div>

  <!-- Модальное окно первой авторизации (больше не открывается повторно после входа) -->
  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="color:var(--cyan-bright);font-size:16px;">Вход на сервер (один раз)</h3>
        <span style="font-size:9px;background:#229ED9;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;">TELEGRAM ID</span>
      </div>

      <div class="auth-tabs">
        <div class="auth-tab active" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ Через Telegram</div>
        <div class="auth-tab" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 Быстрый вход</div>
      </div>

      <input type="text" id="nick-inp" placeholder="Ваш позывной (никнейм)" maxlength="24">

      <div id="auth-tg-panel">
        <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;line-height:1.45;" id="tg-status-hint">
          Нажмите кнопку ниже, чтобы открыть бота в Telegram и нажать <b>«Запустить» (/start)</b> — после этого повторный вход больше никогда не потребуется:
        </p>
        <button type="button" class="btn-tg" id="tg-open-bot-btn" onclick="openTelegramBot()">
          <span>✈️ Открыть Telegram и получить код</span>
        </button>

        <input type="text" id="tg-code-inp" placeholder="Код из Telegram (4 цифры)" maxlength="6" style="text-align:center;font-size:15px;font-weight:700;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="verifyTelegramCode()">Подтвердить код и войти навсегда</button>
      </div>

      <div id="auth-pass-panel" style="display:none;">
        <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">
          Придумайте пароль для вашего позывного (сессия сохранится автоматически):
        </p>
        <input type="password" id="pass-inp" placeholder="Пароль (минимум 4 символа)" maxlength="64">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithPassword()">Войти навсегда</button>
      </div>

      <button class="btn-login-mini" id="auth-close-btn" style="width:100%;text-align:center;margin-top:8px;" onclick="closeAuthModal()">Закрыть</button>
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

<script>
  const params = new URLSearchParams(window.location.search);

  // ---------- Сохранение сессии в localStorage + Cookie (чтобы повторный вход не требовался) ----------
  function setPersistCookie(name, val) {
    try {
      document.cookie = name + '=' + encodeURIComponent(val) + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
  }
  function getPersistCookie(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function makeUid() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  let myUid = '';
  try { myUid = localStorage.getItem('cyber_uid') || ''; } catch (e) {}
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    myUid = getPersistCookie('cyber_uid');
  }
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    myUid = makeUid();
  }
  try { localStorage.setItem('cyber_uid', myUid); } catch (e) {}
  setPersistCookie('cyber_uid', myUid);

  let currentRoom = params.get('room') || params.get('server');
  if (!currentRoom) {
    try { currentRoom = localStorage.getItem('cyber_last_room'); } catch (e) {}
  }
  currentRoom = currentRoom || 'cy-4371';
  try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}

  let currentChannel = params.get('channel') || 'игровая-комната';
  let currentVoiceChannel = 'Ночной эфир';
  let myNick = 'Гость_' + Math.floor(100 + Math.random() * 899);
  try {
    const savedNick = localStorage.getItem('cyber_nick') || getPersistCookie('cyber_nick');
    if (savedNick) myNick = savedNick;
  } catch (e) {}

  let myVerified = false;
  try {
    myVerified = localStorage.getItem('cyber_verified') === '1' || getPersistCookie('cyber_verified') === '1';
  } catch (e) {}
  let authLocked = !myVerified;

  // Данные профиля пользователя
  let myProfile = {
    bio: '',
    interests: '',
    customStatus: '',
    presence: 'online',
    bannerColor: '#0d9488',
    avatarColor: '#e11d48'
  };
  try {
    const savedProf = JSON.parse(localStorage.getItem('cyber_profile') || '{}');
    myProfile = Object.assign(myProfile, savedProf);
  } catch (e) {}

  // Настройки звука, видео и уведомлений
  let appSettings = {
    micDeviceId: '',
    spkDeviceId: '',
    camDeviceId: '',
    micVolume: 100,
    outVolume: 100,
    camRes: '720',
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    compactChat: false,
    fontSize: '12px',
    soundMsg: true,
    soundVoice: true
  };
  try {
    const savedSet = JSON.parse(localStorage.getItem('cyber_settings') || '{}');
    appSettings = Object.assign(appSettings, savedSet);
  } catch (e) {}

  let clientId = Math.random().toString(36).substring(2, 10);
  let evtSource = null;
  let tgSessionToken = '';
  let tgBotUsername = '';
  let tgPollTimer = null;

  let serversList = [];
  let currentServerMeta = {
    id: currentRoom,
    name: 'Ночной клуб',
    icon: 'НК',
    desc: 'Игры, идеи и разговоры после полуночи',
    textChannels: ['игровая-комната', 'общий', 'знакомства', 'музыка'],
    voiceChannels: ['Ночной эфир']
  };

  let rawMicStream = null, localStream = null, micGainNode = null, audioCtx = null;
  let screenStream = null, webcamStream = null, peer = null, myPeerId = null;
  let inVoice = false, inScreen = false, inWebcam = false, isMuted = false, isDeafened = false;
  let screenCalls = {}, camCalls = {};
  let myPid = null, lastMembers = [], social = { friends: [], incoming: [], outgoing: [], servers: [] };
  let pendingChannelType = 'text';
  let micTestStream = null, micTestTimer = null;

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

  function playUiBeep(freq, duration) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq || 580;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (duration || 0.08));
    } catch (e) {}
  }

  function switchAuthTab(mode) {
    const isTg = mode === 'tg';
    document.getElementById('tab-tg-btn').classList.toggle('active', isTg);
    document.getElementById('tab-pass-btn').classList.toggle('active', !isTg);
    document.getElementById('auth-tg-panel').style.display = isTg ? 'block' : 'none';
    document.getElementById('auth-pass-panel').style.display = isTg ? 'none' : 'block';
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    const ava = document.getElementById('user-ava');
    ava.textContent = myNick.slice(0, 2).toUpperCase();
    ava.style.background = myProfile.avatarColor || '#e11d48';
    const pDot = document.getElementById('user-presence-dot');
    pDot.className = 'user-presence-dot ' + (myProfile.presence || 'online');
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    if (myProfile.customStatus) {
      document.getElementById('user-email-label').textContent = myProfile.customStatus;
      document.getElementById('user-email-label').style.color = '#cbd5e1';
    } else if (myVerified) {
      document.getElementById('user-email-label').textContent = '✓ В сети';
      document.getElementById('user-email-label').style.color = '#34d399';
    } else {
      document.getElementById('user-email-label').textContent = 'Настроить профиль';
      document.getElementById('user-email-label').style.color = '';
    }
  }

  function renderServersRail() {
    const box = document.getElementById('servers-list-box');
    box.innerHTML = '';
    const list = serversList.length ? serversList : [currentServerMeta];
    list.forEach(function (srv) {
      const btn = el('div', 'srv-ico' + (srv.id === currentRoom ? ' active' : ''), srv.icon || srv.name.slice(0, 2).toUpperCase());
      btn.title = srv.name;
      btn.onclick = function () {
        if (srv.id !== currentRoom) switchServer(srv.id);
      };
      box.appendChild(btn);
    });
  }

  function renderServerChannels() {
    document.getElementById('srv-title-label').textContent = currentServerMeta.name || currentRoom;
    document.getElementById('srv-desc-label').textContent = currentServerMeta.desc || 'Игры, идеи и разговоры после полуночи';

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
    document.getElementById('banner-desc').textContent = 'Это #' + ch + ' на сервере «' + srvName + '». Делитесь мыслями, включайте камеру или демонстрацию экрана и приглашайте друзей.';
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

  function connectEventStream() {
    if (evtSource) {
      try { evtSource.close(); } catch (e) {}
    }
    clientId = Math.random().toString(36).substring(2, 10);
    const verParam = myVerified ? '1' : '0';
    evtSource = new EventSource('/api/events?id=' + clientId + '&uid=' + myUid + '&verified=' + verParam + '&room=' + encodeURIComponent(currentRoom) + '&nick=' + encodeURIComponent(myNick));

    evtSource.onmessage = function (e) {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      if (data.type === 'server-meta') {
        currentServerMeta = data.payload.current;
        serversList = data.payload.list || [currentServerMeta];
        renderServersRail();
        renderServerChannels();
        loadHistory();
        // Если профиль был сохранён в браузере, синхронизируем его с сервером
        if (myVerified) syncProfileToServer();
      } else if (data.type === 'servers') {
        serversList = data.payload.list || [];
        const found = serversList.find(function (s) { return s.id === currentRoom; });
        if (found) currentServerMeta = found;
        renderServersRail();
        renderServerChannels();
      } else if (data.type === 'msg' && data.payload.channel === currentChannel) {
        addMsgToDOM(data.payload.msg);
        if (appSettings.soundMsg && data.payload.msg && data.payload.msg.author !== myNick) {
          playUiBeep(540, 0.06);
        }
      } else if (data.type === 'users') {
        renderUsers(data.payload);
      } else if (data.type === 'social') {
        myPid = data.payload.pid;
        social = data.payload;
        if (data.payload.nick) {
          myNick = data.payload.nick;
          try { localStorage.setItem('cyber_nick', myNick); } catch (err) {}
          setPersistCookie('cyber_nick', myNick);
        }
        if (data.payload.verified) {
          myVerified = true;
          authLocked = false;
          try { localStorage.setItem('cyber_verified', '1'); } catch (err) {}
          setPersistCookie('cyber_verified', '1');
          closeAuthModal();
        }
        if (data.payload.bio !== undefined) {
          myProfile.bio = data.payload.bio || myProfile.bio;
          myProfile.interests = data.payload.interests || myProfile.interests;
          myProfile.customStatus = data.payload.customStatus || myProfile.customStatus;
          myProfile.presence = data.payload.presence || myProfile.presence;
          myProfile.bannerColor = data.payload.bannerColor || myProfile.bannerColor;
          myProfile.avatarColor = data.payload.avatarColor || myProfile.avatarColor;
        }
        applyNickUI();
        renderSocial();
        renderUsers(lastMembers);
      } else if (data.type === 'voice-join') {
        if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId && data.payload.voiceChannel === currentVoiceChannel) {
          const pid = data.payload.peerId;
          const call = peer.call(pid, localStream, { metadata: { kind: 'audio', nick: myNick } });
          if (call) {
            call.on('stream', function (remoteStream) { playStream(pid, remoteStream); });
            call.on('close', function () { removeAudio(pid); });
            call.on('error', function () { removeAudio(pid); });
          }
          if (inScreen && screenStream) {
            callPeerWithScreen(pid);
          }
          if (inWebcam && webcamStream) {
            callPeerWithWebcam(pid);
          }
        }
      } else if (data.type === 'screen-stop') {
        if (data.payload && data.payload.peerId) {
          removeMediaTile('screen-' + data.payload.peerId);
        }
      } else if (data.type === 'cam-stop') {
        if (data.payload && data.payload.peerId) {
          removeMediaTile('cam-' + data.payload.peerId);
        }
      }
    };
  }

  applyNickUI();
  applyAppearanceFromStorage();
  renderServersRail();
  renderServerChannels();
  connectEventStream();

  // Показываем окно входа ТОЛЬКО если пользователь ни разу не входил
  if (!myVerified) {
    openAuthModal(true);
  }

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
    if (!myVerified) {
      openAuthModal(true);
      return Promise.resolve();
    }
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
    const offline = lastMembers.filter(function (u) { return !u.online; });
    document.getElementById('online-count').textContent = online.length;
    document.getElementById('total-members-count').textContent = lastMembers.length;

    const box = document.getElementById('online-users-box');
    box.innerHTML = '';
    const sorted = online.concat(offline);
    const friendPids = (social.friends || []).map(function (f) { return f.pid; });

    sorted.forEach(function (u) {
      const d = el('div', 'online-user-item' + (u.online ? ' is-online' : ''));
      if (!u.online) d.style.opacity = '0.68';

      const dotCls = u.online ? (u.presence || 'online') : 'off';
      d.appendChild(el('span', 'online-dot ' + dotCls));

      const mediaIcons = (u.inVoice ? ' 🔊' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '');
      const col = el('div', 'member-text-col');
      const nameRow = el('div', 'member-nick-row', u.nick + (u.pid === myPid ? ' (вы)' : '') + mediaIcons);
      nameRow.style.fontWeight = u.online ? '600' : '400';
      col.appendChild(nameRow);
      if (u.customStatus) {
        col.appendChild(el('div', 'member-status-sub', u.customStatus));
      }
      d.appendChild(col);

      const stPill = el('span', 'status-pill ' + (u.online ? 'on' : 'off'), u.online ? 'в сети' : 'не в сети');
      d.appendChild(stPill);

      if (myPid && u.pid !== myPid) {
        if (friendPids.indexOf(u.pid) >= 0) {
          d.appendChild(el('span', 'friend-tag', 'друг'));
        } else if ((social.outgoing || []).indexOf(u.pid) >= 0) {
          d.appendChild(el('span', 'friend-tag', 'заявка'));
        } else if ((social.incoming || []).some(function (i) { return i.pid === u.pid; })) {
          const b = el('button', 'mini-btn', 'принять');
          b.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', u.pid); };
          d.appendChild(b);
        } else {
          const b = el('button', 'mini-btn', '+ друг');
          b.onclick = function (ev) { ev.stopPropagation(); friendAction('request', u.pid); };
          d.appendChild(b);
        }
      }

      d.onclick = function () { openUserProfileCard(u); };
      box.appendChild(d);
    });
  }

  function renderSocial() {
    const friends = social.friends || [];
    const incoming = social.incoming || [];
    document.getElementById('friends-count').textContent = friends.length;

    const rq = document.getElementById('requests-box');
    rq.innerHTML = '';
    incoming.forEach(function (r) {
      const d = el('div', 'online-user-item');
      d.style.borderColor = 'rgba(219, 39, 119, 0.4)';
      const name = el('span', '', r.nick + ' хочет в друзья');
      name.style.flex = '1';
      const ok = el('button', 'mini-btn', '✓');
      ok.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕');
      no.onclick = function (ev) { ev.stopPropagation(); friendAction('decline', r.pid); };
      d.appendChild(name);
      d.appendChild(ok);
      d.appendChild(no);
      rq.appendChild(d);
    });

    const fb = document.getElementById('friends-box');
    fb.innerHTML = '';
    if (friends.length === 0) {
      const hint = el('div', '', 'Пока никого. Нажмите «+ друг» рядом с участником.');
      hint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.35;';
      fb.appendChild(hint);
    }
    friends.forEach(function (f) {
      const d = el('div', 'online-user-item' + (f.online ? ' is-online' : ''));
      if (!f.online) d.style.opacity = '0.68';
      d.appendChild(el('span', 'online-dot ' + (f.online ? (f.presence || 'online') : 'off')));
      const name = el('span', '', f.nick);
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      d.appendChild(name);

      const stPill = el('span', 'status-pill ' + (f.online ? 'on' : 'off'), f.online ? 'в сети' : 'не в сети');
      d.appendChild(stPill);

      const rmb = el('button', 'mini-btn', '✕');
      rmb.title = 'Удалить из друзей';
      rmb.onclick = function (ev) {
        ev.stopPropagation();
        if (confirm('Удалить ' + f.nick + ' из друзей?')) friendAction('remove', f.pid);
      };
      d.appendChild(rmb);
      d.onclick = function () { openUserProfileCard(f); };
      fb.appendChild(d);
    });
  }

  // ---------- Просмотр чужой карточки профиля в стиле Discord ----------
  function openUserProfileCard(u) {
    if (!u) return;
    document.getElementById('vp-banner').style.background = u.bannerColor || '#0d9488';
    const ava = document.getElementById('vp-ava');
    ava.textContent = String(u.nick || '?').slice(0, 2).toUpperCase();
    ava.style.background = u.avatarColor || '#e11d48';
    document.getElementById('vp-nick').textContent = u.nick || 'Участник';
    const pill = document.getElementById('vp-online-pill');
    pill.className = 'status-pill ' + (u.online ? 'on' : 'off');
    pill.textContent = u.online ? 'в сети' : 'не в сети';
    document.getElementById('vp-status').textContent = u.customStatus || '';
    document.getElementById('vp-bio').textContent = u.bio || 'Участник пока ничего о себе не указал.';

    const tagsBox = document.getElementById('vp-tags');
    tagsBox.innerHTML = '';
    const rawTags = String(u.interests || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (rawTags.length === 0) {
      tagsBox.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Интересы не указаны</span>';
    } else {
      rawTags.forEach(function (tg) {
        tagsBox.appendChild(el('span', 'dp-tag', tg));
      });
    }

    const fBtn = document.getElementById('vp-friend-btn');
    const friendPids = (social.friends || []).map(function (f) { return f.pid; });
    if (u.pid === myPid) {
      fBtn.textContent = '✏️ Редактировать мой профиль';
      fBtn.onclick = function () { closeViewProfileModal(); openSettingsModal('profile'); };
    } else if (friendPids.indexOf(u.pid) >= 0) {
      fBtn.textContent = '✓ У вас в друзьях';
      fBtn.onclick = function () { closeViewProfileModal(); };
    } else {
      fBtn.textContent = '+ Добавить в друзья';
      fBtn.onclick = function () { friendAction('request', u.pid); closeViewProfileModal(); };
    }

    document.getElementById('view-profile-modal').classList.add('open');
  }
  function closeViewProfileModal() {
    document.getElementById('view-profile-modal').classList.remove('open');
  }

  // ---------- Панель Профиля и Настроек в стиле Discord ----------
  function openSettingsModal(pane) {
    document.getElementById('prof-nick-inp').value = myNick;
    document.getElementById('prof-presence-sel').value = myProfile.presence || 'online';
    document.getElementById('prof-status-inp').value = myProfile.customStatus || '';
    document.getElementById('prof-bio-inp').value = myProfile.bio || '';
    document.getElementById('prof-interests-inp').value = myProfile.interests || '';
    updateProfilePreview();

    document.getElementById('set-mic-vol').value = appSettings.micVolume;
    document.getElementById('lbl-mic-vol').textContent = appSettings.micVolume + '%';
    document.getElementById('set-out-vol').value = appSettings.outVolume;
    document.getElementById('lbl-out-vol').textContent = appSettings.outVolume + '%';
    document.getElementById('set-cam-res').value = appSettings.camRes || '720';
    document.getElementById('chk-noise').checked = appSettings.noiseSuppression !== false;
    document.getElementById('chk-echo').checked = appSettings.echoCancellation !== false;
    document.getElementById('chk-agc').checked = appSettings.autoGainControl !== false;
    document.getElementById('chk-compact').checked = !!appSettings.compactChat;
    document.getElementById('sel-font-size').value = appSettings.fontSize || '12px';
    document.getElementById('chk-snd-msg').checked = appSettings.soundMsg !== false;
    document.getElementById('chk-snd-voice').checked = appSettings.soundVoice !== false;

    refreshMediaDevices();
    switchSettingsPane(pane || 'profile');
    document.getElementById('settings-modal').classList.add('open');
  }

  function closeSettingsModal() {
    stopMicTest();
    document.getElementById('settings-modal').classList.remove('open');
  }

  function switchSettingsPane(paneId) {
    document.querySelectorAll('.settings-nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-pane') === paneId);
    });
    document.querySelectorAll('.settings-pane').forEach(function (p) {
      p.classList.toggle('active', p.id === 'pane-' + paneId);
    });
    if (paneId !== 'voice') stopMicTest();
  }

  function selectBannerColor(col) {
    myProfile.bannerColor = col;
    updateProfilePreview();
  }
  function selectAvatarColor(col) {
    myProfile.avatarColor = col;
    updateProfilePreview();
  }

  function updateProfilePreview() {
    const n = document.getElementById('prof-nick-inp').value.trim() || myNick;
    const st = document.getElementById('prof-status-inp').value.trim();
    const bio = document.getElementById('prof-bio-inp').value.trim();
    const intr = document.getElementById('prof-interests-inp').value.trim();

    document.getElementById('preview-banner').style.background = myProfile.bannerColor || '#0d9488';
    const ava = document.getElementById('preview-ava');
    ava.textContent = n.slice(0, 2).toUpperCase();
    ava.style.background = myProfile.avatarColor || '#e11d48';
    document.getElementById('preview-nick').textContent = n;
    document.getElementById('preview-status').textContent = st || 'В эфире СИГНАЛ';
    document.getElementById('preview-bio').textContent = bio || 'Расскажите о себе, во что играете и чем увлекаетесь...';

    const tBox = document.getElementById('preview-tags');
    tBox.innerHTML = '';
    const tags = intr.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (tags.length === 0) {
      tBox.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Нет тегов</span>';
    } else {
      tags.forEach(function (tg) {
        tBox.appendChild(el('span', 'dp-tag', tg));
      });
    }
  }

  function syncProfileToServer() {
    return fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: myUid,
        nick: myNick,
        presence: myProfile.presence,
        customStatus: myProfile.customStatus,
        bio: myProfile.bio,
        interests: myProfile.interests,
        bannerColor: myProfile.bannerColor,
        avatarColor: myProfile.avatarColor
      })
    }).catch(function () {});
  }

  async function saveProfileSettings() {
    const newNick = document.getElementById('prof-nick-inp').value.trim().slice(0, 24);
    if (newNick) {
      myNick = newNick;
      try { localStorage.setItem('cyber_nick', myNick); } catch (e) {}
      setPersistCookie('cyber_nick', myNick);
    }
    myProfile.presence = document.getElementById('prof-presence-sel').value;
    myProfile.customStatus = document.getElementById('prof-status-inp').value.trim().slice(0, 60);
    myProfile.bio = document.getElementById('prof-bio-inp').value.trim().slice(0, 220);
    myProfile.interests = document.getElementById('prof-interests-inp').value.trim().slice(0, 160);

    try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
    applyNickUI();
    await syncProfileToServer();
    closeSettingsModal();
  }

  // ---------- Рабочие настройки звука и видео ----------
  async function refreshMediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const micSel = document.getElementById('set-mic-select');
      const spkSel = document.getElementById('set-spk-select');
      const camSel = document.getElementById('set-cam-select');
      micSel.innerHTML = '';
      spkSel.innerHTML = '';
      camSel.innerHTML = '';

      let mCount = 1, sCount = 1, cCount = 1;
      devices.forEach(function (d) {
        if (d.kind === 'audioinput') {
          const opt = el('option', '', d.label || ('Микрофон ' + (mCount++)));
          opt.value = d.deviceId;
          if (d.deviceId === appSettings.micDeviceId) opt.selected = true;
          micSel.appendChild(opt);
        } else if (d.kind === 'audiooutput') {
          const opt = el('option', '', d.label || ('Динамики / Наушники ' + (sCount++)));
          opt.value = d.deviceId;
          if (d.deviceId === appSettings.spkDeviceId) opt.selected = true;
          spkSel.appendChild(opt);
        } else if (d.kind === 'videoinput') {
          const opt = el('option', '', d.label || ('Веб-камера ' + (cCount++)));
          opt.value = d.deviceId;
          if (d.deviceId === appSettings.camDeviceId) opt.selected = true;
          camSel.appendChild(opt);
        }
      });
      if (!micSel.options.length) micSel.appendChild(el('option', '', 'Микрофон по умолчанию'));
      if (!spkSel.options.length) spkSel.appendChild(el('option', '', 'Системный звук по умолчанию'));
      if (!camSel.options.length) camSel.appendChild(el('option', '', 'Веб-камера по умолчанию'));
    } catch (e) {}
  }

  function onAudioSlidersChange() {
    const mVol = Number(document.getElementById('set-mic-vol').value || 100);
    const oVol = Number(document.getElementById('set-out-vol').value || 100);
    document.getElementById('lbl-mic-vol').textContent = mVol + '%';
    document.getElementById('lbl-out-vol').textContent = oVol + '%';
    appSettings.micVolume = mVol;
    appSettings.outVolume = oVol;

    if (micGainNode) {
      micGainNode.gain.value = mVol / 100;
    }
    applyOutputVolumeToAll();
    saveAudioVideoSettings();
  }

  function applyOutputVolumeToAll() {
    const vol = isDeafened ? 0 : Math.min(1, Math.max(0, (appSettings.outVolume || 100) / 100));
    document.querySelectorAll('#audio-box audio').forEach(function (a) {
      a.volume = vol;
      a.muted = isDeafened;
      if (appSettings.spkDeviceId && typeof a.setSinkId === 'function') {
        a.setSinkId(appSettings.spkDeviceId).catch(function () {});
      }
    });
  }

  function saveAudioVideoSettings() {
    const micSel = document.getElementById('set-mic-select');
    const spkSel = document.getElementById('set-spk-select');
    const camSel = document.getElementById('set-cam-select');
    if (micSel && micSel.value) appSettings.micDeviceId = micSel.value;
    if (spkSel && spkSel.value) appSettings.spkDeviceId = spkSel.value;
    if (camSel && camSel.value) appSettings.camDeviceId = camSel.value;
    appSettings.camRes = document.getElementById('set-cam-res').value || '720';
    appSettings.noiseSuppression = document.getElementById('chk-noise').checked;
    appSettings.echoCancellation = document.getElementById('chk-echo').checked;
    appSettings.autoGainControl = document.getElementById('chk-agc').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll();
  }

  async function toggleMicTest() {
    if (micTestTimer) {
      stopMicTest();
      return;
    }
    try {
      micTestStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: appSettings.micDeviceId ? { ideal: appSettings.micDeviceId } : undefined,
          noiseSuppression: appSettings.noiseSuppression,
          echoCancellation: appSettings.echoCancellation,
          autoGainControl: appSettings.autoGainControl
        }
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(micTestStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const dataArr = new Uint8Array(analyser.frequencyBinCount);
      document.getElementById('btn-mic-test').textContent = '🛑 Остановить проверку';

      micTestTimer = setInterval(function () {
        analyser.getByteFrequencyData(dataArr);
        let sum = 0;
        for (let i = 0; i < dataArr.length; i++) sum += dataArr[i];
        const avg = sum / dataArr.length;
        const pct = Math.min(100, Math.round((avg / 90) * 100 * (appSettings.micVolume / 100)));
        document.getElementById('mic-test-bar').style.width = pct + '%';
      }, 60);
    } catch (e) {
      alert('Не удалось получить доступ к микрофону.');
    }
  }

  function stopMicTest() {
    if (micTestTimer) {
      clearInterval(micTestTimer);
      micTestTimer = null;
    }
    if (micTestStream) {
      micTestStream.getTracks().forEach(function (t) { t.stop(); });
      micTestStream = null;
    }
    const btn = document.getElementById('btn-mic-test');
    if (btn) btn.textContent = '🎙️ Проверить микрофон';
    const bar = document.getElementById('mic-test-bar');
    if (bar) bar.style.width = '0%';
  }

  function setAccentTheme(mainColor, brightColor) {
    document.documentElement.style.setProperty('--cyan', mainColor);
    document.documentElement.style.setProperty('--cyan-bright', brightColor);
    appSettings.accentMain = mainColor;
    appSettings.accentBright = brightColor;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
  }

  function applyAppearanceSettings() {
    appSettings.compactChat = document.getElementById('chk-compact').checked;
    appSettings.fontSize = document.getElementById('sel-font-size').value || '12px';
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyAppearanceFromStorage();
  }

  function applyAppearanceFromStorage() {
    document.body.classList.toggle('compact-chat', !!appSettings.compactChat);
    document.documentElement.style.setProperty('--chat-font-size', appSettings.fontSize || '12px');
    if (appSettings.accentMain && appSettings.accentBright) {
      document.documentElement.style.setProperty('--cyan', appSettings.accentMain);
      document.documentElement.style.setProperty('--cyan-bright', appSettings.accentBright);
    }
  }

  function saveNotificationSettings() {
    appSettings.soundMsg = document.getElementById('chk-snd-msg').checked;
    appSettings.soundVoice = document.getElementById('chk-snd-voice').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
  }

  function logoutAccount() {
    if (!confirm('Вы действительно хотите выйти из аккаунта?')) return;
    try {
      localStorage.removeItem('cyber_verified');
      localStorage.removeItem('cyber_uid');
    } catch (e) {}
    setPersistCookie('cyber_verified', '');
    setPersistCookie('cyber_uid', '');
    window.location.reload();
  }

  function sendChatMessage(e) {
    e.preventDefault();
    if (!myVerified) {
      openAuthModal(true);
      return;
    }
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text) return;
    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, channel: currentChannel, author: myNick, text: text })
    }).catch(function () { alert('Не удалось отправить сообщение.'); });
    inp.value = '';
  }

  function setChannel(ch) {
    currentChannel = ch;
    applyChannelUI(ch);
    loadHistory();
  }

  function selectVoiceChannel(vch) {
    if (!myVerified) {
      openAuthModal(true);
      return;
    }
    currentVoiceChannel = vch;
    updateVoicePanelUI();
    renderServerChannels();
    if (!inVoice) {
      toggleVoiceCall();
    } else {
      postVoiceState({ inVoice: true, inScreen: inScreen, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel })
        .then(function (data) {
          if (data && Array.isArray(data.peers)) {
            data.peers.forEach(function (remotePid) {
              if (inScreen && screenStream) callPeerWithScreen(remotePid);
              if (inWebcam && webcamStream) callPeerWithWebcam(remotePid);
            });
          }
        });
    }
  }

  function openCreateServerModal() {
    if (!myVerified) return openAuthModal(true);
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

  function openCreateChannelModal(type) {
    if (!myVerified) return openAuthModal(true);
    pendingChannelType = type === 'voice' ? 'voice' : 'text';
    document.getElementById('create-ch-title').textContent = pendingChannelType === 'voice' ? 'Создать голосовой канал' : 'Создать текстовый канал';
    document.getElementById('create-ch-sub').textContent = pendingChannelType === 'voice' ? 'Участники смогут созваниваться, включать камеру и стрим экрана:' : 'Участники смогут переписываться в этом канале:';
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
      alert('Ссылка-приглашение скопирована! Отправьте её другу.');
    } catch (e) {
      prompt('Скопируйте ссылку вручную:', url);
    }
  }

  // ---------- Авторизация через Telegram (однократная) ----------
  async function initTelegramSession() {
    try {
      const res = await fetch('/api/tg-init');
      const data = await res.json();
      tgSessionToken = data.token || '';
      tgBotUsername = data.botUsername || '';
      const btn = document.getElementById('tg-open-bot-btn');
      const hint = document.getElementById('tg-status-hint');
      if (tgBotUsername) {
        btn.innerHTML = '<span>✈️ Открыть @' + escapeHtml(tgBotUsername) + ' и войти</span>';
      } else {
        hint.innerHTML = 'ℹ️ Если токен бота ещё не задан, войдите во вкладке «Быстрый вход» — сессия сохранится навсегда.';
      }
    } catch (e) {}
  }

  function startTgPolling() {
    if (tgPollTimer) clearInterval(tgPollTimer);
    tgPollTimer = setInterval(async function () {
      if (!tgSessionToken || myVerified) return;
      try {
        const customNick = document.getElementById('nick-inp').value.trim().slice(0, 24);
        const res = await fetch('/api/tg-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: clientId,
            uid: myUid,
            room: currentRoom,
            token: tgSessionToken,
            nick: customNick
          })
        });
        const data = await res.json();
        if (data && data.ok && data.verified) {
          clearInterval(tgPollTimer);
          tgPollTimer = null;
          completeClientAuth(data);
        }
      } catch (e) {}
    }, 2000);
  }

  function openTelegramBot() {
    if (!tgBotUsername) {
      switchAuthTab('pass');
      return;
    }
    const url = 'https://t.me/' + encodeURIComponent(tgBotUsername) + '?start=auth_' + encodeURIComponent(tgSessionToken);
    window.open(url, '_blank');
    startTgPolling();
  }

  async function verifyTelegramCode() {
    const code = document.getElementById('tg-code-inp').value.trim();
    const customNick = document.getElementById('nick-inp').value.trim().slice(0, 24);
    if (!code) return alert('Введите 4-значный код из Telegram-бота!');
    try {
      const res = await fetch('/api/tg-verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: clientId,
          uid: myUid,
          room: currentRoom,
          code: code,
          nick: customNick
        })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      completeClientAuth(data);
    } catch (e) {
      alert('Ошибка соединения с сервером.');
    }
  }

  function completeClientAuth(data) {
    if (data.uid && data.uid !== myUid) {
      myUid = data.uid;
    }
    if (data.nick) myNick = data.nick;
    myVerified = true;
    authLocked = false;
    try {
      localStorage.setItem('cyber_uid', myUid);
      localStorage.setItem('cyber_nick', myNick);
      localStorage.setItem('cyber_verified', '1');
    } catch (e) {}
    setPersistCookie('cyber_uid', myUid);
    setPersistCookie('cyber_nick', myNick);
    setPersistCookie('cyber_verified', '1');

    applyNickUI();
    closeAuthModal();
    connectEventStream();
  }

  function openAuthModal(lock) {
    authLocked = !!lock || !myVerified;
    document.getElementById('auth-close-btn').style.display = authLocked ? 'none' : 'block';
    const nickField = document.getElementById('nick-inp');
    if (myNick && !myNick.startsWith('Гость_')) nickField.value = myNick;
    document.getElementById('auth-modal').classList.add('open');
    initTelegramSession().then(function () {
      startTgPolling();
    });
  }

  function closeAuthModal() {
    if (authLocked && !myVerified) return;
    if (tgPollTimer) {
      clearInterval(tgPollTimer);
      tgPollTimer = null;
    }
    document.getElementById('auth-modal').classList.remove('open');
  }

  async function loginWithPassword() {
    const nick = document.getElementById('nick-inp').value.trim().slice(0, 24);
    const password = document.getElementById('pass-inp').value;
    if (!nick) return alert('Введите ваш позывной!');
    if (!password && !myVerified) return alert('Введите пароль (минимум 4 символа)!');

    try {
      const res = await fetch('/api/auth-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: clientId,
          uid: myUid,
          room: currentRoom,
          nick: nick,
          password: password
        })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      completeClientAuth(data);
    } catch (e) {
      alert('Ошибка соединения с сервером.');
    }
  }

  // ---------- Голосовой канал, Веб-камера и Трансляция экрана ----------
  function postVoiceState(state) {
    return fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ id: clientId }, state))
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
  }

  function createProcessedAudioStream(rawStream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(rawStream);
      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = (appSettings.micVolume || 100) / 100;
      const dst = audioCtx.createMediaStreamDestination();
      src.connect(micGainNode);
      micGainNode.connect(dst);
      return dst.stream;
    } catch (e) {
      return rawStream;
    }
  }

  function createSilentAudioStream() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dst = ctx.createMediaStreamDestination();