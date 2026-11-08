const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const DEFAULT_TEXT_CHANNELS = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
const DEFAULT_VOICE_CHANNELS = ['Ночной эфир'];
const MAX_HISTORY = 500, MAX_CHANNELS = 40, MAX_SERVERS = 100, MAX_MEMBERS = 500, MAX_FRIENDS = 200;
const MAX_BODY = 2 * 1024 * 1024, CODE_TTL_MS = 10 * 60 * 1000;

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBotUsername = '', tgUpdateOffset = 0;

const serversMeta = Object.create(null), rooms = Object.create(null);
const tgCodes = Object.create(null), pendingTgTokens = Object.create(null);
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

function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(String(pw), s, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, orig] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(orig, 'hex'), Buffer.from(test, 'hex'));
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
    text: 'Добро пожаловать в «Ночной клуб»! Активирован мобильный фоновый режим звонка (PWA + Base64 WAV + Web Worker + WakeLock/MediaSession).'
  });
}

const safeChannel = (r, c) => { const m = ensureServer(r); return m.textChannels.includes(String(c || '').trim()) ? String(c).trim() : m.textChannels[0]; };
const safeVoiceChannel = (r, c) => { const m = ensureServer(r); return m.voiceChannels.includes(String(c || '').trim()) ? String(c).trim() : m.voiceChannels[0]; };
const getRoom = r => (ensureServer(r), rooms[r]);

// ---------- Telegram Bot API ----------
async function tgApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(35000)
  });
  return res.json();
}

function generateTgCode(tgId, firstName, username) {
  Object.keys(tgCodes).forEach(k => { if (tgCodes[k].tgId === String(tgId) || tgCodes[k].expires < Date.now()) delete tgCodes[k]; });
  let code = Math.floor(1000 + Math.random() * 9000).toString();
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
            await tgApi('sendMessage', { chat_id: m.chat.id, parse_mode: 'Markdown', text: `⚡ *СИГНАЛ // CYBER.NET*\n\n✅ Аккаунт подтверждён!\n🔑 Код: *${code}*\n\nВернитесь в браузер — вход выполнится автоматически.` }).catch(() => {});
          }
        }
      } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}

// ---------- Хранилище: Redis / data.json / Vault Auto-Restore ----------
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

