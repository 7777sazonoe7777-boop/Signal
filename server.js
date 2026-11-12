const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const DEFAULT_TEXT_CHANNELS = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
const DEFAULT_VOICE_CHANNELS = ['Ночной эфир'];
const MAX_HISTORY = 500, MAX_CHANNELS = 40, MAX_SERVERS = 100, MAX_MEMBERS = 500, MAX_FRIENDS = 200;
const MAX_BODY = 6 * 1024 * 1024, CODE_TTL_MS = 10 * 60 * 1000;

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBotUsername = '', tgUpdateOffset = 0;

const serversMeta = Object.create(null), rooms = Object.create(null);
const tgCodes = Object.create(null), pendingTgTokens = Object.create(null), deviceLinkCodes = Object.create(null);
const users = Object.create(null), pidToUid = Object.create(null);
const tgIdToUid = Object.create(null), nickToUid = Object.create(null), members = Object.create(null);
let clients = [];
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const SEXUAL_RX = [/порн/i, /секс/i, /эротик/i, /интим/i, /хентай/i, /минет/i, /трах/i, /шлюх/i, /проститут/i, /сиськ/i, /вагин/i, /член/i, /голая/i, /голые/i, /обнажен/i, /porn/i, /nsfw/i, /xxx/i, /hentai/i, /onlyfans/i, /xvideos/i, /pornhub/i, /rule34/i, /nude/i, /boobs/i, /pussy/i, /dick/i];
const GORE_RX = [/расчлен/i, /кишки/i, /труп/i, /казнь/i, /пытк/i, /убийств/i, /самоубийств/i, /суицид/i, /резня/i, /кровопролит/i, /увечь/i, /жесть/i, /насили/i, /террор/i, /gore/i, /liveleak/i, /bestgore/i, /behead/i, /torture/i, /suicide/i, /murder/i];

const detectFlags = t => ({ sexual: SEXUAL_RX.some(r => r.test(String(t || ''))), gore: GORE_RX.some(r => r.test(String(t || ''))) });
const pidOf = uid => crypto.createHash('sha256').update(uid).digest('hex').slice(0, 10);
const uidFromTgId = id => crypto.createHash('sha256').update('signal-tg:' + String(id)).digest('hex').slice(0, 32);
const validUid = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const validPid = v => typeof v === 'string' && /^[a-f0-9]{10}$/.test(v);
const pidList = a => Array.isArray(a) ? Array.from(new Set(a.filter(validPid))).slice(0, MAX_FRIENDS) : [];
const safeRoom = v => /^[\p{L}\p{N}_-]{1,32}$/u.test(String(v || '').trim()) ? String(v).trim() : DEFAULT_ROOM;
const roomList = a => Array.isArray(a) ? Array.from(new Set(a.filter(r => safeRoom(r) === r))).slice(0, MAX_SERVERS) : [];
const cleanChannelName = v => { const s = String(v || '').trim().replace(/\s+/g, '-').slice(0, 28); return /^[\p{L}\p{N}_-]{1,28}$/u.test(s) ? s : ''; };
const cleanNick = v => String(v || '').trim().slice(0, 24) || 'Гость';
const cleanText = (v, m = 160) => String(v || '').trim().slice(0, m);
const cleanColor = (v, def) => /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()) ? String(v).trim() : def;
const cleanPresence = v => ['online', 'idle', 'dnd', 'invisible'].includes(String(v || '').trim()) ? String(v).trim() : 'online';
const cleanImgData = (v, maxLen = 450000) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if ((s.startsWith('data:image/') || s.startsWith('https://') || s.startsWith('/')) && s.length <= maxLen) return s;
  return '';
};

function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(String(pw), s, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const parts = stored.split(':');
  const test = crypto.scryptSync(String(pw), parts[0], 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(parts[1], 'hex'), Buffer.from(test, 'hex'));
}

function ensureServer(room, name, desc, icon) {
  const r = safeRoom(room);
  if (!serversMeta[r]) {
    const title = String(name || (r === DEFAULT_ROOM ? 'Ночной клуб' : r)).trim().slice(0, 28) || r;
    serversMeta[r] = {
      id: r, name: title,
      icon: String(icon || title.slice(0, 2)).trim().toUpperCase().slice(0, 3) || 'СВ',
      desc: String(desc || 'Игры, идеи и разговоры после полуночи').trim().slice(0, 80),
      textChannels: DEFAULT_TEXT_CHANNELS.slice(),
      voiceChannels: DEFAULT_VOICE_CHANNELS.slice()
    };
  }
  if (!rooms[r]) rooms[r] = Object.create(null);
  serversMeta[r].textChannels.forEach(ch => { if (!rooms[r][ch]) rooms[r][ch] = []; });
  return serversMeta[r];
}

ensureServer(DEFAULT_ROOM, 'Ночной клуб', 'Игры, идеи и разговоры после полуночи', 'НК');
ensureServer('hc-node', 'Кибер Узел', 'Технологии, код и ночные эфиры', 'HC');
ensureServer('ma-club', 'Мастерская', 'Музыка, творчество и совместные проекты', 'MA');
if (!rooms[DEFAULT_ROOM]['игровая-комната'].length) {
  rooms[DEFAULT_ROOM]['игровая-комната'].push({
    author: 'СИСТЕМА СИГНАЛ', time: '00:00',
    text: 'Добро пожаловать в «Ночной клуб»! Синхронизация аккаунта между ПК и телефоном активна.'
  });
}

const safeChannel = (r, c) => { const m = ensureServer(r); return m.textChannels.includes(String(c || '').trim()) ? String(c).trim() : m.textChannels[0]; };
const safeVoiceChannel = (r, c) => { const m = ensureServer(r); return m.voiceChannels.includes(String(c || '').trim()) ? String(c).trim() : m.voiceChannels[0]; };
const getRoom = r => (ensureServer(r), rooms[r]);

async function tgApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(35000)
  });
  return res.json();
}

function generateTgCode(tgId, firstName, username) {
  Object.keys(tgCodes).forEach(k => { if (tgCodes[k].tgId === String(tgId) || tgCodes[k].expires < Date.now()) delete tgCodes[k]; });
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  tgCodes[code] = { tgId: String(tgId), firstName: String(firstName || '').trim(), username: String(username || '').trim(), expires: Date.now() + CODE_TTL_MS };
  return code;
}

async function startTelegramBotPolling() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await tgApi('deleteWebhook', { drop_pending_updates: false });
    const me = await tgApi('getMe', {});
    if (me && me.ok && me.result) telegramBotUsername = me.result.username || '';
  } catch (e) { return; }
  (async function loop() {
    while (true) {
      try {
        const d = await tgApi('getUpdates', { offset: tgUpdateOffset, timeout: 25, allowed_updates: ['message'] });
        if (d && d.ok && Array.isArray(d.result)) {
          for (const u of d.result) {
            tgUpdateOffset = u.update_id + 1;
            const m = u.message;
            if (!m || !m.from || !m.chat) continue;
            const tgId = String(m.from.id), firstName = String(m.from.first_name || m.from.username || 'Странник'), username = String(m.from.username || '');
            const code = generateTgCode(tgId, firstName, username);
            const txt = String(m.text || '').trim();
            if (txt.startsWith('/start')) {
              const p = (txt.split(/\s+/)[1] || '');
              if (p.startsWith('auth_')) {
                const pend = pendingTgTokens[p.slice(5)];
                if (pend && pend.expires > Date.now()) pend.completed = { tgId, firstName, username, code };
              }
            }
            await tgApi('sendMessage', { chat_id: m.chat.id, parse_mode: 'Markdown', text: '⚡ *СИГНАЛ // CYBER.NET*\n\n✅ Аккаунт подтверждён!\n🔑 Код: *' + code + '*\n\nВернитесь в приложение.' }).catch(() => {});
          }
        }
      } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}

const REDIS_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const KEY = 'signal:';
const dirtyRooms = new Set();
let loaded = false, saveTimer = null, saving = false, resave = false;

async function redis(cmds) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds), signal: AbortSignal.timeout(8000)
  });
  const data = await res.json();
  return data.map(x => x.result);
}

// Сохраняем в базу ТОЛЬКО зарегистрированных (verified) пользователей! Гости не сохраняются
function usersPart() {
  const o = {};
  Object.keys(users).forEach(uid => {
    if (users[uid] && users[uid].verified) {
      o[uid] = Object.assign({}, users[uid]);
    }
  });
  return o;
}

function scheduleSave(room) {
  if (room) dirtyRooms.add(room);
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
}

async function saveNow() {
  if (!loaded) return;
  if (saving) { resave = true; return; }
  saving = true;
  try {
    if (USE_REDIS) {
      const rs = Array.from(dirtyRooms); dirtyRooms.clear();
      const cmds = [['SET', KEY + 'users', JSON.stringify(usersPart())], ['SET', KEY + 'members', JSON.stringify(members)], ['SET', KEY + 'rooms', JSON.stringify(Object.keys(rooms))], ['SET', KEY + 'servers', JSON.stringify(serversMeta)]];
      rs.forEach(r => { if (rooms[r]) cmds.push(['SET', KEY + 'msg:' + r, JSON.stringify(rooms[r])]); });
      await redis(cmds);
    } else {
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ users: usersPart(), members, servers: serversMeta, messages: rooms }));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    }
  } catch (e) {} finally {
    saving = false;
    if (resave) { resave = false; scheduleSave(); }
  }
}

function applyData(d) {
  if (!d || typeof d !== 'object') return;
  Object.keys(d.servers || {}).forEach(r => {
    if (safeRoom(r) !== r) return;
    const sm = d.servers[r] || {}, meta = ensureServer(r, sm.name, sm.desc, sm.icon);
    (sm.textChannels || []).map(cleanChannelName).filter(Boolean).forEach(c => { if (!meta.textChannels.includes(c) && meta.textChannels.length < MAX_CHANNELS) meta.textChannels.push(c); });
    (sm.voiceChannels || []).map(v => String(v || '').trim().slice(0, 28)).filter(Boolean).forEach(c => { if (!meta.voiceChannels.includes(c) && meta.voiceChannels.length < MAX_CHANNELS) meta.voiceChannels.push(c); });
    meta.textChannels.forEach(ch => { if (!rooms[r][ch]) rooms[r][ch] = []; });
  });
  Object.keys(d.users || {}).forEach(uid => {
    if (!validUid(uid)) return;
    const u = d.users[uid] || {};
    // Пропускаем старых незарегистрированных гостей при загрузке базы
    if (!u.verified && String(u.nick || '').startsWith('Гость_')) return;
    const ex = users[uid] || {};
    const nick = cleanNick(u.nick || ex.nick);
    users[uid] = {
      pid: validPid(u.pid) ? u.pid : (ex.pid || pidOf(uid)), nick,
      tgId: String(u.tgId || ex.tgId || '').trim(), tgUsername: String(u.tgUsername || ex.tgUsername || '').trim(),
      passHash: String(u.passHash || ex.passHash || ''), verified: true,
      bio: cleanText(u.bio !== undefined ? u.bio : ex.bio, 220), interests: cleanText(u.interests !== undefined ? u.interests : ex.interests, 160),
      customStatus: cleanText(u.customStatus !== undefined ? u.customStatus : ex.customStatus, 60), presence: cleanPresence(u.presence || ex.presence),
      bannerColor: cleanColor(u.bannerColor || ex.bannerColor, '#00f0ff'), avatarColor: cleanColor(u.avatarColor || ex.avatarColor, '#3b82f6'),
      avatarImg: cleanImgData(u.avatarImg !== undefined ? u.avatarImg : ex.avatarImg),
      bannerImg: cleanImgData(u.bannerImg !== undefined ? u.bannerImg : ex.bannerImg),
      friends: pidList([].concat(ex.friends || [], u.friends || [])), incoming: pidList([].concat(ex.incoming || [], u.incoming || [])),
      outgoing: pidList([].concat(ex.outgoing || [], u.outgoing || [])), servers: roomList([].concat(ex.servers || [], u.servers || []))
    };
    pidToUid[users[uid].pid] = uid;
    if (users[uid].tgId) tgIdToUid[users[uid].tgId] = uid;
    if (nick) nickToUid[nick.toLowerCase()] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    ensureServer(r);
    const cur = members[r] || (members[r] = []);
    d.members[r].filter(u => validUid(u) && users[u] && users[u].verified).forEach(u => { if (!cur.includes(u) && cur.length < MAX_MEMBERS) cur.push(u); });
  });
  Object.keys(d.messages || {}).forEach(r => {
    if (safeRoom(r) !== r || !d.messages[r]) return;
    const meta = ensureServer(r), rm = getRoom(r);
    Object.keys(d.messages[r]).forEach(ch => {
      const c = cleanChannelName(ch);
      if (!c || !Array.isArray(d.messages[r][ch])) return;
      if (!meta.textChannels.includes(c) && meta.textChannels.length < MAX_CHANNELS) meta.textChannels.push(c);
      const exList = rm[c] || [], seen = new Set(exList.map(m => m.author + '|' + m.time + '|' + m.text));
      d.messages[r][ch].slice(-MAX_HISTORY).forEach(m => {
        const cm = { author: String(m.author || '').slice(0, 24), time: String(m.time || '').slice(0, 5), text: String(m.text || '').slice(0, 1000) };
        cm.flags = detectFlags(cm.text);
        const k = cm.author + '|' + cm.time + '|' + cm.text;
        if (cm.text && !seen.has(k)) { seen.add(k); exList.push(cm); }
      });
      rm[c] = exList.slice(-MAX_HISTORY);
    });
  });
}

