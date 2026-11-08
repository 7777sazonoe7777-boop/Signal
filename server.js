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
const MAX_BODY = 2 * 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBotUsername = '';
let tgUpdateOffset = 0;

const serversMeta = Object.create(null);
const rooms = Object.create(null);
const tgCodes = Object.create(null);
const pendingTgTokens = Object.create(null);
let clients = [];

const users = Object.create(null);
const pidToUid = Object.create(null);
const tgIdToUid = Object.create(null);
const nickToUid = Object.create(null);
const members = Object.create(null);
const MAX_MEMBERS = 500;
const MAX_FRIENDS = 200;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// Словари для распознавания сексуального (18+) и шокирующего/насильственного контента
const SEXUAL_PATTERNS = [
  /порн/i, /секс/i, /эротик/i, /интим/i, /хентай/i, /минет/i, /трах/i, /шлюх/i,
  /проститут/i, /сиськ/i, /вагин/i, /член/i, /голая/i, /голые/i, /обнажен/i,
  /porn/i, /nsfw/i, /xxx/i, /hentai/i, /onlyfans/i, /xvideos/i, /pornhub/i,
  /redtube/i, /brazzers/i, /rule34/i, /nude/i, /boobs/i, /pussy/i, /dick/i
];

const GORE_PATTERNS = [
  /расчлен/i, /кишки/i, /труп/i, /казнь/i, /пытк/i, /убийств/i, /самоубийств/i,
  /суицид/i, /резня/i, /кровопролит/i, /увечь/i, /жесть/i, /насили/i, /террор/i,
  /gore/i, /liveleak/i, /bestgore/i, /behead/i, /torture/i, /suicide/i, /deadbody/i, /murder/i
];

function detectContentFlags(text) {
  const s = String(text || '');
  const sexual = SEXUAL_PATTERNS.some(rx => rx.test(s));
  const gore = GORE_PATTERNS.some(rx => rx.test(s));
  return { sexual, gore };
}

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
  return Array.isArray(a) ? Array.from(new Set(a.filter(validPid))).slice(0, MAX_FRIENDS) : [];
}
function roomList(a) {
  return Array.isArray(a) ? Array.from(new Set(a.filter(r => safeRoom(r) === r))).slice(0, MAX_SERVERS) : [];
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
      text: 'Добро пожаловать в «Ночной клуб»! Все друзья, серверы и каналы защищены от сброса при обновлениях, а системный оверлей звонка работает поверх всех окон даже при свёрнутом браузере.'
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

// ---------- Хранилище: Upstash Redis + локальный data.json + Клиентское Авто-Восстановление ----------
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
      pid: u.pid || pidOf(uid),
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
      friends: u.friends || [],
      incoming: u.incoming || [],
      outgoing: u.outgoing || [],
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
  }, USE_REDIS ? 600 : 400);
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
  if (!d || typeof d !== 'object') return;
  if (d.servers && typeof d.servers === 'object') {
    Object.keys(d.servers).forEach(r => {
      if (safeRoom(r) !== r) return;
      const sm = d.servers[r] || {};
      const meta = ensureServer(r, sm.name, sm.desc, sm.icon);
      if (Array.isArray(sm.textChannels)) {
        const tc = sm.textChannels.map(cleanChannelName).filter(Boolean);
        tc.forEach(c => {
          if (!meta.textChannels.includes(c) && meta.textChannels.length < MAX_CHANNELS) {
            meta.textChannels.push(c);
          }
        });
      }
      if (Array.isArray(sm.voiceChannels)) {
        const vc = sm.voiceChannels.map(v => String(v || '').trim().slice(0, 28)).filter(Boolean);
        vc.forEach(c => {
          if (!meta.voiceChannels.includes(c) && meta.voiceChannels.length < MAX_CHANNELS) {
            meta.voiceChannels.push(c);
          }
        });
      }
      meta.textChannels.forEach(ch => {
        if (!rooms[r][ch]) rooms[r][ch] = [];
      });
    });
  }
  Object.keys(d.users || {}).forEach(uid => {
    if (!validUid(uid)) return;
    const u = d.users[uid] || {};
    const existing = users[uid];
    const tgId = String(u.tgId || (existing && existing.tgId) || '').trim();
    const tgUsername = String(u.tgUsername || (existing && existing.tgUsername) || '').trim();
    const nick = cleanNick(u.nick || (existing && existing.nick));
    const passHash = String(u.passHash || (existing && existing.passHash) || '');
    const verified = u.verified !== undefined ? !!u.verified : true;
    const customPid = validPid(u.pid) ? u.pid : (existing && existing.pid ? existing.pid : pidOf(uid));

    users[uid] = {
      pid: customPid,
      nick: nick,
      tgId: tgId,
      tgUsername: tgUsername,
      passHash: passHash,
      verified: verified,
      bio: cleanText(u.bio !== undefined ? u.bio : (existing && existing.bio), 220),
      interests: cleanText(u.interests !== undefined ? u.interests : (existing && existing.interests), 160),
      customStatus: cleanText(u.customStatus !== undefined ? u.customStatus : (existing && existing.customStatus), 60),
      presence: cleanPresence(u.presence || (existing && existing.presence)),
      bannerColor: cleanColor(u.bannerColor || (existing && existing.bannerColor), '#0d9488'),
      avatarColor: cleanColor(u.avatarColor || (existing && existing.avatarColor), '#e11d48'),
      friends: pidList([].concat((existing && existing.friends) || [], u.friends || [])),
      incoming: pidList([].concat((existing && existing.incoming) || [], u.incoming || [])),
      outgoing: pidList([].concat((existing && existing.outgoing) || [], u.outgoing || [])),
      servers: roomList([].concat((existing && existing.servers) || [], u.servers || []))
    };
    pidToUid[users[uid].pid] = uid;
    if (tgId) tgIdToUid[tgId] = uid;
    if (verified && nick) nickToUid[nick.toLowerCase()] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    ensureServer(r);
    const cur = members[r] || (members[r] = []);
    d.members[r].filter(validUid).forEach(uid => {
      if (!cur.includes(uid) && cur.length < MAX_MEMBERS) cur.push(uid);
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
      const existingList = room[cleanCh] || [];
      const seenKeys = new Set(existingList.map(m => (m.author + '|' + m.time + '|' + m.text)));
      list.slice(-MAX_HISTORY).forEach(m => {
        const cleanM = {
          author: String(m.author || '').slice(0, 24),
          time: String(m.time || '').slice(0, 5),
          text: String(m.text || '').slice(0, 1000)
        };
        cleanM.flags = detectContentFlags(cleanM.text);
        const k = cleanM.author + '|' + cleanM.time + '|' + cleanM.text;
        if (!seenKeys.has(k) && cleanM.text) {
          seenKeys.add(k);
          existingList.push(cleanM);
        }
      });
      room[cleanCh] = existingList.slice(-MAX_HISTORY);
    });
  });
}