function usersPart() {
  const o = {};
  Object.keys(users).forEach(uid => { o[uid] = Object.assign({}, users[uid]); });
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
    const u = d.users[uid] || {}, ex = users[uid] || {};
    const nick = cleanNick(u.nick || ex.nick);
    users[uid] = {
      pid: validPid(u.pid) ? u.pid : (ex.pid || pidOf(uid)), nick,
      tgId: String(u.tgId || ex.tgId || '').trim(), tgUsername: String(u.tgUsername || ex.tgUsername || '').trim(),
      passHash: String(u.passHash || ex.passHash || ''), verified: u.verified !== undefined ? !!u.verified : true,
      bio: cleanText(u.bio !== undefined ? u.bio : ex.bio, 220), interests: cleanText(u.interests !== undefined ? u.interests : ex.interests, 160),
      customStatus: cleanText(u.customStatus !== undefined ? u.customStatus : ex.customStatus, 60), presence: cleanPresence(u.presence || ex.presence),
      bannerColor: cleanColor(u.bannerColor || ex.bannerColor, '#0d9488'), avatarColor: cleanColor(u.avatarColor || ex.avatarColor, '#e11d48'),
      friends: pidList([].concat(ex.friends || [], u.friends || [])), incoming: pidList([].concat(ex.incoming || [], u.incoming || [])),
      outgoing: pidList([].concat(ex.outgoing || [], u.outgoing || [])), servers: roomList([].concat(ex.servers || [], u.servers || []))
    };
    pidToUid[users[uid].pid] = uid;
    if (users[uid].tgId) tgIdToUid[users[uid].tgId] = uid;
    if (users[uid].verified && nick) nickToUid[nick.toLowerCase()] = uid;
  });
  Object.keys(d.members || {}).forEach(r => {
    if (safeRoom(r) !== r || !Array.isArray(d.members[r])) return;
    ensureServer(r);
    const cur = members[r] || (members[r] = []);
    d.members[r].filter(validUid).forEach(u => { if (!cur.includes(u) && cur.length < MAX_MEMBERS) cur.push(u); });
  });
  Object.keys(d.messages || {}).forEach(r => {
    if (safeRoom(r) !== r || !d.messages[r]) return;
    const meta = ensureServer(r), rm = getRoom(r);
    Object.keys(d.messages[r]).forEach(ch => {
      const c = cleanChannelName(ch);
      if (!c || !Array.isArray(d.messages[r][ch])) return;
      if (!meta.textChannels.includes(c) && meta.textChannels.length < MAX_CHANNELS) meta.textChannels.push(c);
      const exList = rm[c] || [], seen = new Set(exList.map(m => `${m.author}|${m.time}|${m.text}`));
      d.messages[r][ch].slice(-MAX_HISTORY).forEach(m => {
        const cm = { author: String(m.author || '').slice(0, 24), time: String(m.time || '').slice(0, 5), text: String(m.text || '').slice(0, 1000) };
        cm.flags = detectFlags(cm.text);
        const k = `${cm.author}|${cm.time}|${cm.text}`;
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

function ensureUser(uid, nick, ver) {
  let u = users[uid]; const n = cleanNick(nick);
  if (!u) {
    u = users[uid] = { pid: pidOf(uid), nick: n, tgId: '', tgUsername: '', passHash: '', verified: !!ver, bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#0d9488', avatarColor: '#e11d48', friends: [], incoming: [], outgoing: [], servers: [] };
    pidToUid[u.pid] = uid; if (u.verified) nickToUid[n.toLowerCase()] = uid; scheduleSave();
  } else {
    if (ver && !u.verified) { u.verified = true; scheduleSave(); }
    if (nick && !u.verified && u.nick !== n) { u.nick = n; scheduleSave(); }
  }
  return u;
}

function addMember(room, uid) {
  const r = safeRoom(room), arr = members[r] || (members[r] = []);
  if (!arr.includes(uid) && arr.length < MAX_MEMBERS) { arr.push(uid); scheduleSave(); }
  if (users[uid] && !users[uid].servers.includes(r)) { users[uid].servers.push(r); scheduleSave(); }
}

function restoreClientVault(v) {
  if (!v || typeof v !== 'object') return false;
  (v.knownUsers || []).forEach(ku => {
    if (!ku || !validPid(ku.pid)) return;
    const tUid = pidToUid[ku.pid] || (validUid(ku.uid) ? ku.uid : crypto.createHash('sha256').update('ghost:' + ku.pid).digest('hex').slice(0, 32));
    if (!users[tUid]) {
      users[tUid] = { pid: ku.pid, nick: cleanNick(ku.nick), tgId: '', tgUsername: '', passHash: '', verified: true, bio: cleanText(ku.bio, 220), interests: cleanText(ku.interests, 160), customStatus: cleanText(ku.customStatus, 60), presence: cleanPresence(ku.presence), bannerColor: cleanColor(ku.bannerColor, '#0d9488'), avatarColor: cleanColor(ku.avatarColor, '#e11d48'), friends: [], incoming: [], outgoing: [], servers: [] };
      pidToUid[ku.pid] = tUid;
    }
  });
  if (validUid(v.uid)) {
    const me = ensureUser(v.uid, v.nick || 'Участник', true);
    if (v.profile) Object.assign(me, { bio: cleanText(v.profile.bio || me.bio, 220), interests: cleanText(v.profile.interests || me.interests, 160), customStatus: cleanText(v.profile.customStatus || me.customStatus, 60), presence: cleanPresence(v.profile.presence || me.presence), bannerColor: cleanColor(v.profile.bannerColor || me.bannerColor, '#0d9488'), avatarColor: cleanColor(v.profile.avatarColor || me.avatarColor, '#e11d48') });
    (v.friends || []).filter(validPid).forEach(p => {
      if (!me.friends.includes(p)) me.friends.push(p);
      const fu = pidToUid[p]; if (fu && users[fu] && !users[fu].friends.includes(me.pid)) users[fu].friends.push(me.pid);
    });
  }
  if (Array.isArray(v.servers)) { const so = {}; v.servers.forEach(s => { if (s && s.id) so[s.id] = s; }); applyData({ servers: so }); }
  if (v.room && Array.isArray(v.roomMembersPids)) v.roomMembersPids.forEach(p => { if (pidToUid[p]) addMember(v.room, pidToUid[p]); });
  if (v.messages) applyData({ messages: v.messages });
  scheduleSave();
  return true;
}

function mergeAccount(prevUid, finalUid, nick, tgId, tgUsername, passHash) {
  const prev = prevUid && users[prevUid] ? users[prevUid] : {};
  const ex = users[finalUid] || {};
  const u = users[finalUid] = {
    pid: ex.pid || pidOf(finalUid), nick: cleanNick(nick || ex.nick || prev.nick),
    tgId: tgId || ex.tgId || prev.tgId || '', tgUsername: tgUsername || ex.tgUsername || prev.tgUsername || '',
    passHash: passHash || ex.passHash || prev.passHash || '', verified: true,
    bio: ex.bio || prev.bio || '', interests: ex.interests || prev.interests || '',
    customStatus: ex.customStatus || prev.customStatus || '', presence: ex.presence || prev.presence || 'online',
    bannerColor: ex.bannerColor || prev.bannerColor || '#0d9488', avatarColor: ex.avatarColor || prev.avatarColor || '#e11d48',
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
  return { pid: u.pid, nick: u.nick, tgUsername: u.tgUsername || '', verified: !!u.verified, online: on, presence: on ? (u.presence || 'online') : 'offline', bio: u.bio || '', interests: u.interests || '', customStatus: u.customStatus || '', bannerColor: u.bannerColor || '#0d9488', avatarColor: u.avatarColor || '#e11d48' };
}

function sendSocial(uid) {
  const u = users[uid]; if (!u) return;
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
    if (!c.uid) return;
    const pr = on.get(c.uid), ir = c.room === room;
    on.set(c.uid, { inVoice: !!(pr && pr.inVoice) || (ir && !!c.inVoice), inScreen: !!(pr && pr.inScreen) || (ir && !!c.inScreen), inCam: !!(pr && pr.inCam) || (ir && !!c.inCam), voiceChannel: (ir && c.inVoice) ? c.voiceChannel : (pr ? pr.voiceChannel : null) });
  });
  return (members[room] || []).map(uid => {
    const u = users[uid] || { pid: pidOf(uid), nick: '?' }, o = on.get(uid), isOn = !!o && u.presence !== 'invisible';
    return { pid: u.pid, nick: u.nick, verified: !!u.verified, online: isOn, presence: isOn ? (u.presence || 'online') : 'offline', customStatus: u.customStatus || '', bio: u.bio || '', interests: u.interests || '', bannerColor: u.bannerColor || '#0d9488', avatarColor: u.avatarColor || '#e11d48', inVoice: !!(o && o.inVoice), inScreen: !!(o && o.inScreen), inCam: !!(o && o.inCam), voiceChannel: o ? o.voiceChannel : null };
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="manifest" href="/manifest.json">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#040609">
<title>СИГНАЛ — Ночной клуб</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root { --bg-darkest:#040609; --bg-sidebar:#080d14; --bg-main:#0b1118; --bg-card:#0f1722; --bg-input:#131c28; --cyan:#14b8a6; --cyan-bright:#2dd4bf; --pink:#db2777; --pink-border:rgba(219,39,119,0.4); --text-main:#f1f5f9; --text-muted:#64748b; --text-dim:#94a3b8; --border:rgba(255,255,255,0.08); --cyan-border:rgba(45,212,191,0.35); --chat-font-size:12px; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg-darkest); color:var(--text-main); height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden; user-select:none; }
  .top-header { height:38px; background:#030508; border-bottom:1px solid var(--border); display:flex; align-items:center; padding:0 16px; gap:12px; font-size:12px; flex-shrink:0; }
  .top-logo { display:flex; align-items:center; gap:6px; font-weight:800; color:#fff; background:#e11d48; padding:3px 8px; border-radius:4px; font-size:11px; }
  .top-sub { color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .top-right-group { margin-left:auto; display:flex; align-items:center; gap:8px; }
  .btn-top-settings { background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--text-main); padding:4px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer; }
  .btn-top-invite { background:#9d174d; border:1px solid #f43f5e; color:#fff; padding:4px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; }
  .workspace { flex:1; display:grid; grid-template-columns:68px 250px 1fr 260px; overflow:hidden; position:relative; min-height:0; }
  .servers-rail { background:#030508; border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:10px; overflow-y:auto; }
  .bolt-icon { width:40px; height:40px; display:flex; align-items:center; justify-content:center; color:var(--cyan-bright); font-size:18px; }
  .srv-ico { width:42px; height:42px; border-radius:12px; background:var(--bg-card); border:1px solid var(--border); color:var(--text-dim); font-weight:700; font-size:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; }
  .srv-ico.active { background:var(--cyan-bright); color:#042f2e; border-color:var(--cyan-bright); box-shadow:0 0 12px rgba(45,212,191,0.4); }
  .srv-ico-add { background:transparent; border:1px dashed var(--border); color:var(--pink); font-size:18px; border-radius:12px; width:42px; height:42px; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; }
  .channels-panel { background:var(--bg-sidebar); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
  .srv-header { padding:12px 14px 8px; }
  .srv-label { font-size:9px; text-transform:uppercase; color:var(--text-muted); font-weight:700; }
  .srv-title { font-size:16px; font-weight:800; color:#fff; margin-top:2px; }
  .freq-card { margin:4px 10px 10px; padding:12px; border-radius:10px; background:linear-gradient(135deg,#111a24,#0a0f16); border:1px solid var(--border); }
  .freq-top { display:flex; justify-content:space-between; margin-bottom:6px; font-size:9px; font-weight:700; color:var(--text-muted); }
  .live-badge { background:#9d174d; color:#fff; padding:1px 6px; border-radius:4px; }
  .freq-card h4 { font-size:14px; font-weight:800; margin-bottom:4px; }
  .freq-card p { font-size:10px; color:var(--text-dim); }
  .channels-scroll { flex:1; overflow-y:auto; padding:0 8px; }
  .cat-header { display:flex; justify-content:space-between; align-items:center; padding:8px 6px 4px; font-size:9px; font-weight:700; color:var(--text-muted); }
  .cat-add-btn { background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--cyan-bright); width:20px; height:20px; border-radius:4px; cursor:pointer; font-weight:700; }
  .ch-btn, .voice-ch-box { display:flex; align-items:center; justify-content:space-between; padding:8px 9px; border-radius:6px; font-size:12px; color:var(--text-dim); cursor:pointer; margin-bottom:2px; }
  .ch-btn.active { background:rgba(20,184,166,0.12); color:#fff; font-weight:600; }
  .voice-ch-box.active { background:rgba(20,184,166,0.12); color:#4ade80; font-weight:600; }
  .ch-dot { width:5px; height:5px; border-radius:50%; background:var(--cyan-bright); display:none; }
  .ch-btn.active .ch-dot { display:block; }
  .ch-unread-badge { background:#e11d48; color:#fff; font-size:9px; font-weight:800; padding:1px 5px; border-radius:999px; }
  .off-badge { font-size:9px; background:rgba(255,255,255,0.05); color:var(--text-muted); padding:1px 6px; border-radius:4px; font-weight:700; }
  .off-badge.on { background:#064e3b; color:#34d399; }
  .user-bar { padding:8px 10px; background:#030508; border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .user-info { display:flex; align-items:center; gap:8px; overflow:hidden; cursor:pointer; flex:1; min-width:0; }
  .user-ava-wrap { position:relative; flex-shrink:0; }
  .user-ava { width:30px; height:30px; border-radius:8px; background:#e11d48; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; }
  .user-presence-dot { position:absolute; right:-2px; bottom:-2px; width:10px; height:10px; border-radius:50%; background:#22c55e; border:2px solid #030508; }
  .user-presence-dot.idle { background:#eab308; } .user-presence-dot.dnd { background:#ef4444; } .user-presence-dot.invisible, .user-presence-dot.offline { background:#64748b; }
  .user-name { font-size:11px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-sub { font-size:9px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .btn-icon-bar { background:rgba(255,255,255,0.04); border:1px solid var(--border); color:var(--text-dim); width:28px; height:28px; border-radius:6px; cursor:pointer; }
  .btn-login-mini { background:rgba(20,184,166,0.08); border:1px solid var(--cyan-border); color:var(--cyan-bright); padding:5px 10px; border-radius:6px; font-size:10px; font-weight:700; cursor:pointer; white-space:nowrap; }
  .main-chat { background:var(--bg-main); display:flex; flex-direction:column; overflow:hidden; min-width:0; min-height:0; }
  .chat-topbar { height:48px; padding:0 14px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px; flex-shrink:0; }
  .chat-topbar-left, .chat-topbar-right { display:flex; align-items:center; gap:8px; min-width:0; }
  .hash-large { color:var(--cyan-bright); font-size:18px; font-weight:800; }
  .top-ch-name { font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .top-ch-desc { font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .btn-top-right-share { background:#0d9488; color:#fff; border:none; padding:6px 11px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; }
  .mob-top-btn { display:none; background:rgba(255,255,255,0.05); border:1px solid var(--border); color:#fff; width:34px; height:34px; border-radius:8px; align-items:center; justify-content:center; font-size:15px; cursor:pointer; }
  .mob-drawer-backdrop { display:none; position:fixed; inset:0; background:rgba(2,5,10,0.72); backdrop-filter:blur(3px); z-index:940; }
  .mob-bottom-nav { display:none; height:54px; background:#04070c; border-top:1px solid var(--border); grid-template-columns:repeat(5,1fr); align-items:center; flex-shrink:0; z-index:960; }
  .mob-nav-item { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; height:100%; color:var(--text-dim); font-size:9.5px; font-weight:700; cursor:pointer; }
  .mob-nav-item.active { color:var(--cyan-bright); background:rgba(45,212,191,0.07); }
  .chat-scroll-area { flex:1; overflow-y:auto; padding:14px 18px; display:flex; flex-direction:column; gap:12px; min-height:0; }
  .hero-banner { background:linear-gradient(135deg,#0f1726,#080e17); border:1px solid var(--border); border-radius:12px; padding:16px 18px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .hero-banner h2 { font-size:20px; font-weight:800; margin:4px 0; }
  .hero-banner p { font-size:11px; color:var(--text-dim); margin-bottom:8px; }
  .pill-tags-row { display:flex; gap:6px; flex-wrap:wrap; }
  .pill-tag { padding:4px 9px; border-radius:999px; font-size:9px; font-weight:700; background:rgba(255,255,255,0.04); border:1px solid var(--border); color:#cbd5e1; cursor:pointer; }
  .pill-tag.pink { background:rgba(219,39,119,0.15); border-color:var(--pink-border); color:#f43f5e; }
  .messages-container { display:flex; flex-direction:column; gap:8px; }
  .msg-item { display:flex; gap:10px; background:rgba(255,255,255,0.015); padding:8px 10px; border-radius:8px; border:1px solid var(--border); }
  body.compact-chat .msg-item { padding:4px 8px; align-items:center; }
  .msg-ava { width:28px; height:28px; border-radius:6px; background:var(--cyan); color:#042f2e; font-weight:800; font-size:11px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .msg-author { font-size:12px; font-weight:700; color:#fff; margin-right:6px; }
  .msg-time { font-size:9px; color:var(--text-muted); }
  .msg-text { font-size:var(--chat-font-size); color:#e2e8f0; margin-top:2px; user-select:text; word-break:break-word; }
  .filtered-block-card { display:inline-flex; align-items:center; gap:8px; background:rgba(225,29,72,0.1); border:1px dashed rgba(244,63,94,0.45); color:#fda4af; padding:6px 10px; border-radius:7px; font-size:11px; font-weight:600; margin-top:4px; }
  .spoiler-blur-wrap { position:relative; display:inline-block; width:100%; background:rgba(15,23,34,0.9); border:1px solid rgba(244,63,94,0.4); border-radius:8px; padding:8px 10px; margin-top:4px; cursor:pointer; }
  .spoiler-blur-content { filter:blur(8px); user-select:none; pointer-events:none; transition:0.2s; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter:none; user-select:text; pointer-events:auto; }
  .spoiler-badge { display:inline-flex; font-size:10px; font-weight:700; color:#fda4af; background:rgba(225,29,72,0.2); padding:3px 8px; border-radius:5px; margin-bottom:4px; }
  .spoiler-blur-wrap.revealed .spoiler-badge { display:none; }
  .chat-inline-media { max-width:100%; max-height:220px; border-radius:8px; border:1px solid var(--border); margin-top:6px; display:block; }
  .voice-panel { background:rgba(13,148,136,0.06); border:1px solid var(--cyan-border); border-radius:10px; padding:12px 16px; display:flex; flex-direction:column; gap:10px; }
  .voice-panel-top { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .voice-label { font-size:9px; text-transform:uppercase; color:var(--cyan-bright); font-weight:700; }
  .voice-title { font-size:12px; font-weight:700; margin:2px 0; }
  .voice-sub { font-size:10px; color:var(--text-dim); }
  .voice-active-area { display:none; flex-direction:column; gap:10px; padding-top:8px; border-top:1px solid var(--border); }
  .voice-active-area.show { display:flex; }
  .voice-user-card { display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.3); padding:6px 10px; border-radius:8px; border:1px solid var(--border); width:fit-content; }
  .vu-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; }
  .floating-call-overlay { position:fixed; right:18px; bottom:72px; width:300px; background:rgba(8,13,20,0.96); border:1px solid var(--cyan-border); border-radius:12px; padding:10px 12px; z-index:980; box-shadow:0 14px 40px rgba(0,0,0,0.85); display:none; flex-direction:column; gap:8px; backdrop-filter:blur(8px); }
  .floating-call-overlay.show { display:flex; }
  .fco-head { display:flex; justify-content:space-between; align-items:center; cursor:move; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .fco-live { display:flex; align-items:center; gap:6px; font-size:10px; font-weight:800; color:var(--cyan-bright); }
  .fco-pulse { width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 8px #22c55e; }
  .fco-timer { font-size:10px; font-family:monospace; color:#cbd5e1; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; }
  .fco-peers { display:flex; flex-wrap:wrap; gap:5px; max-height:74px; overflow-y:auto; }
  .fco-peer-chip { display:inline-flex; align-items:center; gap:5px; background:rgba(255,255,255,0.04); border:1px solid var(--border); padding:3px 7px; border-radius:999px; font-size:10px; color:#f1f5f9; }
  .fco-actions { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
  .fco-btn { background:#131c28; border:1px solid var(--border); color:#fff; padding:6px 4px; border-radius:6px; font-size:10px; font-weight:700; cursor:pointer; }
  .fco-btn.danger { background:rgba(239,68,68,0.2); border-color:rgba(239,68,68,0.5); color:#fca5a5; }
  .fco-btn.active-pip { background:rgba(20,184,166,0.22); border-color:var(--cyan-bright); color:var(--cyan-bright); }
  .screen-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px; width:100%; }
  .screen-grid:empty { display:none; }
  .screen-card { background:#05080d; border:1px solid var(--cyan-border); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .screen-card-head { display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:rgba(15,23,34,0.95); border-bottom:1px solid var(--border); font-size:11px; font-weight:700; color:var(--cyan-bright); gap:6px; flex-wrap:wrap; }
  .screen-live-pill { background:#e11d48; color:#fff; font-size:9px; padding:2px 6px; border-radius:4px; margin-left:6px; }
  .screen-live-pill.cam { background:#0d9488; }
  .screen-video-wrap { position:relative; width:100%; background:#000; display:flex; align-items:center; justify-content:center; min-height:160px; max-height:380px; overflow:hidden; }
  .screen-video-wrap video { width:100%; max-height:380px; object-fit:contain; background:#000; display:block; transition:filter 0.25s; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter:blur(26px) brightness(0.3); }
  .media-nsfw-shield { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:rgba(4,7,13,0.72); color:#fda4af; font-size:12px; font-weight:700; text-align:center; padding:14px; z-index:5; cursor:pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display:flex; }
  .btn-fs { background:rgba(255,255,255,0.08); border:1px solid var(--border); color:#fff; padding:3px 8px; border-radius:5px; font-size:10px; font-weight:600; cursor:pointer; }
  .btn-fs.active-shield { background:rgba(225,29,72,0.25); border-color:#f43f5e; color:#fda4af; }
  .chat-bottom { padding:8px 18px 12px; border-top:1px solid var(--border); background:#070b12; display:flex; flex-direction:column; gap:6px; flex-shrink:0; }
  .input-row { display:flex; gap:8px; align-items:center; }
  .chat-inp { flex:1; min-width:0; background:var(--bg-input); border:1px solid var(--border); padding:9px 12px; border-radius:6px; color:#fff; font-size:13px; outline:none; }
  .bottom-hint { font-size:9px; color:var(--text-muted); }
  .right-panel { background:var(--bg-sidebar); border-left:1px solid var(--border); padding:14px 12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto; }
  .right-sec-title { font-size:9px; text-transform:uppercase; color:var(--cyan-bright); font-weight:700; display:flex; justify-content:space-between; }
  .online-user-item { display:flex; align-items:center; gap:7px; font-size:11px; padding:6px 7px; background:rgba(255,255,255,0.02); border-radius:7px; border:1px solid transparent; cursor:pointer; min-width:0; }
  .online-user-item.is-online { border-color:rgba(34,197,94,0.14); }
  .online-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e; flex-shrink:0; }
  .online-dot.idle { background:#eab308; } .online-dot.dnd { background:#ef4444; } .online-dot.off, .online-dot.offline { background:#475569; box-shadow:none; }
  .member-text-col { flex:1; overflow:hidden; display:flex; flex-direction:column; min-width:0; }
  .member-nick-row { font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .member-status-sub { font-size:9px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .status-pill { font-size:8px; padding:1px 5px; border-radius:4px; font-weight:700; text-transform:uppercase; flex-shrink:0; }
  .status-pill.on { background:rgba(34,197,94,0.15); color:#4ade80; } .status-pill.off { background:rgba(255,255,255,0.05); color:#64748b; }
  .mini-btn { background:transparent; border:1px solid var(--cyan-border); color:var(--cyan-bright); padding:2px 6px; border-radius:4px; font-size:9px; font-weight:700; cursor:pointer; }
  .friend-tag { font-size:9px; color:var(--cyan-bright); font-weight:700; }
  .invite-banner-card { background:linear-gradient(135deg,rgba(219,39,119,0.12),rgba(13,148,136,0.06)); border:1px solid var(--pink-border); border-radius:10px; padding:12px; margin-top:auto; }
  .invite-banner-card h5 { font-size:11px; margin-bottom:3px; } .invite-banner-card p { font-size:10px; color:var(--text-dim); margin-bottom:8px; }
  .btn-cyan { background:var(--cyan-bright); color:#042f2e; border:none; padding:7px 14px; border-radius:6px; font-weight:700; font-size:11px; cursor:pointer; white-space:nowrap; }
  .btn-danger { background:rgba(239,68,68,0.16); color:#fca5a5; border:1px solid rgba(239,68,68,0.45); padding:7px 12px; border-radius:6px; font-weight:700; font-size:11px; cursor:pointer; }
  .btn-mute { background:#131c28; color:#e2e8f0; border:1px solid var(--border); padding:7px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer; }
  .btn-mute.active-screen { background:rgba(219,39,119,0.22); border-color:#f43f5e; color:#fda4af; }
  .btn-mute.active-cam { background:rgba(20,184,166,0.22); border-color:var(--cyan-bright); color:var(--cyan-bright); }
  .btn-pink-card { background:#9d174d; color:#fff; border:none; width:100%; padding:7px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; }
  .btn-tg { background:#229ED9; color:#fff; border:none; width:100%; padding:10px 14px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer; margin-bottom:10px; }
  .modal-backdrop { position:fixed; inset:0; background:rgba(2,4,8,0.86); backdrop-filter:blur(5px); display:none; align-items:center; justify-content:center; z-index:999; padding:12px; }
  .modal-backdrop.open { display:flex; }
  .modal-box { background:var(--bg-card); border:1px solid var(--cyan-border); border-radius:12px; padding:22px; width:390px; max-width:100%; overflow:hidden; }
  .modal-box input[type="text"], .modal-box input[type="password"], .modal-box textarea, .modal-box select { width:100%; padding:8px 11px; background:#04060a; border:1px solid var(--border); border-radius:6px; color:#fff; margin-bottom:10px; font-size:12px; outline:none; }
  .link-box { background:#030508; border:1px dashed var(--cyan-bright); padding:8px; color:var(--cyan-bright); font-size:11px; word-break:break-all; margin-bottom:10px; border-radius:6px; display:block; text-align:center; }
  .auth-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:12px; background:#06090f; padding:4px; border-radius:8px; border:1px solid var(--border); }
  .auth-tab { padding:6px 8px; font-size:11px; font-weight:700; text-align:center; border-radius:6px; cursor:pointer; color:var(--text-dim); }
  .auth-tab.active { background:rgba(34,158,217,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); }
  .settings-modal-box { background:#0b1119; border:1px solid var(--cyan-border); border-radius:14px; width:820px; max-width:100%; height:590px; max-height:92vh; display:grid; grid-template-columns:215px minmax(0,1fr); overflow:hidden; }
  .settings-nav { background:#060a0f; border-right:1px solid var(--border); padding:14px 10px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; }
  .settings-nav-label { font-size:9px; font-weight:800; text-transform:uppercase; color:var(--text-muted); padding:6px 8px 3px; }
  .settings-nav-btn { padding:8px 10px; border-radius:7px; font-size:11.5px; font-weight:600; color:var(--text-dim); cursor:pointer; display:flex; align-items:center; gap:8px; border:1px solid transparent; white-space:nowrap; }
  .settings-nav-btn.active { background:rgba(45,212,191,0.13); color:var(--cyan-bright); border-color:var(--cyan-border); }
  .settings-content { padding:18px 22px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; min-width:0; }
  .settings-pane { display:none; flex-direction:column; gap:12px; min-width:0; }
  .settings-pane.active { display:flex; }
  .settings-head { display:flex; justify-content:space-between; align-items:center; gap:10px; border-bottom:1px solid var(--border); padding-bottom:10px; flex-wrap:wrap; }
  .settings-head h3 { font-size:15px; font-weight:800; color:#fff; }
  .field-label { font-size:9.5px; font-weight:700; text-transform:uppercase; color:var(--text-dim); margin-bottom:5px; display:block; }
  .settings-card { background:#070b11; border:1px solid var(--border); border-radius:10px; padding:13px 14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .settings-grid-2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; width:100%; }
  .settings-card input[type="text"], .settings-card textarea, .settings-card select { width:100%; min-width:0; padding:8px 10px; background:#04060a; border:1px solid var(--border); border-radius:6px; color:#fff; font-size:11.5px; outline:none; margin:0; }
  .toggle-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid rgba(255,255,255,0.04); }
  .toggle-row:last-child { border-bottom:none; }
  .toggle-title { font-size:12px; font-weight:600; color:#f1f5f9; }
  .toggle-sub { font-size:10px; color:var(--text-muted); margin-top:2px; }
  .cyber-switch { position:relative; display:inline-block; width:38px; height:20px; flex-shrink:0; cursor:pointer; }
  .cyber-switch input { opacity:0; width:0; height:0; }
  .cyber-slider { position:absolute; inset:0; background:#131c28; border:1px solid var(--border); border-radius:999px; transition:0.2s; }
  .cyber-slider::before { content:''; position:absolute; width:14px; height:14px; left:2px; top:2px; background:#64748b; border-radius:50%; transition:0.2s; }
  .cyber-switch input:checked + .cyber-slider { background:rgba(20,184,166,0.25); border-color:var(--cyan-bright); }
  .cyber-switch input:checked + .cyber-slider::before { transform:translateX(18px); background:var(--cyan-bright); }
  .cyber-range { -webkit-appearance:none; appearance:none; width:100%; height:6px; background:#04060a; border:1px solid var(--border); border-radius:999px; outline:none; margin-top:4px; }
  .cyber-range::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:var(--cyan-bright); cursor:pointer; }
  .theme-pills-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .theme-pill-btn { background:#04060a; border:1px solid var(--border); color:#fff; padding:8px 10px; border-radius:7px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; }
  .theme-dot-swatch { width:12px; height:12px; border-radius:50%; }
  .color-swatches { display:flex; gap:7px; flex-wrap:wrap; }
  .color-swatch { width:24px; height:24px; border-radius:6px; cursor:pointer; border:2px solid rgba(255,255,255,0.15); }
  .mic-meter-wrap { width:100%; height:10px; background:#04060a; border-radius:999px; overflow:hidden; border:1px solid var(--border); }
  .mic-meter-bar { height:100%; width:0%; background:linear-gradient(90deg,#22c55e,#2dd4bf,#ec4899); transition:width 0.06s; }
  .discord-profile-card { background:#070b11; border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  .dp-banner { height:64px; background:#0d9488; }
  .dp-body { padding:30px 14px 14px; position:relative; }
  .dp-ava { width:52px; height:52px; border-radius:12px; background:#e11d48; border:4px solid #070b11; position:absolute; top:-26px; left:14px; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:800; color:#fff; }
  .dp-nick { font-size:15px; font-weight:800; color:#fff; }
  .dp-status { font-size:11px; color:var(--cyan-bright); margin-top:2px; }
  .dp-sec { margin-top:10px; padding-top:8px; border-top:1px solid var(--border); }
  .dp-sec-title { font-size:9px; font-weight:800; color:var(--text-muted); margin-bottom:4px; }
  .dp-bio { font-size:11.5px; color:#cbd5e1; white-space:pre-wrap; }
  .dp-tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:4px; }
  .dp-tag { background:rgba(45,212,191,0.12); border:1px solid var(--cyan-border); color:var(--cyan-bright); padding:2px 8px; border-radius:999px; font-size:9.5px; font-weight:700; }
  @media (max-width:900px) {
    .top-sub, .top-right-group .btn-top-settings, .top-ch-desc, .bottom-hint { display:none; }
    .workspace { display:flex; flex-direction:column; flex:1; }
    .main-chat { flex:1; width:100%; height:100%; }
    .mob-top-btn { display:inline-flex; } .mob-bottom-nav { display:grid; }
    .servers-rail { position:fixed; top:0; bottom:54px; left:0; width:64px; z-index:955; transform:translateX(-360px); transition:transform 0.24s; }
    .channels-panel { position:fixed; top:0; bottom:54px; left:64px; width:calc(100vw - 64px); max-width:270px; z-index:955; transform:translateX(-360px); transition:transform 0.24s; }
    body.mob-left-open .servers-rail, body.mob-left-open .channels-panel, body.mob-right-open .right-panel { transform:translateX(0); }
    .right-panel { position:fixed; top:0; bottom:54px; right:0; width:min(86vw,300px); z-index:955; transform:translateX(105%); transition:transform 0.24s; }
    body.mob-left-open .mob-drawer-backdrop, body.mob-right-open .mob-drawer-backdrop { display:block; }
    .chat-inp { font-size:16px; }
    .floating-call-overlay { right:10px; left:10px; width:auto; bottom:62px; }
    .settings-modal-box { grid-template-columns:1fr; grid-template-rows:auto 1fr; height:92dvh; }
    .settings-nav { flex-direction:row; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); padding:8px; }
    .settings-nav-label { display:none; }
    .settings-grid-2, .theme-pills-grid { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
  <div class="top-header">
    <div class="top-logo">СИГНАЛ <b>CYBER.NET</b></div>
    <div class="top-sub">МЕСТО ДЛЯ СВОИХ // ГОЛОС, КАМЕРА, PWA И СТРИМЫ</div>
    <div class="top-right-group">
      <button class="btn-top-settings" onclick="openSettingsModal('profile')">👤 Мой профиль</button>
      <button class="btn-top-settings" onclick="openSettingsModal('safety')">🛡️ Фильтр 18+</button>
      <button class="btn-top-settings" onclick="openSettingsModal('voice')">⚙️ Настройки</button>
      <button class="btn-top-invite" onclick="openInviteModal()">+ ПРИГЛАСИТЬ</button>
    </div>
  </div>

  <div class="workspace">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>
    <div class="servers-rail"><div class="bolt-icon">⚡</div><div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;"></div><div class="srv-ico-add" onclick="openCreateServerModal()">+</div></div>
    <div class="channels-panel">
      <div class="srv-header"><div class="srv-label">СЕРВЕР СООБЩЕСТВА</div><div class="srv-title" id="srv-title-label">Ночной клуб</div></div>
      <div class="freq-card"><div class="freq-top"><span>ЧАСТОТА 108.4 FM</span><span class="live-badge">LIVE</span></div><h4>Лови свою частоту.</h4><p id="srv-desc-label">Игры, идеи и разговоры после полуночи</p></div>
      <div class="channels-scroll">
        <div class="cat-header"><span>ТЕКСТОВЫЕ КАНАЛЫ</span><button class="cat-add-btn" onclick="openCreateChannelModal('text')">+</button></div>
        <div id="text-channels-list"></div>
        <div class="cat-header" style="margin-top:8px;"><span>ГОЛОСОВЫЕ КАНАЛЫ</span><button class="cat-add-btn" onclick="openCreateChannelModal('voice')">+</button></div>
        <div id="voice-channels-list"></div>
      </div>
      <div class="user-bar">
        <div class="user-info" onclick="openSettingsModal('profile')">
          <div class="user-ava-wrap"><div class="user-ava" id="user-ava">ГО</div><div class="user-presence-dot" id="user-presence-dot"></div></div>
          <div style="overflow:hidden;min-width:0;"><div class="user-name" id="user-name-label">Гость</div><div class="user-sub" id="user-email-label">Настроить профиль</div></div>
        </div>
        <div style="display:flex;gap:4px;"><button class="btn-login-mini" onclick="openSettingsModal('profile')">Профиль</button><button class="btn-icon-bar" onclick="openSettingsModal('voice')">⚙️</button></div>
      </div>
    </div>

    <div class="main-chat">
      <div class="chat-topbar">
        <div class="chat-topbar-left"><button class="mob-top-btn" onclick="toggleMobileLeft()">☰</button><span class="hash-large">#</span><div style="min-width:0;"><div class="top-ch-name" id="top-ch-name">игровая-комната</div><div class="top-ch-desc" id="top-ch-desc">Канал сообщества</div></div></div>
        <div class="chat-topbar-right"><button class="btn-top-right-share" onclick="openInviteModal()">🔗 ССЫЛКА</button><button class="mob-top-btn" onclick="toggleMobileRight()">👥</button></div>
      </div>
      <div class="chat-scroll-area" id="chat-scroll">
        <div class="hero-banner">
          <div class="hero-banner-left">
            <div style="font-size:9px;color:var(--cyan-bright);font-weight:700;">НАЧАЛО КАНАЛА // P2P СИНХРОНИЗАЦИЯ</div>
            <h2>Кто сегодня на связи?</h2>
            <p id="banner-desc">Делитесь мыслями, включайте камеру, экран или фоновый звонок на телефоне.</p>
            <div class="pill-tags-row">
              <span class="pill-tag" onclick="openSettingsModal('profile')">👤 ПРОФИЛЬ И ИНТЕРЕСЫ</span>
              <span class="pill-tag" onclick="openSettingsModal('safety')">🛡️ ФИЛЬТР 18+</span>
              <span class="pill-tag pink" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА</span>
            </div>
          </div>
        </div>
        <div class="messages-container" id="messages-list"></div>
        <div class="voice-panel" id="voice-panel-card">
          <div class="voice-panel-top">
            <div>
              <div class="voice-label">ГОЛОСОВОЙ КАНАЛ, КАМЕРА И ФОНОВЫЙ РЕЖИМ // WEBRTC P2P</div>
              <div class="voice-title" id="voice-panel-title">Общий разговор («Ночной эфир»)</div>
              <div class="voice-sub">Связка PWA + Base64 WAV + Web Worker + WakeLock удерживает звонок на телефоне при сворачивании.</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>
              <button class="btn-mute" id="deafen-btn" style="display:none;" onclick="toggleDeafen()">🎧 Звук вкл</button>
              <button class="btn-mute" id="cam-btn" onclick="toggleWebcam()">📷 Камера</button>
              <button class="btn-mute" id="screen-btn" onclick="toggleScreenShare()">🖥️ Экран</button>
              <button class="btn-mute" id="pip-overlay-btn" onclick="toggleExternalOverlay()">🪟 Оверлей</button>
              <button class="btn-mute" onclick="openSettingsModal('voice')">⚙️</button>
              <button class="btn-cyan" id="connect-voice-btn" onclick="toggleVoiceCall()">ПОДКЛЮЧИТЬСЯ</button>
            </div>
          </div>
          <div class="voice-active-area" id="voice-active-area">
            <div class="voice-user-card"><span class="vu-dot"></span><span id="voice-my-name" style="font-size:11px;font-weight:700;">Гость (Вы)</span></div>
            <div class="screen-grid" id="screen-grid"></div>
            <div id="audio-box"></div>
          </div>
        </div>
      </div>
      <div class="chat-bottom">
        <form class="input-row" onsubmit="sendChatMessage(event)"><input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000"><button type="submit" class="btn-cyan">ОТПРАВИТЬ</button></form>
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • ЗВОНОК РАБОТАЕТ В ФОНЕ НА ТЕЛЕФОНЕ И ПК</div>
      </div>
    </div>

    <div class="right-panel">
      <div class="right-sec-title"><span>УЧАСТНИКИ</span><span>В СЕТИ: <b id="online-count">1</b> / <span id="total-members-count">1</span></span></div>
      <div id="online-users-box"></div>
      <div class="right-sec-title" style="margin-top:8px;"><span>ДРУЗЬЯ</span><span><b id="friends-count">0</b></span></div>
      <div id="requests-box"></div><div id="friends-box"></div>
      <div class="invite-banner-card"><h5>Зови друзей в канал</h5><p>Участники и друзья сохраняются навсегда.</p><button class="btn-pink-card" onclick="openInviteModal()">🔗 СОЗДАТЬ ПРИГЛАШЕНИЕ</button></div>
    </div>
  </div>

  <div class="floating-call-overlay" id="floating-call-overlay">
    <div class="fco-head" id="fco-drag-handle"><div class="fco-live"><span class="fco-pulse"></span><span id="fco-channel-label">Ночной эфир</span></div><span class="fco-timer" id="fco-timer-label">00:00</span></div>
    <div class="fco-peers" id="fco-peers-box"></div>
    <div class="fco-actions">
      <button class="fco-btn" id="fco-mute-btn" onclick="toggleMute()">🎤 Вкл</button>
      <button class="fco-btn" id="fco-deaf-btn" onclick="toggleDeafen()">🎧 Вкл</button>
      <button class="fco-btn" id="fco-pip-btn" onclick="toggleExternalOverlay()">🪟 Поверх</button>
      <button class="fco-btn danger" onclick="toggleVoiceCall()">🛑 Выход</button>
    </div>
  </div>

  <div class="mob-bottom-nav" id="mob-bottom-nav">
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()"><span class="ico">☰</span><span>Каналы</span></div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span class="ico">💬</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="scrollToVoiceMobile()"><span class="ico">🔊</span><span>Голос</span></div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()"><span class="ico">👥</span><span>Друзья</span></div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('profile')"><span class="ico">👤</span><span>Профиль</span></div>
  </div>

  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Профиль</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">👤 Мой профиль</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🔑 Учётная запись</div>
        <div class="settings-nav-label">Безопасность</div>
        <div class="settings-nav-btn" data-pane="safety" onclick="switchSettingsPane('safety')">🛡️ Фильтр контента</div>
        <div class="settings-nav-label">Приложение</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и оверлей</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;"><button class="btn-login-mini" style="width:100%;" onclick="closeSettingsModal()">✕ Закрыть</button></div>
      </div>
      <div class="settings-content">
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head"><h3>Мой профиль</h3><button class="btn-cyan" onclick="saveProfileSettings()">✓ Сохранить онлайн</button></div>
          <div class="discord-profile-card"><div class="dp-banner" id="preview-banner"></div><div class="dp-body"><div class="dp-ava" id="preview-ava">ГО</div><div class="dp-nick" id="preview-nick">Гость</div><div class="dp-status" id="preview-status"></div><div class="dp-sec"><div class="dp-sec-title">О СЕБЕ</div><div class="dp-bio" id="preview-bio"></div></div><div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="preview-tags"></div></div></div></div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <div><label class="field-label">Позывной</label><input type="text" id="prof-nick-inp" maxlength="24" oninput="updateProfilePreview()"></div>
              <div><label class="field-label">Статус</label><select id="prof-presence-sel" onchange="updateProfilePreview()"><option value="online">🟢 В сети</option><option value="idle">🌙 Не активен</option><option value="dnd">⛔ Не беспокоить</option><option value="invisible">⚪ Невидимка</option></select></div>
            </div>
            <div><label class="field-label">Кастомный статус</label><input type="text" id="prof-status-inp" maxlength="60" oninput="updateProfilePreview()"></div>
            <div><label class="field-label">О себе</label><textarea id="prof-bio-inp" rows="2" maxlength="220" oninput="updateProfilePreview()"></textarea></div>
            <div><label class="field-label">Интересы (через запятую)</label><input type="text" id="prof-interests-inp" maxlength="160" oninput="updateProfilePreview()"></div>
            <div class="settings-grid-2">
              <div><label class="field-label">Цвет баннера</label><div class="color-swatches"><div class="color-swatch" style="background:#0d9488;" onclick="selectBannerColor('#0d9488')"></div><div class="color-swatch" style="background:#db2777;" onclick="selectBannerColor('#db2777')"></div><div class="color-swatch" style="background:#7c3aed;" onclick="selectBannerColor('#7c3aed')"></div><div class="color-swatch" style="background:#2563eb;" onclick="selectBannerColor('#2563eb')"></div><div class="color-swatch" style="background:#ea580c;" onclick="selectBannerColor('#ea580c')"></div></div></div>
              <div><label class="field-label">Цвет аватара</label><div class="color-swatches"><div class="color-swatch" style="background:#e11d48;" onclick="selectAvatarColor('#e11d48')"></div><div class="color-swatch" style="background:#14b8a6;" onclick="selectAvatarColor('#14b8a6')"></div><div class="color-swatch" style="background:#8b5cf6;" onclick="selectAvatarColor('#8b5cf6')"></div><div class="color-swatch" style="background:#3b82f6;" onclick="selectAvatarColor('#3b82f6')"></div><div class="color-swatch" style="background:#f59e0b;" onclick="selectAvatarColor('#f59e0b')"></div></div></div>
            </div>
          </div>
        </div>
        <div class="settings-pane" id="pane-safety">
          <div class="settings-head"><h3>🛡️ Фильтр 18+ и шок-контента</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">🔞 Блокировать сексуальный контент (18+)</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-sexual" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🩸 Блокировать насилие и шок-контент</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-gore" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🔗 Блокировать отправку запрещённого</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-outgoing" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Действие фильтра</label><select id="sel-filter-action" onchange="saveSafetySettings()"><option value="block">🚫 Полностью блокировать</option><option value="blur">👁️ Скрывать под размытым спойлером</option></select></div>
            <div><label class="field-label">Свой чёрный список (через запятую)</label><input type="text" id="inp-custom-blocklist" oninput="saveSafetySettings()"></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head"><h3>Голос, камера и фоновый режим</h3><button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 Обновить</button></div>
          <div class="settings-card">
            <div class="settings-grid-2"><div><label class="field-label">Микрофон</label><select id="set-mic-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Наушники</label><select id="set-spk-select" onchange="saveAudioVideoSettings()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Громкость микр.: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость звука: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Проверка микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ Проверить</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Веб-камера</label><select id="set-cam-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Качество камеры</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
            <div class="toggle-row"><div><div class="toggle-title">🪟 Показывать виджет звонка</div></div><label class="cyber-switch"><input type="checkbox" id="chk-auto-overlay" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Шумоподавление</div></div><label class="cyber-switch"><input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Эхоподавление</div></div><label class="cyber-switch"><input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Автоусиление</div></div><label class="cyber-switch"><input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head"><h3>Внешний вид</h3></div>
          <div class="settings-card">
            <div class="theme-pills-grid">
              <button class="theme-pill-btn" onclick="setAccentTheme('#14b8a6','#2dd4bf')"><span class="theme-dot-swatch" style="background:#2dd4bf;"></span><span>Бирюзовый</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#db2777','#f43f5e')"><span class="theme-dot-swatch" style="background:#f43f5e;"></span><span>Розовый</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#7c3aed','#a78bfa')"><span class="theme-dot-swatch" style="background:#a78bfa;"></span><span>Фиолетовый</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#d97706','#fbbf24')"><span class="theme-dot-swatch" style="background:#fbbf24;"></span><span>Золотой</span></button>
            </div>
            <div class="toggle-row"><div><div class="toggle-title">Компактный чат</div></div><label class="cyber-switch"><input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Шрифт чата</label><select id="sel-font-size" onchange="applyAppearanceSettings()"><option value="11px">11px</option><option value="12px" selected>12px</option><option value="14px">14px</option></select></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head"><h3>Уведомления</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">Звук новых сообщений</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Звук голосового канала</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-account">
          <div class="settings-head"><h3>Учётная запись и PWA</h3></div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <button class="btn-cyan" onclick="closeSettingsModal();openAuthModal(false)">✈️ Сменить аккаунт</button>
              <button class="btn-danger" onclick="logoutAccount()">Выйти</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="view-profile-modal" onclick="if(event.target===this)closeViewProfileModal()">
    <div class="modal-box" style="padding:0;width:360px;"><div class="discord-profile-card" style="border:none;"><div class="dp-banner" id="vp-banner"></div><div class="dp-body"><div class="dp-ava" id="vp-ava">УЧ</div><div style="display:flex;justify-content:space-between;"><div class="dp-nick" id="vp-nick"></div><span class="status-pill on" id="vp-online-pill">в сети</span></div><div class="dp-status" id="vp-status"></div><div class="dp-sec"><div class="dp-sec-title">О СЕБЕ</div><div class="dp-bio" id="vp-bio"></div></div><div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="vp-tags"></div></div><div style="margin-top:14px;display:flex;gap:8px;"><button class="btn-cyan" id="vp-friend-btn" style="flex:1;">+ В друзья</button><button class="btn-login-mini" onclick="closeViewProfileModal()">Закрыть</button></div></div></div></div>
  </div>

  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box"><h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:8px;">Ссылка-приглашение</h3><a class="link-box" id="public-invite-url" href="#" target="_blank"></a><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button><button class="btn-login-mini" style="width:100%;" onclick="closeInviteModal()">Закрыть</button></div>
  </div>

  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><h3 style="color:var(--cyan-bright);font-size:16px;">Вход (один раз)</h3><span style="font-size:9px;background:#229ED9;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;">TELEGRAM ID</span></div>
      <div class="auth-tabs"><div class="auth-tab active" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ Через Telegram</div><div class="auth-tab" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 Быстрый вход</div></div>
      <input type="text" id="nick-inp" placeholder="Ваш позывной (никнейм)" maxlength="24">
      <div id="auth-tg-panel">
        <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;" id="tg-status-hint">Откройте бота и нажмите /start — вход выполнится автоматически:</p>
        <button type="button" class="btn-tg" id="tg-open-bot-btn" onclick="openTelegramBot()">✈️ Открыть Telegram и получить код</button>
        <input type="text" id="tg-code-inp" placeholder="Код из Telegram (4 цифры)" maxlength="6" style="text-align:center;font-size:15px;font-weight:700;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="verifyTelegramCode()">Подтвердить код и войти</button>
      </div>
      <div id="auth-pass-panel" style="display:none;">
        <input type="password" id="pass-inp" placeholder="Пароль (минимум 4 символа)" maxlength="64">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithPassword()">Войти навсегда</button>
      </div>
      <button class="btn-login-mini" id="auth-close-btn" style="width:100%;margin-top:8px;" onclick="closeAuthModal()">Закрыть</button>
    </div>
  </div>

  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">
    <div class="modal-box"><h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:8px;">Создать свой сервер</h3><input type="text" id="new-srv-name" placeholder="Название сервера" maxlength="28"><input type="text" id="new-srv-desc" placeholder="Описание" maxlength="80"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">Создать</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateServerModal()">Закрыть</button></div>
  </div>

  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannelModal()">
    <div class="modal-box"><h3 id="create-ch-title" style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Создать канал</h3><p id="create-ch-sub" style="font-size:11px;color:var(--text-dim);margin-bottom:10px;"></p><input type="text" id="new-ch-name" placeholder="Название канала" maxlength="28"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">Создать</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateChannelModal()">Закрыть</button></div>
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

  // ---------- Сохранение сессии и локального хранилища (защита от сброса при обновлении server.js) ----------
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

  // ---------- Резервный слепок друзей, серверов и истории в браузере ----------
  let localVault = {
    knownUsers: {},
    friends: [],
    incoming: [],
    outgoing: [],
    servers: [],
    messages: {}
  };
  try {
    const rawVault = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
    if (rawVault && typeof rawVault === 'object') {
      localVault = Object.assign(localVault, rawVault);
    }
  } catch (e) {}

  function rememberUserInVault(u) {
    if (!u || !u.pid || u.nick === '?') return;
    const prev = localVault.knownUsers[u.pid] || {};
    localVault.knownUsers[u.pid] = {
      pid: u.pid,
      nick: u.nick || prev.nick || 'Участник',
      bio: u.bio !== undefined ? u.bio : (prev.bio || ''),
      interests: u.interests !== undefined ? u.interests : (prev.interests || ''),
      customStatus: u.customStatus !== undefined ? u.customStatus : (prev.customStatus || ''),
      presence: u.presence || prev.presence || 'online',
      bannerColor: u.bannerColor || prev.bannerColor || '#0d9488',
      avatarColor: u.avatarColor || prev.avatarColor || '#e11d48'
    };
  }

  function saveLocalVault() {
    try {
      if (Array.isArray(social.friends) && social.friends.length > 0) {
        localVault.friends = social.friends.map(function (f) {
          rememberUserInVault(f);
          return f.pid;
        });
      }
      if (Array.isArray(social.incoming)) {
        localVault.incoming = social.incoming.map(function (inc) {
          rememberUserInVault(inc);
          return inc.pid;
        });
      }
      if (Array.isArray(social.outgoing)) {
        localVault.outgoing = social.outgoing.slice();
      }
      if (Array.isArray(lastMembers)) {
        lastMembers.forEach(rememberUserInVault);
      }
      if (Array.isArray(serversList) && serversList.length > 0) {
        localVault.servers = serversList.slice(0, 40);
      }
      if (!localVault.messages) localVault.messages = {};
      if (currentRoom && roomMessagesCache) {
        const roomCopy = {};
        Object.keys(roomMessagesCache).forEach(function (ch) {
          const arr = roomMessagesCache[ch];
          if (Array.isArray(arr) && arr.length) {
            roomCopy[ch] = arr.slice(-80);
          }
        });
        localVault.messages[currentRoom] = roomCopy;
      }
      localStorage.setItem('cyber_vault_v1', JSON.stringify(localVault));
    } catch (e) {}
  }

  async function pushLocalVaultToServer() {
    try {
      const knownArr = Object.values(localVault.knownUsers || {});
      const payload = {
        uid: myUid,
        nick: myNick,
        profile: myProfile,
        friends: localVault.friends || [],
        incoming: localVault.incoming || [],
        outgoing: localVault.outgoing || [],
        knownUsers: knownArr,
        servers: localVault.servers || [],
        room: currentRoom,
        roomMembersPids: knownArr.map(function (u) { return u.pid; }),
        messages: localVault.messages || {}
      };
      await fetch('/api/vault-restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  }

  const IMAGE_URL_RX = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'<>]*)?/i;

  function checkContentViolation(text, serverFlags) {
    const s = String(text || '');
    const reasons = [];
    if (appSettings.filterSexual) {
      if ((serverFlags && serverFlags.sexual) || SEXUAL_RX.some(function (rx) { return rx.test(s); })) {
        reasons.push('Сексуальный контент 18+');
      }
    }
    if (appSettings.filterGore) {
      if ((serverFlags && serverFlags.gore) || GORE_RX.some(function (rx) { return rx.test(s); })) {
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

  // Мобильные переменные для удержания фона (Base64 WAV + Web Worker + WakeLock)
  let callStartTime = 0;
  let voiceLockRelease = null, wakeLockSentinel = null, keepAliveAudioEl = null;
  let bgWorker = null;
  let pipCanvas = null, pipCtx = null, canvasPipVideo = null;
  let popupOverlayWin = null;
  let subsonicWavUrl = null;

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

  function formatCallTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Генератор инфразвукового WAV для обхода 30-секундного засыпания на Android/iOS
  function getSubsonicWavUrl() {
    if (subsonicWavUrl) return subsonicWavUrl;
    const sampleRate = 8000, duration = 2, numSamples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + numSamples * 2), view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 20 * (i / sampleRate)) * 45, true);
    }
    subsonicWavUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return subsonicWavUrl;
  }

  // Системный оверлей (Picture-in-Picture)
  function ensurePipCanvasAndVideo() {
    if (!pipCanvas) {
      pipCanvas = document.createElement('canvas');
      pipCanvas.width = 460; pipCanvas.height = 260;
      pipCtx = pipCanvas.getContext('2d', { alpha: false });
      drawSystemPipOverlayFrame();
    }
    if (!canvasPipVideo) {
      canvasPipVideo = document.createElement('video');
      canvasPipVideo.muted = true; canvasPipVideo.autoplay = true; canvasPipVideo.playsInline = true; canvasPipVideo.autoPictureInPicture = true;
      canvasPipVideo.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:1;';
      document.body.appendChild(canvasPipVideo);
      try { canvasPipVideo.srcObject = pipCanvas.captureStream(25); canvasPipVideo.play().catch(() => {}); } catch (e) {}
      canvasPipVideo.addEventListener('enterpictureinpicture', () => {
        document.getElementById('pip-overlay-btn')?.classList.add('active-cam');
        document.getElementById('fco-pip-btn')?.classList.add('active-pip');
      });
      canvasPipVideo.addEventListener('leavepictureinpicture', () => {
        document.getElementById('pip-overlay-btn')?.classList.remove('active-cam');
        document.getElementById('fco-pip-btn')?.classList.remove('active-pip');
      });
    } else if (canvasPipVideo.paused) {
      canvasPipVideo.play().catch(() => {});
    }
  }

  document.addEventListener('pointerdown', () => { ensurePipCanvasAndVideo(); }, { once: true });

  function drawSystemPipOverlayFrame() {
    if (!pipCanvas || !pipCtx) return;
    const ctx = pipCtx, w = pipCanvas.width, h = pipCanvas.height;
    ctx.fillStyle = '#05080f'; ctx.fillRect(0, 0, w, h);
    const activeVideoEl = document.querySelector('#screen-grid .screen-card:not(.nsfw-masked) video');
    if (activeVideoEl && activeVideoEl.readyState >= 2) {
      try { ctx.drawImage(activeVideoEl, 0, 38, w, h - 38); } catch (e) {}
      ctx.fillStyle = 'rgba(4, 7, 13, 0.85)'; ctx.fillRect(0, 0, w, 38);
    } else {
      ctx.fillStyle = isMuted ? 'rgba(244, 63, 94, 0.14)' : 'rgba(20, 184, 166, 0.12)';
      ctx.fillRect(14, 48, w - 28, 34); ctx.strokeStyle = isMuted ? '#f43f5e' : '#2dd4bf'; ctx.lineWidth = 1.5; ctx.strokeRect(14, 48, w - 28, 34);
      ctx.fillStyle = isMuted ? '#fda4af' : '#5eead4'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText((isMuted ? '🔇 Микрофон выкл' : '🎤 Микрофон вкл') + (isDeafened ? ' • 🔇 Звук выкл' : ' • 🎧 Звук вкл'), 26, 70);
      ctx.fillStyle = '#64748b'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('УЧАСТНИКИ В КАНАЛЕ:', 16, 104);
      getVoiceChannelMembers().slice(0, 5).forEach((u, i) => {
        const y = 128 + i * 25;
        ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(14, y - 16, w - 28, 22);
        ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(26, y - 5, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f1f5f9'; ctx.font = 'bold 13px sans-serif';
        ctx.fillText(u.nick + (u.pid === myPid ? ' (Вы)' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''), 38, y);
      });
    }
    ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = '#e11d48'; ctx.fillRect(14, 9, 72, 20); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('СИГНАЛ', 23, 23);
    ctx.fillStyle = '#2dd4bf'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('🔊 ' + String(currentVoiceChannel || 'Эфир').slice(0, 20), 96, 24);
    ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 13px monospace'; ctx.fillText(formatCallTime(callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0), w - 58, 24);
  }

  function openStandalonePopupOverlay() {
    if (popupOverlayWin && !popupOverlayWin.closed) { popupOverlayWin.focus(); renderPopupOverlayContent(); return; }
    popupOverlayWin = window.open('', 'SignalCallOverlay', 'width=340,height=250,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!popupOverlayWin) return;
    const doc = popupOverlayWin.document;
    doc.open();
    doc.write('<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>СИГНАЛ — Оверлей</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;}body{background:#060a10;color:#f1f5f9;padding:12px;height:100vh;display:flex;flex-direction:column;justify-content:space-between;border:1px solid rgba(45,212,191,0.45);}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:8px;}.badge{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#2dd4bf;}.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;}.timer{font-family:monospace;font-size:11px;background:rgba(255,255,255,0.07);padding:2px 7px;border-radius:4px;color:#cbd5e1;}.peers{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;overflow-y:auto;flex:1;align-content:flex-start;}.chip{display:inline-flex;align-items:center;gap:6px;background:#0f1722;border:1px solid rgba(45,212,191,0.3);padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;color:#fff;}.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);}button{background:#131c28;border:1px solid rgba(255,255,255,0.12);color:#fff;padding:8px 6px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;}button.off{background:rgba(244,63,94,0.2);border-color:#f43f5e;color:#fda4af;}button.hang{background:#ef4444;border-color:#ef4444;color:#fff;}</style></head><body><div class="top"><div class="badge"><span class="dot"></span><span id="pop-ch"></span></div><span class="timer" id="pop-timer">00:00</span></div><div class="peers" id="pop-peers"></div><div class="btns"><button id="pop-mute"></button><button id="pop-deaf"></button><button class="hang" id="pop-hang">🛑 Выход</button></div></body></html>');
    doc.close();
    doc.getElementById('pop-mute').onclick = () => toggleMute();
    doc.getElementById('pop-deaf').onclick = () => toggleDeafen();
    doc.getElementById('pop-hang').onclick = () => { toggleVoiceCall(); popupOverlayWin.close(); };
    renderPopupOverlayContent();
  }

  function renderPopupOverlayContent() {
    if (!popupOverlayWin || popupOverlayWin.closed) return;
    try {
      const doc = popupOverlayWin.document;
      doc.getElementById('pop-ch').textContent = '🔊 ' + currentVoiceChannel;
      const m = doc.getElementById('pop-mute'); m.textContent = isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл'; m.className = isMuted ? 'off' : '';
      const d = doc.getElementById('pop-deaf'); d.textContent = isDeafened ? '🔇 Звук выкл' : '🎧 Звук вкл'; d.className = isDeafened ? 'off' : '';
      const pb = doc.getElementById('pop-peers'); pb.innerHTML = '';
      getVoiceChannelMembers().forEach(u => {
        const c = doc.createElement('div'); c.className = 'chip'; c.textContent = '🟢 ' + u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''); pb.appendChild(c);
      });
    } catch (e) {}
  }

  function toggleExternalOverlay() {
    if (document.pictureInPictureElement || (popupOverlayWin && !popupOverlayWin.closed)) { closeExternalOverlay(); return; }
    ensurePipCanvasAndVideo(); drawSystemPipOverlayFrame();
    if (canvasPipVideo && typeof canvasPipVideo.requestPictureInPicture === 'function') {
      canvasPipVideo.requestPictureInPicture().then(() => {
        document.getElementById('pip-overlay-btn')?.classList.add('active-cam');
        document.getElementById('fco-pip-btn')?.classList.add('active-pip');
      }).catch(() => {
        canvasPipVideo.play().then(() => canvasPipVideo.requestPictureInPicture()).catch(() => openStandalonePopupOverlay());
      });
    } else { openStandalonePopupOverlay(); }
    if (!inVoice) ensureVoiceConnected();
  }

  function closeExternalOverlay() {
    if (document.pictureInPictureElement) try { document.exitPictureInPicture(); } catch (e) {}
    if (popupOverlayWin && !popupOverlayWin.closed) try { popupOverlayWin.close(); } catch (e) {}
    popupOverlayWin = null;
    document.getElementById('pip-overlay-btn')?.classList.remove('active-cam');
    document.getElementById('fco-pip-btn')?.classList.remove('active-pip');
  }

  // Запуск мобильного удержания связи (Base64 WAV + Web Worker + WakeLock)
  function startBackgroundCallPersistence() {
    if (navigator.locks && navigator.locks.request && !voiceLockRelease) {
      navigator.locks.request('signal_active_voice_call', { mode: 'exclusive' }, () => new Promise(r => { voiceLockRelease = r; })).catch(() => {});
    }
    if (navigator.wakeLock && navigator.wakeLock.request && !wakeLockSentinel) {
      navigator.wakeLock.request('screen').then(s => { wakeLockSentinel = s; }).catch(() => {});
    }
    try {
      if (!keepAliveAudioEl) {
        keepAliveAudioEl = document.createElement('audio');
        keepAliveAudioEl.setAttribute('playsinline', ''); keepAliveAudioEl.setAttribute('webkit-playsinline', '');
        keepAliveAudioEl.loop = true; keepAliveAudioEl.volume = 0.02;
        document.body.appendChild(keepAliveAudioEl);
      }
      keepAliveAudioEl.src = getSubsonicWavUrl();
      keepAliveAudioEl.play().catch(() => {});
    } catch (e) {}

    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}

    ensurePipCanvasAndVideo(); drawSystemPipOverlayFrame();

    callStartTime = Date.now();
    if (bgWorker) try { bgWorker.terminate(); } catch (e) {}
    try {
      const blob = new Blob(['setInterval(function(){ postMessage("tick"); }, 1000);'], { type: 'application/javascript' });
      bgWorker = new Worker(URL.createObjectURL(blob));
      let cnt = 0;
      bgWorker.onmessage = () => {
        if (!inVoice) return;
        cnt++;
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const tStr = formatCallTime(elapsed);
        const tEl = document.getElementById('fco-timer-label'); if (tEl) tEl.textContent = tStr;
        if (popupOverlayWin && !popupOverlayWin.closed) {
          try { popupOverlayWin.document.getElementById('pop-timer').textContent = tStr; } catch (e) {}
        }
        if (cnt % 3 === 0) {
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
          if (keepAliveAudioEl && keepAliveAudioEl.paused) keepAliveAudioEl.play().catch(() => {});
          document.querySelectorAll('#audio-box audio').forEach(a => { if (a.paused && !isDeafened) a.play().catch(() => {}); });
          if (document.hidden) fetch('/healthz?t=' + Date.now(), { keepalive: true }).catch(() => {});
        }
        drawSystemPipOverlayFrame();
      };
    } catch (e) {}

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: '🔊 В эфире: ' + currentVoiceChannel, artist: 'СИГНАЛ // ' + (currentServerMeta.name || currentRoom), album: 'Активный звонок' });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', () => { if (isMuted) toggleMute(); if (keepAliveAudioEl?.paused) keepAliveAudioEl.play().catch(() => {}); });
        navigator.mediaSession.setActionHandler('pause', () => { toggleMute(); if (keepAliveAudioEl?.paused) keepAliveAudioEl.play().catch(() => {}); navigator.mediaSession.playbackState = 'playing'; });
        navigator.mediaSession.setActionHandler('hangup', () => { if (inVoice) toggleVoiceCall(); });
      } catch (e) {}
    }
    updateFloatingOverlayUI();
  }

  function stopBackgroundCallPersistence() {
    if (voiceLockRelease) { try { voiceLockRelease(); } catch (e) {} voiceLockRelease = null; }
    if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch (e) {} wakeLockSentinel = null; }
    if (keepAliveAudioEl) { try { keepAliveAudioEl.pause(); keepAliveAudioEl.removeAttribute('src'); } catch (e) {} }
    if (bgWorker) { try { bgWorker.terminate(); } catch (e) {} bgWorker = null; }
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'none'; } catch (e) {} }
    closeExternalOverlay();
    updateFloatingOverlayUI();
  }

  document.addEventListener('visibilitychange', () => {
    if (!inVoice) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    document.querySelectorAll('#audio-box audio').forEach(a => { if (a.paused && !isDeafened) a.play().catch(() => {}); });
    if (keepAliveAudioEl?.paused) keepAliveAudioEl.play().catch(() => {});
    if (canvasPipVideo?.paused) canvasPipVideo.play().catch(() => {});
    drawSystemPipOverlayFrame();
  });

  function getVoiceChannelMembers() {
    const uList = (lastMembers || []).filter(u => u.online && u.inVoice && (!u.voiceChannel || u.voiceChannel === currentVoiceChannel));
    if (!uList.some(u => u.pid === myPid) && inVoice) uList.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen });
    return uList;
  }

  function updateFloatingOverlayUI() {
    const box = document.getElementById('floating-call-overlay'); if (!box) return;
    if (!inVoice || appSettings.autoOverlay === false) box.classList.remove('show'); else box.classList.add('show');
    document.getElementById('fco-channel-label').textContent = '🔊 ' + currentVoiceChannel;
    document.getElementById('fco-mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('fco-deaf-btn').textContent = isDeafened ? '🔇 Глух' : '🎧 Вкл';
    const pb = document.getElementById('fco-peers-box'); pb.innerHTML = '';
    getVoiceChannelMembers().forEach(u => {
      const c = el('div', 'fco-peer-chip'); c.appendChild(el('span', 'fco-pulse')); c.appendChild(el('span', '', u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''))); pb.appendChild(c);
    });
    drawSystemPipOverlayFrame();
    renderPopupOverlayContent();
  }

  (function () {
    const card = document.getElementById('floating-call-overlay'), handle = document.getElementById('fco-drag-handle');
    if (!card || !handle) return;
    let drag = false, sx = 0, sy = 0, or = 18, ob = 72;
    const start = (x, y) => { drag = true; sx = x; sy = y; const rect = card.getBoundingClientRect(); or = window.innerWidth - rect.right; ob = window.innerHeight - rect.bottom; };
    const move = (x, y) => { if (!drag) return; card.style.left = 'auto'; card.style.right = Math.max(8, Math.min(window.innerWidth - 120, or - (x - sx))) + 'px'; card.style.bottom = Math.max(8, Math.min(window.innerHeight - 80, ob - (y - sy))) + 'px'; };
    const end = () => { drag = false; };
    handle.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY)); window.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', e => { if (e.touches[0]) start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchmove', e => { if (drag && e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchend', end);
  })();

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    const ava = document.getElementById('user-ava'); ava.textContent = myNick.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#e11d48';
    document.getElementById('user-presence-dot').className = 'user-presence-dot ' + (myProfile.presence || 'online');
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    const stViol = checkContentViolation(myProfile.customStatus || '');
    const sStat = stViol.length ? '' : myProfile.customStatus;
    if (sStat) { document.getElementById('user-email-label').textContent = sStat; document.getElementById('user-email-label').style.color = '#cbd5e1'; }
    else if (myVerified) { document.getElementById('user-email-label').textContent = '✓ В сети'; document.getElementById('user-email-label').style.color = '#34d399'; }
    else { document.getElementById('user-email-label').textContent = 'Настроить профиль'; document.getElementById('user-email-label').style.color = ''; }
  }

  function renderServersRail() {
    const box = document.getElementById('servers-list-box'); box.innerHTML = '';
    (serversList.length ? serversList : [currentServerMeta]).forEach(srv => {
      const b = el('div', 'srv-ico' + (srv.id === currentRoom ? ' active' : ''), srv.icon || srv.name.slice(0, 2).toUpperCase());
      b.title = srv.name; b.onclick = () => { if (srv.id !== currentRoom) switchServer(srv.id); }; box.appendChild(b);
    });
  }

  function renderServerChannels() {
    document.getElementById('srv-title-label').textContent = currentServerMeta.name || currentRoom;
    document.getElementById('srv-desc-label').textContent = currentServerMeta.desc || 'Игры, идеи и разговоры после полуночи';
    const tList = currentServerMeta.textChannels || ['игровая-комната'];
    if (!tList.includes(currentChannel)) currentChannel = tList[0] || 'игровая-комната';
    const vList = currentServerMeta.voiceChannels || ['Ночной эфир'];
    if (!vList.includes(currentVoiceChannel)) currentVoiceChannel = vList[0] || 'Ночной эфир';

    const tBox = document.getElementById('text-channels-list'); tBox.innerHTML = '';
    tList.forEach(ch => {
      const row = el('div', 'ch-btn' + (ch === currentChannel ? ' active' : '')); row.setAttribute('data-ch', ch);
      const rw = el('div', '', ''); rw.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const unread = unreadByChannel[ch] || 0; if (unread > 0 && ch !== currentChannel) rw.appendChild(el('span', 'ch-unread-badge', String(unread)));
      rw.appendChild(el('span', 'ch-dot')); row.appendChild(el('span', '', '# ' + ch)); row.appendChild(rw);
      row.onclick = () => setChannel(ch); tBox.appendChild(row);
    });

    const vBox = document.getElementById('voice-channels-list'); vBox.innerHTML = '';
    vList.forEach(vch => {
      const isAct = inVoice && currentVoiceChannel === vch;
      const row = el('div', 'voice-ch-box' + (isAct ? ' active' : ''));
      row.appendChild(el('span', '', '🔊 ' + vch)); row.appendChild(el('span', 'off-badge' + (isAct ? ' on' : ''), isAct ? 'ON' : 'OFF'));
      row.onclick = () => selectVoiceChannel(vch); vBox.appendChild(row);
    });
    applyChannelUI(currentChannel); updateVoicePanelUI();
  }

  function applyChannelUI(ch) {
    const sName = currentServerMeta.name || 'Ночной клуб';
    document.getElementById('top-ch-name').textContent = ch;
    document.getElementById('top-ch-desc').textContent = 'Канал сервера «' + sName + '»';
    document.getElementById('banner-desc').textContent = 'Это #' + ch + ' на сервере «' + sName + '». Делитесь мыслями, включайте камеру или оверлей.';
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(i => i.classList.toggle('active', i.getAttribute('data-ch') === ch));
  }

  function updateVoicePanelUI() {
    document.getElementById('voice-panel-title').textContent = 'Общий разговор участников канала («' + currentVoiceChannel + '»)';
    updateFloatingOverlayUI();
  }

  async function switchServer(roomId) {
    const clean = String(roomId || '').trim();
    if (!clean || clean === currentRoom) { closeMobileDrawers(); return; }
    if (inVoice) await toggleVoiceCall();
    currentRoom = clean; unreadByChannel = {}; roomMessagesCache = {};
    try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}
    const found = serversList.find(s => s.id === currentRoom);
    if (found) { currentServerMeta = found; currentChannel = found.textChannels[0] || 'игровая-комната'; currentVoiceChannel = found.voiceChannels[0] || 'Ночной эфир'; }
    updateBrowserUrl(); renderServersRail(); renderServerChannels(); closeMobileDrawers();
    try {
      const res = await fetch('/api/switch-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick: myNick }) });
      const data = await res.json();
      if (data && data.ok) {
        currentServerMeta = data.current || currentServerMeta; serversList = data.list || serversList; roomMessagesCache = data.messagesByChannel || {};
        if (!currentServerMeta.textChannels.includes(currentChannel)) currentChannel = currentServerMeta.textChannels[0] || 'игровая-комната';
        cachedMessages = roomMessagesCache[currentChannel] || [];
        updateBrowserUrl(); renderServersRail(); renderServerChannels(); rerenderChatMessages();
        if (Array.isArray(data.users)) renderUsers(data.users); saveLocalVault();
      }
    } catch (e) {}
  }

  function connectEventStream() {
    if (evtSource) try { evtSource.close(); } catch (e) {}
    clientId = Math.random().toString(36).substring(2, 10);
    evtSource = new EventSource(`/api/events?id=${clientId}&uid=${myUid}&verified=${myVerified ? '1' : '0'}&room=${encodeURIComponent(currentRoom)}&nick=${encodeURIComponent(myNick)}`);
    evtSource.onmessage = e => {
      let data; try { data = JSON.parse(e.data); } catch (err) { return; }
      if (data.type === 'server-meta') {
        currentServerMeta = data.payload.current; serversList = data.payload.list || [currentServerMeta];
        if (data.payload.messagesByChannel) roomMessagesCache = data.payload.messagesByChannel;
        renderServersRail(); renderServerChannels(); cachedMessages = roomMessagesCache[currentChannel] || []; rerenderChatMessages();
        pushLocalVaultToServer();
      } else if (data.type === 'servers') {
        serversList = data.payload.list || [];
        const f = serversList.find(s => s.id === currentRoom); if (f) currentServerMeta = f;
        renderServersRail(); renderServerChannels(); saveLocalVault();
      } else if (data.type === 'msg') {
        const ch = data.payload.channel, msg = data.payload.msg;
        if (!roomMessagesCache[ch]) roomMessagesCache[ch] = [];
        roomMessagesCache[ch].push(msg); saveLocalVault();
        if (ch === currentChannel) { cachedMessages = roomMessagesCache[ch]; addMsgToDOM(msg); }
        else { unreadByChannel[ch] = (unreadByChannel[ch] || 0) + 1; renderServerChannels(); }
        if (appSettings.soundMsg && msg && msg.author !== myNick) playUiBeep(540, 0.06);
      } else if (data.type === 'users') {
        renderUsers(data.payload); updateFloatingOverlayUI(); saveLocalVault();
      } else if (data.type === 'social') {
        myPid = data.payload.pid; social = data.payload;
        if (data.payload.nick) { myNick = data.payload.nick; try { localStorage.setItem('cyber_nick', myNick); } catch (err) {} setPersistCookie('cyber_nick', myNick); }
        if (data.payload.verified) { myVerified = true; authLocked = false; try { localStorage.setItem('cyber_verified', '1'); } catch (err) {} setPersistCookie('cyber_verified', '1'); closeAuthModal(); }
        if (data.payload.bio !== undefined) Object.assign(myProfile, { bio: data.payload.bio || myProfile.bio, interests: data.payload.interests || myProfile.interests, customStatus: data.payload.customStatus || myProfile.customStatus, presence: data.payload.presence || myProfile.presence, bannerColor: data.payload.bannerColor || myProfile.bannerColor, avatarColor: data.payload.avatarColor || myProfile.avatarColor });
        applyNickUI(); renderSocial(); renderUsers(lastMembers); saveLocalVault();
      } else if (data.type === 'voice-join') {
        if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId && data.payload.voiceChannel === currentVoiceChannel) {
          const pid = data.payload.peerId; const call = peer.call(pid, localStream, { metadata: { kind: 'audio', nick: myNick } });
          if (call) { call.on('stream', s => playStream(pid, s)); call.on('close', () => removeAudio(pid)); call.on('error', () => removeAudio(pid)); }
          if (inScreen && screenStream) callPeerWithScreen(pid);
          if (inWebcam && webcamStream) callPeerWithWebcam(pid);
        }
      } else if (data.type === 'screen-stop' && data.payload?.peerId) { removeMediaTile('screen-' + data.payload.peerId); }
      else if (data.type === 'cam-stop' && data.payload?.peerId) { removeMediaTile('cam-' + data.payload.peerId); }
    };
  }

  applyNickUI(); applyAppearanceFromStorage(); renderServersRail(); renderServerChannels(); connectEventStream();
  if (!myVerified) openAuthModal(true);

  function rerenderChatMessages() {
    const box = document.getElementById('messages-list'); box.innerHTML = '';
    if (!cachedMessages || !cachedMessages.length) { box.innerHTML = '<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>'; return; }
    cachedMessages.forEach(addMsgToDOM);
  }

  function buildMessageBodyHTML(text, violations) {
    const safeText = escapeHtml(text), imgMatch = String(text || '').match(IMAGE_URL_RX);
    let inner = '<div>' + safeText + '</div>';
    if (imgMatch) inner += '<img class="chat-inline-media" src="' + escapeHtml(imgMatch[0]) + '" alt="media" loading="lazy">';
    if (!violations || !violations.length) return inner;
    const rStr = escapeHtml(violations.join(', '));
    if (appSettings.filterAction === 'blur') {
      return '<div class="spoiler-blur-wrap" onclick="toggleSpoiler(this)" title="Показать/скрыть"><div class="spoiler-badge">🛡️ Скрыто фильтром (' + rStr + ') — нажми для просмотра</div><div class="spoiler-blur-content">' + inner + '</div></div>';
    }
    return '<div class="filtered-block-card">🛡️ Заблокировано фильтром безопасности (' + rStr + ')</div>';
  }

  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list'), hint = document.getElementById('empty-hint'); if (hint) hint.remove();
    const author = String(m.author || '?'), viol = checkContentViolation(m.text, m.flags);
    const div = el('div', 'msg-item');
    div.innerHTML = '<div class="msg-ava">' + escapeHtml(author.charAt(0).toUpperCase()) + '</div><div style="flex:1;min-width:0;"><div><span class="msg-author">' + escapeHtml(author) + '</span><span class="msg-time">' + escapeHtml(m.time) + '</span></div><div class="msg-text">' + buildMessageBodyHTML(m.text, viol) + '</div></div>';
    box.appendChild(div);
    const scrollArea = document.getElementById('chat-scroll'); scrollArea.scrollTop = scrollArea.scrollHeight;
  }

  function friendAction(action, pid) {
    if (!myVerified) { openAuthModal(true); return Promise.resolve(); }
    if (action === 'remove') { localVault.friends = (localVault.friends || []).filter(x => x !== pid); saveLocalVault(); }
    return fetch('/api/friend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, action, target: pid }) })
      .then(r => r.json()).then(d => { if (d.error) alert(d.error); }).catch(() => alert('Ошибка соединения.'));
  }

  function renderUsers(list) {
    lastMembers = list || [];
    const online = lastMembers.filter(u => u.online), offline = lastMembers.filter(u => !u.online);
    document.getElementById('online-count').textContent = online.length;
    document.getElementById('total-members-count').textContent = lastMembers.length;
    const box = document.getElementById('online-users-box'); box.innerHTML = '';
    const friendPids = (social.friends || []).map(f => f.pid);
    online.concat(offline).forEach(u => {
      const d = el('div', 'online-user-item' + (u.online ? ' is-online' : '')); if (!u.online) d.style.opacity = '0.68';
      d.appendChild(el('span', 'online-dot ' + (u.online ? (u.presence || 'online') : 'off')));
      const col = el('div', 'member-text-col');
      const nr = el('div', 'member-nick-row', u.nick + (u.pid === myPid ? ' (вы)' : '') + (u.inVoice ? ' 🔊' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '')); nr.style.fontWeight = u.online ? '600' : '400'; col.appendChild(nr);
      if (u.customStatus) { const sv = checkContentViolation(u.customStatus); col.appendChild(el('div', 'member-status-sub', sv.length ? '🛡️ [Статус скрыт]' : u.customStatus)); }
      d.appendChild(col);
      d.appendChild(el('span', 'status-pill ' + (u.online ? 'on' : 'off'), u.online ? 'в сети' : 'не в сети'));
      if (myPid && u.pid !== myPid) {
        if (friendPids.includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'друг'));
        else if ((social.outgoing || []).includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'заявка'));
        else if ((social.incoming || []).some(i => i.pid === u.pid)) { const b = el('button', 'mini-btn', 'принять'); b.onclick = ev => { ev.stopPropagation(); friendAction('accept', u.pid); }; d.appendChild(b); }
        else { const b = el('button', 'mini-btn', '+ друг'); b.onclick = ev => { ev.stopPropagation(); friendAction('request', u.pid); }; d.appendChild(b); }
      }
      d.onclick = () => openUserProfileCard(u); box.appendChild(d);
    });
  }

  function renderSocial() {
    const friends = social.friends || [], incoming = social.incoming || [];
    document.getElementById('friends-count').textContent = friends.length;
    const rq = document.getElementById('requests-box'); rq.innerHTML = '';
    incoming.forEach(r => {
      const d = el('div', 'online-user-item'); d.style.borderColor = 'rgba(219,39,119,0.4)';
      const nm = el('span', '', r.nick + ' хочет в друзья'); nm.style.flex = '1';
      const ok = el('button', 'mini-btn', '✓'); ok.onclick = ev => { ev.stopPropagation(); friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕'); no.onclick = ev => { ev.stopPropagation(); friendAction('decline', r.pid); };
      d.appendChild(nm); d.appendChild(ok); d.appendChild(no); rq.appendChild(d);
    });
    const fb = document.getElementById('friends-box'); fb.innerHTML = '';
    if (!friends.length) fb.appendChild(el('div', '', 'Пока никого. Нажмите «+ друг» рядом с участником.'));
    friends.forEach(f => {
      const d = el('div', 'online-user-item' + (f.online ? ' is-online' : '')); if (!f.online) d.style.opacity = '0.68';
      d.appendChild(el('span', 'online-dot ' + (f.online ? (f.presence || 'online') : 'off')));
      const nm = el('span', '', f.nick); nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'; d.appendChild(nm);
      d.appendChild(el('span', 'status-pill ' + (f.online ? 'on' : 'off'), f.online ? 'в сети' : 'не в сети'));
      const rm = el('button', 'mini-btn', '✕'); rm.onclick = ev => { ev.stopPropagation(); if (confirm('Удалить из друзей?')) friendAction('remove', f.pid); };
      d.appendChild(rm); d.onclick = () => openUserProfileCard(f); fb.appendChild(d);
    });
  }

  function openUserProfileCard(u) {
    if (!u) return;
    document.getElementById('vp-banner').style.background = u.bannerColor || '#0d9488';
    const ava = document.getElementById('vp-ava'); ava.textContent = String(u.nick || '?').slice(0, 2).toUpperCase(); ava.style.background = u.avatarColor || '#e11d48';
    document.getElementById('vp-nick').textContent = u.nick || 'Участник';
    const pill = document.getElementById('vp-online-pill'); pill.className = 'status-pill ' + (u.online ? 'on' : 'off'); pill.textContent = u.online ? 'в сети' : 'не в сети';
    document.getElementById('vp-status').textContent = checkContentViolation(u.customStatus || '').length ? '🛡️ [Статус скрыт]' : (u.customStatus || '');
    document.getElementById('vp-bio').textContent = checkContentViolation(u.bio || '').length ? '🛡️ [Скрыто фильтром]' : (u.bio || 'Участник ничего о себе не указал.');
    const tb = document.getElementById('vp-tags'); tb.innerHTML = '';
    String(u.interests || '').split(',').map(t => t.trim()).filter(Boolean).forEach(tg => { if (!checkContentViolation(tg).length) tb.appendChild(el('span', 'dp-tag', tg)); });
    if (!tb.childNodes.length) tb.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Нет тегов</span>';
    const fBtn = document.getElementById('vp-friend-btn'), friendPids = (social.friends || []).map(f => f.pid);
    if (u.pid === myPid) { fBtn.textContent = '✏️ Редактировать профиль'; fBtn.onclick = () => { closeViewProfileModal(); openSettingsModal('profile'); }; }
    else if (friendPids.includes(u.pid)) { fBtn.textContent = '✓ В друзьях'; fBtn.onclick = () => closeViewProfileModal(); }
    else { fBtn.textContent = '+ В друзья'; fBtn.onclick = () => { friendAction('request', u.pid); closeViewProfileModal(); }; }
    document.getElementById('view-profile-modal').classList.add('open');
  }
  function closeViewProfileModal() { document.getElementById('view-profile-modal').classList.remove('open'); }

  function openSettingsModal(pane) {
    closeMobileDrawers(); setMobActiveTab('mob-tab-profile');
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
    document.getElementById('set-mic-vol').value = appSettings.micVolume; document.getElementById('lbl-mic-vol').textContent = appSettings.micVolume + '%';
    document.getElementById('set-out-vol').value = appSettings.outVolume; document.getElementById('lbl-out-vol').textContent = appSettings.outVolume + '%';
    document.getElementById('set-cam-res').value = appSettings.camRes || '720';
    document.getElementById('chk-auto-overlay').checked = appSettings.autoOverlay !== false;
    document.getElementById('chk-noise').checked = appSettings.noiseSuppression !== false;
    document.getElementById('chk-echo').checked = appSettings.echoCancellation !== false;
    document.getElementById('chk-agc').checked = appSettings.autoGainControl !== false;
    document.getElementById('chk-compact').checked = !!appSettings.compactChat;
    document.getElementById('sel-font-size').value = appSettings.fontSize || '12px';
    document.getElementById('chk-snd-msg').checked = appSettings.soundMsg !== false;
    document.getElementById('chk-snd-voice').checked = appSettings.soundVoice !== false;
    refreshMediaDevices(); switchSettingsPane(pane || 'profile');
    document.getElementById('settings-modal').classList.add('open');
  }

  function closeSettingsModal() { stopMicTest(); document.getElementById('settings-modal').classList.remove('open'); setMobActiveTab('mob-tab-chat'); }
  function switchSettingsPane(pId) {
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-pane') === pId));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + pId));
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
    const intr = document.getElementById('prof-interests-inp').value.trim().slice(0, 160);

    document.getElementById('preview-banner').style.background = myProfile.bannerColor || '#0d9488';
    const ava = document.getElementById('preview-ava'); ava.textContent = n.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#e11d48';
    document.getElementById('preview-nick').textContent = n; document.getElementById('preview-status').textContent = st || 'В эфире'; document.getElementById('preview-bio').textContent = bio || 'О себе...';
    const tb = document.getElementById('preview-tags'); tb.innerHTML = '';
    const tags = intr.split(',').map(x => x.trim()).filter(Boolean);
    if (!tags.length) tb.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Нет тегов</span>';
    else tags.forEach(tg => tb.appendChild(el('span', 'dp-tag', tg)));

    if (!skipSync) {
      myNick = n; myProfile.presence = pr; myProfile.customStatus = st; myProfile.bio = bio; myProfile.interests = intr;
      try { localStorage.setItem('cyber_nick', myNick); localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
      setPersistCookie('cyber_nick', myNick); saveLocalVault(); applyNickUI();
      if (profileSyncTimer) clearTimeout(profileSyncTimer);
      profileSyncTimer = setTimeout(() => syncProfileToServer(), 350);
    }
  }

  function syncProfileToServer() {
    return fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, presence: myProfile.presence, customStatus: myProfile.customStatus, bio: myProfile.bio, interests: myProfile.interests, bannerColor: myProfile.bannerColor, avatarColor: myProfile.avatarColor }) }).catch(() => {});
  }
  async function saveProfileSettings() { updateProfilePreview(false); await syncProfileToServer(); closeSettingsModal(); }

  async function refreshMediaDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mSel = document.getElementById('set-mic-select'), sSel = document.getElementById('set-spk-select'), cSel = document.getElementById('set-cam-select');
      mSel.innerHTML = ''; sSel.innerHTML = ''; cSel.innerHTML = '';
      devs.forEach(d => {
        if (d.kind === 'audioinput') { const o = el('option', '', d.label || 'Микрофон'); o.value = d.deviceId; if (d.deviceId === appSettings.micDeviceId) o.selected = true; mSel.appendChild(o); }
        else if (d.kind === 'audiooutput') { const o = el('option', '', d.label || 'Динамики'); o.value = d.deviceId; if (d.deviceId === appSettings.spkDeviceId) o.selected = true; sSel.appendChild(o); }
        else if (d.kind === 'videoinput') { const o = el('option', '', d.label || 'Камера'); o.value = d.deviceId; if (d.deviceId === appSettings.camDeviceId) o.selected = true; cSel.appendChild(o); }
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
    document.querySelectorAll('#audio-box audio').forEach(a => { a.volume = vol; a.muted = isDeafened; if (appSettings.spkDeviceId && typeof a.setSinkId === 'function') a.setSinkId(appSettings.spkDeviceId).catch(() => {}); });
  }

  function saveAudioVideoSettings() {
    appSettings.micDeviceId = document.getElementById('set-mic-select')?.value || '';
    appSettings.spkDeviceId = document.getElementById('set-spk-select')?.value || '';
    appSettings.camDeviceId = document.getElementById('set-cam-select')?.value || '';
    appSettings.camRes = document.getElementById('set-cam-res')?.value || '720';
    appSettings.autoOverlay = document.getElementById('chk-auto-overlay')?.checked;
    appSettings.noiseSuppression = document.getElementById('chk-noise')?.checked;
    appSettings.echoCancellation = document.getElementById('chk-echo')?.checked;
    appSettings.autoGainControl = document.getElementById('chk-agc')?.checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
  }

  async function toggleMicTest() {
    if (micTestTimer) { stopMicTest(); return; }
    try {
      micTestStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: appSettings.micDeviceId ? { ideal: appSettings.micDeviceId } : undefined } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createMediaStreamSource(micTestStream), an = ctx.createAnalyser();
      an.fftSize = 256; src.connect(an); const d = new Uint8Array(an.frequencyBinCount);
      document.getElementById('btn-mic-test').textContent = '🛑 Стоп';
      micTestTimer = setInterval(() => { an.getByteFrequencyData(d); let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i]; document.getElementById('mic-test-bar').style.width = Math.min(100, Math.round((sum / d.length / 90) * 100)) + '%'; }, 60);
    } catch (e) { alert('Ошибка микрофона.'); }
  }

  function stopMicTest() {
    if (micTestTimer) { clearInterval(micTestTimer); micTestTimer = null; }
    if (micTestStream) { micTestStream.getTracks().forEach(t => t.stop()); micTestStream = null; }
    const b = document.getElementById('btn-mic-test'); if (b) b.textContent = '🎙️ Проверить';
    const bar = document.getElementById('mic-test-bar'); if (bar) bar.style.width = '0%';
  }

  function setAccentTheme(m, b) { document.documentElement.style.setProperty('--cyan', m); document.documentElement.style.setProperty('--cyan-bright', b); appSettings.accentMain = m; appSettings.accentBright = b; try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {} }
  function applyAppearanceSettings() {
    appSettings.compactChat = document.getElementById('chk-compact').checked; appSettings.fontSize = document.getElementById('sel-font-size').value || '12px';
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {} applyAppearanceFromStorage();
  }
  function applyAppearanceFromStorage() {
    document.body.classList.toggle('compact-chat', !!appSettings.compactChat);
    document.documentElement.style.setProperty('--chat-font-size', appSettings.fontSize || '12px');
    if (appSettings.accentMain) { document.documentElement.style.setProperty('--cyan', appSettings.accentMain); document.documentElement.style.setProperty('--cyan-bright', appSettings.accentBright); }
  }
  function saveNotificationSettings() {
    appSettings.soundMsg = document.getElementById('chk-snd-msg').checked; appSettings.soundVoice = document.getElementById('chk-snd-voice').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
  }

  function logoutAccount() {
    if (!confirm('Выйти из аккаунта?')) return;
    try { localStorage.removeItem('cyber_verified'); localStorage.removeItem('cyber_uid'); } catch (e) {}
    setPersistCookie('cyber_verified', ''); setPersistCookie('cyber_uid', ''); myVerified = false; openAuthModal(true);
  }

  function sendChatMessage(e) {
    e.preventDefault(); if (!myVerified) { openAuthModal(true); return; }
    const inp = document.getElementById('chat-input'), text = inp.value.trim(); if (!text) return;
    if (appSettings.filterOutgoing !== false && checkContentViolation(text).length) { alert('🛡️ Отправка заблокирована фильтром безопасности.'); return; }
    fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, channel: currentChannel, author: myNick, text }) }).catch(() => {});
    inp.value = '';
  }

  function setChannel(ch) {
    currentChannel = ch; unreadByChannel[ch] = 0; updateBrowserUrl(); applyChannelUI(ch); renderServerChannels();
    cachedMessages = roomMessagesCache[ch] || []; rerenderChatMessages(); closeMobileDrawers();
  }

  function selectVoiceChannel(vch) {
    if (!myVerified) { openAuthModal(true); return; }
    currentVoiceChannel = vch; updateVoicePanelUI(); renderServerChannels(); closeMobileDrawers();
    if (!inVoice) toggleVoiceCall();
    else postVoiceState({ inVoice: true, inScreen, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel }).then(d => { if (d?.peers) d.peers.forEach(p => { if (inScreen) callPeerWithScreen(p); if (inWebcam) callPeerWithWebcam(p); }); });
  }

  function openCreateServerModal() { if (!myVerified) return openAuthModal(true); closeMobileDrawers(); document.getElementById('create-server-modal').classList.add('open'); }
  function closeCreateServerModal() { document.getElementById('create-server-modal').classList.remove('open'); }
  async function submitCreateServer() {
    const name = document.getElementById('new-srv-name').value.trim(); if (!name) return alert('Введите название!');
    const res = await fetch('/api/server/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, name }) });
    const d = await res.json(); if (d.error) return alert(d.error); closeCreateServerModal(); await switchServer(d.serverId);
  }

  function openCreateChannelModal(type) {
    if (!myVerified) return openAuthModal(true); closeMobileDrawers(); pendingChannelType = type;
    document.getElementById('create-ch-title').textContent = type === 'voice' ? 'Создать голос' : 'Создать текст';
    document.getElementById('create-channel-modal').classList.add('open');
  }
  function closeCreateChannelModal() { document.getElementById('create-channel-modal').classList.remove('open'); }
  async function submitCreateChannel() {
    const name = document.getElementById('new-ch-name').value.trim(); if (!name) return alert('Введите название!');
    const res = await fetch('/api/channel/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, room: currentRoom, type: pendingChannelType, name }) });
    const d = await res.json(); if (d.error) return alert(d.error); closeCreateChannelModal();
    if (pendingChannelType === 'text' && d.channel) { roomMessagesCache[d.channel] = []; currentServerMeta.textChannels.push(d.channel); saveLocalVault(); setChannel(d.channel); }
    else if (pendingChannelType === 'voice' && d.channel) { currentServerMeta.voiceChannels.push(d.channel); currentVoiceChannel = d.channel; saveLocalVault(); renderServerChannels(); }
  }

  function openInviteModal() {
    closeMobileDrawers(); document.getElementById('invite-modal').classList.add('open');
    const u = window.location.origin + '/?room=' + encodeURIComponent(currentRoom);
    document.getElementById('public-invite-url').textContent = u; document.getElementById('public-invite-url').href = u;
  }
  function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
  async function copyInviteLink() {
    try { await navigator.clipboard.writeText(document.getElementById('public-invite-url').textContent); alert('Ссылка скопирована!'); } catch (e) { prompt('Скопируйте вручную:', document.getElementById('public-invite-url').textContent); }
  }

  async function initTelegramSession() {
    try {
      const res = await fetch('/api/tg-init'); const d = await res.json(); tgSessionToken = d.token || ''; tgBotUsername = d.botUsername || '';
      if (tgBotUsername) document.getElementById('tg-open-bot-btn').innerHTML = '<span>✈️ Открыть @' + escapeHtml(tgBotUsername) + ' и войти</span>';
    } catch (e) {}
  }

  function startTgPolling() {
    if (tgPollTimer) clearInterval(tgPollTimer);
    tgPollTimer = setInterval(async () => {
      if (!tgSessionToken || myVerified) return;
      try {
        const res = await fetch('/api/tg-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, token: tgSessionToken, nick: document.getElementById('nick-inp').value.trim() }) });
        const d = await res.json(); if (d?.ok && d.verified) { clearInterval(tgPollTimer); tgPollTimer = null; completeClientAuth(d); }
      } catch (e) {}
    }, 2000);
  }

  function openTelegramBot() {
    if (!tgBotUsername) { switchAuthTab('pass'); return; }
    window.open(`https://t.me/${encodeURIComponent(tgBotUsername)}?start=auth_${encodeURIComponent(tgSessionToken)}`, '_blank'); startTgPolling();
  }

  async function verifyTelegramCode() {
    const code = document.getElementById('tg-code-inp').value.trim(); if (!code) return alert('Введите код!');
    const res = await fetch('/api/tg-verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, code, nick: document.getElementById('nick-inp').value.trim() }) });
    const d = await res.json(); if (d.error) return alert(d.error); completeClientAuth(d);
  }

  function completeClientAuth(d) {
    if (d.uid && d.uid !== myUid) myUid = d.uid;
    if (d.nick) myNick = d.nick;
    myVerified = true; authLocked = false;
    try { localStorage.setItem('cyber_uid', myUid); localStorage.setItem('cyber_nick', myNick); localStorage.setItem('cyber_verified', '1'); } catch (e) {}
    setPersistCookie('cyber_uid', myUid); setPersistCookie('cyber_nick', myNick); setPersistCookie('cyber_verified', '1');
    applyNickUI(); closeAuthModal(); connectEventStream();
  }

  function openAuthModal(lock) {
    authLocked = !!lock || !myVerified; document.getElementById('auth-close-btn').style.display = authLocked ? 'none' : 'block';
    if (myNick && !myNick.startsWith('Гость_')) document.getElementById('nick-inp').value = myNick;
    document.getElementById('auth-modal').classList.add('open'); initTelegramSession().then(() => startTgPolling());
  }
  function closeAuthModal() { if (authLocked && !myVerified) return; if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; } document.getElementById('auth-modal').classList.remove('open'); }

  async function loginWithPassword() {
    const nick = document.getElementById('nick-inp').value.trim(), pass = document.getElementById('pass-inp').value;
    if (!nick) return alert('Введите позывной!'); if (!pass && !myVerified) return alert('Введите пароль!');
    const res = await fetch('/api/auth-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick, password: pass }) });
    const d = await res.json(); if (d.error) return alert(d.error); completeClientAuth(d);
  }

  function postVoiceState(st) { return fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: clientId }, st)) }).then(r => r.json()).catch(() => ({})); }

  function createProcessedAudioStream(stream) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream); micGainNode = audioCtx.createGain(); micGainNode.gain.value = (appSettings.micVolume || 100) / 100;
      const dst = audioCtx.createMediaStreamDestination(); src.connect(micGainNode); micGainNode.connect(dst); return dst.stream;
    } catch (e) { return stream; }
  }

  function resetVoiceUI() {
    document.getElementById('connect-voice-btn').textContent = 'ПОДКЛЮЧИТЬСЯ'; document.getElementById('connect-voice-btn').className = 'btn-cyan';
    document.getElementById('mute-btn').style.display = 'none'; document.getElementById('deafen-btn').style.display = 'none';
    document.getElementById('voice-active-area').classList.remove('show'); document.getElementById('audio-box').innerHTML = ''; document.getElementById('screen-grid').innerHTML = '';
    stopBackgroundCallPersistence(); renderServerChannels();
  }

  async function ensureVoiceConnected() {
    if (!myVerified) { openAuthModal(true); return false; }
    if (inVoice && peer && myPeerId) return true;
    try {
      rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: appSettings.micDeviceId ? { ideal: appSettings.micDeviceId } : undefined, noiseSuppression: appSettings.noiseSuppression !== false, echoCancellation: appSettings.echoCancellation !== false, autoGainControl: appSettings.autoGainControl !== false } });
      localStream = createProcessedAudioStream(rawMicStream); isMuted = false;
    } catch (e) {
      localStream = (new (window.AudioContext || window.webkitAudioContext)()).createMediaStreamDestination().stream; isMuted = true;
    }
    inVoice = true; if (appSettings.soundVoice) playUiBeep(720, 0.09);
    document.getElementById('connect-voice-btn').textContent = 'ОТКЛЮЧИТЬСЯ'; document.getElementById('connect-voice-btn').className = 'btn-danger';
    document.getElementById('mute-btn').style.display = 'inline-block'; document.getElementById('deafen-btn').style.display = 'inline-block';
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('voice-active-area').classList.add('show');
    startBackgroundCallPersistence(); renderServerChannels();

    return new Promise(resolve => {
      peer = new Peer();
      peer.on('open', id => { myPeerId = id; postVoiceState({ inVoice: true, inScreen, inCam: inWebcam, peerId: id, voiceChannel: currentVoiceChannel }).then(() => resolve(true)); });
      peer.on('call', call => {
        const kind = call.metadata?.kind || 'audio', n = call.metadata?.nick || 'Участник';
        if (kind === 'screen' || kind === 'cam') {
          call.answer(); call.on('stream', st => renderMediaTile(kind + '-' + call.peer, st, n + (kind === 'cam' ? ' (Камера)' : ' (Экран)'), false, kind));
          call.on('close', () => removeMediaTile(kind + '-' + call.peer)); call.on('error', () => removeMediaTile(kind + '-' + call.peer));
        } else {
          call.answer(localStream || undefined); call.on('stream', st => playStream(call.peer, st));
          call.on('close', () => removeAudio(call.peer)); call.on('error', () => removeAudio(call.peer));
        }
      });
      peer.on('error', () => resolve(false));
    });
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (inScreen) stopScreenShare(true); if (inWebcam) stopWebcam(true);
      if (rawMicStream) rawMicStream.getTracks().forEach(t => t.stop());
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      if (peer) peer.destroy();
      rawMicStream = null; localStream = null; peer = null; myPeerId = null; inVoice = false; isMuted = false; isDeafened = false;
      if (appSettings.soundVoice) playUiBeep(420, 0.09);
      resetVoiceUI(); postVoiceState({ inVoice: false, inScreen: false, inCam: false }); return;
    }
    await ensureVoiceConnected();
  }

  function callPeerWithWebcam(pid) {
    if (!peer || !webcamStream || !pid || pid === myPeerId) return;
    if (camCalls[pid]) try { camCalls[pid].close(); } catch (e) {}
    const c = peer.call(pid, webcamStream, { metadata: { kind: 'cam', nick: myNick, voiceChannel: currentVoiceChannel } });
    if (c) { camCalls[pid] = c; c.on('close', () => delete camCalls[pid]); c.on('error', () => delete camCalls[pid]); }
  }

  async function toggleWebcam() {
    if (!myVerified) return openAuthModal(true);
    if (inWebcam) { stopWebcam(false); return; }
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: appSettings.camDeviceId ? { ideal: appSettings.camDeviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) { alert('Ошибка доступа к камере.'); return; }
    if (!(await ensureVoiceConnected())) { webcamStream.getTracks().forEach(t => t.stop()); return; }
    inWebcam = true; document.getElementById('cam-btn').textContent = '🛑 Выкл камеру'; document.getElementById('cam-btn').classList.add('active-cam');
    document.getElementById('voice-active-area').classList.add('show');
    webcamStream.getVideoTracks()[0].onended = () => stopWebcam(false);
    renderMediaTile('cam-local', webcamStream, myNick + ' (Ваша камера)', true, 'cam');
    const d = await postVoiceState({ inVoice: true, inScreen, inCam: true, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d?.peers) d.peers.forEach(p => callPeerWithWebcam(p));
    updateFloatingOverlayUI();
  }

  function stopWebcam(silent) {
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
    Object.keys(camCalls).forEach(p => { try { camCalls[p].close(); } catch (e) {} }); camCalls = {};
    inWebcam = false; document.getElementById('cam-btn').textContent = '📷 Камера'; document.getElementById('cam-btn').classList.remove('active-cam');
    removeMediaTile('cam-local');
    if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen, inCam: false, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateFloatingOverlayUI();
  }

  function callPeerWithScreen(pid) {
    if (!peer || !screenStream || !pid || pid === myPeerId) return;
    if (screenCalls[pid]) try { screenCalls[pid].close(); } catch (e) {}
    const c = peer.call(pid, screenStream, { metadata: { kind: 'screen', nick: myNick, voiceChannel: currentVoiceChannel } });
    if (c) { screenCalls[pid] = c; c.on('close', () => delete screenCalls[pid]); c.on('error', () => delete screenCalls[pid]); }
  }

  async function toggleScreenShare() {
    if (!myVerified) return openAuthModal(true);
    if (inScreen) { stopScreenShare(false); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { alert('Демонстрация экрана недоступна на этом устройстве.'); return; }
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', frameRate: { ideal: 30 } }, audio: true }); } catch (e) { return; }
    if (!(await ensureVoiceConnected())) { screenStream.getTracks().forEach(t => t.stop()); return; }
    inScreen = true; document.getElementById('screen-btn').textContent = '🛑 Стоп экран'; document.getElementById('screen-btn').classList.add('active-screen');
    document.getElementById('voice-active-area').classList.add('show');
    screenStream.getVideoTracks()[0].onended = () => stopScreenShare(false);
    renderMediaTile('screen-local', screenStream, myNick + ' (Ваш экран)', true, 'screen');
    const d = await postVoiceState({ inVoice: true, inScreen: true, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d?.peers) d.peers.forEach(p => callPeerWithScreen(p));
    updateFloatingOverlayUI();
  }

  function stopScreenShare(silent) {
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    Object.keys(screenCalls).forEach(p => { try { screenCalls[p].close(); } catch (e) {} }); screenCalls = {};
    inScreen = false; document.getElementById('screen-btn').textContent = '🖥️ Экран'; document.getElementById('screen-btn').classList.remove('active-screen');
    removeMediaTile('screen-local');
    if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: false, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateFloatingOverlayUI();
  }

  function toggleMediaNsfwShield(card, btn) {
    if (!card) return;
    const isMasked = card.classList.toggle('nsfw-masked');
    if (btn) { btn.textContent = isMasked ? '👁️ Показать видео' : '🛡️ Скрыть 18+'; btn.classList.toggle('active-shield', isMasked); }
    drawSystemPipOverlayFrame();
  }

  function renderMediaTile(id, stream, title, isLocal, kind) {
    const grid = document.getElementById('screen-grid'); let card = document.getElementById('media-tile-' + id);
    const icon = kind === 'cam' ? '📷 ' : '🖥️ ';
    if (!card) {
      card = el('div', 'screen-card'); card.id = 'media-tile-' + id;
      const head = el('div', 'screen-card-head'), left = el('div', ''), right = el('div', ''); right.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
      left.appendChild(el('span', '', icon + title)); left.appendChild(el('span', 'screen-live-pill' + (kind === 'cam' ? ' cam' : ''), kind === 'cam' ? 'КАМЕРА' : 'СТРИМ'));
      
      const shieldBtn = el('button', 'btn-fs', '🛡️ Скрыть 18+'); shieldBtn.onclick = () => toggleMediaNsfwShield(card, shieldBtn); right.appendChild(shieldBtn);
      const pipBtn = el('button', 'btn-fs', '🪟 В окне'); pipBtn.onclick = () => toggleExternalOverlay(); right.appendChild(pipBtn);
      const fsBtn = el('button', 'btn-fs', '⛶ На весь экран'); fsBtn.onclick = () => card.querySelector('video')?.requestFullscreen?.(); right.appendChild(fsBtn);
      if (isLocal) { const stopBtn = el('button', 'btn-fs', '✕ Выкл'); stopBtn.style.cssText = 'border-color:#f43f5e;color:#fda4af;'; stopBtn.onclick = () => kind === 'cam' ? stopWebcam(false) : stopScreenShare(false); right.appendChild(stopBtn); }
      head.appendChild(left); head.appendChild(right);
      
      const wrap = el('div', 'screen-video-wrap'), vid = document.createElement('video'); vid.autoplay = true; vid.playsInline = true; if (isLocal) vid.muted = true;
      const shield = el('div', 'media-nsfw-shield'); shield.innerHTML = '<div>🔞 Видеопоток скрыт фильтром 18+</div><span class="btn-cyan" style="padding:5px 12px;font-size:10px;">👁️ Показать камеру обратно</span>';
      shield.onclick = () => toggleMediaNsfwShield(card, shieldBtn);
      wrap.appendChild(vid); wrap.appendChild(shield); card.appendChild(head); card.appendChild(wrap); grid.appendChild(card);
    } else {
      card.querySelector('.screen-card-head span').textContent = icon + title;
    }
    const vEl = card.querySelector('video'); if (vEl && vEl.srcObject !== stream) { vEl.srcObject = stream; vEl.play().catch(() => {}); }
  }

  function removeMediaTile(id) { document.getElementById('media-tile-' + id)?.remove(); }

  function toggleMute() {
    if (!localStream) return; isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    if (rawMicStream) rawMicStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл'; updateFloatingOverlayUI();
  }

  function toggleDeafen() {
    isDeafened = !isDeafened; document.getElementById('deafen-btn').textContent = isDeafened ? '🔇 Звук выкл' : '🎧 Звук вкл';
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
  }

  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const a = document.createElement('audio'); a.id = 'aud-' + id; a.srcObject = stream; a.autoplay = true; a.playsInline = true;
    document.getElementById('audio-box').appendChild(a); applyOutputVolumeToAll(); a.play().catch(() => {});
  }
  function removeAudio(id) { document.getElementById('aud-' + id)?.remove(); }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSettingsModal(); closeViewProfileModal(); closeInviteModal(); closeMobileDrawers(); } });
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

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(JSON.stringify({
        name: 'СИГНАЛ — Ночной клуб', short_name: 'СИГНАЛ', start_url: '/', display: 'standalone', background_color: '#040609', theme_color: '#040609',
        icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23e11d48' width='100' height='100' rx='22'/><text y='.88em' font-size='68' x='16' fill='white'>⚡</text></svg>", sizes: '192x192 512x512', type: 'image/svg+xml' }]
      }));
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
      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick });
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
      return sendJson(res, 200, { ok: true, verified: true, uid: finalUid, pid: u.pid, nick: u.nick });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = String(url.searchParams.get('id') || '').slice(0, 32);
      const room = safeRoom(url.searchParams.get('room'));
      const nick = cleanNick(url.searchParams.get('nick') || 'Гость');
      const uid = url.searchParams.get('uid');
      if (!validUid(uid)) { res.writeHead(400); return res.end(); }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');

      const meta = ensureServer(room), user = ensureUser(uid, nick, url.searchParams.get('verified') === '1');
      addMember(room, uid);
      const client = { id, uid, room, nick: user.nick, inVoice: false, inScreen: false, inCam: false, peerId: null, voiceChannel: null, res };
      clients.push(client);

      res.write('data: ' + JSON.stringify({ type: 'server-meta', payload: { current: meta, list: Object.values(serversMeta), messagesByChannel: getRoom(room) } }) + '\n\n');
      notifyAllRoomsOfUser(uid); sendSocial(uid); notifyFriendsOf(uid);

      req.on('close', () => {
        clients = clients.filter(c => c !== client);
        notifyAllRoomsOfUser(uid); notifyFriendsOf(uid);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/switch-room') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Некорректный ID' });
      const newRoom = safeRoom(body.room), meta = ensureServer(newRoom);
      ensureUser(uid, body.nick || 'Участник', true); addMember(newRoom, uid);
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
      if (body.bannerColor !== undefined) u.bannerColor = cleanColor(body.bannerColor, '#0d9488');
      if (body.avatarColor !== undefined) u.avatarColor = cleanColor(body.avatarColor, '#e11d48');
      scheduleSave(); notifyAllRoomsOfUser(uid); notifyFriendsOf(uid); sendSocial(uid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const room = safeRoom(url.searchParams.get('room')), ch = safeChannel(room, url.searchParams.get('channel'));
      return sendJson(res, 200, (rooms[room]?.[ch]) || []);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') return sendJson(res, 200, { publicUrl: null });

    if (req.method === 'POST' && url.pathname === '/api/auth-password') {
      const body = await readBody(req), nick = cleanNick(body.nick), pass = String(body.password || ''), room = safeRoom(body.room), prevUid = validUid(body.uid) ? body.uid : null;
      if (!nick || nick.length < 2) return sendJson(res, 400, { error: 'Введите позывной!' });
      if (prevUid && users[prevUid]?.verified && !pass) {
        users[prevUid].nick = nick; scheduleSave(); notifyAllRoomsOfUser(prevUid); notifyFriendsOf(prevUid); sendSocial(prevUid);
        return sendJson(res, 200, { ok: true, uid: prevUid, pid: users[prevUid].pid, nick });
      }
      if (pass.length < 4) return sendJson(res, 400, { error: 'Пароль от 4 символов!' });
      const exUid = nickToUid[nick.toLowerCase()];
      if (exUid && users[exUid]?.passHash) {
        if (!verifyPassword(pass, users[exUid].passHash)) return sendJson(res, 400, { error: 'Неверный пароль!' });
        const u = mergeAccount(prevUid, exUid, nick, '', '', ''); addMember(room, exUid);
        scheduleSave(); notifyAllRoomsOfUser(exUid); notifyFriendsOf(exUid); sendSocial(exUid);
        return sendJson(res, 200, { ok: true, uid: exUid, pid: u.pid, nick: u.nick });
      }
      const finalUid = exUid || (prevUid && !users[prevUid]?.verified ? prevUid : crypto.randomBytes(16).toString('hex'));
      const u = mergeAccount(prevUid, finalUid, nick, '', '', hashPassword(pass)); addMember(room, finalUid);
      scheduleSave(); notifyAllRoomsOfUser(finalUid); notifyFriendsOf(finalUid); sendSocial(finalUid);
      return sendJson(res, 200, { ok: true, uid: finalUid, pid: u.pid, nick: u.nick });
    }

    if (req.method === 'POST' && url.pathname === '/api/server/create') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Сначала войдите!' });
      const u = ensureUser(uid, body.nick || 'Участник', true), name = String(body.name || '').trim().slice(0, 28);
      if (!name) return sendJson(res, 400, { error: 'Введите название сервера!' });
      const newId = 'cy-' + crypto.randomBytes(2).toString('hex');
      ensureServer(newId, name, String(body.desc || '').trim().slice(0, 80)); addMember(newId, uid);
      rooms[newId]['игровая-комната'].push({ author: 'СИСТЕМА', time: '00:00', text: `Сервер «${name}» создан!` });
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
      if (!validUid(uid)) return sendJson(res, 403, { error: 'Войдите в аккаунт' });
      const u = ensureUser(uid, body.author || c?.nick || 'Участник', true);
      const now = new Date(), time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author: u.nick, time, text, flags: detectFlags(text) };
      const rm = getRoom(room); if (!rm[ch]) rm[ch] = []; rm[ch].push(msg);
      if (rm[ch].length > MAX_HISTORY) rm[ch].shift();
      scheduleSave(room); broadcast(room, 'msg', { channel: ch, msg });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/friend') {
      const body = await readBody(req), uid = body.uid; if (!validUid(uid)) return sendJson(res, 400, { error: 'Войдите!' });
      const me = ensureUser(uid, 'Участник', true), tUid = validPid(body.target) ? pidToUid[body.target] : null, target = tUid ? users[tUid] : null;
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

server.on('error', err => { if (err.code !== 'EADDRINUSE') process.exit(1); });

async function boot() {
  for (let i = 1; i <= 5; i++) {
    try { await loadData(); break; } catch (e) { if (i === 5) process.exit(1); await new Promise(r => setTimeout(r, 2000)); }
  }
  server.listen(PORT, '0.0.0.0', () => startTelegramBotPolling());
}
boot();

async function shutdown() {
  setTimeout(() => process.exit(0), 4000).unref();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await saveNow(); process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, shutdown));