async function loadData() {
  if (USE_REDIS) {
    const first = await redis([['GET', KEY + 'users'], ['GET', KEY + 'members'], ['GET', KEY + 'rooms'], ['GET', KEY + 'servers']]);
    const rNames = (first[2] ? JSON.parse(first[2]) : []).filter(n => safeRoom(n) === n);
    const msgs = rNames.length ? await redis(rNames.map(n => ['GET', KEY + 'msg:' + n])) : [];
    const messages = {}; rNames.forEach((n, i) => { if (msgs[i]) messages[n] = JSON.parse(msgs[i]); });
    applyData({ users: first[0] ? JSON.parse(first[0]) : {}, members: first[1] ? JSON.parse(first[1]) : {}, servers: first[3] ? JSON.parse(first[3]) : {}, messages });
  } else if (fs.existsSync(DATA_FILE)) {
    applyData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
  loaded = true;
}

// Создаём постоянную запись ТОЛЬКО для верифицированных пользователей
function ensureUser(uid, nick, ver) {
  let u = users[uid]; const n = cleanNick(nick);
  if (!u) {
    if (!ver) {
      return { pid: pidOf(uid), nick: n, verified: false, bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#00f0ff', avatarColor: '#3b82f6', avatarImg: '', bannerImg: '', friends: [], incoming: [], outgoing: [], servers: [] };
    }
    u = users[uid] = { pid: pidOf(uid), nick: n, tgId: '', tgUsername: '', passHash: '', verified: true, bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#00f0ff', avatarColor: '#3b82f6', avatarImg: '', bannerImg: '', friends: [], incoming: [], outgoing: [], servers: [] };
    pidToUid[u.pid] = uid; nickToUid[n.toLowerCase()] = uid; scheduleSave();
  } else {
    if (ver && !u.verified) { u.verified = true; nickToUid[u.nick.toLowerCase()] = uid; scheduleSave(); }
  }
  return u;
}

// В постоянный список участников сервера добавляем только зарегистрированных
function addMember(room, uid) {
  if (!users[uid] || !users[uid].verified) return;
  const r = safeRoom(room), arr = members[r] || (members[r] = []);
  if (!arr.includes(uid) && arr.length < MAX_MEMBERS) { arr.push(uid); scheduleSave(); }
  if (!users[uid].servers.includes(r)) { users[uid].servers.push(r); scheduleSave(); }
}

function restoreClientVault(v) {
  if (!v || typeof v !== 'object' || !validUid(v.uid) || !users[v.uid] || !users[v.uid].verified) return false;
  const me = users[v.uid];
  if (v.profile) {
    if (!me.bio && v.profile.bio) me.bio = cleanText(v.profile.bio, 220);
    if (!me.interests && v.profile.interests) me.interests = cleanText(v.profile.interests, 160);
    if (!me.customStatus && v.profile.customStatus) me.customStatus = cleanText(v.profile.customStatus, 60);
    if (!me.avatarImg && v.profile.avatarImg) me.avatarImg = cleanImgData(v.profile.avatarImg);
    if (!me.bannerImg && v.profile.bannerImg) me.bannerImg = cleanImgData(v.profile.bannerImg);
  }
  if (Array.isArray(v.servers)) { const so = {}; v.servers.forEach(s => { if (s && s.id) so[s.id] = s; }); applyData({ servers: so }); }
  if (v.messages) applyData({ messages: v.messages });
  scheduleSave();
  return true;
}

function mergeAccount(prevUid, finalUid, nick, tgId, tgUsername, passHash) {
  const prev = (prevUid && users[prevUid]) ? users[prevUid] : {};
  const ex = users[finalUid] || {};
  const u = users[finalUid] = {
    pid: ex.pid || pidOf(finalUid), nick: cleanNick(ex.nick || nick || prev.nick),
    tgId: tgId || ex.tgId || prev.tgId || '', tgUsername: tgUsername || ex.tgUsername || prev.tgUsername || '',
    passHash: passHash || ex.passHash || prev.passHash || '', verified: true,
    bio: ex.bio || prev.bio || '', interests: ex.interests || prev.interests || '',
    customStatus: ex.customStatus || prev.customStatus || '', presence: ex.presence || prev.presence || 'online',
    bannerColor: ex.bannerColor || prev.bannerColor || '#00f0ff', avatarColor: ex.avatarColor || prev.avatarColor || '#3b82f6',
    avatarImg: ex.avatarImg || prev.avatarImg || '', bannerImg: ex.bannerImg || prev.bannerImg || '',
    friends: pidList([].concat(prev.friends || [], ex.friends || [])), incoming: pidList([].concat(prev.incoming || [], ex.incoming || [])),
    outgoing: pidList([].concat(prev.outgoing || [], ex.outgoing || [])), servers: roomList([].concat(prev.servers || [], ex.servers || []))
  };
  if (prevUid && prevUid !== finalUid) {
    Object.keys(members).forEach(r => { const i = members[r].indexOf(prevUid); if (i >= 0) { if (!members[r].includes(finalUid)) members[r][i] = finalUid; else members[r].splice(i, 1); } });
    delete users[prevUid];
  }
  pidToUid[u.pid] = finalUid; if (u.tgId) tgIdToUid[u.tgId] = finalUid; if (u.nick) nickToUid[u.nick.toLowerCase()] = finalUid;
  return u;
}

function publicProfileOf(uid) {
  const u = users[uid]; if (!u) return null;
  const on = clients.some(c => c.uid === uid) && u.presence !== 'invisible';
  return { pid: u.pid, nick: u.nick, tgUsername: u.tgUsername || '', hasPassword: !!u.passHash, verified: !!u.verified, online: on, presence: on ? (u.presence || 'online') : 'offline', bio: u.bio || '', interests: u.interests || '', customStatus: u.customStatus || '', bannerColor: u.bannerColor || '#00f0ff', avatarColor: u.avatarColor || '#3b82f6', avatarImg: u.avatarImg || '', bannerImg: u.bannerImg || '' };
}

function sendSocial(uid) {
  const u = users[uid]; if (!u || !u.verified) return;
  const info = p => (pidToUid[p] && users[pidToUid[p]]) ? publicProfileOf(pidToUid[p]) : { pid: p, nick: 'Друг (' + p.slice(0, 4) + ')', online: false, presence: 'offline' };
  const payload = Object.assign({}, publicProfileOf(uid), { servers: u.servers || [], friends: u.friends.map(info), incoming: u.incoming.map(info), outgoing: u.outgoing.slice() });
  const msg = 'data: ' + JSON.stringify({ type: 'social', payload }) + '\n\n';
  clients.forEach(c => { if (c.uid === uid) c.res.write(msg); });
}

const notifyFriendsOf = uid => { if (users[uid]) users[uid].friends.forEach(p => { if (pidToUid[p]) sendSocial(pidToUid[p]); }); };
const broadcast = (r, type, payload) => { const d = 'data: ' + JSON.stringify({ type, payload }) + '\n\n'; clients.forEach(c => { if (c.room === r) c.res.write(d); }); };
const broadcastAll = (type, payload) => { const d = 'data: ' + JSON.stringify({ type, payload }) + '\n\n'; clients.forEach(c => c.res.write(d)); };

function memberList(room) {
  const on = new Map();
  clients.forEach(c => {
    if (!c.uid || !users[c.uid] || !users[c.uid].verified) return;
    const pr = on.get(c.uid), ir = c.room === room;
    on.set(c.uid, { inVoice: !!(pr && pr.inVoice) || (ir && !!c.inVoice), inScreen: !!(pr && pr.inScreen) || (ir && !!c.inScreen), inCam: !!(pr && pr.inCam) || (ir && !!c.inCam), voiceChannel: (ir && c.inVoice) ? c.voiceChannel : (pr ? pr.voiceChannel : null) });
  });
  const savedUids = (members[room] || []).filter(uid => users[uid] && users[uid].verified);
  return savedUids.map(uid => {
    const u = users[uid], o = on.get(uid), isOn = !!o && u.presence !== 'invisible';
    return { pid: u.pid, nick: u.nick, verified: true, online: isOn, presence: isOn ? (u.presence || 'online') : 'offline', customStatus: u.customStatus || '', bio: u.bio || '', interests: u.interests || '', bannerColor: u.bannerColor || '#00f0ff', avatarColor: u.avatarColor || '#3b82f6', avatarImg: u.avatarImg || '', bannerImg: u.bannerImg || '', inVoice: !!(o && o.inVoice), inScreen: !!(o && o.inScreen), inCam: !!(o && o.inCam), voiceChannel: o ? o.voiceChannel : null };
  });
}

const broadcastUsers = r => broadcast(r, 'users', memberList(r));
const notifyAllRoomsOfUser = uid => Object.keys(members).forEach(r => { if (members[r] && members[r].includes(uid)) broadcastUsers(r); });
const broadcastServers = () => broadcastAll('servers', { list: Object.values(serversMeta) });
setInterval(() => clients.forEach(c => c.res.write(': ping\n\n')), 25000);

const HTML_PAGE = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#04070d">
<title>СИГНАЛ // CYBER.NET</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root {
    --bg-darkest:#04070d; --bg-servers:#050911; --bg-channels:#070d17; --bg-chat:#08101c;
    --bg-members:#070d17; --bg-userbar:#040810; --bg-card:rgba(10,19,32,0.9); --bg-input:#091320;
    --bg-hover:rgba(0,240,255,0.09); --bg-active:rgba(0,240,255,0.17);
    --brand:#00f0ff; --brand-hover:#66f7ff; --pink:#ff2a85; --green:#10b981; --red:#ff1e56; --yellow:#fcee09;
    --text-main:#e6f7ff; --text-normal:#b4cde0; --text-muted:#63809b; --text-dim:#3b536b;
    --border:rgba(0,240,255,0.16); --pink-border:rgba(255,42,133,0.48); --cyan-border:rgba(0,240,255,0.4);
    --chat-font-size:14px;
    --hex-regular:polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%);
    --hex-inner-hole:polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
    --pcb:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cg fill='none' stroke='%2300f0ff' stroke-width='0.8' stroke-opacity='0.05'%3E%3Cpath d='M0 20h30l15 15v30l15 15h40l20-20h20M20 0v25l20 20h35l15-15h50M0 95h25l20 20v25M80 140v-25l20-20h40'/%3E%3C/g%3E%3C/svg%3E");
  }
  @keyframes eqPulse { 0%,100%{transform:scaleY(0.25);opacity:0.45;} 50%{transform:scaleY(1);opacity:1;} }
  @keyframes badgeFlow { 0%{background-position:0% 50%;} 50%{background-position:100% 50%;} 100%{background-position:0% 50%;} }

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html, body {
    font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;
    background-color:var(--bg-darkest); background-image:var(--pcb); color:var(--text-main);
    width:100%; height:100vh; height:100dvh; display:flex; flex-direction:column;
    overflow:hidden; user-select:none; overscroll-behavior:none;
    padding-top:env(safe-area-inset-top, 0px);
  }

  /* ШЕСТИУГОЛЬНЫЕ АВАТАРЫ С ПОДДЕРЖКОЙ СВОИХ ФОТО И ОРИГИНАЛЬНЫХ РАМОК */
  .hex-wrap {
    position:relative; display:inline-flex; align-items:center; justify-content:center;
    flex-shrink:0; overflow:visible !important;
  }
  .hex-border {
    position:relative; width:100%; height:100%;
    clip-path:var(--hex-regular);
    background:rgba(0,240,255,0.35); display:flex; align-items:center; justify-content:center;
    padding:2px; overflow:hidden; z-index:1;
  }
  .hex-wrap.has-custom-frame .hex-border {
    width:54%; height:58%;
    margin-right:5%; margin-top:4%;
    clip-path:var(--hex-inner-hole);
    padding:0; background:transparent;
  }
  .hex-core {
    position:relative; z-index:1; width:100%; height:100%;
    clip-path:inherit;
    background:linear-gradient(145deg,#14253d,#08111e); color:#fff; font-weight:800;
    display:flex; align-items:center; justify-content:center; overflow:hidden;
    background-size:cover !important; background-position:center !important;
  }
  .hex-core img.ava-custom-img, .cds-user-core img.ava-custom-img {
    width:100%; height:100%; object-fit:cover; display:block; pointer-events:none;
  }
  .mini-frame-overlay {
    position:absolute; width:146%; height:146%;
    left:-23%; top:-23%;
    object-fit:contain; mix-blend-mode:screen;
    pointer-events:none; z-index:4;
  }
  .hex-status-dot {
    position:absolute; right:-2px; bottom:-2px; width:10px; height:10px;
    clip-path:var(--hex-regular); background:var(--green); border:1.5px solid #04070d; z-index:6;
  }
  .hex-status-dot.idle { background:var(--yellow); }
  .hex-status-dot.dnd { background:var(--red); }
  .hex-status-dot.invisible,.hex-status-dot.offline,.hex-status-dot.off { background:var(--text-dim); }

  /* КРУПНЫЙ МЕДАЛЬОН АВАТАРА В ПРОФИЛЕ И НАСТРОЙКАХ */
  .cyber-diode-scene {
    position:relative; width:112px; height:112px; margin:0 auto 4px auto;
    display:flex; align-items:center; justify-content:center; flex-shrink:0;
    overflow:visible; cursor:pointer;
  }
  .cds-user-core {
    position:absolute;
    left:22.4%; top:24.8%; width:50.2%; height:56.8%;
    clip-path:var(--hex-inner-hole);
    background:#070d19;
    background-size:cover !important; background-position:center !important;
    display:flex; align-items:center; justify-content:center;
    font-size:18px; font-weight:900; color:#fff; z-index:1;
    border:1px solid rgba(0,240,255,0.35);
    box-shadow:inset 0 0 16px rgba(0,240,255,0.3);
    overflow:hidden;
  }
  .cds-frame-img {
    position:absolute; inset:0; width:100%; height:100%;
    object-fit:contain; mix-blend-mode:screen; pointer-events:none; z-index:3;
  }

  /* БЕЙДЖИ СПРАВА ОТ НИКА */
  .cyber-badge {
    display:inline-flex; align-items:center; gap:3px; padding:1.5px 6px; border-radius:4px;
    font-size:9px; font-weight:900; letter-spacing:0.5px; text-transform:uppercase;
    white-space:nowrap; flex-shrink:0; background-size:200% 200%; animation:badgeFlow 2.5s ease infinite;
  }
  .cyber-badge.b-set1 { background-image:linear-gradient(90deg,#ff2a85,#00f0ff,#ff2a85); color:#fff; box-shadow:0 0 8px rgba(0,240,255,0.6); }
  .cyber-badge.b-set2 { background-image:linear-gradient(90deg,#ff6a00,#fcee09,#00f0ff); color:#04120c; box-shadow:0 0 8px rgba(255,106,0,0.65); }
  .cyber-badge.b-set3 { background-image:linear-gradient(90deg,#ff003c,#ff5500,#ff003c); color:#fff; box-shadow:0 0 8px rgba(255,0,60,0.7); }

  /* КАРТОЧКА ПРОФИЛЯ С КАЛИБРОВАННЫМИ ОТСТУПАМИ ПОД РАМКИ И СВОИМ ФОНОМ */
  .profile-surface {
    position:relative; background:#060a12; border:1px solid var(--border);
    border-radius:14px; overflow:hidden; transition:0.25s;
    background-size:cover; background-position:center;
  }
  .profile-custom-bg {
    position:absolute; inset:0; width:100%; height:100%;
    background-size:cover; background-position:center;
    opacity:0.45; pointer-events:none; z-index:1;
  }
  .profile-frame-overlay {
    position:absolute; inset:0; width:100%; height:100%;
    background-image:url('/profile_frames_3sets.jpg');
    background-repeat:no-repeat;
    background-size:300% 100%;
    mix-blend-mode:screen;
    pointer-events:none;
    z-index:2 !important;
    opacity:0;
    transition:opacity 0.2s;
  }
  .profile-surface.theme-set1 .profile-frame-overlay { opacity:1; background-position:0% 0%; }
  .profile-surface.theme-set2 .profile-frame-overlay { opacity:1; background-position:50% 0%; }
  .profile-surface.theme-set3 .profile-frame-overlay { opacity:1; background-position:100% 0%; }

  .profile-surface.theme-set1 { border:1px solid rgba(184,41,255,0.55); box-shadow:0 0 26px rgba(184,41,255,0.35); background-color:#050811; }
  .profile-surface.theme-set2 { border:1px solid rgba(255,120,0,0.55); box-shadow:0 0 26px rgba(255,120,0,0.35); background-color:#060911; }
  .profile-surface.theme-set3 { border:1px solid rgba(255,0,60,0.6); box-shadow:0 0 26px rgba(255,0,60,0.4); background-color:#090508; }

  .dp-body {
    padding:28px 26px 20px 26px;
    position:relative; z-index:6 !important;
    flex:1; display:flex; flex-direction:column; gap:7px;
  }
  .profile-surface[class*="theme-set"] .dp-body {
    padding:116px 42px 22px 42px !important;
  }
  .profile-surface[class*="theme-set"] .cyber-diode-scene {
    width:104px !important; height:104px !important;
    margin:-16px auto 0 auto !important;
  }
  .dp-nick-line { display:flex; align-items:center; justify-content:center; gap:7px; flex-wrap:wrap; text-align:center; }
  .dp-nick { font-size:18px; font-weight:900; color:#fff; text-shadow:0 2px 6px #000; }
  .dp-status { font-size:12px; color:var(--brand); text-align:center; text-shadow:0 1px 4px #000; }
  .dp-sec {
    background:rgba(4,7,14,0.9) !important;
    border:1px solid rgba(0,240,255,0.24) !important;
    border-radius:8px; padding:7px 11px !important;
    backdrop-filter:blur(8px);
    box-shadow:0 4px 14px rgba(0,0,0,0.75);
  }
  .dp-sec-title { font-size:9.5px !important; font-weight:800; color:var(--brand); margin-bottom:2px !important; text-transform:uppercase; text-shadow:0 1px 4px #000; }
  .dp-bio { font-size:11.5px !important; line-height:1.3 !important; color:#eef8ff !important; white-space:pre-wrap; }
  .dp-tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:3px; }
  .dp-tag { background:rgba(0,240,255,0.12); border:1px solid var(--border); color:var(--brand); padding:2px 7px; border-radius:4px; font-size:10.5px; font-weight:700; }

  .profile-surface.theme-set1 .dp-sec:nth-of-type(2),
  .profile-surface.theme-set1 .dp-sec:nth-of-type(3),
  .profile-surface.theme-set1 .dp-actions-col {
    margin-left:104px !important;
    border-color:rgba(184,41,255,0.45) !important;
  }
  .profile-surface.theme-set2 .dp-sec:nth-of-type(1),
  .profile-surface.theme-set2 .dp-sec:nth-of-type(2),
  .profile-surface.theme-set2 .dp-sec:nth-of-type(3) {
    margin-right:86px !important;
    border-color:rgba(255,123,0,0.45) !important;
  }
  .profile-surface.theme-set3 .dp-sec:nth-of-type(2),
  .profile-surface.theme-set3 .dp-sec:nth-of-type(3) {
    margin-left:56px !important;
    margin-right:72px !important;
    border-color:rgba(255,0,60,0.45) !important;
  }
  .dp-actions-col { display:flex; flex-direction:column; gap:7px; margin-top:auto; padding-top:6px; position:relative; z-index:10 !important; }
  .status-pill { font-size:10px; padding:2px 7px; border-radius:4px; font-weight:800; }
  .status-pill.on { background:rgba(16,185,129,0.18); color:var(--green); }
  .status-pill.off { background:rgba(255,255,255,0.06); color:var(--text-muted); }

  #preview-surface { max-width:365px; margin:0 auto; }

  /* БЛОК ЗАГРУЗКИ ФОТО ПРОФИЛЯ И ФОНА ВВЕРХУ НАСТРОЕК */
  .photo-upload-bar {
    display:grid; grid-template-columns:1fr 1fr; gap:10px;
    background:rgba(0,240,255,0.06); border:1.5px dashed var(--cyan-border);
    border-radius:10px; padding:12px;
  }
  .pub-col { display:flex; flex-direction:column; gap:6px; }
  .pub-title { font-size:11px; font-weight:800; color:var(--brand); text-transform:uppercase; }

  /* ВЕРХНЯЯ ПАНЕЛЬ (БЕЗ ДУБЛИРУЮЩИХ КНОПОК ПРОФИЛЯ/БИНДОВ/ЭФФЕКТОВ) */
  .top-telemetry-bar { height:42px; background:rgba(4,7,13,0.96); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 12px; gap:8px; flex-shrink:0; z-index:30; }
  .tt-left,.tt-right { display:flex; align-items:center; gap:8px; min-width:0; }
  .tt-logo { display:flex; align-items:center; gap:6px; font-weight:900; font-size:13px; letter-spacing:1px; color:#fff; white-space:nowrap; }
  .tt-cyber-tag { background:rgba(255,42,133,0.2); border:1px solid var(--pink-border); color:#ff7aa8; font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px; }
  .tt-proto-pill { background:rgba(0,240,255,0.06); border:1px solid var(--border); color:var(--text-muted); font-size:10px; font-weight:700; padding:3px 10px; border-radius:4px; white-space:nowrap; }
  .tt-node-pill { display:flex; align-items:center; gap:6px; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.4); color:#6ee7b7; font-size:10.5px; font-weight:700; padding:4px 9px; border-radius:6px; white-space:nowrap; }
  .tt-node-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 8px var(--green); }
  .tt-invite-btn { background:linear-gradient(135deg,rgba(255,42,133,0.32),rgba(157,23,77,0.5)); border:1px solid var(--pink); color:#fff; font-size:10.5px; font-weight:800; padding:5px 11px; border-radius:6px; cursor:pointer; white-space:nowrap; }

  .sub-sync-bar { height:32px; background:rgba(6,11,20,0.92); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 12px; font-size:11px; flex-shrink:0; gap:8px; }
  .ss-left { display:flex; align-items:center; gap:6px; font-weight:700; color:var(--brand); white-space:nowrap; }
  .ss-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
  .ss-btn { background:rgba(0,240,255,0.07); border:1px solid var(--border); color:var(--text-main); font-size:10.5px; font-weight:700; padding:4px 10px; border-radius:5px; cursor:pointer; display:flex; align-items:center; gap:4px; white-space:nowrap; }

  /* СЕТКА ПРИЛОЖЕНИЯ */
  .app-layout { flex:1; display:flex; width:100%; min-height:0; overflow:hidden; position:relative; }
  .servers-rail { width:68px; background:rgba(4,7,13,0.94); border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:10px; overflow-y:auto; flex-shrink:0; z-index:20; }
  .servers-rail::-webkit-scrollbar { display:none; }
  .srv-pill-wrap { position:relative; width:68px; display:flex; justify-content:center; align-items:center; }
  .srv-pill-bar { position:absolute; left:0; width:3px; height:10px; background:var(--brand); opacity:0; transition:0.18s; }
  .srv-pill-wrap.active .srv-pill-bar { opacity:1; height:36px; }
  .srv-ico { width:44px; height:44px; clip-path:var(--hex-regular); background:#0c1626; color:var(--text-normal); font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .srv-ico:hover,.srv-pill-wrap.active .srv-ico { background:var(--brand); color:#031518; box-shadow:0 0 14px rgba(0,240,255,0.6); }
  .srv-ico.home-ico { background:#0d1829; color:var(--yellow); font-size:18px; }
  .srv-ico-action { width:44px; height:44px; clip-path:var(--hex-regular); background:rgba(255,42,133,0.18); color:var(--pink); font-size:20px; font-weight:800; display:flex; align-items:center; justify-content:center; cursor:pointer; }

  .workspace { flex:1; display:grid; grid-template-columns:250px 1fr 245px; min-height:0; overflow:hidden; position:relative; }
  body.hide-members-panel .workspace { grid-template-columns:250px 1fr; }
  body.hide-members-panel .right-panel { display:none; }

  /* ЛЕВАЯ КОЛОНКА КАНАЛОВ */
  .channels-panel { background:rgba(6,11,20,0.92); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; height:100%; }
  .srv-header { padding:12px 14px 10px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .srv-sub-label { font-size:9px; font-weight:800; text-transform:uppercase; color:var(--brand); letter-spacing:0.8px; }
  .srv-title { font-size:16px; font-weight:900; color:#fff; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .srv-badge-open { background:rgba(0,240,255,0.08); border:1px solid var(--cyan-border); color:var(--brand); font-size:9.5px; font-weight:700; padding:3px 8px; border-radius:4px; cursor:pointer; }
  .packet-card { margin:8px 10px 4px; padding:8px 12px; background:linear-gradient(135deg,rgba(255,42,133,0.14),rgba(10,19,32,0.9)); border:1px solid var(--pink-border); border-radius:8px; display:flex; justify-content:space-between; align-items:center; }
  .pk-label { font-size:9px; font-weight:800; color:var(--text-normal); }
  .pk-val { font-size:11px; font-weight:800; color:#fff; font-family:monospace; }
  .pk-live { font-size:9.5px; font-weight:800; color:var(--pink); }
  .channels-scroll { flex:1; overflow-y:auto; padding:6px 10px 12px; }
  .channels-scroll::-webkit-scrollbar { width:4px; }
  .btn-create-ch-wide { width:100%; background:rgba(0,240,255,0.05); border:1px solid var(--border); color:var(--text-main); font-size:11px; font-weight:800; padding:8px 10px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; margin:6px 0 10px; }
  .cat-header { display:flex; align-items:center; justify-content:space-between; padding:8px 4px 5px; font-size:10.5px; font-weight:800; text-transform:uppercase; color:var(--text-muted); }
  .cat-add-btn { background:rgba(0,240,255,0.08); border:1px solid var(--border); color:var(--brand); width:22px; height:22px; border-radius:4px; font-size:14px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .ch-btn,.voice-ch-box { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:6px; font-size:13px; font-weight:600; color:var(--text-normal); cursor:pointer; margin-bottom:3px; border:1px solid transparent; }
  .ch-btn:hover,.voice-ch-box:hover { background:var(--bg-hover); color:#fff; }
  .ch-btn.active { background:var(--bg-active); border-color:var(--cyan-border); color:#fff; }
  .voice-ch-box.active { background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.45); color:#6ee7b7; }
  .ch-left { display:flex; align-items:center; gap:7px; min-width:0; flex:1; }
  .ch-hash { color:var(--brand); font-size:13px; font-weight:800; width:16px; text-align:center; }
  .ch-name-txt { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ch-unread-badge { background:var(--pink); color:#fff; font-size:10px; font-weight:800; padding:1px 6px; border-radius:999px; }
  .off-badge { font-size:9px; color:var(--text-muted); font-weight:800; }
  .off-badge.on { color:var(--green); }
  .voice-connected-users { display:flex; flex-direction:column; gap:6px; padding:4px 0 6px 18px; }
  .vc-user-row { display:flex; align-items:center; gap:10px; padding:4px 6px; border-radius:4px; font-size:12px; color:var(--text-normal); cursor:pointer; }

  /* ГОЛОСОВОЙ ДОК СНИЗУ СЛЕВА (2 КНОПКИ: КАМЕРА И ЭКРАН, БЕЗ ОВЕРЛЕЯ) */
  .sidebar-voice-dock { background:rgba(6,16,26,0.96); border-top:1px solid var(--cyan-border); padding:9px 10px; display:flex; flex-direction:column; gap:7px; flex-shrink:0; }
  .svd-top { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .svd-state-row { font-size:10.5px; font-weight:800; color:var(--green); text-transform:uppercase; }
  .svd-state-row.idle { color:var(--text-muted); }
  .svd-channel-name { font-size:12px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .svd-hangup-btn { background:rgba(255,42,133,0.22); border:1px solid var(--pink); color:#ff80a0; padding:5px 9px; border-radius:5px; font-size:11px; font-weight:800; cursor:pointer; }
  .svd-connect-btn { background:var(--brand); border:none; color:#031518; padding:5px 10px; border-radius:5px; font-size:10.5px; font-weight:800; cursor:pointer; }
  .svd-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .svd-btn { background:#0d1829; border:1px solid var(--border); color:var(--text-normal); padding:6px 4px; border-radius:5px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; }
  .svd-btn.active-cam { background:rgba(16,185,129,0.25); border-color:var(--green); color:#6ee7b7; }
  .svd-btn.active-screen { background:rgba(255,42,133,0.25); border-color:var(--pink); color:#ffaec2; }

  .user-bar { height:58px; padding:0 10px; background:var(--bg-userbar); border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:6px; flex-shrink:0; overflow:visible; }
  .user-info { display:flex; align-items:center; gap:12px; padding:4px 6px; border-radius:6px; cursor:pointer; flex:1; min-width:0; overflow:visible; }
  .user-name-row { display:flex; align-items:center; gap:5px; min-width:0; }
  .user-name { font-size:13px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-sub { font-size:10px; color:var(--brand); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-bar-controls { display:flex; align-items:center; gap:4px; }
  .ub-ctrl-btn { width:32px; height:32px; clip-path:var(--hex-regular); background:#0d1829; border:none; color:var(--brand); font-size:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .ub-ctrl-btn.off { background:rgba(255,42,133,0.25); color:var(--pink); }

  /* ЦЕНТРАЛЬНАЯ ЗОНА И СЦЕНА КАМЕР */
  .main-chat { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; flex:1; }
  .audio-stream-header-card { margin:8px 12px 4px; padding:9px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-shrink:0; }
  .ash-left { display:flex; align-items:center; gap:8px; min-width:0; }
  .ash-label { font-size:9.5px; font-weight:800; color:var(--brand); text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ash-channel { font-size:14px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ash-wave { flex:1; height:24px; display:flex; align-items:center; justify-content:center; gap:3px; overflow:hidden; max-width:340px; }
  .ash-bar { width:3px; height:100%; background:var(--brand); border-radius:2px; opacity:0.35; transform:scaleY(0.25); }
  body.voice-live .ash-bar { animation:eqPulse 0.9s ease-in-out infinite; }
  .ash-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }

  .media-stage-dock { margin:4px 12px; background:rgba(5,10,18,0.95); border:1px solid var(--cyan-border); border-radius:10px; padding:8px; display:none; flex-direction:column; gap:8px; max-height:46vh; overflow-y:auto; flex-shrink:0; }
  .media-stage-dock.show { display:flex; }
  .msd-header { display:flex; justify-content:space-between; align-items:center; gap:8px; border-bottom:1px solid var(--border); padding-bottom:6px; flex-wrap:wrap; }
  .msd-title { font-size:10.5px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .msd-layout-btn { background:#0d1829; border:1px solid var(--border); color:var(--text-normal); padding:3px 8px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; }
  .msd-layout-btn.active { background:var(--brand); color:#031518; border-color:var(--brand); }
  .screen-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:8px; width:100%; }
  .screen-grid.spotlight-mode { grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
  .screen-grid.spotlight-mode .screen-card.featured-tile { grid-column:1 / -1; }
  .screen-card { background:#04070d; border:1px solid var(--border); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; cursor:pointer; }
  .screen-card.featured-tile { border-color:var(--brand); }
  .screen-card-head { display:flex; justify-content:space-between; align-items:center; padding:5px 8px; background:rgba(4,7,13,0.92); border-bottom:1px solid var(--border); font-size:10.5px; font-weight:700; color:var(--text-main); gap:5px; flex-wrap:wrap; }
  .screen-live-pill { background:var(--pink); color:#fff; font-size:8.5px; padding:1px 5px; border-radius:4px; margin-left:4px; }
  .screen-live-pill.cam { background:var(--green); color:#031518; }
  .screen-video-wrap { position:relative; width:100%; background:#000; display:flex; align-items:center; justify-content:center; min-height:130px; max-height:260px; overflow:hidden; }
  .screen-card.featured-tile .screen-video-wrap { max-height:320px; }
  .screen-video-wrap video { width:100%; max-height:320px; object-fit:contain; background:#000; display:block; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter:blur(26px) brightness(0.3); }
  .media-nsfw-shield { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:rgba(4,7,13,0.85); color:var(--pink); font-size:11.5px; font-weight:800; z-index:5; cursor:pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display:flex; }
  .btn-fs { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:3px 7px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; }

  .chat-scroll-area { flex:1; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; min-height:0; }
  .messages-container { display:flex; flex-direction:column; gap:8px; }
  .msg-item { display:flex; gap:14px; padding:10px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:8px; overflow:visible; }
  body.compact-chat .msg-item { padding:6px 10px; }
  .msg-head-line { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .msg-author { font-size:13.5px; font-weight:800; color:var(--brand); cursor:pointer; }
  .msg-time { font-size:10.5px; color:var(--text-muted); font-family:monospace; }
  .msg-text { font-size:var(--chat-font-size); color:var(--text-main); margin-top:3px; line-height:1.4; user-select:text; word-break:break-word; }
  .msg-text a { color:var(--brand); text-decoration:none; border-bottom:1px dashed var(--brand); }
  .chat-inline-media { max-width:min(100%,400px); max-height:240px; border-radius:6px; margin-top:6px; display:block; border:1px solid var(--cyan-border); }
  .filtered-block-card { display:inline-flex; align-items:center; gap:8px; background:rgba(255,42,133,0.12); border:1px dashed var(--pink-border); color:#ff80a0; padding:6px 10px; border-radius:6px; font-size:12px; margin-top:4px; }
  .spoiler-blur-wrap { position:relative; display:inline-block; width:100%; background:#060b14; border:1px solid var(--pink-border); border-radius:6px; padding:8px 10px; margin-top:4px; cursor:pointer; }
  .spoiler-blur-content { filter:blur(8px); user-select:none; pointer-events:none; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter:none; user-select:text; pointer-events:auto; }
  .spoiler-badge { font-size:11px; font-weight:700; color:var(--pink); margin-bottom:4px; }
  .spoiler-blur-wrap.revealed .spoiler-badge { display:none; }

  .chat-bottom { padding:6px 12px 8px; flex-shrink:0; }
  .console-box { background:var(--bg-card); border:1px solid var(--cyan-border); border-radius:8px; padding:6px 10px 8px; display:flex; flex-direction:column; gap:5px; }
  .console-top-label { display:flex; justify-content:space-between; font-size:9px; font-weight:800; color:var(--text-muted); text-transform:uppercase; }
  .input-row { display:flex; align-items:center; gap:8px; }
  .chat-inp { flex:1; min-width:0; background:#050a12; border:1px solid var(--border); border-radius:6px; padding:8px 11px; color:var(--text-main); font-size:14px; outline:none; }

  /* ПРАВАЯ КОЛОНКА И ВЫЕЗЖАЮЩИЙ ПРОФИЛЬ */
  .right-panel { width:245px; background:rgba(6,11,20,0.92); border-left:1px solid var(--border); padding:12px 10px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; height:100%; }
  .telemetry-mini-card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:9px 10px; margin-bottom:6px; font-size:10.5px; }
  .tm-row { display:flex; justify-content:space-between; color:var(--text-normal); margin-top:4px; font-family:monospace; }
  .tm-val { color:var(--brand); font-weight:700; }
  .right-sec-title { font-size:10.5px; text-transform:uppercase; color:var(--brand); font-weight:800; padding:8px 6px 4px; }
  .online-user-item { display:flex; align-items:center; gap:12px; padding:7px 8px; border-radius:6px; cursor:pointer; min-width:0; overflow:visible; }
  .online-user-item:hover { background:var(--bg-hover); }
  .member-text-col { flex:1; overflow:hidden; display:flex; flex-direction:column; min-width:0; }
  .member-nick-row { display:flex; align-items:center; gap:5px; font-size:13px; font-weight:700; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .member-status-sub { font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mini-btn { background:rgba(0,240,255,0.08); border:1px solid var(--border); color:var(--brand); padding:2px 7px; border-radius:4px; font-size:10px; font-weight:800; cursor:pointer; }
  .friend-tag { font-size:9.5px; color:var(--green); font-weight:800; }

  .profile-drawer-backdrop { position:fixed; inset:0; background:rgba(2,5,10,0.68); backdrop-filter:blur(3px); z-index:970; display:none; }
  .profile-drawer-backdrop.open { display:block; }
  .profile-slide-drawer { position:fixed; top:0; right:0; bottom:0; width:380px; max-width:95vw; z-index:975; transform:translateX(106%); transition:transform 0.26s cubic-bezier(0.16,1,0.3,1); display:flex; flex-direction:column; padding:10px; pointer-events:none; }
  .profile-slide-drawer.open { transform:translateX(0); pointer-events:auto; }
  .psd-inner { flex:1; display:flex; flex-direction:column; overflow-y:auto; }
  .dp-close-x { position:absolute; top:14px; right:14px; width:32px; height:32px; border-radius:6px; background:rgba(4,7,13,0.88); border:1px solid var(--border); color:#fff; font-weight:800; cursor:pointer; z-index:12; }

  .bottom-status-footer { height:24px; background:#03060b; border-top:1px solid var(--border); padding:0 14px; display:flex; align-items:center; justify-content:space-between; font-size:10px; font-family:monospace; color:var(--text-muted); flex-shrink:0; }
  .bsf-green { color:var(--brand); font-weight:700; }

  .btn-cyan { background:var(--brand); color:#031518; border:none; padding:8px 14px; border-radius:6px; font-weight:800; font-size:11.5px; text-transform:uppercase; cursor:pointer; white-space:nowrap; }
  .btn-danger { background:var(--pink); color:#fff; border:none; padding:8px 12px; border-radius:6px; font-weight:800; font-size:11.5px; text-transform:uppercase; cursor:pointer; }
  .btn-login-mini { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:6px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; }
  .btn-tg { background:var(--brand); color:#031518; border:none; width:100%; padding:10px 14px; border-radius:6px; font-weight:800; font-size:12.5px; text-transform:uppercase; cursor:pointer; margin-bottom:10px; }

  .modal-backdrop { position:fixed; inset:0; background:rgba(2,5,10,0.86); backdrop-filter:blur(5px); display:none; align-items:center; justify-content:center; z-index:999; padding:10px; }
  .modal-backdrop.open { display:flex; }
  .modal-box { background:#070d17; border:1px solid var(--brand); border-radius:10px; padding:18px; width:410px; max-width:100%; }
  .modal-box input[type="text"],.modal-box input[type="password"],.modal-box textarea,.modal-box select { width:100%; padding:10px; background:#040810; border:1px solid var(--border); border-radius:6px; color:#fff; margin-bottom:10px; font-size:14px; outline:none; }
  .link-box { background:#040810; border:1px dashed var(--brand); padding:10px; color:var(--brand); font-size:12px; word-break:break-all; margin-bottom:10px; border-radius:6px; display:block; text-align:center; text-decoration:none; }
  .auth-tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-bottom:12px; background:#040810; padding:4px; border-radius:6px; border:1px solid var(--border); }
  .auth-tab { padding:7px 4px; font-size:11px; font-weight:800; text-align:center; cursor:pointer; color:var(--text-muted); border-radius:4px; }
  .auth-tab.active { background:var(--brand); color:#031518; }

  .settings-modal-box { background:#070d17; border:1px solid var(--brand); border-radius:10px; width:900px; max-width:100%; height:640px; max-height:92dvh; display:grid; grid-template-columns:220px minmax(0,1fr); overflow:hidden; }
  .settings-nav { background:#050911; border-right:1px solid var(--border); padding:14px 10px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; }
  .settings-nav-label { font-size:10px; font-weight:800; text-transform:uppercase; color:var(--brand); padding:6px 10px 3px; }
  .settings-nav-btn { padding:8px 10px; border-radius:6px; font-size:12.5px; font-weight:600; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; gap:8px; white-space:nowrap; flex-shrink:0; }
  .settings-nav-btn.active { background:var(--bg-active); color:var(--brand); border-left:2px solid var(--brand); }
  .settings-content { padding:18px 20px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; min-width:0; }
  .settings-pane { display:none; flex-direction:column; gap:12px; min-width:0; }
  .settings-pane.active { display:flex; }
  .settings-head { display:flex; justify-content:space-between; align-items:center; gap:10px; border-bottom:1px solid var(--border); padding-bottom:10px; flex-wrap:wrap; }
  .settings-head h3 { font-size:15px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .field-label { font-size:10.5px; font-weight:800; text-transform:uppercase; color:var(--brand); margin-bottom:6px; display:block; }
  .settings-card { background:rgba(4,8,16,0.9); border:1px solid var(--border); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:10px; }
  .settings-grid-2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; }
  .settings-card input[type="text"],.settings-card input[type="password"],.settings-card textarea,.settings-card select { width:100%; padding:8px 10px; background:#03060c; border:1px solid var(--border); border-radius:6px; color:#fff; font-size:14px; outline:none; }
  .toggle-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid var(--border); }
  .toggle-row:last-child { border-bottom:none; }
  .toggle-title { font-size:13px; font-weight:600; color:#fff; }
  .cyber-switch { position:relative; display:inline-block; width:40px; height:22px; flex-shrink:0; cursor:pointer; }
  .cyber-switch input { opacity:0; width:0; height:0; }
  .cyber-slider { position:absolute; inset:0; background:#101929; border:1px solid var(--border); border-radius:20px; transition:0.2s; }
  .cyber-slider::before { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; background:var(--text-muted); clip-path:var(--hex-regular); transition:0.2s; }
  .cyber-switch input:checked + .cyber-slider { background:rgba(0,240,255,0.22); border-color:var(--brand); }
  .cyber-switch input:checked + .cyber-slider::before { transform:translateX(18px); background:var(--brand); }
  .cyber-range { -webkit-appearance:none; appearance:none; width:100%; height:6px; background:#03060c; border:1px solid var(--border); border-radius:4px; outline:none; margin-top:4px; }
  .cyber-range::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; clip-path:var(--hex-regular); background:var(--brand); cursor:pointer; }
  .color-swatches { display:flex; gap:8px; flex-wrap:wrap; }
  .color-swatch { width:26px; height:26px; clip-path:var(--hex-regular); cursor:pointer; }
  .mic-meter-wrap { width:100%; height:8px; background:#03060c; border:1px solid var(--border); border-radius:4px; overflow:hidden; }
  .mic-meter-bar { height:100%; width:0%; background:linear-gradient(90deg,var(--green),var(--brand),var(--pink)); transition:width 0.06s; }

  .fx-sets-grid { display:flex; flex-direction:column; gap:14px; }
  .fx-bundle-card { border-radius:12px; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:14px; border:1.5px solid var(--border); background:rgba(5,10,18,0.94); }
  .fx-bundle-card.set1-card { border-color:#00f0ff; box-shadow:0 0 20px rgba(255,42,133,0.28); background:linear-gradient(135deg,rgba(255,42,133,0.18),rgba(0,240,255,0.12),rgba(5,10,18,0.96)); }
  .fx-bundle-card.set2-card { border-color:#ff7b00; box-shadow:0 0 20px rgba(255,123,0,0.28); background:linear-gradient(135deg,rgba(255,123,0,0.18),rgba(0,240,255,0.12),rgba(5,10,18,0.96)); }
  .fx-bundle-card.set3-card { border-color:#ff003c; box-shadow:0 0 20px rgba(255,0,60,0.28); background:linear-gradient(135deg,rgba(255,0,60,0.2),rgba(0,240,255,0.1),rgba(5,10,18,0.96)); }
  .fxb-left { display:flex; align-items:center; gap:14px; min-width:0; flex:1; }
  .fxb-preview-pair { display:flex; align-items:center; gap:10px; flex-shrink:0; }
  .fxb-prof-thumb {
    width:72px; height:104px; border-radius:8px; border:1px solid rgba(255,255,255,0.2);
    background-image:url('/profile_frames_3sets.jpg'); background-repeat:no-repeat; background-size:300% 100%;
    flex-shrink:0;
  }

  .keybind-row { display:flex; justify-content:space-between; align-items:center; padding:9px 12px; background:#040810; border:1px solid var(--border); border-radius:6px; gap:10px; flex-wrap:wrap; }
  .kb-btn { background:#0d1829; border:1px solid var(--cyan-border); color:var(--brand); font-family:monospace; font-size:12px; font-weight:800; padding:6px 14px; border-radius:5px; cursor:pointer; min-width:130px; text-align:center; }
  .kb-btn.recording { background:rgba(255,42,133,0.25); border-color:var(--pink); color:#fff; }

  .mob-top-btn { display:none; background:rgba(0,240,255,0.08); border:1px solid var(--border); border-radius:6px; color:var(--brand); width:32px; height:32px; align-items:center; justify-content:center; font-size:17px; cursor:pointer; flex-shrink:0; }
  .mob-drawer-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.74); z-index:940; }
  .mob-bottom-nav {
    display:none; height:calc(54px + env(safe-area-inset-bottom, 0px));
    padding-bottom:env(safe-area-inset-bottom, 0px);
    background:#04070d; border-top:1px solid var(--border);
    grid-template-columns:repeat(5,1fr); align-items:center; flex-shrink:0; z-index:960;
  }
  .mob-nav-item { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; height:100%; color:var(--text-muted); font-size:10px; font-weight:700; cursor:pointer; }
  .mob-nav-item.active { color:var(--brand); background:rgba(0,240,255,0.08); }

  @media (max-width:900px) {
    .tt-proto-pill,.tt-cyber-tag,.ash-wave,.bottom-status-footer,.ss-left span:first-child { display:none; }
    .top-telemetry-bar { height:44px; padding:0 10px; }
    .sub-sync-bar { height:34px; padding:0 10px; }
    .workspace { display:flex; flex-direction:column; flex:1; min-height:0; }
    .main-chat { flex:1; width:100%; height:100%; min-height:0; }
    .mob-top-btn { display:inline-flex; }
    .mob-bottom-nav { display:grid; }
    .servers-rail {
      position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px));
      left:0; width:64px; z-index:955; transform:translateX(-340px); transition:transform 0.24s ease;
    }
    .channels-panel {
      position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px));
      left:64px; width:calc(100vw - 64px); max-width:265px; z-index:955;
      transform:translateX(-340px); transition:transform 0.24s ease;
      box-shadow:8px 0 24px rgba(0,0,0,0.8);
    }
    body.mob-left-open .servers-rail, body.mob-left-open .channels-panel { transform:translateX(0); }
    .right-panel {
      position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px));
      right:0; width:min(84vw,280px); z-index:955;
      transform:translateX(105%); transition:transform 0.24s ease;
      box-shadow:-8px 0 24px rgba(0,0,0,0.8);
    }
    body.mob-right-open .right-panel { transform:translateX(0); }
    body.mob-left-open .mob-drawer-backdrop, body.mob-right-open .mob-drawer-backdrop { display:block; }

    .audio-stream-header-card { margin:6px 10px 2px; padding:8px 10px; }
    .chat-scroll-area { padding:6px 10px; }
    .chat-bottom { padding:4px 10px 6px; }
    .chat-inp { font-size:16px; padding:8px 10px; }
    .profile-slide-drawer { width:100vw; max-width:100vw; padding:0; }
    .profile-slide-drawer .profile-surface { border-radius:0; height:100%; border:none; }
    .settings-modal-box {
      grid-template-columns:1fr; grid-template-rows:auto 1fr;
      width:100vw; height:100dvh; max-height:100dvh; border-radius:0;
    }
    .settings-nav {
      flex-direction:row; overflow-x:auto; padding:8px 10px;
      border-right:none; border-bottom:1px solid var(--border); gap:6px;
    }
    .settings-nav::-webkit-scrollbar { display:none; }
    .settings-nav-label { display:none; }
    .settings-nav-btn { border-left:none; border-bottom:2px solid transparent; padding:7px 10px; }
    .settings-nav-btn.active { border-left:none; border-bottom:2px solid var(--brand); }
    .settings-content { padding:14px; }
    .settings-grid-2,.photo-upload-bar,.fx-bundle-card,.fxb-left { grid-template-columns:1fr; flex-direction:column; align-items:flex-start; }
    .fx-bundle-card button { width:100%; }
  }
</style>
</head>
<body>
  <div class="top-telemetry-bar">
    <div class="tt-left">
      <button class="mob-top-btn" onclick="toggleMobileLeft()">☰</button>
      <div class="tt-logo"><span style="color:var(--brand);">⚡</span><span>СИГНАЛ</span></div>
      <span class="tt-cyber-tag">CYBER.NET</span>
      <span class="tt-proto-pill">МЕСТО ДЛЯ СВОИХ // P2P ПРОТОКОЛ</span>
    </div>
    <div class="tt-right">
      <div class="tt-node-pill"><span class="tt-node-dot"></span><span id="tt-node-label">cy-4371</span></div>
      <button class="tt-invite-btn" onclick="openInviteModal()">+ ПРИГЛАСИТЬ</button>
    </div>
  </div>

  <!-- ВЕРХНЯЯ ПАНЕЛЬ СИНХРОНИЗАЦИИ БЕЗ ДУБЛИРУЮЩИХ КНОПОК ЭФФЕКТОВ/БИНДОВ/ПРОФИЛЯ -->
  <div class="sub-sync-bar">
    <div class="ss-left"><span>● АКТИВНАЯ СЕТЬ:</span><span style="color:#fff;font-weight:800;">P2P СИНХРОНИЗАЦИЯ</span></div>
    <div class="ss-right">
      <button class="ss-btn" onclick="if(window.innerWidth<=900)toggleMobileRight();else document.body.classList.toggle('hide-members-panel');">👥 УЧАСТНИКИ</button>
    </div>
  </div>

  <div class="app-layout">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>
    <div class="servers-rail">
      <div class="srv-pill-wrap" title="Настройки и профиль" onclick="openSettingsModal('profile')">
        <span class="srv-pill-bar"></span><div class="srv-ico home-ico">⚡</div>
      </div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;width:100%;"></div>
      <div class="srv-ico-action" title="Создать сервер" onclick="openCreateServerModal()">+</div>
    </div>

    <div class="workspace">
      <div class="channels-panel">
        <div class="srv-header">
          <div style="min-width:0;"><div class="srv-sub-label">ОТКРЫТЫЙ СЕРВЕР</div><div class="srv-title" id="srv-title-label">Ночной клуб</div></div>
          <span class="srv-badge-open" onclick="openInviteModal()">Ссылка</span>
        </div>
        <div class="packet-card">
          <div><div class="pk-label">ОЧЕРЕДЬ ПАКЕТОВ</div><div class="pk-val">108.4 FM // P2P</div></div>
          <span class="pk-live">▲ LIVE</span>
        </div>
        <div class="channels-scroll">
          <div class="cat-header"><span>◈ ТЕКСТОВЫЕ КАНАЛЫ</span><button class="cat-add-btn" onclick="openCreateChannelModal('text')">+</button></div>
          <div id="text-channels-list"></div>
          <button class="btn-create-ch-wide" onclick="openCreateChannelModal('text')"><span>СОЗДАТЬ НОВЫЙ КАНАЛ</span><span style="color:var(--brand);">+</span></button>
          <div class="cat-header" style="margin-top:6px;"><span>🔊 ГОЛОСОВЫЕ КАНАЛЫ</span><button class="cat-add-btn" onclick="openCreateChannelModal('voice')">+</button></div>
          <div id="voice-channels-list"></div>
          <div class="voice-connected-users" id="sidebar-voice-peers"></div>
        </div>

        <div class="sidebar-voice-dock" id="voice-panel-card">
          <div class="svd-top">
            <div style="min-width:0;">
              <div class="svd-state-row idle" id="svd-state-text">📡 ГОЛОСОВОЙ КАНАЛ</div>
              <div class="svd-channel-name" id="voice-panel-title">Ночной эфир</div>
            </div>
            <button class="svd-connect-btn" id="connect-voice-btn" onclick="toggleVoiceCall()">ВОЙТИ</button>
          </div>
          <div class="svd-actions">
            <button class="svd-btn" id="cam-btn" onclick="toggleWebcam()">📷 Камера</button>
            <button class="svd-btn" id="screen-btn" onclick="toggleScreenShare()">🖥️ Экран</button>
          </div>
          <div id="audio-box" style="display:none;"></div>
        </div>

        <div class="user-bar">
          <div class="user-info" onclick="openUserProfileCard(getMyMemberObject())">
            <div class="hex-wrap" id="user-ava-wrap" style="width:40px;height:40px;">
              <div class="hex-border"><div class="hex-core" id="user-ava" style="font-size:11px;">ГО</div></div>
              <img class="mini-frame-overlay" id="user-ava-frame-img" style="display:none;" alt="">
              <span class="hex-status-dot" id="user-presence-dot"></span>
            </div>
            <div style="overflow:hidden;min-width:0;flex:1;">
              <div class="user-name-row"><span class="user-name" id="user-name-label">Гость</span><span id="user-bar-badge-slot"></span></div>
              <div class="user-sub" id="user-email-label">В сети</div>
            </div>
          </div>
          <div class="user-bar-controls">
            <button class="ub-ctrl-btn" id="mute-btn" onclick="if(inVoice)toggleMute();else toggleVoiceCall();">🎤</button>
            <button class="ub-ctrl-btn" id="deafen-btn" onclick="if(inVoice)toggleDeafen();else openSettingsModal('voice');">🎧</button>
            <button class="ub-ctrl-btn" title="Настройки" onclick="openSettingsModal('profile')">⚙️</button>
          </div>
        </div>
      </div>

      <div class="main-chat">
        <div class="audio-stream-header-card">
          <div class="ash-left">
            <span style="color:var(--brand);font-size:18px;font-weight:900;">#</span>
            <div style="min-width:0;"><div class="ash-label" id="top-ch-desc">АКТИВНЫЙ АУДИО ПОТОК // КАНАЛ</div><div class="ash-channel" id="top-ch-name">общий</div></div>
          </div>
          <div class="ash-wave">
            <div class="ash-bar" style="animation-delay:0s"></div><div class="ash-bar" style="animation-delay:.2s"></div><div class="ash-bar" style="animation-delay:.4s"></div><div class="ash-bar" style="animation-delay:.1s"></div><div class="ash-bar" style="animation-delay:.3s"></div><div class="ash-bar" style="animation-delay:.5s"></div><div class="ash-bar" style="animation-delay:.15s"></div><div class="ash-bar" style="animation-delay:.35s"></div><div class="ash-bar" style="animation-delay:.05s"></div><div class="ash-bar" style="animation-delay:.25s"></div><div class="ash-bar" style="animation-delay:.45s"></div><div class="ash-bar" style="animation-delay:.12s"></div>
          </div>
          <div class="ash-right">
            <button class="btn-login-mini" onclick="openSettingsModal('profile')">⚙️ Настройки</button>
          </div>
        </div>

        <div class="media-stage-dock" id="media-stage-dock">
          <div class="msd-header">
            <span class="msd-title">📹 ТРАНСЛЯЦИИ В КАНАЛЕ</span>
            <div style="display:flex;gap:6px;">
              <button class="msd-layout-btn active" id="btn-stage-grid" onclick="setStageLayout('grid')">⊞ Сетка</button>
              <button class="msd-layout-btn" id="btn-stage-spot" onclick="setStageLayout('spotlight')">⊡ Фокус</button>
            </div>
          </div>
          <div class="screen-grid" id="screen-grid"></div>
        </div>

        <div class="chat-scroll-area" id="chat-scroll"><div class="messages-container" id="messages-list"></div></div>

        <div class="chat-bottom">
          <div class="console-box">
            <div class="console-top-label"><span>ОКНО ВВОДА // КОНСОЛЬ</span><span id="banner-desc">P2P КАНАЛ АКТИВЕН</span></div>
            <form class="input-row" onsubmit="sendChatMessage(event)">
              <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">
              <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
            </form>
          </div>
        </div>
      </div>

      <div class="right-panel">
        <div class="telemetry-mini-card">
          <div style="font-size:9.5px;font-weight:800;color:var(--brand);">СТАТИСТИКА КАНАЛА</div>
          <div class="tm-row"><span>P2P Stability:</span><span class="tm-val">99.8%</span></div>
          <div class="tm-row"><span>Latency:</span><span class="tm-val">18ms</span></div>
        </div>
        <div class="right-sec-title">⬢ В сети — <span id="online-count">0</span></div>
        <div id="online-users-box"></div>
        <div class="right-sec-title">⬡ Не в сети — <span id="total-members-count">0</span></div>
        <div id="offline-users-box"></div>
        <div class="right-sec-title" style="margin-top:6px;">◈ Друзья — <span id="friends-count">0</span></div>
        <div id="requests-box"></div><div id="friends-box"></div>
      </div>
    </div>
  </div>

  <!-- ВЫЕЗЖАЮЩАЯ СПРАВА КАРТОЧКА ПРОФИЛЯ -->
  <div class="profile-drawer-backdrop" id="view-profile-backdrop" onclick="closeViewProfileModal()"></div>
  <div class="profile-slide-drawer" id="view-profile-drawer">
    <div class="profile-surface psd-inner" id="vp-surface">
      <div class="profile-custom-bg" id="vp-custom-bg"></div>
      <div class="profile-frame-overlay"></div>
      <button class="dp-close-x" onclick="closeViewProfileModal()">✕</button>
      <div class="dp-body">
        <div class="cyber-diode-scene" id="vp-hero-stage"></div>
        <div class="dp-nick-line">
          <span class="dp-nick" id="vp-nick">Участник</span>
          <span id="vp-badge-slot"></span>
          <span class="status-pill on" id="vp-online-pill">В СЕТИ</span>
        </div>
        <div class="dp-status" id="vp-status"></div>
        <div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ // ДОСЬЕ</div><div class="dp-bio" id="vp-bio"></div></div>
        <div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ И ТЕГИ</div><div class="dp-tags" id="vp-tags"></div></div>
        <div class="dp-sec"><div class="dp-sec-title">АКТИВНАЯ РАМКА И НАБОР</div><div style="font-size:11.5px;color:var(--text-normal);font-weight:700;" id="vp-fx-label">Стандартный контур</div></div>
        <div class="dp-actions-col">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;">
            <button class="btn-login-mini" id="vp-mention-btn">💬 Написать (@ник)</button>
            <button class="btn-login-mini" id="vp-call-btn">🔊 Позвать в эфир</button>
          </div>
          <button class="btn-cyan" id="vp-friend-btn" style="width:100%;">+ Добавить в друзья</button>
        </div>
      </div>
    </div>
  </div>

  <div class="bottom-status-footer">
    <span id="footer-keybind-hint">ГОРЯЧИЕ КЛАВИШИ АКТИВНЫ</span>
    <span class="bsf-green">P2P ONLINE // Secure // E2EE // Latency 18ms</span>
  </div>

  <div class="mob-bottom-nav" id="mob-bottom-nav">
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()"><span>☰</span><span>Каналы</span></div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span>◈</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="toggleMobileLeft()"><span>🔊</span><span>Голос</span></div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()"><span>⬢</span><span>Участники</span></div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('profile')"><span>⚙️</span><span>Настройки</span></div>
  </div>

  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Профиль и эффекты</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">⬢ Мой профиль</div>
        <div class="settings-nav-btn" data-pane="fx" onclick="switchSettingsPane('fx')">✨ Эффекты (3 набора)</div>
        <div class="settings-nav-btn" data-pane="keybinds" onclick="switchSettingsPane('keybinds')">⌨️ Горячие клавиши</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🔑 Учётная запись</div>
        <div class="settings-nav-label">Система</div>
        <div class="settings-nav-btn" data-pane="safety" onclick="switchSettingsPane('safety')">🛡️ Фильтр 18+</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и видео</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;"><button class="btn-login-mini" style="width:100%;" onclick="closeSettingsModal()">✕ ЗАКРЫТЬ</button></div>
      </div>
      <div class="settings-content">
        <!-- ВКЛАДКА 1: МОЙ ПРОФИЛЬ С ЗАМЕТНОЙ ЗАГРУЗКОЙ ФОТО СВЕРХУ -->
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head"><h3>⬢ Мой профиль и фото</h3><button class="btn-cyan" onclick="saveProfileSettings()">СОХРАНИТЬ</button></div>

          <input type="file" id="inp-ava-file" accept="image/*" style="display:none;" onchange="handleCustomImageUpload(event, 'avatar')">
          <input type="file" id="inp-bg-file" accept="image/*" style="display:none;" onchange="handleCustomImageUpload(event, 'banner')">

          <div class="photo-upload-bar">
            <div class="pub-col">
              <span class="pub-title">📷 Фото аватара (в шестиугольник)</span>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn-cyan" style="flex:1;" onclick="document.getElementById('inp-ava-file').click()">ЗАГРУЗИТЬ СВОЁ ФОТО</button>
                <button type="button" class="btn-login-mini" onclick="clearCustomImage('avatar')">✕ Сброс</button>
              </div>
            </div>
            <div class="pub-col">
              <span class="pub-title">🖼️ Картинка фона профиля</span>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn-cyan" style="flex:1;" onclick="document.getElementById('inp-bg-file').click()">ЗАГРУЗИТЬ ФОН</button>
                <button type="button" class="btn-login-mini" onclick="clearCustomImage('banner')">✕ Сброс</button>
              </div>
            </div>
          </div>

          <div class="profile-surface" id="preview-surface">
            <div class="profile-custom-bg" id="preview-custom-bg"></div>
            <div class="profile-frame-overlay"></div>
            <div class="dp-body">
              <div class="cyber-diode-scene" id="preview-hero-stage" title="Нажмите, чтобы выбрать своё фото аватара" onclick="document.getElementById('inp-ava-file').click()"></div>
              <div class="dp-nick-line"><span class="dp-nick" id="preview-nick">Гость</span><span id="preview-badge-slot"></span></div>
              <div class="dp-status" id="preview-status"></div>
              <div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ // ДОСЬЕ</div><div class="dp-bio" id="preview-bio"></div></div>
              <div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ И ТЕГИ</div><div class="dp-tags" id="preview-tags"></div></div>
              <div class="dp-sec"><div class="dp-sec-title">АКТИВНАЯ РАМКА И НАБОР</div><div style="font-size:11.5px;color:var(--text-normal);font-weight:700;" id="preview-fx-label">Набор 1</div></div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-grid-2">
              <div><label class="field-label">Позывной (Никнейм)</label><input type="text" id="prof-nick-inp" maxlength="24" oninput="updateProfilePreview()"></div>
              <div><label class="field-label">Статус</label><select id="prof-presence-sel" onchange="updateProfilePreview()"><option value="online">⬢ В сети</option><option value="idle">🌙 Не активен</option><option value="dnd">⛔ Не беспокоить</option><option value="invisible">⬡ Невидимка</option></select></div>
            </div>
            <div><label class="field-label">Пользовательский статус</label><input type="text" id="prof-status-inp" maxlength="60" oninput="updateProfilePreview()"></div>
            <div><label class="field-label">О себе</label><textarea id="prof-bio-inp" rows="2" maxlength="220" oninput="updateProfilePreview()"></textarea></div>
            <div><label class="field-label">Интересы (через запятую)</label><input type="text" id="prof-interests-inp" maxlength="140" oninput="updateProfilePreview()"></div>
            <div class="settings-grid-2">
              <div><label class="field-label">Цвет подсветки</label><div class="color-swatches"><div class="color-swatch" style="background:#00f0ff;" onclick="selectBannerColor('#00f0ff')"></div><div class="color-swatch" style="background:#ff2a85;" onclick="selectBannerColor('#ff2a85')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectBannerColor('#10b981')"></div><div class="color-swatch" style="background:#fcee09;" onclick="selectBannerColor('#fcee09')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectBannerColor('#b829ff')"></div></div></div>
              <div><label class="field-label">Цвет 6-угольника (если без фото)</label><div class="color-swatches"><div class="color-swatch" style="background:#3b82f6;" onclick="selectAvatarColor('#3b82f6')"></div><div class="color-swatch" style="background:#ff2a85;" onclick="selectAvatarColor('#ff2a85')"></div><div class="color-swatch" style="background:#00f0ff;" onclick="selectAvatarColor('#00f0ff')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectAvatarColor('#10b981')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectAvatarColor('#b829ff')"></div></div></div>
            </div>
          </div>
        </div>

        <!-- ВКЛАДКА 2: ЭФФЕКТЫ -->
        <div class="settings-pane" id="pane-fx">
          <div class="settings-head">
            <h3>✨ Эффекты (Все 3 оригинальные рамки аватара + 3 рамки профиля)</h3>
            <button class="btn-login-mini" id="btn-disable-fx" onclick="selectEffectSet('')">Отключить</button>
          </div>
          <div class="fx-sets-grid">
            <div class="fx-bundle-card set1-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair">
                  <div id="fx-demo-slot-1"></div>
                  <div class="fxb-prof-thumb" style="background-position:0% 0%;"></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#00f0ff;">Набор 1: Люси Кушинада // Edgerunners S1</span>
                    <span class="cyber-badge b-set1">🌙 LUCY NET</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная неоновая рамка аватара с Люси + фиолетовая неоновая рамка профиля с Луной и портретом Люси.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set1" onclick="selectEffectSet('set1')">🎁 ЗАБРАТЬ</button>
            </div>

            <div class="fx-bundle-card set2-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair">
                  <div id="fx-demo-slot-2"></div>
                  <div class="fxb-prof-thumb" style="background-position:50% 0%;"></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#fcee09;">Набор 2: Edgerunners // Граффити «ОПАСНО» (Сезон 2)</span>
                    <span class="cyber-badge b-set2">⚠️ EDGERUN</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная огненно-жёлтая рамка аватара «CYBER» + граффити-рамка профиля с черепом в короне и колючей проволокой.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set2" onclick="selectEffectSet('set2')">🎁 ЗАБРАТЬ</button>
            </div>

            <div class="fx-bundle-card set3-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair">
                  <div id="fx-demo-slot-3"></div>
                  <div class="fxb-prof-thumb" style="background-position:100% 0%;"></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#ff4d79;">Набор 3: Джонни Сильверхенд // SAMURAI (Cyberpunk 2077)</span>
                    <span class="cyber-badge b-set3">🔥 SAMURAI</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная стальная рамка аватара «SAMURAI» с Джонни Сильверхендом + рамка профиля с цепями и горящей гитарой.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set3" onclick="selectEffectSet('set3')">🎁 ЗАБРАТЬ</button>
            </div>
          </div>
        </div>

        <!-- ВКЛАДКА 3: ГОРЯЧИЕ КЛАВИШИ (БЕЗ ОВЕРЛЕЯ) -->
        <div class="settings-pane" id="pane-keybinds">
          <div class="settings-head"><h3>⌨️ Горячие клавиши</h3><button class="btn-login-mini" onclick="resetKeybindsToDefault()">Сбросить</button></div>
          <div class="settings-card">
            <div class="keybind-row"><div class="toggle-title">🎤 Микрофон вкл/выкл (Mute)</div><button class="kb-btn" id="kb-btn-mute" onclick="startKeybindRecord('mute')"></button></div>
            <div class="keybind-row"><div class="toggle-title">🎧 Звук вкл/выкл (Deafen)</div><button class="kb-btn" id="kb-btn-deafen" onclick="startKeybindRecord('deafen')"></button></div>
            <div class="keybind-row"><div class="toggle-title">📷 Веб-камера</div><button class="kb-btn" id="kb-btn-cam" onclick="startKeybindRecord('cam')"></button></div>
            <div class="keybind-row"><div class="toggle-title">🖥️ Демонстрация экрана</div><button class="kb-btn" id="kb-btn-screen" onclick="startKeybindRecord('screen')"></button></div>
          </div>
        </div>

        <!-- ВКЛАДКА 4: ФИЛЬТР 18+ -->
        <div class="settings-pane" id="pane-safety">
          <div class="settings-head"><h3>🛡️ Фильтр контента 18+</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div class="toggle-title">🔞 Блокировать 18+</div><label class="cyber-switch"><input type="checkbox" id="chk-filter-sexual" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">🩸 Блокировать шок-контент</div><label class="cyber-switch"><input type="checkbox" id="chk-filter-gore" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">🔗 Проверять исходящие</div><label class="cyber-switch"><input type="checkbox" id="chk-filter-outgoing" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Действие фильтра</label><select id="sel-filter-action" onchange="saveSafetySettings()"><option value="block">🚫 Блокировать</option><option value="blur">👁️ Спойлер</option></select></div>
            <div><label class="field-label">Чёрный список слов</label><input type="text" id="inp-custom-blocklist" oninput="saveSafetySettings()"></div>
          </div>
        </div>

        <!-- ВКЛАДКА 5: ГОЛОС И ВИДЕО -->
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head"><h3>🎙️ Голос и видео</h3><button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 ОБНОВИТЬ</button></div>
          <div class="settings-card">
            <div class="settings-grid-2"><div><label class="field-label">Микрофон</label><select id="set-mic-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Аудиовыход</label><select id="set-spk-select" onchange="saveAudioVideoSettings()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Усиление микр.: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Тест микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ ПРОВЕРИТЬ</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Камера</label><select id="set-cam-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Разрешение</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
            <div class="toggle-row"><div class="toggle-title">Шумоподавление</div><label class="cyber-switch"><input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Эхоподавление</div><label class="cyber-switch"><input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Автоусиление</div><label class="cyber-switch"><input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <!-- ВКЛАДКА 6: ВНЕШНИЙ ВИД -->
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head"><h3>🎨 Внешний вид</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div class="toggle-title">Компактный чат</div><label class="cyber-switch"><input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Размер шрифта</label><select id="sel-font-size" onchange="applyAppearanceSettings()"><option value="13px">13px</option><option value="14px" selected>14px</option><option value="16px">16px</option></select></div>
          </div>
        </div>

        <!-- ВКЛАДКА 7: УВЕДОМЛЕНИЯ -->
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head"><h3>🔔 Звуковые сигналы</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div class="toggle-title">Звук нового сообщения</div><label class="cyber-switch"><input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Звук голосового канала</div><label class="cyber-switch"><input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <!-- ВКЛАДКА 8: УЧЁТНАЯ ЗАПИСЬ И ВХОД В ТОТ ЖЕ АККАУНТ С ТЕЛЕФОНА -->
        <div class="settings-pane" id="pane-account">
          <div class="settings-head"><h3>🔑 Учётная запись (ПК и Телефон)</h3></div>
          <div class="settings-card">
            <div class="field-label">Быстрый вход в этот же аккаунт на телефоне</div>
            <p style="font-size:12px;color:var(--text-normal);">Нажмите кнопку ниже, чтобы получить 4-значный код, затем откройте приложение на телефоне и введите этот код во вкладке «📲 КОД ПК/ТЕЛ»:</p>
            <div style="display:flex;gap:10px;align-items:center;">
              <button class="btn-cyan" onclick="generateDeviceLinkCode()">📲 ПОЛУЧИТЬ КОД ДЛЯ ТЕЛЕФОНА</button>
              <span id="device-link-code-box" style="font-size:20px;font-weight:900;color:var(--yellow);letter-spacing:4px;font-family:monospace;"></span>
            </div>
          </div>
          <div class="settings-card">
            <div class="field-label">Установить или обновить пароль для входа по позывному</div>
            <p style="font-size:12px;color:var(--text-normal);">Вы также можете входить на любом устройстве (ПК или Android), просто введя свой позывной <b id="acc-current-nick" style="color:var(--brand);"></b> и этот пароль:</p>
            <div style="display:flex;gap:8px;">
              <input type="password" id="acc-new-pass-inp" placeholder="Новый пароль (от 4 символов)" maxlength="64" style="flex:1;">
              <button class="btn-cyan" onclick="saveAccountPassword()">СОХРАНИТЬ ПАРОЛЬ</button>
            </div>
          </div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <button class="btn-login-mini" onclick="closeSettingsModal();openAuthModal(false)">🔄 ВОЙТИ В ДРУГОЙ АККАУНТ</button>
              <button class="btn-danger" onclick="logoutAccount()">ВЫЙТИ ИЗ АККАУНТА</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box"><h3 style="color:var(--brand);font-size:16px;margin-bottom:8px;">⚡ ПРИГЛАСИТЬ ДРУГА</h3><a class="link-box" id="public-invite-url" href="#" target="_blank"></a><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">СКОПИРОВАТЬ ССЫЛКУ</button><button class="btn-login-mini" style="width:100%;" onclick="closeInviteModal()">ЗАКРЫТЬ</button></div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО АВТОРИЗАЦИИ (ПАРОЛЬ / КОД С ПК / TELEGRAM) -->
  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="color:var(--brand);font-size:16px;">⚡ ВХОД В АККАУНТ</h3><span style="font-size:10px;background:var(--pink);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;">ПК + ANDROID</span></div>
      <div class="auth-tabs">
        <div class="auth-tab active" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 ПАРОЛЬ</div>
        <div class="auth-tab" id="tab-link-btn" onclick="switchAuthTab('link')">📲 КОД ПК/ТЕЛ</div>
        <div class="auth-tab" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ TELEGRAM</div>
      </div>

      <div id="auth-pass-panel">
        <p style="font-size:12px;color:var(--text-normal);margin-bottom:8px;">Введите ваш позывной и пароль (одинаковый на ПК и на телефоне):</p>
        <input type="text" id="nick-inp" placeholder="Ваш позывной (например: Sergo)" maxlength="24">
        <input type="password" id="pass-inp" placeholder="Пароль (минимум 4 символа)" maxlength="64">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithPassword()">ВОЙТИ В АККАУНТ</button>
      </div>

      <div id="auth-link-panel" style="display:none;">
        <p style="font-size:12px;color:var(--text-normal);margin-bottom:8px;">Откройте на ПК «Настройки -> Учётная запись -> Получить код для телефона» и введите 4 цифры здесь:</p>
        <input type="text" id="device-link-inp" placeholder="4 ЦИФРЫ КОДА" maxlength="6" style="text-align:center;font-size:16px;font-weight:900;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithDeviceCode()">ВОЙТИ В ТОТ ЖЕ АККАУНТ</button>
      </div>

      <div id="auth-tg-panel" style="display:none;">
        <p style="font-size:12px;color:var(--text-normal);margin-bottom:10px;">Откройте Telegram-бота и нажмите /start — вы войдёте в свой единый аккаунт:</p>
        <button type="button" class="btn-tg" id="tg-open-bot-btn" onclick="openTelegramBot()">✈️ ОТКРЫТЬ TELEGRAM И ПОЛУЧИТЬ КОД</button>
        <input type="text" id="tg-code-inp" placeholder="КОД ИЗ БОТА (4 ЦИФРЫ)" maxlength="6" style="text-align:center;font-size:15px;font-weight:800;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="verifyTelegramCode()">ПОДТВЕРДИТЬ И ВОЙТИ</button>
      </div>

      <button class="btn-login-mini" id="auth-close-btn" style="width:100%;margin-top:8px;" onclick="closeAuthModal()">ЗАКРЫТЬ</button>
    </div>
  </div>

  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">
    <div class="modal-box"><h3 style="color:var(--brand);font-size:16px;margin-bottom:8px;">⬢ СОЗДАТЬ СЕРВЕР</h3><input type="text" id="new-srv-name" placeholder="Название узла" maxlength="28"><input type="text" id="new-srv-desc" placeholder="Описание" maxlength="80"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">СОЗДАТЬ</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateServerModal()">ОТМЕНА</button></div>
  </div>

  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannelModal()">
    <div class="modal-box"><h3 id="create-ch-title" style="color:var(--brand);font-size:16px;margin-bottom:6px;">◈ СОЗДАТЬ КАНАЛ</h3><p id="create-ch-sub" style="font-size:12px;color:var(--text-normal);margin-bottom:10px;"></p><input type="text" id="new-ch-name" placeholder="название-канала" maxlength="28"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">СОЗДАТЬ</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateChannelModal()">ОТМЕНА</button></div>
  </div>
<script>
  const params = new URLSearchParams(window.location.search);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  function setMobActiveTab(t) { document.querySelectorAll('#mob-bottom-nav .mob-nav-item').forEach(function (e) { e.classList.toggle('active', e.id === t); }); }
  function closeMobileDrawers() {
    document.body.classList.remove('mob-left-open', 'mob-right-open');
    setMobActiveTab('mob-tab-chat');
  }
  function toggleMobileLeft() {
    closeViewProfileModal();
    const o = document.body.classList.contains('mob-left-open');
    document.body.classList.remove('mob-right-open');
    if (o) closeMobileDrawers();
    else { document.body.classList.add('mob-left-open'); setMobActiveTab('mob-tab-left'); }
  }
  function toggleMobileRight() {
    closeViewProfileModal();
    const o = document.body.classList.contains('mob-right-open');
    document.body.classList.remove('mob-left-open');
    if (o) closeMobileDrawers();
    else { document.body.classList.add('mob-right-open'); setMobActiveTab('mob-tab-right'); }
  }

  function setPersistCookie(n, v) { try { document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=31536000; SameSite=Lax'; } catch (e) {} }
  function getPersistCookie(n) { try { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; } }

  // Проверяем, авторизован ли пользователь. Если не авторизован — НЕ сохраняем его как постоянного пользователя
  let myVerified = (localStorage.getItem('cyber_verified') === '1') || (getPersistCookie('cyber_verified') === '1');
  let myUid = '';
  if (myVerified) {
    try { myUid = localStorage.getItem('cyber_uid') || getPersistCookie('cyber_uid') || ''; } catch (e) {}
  }
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
    myUid = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    myVerified = false;
  }

  let currentRoom = params.get('room') || params.get('server') || localStorage.getItem('cyber_last_room') || 'cy-4371';
  let currentChannel = params.get('channel') || 'общий', currentVoiceChannel = 'Ночной эфир';
  let myNick = myVerified ? (localStorage.getItem('cyber_nick') || getPersistCookie('cyber_nick') || 'Оператор') : 'Гость';
  let authLocked = !myVerified;

  function updateBrowserUrl() { try { window.history.replaceState({}, '', window.location.pathname + '?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel)); } catch (e) {} }

  const FX_SETS_META = {
    set1: {
      code: '⚡FX:SET1', avaClass: 'fx-set1', badgeClass: 'b-set1', badgeText: '🌙 LUCY NET', surfaceClass: 'theme-set1',
      frameImgUrl: '/variant1_lucy_avatar_frame.jpg',
      title: 'Набор 1: Люси Кушинада // Edgerunners S1'
    },
    set2: {
      code: '⚡FX:SET2', avaClass: 'fx-set2', badgeClass: 'b-set2', badgeText: '⚠️ EDGERUN', surfaceClass: 'theme-set2',
      frameImgUrl: '/variant2_edgerunner_avatar_frame.jpg',
      title: 'Набор 2: Edgerunners // Граффити «ОПАСНО» (Сезон 2)'
    },
    set3: {
      code: '⚡FX:SET3', avaClass: 'fx-set3', badgeClass: 'b-set3', badgeText: '🔥 SAMURAI', surfaceClass: 'theme-set3',
      frameImgUrl: '/variant3_johnny_avatar_frame.jpg',
      title: 'Набор 3: Джонни Сильверхенд // SAMURAI (Cyberpunk 2077)'
    }
  };

  let myProfile = { bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#00f0ff', avatarColor: '#3b82f6', fxSet: 'set1', avatarImg: '', bannerImg: '' };
  if (myVerified) {
    try { myProfile = Object.assign(myProfile, JSON.parse(localStorage.getItem('cyber_profile') || '{}')); } catch (e) {}
  }

  // Надёжная обрезка по центру и сжатие своей картинки для аватара или фона профиля
  function handleCustomImageUpload(ev, kind) {
    const file = ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (kind === 'avatar') {
          const size = 240;
          canvas.width = size;
          canvas.height = size;
          const minSide = Math.min(img.width, img.height);
          const sx = Math.floor((img.width - minSide) / 2);
          const sy = Math.floor((img.height - minSide) / 2);
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        } else {
          const maxW = 520, maxH = 700;
          const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
          canvas.width = Math.max(1, Math.round(img.width * ratio));
          canvas.height = Math.max(1, Math.round(img.height * ratio));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
        const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
        if (kind === 'avatar') myProfile.avatarImg = dataUrl;
        else myProfile.bannerImg = dataUrl;
        if (myVerified) {
          try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (err) {}
        }
        applyNickUI();
        updateProfilePreview(true);
        syncProfileToServer();
        renderUsers(lastMembers);
        rerenderChatMessages();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    ev.target.value = '';
  }

  function clearCustomImage(kind) {
    if (kind === 'avatar') myProfile.avatarImg = '';
    else myProfile.bannerImg = '';
    if (myVerified) {
      try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (err) {}
    }
    applyNickUI();
    updateProfilePreview(true);
    syncProfileToServer();
    renderUsers(lastMembers);
    rerenderChatMessages();
  }

  function buildAvatarInnerContent(letters, avaImg) {
    if (avaImg) return '<img class="ava-custom-img" src="' + escapeHtml(avaImg) + '" alt="">';
    return escapeHtml(letters);
  }

  function buildMiniHexAvatarHTML(letters, avaColor, setKey, sizePx, statusCls, avaImg) {
    const m = FX_SETS_META[setKey];
    const sz = sizePx || 36;
    const fSize = Math.max(9, Math.round(sz * 0.3));
    const innerHTML = buildAvatarInnerContent(letters, avaImg);
    const bgStyle = 'font-size:' + (m ? Math.max(8, fSize - 1) : fSize) + 'px;background:' + escapeHtml(avaColor || '#3b82f6') + ';';
    if (!m) {
      return '<div class="hex-wrap" style="width:' + sz + 'px;height:' + sz + 'px;">' +
        '<div class="hex-border"><div class="hex-core" style="' + bgStyle + '">' + innerHTML + '</div></div>' +
        (statusCls ? '<span class="hex-status-dot ' + statusCls + '"></span>' : '') +
      '</div>';
    }
    return '<div class="hex-wrap has-custom-frame ' + m.avaClass + '" style="width:' + sz + 'px;height:' + sz + 'px;">' +
      '<div class="hex-border"><div class="hex-core" style="' + bgStyle + '">' + innerHTML + '</div></div>' +
      '<img class="mini-frame-overlay" src="' + m.frameImgUrl + '" alt="">' +
      (statusCls ? '<span class="hex-status-dot ' + statusCls + '"></span>' : '') +
    '</div>';
  }

  function buildHeroHexMedallionHTML(letters, avaColor, setKey, statusCls, avaImg) {
    const m = FX_SETS_META[setKey];
    const innerHTML = buildAvatarInnerContent(letters, avaImg);
    const bgStyle = 'font-size:18px;background:' + escapeHtml(avaColor || '#3b82f6') + ';';
    if (!m) {
      return '<div class="hex-wrap" style="width:84px;height:84px;">' +
        '<div class="hex-border"><div class="hex-core" style="' + bgStyle + '">' + innerHTML + '</div></div>' +
        (statusCls ? '<span class="hex-status-dot ' + statusCls + '"></span>' : '') +
      '</div>';
    }
    return '<div class="cds-user-core" style="' + bgStyle + '">' + innerHTML + '</div>' +
      '<img class="cds-frame-img" src="' + m.frameImgUrl + '" alt="Frame">' +
      (statusCls ? '<span class="hex-status-dot ' + statusCls + '" style="right:18px;bottom:10px;"></span>' : '');
  }

  function detectFxSetFromInterests(raw) {
    const s = String(raw || '');
    if (s.includes('⚡FX:SET1')) return 'set1';
    if (s.includes('⚡FX:SET2')) return 'set2';
    if (s.includes('⚡FX:SET3') || s.includes('⚡FX:RED_NEON')) return 'set3';
    return '';
  }
  if (!myProfile.fxSet) myProfile.fxSet = detectFxSetFromInterests(myProfile.interests);

  function getUserFxSet(u) {
    if (!u) return '';
    if (u.pid && u.pid === myPid) return myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    return u.fxSet || detectFxSetFromInterests(u.interests);
  }
  function getBadgeHTML(setKey) {
    const m = FX_SETS_META[setKey];
    return m ? '<span class="cyber-badge ' + m.badgeClass + '">' + m.badgeText + '</span>' : '';
  }
  function cleanInterestsForDisplay(raw) {
    return String(raw || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && !x.startsWith('⚡FX:'); });
  }

  function selectEffectSet(setKey) {
    myProfile.fxSet = FX_SETS_META[setKey] ? setKey : '';
    const tags = cleanInterestsForDisplay(myProfile.interests);
    if (myProfile.fxSet && FX_SETS_META[myProfile.fxSet]) tags.push(FX_SETS_META[myProfile.fxSet].code);
    myProfile.interests = tags.join(', ');
    if (myVerified) { try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {} }
    updateFxButtonsUI(); applyNickUI(); updateProfilePreview(true); syncProfileToServer();
    renderUsers(lastMembers); rerenderChatMessages();
  }

  function updateFxButtonsUI() {
    const cur = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    ['set1', 'set2', 'set3'].forEach(function (k, idx) {
      const b = document.getElementById('btn-fx-' + k);
      if (b) b.textContent = (cur === k) ? '✓ АКТИВЕН' : '🎁 ЗАБРАТЬ';
      const slot = document.getElementById('fx-demo-slot-' + (idx + 1));
      if (slot) slot.innerHTML = '<div class="cyber-diode-scene" style="margin:0;width:104px;height:104px;">' + buildHeroHexMedallionHTML(myNick.slice(0, 2).toUpperCase(), myProfile.avatarColor, k, '', myProfile.avatarImg) + '</div>';
    });
    const dis = document.getElementById('btn-disable-fx');
    if (dis) dis.style.display = cur ? 'inline-block' : 'none';
  }

  function getMyMemberObject() {
    return { pid: myPid, nick: myNick, online: true, presence: myProfile.presence, customStatus: myProfile.customStatus, bio: myProfile.bio, interests: myProfile.interests, bannerColor: myProfile.bannerColor, avatarColor: myProfile.avatarColor, avatarImg: myProfile.avatarImg, bannerImg: myProfile.bannerImg, fxSet: myProfile.fxSet };
  }

  const DEFAULT_KEYBINDS = { mute: 'Alt+KeyM', deafen: 'Alt+KeyD', cam: 'Alt+KeyC', screen: 'Alt+KeyS' };
  let userKeybinds = Object.assign({}, DEFAULT_KEYBINDS);
  try { userKeybinds = Object.assign(userKeybinds, JSON.parse(localStorage.getItem('cyber_keybinds') || '{}')); } catch (e) {}
  let recordingAction = null;

  function formatKeybindCode(c) { return c ? String(c).replace('Key', '').replace('Digit', '').replace('Control', 'Ctrl') : 'Не назначено'; }
  function renderKeybindsUI() {
    ['mute', 'deafen', 'cam', 'screen'].forEach(function (act) {
      const btn = document.getElementById('kb-btn-' + act);
      if (!btn) return;
      btn.textContent = (recordingAction === act) ? 'Нажмите клавишу...' : formatKeybindCode(userKeybinds[act]);
      btn.classList.toggle('recording', recordingAction === act);
    });
    const hint = document.getElementById('footer-keybind-hint');
    if (hint) hint.textContent = 'БИНДЫ: МИКР [' + formatKeybindCode(userKeybinds.mute) + '] • ЗВУК [' + formatKeybindCode(userKeybinds.deafen) + '] • КАМЕРА [' + formatKeybindCode(userKeybinds.cam) + ']';
  }
  function startKeybindRecord(act) { recordingAction = (recordingAction === act) ? null : act; renderKeybindsUI(); }
  function resetKeybindsToDefault() { userKeybinds = Object.assign({}, DEFAULT_KEYBINDS); recordingAction = null; try { localStorage.setItem('cyber_keybinds', JSON.stringify(userKeybinds)); } catch (e) {} renderKeybindsUI(); }
  function eventToComboString(e) {
    const p = []; if (e.ctrlKey || e.metaKey) p.push('Ctrl'); if (e.altKey) p.push('Alt'); if (e.shiftKey) p.push('Shift');
    const ign = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
    if (e.code && !ign.includes(e.code)) p.push(e.code);
    return p.join('+');
  }

  let appSettings = Object.assign({ micDeviceId: '', spkDeviceId: '', camDeviceId: '', micVolume: 100, outVolume: 100, camRes: '720', noiseSuppression: true, echoCancellation: true, autoGainControl: true, compactChat: false, fontSize: '14px', soundMsg: true, soundVoice: true, filterSexual: true, filterGore: true, filterOutgoing: true, filterAction: 'block', customBlockedWords: '' }, JSON.parse(localStorage.getItem('cyber_settings') || '{}'));
  let localVault = Object.assign({ knownUsers: {}, friends: [], incoming: [], outgoing: [], servers: [], messages: {} }, JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}'));

  function saveLocalVault() {
    if (!myVerified) return;
    try {
      if (serversList && serversList.length) localVault.servers = serversList.slice(0, 40);
      if (currentRoom && roomMessagesCache) {
        if (!localVault.messages) localVault.messages = {};
        const rc = {}; Object.keys(roomMessagesCache).forEach(function (ch) { if (roomMessagesCache[ch] && roomMessagesCache[ch].length) rc[ch] = roomMessagesCache[ch].slice(-80); });
        localVault.messages[currentRoom] = rc;
      }
      localStorage.setItem('cyber_vault_v1', JSON.stringify(localVault));
    } catch (e) {}
  }
  async function pushLocalVaultToServer() {
    if (!myVerified) return;
    try {
      await fetch('/api/vault-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, profile: myProfile, servers: localVault.servers || [], room: currentRoom, messages: localVault.messages || {} }) });
    } catch (e) {}
  }

  const CLIENT_SEXUAL_RX = [/порн/i, /секс/i, /эротик/i, /интим/i, /хентай/i, /минет/i, /трах/i, /шлюх/i, /проститут/i, /сиськ/i, /вагин/i, /член/i, /голая/i, /голые/i, /обнажен/i, /porn/i, /nsfw/i, /xxx/i, /hentai/i, /onlyfans/i, /xvideos/i, /pornhub/i, /rule34/i, /nude/i, /boobs/i, /pussy/i, /dick/i];
  const CLIENT_GORE_RX = [/расчлен/i, /кишки/i, /труп/i, /казнь/i, /пытк/i, /убийств/i, /самоубийств/i, /суицид/i, /резня/i, /кровопролит/i, /увечь/i, /жесть/i, /насили/i, /террор/i, /gore/i, /liveleak/i, /bestgore/i, /behead/i, /torture/i, /suicide/i, /murder/i];
  const IMAGE_URL_RX = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'<>]*)?/i;
  const ANY_URL_RX = /(https?:\/\/[^\s"'<>]+)/g;

  function checkContentViolation(text, serverFlags) {
    const s = String(text || ''), r = [];
    if (appSettings.filterSexual && ((serverFlags && serverFlags.sexual) || CLIENT_SEXUAL_RX.some(function (rx) { return rx.test(s); }))) r.push('18+');
    if (appSettings.filterGore && ((serverFlags && serverFlags.gore) || CLIENT_GORE_RX.some(function (rx) { return rx.test(s); }))) r.push('Шок-контент');
    if (appSettings.customBlockedWords) {
      const list = String(appSettings.customBlockedWords).split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
      const low = s.toLowerCase(); if (list.some(function (w) { return low.includes(w); })) r.push('Чёрный список');
    }
    return r;
  }
  function toggleSpoiler(w) { if (w) w.classList.toggle('revealed'); }

  let clientId = Math.random().toString(36).substring(2, 10), evtSource = null, tgSessionToken = '', tgBotUsername = '', tgPollTimer = null;
  let roomMessagesCache = {}, unreadByChannel = {}, cachedMessages = [], profileSyncTimer = null;
  let serversList = [], currentServerMeta = { id: currentRoom, name: 'Ночной клуб', icon: 'НК', desc: 'Игры и разговоры', textChannels: ['игровая-комната', 'общий', 'знакомства', 'музыка'], voiceChannels: ['Ночной эфир'] };
  let rawMicStream = null, localStream = null, micGainNode = null, audioCtx = null;
  let screenStream = null, webcamStream = null, peer = null, myPeerId = null;
  let inVoice = false, inScreen = false, inWebcam = false, isMuted = false, isDeafened = false;
  let screenCalls = {}, camCalls = {}, myPid = null, lastMembers = [], social = { friends: [], incoming: [], outgoing: [], servers: [] };
  let pendingChannelType = 'text', micTestStream = null, micTestTimer = null, stageLayoutMode = 'grid';
  let callStartTime = 0, voiceLockRelease = null, wakeLockSentinel = null, keepAliveAudioEl = null, bgWorker = null, subsonicWavUrl = null;
  const SILENT_WAV_BASE64 = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function playUiBeep(freq, dur) { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(), o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq || 580; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (dur || 0.06)); } catch (e) {} }
  function formatCallTime(sec) { return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }

  function getSubsonicWavUrl() {
    if (subsonicWavUrl) return subsonicWavUrl;
    try {
      const sr = 8000, num = 16000, buf = new ArrayBuffer(44 + num * 2), view = new DataView(buf);
      const wr = function (o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
      wr(0, 'RIFF'); view.setUint32(4, 36 + num * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); wr(36, 'data'); view.setUint32(40, num * 2, true);
      for (let i = 0; i < num; i++) view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 20 * (i / sr)) * 40, true);
      subsonicWavUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      return subsonicWavUrl;
    } catch (e) { return SILENT_WAV_BASE64; }
  }

  function startBackgroundCallPersistence() {
    document.body.classList.add('voice-live');
    if (navigator.locks && navigator.locks.request && !voiceLockRelease) navigator.locks.request('signal_voice', { mode: 'exclusive' }, function () { return new Promise(function (r) { voiceLockRelease = r; }); }).catch(function () {});
    if (navigator.wakeLock && navigator.wakeLock.request && !wakeLockSentinel) navigator.wakeLock.request('screen').then(function (s) { wakeLockSentinel = s; }).catch(function () {});
    try {
      if (!keepAliveAudioEl) { keepAliveAudioEl = document.createElement('audio'); keepAliveAudioEl.playsInline = true; keepAliveAudioEl.loop = true; keepAliveAudioEl.volume = 0.02; document.body.appendChild(keepAliveAudioEl); }
      keepAliveAudioEl.src = getSubsonicWavUrl(); keepAliveAudioEl.play().catch(function () {});
    } catch (e) {}
    callStartTime = Date.now();
    if (bgWorker) try { bgWorker.terminate(); } catch (e) {}
    try {
      bgWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1);},1000);'], { type: 'application/javascript' })));
      bgWorker.onmessage = function () {
        if (!inVoice) return;
        const tStr = formatCallTime(Math.floor((Date.now() - callStartTime) / 1000));
        const stEl = document.getElementById('svd-state-text'); if (stEl) stEl.textContent = '🟢 В ЭФИРЕ • ' + tStr;
      };
    } catch (e) {}
    updateVoiceControlsUI();
  }

  function stopBackgroundCallPersistence() {
    document.body.classList.remove('voice-live');
    if (voiceLockRelease) { try { voiceLockRelease(); } catch (e) {} voiceLockRelease = null; }
    if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch (e) {} wakeLockSentinel = null; }
    if (keepAliveAudioEl) { try { keepAliveAudioEl.pause(); } catch (e) {} }
    if (bgWorker) { try { bgWorker.terminate(); } catch (e) {} bgWorker = null; }
    const stEl = document.getElementById('svd-state-text'); if (stEl) { stEl.textContent = '📡 ГОЛОСОВОЙ КАНАЛ'; stEl.classList.add('idle'); }
    updateVoiceControlsUI();
  }

  function getVoiceChannelMembers() {
    const uList = (lastMembers || []).filter(function (u) { return u.online && u.inVoice && (!u.voiceChannel || u.voiceChannel === currentVoiceChannel); });
    if (!uList.some(function (u) { return u.pid === myPid; }) && inVoice) uList.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen, interests: myProfile.interests, avatarColor: myProfile.avatarColor, avatarImg: myProfile.avatarImg, bannerImg: myProfile.bannerImg });
    return uList;
  }

  function renderSidebarVoicePeers() {
    const box = document.getElementById('sidebar-voice-peers'); if (!box) return; box.innerHTML = '';
    getVoiceChannelMembers().forEach(function (u) {
      const setKey = getUserFxSet(u);
      const r = el('div', 'vc-user-row');
      const avaHolder = document.createElement('div');
      avaHolder.innerHTML = buildMiniHexAvatarHTML(String(u.nick || '?').slice(0, 2).toUpperCase(), u.avatarColor || '#3b82f6', setKey, 28, '', u.avatarImg);
      r.appendChild(avaHolder.firstChild);
      r.appendChild(el('span', '', u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '')));
      r.onclick = function () { openUserProfileCard(u); };
      box.appendChild(r);
    });
  }

  function updateVoiceControlsUI() {
    const ubMic = document.getElementById('mute-btn'), ubDeaf = document.getElementById('deafen-btn');
    if (ubMic) { ubMic.classList.toggle('off', isMuted); ubMic.textContent = isMuted ? '🔇' : '🎤'; }
    if (ubDeaf) { ubDeaf.classList.toggle('off', isDeafened); ubDeaf.textContent = isDeafened ? '🔇' : '🎧'; }
    renderSidebarVoicePeers();
  }

  function switchAuthTab(m) {
    document.getElementById('tab-pass-btn').classList.toggle('active', m === 'pass');
    document.getElementById('tab-link-btn').classList.toggle('active', m === 'link');
    document.getElementById('tab-tg-btn').classList.toggle('active', m === 'tg');
    document.getElementById('auth-pass-panel').style.display = m === 'pass' ? 'block' : 'none';
    document.getElementById('auth-link-panel').style.display = m === 'link' ? 'block' : 'none';
    document.getElementById('auth-tg-panel').style.display = m === 'tg' ? 'block' : 'none';
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    const accNickEl = document.getElementById('acc-current-nick');
    if (accNickEl) accNickEl.textContent = myNick;
    const ava = document.getElementById('user-ava');
    ava.innerHTML = buildAvatarInnerContent(myNick.slice(0, 2).toUpperCase(), myProfile.avatarImg);
    ava.style.background = myProfile.avatarColor || '#3b82f6';

    const curSet = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests), meta = FX_SETS_META[curSet];
    const wrap = document.getElementById('user-ava-wrap');
    if (wrap) wrap.className = 'hex-wrap' + (meta ? ' has-custom-frame ' + meta.avaClass : '');
    const fImg = document.getElementById('user-ava-frame-img');
    if (fImg) {
      if (meta && meta.frameImgUrl) { fImg.src = meta.frameImgUrl; fImg.style.display = 'block'; }
      else { fImg.style.display = 'none'; }
    }
    const badgeSlot = document.getElementById('user-bar-badge-slot'); if (badgeSlot) badgeSlot.innerHTML = getBadgeHTML(curSet);
    document.getElementById('user-presence-dot').className = 'hex-status-dot ' + (myProfile.presence || 'online');
    const sStat = checkContentViolation(myProfile.customStatus || '').length ? '' : myProfile.customStatus;
    document.getElementById('user-email-label').textContent = sStat || 'В сети';
    updateFxButtonsUI();
  }

  function renderServersRail() {
    const box = document.getElementById('servers-list-box'); box.innerHTML = '';
    (serversList.length ? serversList : [currentServerMeta]).forEach(function (srv) {
      const wrap = el('div', 'srv-pill-wrap' + (srv.id === currentRoom ? ' active' : ''));
      wrap.appendChild(el('span', 'srv-pill-bar'));
      const b = el('div', 'srv-ico', srv.icon || srv.name.slice(0, 2)); b.title = srv.name;
      wrap.onclick = function () { if (srv.id !== currentRoom) switchServer(srv.id); };
      wrap.appendChild(b); box.appendChild(wrap);
    });
  }

  function renderServerChannels() {
    const sName = currentServerMeta.name || currentRoom;
    document.getElementById('srv-title-label').textContent = sName;
    const nodeLbl = document.getElementById('tt-node-label'); if (nodeLbl) nodeLbl.textContent = currentRoom;
    const tList = currentServerMeta.textChannels || ['общий']; if (!tList.includes(currentChannel)) currentChannel = tList[0] || 'общий';
    const vList = currentServerMeta.voiceChannels || ['Ночной эфир']; if (!vList.includes(currentVoiceChannel)) currentVoiceChannel = vList[0] || 'Ночной эфир';

    const tBox = document.getElementById('text-channels-list'); tBox.innerHTML = '';
    tList.forEach(function (ch) {
      const row = el('div', 'ch-btn' + (ch === currentChannel ? ' active' : '')); row.setAttribute('data-ch', ch);
      const left = el('div', 'ch-left'); left.appendChild(el('span', 'ch-hash', '#')); left.appendChild(el('span', 'ch-name-txt', ch)); row.appendChild(left);
      const unread = unreadByChannel[ch] || 0; if (unread > 0 && ch !== currentChannel) row.appendChild(el('span', 'ch-unread-badge', String(unread)));
      row.onclick = function () { setChannel(ch); }; tBox.appendChild(row);
    });

    const vBox = document.getElementById('voice-channels-list'); vBox.innerHTML = '';
    vList.forEach(function (vch) {
      const isAct = inVoice && currentVoiceChannel === vch;
      const row = el('div', 'voice-ch-box' + (isAct ? ' active' : ''));
      const left = el('div', 'ch-left'); left.appendChild(el('span', 'ch-hash', '🔊')); left.appendChild(el('span', 'ch-name-txt', vch)); row.appendChild(left);
      row.appendChild(el('span', 'off-badge' + (isAct ? ' on' : ''), isAct ? 'LIVE' : ''));
      row.onclick = function () { selectVoiceChannel(vch); }; vBox.appendChild(row);
    });
    applyChannelUI(currentChannel); updateVoicePanelUI();
  }

  function applyChannelUI(ch) {
    const sName = currentServerMeta.name || 'Ночной клуб';
    document.getElementById('top-ch-name').textContent = ch;
    document.getElementById('top-ch-desc').textContent = 'АКТИВНЫЙ ПОТОК // ' + sName.toUpperCase();
    document.getElementById('banner-desc').textContent = 'КАНАЛ #' + ch.toUpperCase();
    document.getElementById('chat-input').placeholder = 'Написать в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(function (i) { i.classList.toggle('active', i.getAttribute('data-ch') === ch); });
  }
  function updateVoicePanelUI() { document.getElementById('voice-panel-title').textContent = currentVoiceChannel; updateVoiceControlsUI(); }

  async function switchServer(roomId) {
    const clean = String(roomId || '').trim(); if (!clean || clean === currentRoom) { closeMobileDrawers(); return; }
    if (inVoice) await toggleVoiceCall();
    currentRoom = clean; unreadByChannel = {}; roomMessagesCache = {};
    try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}
    const found = serversList.find(function (s) { return s.id === currentRoom; });
    if (found) { currentServerMeta = found; currentChannel = found.textChannels[0] || 'общий'; currentVoiceChannel = found.voiceChannels[0] || 'Ночной эфир'; }
    updateBrowserUrl(); renderServersRail(); renderServerChannels(); closeMobileDrawers();
    try {
      const res = await fetch('/api/switch-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick: myNick }) });
      const data = await res.json();
      if (data && data.ok) {
        currentServerMeta = data.current || currentServerMeta; serversList = data.list || serversList; roomMessagesCache = data.messagesByChannel || {};
        if (!currentServerMeta.textChannels.includes(currentChannel)) currentChannel = currentServerMeta.textChannels[0] || 'общий';
        cachedMessages = roomMessagesCache[currentChannel] || [];
        updateBrowserUrl(); renderServersRail(); renderServerChannels(); rerenderChatMessages();
        if (Array.isArray(data.users)) renderUsers(data.users); saveLocalVault();
      }
    } catch (e) {}
  }

  function connectEventStream() {
    if (evtSource) try { evtSource.close(); } catch (e) {}
    clientId = Math.random().toString(36).substring(2, 10);
    evtSource = new EventSource('/api/events?id=' + clientId + '&uid=' + myUid + '&verified=' + (myVerified ? '1' : '0') + '&room=' + encodeURIComponent(currentRoom) + '&nick=' + encodeURIComponent(myNick));
    evtSource.onmessage = function (e) {
      let data; try { data = JSON.parse(e.data); } catch (err) { return; }
      if (data.type === 'server-meta') {
        currentServerMeta = data.payload.current; serversList = data.payload.list || [currentServerMeta];
        if (data.payload.messagesByChannel) roomMessagesCache = data.payload.messagesByChannel;
        renderServersRail(); renderServerChannels(); cachedMessages = roomMessagesCache[currentChannel] || []; rerenderChatMessages();
        if (myVerified) pushLocalVaultToServer();
      } else if (data.type === 'servers') {
        serversList = data.payload.list || []; const f = serversList.find(function (s) { return s.id === currentRoom; }); if (f) currentServerMeta = f;
        renderServersRail(); renderServerChannels(); saveLocalVault();
      } else if (data.type === 'msg') {
        const ch = data.payload.channel, msg = data.payload.msg;
        if (!roomMessagesCache[ch]) roomMessagesCache[ch] = []; roomMessagesCache[ch].push(msg); saveLocalVault();
        if (ch === currentChannel) { cachedMessages = roomMessagesCache[ch]; addMsgToDOM(msg); }
        else { unreadByChannel[ch] = (unreadByChannel[ch] || 0) + 1; renderServerChannels(); }
        if (appSettings.soundMsg && msg && msg.author !== myNick) playUiBeep(540, 0.06);
      } else if (data.type === 'users') {
        renderUsers(data.payload); updateVoiceControlsUI(); saveLocalVault();
      } else if (data.type === 'social') {
        myPid = data.payload.pid; social = data.payload;
        if (data.payload.nick) { myNick = data.payload.nick; try { localStorage.setItem('cyber_nick', myNick); } catch (err) {} setPersistCookie('cyber_nick', myNick); }
        if (data.payload.verified) { myVerified = true; authLocked = false; try { localStorage.setItem('cyber_verified', '1'); } catch (err) {} setPersistCookie('cyber_verified', '1'); closeAuthModal(); }
        Object.assign(myProfile, {
          bio: data.payload.bio !== undefined ? data.payload.bio : myProfile.bio,
          interests: data.payload.interests !== undefined ? data.payload.interests : myProfile.interests,
          customStatus: data.payload.customStatus !== undefined ? data.payload.customStatus : myProfile.customStatus,
          presence: data.payload.presence || myProfile.presence,
          bannerColor: data.payload.bannerColor || myProfile.bannerColor,
          avatarColor: data.payload.avatarColor || myProfile.avatarColor,
          avatarImg: data.payload.avatarImg !== undefined ? data.payload.avatarImg : myProfile.avatarImg,
          bannerImg: data.payload.bannerImg !== undefined ? data.payload.bannerImg : myProfile.bannerImg
        });
        const det = detectFxSetFromInterests(myProfile.interests); if (det) myProfile.fxSet = det;
        try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (err) {}
        applyNickUI(); renderSocial(); renderUsers(lastMembers); saveLocalVault();
      } else if (data.type === 'voice-join') {
        if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId && data.payload.voiceChannel === currentVoiceChannel) {
          const pid = data.payload.peerId; const call = peer.call(pid, localStream, { metadata: { kind: 'audio', nick: myNick } });
          if (call) { call.on('stream', function (s) { playStream(pid, s); }); call.on('close', function () { removeAudio(pid); }); call.on('error', function () { removeAudio(pid); }); }
          if (inScreen && screenStream) callPeerWithScreen(pid);
          if (inWebcam && webcamStream) callPeerWithWebcam(pid);
        }
      }
    };
  }

  function rerenderChatMessages() {
    const box = document.getElementById('messages-list'); box.innerHTML = '';
    if (!cachedMessages || !cachedMessages.length) { box.innerHTML = '<div id="empty-hint" style="font-size:13px;color:var(--text-muted);padding:8px 4px;">Сообщений пока нет. Напишите в консоль ниже!</div>'; return; }
    cachedMessages.forEach(addMsgToDOM);
  }

  function buildMessageBodyHTML(text, violations) {
    const safeText = escapeHtml(text).replace(ANY_URL_RX, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const imgMatch = String(text || '').match(IMAGE_URL_RX);
    let inner = '<div>' + safeText + '</div>';
    if (imgMatch) inner += '<img class="chat-inline-media" src="' + escapeHtml(imgMatch[0]) + '" alt="media" loading="lazy">';
    if (!violations || !violations.length) return inner;
    const rStr = escapeHtml(violations.join(', '));
    if (appSettings.filterAction === 'blur') return '<div class="spoiler-blur-wrap" onclick="toggleSpoiler(this)"><div class="spoiler-badge">🛡️ Скрыто фильтром (' + rStr + ') — клик для показа</div><div class="spoiler-blur-content">' + inner + '</div></div>';
    return '<div class="filtered-block-card">🛡️ Заблокировано фильтром (' + rStr + ')</div>';
  }

  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list'), hint = document.getElementById('empty-hint'); if (hint) hint.remove();
    const author = String(m.author || '?'), viol = checkContentViolation(m.text, m.flags);
    const memberObj = (lastMembers || []).find(function (u) { return u.nick === author; }) || (author === myNick ? getMyMemberObject() : { nick: author });
    const setKey = getUserFxSet(memberObj);
    const avaCol = (memberObj && memberObj.avatarColor) || '#3b82f6';
    const avaImg = (memberObj && memberObj.avatarImg) || '';
    const div = el('div', 'msg-item');
    div.innerHTML =
      '<div style="cursor:pointer;margin-top:2px;">' +
        buildMiniHexAvatarHTML(author.slice(0, 2).toUpperCase(), avaCol, setKey, 40, '', avaImg) +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="msg-head-line"><span class="msg-author">' + escapeHtml(author) + '</span>' + getBadgeHTML(setKey) + '<span class="msg-time">' + escapeHtml(m.time) + '</span></div>' +
        '<div class="msg-text">' + buildMessageBodyHTML(m.text, viol) + '</div>' +
      '</div>';
    div.querySelector('.hex-wrap').onclick = function () { openUserProfileCard(memberObj); };
    div.querySelector('.msg-author').onclick = function () { openUserProfileCard(memberObj); };
    box.appendChild(div);
    const sc = document.getElementById('chat-scroll'); sc.scrollTop = sc.scrollHeight;
  }

  function friendAction(action, pid) {
    if (!myVerified) { openAuthModal(true); return Promise.resolve(); }
    return fetch('/api/friend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, action: action, target: pid }) }).then(function (r) { return r.json(); }).catch(function () {});
  }

  function renderMemberRow(u, friendPids) {
    const d = el('div', 'online-user-item' + (u.online ? ' is-online' : '')); if (!u.online) d.style.opacity = '0.55';
    const setKey = getUserFxSet(u), fxMeta = FX_SETS_META[setKey];
    const avaHolder = document.createElement('div');
    const aImg = (u.pid === myPid ? myProfile.avatarImg : u.avatarImg) || '';
    avaHolder.innerHTML = buildMiniHexAvatarHTML(String(u.nick || '?').slice(0, 2).toUpperCase(), u.avatarColor || '#3b82f6', setKey, 36, u.online ? (u.presence || 'online') : 'off', aImg);
    d.appendChild(avaHolder.firstChild);

    const col = el('div', 'member-text-col'), nr = el('div', 'member-nick-row');
    const nickTxt = el('span', '', u.nick + (u.inVoice ? ' 🔊' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''));
    nickTxt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;'; nr.appendChild(nickTxt);
    if (fxMeta) { const bs = document.createElement('span'); bs.innerHTML = getBadgeHTML(setKey); if (bs.firstChild) nr.appendChild(bs.firstChild); }
    col.appendChild(nr);
    if (u.customStatus && !checkContentViolation(u.customStatus).length) col.appendChild(el('div', 'member-status-sub', u.customStatus));
    d.appendChild(col);

    if (myPid && u.pid !== myPid) {
      if (friendPids.includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'друг'));
      else if ((social.incoming || []).some(function (i) { return i.pid === u.pid; })) {
        const b = el('button', 'mini-btn', '✓'); b.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', u.pid); }; d.appendChild(b);
      } else if (!(social.outgoing || []).includes(u.pid)) {
        const b = el('button', 'mini-btn', '+'); b.onclick = function (ev) { ev.stopPropagation(); friendAction('request', u.pid); }; d.appendChild(b);
      }
    }
    d.onclick = function () { openUserProfileCard(u); };
    return d;
  }

  function renderUsers(list) {
    lastMembers = list || [];
    const online = lastMembers.filter(function (u) { return u.online; }), offline = lastMembers.filter(function (u) { return !u.online; });
    document.getElementById('online-count').textContent = online.length;
    document.getElementById('total-members-count').textContent = offline.length;
    const onBox = document.getElementById('online-users-box'), offBox = document.getElementById('offline-users-box');
    onBox.innerHTML = ''; offBox.innerHTML = '';
    const friendPids = (social.friends || []).map(function (f) { return f.pid; });
    online.forEach(function (u) { onBox.appendChild(renderMemberRow(u, friendPids)); });
    offline.forEach(function (u) { offBox.appendChild(renderMemberRow(u, friendPids)); });
    renderSidebarVoicePeers();
  }

  function renderSocial() {
    const friends = social.friends || [], incoming = social.incoming || [];
    document.getElementById('friends-count').textContent = friends.length;
    const rq = document.getElementById('requests-box'); rq.innerHTML = '';
    incoming.forEach(function (r) {
      const d = el('div', 'online-user-item'), nm = el('span', '', r.nick + ' (запрос)'); nm.style.cssText = 'flex:1;font-size:12px;';
      const ok = el('button', 'mini-btn', '✓'); ok.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕'); no.onclick = function (ev) { ev.stopPropagation(); friendAction('decline', r.pid); };
      d.appendChild(nm); d.appendChild(ok); d.appendChild(no); rq.appendChild(d);
    });
    const fb = document.getElementById('friends-box'); fb.innerHTML = '';
    friends.forEach(function (f) { fb.appendChild(renderMemberRow(f, [f.pid])); });
  }

  function openUserProfileCard(u) {
    if (!u) return;
    closeMobileDrawers();
    const setKey = getUserFxSet(u), fxMeta = FX_SETS_META[setKey];
    document.getElementById('vp-surface').className = 'profile-surface psd-inner' + (fxMeta ? ' ' + fxMeta.surfaceClass : '');
    const customBgEl = document.getElementById('vp-custom-bg');
    if (customBgEl) {
      const bImg = (u.pid === myPid ? myProfile.bannerImg : u.bannerImg) || '';
      customBgEl.style.backgroundImage = bImg ? 'url(\'' + bImg + '\')' : 'none';
    }
    const aImg = (u.pid === myPid ? myProfile.avatarImg : u.avatarImg) || '';
    document.getElementById('vp-hero-stage').innerHTML = buildHeroHexMedallionHTML(String(u.nick || '?').slice(0, 2).toUpperCase(), u.avatarColor || '#3b82f6', setKey, u.online ? (u.presence || 'online') : 'off', aImg);
    document.getElementById('vp-nick').textContent = u.nick || 'Участник';
    document.getElementById('vp-badge-slot').innerHTML = getBadgeHTML(setKey);
    document.getElementById('vp-fx-label').textContent = fxMeta ? fxMeta.title : 'Стандартный кибер-контур';
    const pill = document.getElementById('vp-online-pill'); pill.className = 'status-pill ' + (u.online ? 'on' : 'off'); pill.textContent = u.online ? 'В СЕТИ' : 'НЕ В СЕТИ';
    document.getElementById('vp-status').textContent = u.customStatus || 'В эфире СИГНАЛ';
    document.getElementById('vp-bio').textContent = u.bio || 'Оператор пока не добавил описание.';
    const tb = document.getElementById('vp-tags'); tb.innerHTML = '';
    cleanInterestsForDisplay(u.interests).forEach(function (tg) { tb.appendChild(el('span', 'dp-tag', tg)); });
    if (!tb.childNodes.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Интересы не указаны</span>';

    document.getElementById('vp-mention-btn').onclick = function () { closeViewProfileModal(); const inp = document.getElementById('chat-input'); inp.value = '@' + (u.nick || '') + ' ' + inp.value; inp.focus(); };
    document.getElementById('vp-call-btn').onclick = function () { closeViewProfileModal(); if (!inVoice) toggleVoiceCall(); };

    const fBtn = document.getElementById('vp-friend-btn'), friendPids = (social.friends || []).map(function (f) { return f.pid; });
    if (u.pid === myPid || u.nick === myNick) {
      fBtn.textContent = '📷 Настроить мой профиль и фото'; fBtn.className = 'btn-cyan';
      fBtn.onclick = function () { closeViewProfileModal(); openSettingsModal('profile'); };
    } else if (friendPids.includes(u.pid)) {
      fBtn.textContent = '✕ Удалить из друзей'; fBtn.className = 'btn-danger';
      fBtn.onclick = function () { friendAction('remove', u.pid); closeViewProfileModal(); };
    } else {
      fBtn.textContent = '+ Добавить в друзья'; fBtn.className = 'btn-cyan';
      fBtn.onclick = function () { friendAction('request', u.pid); closeViewProfileModal(); };
    }
    document.getElementById('view-profile-backdrop').classList.add('open');
    document.getElementById('view-profile-drawer').classList.add('open');
  }
  function closeViewProfileModal() {
    document.getElementById('view-profile-backdrop').classList.remove('open');
    document.getElementById('view-profile-drawer').classList.remove('open');
  }

  function openSettingsModal(pane) {
    if (!myVerified) return openAuthModal(true);
    closeMobileDrawers(); closeViewProfileModal(); setMobActiveTab('mob-tab-profile');
    document.getElementById('prof-nick-inp').value = myNick;
    document.getElementById('prof-presence-sel').value = myProfile.presence || 'online';
    document.getElementById('prof-status-inp').value = myProfile.customStatus || '';
    document.getElementById('prof-bio-inp').value = myProfile.bio || '';
    document.getElementById('prof-interests-inp').value = cleanInterestsForDisplay(myProfile.interests).join(', ');
    updateProfilePreview(true); updateFxButtonsUI(); renderKeybindsUI();
    refreshMediaDevices(); switchSettingsPane(pane || 'profile');
    document.getElementById('settings-modal').classList.add('open');
  }
  function closeSettingsModal() { recordingAction = null; stopMicTest(); document.getElementById('settings-modal').classList.remove('open'); setMobActiveTab('mob-tab-chat'); }
  function switchSettingsPane(pId) {
    recordingAction = null; renderKeybindsUI();
    document.querySelectorAll('.settings-nav-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-pane') === pId); });
    document.querySelectorAll('.settings-pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + pId); });
    if (pId !== 'voice') stopMicTest();
  }

  function saveSafetySettings() {
    appSettings.filterSexual = document.getElementById('chk-filter-sexual').checked;
    appSettings.filterGore = document.getElementById('chk-filter-gore').checked;
    appSettings.filterOutgoing = document.getElementById('chk-filter-outgoing').checked;
    appSettings.filterAction = document.getElementById('sel-filter-action').value || 'block';
    appSettings.customBlockedWords = document.getElementById('inp-custom-blocklist').value.trim();
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    rerenderChatMessages(); renderUsers(lastMembers); applyNickUI();
  }
  function selectBannerColor(c) { myProfile.bannerColor = c; updateProfilePreview(false); }
  function selectAvatarColor(c) { myProfile.avatarColor = c; updateProfilePreview(false); }

  function updateProfilePreview(skipSync) {
    const n = document.getElementById('prof-nick-inp').value.trim().slice(0, 24) || myNick;
    const pr = document.getElementById('prof-presence-sel').value || 'online';
    const st = document.getElementById('prof-status-inp').value.trim().slice(0, 60);
    const bio = document.getElementById('prof-bio-inp').value.trim().slice(0, 220);
    const rawIntr = document.getElementById('prof-interests-inp').value.trim().slice(0, 130);
    const cleanTags = cleanInterestsForDisplay(rawIntr);
    const curSet = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests), fxMeta = FX_SETS_META[curSet];
    if (fxMeta) cleanTags.push(fxMeta.code);
    const finalIntr = cleanTags.join(', ');

    document.getElementById('preview-surface').className = 'profile-surface' + (fxMeta ? ' ' + fxMeta.surfaceClass : '');
    const prevBg = document.getElementById('preview-custom-bg');
    if (prevBg) prevBg.style.backgroundImage = myProfile.bannerImg ? 'url(\'' + myProfile.bannerImg + '\')' : 'none';
    document.getElementById('preview-hero-stage').innerHTML = buildHeroHexMedallionHTML(n.slice(0, 2).toUpperCase(), myProfile.avatarColor || '#3b82f6', curSet, pr, myProfile.avatarImg);
    document.getElementById('preview-nick').textContent = n;
    document.getElementById('preview-badge-slot').innerHTML = getBadgeHTML(curSet);
    document.getElementById('preview-status').textContent = st || 'В сети';
    document.getElementById('preview-bio').textContent = bio || 'О себе...';
    const fxLbl = document.getElementById('preview-fx-label');
    if (fxLbl) fxLbl.textContent = fxMeta ? fxMeta.title : 'Стандартный контур';
    const tb = document.getElementById('preview-tags'); tb.innerHTML = '';
    const dTags = cleanInterestsForDisplay(finalIntr);
    if (!dTags.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Интересы не указаны</span>';
    else dTags.forEach(function (tg) { tb.appendChild(el('span', 'dp-tag', tg)); });

    if (!skipSync && myVerified) {
      myNick = n; myProfile.presence = pr; myProfile.customStatus = st; myProfile.bio = bio; myProfile.interests = finalIntr;
      try { localStorage.setItem('cyber_nick', myNick); localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
      setPersistCookie('cyber_nick', myNick); saveLocalVault(); applyNickUI();
      if (profileSyncTimer) clearTimeout(profileSyncTimer);
      profileSyncTimer = setTimeout(function () { syncProfileToServer(); }, 350);
    }
  }

  function syncProfileToServer() {
    if (!myVerified) return Promise.resolve();
    return fetch('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: myUid, nick: myNick, presence: myProfile.presence,
        customStatus: myProfile.customStatus, bio: myProfile.bio,
        interests: myProfile.interests, bannerColor: myProfile.bannerColor,
        avatarColor: myProfile.avatarColor, avatarImg: myProfile.avatarImg || '',
        bannerImg: myProfile.bannerImg || ''
      })
    }).catch(function () {});
  }
  async function saveProfileSettings() { updateProfilePreview(false); await syncProfileToServer(); closeSettingsModal(); }

  // Генерация 4-значного кода для входа в этот же аккаунт на телефоне
  async function generateDeviceLinkCode() {
    try {
      const res = await fetch('/api/device-link-init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid }) });
      const d = await res.json();
      if (d.error) return alert(d.error);
      document.getElementById('device-link-code-box').textContent = d.code;
    } catch (e) {}
  }

  async function loginWithDeviceCode() {
    const code = document.getElementById('device-link-inp').value.trim();
    if (!code) return alert('Введите 4-значный код!');
    const res = await fetch('/api/device-link-verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, room: currentRoom, code: code }) });
    const d = await res.json();
    if (d.error) return alert(d.error);
    completeClientAuth(d);
  }

  async function saveAccountPassword() {
    const pw = document.getElementById('acc-new-pass-inp').value;
    if (!pw || pw.length < 4) return alert('Пароль должен быть не менее 4 символов!');
    const res = await fetch('/api/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, password: pw }) });
    const d = await res.json();
    if (d.error) return alert(d.error);
    document.getElementById('acc-new-pass-inp').value = '';
    alert('Пароль сохранён! Теперь вы можете входить по своему позывному "' + myNick + '" и этому паролю с телефона и ПК.');
  }

  async function refreshMediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mSel = document.getElementById('set-mic-select'), sSel = document.getElementById('set-spk-select'), cSel = document.getElementById('set-cam-select');
      mSel.innerHTML = ''; sSel.innerHTML = ''; cSel.innerHTML = '';
      devs.forEach(function (d) {
        if (d.kind === 'audioinput') { const o = el('option', '', d.label || 'Микрофон'); o.value = d.deviceId; mSel.appendChild(o); }
        else if (d.kind === 'audiooutput') { const o = el('option', '', d.label || 'Динамики'); o.value = d.deviceId; sSel.appendChild(o); }
        else if (d.kind === 'videoinput') { const o = el('option', '', d.label || 'Камера'); o.value = d.deviceId; cSel.appendChild(o); }
      });
    } catch (e) {}
  }

  function onAudioSlidersChange() {
    const mv = Number(document.getElementById('set-mic-vol').value || 100), ov = Number(document.getElementById('set-out-vol').value || 100);
    document.getElementById('lbl-mic-vol').textContent = mv + '%'; document.getElementById('lbl-out-vol').textContent = ov + '%';
    appSettings.micVolume = mv; appSettings.outVolume = ov;
    if (micGainNode) micGainNode.gain.value = mv / 100;
    applyOutputVolumeToAll(); saveAudioVideoSettings();
  }
  function applyOutputVolumeToAll() {
    const vol = isDeafened ? 0 : Math.min(1, Math.max(0, (appSettings.outVolume || 100) / 100));
    document.querySelectorAll('#audio-box audio').forEach(function (a) { a.volume = vol; a.muted = isDeafened; });
  }
  function saveAudioVideoSettings() {
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll(); updateVoiceControlsUI();
  }

  async function toggleMicTest() {
    if (micTestTimer) { stopMicTest(); return; }
    try {
      micTestStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createMediaStreamSource(micTestStream), an = ctx.createAnalyser();
      an.fftSize = 256; src.connect(an); const d = new Uint8Array(an.frequencyBinCount);
      document.getElementById('btn-mic-test').textContent = '🛑 СТОП';
      micTestTimer = setInterval(function () { an.getByteFrequencyData(d); let s = 0; for (let i = 0; i < d.length; i++) s += d[i]; document.getElementById('mic-test-bar').style.width = Math.min(100, Math.round((s / d.length / 90) * 100)) + '%'; }, 60);
    } catch (e) {}
  }
  function stopMicTest() {
    if (micTestTimer) { clearInterval(micTestTimer); micTestTimer = null; }
    if (micTestStream) { micTestStream.getTracks().forEach(function (t) { t.stop(); }); micTestStream = null; }
    const b = document.getElementById('btn-mic-test'); if (b) b.textContent = '🎙️ ПРОВЕРИТЬ';
    const bar = document.getElementById('mic-test-bar'); if (bar) bar.style.width = '0%';
  }

  function applyAppearanceSettings() {
    appSettings.compactChat = document.getElementById('chk-compact').checked; appSettings.fontSize = document.getElementById('sel-font-size').value || '14px';
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {} applyAppearanceFromStorage();
  }
  function applyAppearanceFromStorage() {
    document.body.classList.toggle('compact-chat', !!appSettings.compactChat);
    document.documentElement.style.setProperty('--chat-font-size', appSettings.fontSize || '14px');
  }
  function saveNotificationSettings() {
    appSettings.soundMsg = document.getElementById('chk-snd-msg').checked; appSettings.soundVoice = document.getElementById('chk-snd-voice').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
  }
  function logoutAccount() {
    if (!confirm('Выйти из аккаунта на этом устройстве?')) return;
    try { localStorage.removeItem('cyber_verified'); localStorage.removeItem('cyber_uid'); localStorage.removeItem('cyber_nick'); } catch (e) {}
    setPersistCookie('cyber_verified', ''); setPersistCookie('cyber_uid', ''); setPersistCookie('cyber_nick', '');
    myVerified = false; closeSettingsModal(); openAuthModal(true);
  }

  function sendChatMessage(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!myVerified) { openAuthModal(true); return; }
    const inp = document.getElementById('chat-input'), text = inp.value.trim(); if (!text) return;
    if (appSettings.filterOutgoing !== false && checkContentViolation(text).length) { alert('🛡️ Заблокировано фильтром безопасности.'); return; }
    fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, channel: currentChannel, author: myNick, text: text }) }).catch(function () {});
    inp.value = '';
  }

  function setChannel(ch) { currentChannel = ch; unreadByChannel[ch] = 0; updateBrowserUrl(); applyChannelUI(ch); renderServerChannels(); cachedMessages = roomMessagesCache[ch] || []; rerenderChatMessages(); closeMobileDrawers(); }
  function selectVoiceChannel(vch) {
    if (!myVerified) { openAuthModal(true); return; }
    currentVoiceChannel = vch; updateVoicePanelUI(); renderServerChannels(); closeMobileDrawers();
    if (!inVoice) toggleVoiceCall();
    else postVoiceState({ inVoice: true, inScreen: inScreen, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
  }

  function openCreateServerModal() { if (!myVerified) return openAuthModal(true); closeMobileDrawers(); document.getElementById('create-server-modal').classList.add('open'); }
  function closeCreateServerModal() { document.getElementById('create-server-modal').classList.remove('open'); }
  async function submitCreateServer() {
    const name = document.getElementById('new-srv-name').value.trim(), desc = document.getElementById('new-srv-desc').value.trim();
    if (!name) return alert('Введите название!');
    const res = await fetch('/api/server/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, name: name, desc: desc }) });
    const d = await res.json(); if (d.error) return alert(d.error);
    closeCreateServerModal(); await switchServer(d.serverId);
  }

  function openCreateChannelModal(type) {
    if (!myVerified) return openAuthModal(true); closeMobileDrawers(); pendingChannelType = type === 'voice' ? 'voice' : 'text';
    document.getElementById('create-ch-title').textContent = pendingChannelType === 'voice' ? '🔊 СОЗДАТЬ ГОЛОСОВОЙ КАНАЛ' : '◈ СОЗДАТЬ ТЕКСТОВЫЙ КАНАЛ';
    document.getElementById('new-ch-name').value = ''; document.getElementById('create-channel-modal').classList.add('open');
  }
  function closeCreateChannelModal() { document.getElementById('create-channel-modal').classList.remove('open'); }
  async function submitCreateChannel() {
    const name = document.getElementById('new-ch-name').value.trim(); if (!name) return alert('Введите название!');
    const res = await fetch('/api/channel/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, room: currentRoom, type: pendingChannelType, name: name }) });
    const d = await res.json(); if (d.error) return alert(d.error); closeCreateChannelModal();
    if (pendingChannelType === 'text' && d.channel) { roomMessagesCache[d.channel] = []; if (!currentServerMeta.textChannels.includes(d.channel)) currentServerMeta.textChannels.push(d.channel); setChannel(d.channel); }
    else if (pendingChannelType === 'voice' && d.channel) { if (!currentServerMeta.voiceChannels.includes(d.channel)) currentServerMeta.voiceChannels.push(d.channel); currentVoiceChannel = d.channel; renderServerChannels(); }
  }

  function openInviteModal() {
    closeMobileDrawers(); document.getElementById('invite-modal').classList.add('open');
    const u = window.location.origin + '/?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel);
    document.getElementById('public-invite-url').textContent = u; document.getElementById('public-invite-url').href = u;
  }
  function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
  async function copyInviteLink() { const u = document.getElementById('public-invite-url').textContent; try { await navigator.clipboard.writeText(u); alert('Ссылка скопирована!'); } catch (e) { prompt('Скопируйте ссылку:', u); } }

  async function initTelegramSession() {
    try { const res = await fetch('/api/tg-init'); const d = await res.json(); tgSessionToken = d.token || ''; tgBotUsername = d.botUsername || ''; } catch (e) {}
  }
  function startTgPolling() {
    if (tgPollTimer) clearInterval(tgPollTimer);
    tgPollTimer = setInterval(async function () {
      if (!tgSessionToken || myVerified) return;
      try {
        const res = await fetch('/api/tg-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, token: tgSessionToken, nick: document.getElementById('nick-inp').value.trim() }) });
        const d = await res.json(); if (d && d.ok && d.verified) { clearInterval(tgPollTimer); tgPollTimer = null; completeClientAuth(d); }
      } catch (e) {}
    }, 2000);
  }
  function openTelegramBot() { if (!tgBotUsername) { switchAuthTab('pass'); return; } window.open('https://t.me/' + encodeURIComponent(tgBotUsername) + '?start=auth_' + encodeURIComponent(tgSessionToken), '_blank'); startTgPolling(); }
  async function verifyTelegramCode() {
    const code = document.getElementById('tg-code-inp').value.trim(); if (!code) return alert('Введите код!');
    const res = await fetch('/api/tg-verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, code: code, nick: document.getElementById('nick-inp').value.trim() }) });
    const d = await res.json(); if (d.error) return alert(d.error); completeClientAuth(d);
  }

  function completeClientAuth(d) {
    if (d.uid) myUid = d.uid;
    if (d.nick) myNick = d.nick;
    if (d.profile) {
      Object.assign(myProfile, d.profile);
      const det = detectFxSetFromInterests(myProfile.interests);
      if (det) myProfile.fxSet = det;
    }
    myVerified = true; authLocked = false;
    try {
      localStorage.setItem('cyber_uid', myUid);
      localStorage.setItem('cyber_nick', myNick);
      localStorage.setItem('cyber_verified', '1');
      localStorage.setItem('cyber_profile', JSON.stringify(myProfile));
    } catch (e) {}
    setPersistCookie('cyber_uid', myUid); setPersistCookie('cyber_nick', myNick); setPersistCookie('cyber_verified', '1');
    applyNickUI(); closeAuthModal(); connectEventStream();
  }

  function openAuthModal(lock) {
    authLocked = !!lock || !myVerified; document.getElementById('auth-close-btn').style.display = authLocked ? 'none' : 'block';
    if (myVerified && myNick && myNick !== 'Гость') document.getElementById('nick-inp').value = myNick;
    document.getElementById('auth-modal').classList.add('open'); initTelegramSession().then(function () { startTgPolling(); });
  }
  function closeAuthModal() { if (authLocked && !myVerified) return; if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; } document.getElementById('auth-modal').classList.remove('open'); }

  async function loginWithPassword() {
    const nick = document.getElementById('nick-inp').value.trim(), pass = document.getElementById('pass-inp').value;
    if (!nick) return alert('Введите ваш позывной!');
    if (!pass || pass.length < 4) return alert('Введите пароль (минимум 4 символа)!');
    const res = await fetch('/api/auth-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myVerified ? myUid : '', room: currentRoom, nick: nick, password: pass }) });
    const d = await res.json(); if (d.error) return alert(d.error); completeClientAuth(d);
  }

  function postVoiceState(st) { return fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: clientId }, st)) }).then(function (r) { return r.json(); }).catch(function () { return {}; }); }

  async function ensureVoiceConnected() {
    if (!myVerified) { openAuthModal(true); return false; }
    if (inVoice && peer && myPeerId) return true;
    try { rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: true }); localStream = rawMicStream; isMuted = false; }
    catch (e) { localStream = (new (window.AudioContext || window.webkitAudioContext)()).createMediaStreamDestination().stream; isMuted = true; }
    inVoice = true; if (appSettings.soundVoice) playUiBeep(720, 0.08);
    const cBtn = document.getElementById('connect-voice-btn'); if (cBtn) { cBtn.textContent = 'ВЫЙТИ'; cBtn.className = 'svd-hangup-btn'; }
    const stEl = document.getElementById('svd-state-text'); if (stEl) { stEl.textContent = '🟢 ГОЛОС ПОДКЛЮЧЕН'; stEl.classList.remove('idle'); }
    startBackgroundCallPersistence(); renderServerChannels();

    return new Promise(function (resolve) {
      peer = new Peer();
      peer.on('open', function (id) { myPeerId = id; postVoiceState({ inVoice: true, inScreen: inScreen, inCam: inWebcam, peerId: id, voiceChannel: currentVoiceChannel }).then(function () { resolve(true); }); });
      peer.on('call', function (call) {
        const kind = (call.metadata && call.metadata.kind) || 'audio', n = (call.metadata && call.metadata.nick) || 'Участник';
        if (kind === 'screen' || kind === 'cam') {
          call.answer(); call.on('stream', function (st) { renderMediaTile(kind + '-' + call.peer, st, n + (kind === 'cam' ? ' (Камера)' : ' (Экран)'), false, kind); });
          call.on('close', function () { removeMediaTile(kind + '-' + call.peer); });
        } else {
          call.answer(localStream || undefined); call.on('stream', function (st) { playStream(call.peer, st); });
          call.on('close', function () { removeAudio(call.peer); });
        }
      });
      peer.on('error', function () { resolve(false); });
    });
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (inScreen) stopScreenShare(true); if (inWebcam) stopWebcam(true);
      if (rawMicStream) rawMicStream.getTracks().forEach(function (t) { t.stop(); });
      if (peer) peer.destroy();
      rawMicStream = null; localStream = null; peer = null; myPeerId = null; inVoice = false; isMuted = false; isDeafened = false;
      const cBtn = document.getElementById('connect-voice-btn'); if (cBtn) { cBtn.textContent = 'ВОЙТИ'; cBtn.className = 'svd-connect-btn'; }
      document.getElementById('audio-box').innerHTML = ''; document.getElementById('screen-grid').innerHTML = '';
      updateMediaStageVisibility(); stopBackgroundCallPersistence(); renderServerChannels(); postVoiceState({ inVoice: false, inScreen: false, inCam: false }); return;
    }
    await ensureVoiceConnected();
  }

  function callPeerWithWebcam(pid) { if (peer && webcamStream && pid && pid !== myPeerId) camCalls[pid] = peer.call(pid, webcamStream, { metadata: { kind: 'cam', nick: myNick } }); }
  async function toggleWebcam() {
    if (!myVerified) return openAuthModal(true); if (inWebcam) { stopWebcam(false); return; }
    try { webcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); } catch (e) { alert('Разрешите доступ к камере!'); return; }
    if (!(await ensureVoiceConnected())) { webcamStream.getTracks().forEach(function (t) { t.stop(); }); return; }
    inWebcam = true; document.getElementById('cam-btn').textContent = '🛑 Камера'; document.getElementById('cam-btn').classList.add('active-cam');
    webcamStream.getVideoTracks()[0].onended = function () { stopWebcam(false); };
    renderMediaTile('cam-local', webcamStream, myNick + ' (Камера)', true, 'cam');
    const d = await postVoiceState({ inVoice: true, inScreen: inScreen, inCam: true, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d && d.peers) d.peers.forEach(callPeerWithWebcam);
    updateVoiceControlsUI();
  }
  function stopWebcam(silent) {
    if (webcamStream) { webcamStream.getTracks().forEach(function (t) { t.stop(); }); webcamStream = null; }
    inWebcam = false; document.getElementById('cam-btn').textContent = '📷 Камера'; document.getElementById('cam-btn').classList.remove('active-cam');
    removeMediaTile('cam-local'); if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: inScreen, inCam: false, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateVoiceControlsUI();
  }

  function callPeerWithScreen(pid) { if (peer && screenStream && pid && pid !== myPeerId) screenCalls[pid] = peer.call(pid, screenStream, { metadata: { kind: 'screen', nick: myNick } }); }
  async function toggleScreenShare() {
    if (!myVerified) return openAuthModal(true); if (inScreen) { stopScreenShare(false); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return alert('Демонстрация экрана недоступна.');
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); } catch (e) { return; }
    if (!(await ensureVoiceConnected())) { screenStream.getTracks().forEach(function (t) { t.stop(); }); return; }
    inScreen = true; document.getElementById('screen-btn').textContent = '🛑 Стоп'; document.getElementById('screen-btn').classList.add('active-screen');
    screenStream.getVideoTracks()[0].onended = function () { stopScreenShare(false); };
    renderMediaTile('screen-local', screenStream, myNick + ' (Экран)', true, 'screen');
    const d = await postVoiceState({ inVoice: true, inScreen: true, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d && d.peers) d.peers.forEach(callPeerWithScreen);
    updateVoiceControlsUI();
  }
  function stopScreenShare(silent) {
    if (screenStream) { screenStream.getTracks().forEach(function (t) { t.stop(); }); screenStream = null; }
    inScreen = false; document.getElementById('screen-btn').textContent = '🖥️ Экран'; document.getElementById('screen-btn').classList.remove('active-screen');
    removeMediaTile('screen-local'); if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: false, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateVoiceControlsUI();
  }

  function setStageLayout(mode) {
    stageLayoutMode = mode === 'spotlight' ? 'spotlight' : 'grid';
    const grid = document.getElementById('screen-grid'); if (!grid) return;
    grid.classList.toggle('spotlight-mode', stageLayoutMode === 'spotlight');
    document.getElementById('btn-stage-grid').classList.toggle('active', stageLayoutMode === 'grid');
    document.getElementById('btn-stage-spot').classList.toggle('active', stageLayoutMode === 'spotlight');
    if (stageLayoutMode === 'spotlight' && !grid.querySelector('.featured-tile') && grid.firstElementChild) grid.firstElementChild.classList.add('featured-tile');
  }
  function updateMediaStageVisibility() {
    const grid = document.getElementById('screen-grid'), dock = document.getElementById('media-stage-dock');
    if (grid && dock) dock.classList.toggle('show', grid.children.length > 0);
  }
  function toggleMediaNsfwShield(card, btn) {
    if (!card) return; const m = card.classList.toggle('nsfw-masked');
    if (btn) btn.textContent = m ? '👁️ Показать' : '🛡️ 18+';
  }

  function renderMediaTile(id, stream, title, isLocal, kind) {
    const grid = document.getElementById('screen-grid'); let card = document.getElementById('media-tile-' + id);
    const icon = kind === 'cam' ? '📷 ' : '🖥️ ';
    if (!card) {
      card = el('div', 'screen-card'); card.id = 'media-tile-' + id;
      card.onclick = function (ev) {
        if (ev.target.tagName === 'BUTTON') return;
        grid.querySelectorAll('.screen-card').forEach(function (c) { c.classList.remove('featured-tile'); });
        card.classList.add('featured-tile'); setStageLayout('spotlight');
      };
      const head = el('div', 'screen-card-head'), left = el('div', ''), right = el('div', ''); right.style.cssText = 'display:flex;gap:5px;align-items:center;';
      left.appendChild(el('span', '', icon + title)); left.appendChild(el('span', 'screen-live-pill' + (kind === 'cam' ? ' cam' : ''), kind === 'cam' ? 'КАМЕРА' : 'СТРИМ'));
      const sBtn = el('button', 'btn-fs', '🛡️ 18+'); sBtn.onclick = function () { toggleMediaNsfwShield(card, sBtn); }; right.appendChild(sBtn);
      const fsBtn = el('button', 'btn-fs', '⛶'); fsBtn.onclick = function () { const v = card.querySelector('video'); if (v && v.requestFullscreen) v.requestFullscreen(); }; right.appendChild(fsBtn);
      if (isLocal) { const stBtn = el('button', 'btn-fs', '✕'); stBtn.style.background = '#ff1e56'; stBtn.style.color = '#fff'; stBtn.onclick = function () { if (kind === 'cam') stopWebcam(false); else stopScreenShare(false); }; right.appendChild(stBtn); }
      head.appendChild(left); head.appendChild(right);
      const wrap = el('div', 'screen-video-wrap'), vid = document.createElement('video'); vid.autoplay = true; vid.playsInline = true; if (isLocal) vid.muted = true;
      const shield = el('div', 'media-nsfw-shield'); shield.innerHTML = '<div>🔞 Скрыто фильтром 18+</div><span class="btn-cyan" style="padding:4px 10px;font-size:10px;">👁️ Показать</span>';
      shield.onclick = function () { toggleMediaNsfwShield(card, sBtn); };
      wrap.appendChild(vid); wrap.appendChild(shield); card.appendChild(head); card.appendChild(wrap); grid.appendChild(card);
    }
    const vEl = card.querySelector('video'); if (vEl && vEl.srcObject !== stream) { vEl.srcObject = stream; vEl.play().catch(function () {}); }
    updateMediaStageVisibility();
  }
  function removeMediaTile(id) { const c = document.getElementById('media-tile-' + id); if (c) c.remove(); updateMediaStageVisibility(); }

  function toggleMute() {
    if (!localStream) return; isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    playUiBeep(isMuted ? 380 : 640, 0.05); updateVoiceControlsUI();
  }
  function toggleDeafen() { isDeafened = !isDeafened; playUiBeep(isDeafened ? 320 : 680, 0.05); applyOutputVolumeToAll(); updateVoiceControlsUI(); }
  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const a = document.createElement('audio'); a.id = 'aud-' + id; a.srcObject = stream; a.autoplay = true; a.playsInline = true;
    document.getElementById('audio-box').appendChild(a); applyOutputVolumeToAll(); a.play().catch(function () {});
  }
  function removeAudio(id) { const a = document.getElementById('aud-' + id); if (a) a.remove(); }

  document.addEventListener('keydown', function (e) {
    if (recordingAction) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { recordingAction = null; renderKeybindsUI(); return; }
      const combo = eventToComboString(e);
      if (combo && !['Ctrl', 'Alt', 'Shift'].includes(combo)) {
        userKeybinds[recordingAction] = combo;
        try { localStorage.setItem('cyber_keybinds', JSON.stringify(userKeybinds)); } catch (err) {}
        recordingAction = null; renderKeybindsUI();
      }
      return;
    }
    if (e.key === 'Escape') { closeSettingsModal(); closeViewProfileModal(); closeInviteModal(); closeMobileDrawers(); return; }
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const pressed = eventToComboString(e);
    if (!pressed) return;
    if (pressed === userKeybinds.mute) { e.preventDefault(); if (inVoice) toggleMute(); else toggleVoiceCall(); }
    else if (pressed === userKeybinds.deafen) { e.preventDefault(); if (inVoice) toggleDeafen(); }
    else if (pressed === userKeybinds.cam) { e.preventDefault(); toggleWebcam(); }
    else if (pressed === userKeybinds.screen) { e.preventDefault(); toggleScreenShare(); }
  });

  applyNickUI(); renderKeybindsUI(); applyAppearanceFromStorage(); renderServersRail(); renderServerChannels(); connectEventStream();
  if (!myVerified) openAuthModal(true);
</script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '', tooBig = false;
    req.on('data', c => { if (tooBig) return; body += c; if (body.length > MAX_BODY) tooBig = true; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
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

    const STATIC_IMAGES = {
      '/variant1_lucy_avatar_frame.jpg': ['variant1_lucy_avatar_frame.jpg'],
      '/variant2_edgerunner_avatar_frame.jpg': ['variant2_edgerunner_avatar_frame.jpg', 'set2_frame.jpg'],
      '/variant3_johnny_avatar_frame.jpg': ['variant3_johnny_avatar_frame.jpg', 'set3_frame.jpg'],
      '/profile_frames_3sets.jpg': ['Gemini_Generated_Image_4kd03t4kd03t4kd0.jpg', 'profile_frames_3sets.jpg']
    };
    if (req.method === 'GET' && STATIC_IMAGES[url.pathname]) {
      for (const fname of STATIC_IMAGES[url.pathname]) {
        const fullPath = path.join(__dirname, fname);
        if (fs.existsSync(fullPath)) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
          return res.end(fs.readFileSync(fullPath));
        }
      }
    }

    if (req.method === 'GET' && (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png' || url.pathname === '/logo.png')) {
      const logo1 = path.join(__dirname, 'logo.png');
      const logo2 = path.join(__dirname, 'logo (1).png');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      if (fs.existsSync(logo1)) return res.end(fs.readFileSync(logo1));
      if (fs.existsSync(logo2)) return res.end(fs.readFileSync(logo2));
      const fallbackPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAABlBMVEX///8ef49/6C72AAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAaklEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOA1v9QAATX6870AAAAASUVORK5CYII=', 'base64');
      return res.end(fallbackPng);
    }

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(JSON.stringify({
        id: '/',
        name: 'СИГНАЛ — Киберпанк Сеть',
        short_name: 'СИГНАЛ',
        description: 'Голосовые и текстовые P2P-каналы связи СИГНАЛ // CYBER.NET',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#04070d',
        theme_color: '#04070d',
        dir: 'ltr',
        lang: 'ru',
        categories: ['social', 'communication'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }));
    }

    if (req.method === 'GET' && url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (req.method === 'POST' && url.pathname === '/api/vault-restore') {
      const body = await readBody(req);
      const changed = restoreClientVault(body);
      if (changed) {
        broadcastServers();
        if (validUid(body.uid)) { notifyAllRoomsOfUser(body.uid); notifyFriendsOf(body.uid); sendSocial(body.uid); }
      }
      return sendJson(res, 200, { ok: true });
    }

    // Генерация 4-значного кода для входа в тот же аккаунт с телефона
    if (req.method === 'POST' && url.pathname === '/api/device-link-init') {
      const body = await readBody(req), uid = body.uid;
      if (!validUid(uid) || !users[uid] || !users[uid].verified) return sendJson(res, 400, { error: 'Сначала авторизуйтесь!' });
      Object.keys(deviceLinkCodes).forEach(k => { if (deviceLinkCodes[k].uid === uid || deviceLinkCodes[k].expires < Date.now()) delete deviceLinkCodes[k]; });
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      deviceLinkCodes[code] = { uid, expires: Date.now() + CODE_TTL_MS };
      return sendJson(res, 200, { ok: true, code });
    }

    // Вход на телефоне по 4-значному коду с ПК
    if (req.method === 'POST' && url.pathname === '/api/device-link-verify') {
      const body = await readBody(req), code = String(body.code || '').trim();
      const entry = deviceLinkCodes[code];
      if (!entry || entry.expires < Date.now() || !users[entry.uid]) return sendJson(res, 400, { error: 'Код недействителен или истёк!' });
      delete deviceLinkCodes[code];
      const finalUid = entry.uid, u = users[finalUid], room = safeRoom(body.room);
      addMember(room, finalUid);
      clients.forEach(x => { if (x.id === body.id) { x.uid = finalUid; x.nick = u.nick; } });
      scheduleSave(room); notifyAllRoomsOfUser(finalUid); notifyFriendsOf(finalUid); sendSocial(finalUid);
      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick, profile: publicProfileOf(finalUid) });
    }

    // Установка/обновление пароля в настройках аккаунта
    if (req.method === 'POST' && url.pathname === '/api/set-password') {
      const body = await readBody(req), uid = body.uid, pass = String(body.password || '');
      if (!validUid(uid) || !users[uid] || !users[uid].verified) return sendJson(res, 400, { error: 'Не авторизован' });
      if (pass.length < 4) return sendJson(res, 400, { error: 'Пароль от 4 символов' });
      users[uid].passHash = hashPassword(pass);
      nickToUid[users[uid].nick.toLowerCase()] = uid;
      scheduleSave();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/tg-init') {
      const token = crypto.randomBytes(12).toString('hex');
      pendingTgTokens[token] = { expires: Date.now() + CODE_TTL_MS, completed: null };
      return sendJson(res, 200, { enabled: !!telegramBotUsername, botUsername: telegramBotUsername, token });
    }

    if (req.method === 'POST' && url.pathname === '/api/tg-check') {
      const body = await readBody(req), token = String(body.token || '').trim();
      const entry = pendingTgTokens[token];
      if (!entry || entry.expires < Date.now() || !entry.completed) return sendJson(res, 200, { ok: true, verified: false });
      const tgInfo = entry.completed; delete pendingTgTokens[token];

      const room = safeRoom(body.room), prevUid = validUid(body.uid) ? body.uid : null;
      const finalUid = tgIdToUid[tgInfo.tgId] || uidFromTgId(tgInfo.tgId);
      const u = mergeAccount(prevUid, finalUid, cleanNick(body.nick || tgInfo.firstName || 'Странник'), tgInfo.tgId, tgInfo.username, '');
      addMember(room, finalUid);

      clients.forEach(x => { if (x.id === body.id || x.uid === prevUid || x.uid === finalUid) { x.uid = finalUid; x.nick = u.nick; } });
      scheduleSave(room); notifyAllRoomsOfUser(finalUid); notifyFriendsOf(finalUid); sendSocial(finalUid);
      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick, profile: publicProfileOf(finalUid) });
    }

    if (req.method === 'POST' && url.pathname === '/api/tg-verify-code') {
      const body = await readBody(req), code = String(body.code || '').trim();
      const entry = tgCodes[code]; if (!entry || entry.expires < Date.now()) return sendJson(res, 400, { error: 'Неверный код!' });
      delete tgCodes[code];

      const room = safeRoom(body.room), prevUid = validUid(body.uid) ? body.uid : null;
      const finalUid = tgIdToUid[entry.tgId] || uidFromTgId(entry.tgId);
      const u = mergeAccount(prevUid, finalUid, cleanNick(body.nick || entry.firstName || 'Странник'), entry.tgId, entry.username, '');
      addMember(room, finalUid);

      clients.forEach(x => { if (x.id === body.id || x.uid === prevUid || x.uid === finalUid) { x.uid = finalUid; x.nick = u.nick; } });
      scheduleSave(room); notifyAllRoomsOfUser(finalUid); notifyFriendsOf(finalUid); sendSocial(finalUid);
      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick, profile: publicProfileOf(finalUid) });
    }

    // SSE-поток событий: если зашел незарегистрированный гость, НЕ сохраняем его в базу и в список участников
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = String(url.searchParams.get('id') || '').slice(0, 32);
      const room = safeRoom(url.searchParams.get('room'));
      const nick = cleanNick(url.searchParams.get('nick') || 'Гость');
      const uid = url.searchParams.get('uid');
      const isVer = url.searchParams.get('verified') === '1' && validUid(uid);
      if (!validUid(uid)) { res.writeHead(400); return res.end(); }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');

      const meta = ensureServer(room);
      let clientNick = nick;
      if (isVer) {
        const user = ensureUser(uid, nick, true);
        clientNick = user.nick;
        addMember(room, uid);
      }

      const client = { id, uid, room, nick: clientNick, inVoice: false, inScreen: false, inCam: false, peerId: null, voiceChannel: null, res };
      clients.push(client);

      res.write('data: ' + JSON.stringify({ type: 'server-meta', payload: { current: meta, list: Object.values(serversMeta), messagesByChannel: getRoom(room) } }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'users', payload: memberList(room) }) + '\n\n');

      if (isVer) {
        notifyAllRoomsOfUser(uid); sendSocial(uid); notifyFriendsOf(uid);
      }

      req.on('close', () => {
        clients = clients.filter(c => c !== client);
        if (users[uid] && users[uid].verified) {
          notifyAllRoomsOfUser(uid); notifyFriendsOf(uid);
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/switch-room') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Некорректный ID' });
      const newRoom = safeRoom(body.room), meta = ensureServer(newRoom);
      if (users[uid] && users[uid].verified) addMember(newRoom, uid);
      let oldRoom = null;
      clients.forEach(c => { if (c.id === body.id || c.uid === uid) { oldRoom = c.room; c.room = newRoom; c.inVoice = false; c.inScreen = false; c.inCam = false; c.peerId = null; c.voiceChannel = null; } });
      if (oldRoom && oldRoom !== newRoom) broadcastUsers(oldRoom); broadcastUsers(newRoom);
      return sendJson(res, 200, { ok: true, current: meta, list: Object.values(serversMeta), messagesByChannel: getRoom(newRoom), users: memberList(newRoom) });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Некорректный ID' });
      const u = ensureUser(uid, body.nick, true);
      if (body.nick) { const cn = cleanNick(body.nick); u.nick = cn; nickToUid[cn.toLowerCase()] = uid; clients.forEach(c => { if (c.uid === uid) c.nick = cn; }); }
      if (body.bio !== undefined) u.bio = cleanText(body.bio, 220);
      if (body.interests !== undefined) u.interests = cleanText(body.interests, 160);
      if (body.customStatus !== undefined) u.customStatus = cleanText(body.customStatus, 60);
      if (body.presence !== undefined) u.presence = cleanPresence(body.presence);
      if (body.bannerColor !== undefined) u.bannerColor = cleanColor(body.bannerColor, '#00f0ff');
      if (body.avatarColor !== undefined) u.avatarColor = cleanColor(body.avatarColor, '#3b82f6');
      if (body.avatarImg !== undefined) u.avatarImg = cleanImgData(body.avatarImg);
      if (body.bannerImg !== undefined) u.bannerImg = cleanImgData(body.bannerImg);
      scheduleSave(); notifyAllRoomsOfUser(uid); notifyFriendsOf(uid); sendSocial(uid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const room = safeRoom(url.searchParams.get('room')), ch = safeChannel(room, url.searchParams.get('channel'));
      return sendJson(res, 200, (rooms[room] && rooms[room][ch]) || []);
    }

    // Вход с любого устройства (ПК или Телефон) в единый аккаунт по позывному и паролю
    if (req.method === 'POST' && url.pathname === '/api/auth-password') {
      const body = await readBody(req), nick = cleanNick(body.nick), pass = String(body.password || ''), room = safeRoom(body.room), prevUid = validUid(body.uid) ? body.uid : null;
      if (!nick || nick.length < 2) return sendJson(res, 400, { error: 'Введите позывной!' });
      if (pass.length < 4) return sendJson(res, 400, { error: 'Пароль от 4 символов!' });

      // Ищем существующий аккаунт по позывному (без учёта регистра)
      let exUid = nickToUid[nick.toLowerCase()];
      if (!exUid) {
        exUid = Object.keys(users).find(k => users[k] && users[k].verified && String(users[k].nick || '').toLowerCase() === nick.toLowerCase());
        if (exUid) nickToUid[nick.toLowerCase()] = exUid;
      }

      if (exUid && users[exUid]) {
        // Если у существующего аккаунта ещё не был задан пароль — сохраняем введённый пароль и пускаем
        if (!users[exUid].passHash) {
          users[exUid].passHash = hashPassword(pass);
        } else if (!verifyPassword(pass, users[exUid].passHash)) {
          return sendJson(res, 400, { error: 'Неверный пароль от аккаунта ' + users[exUid].nick + '!' });
        }
        const u = mergeAccount(prevUid, exUid, users[exUid].nick, '', '', '');
        addMember(room, exUid);
        clients.forEach(x => { if (x.id === body.id) { x.uid = exUid; x.nick = u.nick; } });
        scheduleSave(room); notifyAllRoomsOfUser(exUid); notifyFriendsOf(exUid); sendSocial(exUid);
        return sendJson(res, 200, { ok: true, uid: exUid, pid: u.pid, nick: u.nick, profile: publicProfileOf(exUid) });
      }

      // Если такого позывного ещё нет — создаём новый единый аккаунт
      const finalUid = crypto.createHash('sha256').update('signal-acc:' + nick.toLowerCase()).digest('hex').slice(0, 32);
      const u = mergeAccount(prevUid, finalUid, nick, '', '', hashPassword(pass));
      addMember(room, finalUid);
      clients.forEach(x => { if (x.id === body.id) { x.uid = finalUid; x.nick = u.nick; } });
      scheduleSave(room); notifyAllRoomsOfUser(finalUid); notifyFriendsOf(finalUid); sendSocial(finalUid);
      return sendJson(res, 200, { ok: true, uid: finalUid, pid: u.pid, nick: u.nick, profile: publicProfileOf(finalUid) });
    }

    if (req.method === 'POST' && url.pathname === '/api/server/create') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Сначала войдите!' });
      ensureUser(uid, body.nick || 'Участник', true);
      const name = String(body.name || '').trim().slice(0, 28);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера!' });
      const newId = 'cy-' + crypto.randomBytes(2).toString('hex');
      ensureServer(newId, name, String(body.desc || '').trim().slice(0, 80)); addMember(newId, uid);
      rooms[newId]['игровая-комната'].push({ author: 'СИСТЕМА', time: '00:00', text: 'Сервер «' + name + '» создан!' });
      scheduleSave(newId); broadcastServers();
      return sendJson(res, 200, { ok: true, serverId: newId });
    }

    if (req.method === 'POST' && url.pathname === '/api/channel/create') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Сначала войдите!' });
      ensureUser(uid, body.nick || 'Участник', true);
      const room = safeRoom(body.room), meta = ensureServer(room), type = body.type === 'voice' ? 'voice' : 'text';
      if (type === 'text') {
        const ch = cleanChannelName(body.name).toLowerCase(); if (!ch) return sendJson(res, 400, { error: 'Неверное имя!' });
        if (!meta.textChannels.includes(ch)) meta.textChannels.push(ch); if (!rooms[room][ch]) rooms[room][ch] = [];
        scheduleSave(room); broadcastServers(); return sendJson(res, 200, { ok: true, channel: ch });
      } else {
        const vch = String(body.name || '').trim().slice(0, 28); if (!vch) return sendJson(res, 400, { error: 'Введите имя!' });
        if (!meta.voiceChannels.includes(vch)) meta.voiceChannels.push(vch);
        scheduleSave(room); broadcastServers(); return sendJson(res, 200, { ok: true, channel: vch });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req), room = safeRoom(body.room), ch = safeChannel(room, body.channel), text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Пусто' });
      const c = clients.find(x => x.id === body.id), uid = c ? c.uid : body.uid;
      if (!validUid(uid) || !users[uid] || !users[uid].verified) return sendJson(res, 403, { error: 'Войдите в аккаунт' });
      const u = users[uid];
      const now = new Date(), time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author: u.nick, time, text, flags: detectFlags(text) };
      const rm = getRoom(room); if (!rm[ch]) rm[ch] = []; rm[ch].push(msg);
      if (rm[ch].length > MAX_HISTORY) rm[ch].shift();
      scheduleSave(room); broadcast(room, 'msg', { channel: ch, msg });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid) || !users[uid] || !users[uid].verified) return sendJson(res, 400, { error: 'Войдите!' });
      const me = users[uid], tUid = validPid(body.target) ? pidToUid[body.target] : null, target = tUid ? users[tUid] : null;
      if (!target || tUid === uid) return sendJson(res, 400, { error: 'Не найден' });
      const rm = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };
      let act = String(body.action || ''); if (act === 'request' && me.incoming.includes(target.pid)) act = 'accept';
      if (act === 'request') { if (!me.friends.includes(target.pid) && !me.outgoing.includes(target.pid)) { me.outgoing.push(target.pid); target.incoming.push(me.pid); } }
      else if (act === 'accept') { rm(me.incoming, target.pid); rm(target.outgoing, me.pid); if (!me.friends.includes(target.pid)) me.friends.push(target.pid); if (!target.friends.includes(me.pid)) target.friends.push(me.pid); }
      else if (act === 'decline') { rm(me.incoming, target.pid); rm(target.outgoing, me.pid); }
      else if (act === 'remove') { rm(me.friends, target.pid); rm(target.friends, me.pid); }
      scheduleSave(); sendSocial(uid); sendSocial(tUid); notifyAllRoomsOfUser(uid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req), c = clients.find(x => x.id === body.id); let peers = [];
      if (c) {
        c.inVoice = !!body.inVoice; c.inScreen = !!(c.inVoice && body.inScreen); c.inCam = !!(c.inVoice && body.inCam);
        c.peerId = body.peerId ? String(body.peerId).slice(0, 64) : null; c.voiceChannel = c.inVoice ? safeVoiceChannel(c.room, body.voiceChannel) : null;
        broadcastUsers(c.room);
        if (c.inVoice && c.peerId) {
          broadcast(c.room, 'voice-join', { peerId: c.peerId, voiceChannel: c.voiceChannel });
          peers = clients.filter(x => x.room === c.room && x.inVoice && x.peerId && x.peerId !== c.peerId && x.voiceChannel === c.voiceChannel).map(x => x.peerId);
        }
      }
      return sendJson(res, 200, { ok: true, peers });
    }

    res.writeHead(404); res.end();
  } catch (err) { if (!res.headersSent) res.writeHead(500); res.end(); }
});

server.on('error', err => console.error('Ошибка сервера:', err));

server.listen(PORT, '0.0.0.0', () => {
  console.log('⚡ СЕРВЕР СИГНАЛ ЗАПУЩЕН НА ПОРТУ ' + PORT);
  (async () => {
    for (let i = 1; i <= 3; i++) {
      try { await loadData(); break; } catch (e) { if (i === 3) loaded = true; else await new Promise(r => setTimeout(r, 1500)); }
    }
    startTelegramBotPolling();
  })();
});

async function shutdown() {
  setTimeout(() => process.exit(0), 3000).unref();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { await saveNow(); } catch (e) {}
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, shutdown));