async function loadData() {
  if (USE_REDIS) {
    // Загружаем данные как из основного префикса signal:, так и из резервного signal:v3:, чтобы ничего не терялось
    const first = await redis([
      ['GET', KEY + 'users'],
      ['GET', KEY + 'members'],
      ['GET', KEY + 'rooms'],
      ['GET', KEY + 'servers'],
      ['GET', 'signal:v3:users'],
      ['GET', 'signal:v3:members'],
      ['GET', 'signal:v3:servers']
    ]);
    if (first[4] || first[5] || first[6]) {
      applyData({
        users: first[4] ? JSON.parse(first[4]) : {},
        members: first[5] ? JSON.parse(first[5]) : {},
        servers: first[6] ? JSON.parse(first[6]) : {}
      });
    }
    const roomNames = Array.from(new Set(
      [].concat(
        first[2] ? JSON.parse(first[2]) : [],
        first[3] ? Object.keys(JSON.parse(first[3])) : []
      )
    )).filter(n => safeRoom(n) === n);
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

// Синхронизация резервной копии из браузера пользователя (чтобы после замены server.js на Render друзья и серверы мгновенно восстанавливались)
function restoreClientVault(v) {
  if (!v || typeof v !== 'object') return false;
  let updated = false;

  // 1. Восстанавливаем известные профили друзей и участников (по их pid/uid)
  if (Array.isArray(v.knownUsers)) {
    v.knownUsers.forEach(ku => {
      if (!ku || !validPid(ku.pid)) return;
      let targetUid = pidToUid[ku.pid];
      if (!targetUid) {
        targetUid = validUid(ku.uid) ? ku.uid : crypto.createHash('sha256').update(' ghost-pid:' + ku.pid).digest('hex').slice(0, 32);
      }
      if (!users[targetUid]) {
        users[targetUid] = {
          pid: ku.pid,
          nick: cleanNick(ku.nick),
          tgId: '',
          tgUsername: '',
          passHash: '',
          verified: true,
          bio: cleanText(ku.bio, 220),
          interests: cleanText(ku.interests, 160),
          customStatus: cleanText(ku.customStatus, 60),
          presence: cleanPresence(ku.presence),
          bannerColor: cleanColor(ku.bannerColor, '#0d9488'),
          avatarColor: cleanColor(ku.avatarColor, '#e11d48'),
          friends: [],
          incoming: [],
          outgoing: [],
          servers: []
        };
        pidToUid[ku.pid] = targetUid;
        updated = true;
      }
    });
  }

  // 2. Восстанавливаем владельца хранилища и все его связи с друзьями
  if (validUid(v.uid)) {
    const me = ensureUser(v.uid, v.nick || 'Участник', true);
    if (v.profile && typeof v.profile === 'object') {
      if (v.profile.bio) me.bio = cleanText(v.profile.bio, 220);
      if (v.profile.interests) me.interests = cleanText(v.profile.interests, 160);
      if (v.profile.customStatus) me.customStatus = cleanText(v.profile.customStatus, 60);
      if (v.profile.presence) me.presence = cleanPresence(v.profile.presence);
      if (v.profile.bannerColor) me.bannerColor = cleanColor(v.profile.bannerColor, '#0d9488');
      if (v.profile.avatarColor) me.avatarColor = cleanColor(v.profile.avatarColor, '#e11d48');
    }
    if (Array.isArray(v.friends)) {
      v.friends.forEach(fPid => {
        if (!validPid(fPid)) return;
        if (!me.friends.includes(fPid) && me.friends.length < MAX_FRIENDS) {
          me.friends.push(fPid);
          updated = true;
        }
        const fUid = pidToUid[fPid];
        if (fUid && users[fUid] && !users[fUid].friends.includes(me.pid)) {
          users[fUid].friends.push(me.pid);
        }
      });
    }
    if (Array.isArray(v.incoming)) {
      v.incoming.forEach(iPid => {
        if (validPid(iPid) && !me.friends.includes(iPid) && !me.incoming.includes(iPid)) {
          me.incoming.push(iPid);
          updated = true;
        }
      });
    }
    if (Array.isArray(v.outgoing)) {
      v.outgoing.forEach(oPid => {
        if (validPid(oPid) && !me.friends.includes(oPid) && !me.outgoing.includes(oPid)) {
          me.outgoing.push(oPid);
          updated = true;
        }
      });
    }
  }

  // 3. Восстанавливаем созданные серверы, каналы и историю сообщений
  if (Array.isArray(v.servers)) {
    const serversObj = {};
    v.servers.forEach(s => {
      if (s && s.id && safeRoom(s.id) === s.id) {
        serversObj[s.id] = s;
      }
    });
    applyData({ servers: serversObj });
    updated = true;
  }

  if (v.room && safeRoom(v.room) === v.room && Array.isArray(v.roomMembersPids)) {
    v.roomMembersPids.forEach(p => {
      const uId = pidToUid[p];
      if (uId) addMember(v.room, uId);
    });
  }

  if (v.messages && typeof v.messages === 'object') {
    applyData({ messages: v.messages });
    Object.keys(v.messages).forEach(r => {
      if (safeRoom(r) === r) dirtyRooms.add(r);
    });
    updated = true;
  }

  if (updated) scheduleSave();
  return updated;
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
    if (!tu || !users[tu]) return { pid, nick: 'Друг (' + pid.slice(0, 4) + ')', online: false, presence: 'offline' };
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

// String.raw гарантирует, что ни один обратный слэш (\) внутри HTML/JS не будет повреждён Node.js
const HTML_PAGE = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background-color: var(--bg-darkest); color: var(--text-main);
    height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; user-select: none;
  }

  .top-header { height: 38px; background: #030508; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 16px; gap: 12px; font-size: 12px; flex-shrink: 0; }
  .top-logo { display: flex; align-items: center; gap: 6px; font-weight: 800; color: #fff; background: #e11d48; padding: 3px 8px; border-radius: 4px; font-size: 11px; flex-shrink: 0; }
  .top-logo b { color: #fff; font-size: 10px; opacity: 0.85; }
  .top-sub { color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top-right-group { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .btn-top-settings { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-main); padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: 0.15s; }
  .btn-top-settings:hover { border-color: var(--cyan-bright); color: var(--cyan-bright); background: rgba(45,212,191,0.08); }
  .btn-top-invite { background: #9d174d; border: 1px solid #f43f5e; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-top-invite:hover { background: #be185d; }

  .workspace { flex: 1; display: grid; grid-template-columns: 68px 250px 1fr 260px; overflow: hidden; position: relative; min-height: 0; }

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
  .cat-add-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--cyan-bright); width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; cursor: pointer; line-height: 1; }
  .cat-add-btn:hover { background: rgba(45, 212, 191, 0.2); color: #fff; border-color: var(--cyan-bright); }

  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 8px 9px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }
  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }
  .ch-btn.active .ch-dot { display: block; }
  .ch-unread-badge { background: #e11d48; color: #fff; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 999px; margin-left: 6px; }

  .voice-ch-box { display: flex; align-items: center; justify-content: space-between; padding: 8px 9px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .voice-ch-box:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .voice-ch-box.active { background: rgba(20, 184, 166, 0.12); color: #4ade80; font-weight: 600; }
  .off-badge { font-size: 9px; background: rgba(255,255,255,0.05); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .off-badge.on { background: #064e3b; color: #34d399; }

  .user-bar { padding: 8px 10px; background: #030508; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .user-info { display: flex; align-items: center; gap: 8px; overflow: hidden; cursor: pointer; padding: 3px 5px; border-radius: 6px; flex: 1; min-width: 0; }
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
  .btn-login-mini { background: rgba(20, 184, 166, 0.08); border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 5px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; flex-shrink: 0; transition: 0.15s; white-space: nowrap; }
  .btn-login-mini:hover { border-color: var(--cyan-bright); background: rgba(45,212,191,0.18); color: #fff; }

  .main-chat { background: var(--bg-main); display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; }
  .chat-topbar { height: 48px; padding: 0 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
  .chat-topbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .chat-topbar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .hash-large { color: var(--cyan-bright); font-size: 18px; font-weight: 800; flex-shrink: 0; }
  .top-ch-name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top-ch-desc { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-top-right-share { background: #0d9488; color: #fff; border: none; padding: 6px 11px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap; }

  .mob-top-btn {
    display: none; background: rgba(255,255,255,0.05); border: 1px solid var(--border);
    color: var(--text-main); width: 34px; height: 34px; border-radius: 8px;
    align-items: center; justify-content: center; font-size: 15px; cursor: pointer; flex-shrink: 0;
  }
  .mob-top-btn:active { background: rgba(45,212,191,0.18); border-color: var(--cyan-bright); }
  .mob-drawer-backdrop {
    display: none; position: fixed; inset: 0; background: rgba(2, 5, 10, 0.72);
    backdrop-filter: blur(3px); z-index: 940;
  }
  .mob-bottom-nav {
    display: none; height: 54px; background: #04070c; border-top: 1px solid var(--border);
    grid-template-columns: repeat(5, 1fr); align-items: center; flex-shrink: 0; z-index: 960;
  }
  .mob-nav-item {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; height: 100%; color: var(--text-dim); font-size: 9.5px; font-weight: 700; cursor: pointer;
  }
  .mob-nav-item span.ico { font-size: 15px; line-height: 1; }
  .mob-nav-item.active { color: var(--cyan-bright); background: rgba(45,212,191,0.07); }

  .chat-scroll-area { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .hero-banner { background: linear-gradient(135deg, #0f1726 0%, #080e17 100%); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .hero-banner-left { max-width: 440px; min-width: 0; }
  .hash-badge { width: 30px; height: 30px; border-radius: 8px; background: rgba(45, 212, 191, 0.12); border: 1px solid var(--cyan-border); color: var(--cyan-bright); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; margin-bottom: 8px; }
  .welcome-tag { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; margin-bottom: 4px; }
  .hero-banner h2 { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
  .hero-banner p { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; line-height: 1.4; }
  .pill-tags-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill-tag { padding: 4px 9px; border-radius: 999px; font-size: 9px; font-weight: 700; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: #cbd5e1; cursor: pointer; }
  .pill-tag.pink { background: rgba(219,39,119,0.15); border-color: rgba(219,39,119,0.4); color: #f43f5e; }
  .radar-box { width: 110px; height: 110px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }

  .messages-container { display: flex; flex-direction: column; gap: 8px; }
  .msg-item { display: flex; gap: 10px; background: rgba(255,255,255,0.015); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); }
  body.compact-chat .msg-item { padding: 4px 8px; align-items: center; }
  body.compact-chat .msg-ava { width: 20px; height: 20px; font-size: 9px; }
  .msg-ava { width: 28px; height: 28px; border-radius: 6px; background: var(--cyan); color: #042f2e; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .msg-author { font-size: 12px; font-weight: 700; color: #fff; margin-right: 6px; }
  .msg-time { font-size: 9px; color: var(--text-muted); }
  .msg-text { font-size: var(--chat-font-size); color: #e2e8f0; margin-top: 2px; user-select: text; word-break: break-word; }

  .filtered-block-card {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(225, 29, 72, 0.1); border: 1px dashed rgba(244, 63, 94, 0.45);
    color: #fda4af; padding: 6px 10px; border-radius: 7px; font-size: 11px; font-weight: 600; margin-top: 4px;
  }
  .spoiler-blur-wrap {
    position: relative; display: inline-block; width: 100%; background: rgba(15, 23, 34, 0.9);
    border: 1px solid rgba(244, 63, 94, 0.4); border-radius: 8px; padding: 8px 10px; margin-top: 4px; cursor: pointer;
  }
  .spoiler-blur-content { filter: blur(8px); user-select: none; pointer-events: none; transition: 0.2s; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter: none; user-select: text; pointer-events: auto; }
  .spoiler-badge {
    display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700;
    color: #fda4af; background: rgba(225, 29, 72, 0.2); padding: 3px 8px; border-radius: 5px; margin-bottom: 4px;
  }
  .spoiler-blur-wrap.revealed .spoiler-badge { display: none; }
  .chat-inline-media { max-width: 100%; width: auto; max-height: 220px; border-radius: 8px; border: 1px solid var(--border); margin-top: 6px; display: block; object-fit: contain; background: #000; }

  .voice-panel { background: rgba(13, 148, 136, 0.06); border: 1px solid var(--cyan-border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
  .voice-panel-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .voice-label { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; }
  .voice-title { font-size: 12px; font-weight: 700; margin: 2px 0; }
  .voice-sub { font-size: 10px; color: var(--text-dim); }
  .voice-active-area { display: none; flex-direction: column; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
  .voice-active-area.show { display: flex; }
  .voice-user-card { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); width: fit-content; }
  .vu-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }

  /* ---------- ПЛАВАЮЩИЙ МИНИ-ОВЕРЛЕЙ ЗВОНКА (ВНУТРИ ВКЛАДКИ И ПОВЕРХ ОКОН) ---------- */
  .floating-call-overlay {
    position: fixed; right: 18px; bottom: 72px; width: 300px;
    background: rgba(8, 13, 20, 0.96); border: 1px solid var(--cyan-border);
    border-radius: 12px; padding: 10px 12px; z-index: 980;
    box-shadow: 0 14px 40px rgba(0,0,0,0.85), 0 0 16px rgba(45,212,191,0.18);
    display: none; flex-direction: column; gap: 8px; backdrop-filter: blur(8px);
  }
  .floating-call-overlay.show { display: flex; }
  .fco-head { display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .fco-live { display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 800; color: var(--cyan-bright); text-transform: uppercase; }
  .fco-pulse { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .fco-timer { font-size: 10px; font-family: monospace; color: #cbd5e1; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  .fco-peers { display: flex; flex-wrap: wrap; gap: 5px; max-height: 74px; overflow-y: auto; }
  .fco-peer-chip { display: inline-flex; align-items: center; gap: 5px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); padding: 3px 7px; border-radius: 999px; font-size: 10px; color: #f1f5f9; }
  .fco-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
  .fco-btn { background: #131c28; border: 1px solid var(--border); color: #fff; padding: 6px 4px; border-radius: 6px; font-size: 10px; font-weight: 700; cursor: pointer; text-align: center; transition: 0.15s; }
  .fco-btn:hover { border-color: var(--cyan-bright); color: var(--cyan-bright); }
  .fco-btn.danger { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.5); color: #fca5a5; }
  .fco-btn.active-pip { background: rgba(20,184,166,0.22); border-color: var(--cyan-bright); color: var(--cyan-bright); }

  .screen-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; width: 100%; }
  .screen-grid:empty { display: none; }
  .screen-card { background: #05080d; border: 1px solid var(--cyan-border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .screen-card-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(15, 23, 34, 0.95); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--cyan-bright); gap: 6px; flex-wrap: wrap; }
  .screen-live-pill { background: #e11d48; color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .screen-live-pill.cam { background: #0d9488; }
  .screen-video-wrap { position: relative; width: 100%; background: #000; display: flex; align-items: center; justify-content: center; min-height: 160px; max-height: 380px; }
  .screen-video-wrap video { width: 100%; max-height: 380px; object-fit: contain; background: #000; display: block; }
  .btn-fs { background: rgba(255,255,255,0.08); border: 1px solid var(--border); color: #fff; padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 600; cursor: pointer; }
  .btn-fs:hover { border-color: var(--cyan-bright); color: var(--cyan-bright); }

  .chat-bottom { padding: 8px 18px 12px; border-top: 1px solid var(--border); background: #070b12; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
  .input-row { display: flex; gap: 8px; align-items: center; }
  .chat-inp { flex: 1; min-width: 0; background: var(--bg-input); border: 1px solid var(--border); padding: 9px 12px; border-radius: 6px; color: #fff; font-size: 13px; outline: none; }
  .chat-inp:focus { border-color: var(--cyan-bright); }
  .bottom-hint { font-size: 9px; color: var(--text-muted); }

  .right-panel { background: var(--bg-sidebar); border-left: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  .right-sec-title { font-size: 9px; text-transform: uppercase; color: var(--cyan-bright); font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
  .online-user-item { display: flex; align-items: center; gap: 7px; font-size: 11px; padding: 6px 7px; background: rgba(255,255,255,0.02); border-radius: 7px; border: 1px solid transparent; cursor: pointer; transition: 0.15s; min-width: 0; }
  .online-user-item:hover { background: rgba(255,255,255,0.05); border-color: var(--border); }
  .online-user-item.is-online { border-color: rgba(34, 197, 94, 0.14); }
  .online-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; flex-shrink: 0; }
  .online-dot.idle { background: #eab308; box-shadow: 0 0 6px #eab308; }
  .online-dot.dnd { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
  .online-dot.off, .online-dot.offline { background: #475569; box-shadow: none; }
  .member-text-col { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
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

  .btn-cyan { background: var(--cyan-bright); color: #042f2e; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; transition: 0.15s; white-space: nowrap; }
  .btn-cyan:hover { filter: brightness(1.08); box-shadow: 0 0 12px rgba(45,212,191,0.35); }
  .btn-danger { background: rgba(239, 68, 68, 0.16); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.45); padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; transition: 0.15s; white-space: nowrap; }
  .btn-danger:hover { background: #ef4444; color: #fff; }
  .btn-mute { background: #131c28; color: #e2e8f0; border: 1px solid var(--border); padding: 7px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: 0.15s; }
  .btn-mute:hover { border-color: var(--cyan-bright); color: #fff; }
  .btn-mute.active-screen { background: rgba(219, 39, 119, 0.22); border-color: #f43f5e; color: #fda4af; }
  .btn-mute.active-cam { background: rgba(20, 184, 166, 0.22); border-color: var(--cyan-bright); color: var(--cyan-bright); }
  .btn-pink-card { background: #9d174d; color: #fff; border: none; width: 100%; padding: 7px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-tg { background: #229ED9; color: #fff; border: none; width: 100%; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; margin-bottom: 10px; }
  .btn-tg:hover { background: #1d8ec4; box-shadow: 0 0 14px rgba(34, 158, 217, 0.45); }

  .modal-backdrop { position: fixed; inset: 0; background: rgba(2, 4, 8, 0.86); backdrop-filter: blur(5px); display: none; align-items: center; justify-content: center; z-index: 999; padding: 12px; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background: var(--bg-card); border: 1px solid var(--cyan-border); border-radius: 12px; padding: 22px; width: 390px; max-width: 100%; box-shadow: 0 20px 50px rgba(0,0,0,0.8); overflow: hidden; }
  .modal-box input[type="text"], .modal-box input[type="password"], .modal-box textarea, .modal-box select {
    width: 100%; max-width: 100%; padding: 8px 11px; background: #04060a; border: 1px solid var(--border);
    border-radius: 6px; color: #fff; margin-bottom: 10px; font-size: 12px; outline: none; user-select: text; font-family: inherit;
  }
  .modal-box input:focus, .modal-box textarea:focus, .modal-box select:focus { border-color: var(--cyan-bright); }
  .link-box { background: #030508; border: 1px dashed var(--cyan-bright); padding: 8px; color: var(--cyan-bright); font-size: 11px; word-break: break-all; margin-bottom: 10px; border-radius: 6px; display: block; text-decoration: none; text-align: center; user-select: text; }
  .auth-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 12px; background: #06090f; padding: 4px; border-radius: 8px; border: 1px solid var(--border); }
  .auth-tab { padding: 6px 8px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 6px; cursor: pointer; color: var(--text-dim); }
  .auth-tab.active { background: rgba(34, 158, 217, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }

  /* Панель Настроек в едином кибер-стиле */
  .settings-modal-box {
    background: #0b1119; border: 1px solid var(--cyan-border); border-radius: 14px;
    width: 820px; max-width: 100%; height: 590px; max-height: 92vh;
    display: grid; grid-template-columns: 215px minmax(0, 1fr);
    overflow: hidden; box-shadow: 0 25px 70px rgba(0,0,0,0.9);
  }
  .settings-nav {
    background: #060a0f; border-right: 1px solid var(--border);
    padding: 14px 10px; display: flex; flex-direction: column; gap: 4px;
    overflow-y: auto; overflow-x: hidden; min-width: 0;
  }
  .settings-nav-label { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--text-muted); padding: 6px 8px 3px; letter-spacing: 0.7px; }
  .settings-nav-btn {
    padding: 8px 10px; border-radius: 7px; font-size: 11.5px; font-weight: 600;
    color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 8px;
    transition: 0.15s; border: 1px solid transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .settings-nav-btn:hover { background: rgba(255,255,255,0.04); color: #fff; }
  .settings-nav-btn.active { background: rgba(45, 212, 191, 0.13); color: var(--cyan-bright); border-color: var(--cyan-border); }
  .settings-content {
    padding: 18px 22px; overflow-y: auto; overflow-x: hidden;
    display: flex; flex-direction: column; gap: 14px; min-width: 0; max-width: 100%;
  }
  .settings-pane { display: none; flex-direction: column; gap: 12px; min-width: 0; max-width: 100%; }
  .settings-pane.active { display: flex; }
  .settings-head {
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    border-bottom: 1px solid var(--border); padding-bottom: 10px; flex-wrap: wrap; min-width: 0;
  }
  .settings-head h3 { font-size: 15px; font-weight: 800; color: #fff; letter-spacing: 0.3px; }
  .field-label { font-size: 9.5px; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-bottom: 5px; display: block; letter-spacing: 0.5px; }
  .settings-card {
    background: #070b11; border: 1px solid var(--border); border-radius: 10px;
    padding: 13px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; max-width: 100%; overflow: hidden;
  }
  .settings-grid-2 {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; width: 100%; min-width: 0;
  }
  .settings-grid-2 > div { min-width: 0; max-width: 100%; }

  .settings-card input[type="text"],
  .settings-card input[type="password"],
  .settings-card textarea,
  .settings-card select {
    width: 100%; max-width: 100%; min-width: 0; padding: 8px 10px;
    background: #04060a; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-main); font-size: 11.5px; outline: none; font-family: inherit;
    margin: 0; transition: 0.15s; text-overflow: ellipsis;
  }
  .settings-card textarea { resize: vertical; min-height: 54px; max-height: 110px; }
  .settings-card input:focus, .settings-card textarea:focus, .settings-card select:focus {
    border-color: var(--cyan-bright); box-shadow: 0 0 8px rgba(45,212,191,0.18);
  }

  .toggle-row {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.04); min-width: 0;
  }
  .toggle-row:last-child { border-bottom: none; padding-bottom: 2px; }
  .toggle-text-col { flex: 1; min-width: 0; }
  .toggle-title { font-size: 12px; font-weight: 600; color: #f1f5f9; line-height: 1.3; }
  .toggle-sub { font-size: 10px; color: var(--text-muted); margin-top: 2px; line-height: 1.35; }

  .cyber-switch { position: relative; display: inline-block; width: 38px; height: 20px; flex-shrink: 0; cursor: pointer; }
  .cyber-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .cyber-slider {
    position: absolute; inset: 0; background: #131c28; border: 1px solid var(--border);
    border-radius: 999px; transition: 0.2s;
  }
  .cyber-slider::before {
    content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px;
    background: #64748b; border-radius: 50%; transition: 0.2s;
  }
  .cyber-switch input:checked + .cyber-slider {
    background: rgba(20, 184, 166, 0.25); border-color: var(--cyan-bright);
    box-shadow: 0 0 10px rgba(45, 212, 191, 0.25);
  }
  .cyber-switch input:checked + .cyber-slider::before {
    transform: translateX(18px); background: var(--cyan-bright);
  }

  .cyber-range {
    -webkit-appearance: none; appearance: none; width: 100%; height: 6px;
    background: #04060a; border: 1px solid var(--border); border-radius: 999px; outline: none; margin-top: 4px;
  }
  .cyber-range::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 14px; height: 14px;
    border-radius: 50%; background: var(--cyan-bright); cursor: pointer; box-shadow: 0 0 8px var(--cyan-bright);
  }

  .theme-pills-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 4px; }
  .theme-pill-btn {
    background: #04060a; border: 1px solid var(--border); color: var(--text-main);
    padding: 8px 10px; border-radius: 7px; font-size: 11px; font-weight: 700; cursor: pointer;
    display: flex; align-items: center; gap: 8px; transition: 0.15s; min-width: 0;
  }
  .theme-pill-btn:hover { border-color: var(--cyan-bright); background: rgba(45,212,191,0.08); }
  .theme-dot-swatch { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }

  .color-swatches { display: flex; gap: 7px; flex-wrap: wrap; }
  .color-swatch { width: 24px; height: 24px; border-radius: 6px; cursor: pointer; border: 2px solid rgba(255,255,255,0.15); transition: 0.15s; }
  .color-swatch:hover, .color-swatch.active { border-color: #fff; transform: scale(1.08); }
  .mic-meter-wrap { width: 100%; height: 10px; background: #04060a; border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
  .mic-meter-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #22c55e, #2dd4bf, #ec4899); transition: width 0.06s linear; }

  .discord-profile-card { background: #070b11; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; min-width: 0; max-width: 100%; }
  .dp-banner { height: 64px; background: #0d9488; position: relative; }
  .dp-body { padding: 30px 14px 14px; position: relative; min-width: 0; }
  .dp-ava { width: 52px; height: 52px; border-radius: 12px; background: #e11d48; border: 4px solid #070b11; position: absolute; top: -26px; left: 14px; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; color: #fff; }
  .dp-nick { font-size: 15px; font-weight: 800; color: #fff; word-break: break-word; }
  .dp-status { font-size: 11px; color: var(--cyan-bright); margin-top: 2px; word-break: break-word; }
  .dp-sec { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
  .dp-sec-title { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; letter-spacing: 0.6px; }
  .dp-bio { font-size: 11.5px; color: #cbd5e1; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .dp-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
  .dp-tag { background: rgba(45, 212, 191, 0.12); border: 1px solid var(--cyan-border); color: var(--cyan-bright); padding: 2px 8px; border-radius: 999px; font-size: 9.5px; font-weight: 700; }

  /* ---------- МОБИЛЬНАЯ ВЕРСИЯ В СТИЛЕ DISCORD (<= 900px) ---------- */
  @media (max-width: 900px) {
    .top-header { padding: 0 10px; height: 36px; }
    .top-sub { display: none; }
    .top-right-group .btn-top-settings { display: none; }

    .workspace { display: flex; flex-direction: column; flex: 1; width: 100%; }
    .main-chat { flex: 1; width: 100%; height: 100%; }

    .mob-top-btn { display: inline-flex; }
    .mob-bottom-nav { display: grid; }

    .servers-rail {
      position: fixed; top: 0; bottom: 54px; left: 0; width: 64px; z-index: 955;
      transform: translateX(-360px); transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: none;
    }
    .channels-panel {
      position: fixed; top: 0; bottom: 54px; left: 64px; width: calc(100vw - 64px); max-width: 270px; z-index: 955;
      transform: translateX(-360px); transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 12px 0 35px rgba(0,0,0,0.85);
    }
    body.mob-left-open .servers-rail,
    body.mob-left-open .channels-panel {
      transform: translateX(0);
    }

    .right-panel {
      position: fixed; top: 0; bottom: 54px; right: 0; width: min(86vw, 300px); z-index: 955;
      transform: translateX(105%); transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: -12px 0 35px rgba(0,0,0,0.85);
    }
    body.mob-right-open .right-panel {
      transform: translateX(0);
    }

    body.mob-left-open .mob-drawer-backdrop,
    body.mob-right-open .mob-drawer-backdrop {
      display: block;
    }

    .chat-topbar { height: 46px; padding: 0 10px; }
    .top-ch-desc { display: none; }
    .btn-top-right-share { padding: 6px 9px; font-size: 10px; }

    .chat-scroll-area { padding: 10px 12px; gap: 10px; }
    .hero-banner { padding: 12px 14px; }
    .hero-banner h2 { font-size: 17px; }
    .radar-box { display: none; }

    .voice-panel { padding: 10px 12px; }
    .voice-panel-top { flex-direction: column; align-items: stretch; gap: 8px; }
    .screen-grid { grid-template-columns: 1fr; }

    .floating-call-overlay { right: 10px; left: 10px; width: auto; bottom: 62px; }

    .chat-bottom { padding: 6px 10px 8px; }
    .chat-inp { font-size: 16px; padding: 8px 11px; }
    .bottom-hint { display: none; }

    .modal-backdrop { padding: 6px; }
    .settings-modal-box {
      grid-template-columns: 1fr; grid-template-rows: auto 1fr;
      width: 100%; height: 92dvh; max-height: 92dvh; border-radius: 12px;
    }
    .settings-nav {
      flex-direction: row; align-items: center; overflow-x: auto; overflow-y: hidden;
      border-right: none; border-bottom: 1px solid var(--border); padding: 8px; gap: 6px;
    }
    .settings-nav-label { display: none; }
    .settings-nav-btn { padding: 7px 10px; font-size: 11px; flex-shrink: 0; }
    .settings-content { padding: 14px; }
    .settings-grid-2 { grid-template-columns: 1fr; }
    .theme-pills-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

  <div class="top-header">
    <div class="top-logo">СИГНАЛ <b>CYBER.NET</b></div>
    <div class="top-sub">МЕСТО ДЛЯ СВОИХ // ГОЛОС, КАМЕРА, ОВЕРЛЕЙ И СТРИМЫ</div>
    <div class="top-right-group">
      <button class="btn-top-settings" onclick="openSettingsModal('profile')">👤 Мой профиль</button>
      <button class="btn-top-settings" onclick="openSettingsModal('safety')">🛡️ Фильтр 18+</button>
      <button class="btn-top-settings" onclick="openSettingsModal('voice')">⚙️ Настройки</button>
      <button class="btn-top-invite" onclick="openInviteModal()">+ ПРИГЛАСИТЬ</button>
    </div>
  </div>

  <div class="workspace">
    <div class="mob-drawer-backdrop" id="mob-backdrop" onclick="closeMobileDrawers()"></div>

    <div class="servers-rail" id="servers-rail">
      <div class="bolt-icon">⚡</div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;"></div>
      <div class="srv-ico-add" title="Создать новый сервер" onclick="openCreateServerModal()">+</div>
    </div>

    <div class="channels-panel" id="channels-panel">
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
          <div style="overflow:hidden;min-width:0;">
            <div class="user-name" id="user-name-label">Гость</div>
            <div class="user-sub" id="user-email-label">Настроить профиль</div>
          </div>
        </div>
        <div class="user-bar-actions">
          <button class="btn-login-mini" onclick="openSettingsModal('profile')">Профиль</button>
          <button class="btn-icon-bar" onclick="openSettingsModal('voice')" title="Настройки голоса, камеры и безопасности">⚙️</button>
        </div>
      </div>
    </div>

    <div class="main-chat">
      <div class="chat-topbar">
        <div class="chat-topbar-left">
          <button class="mob-top-btn" onclick="toggleMobileLeft()" title="Серверы и каналы">☰</button>
          <span class="hash-large">#</span>
          <div style="min-width:0;">
            <div class="top-ch-name" id="top-ch-name">игровая-комната</div>
            <div class="top-ch-desc" id="top-ch-desc">Знакомимся, общаемся, строим планы</div>
          </div>
        </div>
        <div class="chat-topbar-right">
          <button class="btn-top-right-share" onclick="openInviteModal()">🔗 ССЫЛКА</button>
          <button class="mob-top-btn" onclick="toggleMobileRight()" title="Участники и друзья">👥</button>
        </div>
      </div>

      <div class="chat-scroll-area" id="chat-scroll">
        <div class="hero-banner">
          <div class="hero-banner-left">
            <div class="hash-badge">#</div>
            <div class="welcome-tag">НАЧАЛО КАНАЛА // P2P СИНХРОНИЗАЦИЯ</div>
            <h2>Кто сегодня на связи?</h2>
            <p id="banner-desc">Это #игровая-комната на сервере «Ночной клуб». Делитесь мыслями, включайте камеру, экран или плавающий оверлей поверх игр.</p>
            <div class="pill-tags-row">
              <span class="pill-tag" onclick="openSettingsModal('profile')">👤 ПРОФИЛЬ И ИНТЕРЕСЫ</span>
              <span class="pill-tag" onclick="openSettingsModal('safety')">🛡️ ФИЛЬТР 18+</span>
              <span class="pill-tag pink" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА</span>
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

        <div class="voice-panel" id="voice-panel-card">
          <div class="voice-panel-top">
            <div>
              <div class="voice-label">ГОЛОСОВОЙ КАНАЛ, КАМЕРА И ОВЕРЛЕЙ // WEBRTC P2P</div>
              <div class="voice-title" id="voice-panel-title">Общий разговор участников канала («Ночной эфир»)</div>
              <div class="voice-sub" id="voice-sub-status">Нажмите «🪟 Оверлей (Не пропадает)», чтобы закрепить системное мини-окно поверх всех игр и рабочего стола даже при сворачивании браузера.</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>
              <button class="btn-mute" id="deafen-btn" style="display:none;" onclick="toggleDeafen()" title="Отключить весь входящий звук">🎧 Звук вкл</button>
              <button class="btn-mute" id="cam-btn" onclick="toggleWebcam()" title="Включить веб-камеру при разговоре">📷 Камера</button>
              <button class="btn-mute" id="screen-btn" onclick="toggleScreenShare()" title="Транслировать экран, окно или вкладку">🖥️ Экран</button>
              <button class="btn-mute" id="pip-overlay-btn" onclick="toggleExternalOverlay()" title="Системный оверлей поверх всех окон (не пропадает при сворачивании браузера)">🪟 Оверлей</button>
              <button class="btn-mute" onclick="openSettingsModal('voice')" title="Настройки микрофона, звука и оверлея">⚙️</button>
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
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • ВСЕ ДРУЗЬЯ, СЕРВЕРЫ И КАНАЛЫ АВТОМАТИЧЕСКИ СОХРАНЯЮТСЯ ПРИ ОБНОВЛЕНИЯХ</div>
      </div>
    </div>

    <div class="right-panel" id="right-panel">
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

  <!-- Встроенный перетаскиваемый виджет + быстрый запуск неубиваемого системного PiP-оверлея -->
  <div class="floating-call-overlay" id="floating-call-overlay">
    <div class="fco-head" id="fco-drag-handle">
      <div class="fco-live">
        <span class="fco-pulse"></span>
        <span id="fco-channel-label">Ночной эфир</span>
      </div>
      <span class="fco-timer" id="fco-timer-label">00:00</span>
    </div>
    <div class="fco-peers" id="fco-peers-box"></div>
    <div class="fco-actions">
      <button class="fco-btn" id="fco-mute-btn" onclick="toggleMute()">🎤 Вкл</button>
      <button class="fco-btn" id="fco-deaf-btn" onclick="toggleDeafen()">🎧 Вкл</button>
      <button class="fco-btn" id="fco-pip-btn" onclick="toggleExternalOverlay()" title="Закрепить системное окно поверх рабочего стола (не исчезает при сворачивании браузера)">🪟 Поверх</button>
      <button class="fco-btn danger" onclick="toggleVoiceCall()">🛑 Выход</button>
    </div>
  </div>

  <!-- Нижняя навигационная панель для смартфонов -->
  <div class="mob-bottom-nav" id="mob-bottom-nav">
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()">
      <span class="ico">☰</span>
      <span>Каналы</span>
    </div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()">
      <span class="ico">💬</span>
      <span>Чат</span>
    </div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="scrollToVoiceMobile()">
      <span class="ico">🔊</span>
      <span>Голос</span>
    </div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()">
      <span class="ico">👥</span>
      <span>Друзья</span>
    </div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('profile')">
      <span class="ico">👤</span>
      <span>Профиль</span>
    </div>
  </div>

  <!-- Большое окно Профиля и Настроек в едином стиле СИГНАЛ -->
  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Профиль</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">👤 Мой профиль</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🔑 Учётная запись</div>
        <div class="settings-nav-label" style="margin-top:6px;">Безопасность</div>
        <div class="settings-nav-btn" data-pane="safety" onclick="switchSettingsPane('safety')">🛡️ Фильтр контента</div>
        <div class="settings-nav-label" style="margin-top:6px;">Приложение</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и оверлей</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid var(--border);flex-shrink:0;">
          <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeSettingsModal()">✕ Закрыть</button>
        </div>
      </div>

      <div class="settings-content">
        <!-- Вкладка 1: Мой профиль -->
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head">
            <h3>Мой профиль</h3>
            <button class="btn-cyan" onclick="saveProfileSettings()">✓ Сохранить онлайн</button>
          </div>

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
            <div class="settings-grid-2">
              <div>
                <label class="field-label">Отображаемый позывной</label>
                <input type="text" id="prof-nick-inp" maxlength="24" placeholder="Ваш позывной" oninput="updateProfilePreview()">
              </div>
              <div>
                <label class="field-label">Статус активности</label>
                <select id="prof-presence-sel" onchange="updateProfilePreview()">
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
              <textarea id="prof-bio-inp" rows="2" maxlength="220" placeholder="Расскажите о себе, своих проектах, любимых играх или музыке..." oninput="updateProfilePreview()"></textarea>
            </div>

            <div>
              <label class="field-label">Интересы и увлечения (через запятую)</label>
              <input type="text" id="prof-interests-inp" maxlength="160" placeholder="Киберпанк, Игры, Музыка, Программирование, Аниме" oninput="updateProfilePreview()">
            </div>

            <div class="settings-grid-2">
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

        <!-- Вкладка 2: Фильтр контента -->
        <div class="settings-pane" id="pane-safety">
          <div class="settings-head">
            <h3>🛡️ Фильтр сексуального и шокирующего контента</h3>
            <span class="status-pill on">ЗАЩИТА АКТИВНА</span>
          </div>

          <div class="settings-card">
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">🔞 Блокировать сексуальный и откровенный контент (18+ / NSFW)</div>
                <div class="toggle-sub">Автоматически блокирует откровенные медиафайлы, 18+ ссылки и сообщения сексуального характера</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-filter-sexual" checked onchange="saveSafetySettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>

            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">🩸 Блокировать насилие и шокирующий контент (Gore / Шок-медиа)</div>
                <div class="toggle-sub">Блокирует сцены жестокости, насилия, крови, увечий и шокирующие материалы</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-filter-gore" checked onchange="saveSafetySettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>

            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">🔗 Блокировать отправку запрещённых материалов с моего устройства</div>
                <div class="toggle-sub">Предотвращает случайную отправку ссылок или текста с запрещённым контентом в чат</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-filter-outgoing" checked onchange="saveSafetySettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
          </div>

          <div class="settings-card">
            <div>
              <label class="field-label">Действие при обнаружении опасного контента или медиа</label>
              <select id="sel-filter-action" onchange="saveSafetySettings()">
                <option value="block">🚫 Полностью блокировать и удалять из чата (Рекомендуется)</option>
                <option value="blur">👁️ Скрывать под размытым спойлером с предупреждением</option>
              </select>
            </div>

            <div>
              <label class="field-label">Собственный чёрный список слов и доменов (через запятую)</label>
              <input type="text" id="inp-custom-blocklist" maxlength="200" placeholder="Например: казино, спам, badsite.com" oninput="saveSafetySettings()">
            </div>
          </div>
        </div>

        <!-- Вкладка 3: Голос, видео и игровой оверлей -->
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head">
            <h3>Настройки голоса, видео и оверлея</h3>
            <button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 Обновить устройства</button>
          </div>

          <div class="settings-card">
            <div class="settings-grid-2">
              <div>
                <label class="field-label">Устройство ввода (Микрофон)</label>
                <select id="set-mic-select" onchange="saveAudioVideoSettings()"></select>
              </div>
              <div>
                <label class="field-label">Устройство вывода (Наушники)</label>
                <select id="set-spk-select" onchange="saveAudioVideoSettings()"></select>
              </div>
            </div>

            <div class="settings-grid-2">
              <div>
                <label class="field-label">Громкость микрофона: <span id="lbl-mic-vol" style="color:var(--cyan-bright);">100%</span></label>
                <input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()">
              </div>
              <div>
                <label class="field-label">Громкость собеседников: <span id="lbl-out-vol" style="color:var(--cyan-bright);">100%</span></label>
                <input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()">
              </div>
            </div>

            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
                <label class="field-label" style="margin:0;">Проверка микрофона</label>
                <button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ Проверить микрофон</button>
              </div>
              <div class="mic-meter-wrap">
                <div class="mic-meter-bar" id="mic-test-bar"></div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">🪟 Игровой оверлей звонка поверх всех окон (PiP Overlay)</div>
                <div class="toggle-sub">Закрепляет окно звонка поверх рабочего стола, чтобы оно не пропадало при сворачивании браузера</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-auto-overlay" checked onchange="saveAudioVideoSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
            <div class="settings-grid-2">
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
              <div class="toggle-text-col">
                <div class="toggle-title">Шумоподавление (Noise Suppression)</div>
                <div class="toggle-sub">Фильтрует фоновый шум вентиляторов и клавиатуры</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">Эхоподавление (Echo Cancellation)</div>
                <div class="toggle-sub">Предотвращает повтор звука из динамиков в микрофон</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">Авторегулировка усиления (Auto Gain Control)</div>
                <div class="toggle-sub">Автоматически выравнивает громкость вашего голоса</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
          </div>
        </div>

        <!-- Вкладка 4: Внешний вид -->
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head">
            <h3>Внешний вид интерфейса</h3>
          </div>
          <div class="settings-card">
            <div>
              <label class="field-label">Неоновый акцент СИГНАЛ</label>
              <div class="theme-pills-grid">
                <button class="theme-pill-btn" onclick="setAccentTheme('#14b8a6', '#2dd4bf')">
                  <span class="theme-dot-swatch" style="background:#2dd4bf;"></span><span>Бирюзовый Кибер</span>
                </button>
                <button class="theme-pill-btn" onclick="setAccentTheme('#db2777', '#f43f5e')">
                  <span class="theme-dot-swatch" style="background:#f43f5e;"></span><span>Розовый Неон</span>
                </button>
                <button class="theme-pill-btn" onclick="setAccentTheme('#7c3aed', '#a78bfa')">
                  <span class="theme-dot-swatch" style="background:#a78bfa;"></span><span>Фиолетовый Синт</span>
                </button>
                <button class="theme-pill-btn" onclick="setAccentTheme('#d97706', '#fbbf24')">
                  <span class="theme-dot-swatch" style="background:#fbbf24;"></span><span>Золотой Кибер</span>
                </button>
              </div>
            </div>
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">Компактный режим сообщений</div>
                <div class="toggle-sub">Уменьшает отступы в чате, чтобы помещалось больше текста</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()">
                <span class="cyber-slider"></span>
              </label>
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

        <!-- Вкладка 5: Уведомления -->
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head">
            <h3>Звуки и уведомления</h3>
          </div>
          <div class="settings-card">
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">Звук при новом сообщении в чате</div>
                <div class="toggle-sub">Воспроизводить мягкий кибер-сигнал при входящем сообщении</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <div class="toggle-text-col">
                <div class="toggle-title">Звук подключения к голосовому каналу</div>
                <div class="toggle-sub">Звуковой сигнал при входе/выходе из голосового эфира</div>
              </div>
              <label class="cyber-switch">
                <input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()">
                <span class="cyber-slider"></span>
              </label>
            </div>
            <div>
              <button class="btn-login-mini" onclick="playUiBeep(660, 0.08)">🔊 Проверить звук уведомления</button>
            </div>
          </div>
        </div>

        <!-- Вкладка 6: Учётная запись и резервная защита -->
        <div class="settings-pane" id="pane-account">
          <div class="settings-head">
            <h3>Учётная запись и защита данных</h3>
          </div>
          <div class="settings-card">
            <div style="font-size:12px;color:#cbd5e1;line-height:1.5;">
              Ваш аккаунт, список друзей, созданные серверы и каналы автоматически сохраняются в памяти браузера и мгновенно восстанавливаются на сервере после любых обновлений кода.
            </div>
            <div class="settings-grid-2">
              <button class="btn-cyan" onclick="closeSettingsModal();openAuthModal(false)">✈️ Сменить аккаунт / Telegram</button>
              <button class="btn-danger" onclick="logoutAccount()">Выйти из аккаунта</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Модальное окно просмотра чужого профиля -->
  <div class="modal-backdrop" id="view-profile-modal" onclick="if(event.target===this)closeViewProfileModal()">
    <div class="modal-box" style="padding:0;overflow:hidden;width:360px;">
      <div class="discord-profile-card" style="border:none;">
        <div class="dp-banner" id="vp-banner"></div>
        <div class="dp-body">
          <div class="dp-ava" id="vp-ava">УЧ</div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
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

  <!-- Модальное окно первой авторизации -->
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

  // ---------- Мобильная навигация в стиле Discord ----------
  function setMobActiveTab(tabId) {
    document.querySelectorAll('#mob-bottom-nav .mob-nav-item').forEach(function (el) {
      el.classList.toggle('active', el.id === tabId);
    });
  }

  function closeMobileDrawers() {
    document.body.classList.remove('mob-left-open', 'mob-right-open');
    setMobActiveTab('mob-tab-chat');
  }

  function toggleMobileLeft() {
    const isOpen = document.body.classList.contains('mob-left-open');
    document.body.classList.remove('mob-right-open');
    if (isOpen) {
      document.body.classList.remove('mob-left-open');
      setMobActiveTab('mob-tab-chat');
    } else {
      document.body.classList.add('mob-left-open');
      setMobActiveTab('mob-tab-left');
    }
  }

  function toggleMobileRight() {
    const isOpen = document.body.classList.contains('mob-right-open');
    document.body.classList.remove('mob-left-open');
    if (isOpen) {
      document.body.classList.remove('mob-right-open');
      setMobActiveTab('mob-tab-chat');
    } else {
      document.body.classList.add('mob-right-open');
      setMobActiveTab('mob-tab-right');
    }
  }

  function scrollToVoiceMobile() {
    closeMobileDrawers();
    setMobActiveTab('mob-tab-voice');
    const vp = document.getElementById('voice-panel-card');
    if (vp && vp.scrollIntoView) {
      vp.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---------- Сохранение сессии и обновление URL без перезагрузки ----------
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

  function updateBrowserUrl() {
    try {
      const newUrl = window.location.pathname + '?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel);
      window.history.replaceState({ room: currentRoom, channel: currentChannel }, '', newUrl);
    } catch (e) {}
  }

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

  let appSettings = {
    micDeviceId: '',
    spkDeviceId: '',
    camDeviceId: '',
    micVolume: 100,
    outVolume: 100,
    camRes: '720',
    autoOverlay: true,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    compactChat: false,
    fontSize: '12px',
    soundMsg: true,
    soundVoice: true,
    filterSexual: true,
    filterGore: true,
    filterOutgoing: true,
    filterAction: 'block',
    customBlockedWords: ''
  };
  try {
    const savedSet = JSON.parse(localStorage.getItem('cyber_settings') || '{}');
    appSettings = Object.assign(appSettings, savedSet);
  } catch (e) {}

  const CLIENT_SEXUAL_RX = [
    /порн/i, /секс/i, /эротик/i, /интим/i, /хентай/i, /минет/i, /трах/i, /шлюх/i,
    /проститут/i, /сиськ/i, /вагин/i, /член/i, /голая/i, /голые/i, /обнажен/i,
    /porn/i, /nsfw/i, /xxx/i, /hentai/i, /onlyfans/i, /xvideos/i, /pornhub/i,
    /redtube/i, /brazzers/i, /rule34/i, /nude/i, /boobs/i, /pussy/i, /dick/i
  ];
  const CLIENT_GORE_RX = [
    /расчлен/i, /кишки/i, /труп/i, /казнь/i, /пытк/i, /убийств/i, /самоубийств/i,
    /суицид/i, /резня/i, /кровопролит/i, /увечь/i, /жесть/i, /насили/i, /террор/i,
    /gore/i, /liveleak/i, /bestgore/i, /behead/i, /torture/i, /suicide/i, /deadbody/i, /murder/i
  ];
  const IMAGE_URL_RX = new RegExp('https?://' + '[^\\s"\'<>]+\\.(?:png|jpe?g|gif|webp)(?:\\?[^\\s"\'<>]*)?', 'i');

  function checkContentViolation(text, serverFlags) {
    const s = String(text || '');
    const reasons = [];
    if (appSettings.filterSexual) {
      if ((serverFlags && serverFlags.sexual) || CLIENT_SEXUAL_RX.some(function (rx) { return rx.test(s); })) {
        reasons.push('Сексуальный контент 18+');
      }
    }
    if (appSettings.filterGore) {
      if ((serverFlags && serverFlags.gore) || CLIENT_GORE_RX.some(function (rx) { return rx.test(s); })) {
        reasons.push('Насилие / Шокирующий контент');
      }
    }
    if (appSettings.customBlockedWords) {
      const list = String(appSettings.customBlockedWords).split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
      const lower = s.toLowerCase();
      if (list.some(function (w) { return lower.includes(w); })) {
        reasons.push('Чёрный список слов');
      }
    }
    return reasons;
  }

  function toggleSpoiler(wrapEl) {
    if (wrapEl) wrapEl.classList.toggle('revealed');
  }

  let clientId = Math.random().toString(36).substring(2, 10);
  let evtSource = null;
  let tgSessionToken = '';
  let tgBotUsername = '';
  let tgPollTimer = null;

  let roomMessagesCache = {};
  let allRoomsMessagesVault = {};
  let knownUsersByPid = {};
  let unreadByChannel = {};
  let cachedMessages = [];
  let profileSyncTimer = null;

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

  // Переменные для фоновой работы звонка и системного PiP-оверлея, не исчезающего при сворачивании браузера
  let callStartTime = 0;
  let voiceLockRelease = null, wakeLockSentinel = null, keepAliveAudioEl = null;
  let pipCanvas = null, pipCtx = null, canvasPipVideo = null, pipWorker = null;

  // ---------- АВТО-СОХРАНЕНИЕ И ВОССТАНОВЛЕНИЕ ДРУЗЕЙ И СЕРВЕРОВ (VAULT AUTO-RESTORE) ----------
  function loadLocalVault() {
    try {
      const raw = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
      if (raw.knownUsers && typeof raw.knownUsers === 'object') {
        knownUsersByPid = raw.knownUsers;
      }
      if (raw.messages && typeof raw.messages === 'object') {
        allRoomsMessagesVault = raw.messages;
      }
      if (Array.isArray(raw.servers) && raw.servers.length) {
        serversList = raw.servers;
      }
      if (Array.isArray(raw.friendsPids) && (!social.friends || !social.friends.length)) {
        social.friends = raw.friendsPids.map(function (pid) {
          return knownUsersByPid[pid] || { pid: pid, nick: 'Друг', online: false };
        });
      }
    } catch (e) {}
  }
  loadLocalVault();

  function saveLocalVault() {
    try {
      (lastMembers || []).forEach(function (u) {
        if (u && u.pid) {
          knownUsersByPid[u.pid] = Object.assign({}, knownUsersByPid[u.pid] || {}, u);
        }
      });
      (social.friends || []).forEach(function (f) {
        if (f && f.pid && f.nick && !f.nick.startsWith('Друг (')) {
          knownUsersByPid[f.pid] = Object.assign({}, knownUsersByPid[f.pid] || {}, f);
        }
      });
      if (currentRoom && Object.keys(roomMessagesCache).length) {
        allRoomsMessagesVault[currentRoom] = roomMessagesCache;
      }
      const prevRaw = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
      const currentFriendsPids = (social.friends || []).map(function (f) { return f.pid; });
      const mergedFriendsPids = currentFriendsPids.length ? currentFriendsPids : (prevRaw.friendsPids || []);

      const vault = {
        uid: myUid,
        nick: myNick,
        profile: myProfile,
        friendsPids: mergedFriendsPids,
        incomingPids: (social.incoming || []).map(function (i) { return i.pid; }),
        outgoingPids: social.outgoing || [],
        knownUsers: knownUsersByPid,
        servers: serversList,
        room: currentRoom,
        roomMembersPids: (lastMembers || []).map(function (m) { return m.pid; }),
        messages: allRoomsMessagesVault
      };
      localStorage.setItem('cyber_vault_v1', JSON.stringify(vault));
    } catch (e) {}
  }

  async function syncLocalVaultToServer() {
    try {
      const raw = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
      if (!raw || !raw.uid) return;
      const knownArr = Object.keys(raw.knownUsers || {}).map(function (k) { return raw.knownUsers[k]; });
      const res = await fetch('/api/vault-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: myUid,
          nick: myNick,
          profile: myProfile,
          friends: raw.friendsPids || [],
          incoming: raw.incomingPids || [],
          outgoing: raw.outgoingPids || [],
          knownUsers: knownArr,
          servers: raw.servers || [],
          room: currentRoom,
          roomMembersPids: raw.roomMembersPids || [],
          messages: raw.messages || {}
        })
      });
      const data = await res.json();
      if (data && data.ok) {
        if (data.list && data.list.length) {
          serversList = data.list;
          const found = serversList.find(function (s) { return s.id === currentRoom; });
          if (found) currentServerMeta = found;
          renderServersRail();
          renderServerChannels();
        }
        if (data.messagesByChannel) {
          roomMessagesCache = data.messagesByChannel;
          cachedMessages = roomMessagesCache[currentChannel] || [];
          rerenderChatMessages();
        }
        if (data.social) {
          myPid = data.social.pid;
          social = data.social;
          renderSocial();
        }
        if (Array.isArray(data.users)) {
          renderUsers(data.users);
        }
      }
    } catch (e) {}
  }

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

  function formatCallTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ---------- НЕУБИВАЕМЫЙ СИСТЕМНЫЙ ОВЕРЛЕЙ УРОВНЯ ОС (РАБОТАЕТ ПРИ СВОРАЧИВАНИИ БРАУЗЕРА) ----------
  function ensurePipRenderEngine() {
    if (!pipCanvas) {
      pipCanvas = document.createElement('canvas');
      pipCanvas.width = 460;
      pipCanvas.height = 260;
      pipCtx = pipCanvas.getContext('2d');
    }
    if (!canvasPipVideo) {
      canvasPipVideo = document.createElement('video');
      canvasPipVideo.muted = true;
      canvasPipVideo.autoplay = true;
      canvasPipVideo.playsInline = true;
      // Включаем авто-вывод системного оверлея при сворачивании браузера в поддерживаемых браузерах
      canvasPipVideo.autoPictureInPicture = true;
      canvasPipVideo.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;bottom:0;right:0;z-index:-1;';
      document.body.appendChild(canvasPipVideo);

      canvasPipVideo.addEventListener('enterpictureinpicture', function () {
        const b1 = document.getElementById('pip-overlay-btn');
        const b2 = document.getElementById('fco-pip-btn');
        if (b1) b1.classList.add('active-cam');
        if (b2) b2.classList.add('active-pip');
      });
      canvasPipVideo.addEventListener('leavepictureinpicture', function () {
        const b1 = document.getElementById('pip-overlay-btn');
        const b2 = document.getElementById('fco-pip-btn');
        if (b1) b1.classList.remove('active-cam');
        if (b2) b2.classList.remove('active-pip');
      });
    }
    if (!pipWorker) {
      // Web Worker работает в отдельном потоке и НЕ замораживается при сворачивании окна браузера
      try {
        const blob = new Blob([
          'setInterval(function(){ postMessage(Date.now()); }, 250);'
        ], { type: 'application/javascript' });
        pipWorker = new Worker(URL.createObjectURL(blob));
        pipWorker.onmessage = function () {
          if (!inVoice) return;
          const elapsed = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
          const tEl = document.getElementById('fco-timer-label');
          if (tEl) tEl.textContent = formatCallTime(elapsed);
          drawSystemPipOverlayFrame();
        };
      } catch (e) {
        setInterval(function () {
          if (!inVoice) return;
          drawSystemPipOverlayFrame();
        }, 300);
      }
    }
  }

  function drawSystemPipOverlayFrame() {
    if (!pipCtx || !pipCanvas) return;
    const ctx = pipCtx;
    const W = pipCanvas.width;
    const H = pipCanvas.height;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);

    // Если кто-то транслирует экран или камеру, рисуем живое видео на фоне системного оверлея
    const activeVideo = document.querySelector('#screen-grid video');
    if (activeVideo && activeVideo.readyState >= 2) {
      try {
        ctx.drawImage(activeVideo, 0, 42, W, H - 82);
        ctx.fillStyle = 'rgba(4, 7, 13, 0.55)';
        ctx.fillRect(0, 42, W, H - 82);
      } catch (e) {}
    }

    // Неоновая рамка
    ctx.strokeStyle = isMuted ? '#f43f5e' : '#2dd4bf';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, W - 4, H - 4);

    // Верхняя шапка оверлея
    ctx.fillStyle = '#09101a';
    ctx.fillRect(4, 4, W - 8, 38);

    ctx.fillStyle = '#e11d48';
    ctx.fillRect(14, 11, 74, 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('СИГНАЛ', 24, 27);

    ctx.fillStyle = '#2dd4bf';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('🔊 ' + currentVoiceChannel, 98, 28);

    const elapsed = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(formatCallTime(elapsed), W - 64, 28);

    // Список участников голосового канала
    const vUsers = getVoiceChannelMembers();
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('УЧАСТНИКИ В КАНАЛЕ (' + vUsers.length + '):', 16, 64);

    vUsers.slice(0, 5).forEach(function (u, idx) {
      const y = 88 + idx * 25;
      ctx.fillStyle = 'rgba(15, 23, 34, 0.85)';
      ctx.fillRect(14, y - 16, W - 28, 22);

      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(26, y - 5, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 13px sans-serif';
      const tags = (u.pid === myPid ? ' (Вы)' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '');
      ctx.fillText(u.nick + tags, 38, y);
    });

    // Нижняя панель статуса микрофона и звука
    ctx.fillStyle = '#09101a';
    ctx.fillRect(4, H - 38, W - 8, 34);

    ctx.fillStyle = isMuted ? '#fda4af' : '#4ade80';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(isMuted ? '🔇 МИКРОФОН ВЫКЛ' : '🎤 МИКРОФОН ВКЛ', 16, H - 16);

    ctx.fillStyle = isDeafened ? '#fda4af' : '#38bdf8';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(isDeafened ? '🔇 ЗВУК ОТКЛ' : '🎧 В ЭФИРЕ', W - 120, H - 16);
  }

  async function toggleExternalOverlay() {
    if (!inVoice) {
      const ok = await ensureVoiceConnected();
      if (!ok) return;
    }
    if (document.pictureInPictureElement) {
      closeExternalOverlay();
      return;
    }
    try {
      ensurePipRenderEngine();
      drawSystemPipOverlayFrame();
      if (!canvasPipVideo.srcObject) {
        canvasPipVideo.srcObject = pipCanvas.captureStream(15);
      }
      await canvasPipVideo.play();
      if (canvasPipVideo.requestPictureInPicture) {
        await canvasPipVideo.requestPictureInPicture();
      } else if (canvasPipVideo.webkitSetPresentationMode) {
        canvasPipVideo.webkitSetPresentationMode('picture-in-picture');
      }
    } catch (e) {
      alert('Нажмите кнопку «🪟 Оверлей» ещё раз для закрепления окна поверх экрана.');
    }
  }

  function closeExternalOverlay() {
    if (document.pictureInPictureElement) {
      try { document.exitPictureInPicture(); } catch (e) {}
    }
    const b1 = document.getElementById('pip-overlay-btn');
    const b2 = document.getElementById('fco-pip-btn');
    if (b1) b1.classList.remove('active-cam');
    if (b2) b2.classList.remove('active-pip');
  }

  function startBackgroundCallPersistence() {
    // 1. Web Lock API запрещает браузеру замораживать вкладку при сворачивании
    if (navigator.locks && navigator.locks.request && !voiceLockRelease) {
      navigator.locks.request('signal_active_voice_call', { mode: 'exclusive' }, function () {
        return new Promise(function (resolve) {
          voiceLockRelease = resolve;
        });
      }).catch(function () {});
    }

    // 2. WakeLock удерживает устройство активным
    if (navigator.wakeLock && navigator.wakeLock.request && !wakeLockSentinel) {
      navigator.wakeLock.request('screen').then(function (s) {
        wakeLockSentinel = s;
      }).catch(function () {});
    }

    // 3. Непрерывный аудио-мост + подготовка системного PiP видеопотока
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const dst = audioCtx.createMediaStreamDestination();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.frequency.value = 40;
      g.gain.value = 0.0001;
      osc.connect(g);
      g.connect(dst);
      osc.start();

      if (!keepAliveAudioEl) {
        keepAliveAudioEl = document.createElement('audio');
        keepAliveAudioEl.loop = true;
        keepAliveAudioEl.volume = 0.01;
        document.body.appendChild(keepAliveAudioEl);
      }
      keepAliveAudioEl.srcObject = dst.stream;
      keepAliveAudioEl.play().catch(function () {});
    } catch (e) {}

    callStartTime = Date.now();
    ensurePipRenderEngine();
    drawSystemPipOverlayFrame();
    try {
      if (!canvasPipVideo.srcObject) {
        canvasPipVideo.srcObject = pipCanvas.captureStream(15);
      }
      canvasPipVideo.play().catch(function () {});
    } catch (e) {}

    // 4. Интеграция с системными кнопками MediaSession (управление микрофоном прямо из мини-окна PiP)
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '🔊 ' + currentVoiceChannel,
          artist: 'СИГНАЛ // ' + (currentServerMeta.name || currentRoom),
          album: 'Голосовой эфир активен'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', function () {
          if (isMuted) toggleMute();
          if (canvasPipVideo) canvasPipVideo.play().catch(function () {});
        });
        navigator.mediaSession.setActionHandler('pause', function () {
          toggleMute();
          if (canvasPipVideo) canvasPipVideo.play().catch(function () {});
        });
        navigator.mediaSession.setActionHandler('hangup', function () {
          if (inVoice) toggleVoiceCall();
        });
      } catch (e) {}
    }

    updateFloatingOverlayUI();
  }

  function stopBackgroundCallPersistence() {
    if (voiceLockRelease) {
      try { voiceLockRelease(); } catch (e) {}
      voiceLockRelease = null;
    }
    if (wakeLockSentinel) {
      try { wakeLockSentinel.release(); } catch (e) {}
      wakeLockSentinel = null;
    }
    if (keepAliveAudioEl) {
      try { keepAliveAudioEl.pause(); keepAliveAudioEl.srcObject = null; } catch (e) {}
    }
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
    }
    closeExternalOverlay();
    updateFloatingOverlayUI();
  }

  document.addEventListener('visibilitychange', function () {
    if (!inVoice) return;
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
    }
    document.querySelectorAll('#audio-box audio').forEach(function (a) {
      if (a.paused && !isDeafened) a.play().catch(function () {});
    });
    if (keepAliveAudioEl && keepAliveAudioEl.paused) {
      keepAliveAudioEl.play().catch(function () {});
    }
    if (canvasPipVideo && canvasPipVideo.paused) {
      canvasPipVideo.play().catch(function () {});
    }
  });

  function getVoiceChannelMembers() {
    const vUsers = (lastMembers || []).filter(function (u) {
      return u.online && u.inVoice && (!u.voiceChannel || u.voiceChannel === currentVoiceChannel);
    });
    if (!vUsers.some(function (u) { return u.pid === myPid; }) && inVoice) {
      vUsers.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen });
    }
    return vUsers;
  }

  function updateFloatingOverlayUI() {
    const box = document.getElementById('floating-call-overlay');
    if (!box) return;
    if (!inVoice || appSettings.autoOverlay === false) {
      box.classList.remove('show');
    } else {
      box.classList.add('show');
    }
    document.getElementById('fco-channel-label').textContent = '🔊 ' + currentVoiceChannel;
    document.getElementById('fco-mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('fco-deaf-btn').textContent = isDeafened ? '🔇 Глух' : '🎧 Вкл';

    const peersBox = document.getElementById('fco-peers-box');
    peersBox.innerHTML = '';
    const vMembers = getVoiceChannelMembers();
    vMembers.forEach(function (u) {
      const chip = el('div', 'fco-peer-chip');
      const dot = el('span', 'fco-pulse');
      const label = el('span', '', u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''));
      chip.appendChild(dot);
      chip.appendChild(label);
      peersBox.appendChild(chip);
    });

    drawSystemPipOverlayFrame();
  }

  (function initDraggableOverlay() {
    const card = document.getElementById('floating-call-overlay');
    const handle = document.getElementById('fco-drag-handle');
    if (!card || !handle) return;
    let dragging = false, startX = 0, startY = 0, origRight = 18, origBottom = 72;

    function onStart(clientX, clientY) {
      dragging = true;
      startX = clientX;
      startY = clientY;
      const rect = card.getBoundingClientRect();
      origRight = window.innerWidth - rect.right;
      origBottom = window.innerHeight - rect.bottom;
    }
    function onMove(clientX, clientY) {
      if (!dragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      card.style.left = 'auto';
      card.style.right = Math.max(8, Math.min(window.innerWidth - 120, origRight - dx)) + 'px';
      card.style.bottom = Math.max(8, Math.min(window.innerHeight - 80, origBottom - dy)) + 'px';
    }
    function onEnd() { dragging = false; }

    handle.addEventListener('mousedown', function (e) { onStart(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', onEnd);

    handle.addEventListener('touchstart', function (e) {
      if (e.touches[0]) onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (dragging && e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener('touchend', onEnd);
  })();

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
    const stViolations = checkContentViolation(myProfile.customStatus || '');
    const safeStatus = stViolations.length ? '' : myProfile.customStatus;
    if (safeStatus) {
      document.getElementById('user-email-label').textContent = safeStatus;
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
      const rightWrap = el('div', '');
      rightWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const unread = unreadByChannel[ch] || 0;
      if (unread > 0 && ch !== currentChannel) {
        rightWrap.appendChild(el('span', 'ch-unread-badge', String(unread)));
      }
      rightWrap.appendChild(el('span', 'ch-dot'));
      row.appendChild(span);
      row.appendChild(rightWrap);
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
    document.getElementById('banner-desc').textContent = 'Это #' + ch + ' на сервере «' + srvName + '». Делитесь мыслями, включайте камеру, экран или плавающий оверлей поверх игр.';
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(function (i) {
      i.classList.toggle('active', i.getAttribute('data-ch') === ch);
    });
  }

  function updateVoicePanelUI() {
    document.getElementById('voice-panel-title').textContent = 'Общий разговор участников канала («' + currentVoiceChannel + '»)';
    updateFloatingOverlayUI();
  }

  async function switchServer(roomId) {
    const clean = String(roomId || '').trim();
    if (!clean || clean === currentRoom) {
      closeMobileDrawers();
      return;
    }
    if (inVoice) {
      await toggleVoiceCall();
    }
    currentRoom = clean;
    unreadByChannel = {};
    roomMessagesCache = allRoomsMessagesVault[currentRoom] || {};
    try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}

    const found = serversList.find(function (s) { return s.id === currentRoom; });
    if (found) {
      currentServerMeta = found;
      currentChannel = (found.textChannels && found.textChannels[0]) || 'игровая-комната';
      currentVoiceChannel = (found.voiceChannels && found.voiceChannels[0]) || 'Ночной эфир';
    }
    updateBrowserUrl();
    renderServersRail();
    renderServerChannels();
    closeMobileDrawers();

    try {
      const res = await fetch('/api/switch-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick: myNick })
      });
      const data = await res.json();
      if (data && data.ok) {
        currentServerMeta = data.current || currentServerMeta;
        serversList = data.list || serversList;
        roomMessagesCache = data.messagesByChannel || {};
        if (!currentServerMeta.textChannels.includes(currentChannel)) {
          currentChannel = currentServerMeta.textChannels[0] || 'игровая-комната';
        }
        cachedMessages = roomMessagesCache[currentChannel] || [];
        updateBrowserUrl();
        renderServersRail();
        renderServerChannels();
        rerenderChatMessages();
        if (Array.isArray(data.users)) renderUsers(data.users);
        saveLocalVault();
      }
    } catch (e) {}
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
        if (data.payload.messagesByChannel) {
          roomMessagesCache = data.payload.messagesByChannel;
        }
        renderServersRail();
        renderServerChannels();
        cachedMessages = roomMessagesCache[currentChannel] || [];
        rerenderChatMessages();
        // Мгновенно синхронизируем сохранённое хранилище браузера с сервером (чтобы после замены server.js на Render друзья и серверы не пропадали)
        syncLocalVaultToServer();
      } else if (data.type === 'servers') {
        serversList = data.payload.list || [];
        const found = serversList.find(function (s) { return s.id === currentRoom; });
        if (found) currentServerMeta = found;
        renderServersRail();
        renderServerChannels();
        saveLocalVault();
      } else if (data.type === 'msg') {
        const ch = data.payload.channel;
        const msg = data.payload.msg;
        if (!roomMessagesCache[ch]) roomMessagesCache[ch] = [];
        roomMessagesCache[ch].push(msg);
        saveLocalVault();

        if (ch === currentChannel) {
          cachedMessages = roomMessagesCache[ch];
          addMsgToDOM(msg);
        } else {
          unreadByChannel[ch] = (unreadByChannel[ch] || 0) + 1;
          renderServerChannels();
        }
        if (appSettings.soundMsg && msg && msg.author !== myNick) {
          playUiBeep(540, 0.06);
        }
      } else if (data.type === 'users') {
        renderUsers(data.payload);
        updateFloatingOverlayUI();
        saveLocalVault();
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
        saveLocalVault();
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
  renderSocial();
  connectEventStream();

  if (!myVerified) {
    openAuthModal(true);
  }

  function rerenderChatMessages() {
    const box = document.getElementById('messages-list');
    box.innerHTML = '';
    if (!cachedMessages || !cachedMessages.length) {
      box.innerHTML = '<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>';
      return;
    }
    cachedMessages.forEach(addMsgToDOM);
  }

  function buildMessageBodyHTML(text, violations) {
    const safeText = escapeHtml(text);
    const imgMatch = String(text || '').match(IMAGE_URL_RX);
    let innerHtml = '<div>' + safeText + '</div>';
    if (imgMatch) {
      innerHtml += '<img class="chat-inline-media" src="' + escapeHtml(imgMatch[0]) + '" alt="media" loading="lazy">';
    }

    if (!violations || violations.length === 0) {
      return innerHtml;
    }
    const reasonStr = escapeHtml(violations.join(', '));
    if (appSettings.filterAction === 'blur') {
      return '<div class="spoiler-blur-wrap" onclick="toggleSpoiler(this)" title="Нажмите, чтобы показать или скрыть">' +
        '<div class="spoiler-badge">🛡️ Скрыто фильтром (' + reasonStr + ') — нажмите, чтобы показать</div>' +
        '<div class="spoiler-blur-content">' + innerHtml + '</div>' +
        '</div>';
    }
    return '<div class="filtered-block-card">🛡️ Сообщение или медиа заблокировано фильтром безопасности (' + reasonStr + ')</div>';
  }

  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list');
    const hint = document.getElementById('empty-hint');
    if (hint) hint.remove();
    const author = String(m.author || '?');
    const violations = checkContentViolation(m.text, m.flags);
    const div = document.createElement('div');
    div.className = 'msg-item';
    div.innerHTML = '<div class="msg-ava">' + escapeHtml(author.charAt(0).toUpperCase()) + '</div>' +
      '<div style="flex:1;min-width:0;"><div><span class="msg-author">' + escapeHtml(author) + '</span><span class="msg-time">' + escapeHtml(m.time) + '</span></div>' +
      '<div class="msg-text">' + buildMessageBodyHTML(m.text, violations) + '</div></div>';
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
      .then(function (d) {
        if (d.error) alert(d.error);
        else saveLocalVault();
      })
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
        const stViol = checkContentViolation(u.customStatus);
        col.appendChild(el('div', 'member-status-sub', stViol.length ? '🛡️ [Статус скрыт фильтром]' : u.customStatus));
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
      const cachedF = knownUsersByPid[f.pid] || {};
      const dispNick = (f.nick && !f.nick.startsWith('Друг (')) ? f.nick : (cachedF.nick || f.nick);
      const d = el('div', 'online-user-item' + (f.online ? ' is-online' : ''));
      if (!f.online) d.style.opacity = '0.68';
      d.appendChild(el('span', 'online-dot ' + (f.online ? (f.presence || 'online') : 'off')));
      const name = el('span', '', dispNick);
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      d.appendChild(name);

      const stPill = el('span', 'status-pill ' + (f.online ? 'on' : 'off'), f.online ? 'в сети' : 'не в сети');
      d.appendChild(stPill);

      const rmb = el('button', 'mini-btn', '✕');
      rmb.title = 'Удалить из друзей';
      rmb.onclick = function (ev) {
        ev.stopPropagation();
        if (confirm('Удалить ' + dispNick + ' из друзей?')) {
          social.friends = (social.friends || []).filter(function (x) { return x.pid !== f.pid; });
          try {
            const v = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
            if (Array.isArray(v.friendsPids)) {
              v.friendsPids = v.friendsPids.filter(function (p) { return p !== f.pid; });
              localStorage.setItem('cyber_vault_v1', JSON.stringify(v));
            }
          } catch (e) {}
          friendAction('remove', f.pid);
        }
      };
      d.appendChild(rmb);
      d.onclick = function () { openUserProfileCard(Object.assign({}, cachedF, f, { nick: dispNick })); };
      fb.appendChild(d);
    });
  }

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

    const stViol = checkContentViolation(u.customStatus || '');
    const bioViol = checkContentViolation(u.bio || '');
    document.getElementById('vp-status').textContent = stViol.length ? '🛡️ [Статус скрыт фильтром]' : (u.customStatus || '');
    document.getElementById('vp-bio').textContent = bioViol.length ? '🛡️ [Информация скрыта фильтром безопасности]' : (u.bio || 'Участник пока ничего о себе не указал.');

    const tagsBox = document.getElementById('vp-tags');
    tagsBox.innerHTML = '';
    const rawTags = String(u.interests || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (rawTags.length === 0) {
      tagsBox.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Интересы не указаны</span>';
    } else {
      rawTags.forEach(function (tg) {
        if (!checkContentViolation(tg).length) {
          tagsBox.appendChild(el('span', 'dp-tag', tg));
        }
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

  function openSettingsModal(pane) {
    closeMobileDrawers();
    setMobActiveTab('mob-tab-profile');
    document.getElementById('prof-nick-inp').value = myNick;
    document.getElementById('prof-presence-sel').value = myProfile.presence || 'online';
    document.getElementById('prof-status-inp').value = myProfile.customStatus || '';
    document.getElementById('prof-bio-inp').value = myProfile.bio || '';
    document.getElementById('prof-interests-inp').value = myProfile.interests || '';
    updateProfilePreview(true);

    document.getElementById('chk-filter-sexual').checked = appSettings.filterSexual !== false;
    document.getElementById('chk-filter-gore').checked = appSettings.filterGore !== false;
    document.getElementById('chk-filter-outgoing').checked = appSettings.filterOutgoing !== false;
    document.getElementById('sel-filter-action').value = appSettings.filterAction || 'block';
    document.getElementById('inp-custom-blocklist').value = appSettings.customBlockedWords || '';

    document.getElementById('set-mic-vol').value = appSettings.micVolume;
    document.getElementById('lbl-mic-vol').textContent = appSettings.micVolume + '%';
    document.getElementById('set-out-vol').value = appSettings.outVolume;
    document.getElementById('lbl-out-vol').textContent = appSettings.outVolume + '%';
    document.getElementById('set-cam-res').value = appSettings.camRes || '720';
    document.getElementById('chk-auto-overlay').checked = appSettings.autoOverlay !== false;
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
    setMobActiveTab('mob-tab-chat');
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

  function saveSafetySettings() {
    appSettings.filterSexual = document.getElementById('chk-filter-sexual').checked;
    appSettings.filterGore = document.getElementById('chk-filter-gore').checked;
    appSettings.filterOutgoing = document.getElementById('chk-filter-outgoing').checked;
    appSettings.filterAction = document.getElementById('sel-filter-action').value || 'block';
    appSettings.customBlockedWords = document.getElementById('inp-custom-blocklist').value.trim();
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    rerenderChatMessages();
    renderUsers(lastMembers);
    applyNickUI();
  }

  function selectBannerColor(col) {
    myProfile.bannerColor = col;
    updateProfilePreview(false);
  }
  function selectAvatarColor(col) {
    myProfile.avatarColor = col;
    updateProfilePreview(false);
  }

  function updateProfilePreview(skipOnlineSync) {
    const n = document.getElementById('prof-nick-inp').value.trim().slice(0, 24) || myNick;
    const pr = document.getElementById('prof-presence-sel').value || 'online';
    const st = document.getElementById('prof-status-inp').value.trim().slice(0, 60);
    const bio = document.getElementById('prof-bio-inp').value.trim().slice(0, 220);
    const intr = document.getElementById('prof-interests-inp').value.trim().slice(0, 160);

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

    if (!skipOnlineSync) {
      myNick = n;
      myProfile.presence = pr;
      myProfile.customStatus = st;
      myProfile.bio = bio;
      myProfile.interests = intr;
      try {
        localStorage.setItem('cyber_nick', myNick);
        localStorage.setItem('cyber_profile', JSON.stringify(myProfile));
      } catch (e) {}
      setPersistCookie('cyber_nick', myNick);
      applyNickUI();
      saveLocalVault();

      if (profileSyncTimer) clearTimeout(profileSyncTimer);
      profileSyncTimer = setTimeout(function () {
        syncProfileToServer();
      }, 350);
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
    updateProfilePreview(false);
    await syncProfileToServer();
    closeSettingsModal();
  }

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
    appSettings.autoOverlay = document.getElementById('chk-auto-overlay').checked;
    appSettings.noiseSuppression = document.getElementById('chk-noise').checked;
    appSettings.echoCancellation = document.getElementById('chk-echo').checked;
    appSettings.autoGainControl = document.getElementById('chk-agc').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll();
    updateFloatingOverlayUI();
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
    myVerified = false;
    openAuthModal(true);
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

    if (appSettings.filterOutgoing !== false) {
      const myViol = checkContentViolation(text);
      if (myViol.length > 0) {
        alert('🛡️ Отправка заблокирована вашим фильтром безопасности (' + myViol.join(', ') + ').');
        return;
      }
    }

    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, channel: currentChannel, author: myNick, text: text })
    }).catch(function () { alert('Не удалось отправить сообщение.'); });
    inp.value = '';
  }

  function setChannel(ch) {
    currentChannel = ch;
    unreadByChannel[ch] = 0;
    updateBrowserUrl();
    applyChannelUI(ch);
    renderServerChannels();
    cachedMessages = roomMessagesCache[ch] || [];
    rerenderChatMessages();
    closeMobileDrawers();
  }

  function selectVoiceChannel(vch) {
    if (!myVerified) {
      openAuthModal(true);
      return;
    }
    currentVoiceChannel = vch;
    updateVoicePanelUI();
    renderServerChannels();
    closeMobileDrawers();
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
    closeMobileDrawers();
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
        body: JSON.stringify({ uid: myUid, nick: myNick, name: name, desc: desc })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      closeCreateServerModal();
      await switchServer(data.serverId);
    } catch (e) {
      alert('Ошибка создания сервера.');
    }
  }

  function openCreateChannelModal(type) {
    if (!myVerified) return openAuthModal(true);
    closeMobileDrawers();
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
        body: JSON.stringify({ uid: myUid, nick: myNick, room: currentRoom, type: pendingChannelType, name: name })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);
      closeCreateChannelModal();
      if (pendingChannelType === 'text' && data.channel) {
        if (!roomMessagesCache[data.channel]) roomMessagesCache[data.channel] = [];
        if (currentServerMeta.textChannels && !currentServerMeta.textChannels.includes(data.channel)) {
          currentServerMeta.textChannels.push(data.channel);
        }
        saveLocalVault();
        setChannel(data.channel);
      } else if (pendingChannelType === 'voice' && data.channel) {
        if (currentServerMeta.voiceChannels && !currentServerMeta.voiceChannels.includes(data.channel)) {
          currentServerMeta.voiceChannels.push(data.channel);
        }
        currentVoiceChannel = data.channel;
        saveLocalVault();
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
    closeMobileDrawers();
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

    saveLocalVault();
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
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(dst);
      osc.start();
      return dst.stream;
    } catch (e) {
      return null;
    }
  }

  function resetVoiceUI() {
    document.getElementById('connect-voice-btn').textContent = 'ПОДКЛЮЧИТЬСЯ';
    document.getElementById('connect-voice-btn').className = 'btn-cyan';
    document.getElementById('mute-btn').style.display = 'none';
    document.getElementById('deafen-btn').style.display = 'none';
    document.getElementById('mute-btn').textContent = '🎤 Микр. вкл';
    document.getElementById('deafen-btn').textContent = '🎧 Звук вкл';
    document.getElementById('screen-btn').textContent = '🖥️ Экран';
    document.getElementById('screen-btn').classList.remove('active-screen');
    document.getElementById('cam-btn').textContent = '📷 Камера';
    document.getElementById('cam-btn').classList.remove('active-cam');
    document.getElementById('voice-active-area').classList.remove('show');
    document.getElementById('audio-box').innerHTML = '';
    document.getElementById('screen-grid').innerHTML = '';
    stopBackgroundCallPersistence();
    renderServerChannels();
  }

  async function ensureVoiceConnected() {
    if (!myVerified) {
      openAuthModal(true);
      return false;
    }
    if (inVoice && peer && myPeerId) return true;
    try {
      rawMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: appSettings.micDeviceId ? { ideal: appSettings.micDeviceId } : undefined,
          noiseSuppression: appSettings.noiseSuppression !== false,
          echoCancellation: appSettings.echoCancellation !== false,
          autoGainControl: appSettings.autoGainControl !== false
        }
      });
      localStream = createProcessedAudioStream(rawMicStream);
      isMuted = false;
    } catch (e) {
      localStream = createSilentAudioStream();
      isMuted = true;
    }
    inVoice = true;
    if (appSettings.soundVoice) playUiBeep(720, 0.09);
    document.getElementById('connect-voice-btn').textContent = 'ОТКЛЮЧИТЬСЯ';
    document.getElementById('connect-voice-btn').className = 'btn-danger';
    document.getElementById('mute-btn').style.display = 'inline-block';
    document.getElementById('deafen-btn').style.display = 'inline-block';
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Без микр.' : '🎤 Микр. вкл';
    document.getElementById('voice-active-area').classList.add('show');
    startBackgroundCallPersistence();
    renderServerChannels();

    return new Promise(function (resolve) {
      peer = new Peer();
      peer.on('open', function (id) {
        myPeerId = id;
        postVoiceState({
          inVoice: true,
          inScreen: inScreen,
          inCam: inWebcam,
          peerId: id,
          voiceChannel: currentVoiceChannel
        }).then(function () { resolve(true); });
      });
      peer.on('call', function (call) {
        const kind = (call.metadata && call.metadata.kind) || 'audio';
        const callerNick = (call.metadata && call.metadata.nick) || 'Участник';
        if (kind === 'screen') {
          call.answer();
          call.on('stream', function (remoteScreenStream) {
            renderMediaTile('screen-' + call.peer, remoteScreenStream, callerNick + ' (Экран)', false, 'screen');
          });
          call.on('close', function () { removeMediaTile('screen-' + call.peer); });
          call.on('error', function () { removeMediaTile('screen-' + call.peer); });
        } else if (kind === 'cam') {
          call.answer();
          call.on('stream', function (remoteCamStream) {
            renderMediaTile('cam-' + call.peer, remoteCamStream, callerNick + ' (Камера)', false, 'cam');
          });
          call.on('close', function () { removeMediaTile('cam-' + call.peer); });
          call.on('error', function () { removeMediaTile('cam-' + call.peer); });
        } else {
          call.answer(localStream || undefined);
          call.on('stream', function (remoteStream) { playStream(call.peer, remoteStream); });
          call.on('close', function () { removeAudio(call.peer); });
          call.on('error', function () { removeAudio(call.peer); });
        }
      });
      peer.on('error', function () { resolve(false); });
    });
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (inScreen) stopScreenShare(true);
      if (inWebcam) stopWebcam(true);
      if (rawMicStream) rawMicStream.getTracks().forEach(function (t) { t.stop(); });
      if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
      if (peer) peer.destroy();
      rawMicStream = null;
      localStream = null;
      peer = null;
      myPeerId = null;
      inVoice = false;
      isMuted = false;
      isDeafened = false;
      if (appSettings.soundVoice) playUiBeep(420, 0.09);
      resetVoiceUI();
      postVoiceState({ inVoice: false, inScreen: false, inCam: false });
      return;
    }
    await ensureVoiceConnected();
  }

  function callPeerWithWebcam(remotePid) {
    if (!peer || !webcamStream || !remotePid || remotePid === myPeerId) return;
    if (camCalls[remotePid]) {
      try { camCalls[remotePid].close(); } catch (e) {}
    }
    const call = peer.call(remotePid, webcamStream, {
      metadata: { kind: 'cam', nick: myNick, voiceChannel: currentVoiceChannel }
    });
    if (call) {
      camCalls[remotePid] = call;
      call.on('close', function () { delete camCalls[remotePid]; });
      call.on('error', function () { delete camCalls[remotePid]; });
    }
  }

  async function toggleWebcam() {
    if (!myVerified) return openAuthModal(true);
    if (inWebcam) {
      stopWebcam(false);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Ваш браузер не поддерживает веб-камеру.');
      return;
    }
    const isHD = (appSettings.camRes || '720') === '720';
    let camStream;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: appSettings.camDeviceId ? { ideal: appSettings.camDeviceId } : undefined,
          width: { ideal: isHD ? 1280 : 854 },
          height: { ideal: isHD ? 720 : 480 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });
    } catch (e) {
      alert('Разрешите доступ к веб-камере в браузере!');
      return;
    }

    const ok = await ensureVoiceConnected();
    if (!ok) {
      camStream.getTracks().forEach(function (t) { t.stop(); });
      return;
    }

    webcamStream = camStream;
    inWebcam = true;
    document.getElementById('cam-btn').textContent = '🛑 Выкл камеру';
    document.getElementById('cam-btn').classList.add('active-cam');
    document.getElementById('voice-active-area').classList.add('show');

    const vTrack = webcamStream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.onended = function () { stopWebcam(false); };
    }

    renderMediaTile('cam-local', webcamStream, myNick + ' (Ваша камера)', true, 'cam');

    const data = await postVoiceState({
      inVoice: true,
      inScreen: inScreen,
      inCam: true,
      peerId: myPeerId,
      voiceChannel: currentVoiceChannel
    });

    if (data && Array.isArray(data.peers)) {
      data.peers.forEach(function (remotePid) {
        callPeerWithWebcam(remotePid);
      });
    }
    updateFloatingOverlayUI();
  }

  function stopWebcam(silent) {
    if (webcamStream) {
      webcamStream.getTracks().forEach(function (t) { t.stop(); });
      webcamStream = null;
    }
    Object.keys(camCalls).forEach(function (pid) {
      try { camCalls[pid].close(); } catch (e) {}
    });
    camCalls = {};
    inWebcam = false;
    document.getElementById('cam-btn').textContent = '📷 Камера';
    document.getElementById('cam-btn').classList.remove('active-cam');
    removeMediaTile('cam-local');
    if (!silent && inVoice) {
      postVoiceState({
        inVoice: true,
        inScreen: inScreen,
        inCam: false,
        peerId: myPeerId,
        voiceChannel: currentVoiceChannel
      });
    }
    updateFloatingOverlayUI();
  }

  function callPeerWithScreen(remotePid) {
    if (!peer || !screenStream || !remotePid || remotePid === myPeerId) return;
    if (screenCalls[remotePid]) {
      try { screenCalls[remotePid].close(); } catch (e) {}
    }
    const call = peer.call(remotePid, screenStream, {
      metadata: { kind: 'screen', nick: myNick, voiceChannel: currentVoiceChannel }
    });
    if (call) {
      screenCalls[remotePid] = call;
      call.on('close', function () { delete screenCalls[remotePid]; });
      call.on('error', function () { delete screenCalls[remotePid]; });
    }
  }

  async function toggleScreenShare() {
    if (!myVerified) return openAuthModal(true);
    if (inScreen) {
      stopScreenShare(false);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('На этом устройстве демонстрация экрана не поддерживается (используйте кнопку «📷 Камера»).');
      return;
    }
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: { ideal: 30, max: 60 } },
        audio: true
      });
    } catch (e) {
      return;
    }

    const ok = await ensureVoiceConnected();
    if (!ok) {
      displayStream.getTracks().forEach(function (t) { t.stop(); });
      return;
    }

    screenStream = displayStream;
    inScreen = true;
    document.getElementById('screen-btn').textContent = '🛑 Стоп экран';
    document.getElementById('screen-btn').classList.add('active-screen');
    document.getElementById('voice-active-area').classList.add('show');

    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = function () {
        stopScreenShare(false);
      };
    }

    renderMediaTile('screen-local', screenStream, myNick + ' (Ваш экран / окно)', true, 'screen');

    const data = await postVoiceState({
      inVoice: true,
      inScreen: true,
      inCam: inWebcam,
      peerId: myPeerId,
      voiceChannel: currentVoiceChannel
    });

    if (data && Array.isArray(data.peers)) {
      data.peers.forEach(function (remotePid) {
        callPeerWithScreen(remotePid);
      });
    }
    updateFloatingOverlayUI();
  }

  function stopScreenShare(silent) {
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      screenStream = null;
    }
    Object.keys(screenCalls).forEach(function (pid) {
      try { screenCalls[pid].close(); } catch (e) {}
    });
    screenCalls = {};
    inScreen = false;
    document.getElementById('screen-btn').textContent = '🖥️ Экран';
    document.getElementById('screen-btn').classList.remove('active-screen');
    removeMediaTile('screen-local');
    if (!silent && inVoice) {
      postVoiceState({
        inVoice: true,
        inScreen: false,
        inCam: inWebcam,
        peerId: myPeerId,
        voiceChannel: currentVoiceChannel
      });
    }
    updateFloatingOverlayUI();
  }

  function renderMediaTile(id, stream, title, isLocal, kind) {
    const grid = document.getElementById('screen-grid');
    let card = document.getElementById('media-tile-' + id);
    const icon = kind === 'cam' ? '📷 ' : '🖥️ ';
    if (!card) {
      card = el('div', 'screen-card');
      card.id = 'media-tile-' + id;

      const head = el('div', 'screen-card-head');
      const left = el('div', '');
      const nameSpan = el('span', 'screen-title-text', icon + title);
      const pill = el('span', 'screen-live-pill' + (kind === 'cam' ? ' cam' : ''), kind === 'cam' ? 'КАМЕРА' : 'СТРИМ');
      left.appendChild(nameSpan);
      left.appendChild(pill);

      const right = el('div', '');
      right.style.cssText = 'display:flex;gap:6px;align-items:center;';

      if (!isLocal) {
        const blockBtn = el('button', 'btn-fs', '🛡️ Скрыть 18+');
        blockBtn.title = 'Скрыть этот видеопоток (фильтр безопасности)';
        blockBtn.onclick = function () { removeMediaTile(id); };
        right.appendChild(blockBtn);
      }

      const pipVidBtn = el('button', 'btn-fs', '🪟 Поверх окон');
      pipVidBtn.title = 'Закрепить это видео поверх всех окон (не пропадает при сворачивании браузера)';
      pipVidBtn.onclick = function () {
        const vid = card.querySelector('video');
        if (vid && vid.requestPictureInPicture) {
          vid.requestPictureInPicture().catch(function () {});
        } else {
          toggleExternalOverlay();
        }
      };
      right.appendChild(pipVidBtn);

      const fsBtn = el('button', 'btn-fs', '⛶ Полный экран');
      fsBtn.onclick = function () {
        const vid = card.querySelector('video');
        if (!vid) return;
        if (vid.requestFullscreen) vid.requestFullscreen();
        else if (vid.webkitRequestFullscreen) vid.webkitRequestFullscreen();
      };
      right.appendChild(fsBtn);

      if (isLocal) {
        const stopBtn = el('button', 'btn-fs', '✕ Выкл');
        stopBtn.style.borderColor = '#f43f5e';
        stopBtn.style.color = '#fda4af';
        stopBtn.onclick = function () {
          if (kind === 'cam') stopWebcam(false);
          else stopScreenShare(false);
        };
        right.appendChild(stopBtn);
      }

      head.appendChild(left);
      head.appendChild(right);

      const wrap = el('div', 'screen-video-wrap');
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      if (isLocal) video.muted = true;
      wrap.appendChild(video);

      card.appendChild(head);
      card.appendChild(wrap);
      grid.appendChild(card);
    } else {
      const t = card.querySelector('.screen-title-text');
      if (t) t.textContent = icon + title;
    }
    const videoEl = card.querySelector('video');
    if (videoEl && videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      videoEl.play().catch(function () {});
    }
  }

  function removeMediaTile(id) {
    const card = document.getElementById('media-tile-' + id);
    if (card) card.remove();
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    if (rawMicStream) rawMicStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл';
    updateFloatingOverlayUI();
  }

  function toggleDeafen() {
    isDeafened = !isDeafened;
    document.getElementById('deafen-btn').textContent = isDeafened ? '🔇 Звук выкл' : '🎧 Звук вкл';
    applyOutputVolumeToAll();
    updateFloatingOverlayUI();
  }

  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const audio = document.createElement('audio');
    audio.id = 'aud-' + id;
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    document.getElementById('audio-box').appendChild(audio);
    applyOutputVolumeToAll();
    audio.play().catch(function () {});
  }

  function removeAudio(id) {
    const el = document.getElementById('aud-' + id);
    if (el) el.remove();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeSettingsModal();
      closeViewProfileModal();
      closeInviteModal();
      closeMobileDrawers();
    }
  });
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

    // Двусторонняя синхронизация хранилища (мгновенно восстанавливает друзей, серверы и каналы после обновления server.js)
    if (req.method === 'POST' && url.pathname === '/api/vault-sync') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Invalid UID' });
      const room = safeRoom(body.room);
      restoreClientVault(body);
      const meta = ensureServer(room);
      addMember(room, uid);
      broadcastServers();
      notifyAllRoomsOfUser(uid);
      notifyFriendsOf(uid);
      sendSocial(uid);
      return sendJson(res, 200, {
        ok: true,
        current: meta,
        list: Object.values(serversMeta),
        messagesByChannel: getRoom(room),
        users: memberList(room),
        social: socialState(uid)
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/tg-init') {
      const token = crypto.randomBytes(12).toString('hex');
      pendingTgTokens[token] = {
        expires: Date.now() + CODE_TTL_MS,
        completed: null
      };
      return sendJson(res, 200, {
        enabled: !!telegramBotUsername,
        botUsername: telegramBotUsername,
        token: token
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/tg-check') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      const entry = pendingTgTokens[token];
      if (!entry || entry.expires < Date.now() || !entry.completed) {
        return sendJson(res, 200, { ok: true, verified: false });
      }
      const tgInfo = entry.completed;
      delete pendingTgTokens[token];

      const room = safeRoom(body.room);
      const prevUid = validUid(body.uid) ? body.uid : null;
      const finalUid = tgIdToUid[tgInfo.tgId] || uidFromTgId(tgInfo.tgId);
      const existingNick = users[finalUid] && users[finalUid].verified ? users[finalUid].nick : '';
      const chosenNick = cleanNick(body.nick || existingNick || tgInfo.firstName || tgInfo.username || 'Странник');

      const u = mergeAccount(prevUid, finalUid, chosenNick, tgInfo.tgId, tgInfo.username, '');
      addMember(room, finalUid);

      clients.forEach(x => {
        if (x.id === body.id || x.uid === prevUid || x.uid === finalUid) {
          x.uid = finalUid;
          x.nick = u.nick;
        }
      });

      scheduleSave(room);
      notifyAllRoomsOfUser(finalUid);
      notifyFriendsOf(finalUid);
      sendSocial(finalUid);

      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick });
    }

    if (req.method === 'POST' && url.pathname === '/api/tg-verify-code') {
      const body = await readBody(req);
      const code = String(body.code || '').trim();
      const entry = tgCodes[code];
      if (!entry || entry.expires < Date.now()) {
        return sendJson(res, 400, { error: 'Неверный или просроченный код! Нажмите /start в Telegram-боте.' });
      }
      delete tgCodes[code];

      const room = safeRoom(body.room);
      const prevUid = validUid(body.uid) ? body.uid : null;
      const finalUid = tgIdToUid[entry.tgId] || uidFromTgId(entry.tgId);
      const existingNick = users[finalUid] && users[finalUid].verified ? users[finalUid].nick : '';
      const chosenNick = cleanNick(body.nick || existingNick || entry.firstName || entry.username || 'Странник');

      const u = mergeAccount(prevUid, finalUid, chosenNick, entry.tgId, entry.username, '');
      addMember(room, finalUid);

      clients.forEach(x => {
        if (x.id === body.id || x.uid === prevUid || x.uid === finalUid) {
          x.uid = finalUid;
          x.nick = u.nick;
        }
      });

      scheduleSave(room);
      notifyAllRoomsOfUser(finalUid);
      notifyFriendsOf(finalUid);
      sendSocial(finalUid);

      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = String(url.searchParams.get('id') || '').slice(0, 32);
      const room = safeRoom(url.searchParams.get('room'));
      const nick = cleanNick(url.searchParams.get('nick') || 'Гость');
      const uid = url.searchParams.get('uid');
      const clientVerified = url.searchParams.get('verified') === '1';
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
      const user = ensureUser(uid, nick, clientVerified);
      addMember(room, uid);

      const client = { id, uid, room, nick: user.nick, inVoice: false, inScreen: false, inCam: false, peerId: null, voiceChannel: null, res };
      clients.push(client);

      res.write('data: ' + JSON.stringify({
        type: 'server-meta',
        payload: {
          current: meta,
          list: Object.values(serversMeta),
          messagesByChannel: getRoom(room)
        }
      }) + '\n\n');

      notifyAllRoomsOfUser(uid);
      sendSocial(uid);
      notifyFriendsOf(uid);

      req.on('close', () => {
        const oldPeerId = client.peerId;
        const wasScreen = client.inScreen;
        const wasCam = client.inCam;
        const oldRoom = client.room;
        clients = clients.filter(c => c !== client);
        if (wasScreen && oldPeerId) {
          broadcast(oldRoom, 'screen-stop', { peerId: oldPeerId });
        }
        if (wasCam && oldPeerId) {
          broadcast(oldRoom, 'cam-stop', { peerId: oldPeerId });
        }
        notifyAllRoomsOfUser(uid);
        notifyFriendsOf(uid);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/switch-room') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Некорректный ID' });
      const newRoom = safeRoom(body.room);
      const meta = ensureServer(newRoom);
      ensureUser(uid, body.nick || 'Участник', true);
      addMember(newRoom, uid);

      let oldRoom = null;
      clients.forEach(c => {
        if (c.id === body.id || c.uid === uid) {
          oldRoom = c.room;
          c.room = newRoom;
          c.inVoice = false;
          c.inScreen = false;
          c.inCam = false;
          c.peerId = null;
          c.voiceChannel = null;
        }
      });

      if (oldRoom && oldRoom !== newRoom) broadcastUsers(oldRoom);
      broadcastUsers(newRoom);

      return sendJson(res, 200, {
        ok: true,
        current: meta,
        list: Object.values(serversMeta),
        messagesByChannel: getRoom(newRoom),
        users: memberList(newRoom)
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/room-data') {
      const room = safeRoom(url.searchParams.get('room'));
      ensureServer(room);
      return sendJson(res, 200, {
        room: room,
        messagesByChannel: getRoom(room)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) return sendJson(res, 400, { error: 'Некорректный ID' });
      const u = ensureUser(uid, body.nick, true);
      if (body.nick) {
        const cleanN = cleanNick(body.nick);
        u.nick = cleanN;
        nickToUid[cleanN.toLowerCase()] = uid;
        clients.forEach(c => { if (c.uid === uid) c.nick = cleanN; });
      }
      if (body.bio !== undefined) u.bio = cleanText(body.bio, 220);
      if (body.interests !== undefined) u.interests = cleanText(body.interests, 160);
      if (body.customStatus !== undefined) u.customStatus = cleanText(body.customStatus, 60);
      if (body.presence !== undefined) u.presence = cleanPresence(body.presence);
      if (body.bannerColor !== undefined) u.bannerColor = cleanColor(body.bannerColor, '#0d9488');
      if (body.avatarColor !== undefined) u.avatarColor = cleanColor(body.avatarColor, '#e11d48');

      scheduleSave();
      notifyAllRoomsOfUser(uid);
      notifyFriendsOf(uid);
      sendSocial(uid);
      return sendJson(res, 200, { ok: true });
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

    if (req.method === 'POST' && url.pathname === '/api/auth-password') {
      const body = await readBody(req);
      const nick = cleanNick(body.nick);
      const pass = String(body.password || '');
      const room = safeRoom(body.room);
      const prevUid = validUid(body.uid) ? body.uid : null;

      if (!nick || nick.length < 2) {
        return sendJson(res, 400, { error: 'Введите корректный позывной!' });
      }

      if (prevUid && users[prevUid] && users[prevUid].verified && !pass) {
        const key = nick.toLowerCase();
        if (nickToUid[key] && nickToUid[key] !== prevUid) {
          return sendJson(res, 400, { error: 'Этот позывной уже занят!' });
        }
        users[prevUid].nick = nick;
        nickToUid[key] = prevUid;
        clients.forEach(x => {
          if (x.uid === prevUid) x.nick = nick;
        });
        scheduleSave(room);
        notifyAllRoomsOfUser(prevUid);
        notifyFriendsOf(prevUid);
        sendSocial(prevUid);
        return sendJson(res, 200, { ok: true, uid: prevUid, pid: users[prevUid].pid, nick: nick });
      }

      if (pass.length < 4) {
        return sendJson(res, 400, { error: 'Пароль должен содержать минимум 4 символа!' });
      }

      const key = nick.toLowerCase();
      const existingUid = nickToUid[key];

      if (existingUid && users[existingUid] && users[existingUid].passHash) {
        if (!verifyPassword(pass, users[existingUid].passHash)) {
          return sendJson(res, 400, { error: 'Этот позывной уже занят или введён неверный пароль!' });
        }
        const u = mergeAccount(prevUid, existingUid, nick, '', '', '');
        u.nick = nick;
        addMember(room, existingUid);
        clients.forEach(x => {
          if (x.id === body.id || x.uid === prevUid || x.uid === existingUid) {
            x.uid = existingUid;
            x.nick = u.nick;
          }
        });
        scheduleSave(room);
        notifyAllRoomsOfUser(existingUid);
        notifyFriendsOf(existingUid);
        sendSocial(existingUid);
        return sendJson(res, 200, { ok: true, uid: existingUid, pid: u.pid, nick: u.nick });
      }

      const finalUid = existingUid || (prevUid && (!users[prevUid] || !users[prevUid].verified) ? prevUid : crypto.randomBytes(16).toString('hex'));
      const passHash = hashPassword(pass);
      const u = mergeAccount(prevUid, finalUid, nick, '', '', passHash);
      u.nick = nick;
      addMember(room, finalUid);

      clients.forEach(x => {
        if (x.id === body.id || x.uid === prevUid || x.uid === finalUid) {
          x.uid = finalUid;
          x.nick = u.nick;
        }
      });

      scheduleSave(room);
      notifyAllRoomsOfUser(finalUid);
      notifyFriendsOf(finalUid);
      sendSocial(finalUid);

      return sendJson(res, 200, { ok: true, uid: finalUid, pid: u.pid, nick: u.nick });
    }

    if (req.method === 'POST' && url.pathname === '/api/server/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) {
        return sendJson(res, 400, { error: 'Сначала войдите в аккаунт!' });
      }
      const u = ensureUser(uid, body.nick || 'Участник', true);
      if (Object.keys(serversMeta).length >= MAX_SERVERS) {
        return sendJson(res, 400, { error: 'Достигнут лимит серверов' });
      }
      const name = String(body.name || '').trim().slice(0, 28);
      const desc = String(body.desc || '').trim().slice(0, 80);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера!' });

      const newId = 'cy-' + crypto.randomBytes(2).toString('hex');
      ensureServer(newId, name, desc);
      addMember(newId, uid);
      rooms[newId]['игровая-комната'].push({
        author: 'СИСТЕМА СИГНАЛ',
        time: '00:00',
        text: 'Сервер «' + name + '» создан участником ' + u.nick + '! Приглашайте друзей по прямой ссылке.'
      });
      scheduleSave(newId);
      broadcastServers();
      return sendJson(res, 200, { ok: true, serverId: newId });
    }

    if (req.method === 'POST' && url.pathname === '/api/channel/create') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) {
        return sendJson(res, 400, { error: 'Сначала войдите в аккаунт!' });
      }
      ensureUser(uid, body.nick || 'Участник', true);
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
      const uid = c ? c.uid : body.uid;
      if (!validUid(uid)) {
        return sendJson(res, 403, { error: 'Войдите в аккаунт для отправки сообщений' });
      }
      const u = ensureUser(uid, body.author || (c && c.nick) || 'Участник', true);
      const author = u.nick;

      const now = new Date();
      const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const flags = detectContentFlags(text);
      const msg = { author, time, text, flags };

      const rObj = getRoom(room);
      if (!rObj[channel]) rObj[channel] = [];
      const list = rObj[channel];
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      scheduleSave(room);

      broadcast(room, 'msg', { channel, msg });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req);
      const uid = body.uid;
      if (!validUid(uid)) {
        return sendJson(res, 400, { error: 'Сначала войдите в аккаунт!' });
      }
      const me = ensureUser(uid, 'Участник', true);
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
      notifyAllRoomsOfUser(uid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req);
      const c = clients.find(x => x.id === body.id);
      let peers = [];
      if (c) {
        const wasScreen = c.inScreen;
        const wasCam = c.inCam;
        const oldPeerId = c.peerId;
        c.inVoice = !!body.inVoice;
        c.inScreen = !!(c.inVoice && body.inScreen);
        c.inCam = !!(c.inVoice && body.inCam);
        c.peerId = body.peerId ? String(body.peerId).slice(0, 64) : null;
        c.voiceChannel = c.inVoice ? safeVoiceChannel(c.room, body.voiceChannel) : null;

        if (wasScreen && !c.inScreen && (c.peerId || oldPeerId)) {
          broadcast(c.room, 'screen-stop', { peerId: c.peerId || oldPeerId });
        }
        if (wasCam && !c.inCam && (c.peerId || oldPeerId)) {
          broadcast(c.room, 'cam-stop', { peerId: c.peerId || oldPeerId });
        }

        broadcastUsers(c.room);
        if (c.inVoice && c.peerId) {
          broadcast(c.room, 'voice-join', { peerId: c.peerId, voiceChannel: c.voiceChannel });
          peers = clients
            .filter(x => x.room === c.room && x.inVoice && x.peerId && x.peerId !== c.peerId && x.voiceChannel === c.voiceChannel)
            .map(x => x.peerId);
        }
      }
      return sendJson(res, 200, { ok: true, peers });
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
    startTelegramBotPolling();
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