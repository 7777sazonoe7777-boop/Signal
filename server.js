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
    text: 'Добро пожаловать в «Ночной клуб»! Все вкладки, друзья, серверы, оверлей и мобильный фоновый режим активны.'
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
            await tgApi('sendMessage', { chat_id: m.chat.id, parse_mode: 'Markdown', text: '⚡ *СИГНАЛ // CYBER.NET*\n\n✅ Аккаунт подтверждён!\n🔑 Код: *' + code + '*\n\nВернитесь в браузер.' }).catch(() => {});
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
    (v.incoming || []).filter(validPid).forEach(p => { if (!me.friends.includes(p) && !me.incoming.includes(p)) me.incoming.push(p); });
    (v.outgoing || []).filter(validPid).forEach(p => { if (!me.friends.includes(p) && !me.outgoing.includes(p)) me.outgoing.push(p); });
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
<meta name="theme-color" content="#1e1f22">
<title>СИГНАЛ — Сообщество</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root {
    --bg-servers: #1e1f22;
    --bg-channels: #2b2d31;
    --bg-chat: #313338;
    --bg-members: #2b2d31;
    --bg-userbar: #232428;
    --bg-input: #383a40;
    --bg-hover: #35373c;
    --bg-active: #404249;
    --brand: #5865f2;
    --brand-hover: #4752c4;
    --streamer: #593695;
    --green: #23a55a;
    --red: #f23f43;
    --yellow: #f0b232;
    --text-main: #f2f3f5;
    --text-normal: #dbdee1;
    --text-muted: #949ba4;
    --text-dim: #80848e;
    --border: rgba(255, 255, 255, 0.06);
    --cyan: #5865f2;
    --cyan-bright: #5865f2;
    --cyan-border: rgba(88, 101, 242, 0.45);
    --chat-font-size: 14px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body {
    font-family: 'gg sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg-servers);
    color: var(--text-main);
    height: 100vh;
    height: 100dvh;
    display: flex;
    overflow: hidden;
    user-select: none;
  }

  /* Основная сетка как в примере: 72px серверы слева на всю высоту + правая часть с баннером стримера сверху */
  .app-layout {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  /* 1. ЛЕВАЯ КОЛОНКА СЕРВЕРОВ (72px) */
  .servers-rail {
    width: 72px;
    background: var(--bg-servers);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 0;
    gap: 8px;
    overflow-y: auto;
    flex-shrink: 0;
    z-index: 20;
  }
  .servers-rail::-webkit-scrollbar { display: none; }

  .srv-pill-wrap {
    position: relative;
    width: 72px;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .srv-pill-bar {
    position: absolute;
    left: 0;
    width: 4px;
    height: 8px;
    background: #fff;
    border-radius: 0 4px 4px 0;
    opacity: 0;
    transition: 0.18s;
  }
  .srv-pill-wrap:hover .srv-pill-bar { opacity: 1; height: 20px; }
  .srv-pill-wrap.active .srv-pill-bar { opacity: 1; height: 40px; }

  .srv-ico {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-chat);
    color: var(--text-normal);
    font-weight: 700;
    font-size: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: border-radius 0.18s, background 0.18s, color 0.18s;
    flex-shrink: 0;
    overflow: hidden;
  }
  .srv-ico:hover, .srv-pill-wrap.active .srv-ico {
    border-radius: 16px;
    background: var(--brand);
    color: #fff;
  }
  .srv-ico.home-ico { background: var(--bg-chat); font-size: 20px; }
  .srv-ico.home-ico:hover { background: var(--brand); }

  .rail-sep {
    width: 32px;
    height: 2px;
    background: rgba(255,255,255,0.08);
    border-radius: 1px;
    margin: 2px 0;
    flex-shrink: 0;
  }

  .srv-ico-action {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-chat);
    color: var(--green);
    font-size: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: 0.18s;
    flex-shrink: 0;
  }
  .srv-ico-action:hover {
    border-radius: 16px;
    background: var(--green);
    color: #fff;
  }
  .srv-ico-action.neutral { color: var(--text-normal); font-size: 18px; }
  .srv-ico-action.neutral:hover { background: var(--brand); color: #fff; }

  /* ПРАВАЯ ОБЛАСТЬ (Баннер стримера сверху + 3 колонки внизу) */
  .right-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  /* Фиолетовая плашка режима стримера сверху */
  .streamer-bar {
    height: 36px;
    background: linear-gradient(90deg, #593695 0%, #6441a5 100%);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 14px;
    font-size: 13px;
    font-weight: 600;
    position: relative;
    flex-shrink: 0;
    gap: 12px;
  }
  .streamer-bar.hidden { display: none; }
  .streamer-btn-disable {
    background: #fff;
    color: #1e1f22;
    border: none;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .streamer-btn-hide {
    position: absolute;
    right: 12px;
    background: transparent;
    color: #fff;
    border: 1px solid rgba(255,255,255,0.45);
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  /* Рабочая область из 3 колонок: 240px каналы | 1fr чат | 240px участники */
  .workspace {
    flex: 1;
    display: grid;
    grid-template-columns: 240px 1fr 240px;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }
  body.hide-members-panel .workspace {
    grid-template-columns: 240px 1fr;
  }
  body.hide-members-panel .right-panel {
    display: none;
  }

  /* 2. КОЛОНКА КАНАЛОВ (240px) */
  .channels-panel {
    background: var(--bg-channels);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
  }

  .srv-header {
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid rgba(0,0,0,0.28);
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .srv-header:hover { background: var(--bg-hover); }
  .srv-title {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .srv-chevron { color: var(--text-normal); font-size: 14px; }

  .channels-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px 12px;
  }
  .channels-scroll::-webkit-scrollbar { width: 4px; }
  .channels-scroll::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }

  /* Блок "Нужно бустов" как на скриншоте */
  .boost-box {
    padding: 6px 8px 10px;
    margin-bottom: 6px;
  }
  .boost-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text-normal);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .boost-count { color: var(--text-muted); font-size: 11px; font-weight: 500; }
  .boost-bar-bg {
    height: 4px;
    background: #1e1f22;
    border-radius: 999px;
    overflow: hidden;
  }
  .boost-bar-fill {
    width: 14%;
    height: 100%;
    background: linear-gradient(90deg, #5865f2, #eb459e);
    border-radius: 999px;
  }

  /* Навигационные пункты под бустами (Пригласить людей, Участники, Бусты сервера) */
  .QuickNav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    margin-bottom: 2px;
  }
  .QuickNav-item:hover { background: var(--bg-hover); color: var(--text-normal); }
  .QuickNav-ico { width: 18px; text-align: center; font-size: 14px; color: var(--text-muted); }

  .sidebar-divider {
    height: 1px;
    background: rgba(255,255,255,0.06);
    margin: 8px 4px;
  }

  .cat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 4px 4px 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
  }
  .cat-header:hover { color: var(--text-normal); }
  .cat-add-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .cat-add-btn:hover { color: #fff; }

  .ch-btn, .voice-ch-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    margin-bottom: 2px;
  }
  .ch-btn:hover, .voice-ch-box:hover {
    background: var(--bg-hover);
    color: var(--text-normal);
  }
  .ch-btn.active {
    background: var(--bg-active);
    color: #fff;
  }
  .voice-ch-box.active {
    background: rgba(35, 165, 90, 0.16);
    color: #fff;
  }
  .ch-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }
  .ch-hash {
    color: var(--text-dim);
    font-size: 18px;
    font-weight: 600;
    line-height: 1;
    width: 18px;
    text-align: center;
  }
  .ch-name-txt {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ch-right-icons {
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .ch-btn:hover .ch-right-icons, .ch-btn.active .ch-right-icons { opacity: 1; }
  .ch-unread-badge {
    background: var(--red);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 999px;
  }
  .off-badge {
    font-size: 10px;
    color: var(--text-muted);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .off-badge.on { color: #23a55a; font-weight: 700; }

  /* Нижняя панель пользователя (52px) как в Discord */
  .user-bar {
    height: 52px;
    padding: 0 8px;
    background: var(--bg-userbar);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    flex-shrink: 0;
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
    flex: 1;
    min-width: 0;
  }
  .user-info:hover { background: var(--bg-hover); }
  .user-ava-wrap { position: relative; flex-shrink: 0; }
  .user-ava {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--brand);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .user-presence-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--green);
    border: 2px solid var(--bg-userbar);
  }
  .user-presence-dot.idle { background: var(--yellow); }
  .user-presence-dot.dnd { background: var(--red); }
  .user-presence-dot.invisible, .user-presence-dot.offline { background: var(--text-dim); }
  .user-name {
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }
  .user-sub {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }
  .user-bar-controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .ub-ctrl-btn {
    width: 32px;
    height: 32px;
    border-radius: 4px;
    background: transparent;
    border: none;
    color: var(--text-normal);
    font-size: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .ub-ctrl-btn:hover { background: var(--bg-hover); color: #fff; }
  .ub-ctrl-btn.off { color: var(--red); }

  /* 3. ЦЕНТРАЛЬНАЯ ОБЛАСТЬ ЧАТА */
  .main-chat {
    background: var(--bg-chat);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  /* Верхняя панель канала (48px) с иконками колокольчика, пина, участников и поиском */
  .chat-topbar {
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid rgba(0,0,0,0.28);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
  }
  .chat-topbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .hash-large {
    color: var(--text-dim);
    font-size: 22px;
    font-weight: 500;
    line-height: 1;
  }
  .top-ch-name {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
  }
  .top-ch-desc {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-left: 8px;
    padding-left: 10px;
    border-left: 1px solid rgba(255,255,255,0.1);
  }
  .chat-topbar-right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
  }
  .top-ico-btn {
    background: transparent;
    border: none;
    color: var(--text-normal);
    font-size: 17px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .top-ico-btn:hover { color: #fff; }
  .top-search-box {
    width: 195px;
    height: 24px;
    background: #1e1f22;
    border-radius: 4px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .top-search-box input {
    background: transparent;
    border: none;
    color: var(--text-normal);
    font-size: 12px;
    width: 100%;
    outline: none;
  }
  .top-search-box span { color: var(--text-muted); font-size: 12px; }

  .mob-top-btn {
    display: none;
    background: transparent;
    border: none;
    color: var(--text-normal);
    font-size: 20px;
    cursor: pointer;
  }

  /* Лента сообщений как в Discord */
  .chat-scroll-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  .chat-scroll-area::-webkit-scrollbar { width: 8px; }
  .chat-scroll-area::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }

  .hero-banner {
    padding: 12px 16px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    margin: 0 16px 8px;
  }
  .hero-banner h2 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 4px; }
  .hero-banner p { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
  .pill-tags-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill-tag {
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    background: #2b2d31;
    color: var(--text-normal);
    cursor: pointer;
  }
  .pill-tag:hover { background: var(--bg-active); color: #fff; }
  .pill-tag.pink { background: var(--brand); color: #fff; }

  /* Разделитель дат */
  .date-divider {
    display: flex;
    align-items: center;
    margin: 12px 16px 8px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }
  .date-divider::before, .date-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(255,255,255,0.07);
  }
  .date-divider span { padding: 0 8px; }

  .messages-container { display: flex; flex-direction: column; }
  .msg-item {
    display: flex;
    gap: 16px;
    padding: 6px 16px;
    transition: background 0.1s;
  }
  .msg-item:hover { background: rgba(0, 0, 0, 0.08); }
  body.compact-chat .msg-item { padding: 3px 16px; }

  .msg-ava {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--brand);
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .msg-author {
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    margin-right: 8px;
    cursor: pointer;
  }
  .msg-author:hover { text-decoration: underline; }
  .msg-time { font-size: 11px; color: var(--text-muted); }
  .msg-text {
    font-size: var(--chat-font-size);
    color: var(--text-normal);
    margin-top: 2px;
    line-height: 1.38;
    user-select: text;
    word-break: break-word;
  }
  .msg-text a { color: #00a8fc; text-decoration: none; }
  .msg-text a:hover { text-decoration: underline; }

  .chat-inline-media {
    max-width: min(100%, 480px);
    max-height: 300px;
    border-radius: 8px;
    margin-top: 8px;
    display: block;
    border: 1px solid rgba(0,0,0,0.3);
  }

  .filtered-block-card {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(242, 63, 67, 0.12);
    border: 1px solid rgba(242, 63, 67, 0.4);
    color: #fca5a5;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    margin-top: 4px;
  }
  .spoiler-blur-wrap {
    position: relative;
    display: inline-block;
    width: 100%;
    background: #232428;
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 4px;
    cursor: pointer;
  }
  .spoiler-blur-content { filter: blur(8px); user-select: none; pointer-events: none; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter: none; user-select: text; pointer-events: auto; }
  .spoiler-badge { font-size: 11px; font-weight: 600; color: #fca5a5; margin-bottom: 4px; }
  .spoiler-blur-wrap.revealed .spoiler-badge { display: none; }

  /* Панель голосовой связи внутри чата */
  .voice-panel {
    margin: 8px 16px;
    background: #232428;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .voice-panel-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .voice-label { font-size: 10px; text-transform: uppercase; color: var(--green); font-weight: 700; }
  .voice-title { font-size: 14px; font-weight: 700; color: #fff; margin: 2px 0; }
  .voice-sub { font-size: 12px; color: var(--text-muted); }
  .voice-active-area { display: none; flex-direction: column; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
  .voice-active-area.show { display: flex; }
  .voice-user-card { display: flex; align-items: center; gap: 8px; background: #1e1f22; padding: 6px 10px; border-radius: 6px; width: fit-content; }
  .vu-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }

  /* Нижнее поле ввода как в Discord (+ слева, Написать в #канал, иконки справа) */
  .chat-bottom {
    padding: 0 16px 20px;
    background: var(--bg-chat);
    flex-shrink: 0;
  }
  .input-row {
    background: var(--bg-input);
    border-radius: 8px;
    padding: 0 12px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .input-plus-btn {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #b5bac1;
    color: #313338;
    border: none;
    font-size: 17px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }
  .input-plus-btn:hover { background: #fff; }
  .chat-inp {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-size: 14px;
    outline: none;
  }
  .chat-inp::placeholder { color: #6d6f78; }
  .input-right-icons {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #b5bac1;
    font-size: 17px;
  }
  .input-right-icons span { cursor: pointer; }
  .input-right-icons span:hover { color: #fff; }

  /* 4. ПРАВАЯ КОЛОНКА УЧАСТНИКОВ (240px) */
  .right-panel {
    width: 240px;
    background: var(--bg-members);
    padding: 16px 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    height: 100%;
  }
  .right-panel::-webkit-scrollbar { width: 4px; }
  .right-panel::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }

  .right-sec-title {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    padding: 10px 8px 4px;
    letter-spacing: 0.4px;
  }
  .online-user-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 4px;
    cursor: pointer;
    min-width: 0;
  }
  .online-user-item:hover { background: var(--bg-hover); }
  .member-ava-wrap {
    position: relative;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
  }
  .member-ava {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--brand);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .online-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--green);
    border: 2px solid var(--bg-members);
  }
  .online-dot.idle { background: var(--yellow); }
  .online-dot.dnd { background: var(--red); }
  .online-dot.off, .online-dot.offline { background: #80848e; }

  .member-text-col { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
  .member-nick-row {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-normal);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .bot-badge {
    background: var(--brand);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .member-status-sub {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mini-btn {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.18);
    color: var(--text-normal);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .mini-btn:hover { background: var(--brand); border-color: var(--brand); color: #fff; }
  .friend-tag { font-size: 10px; color: var(--green); font-weight: 600; }

  /* Кнопки и виджеты */
  .btn-cyan { background: var(--brand); color: #fff; border: none; padding: 7px 14px; border-radius: 4px; font-weight: 600; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .btn-cyan:hover { background: var(--brand-hover); }
  .btn-danger { background: var(--red); color: #fff; border: none; padding: 7px 12px; border-radius: 4px; font-weight: 600; font-size: 12px; cursor: pointer; }
  .btn-mute { background: #2b2d31; color: var(--text-normal); border: 1px solid rgba(255,255,255,0.1); padding: 6px 10px; border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer; }
  .btn-mute:hover { background: var(--bg-active); color: #fff; }
  .btn-mute.active-screen { background: var(--red); border-color: var(--red); color: #fff; }
  .btn-mute.active-cam { background: var(--green); border-color: var(--green); color: #fff; }
  .btn-login-mini { background: #383a40; border: none; color: var(--text-normal); padding: 6px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn-tg { background: #229ED9; color: #fff; border: none; width: 100%; padding: 10px 14px; border-radius: 4px; font-weight: 700; font-size: 13px; cursor: pointer; margin-bottom: 10px; }

  /* Оверлей звонка и видеосетка */
  .floating-call-overlay { position: fixed; right: 18px; bottom: 72px; width: 290px; background: #1e1f22; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 10px 12px; z-index: 980; box-shadow: 0 12px 32px rgba(0,0,0,0.6); display: none; flex-direction: column; gap: 8px; }
  .floating-call-overlay.show { display: flex; }
  .fco-head { display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .fco-live { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--green); }
  .fco-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .fco-timer { font-size: 11px; font-family: monospace; color: var(--text-normal); }
  .fco-peers { display: flex; flex-wrap: wrap; gap: 5px; max-height: 74px; overflow-y: auto; }
  .fco-peer-chip { display: inline-flex; align-items: center; gap: 5px; background: #2b2d31; padding: 3px 8px; border-radius: 999px; font-size: 11px; color: #fff; }
  .fco-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
  .fco-btn { background: #2b2d31; border: none; color: #fff; padding: 6px 4px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .fco-btn.danger { background: var(--red); }
  .fco-btn.active-pip { background: var(--brand); }

  .screen-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; width: 100%; }
  .screen-grid:empty { display: none; }
  .screen-card { background: #1e1f22; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .screen-card-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: #111214; font-size: 12px; font-weight: 600; color: #fff; gap: 6px; flex-wrap: wrap; }
  .screen-live-pill { background: var(--red); color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
  .screen-live-pill.cam { background: var(--green); }
  .screen-video-wrap { position: relative; width: 100%; background: #000; display: flex; align-items: center; justify-content: center; min-height: 160px; max-height: 360px; overflow: hidden; }
  .screen-video-wrap video { width: 100%; max-height: 360px; object-fit: contain; background: #000; display: block; transition: filter 0.25s; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter: blur(26px) brightness(0.3); }
  .media-nsfw-shield { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: rgba(0,0,0,0.75); color: #fff; font-size: 12px; font-weight: 700; text-align: center; padding: 14px; z-index: 5; cursor: pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display: flex; }
  .btn-fs { background: #2b2d31; border: none; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; }
  .btn-fs.active-shield { background: var(--red); }

  /* Модальные окна */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: none; align-items: center; justify-content: center; z-index: 999; padding: 12px; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background: #313338; border-radius: 8px; padding: 20px; width: 400px; max-width: 100%; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .modal-box input[type="text"], .modal-box input[type="password"], .modal-box textarea, .modal-box select { width: 100%; padding: 10px; background: #1e1f22; border: none; border-radius: 4px; color: #fff; margin-bottom: 10px; font-size: 13px; outline: none; }
  .link-box { background: #1e1f22; padding: 10px; color: #00a8fc; font-size: 12px; word-break: break-all; margin-bottom: 10px; border-radius: 4px; display: block; text-align: center; text-decoration: none; }
  .auth-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 12px; background: #1e1f22; padding: 4px; border-radius: 6px; }
  .auth-tab { padding: 7px; font-size: 12px; font-weight: 600; text-align: center; border-radius: 4px; cursor: pointer; color: var(--text-muted); }
  .auth-tab.active { background: var(--brand); color: #fff; }

  .settings-modal-box { background: #313338; border-radius: 8px; width: 820px; max-width: 100%; height: 590px; max-height: 92vh; display: grid; grid-template-columns: 215px minmax(0, 1fr); overflow: hidden; }
  .settings-nav { background: #2b2d31; padding: 16px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .settings-nav-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); padding: 8px 10px 4px; }
  .settings-nav-btn { padding: 8px 10px; border-radius: 4px; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .settings-nav-btn:hover { background: var(--bg-hover); color: var(--text-normal); }
  .settings-nav-btn.active { background: var(--bg-active); color: #fff; }
  .settings-content { padding: 20px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .settings-pane { display: none; flex-direction: column; gap: 12px; min-width: 0; }
  .settings-pane.active { display: flex; }
  .settings-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 10px; flex-wrap: wrap; }
  .settings-head h3 { font-size: 16px; font-weight: 700; color: #fff; }
  .field-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; display: block; }
  .settings-card { background: #2b2d31; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .settings-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; width: 100%; }
  .settings-card input[type="text"], .settings-card textarea, .settings-card select { width: 100%; min-width: 0; padding: 8px 10px; background: #1e1f22; border: none; border-radius: 4px; color: #fff; font-size: 13px; outline: none; margin: 0; }
  .toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-title { font-size: 13px; font-weight: 500; color: #fff; }
  .cyber-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; cursor: pointer; }
  .cyber-switch input { opacity: 0; width: 0; height: 0; }
  .cyber-slider { position: absolute; inset: 0; background: #80848e; border-radius: 999px; transition: 0.2s; }
  .cyber-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
  .cyber-switch input:checked + .cyber-slider { background: var(--green); }
  .cyber-switch input:checked + .cyber-slider::before { transform: translateX(18px); }
  .cyber-range { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: #1e1f22; border-radius: 999px; outline: none; margin-top: 4px; }
  .cyber-range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--brand); cursor: pointer; }
  .theme-pills-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .theme-pill-btn { background: #1e1f22; border: none; color: #fff; padding: 8px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .theme-dot-swatch { width: 12px; height: 12px; border-radius: 50%; }
  .color-swatches { display: flex; gap: 7px; flex-wrap: wrap; }
  .color-swatch { width: 24px; height: 24px; border-radius: 4px; cursor: pointer; border: 2px solid rgba(255,255,255,0.15); }
  .mic-meter-wrap { width: 100%; height: 8px; background: #1e1f22; border-radius: 999px; overflow: hidden; }
  .mic-meter-bar { height: 100%; width: 0%; background: var(--green); transition: width 0.06s; }
  .discord-profile-card { background: #111214; border-radius: 8px; overflow: hidden; }
  .dp-banner { height: 60px; background: var(--brand); }
  .dp-body { padding: 30px 14px 14px; position: relative; }
  .dp-ava { width: 56px; height: 56px; border-radius: 50%; background: var(--brand); border: 4px solid #111214; position: absolute; top: -28px; left: 14px; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; color: #fff; }
  .dp-nick { font-size: 16px; font-weight: 700; color: #fff; }
  .dp-status { font-size: 12px; color: var(--text-normal); margin-top: 2px; }
  .dp-sec { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); }
  .dp-sec-title { font-size: 10px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px; }
  .dp-bio { font-size: 12px; color: var(--text-normal); white-space: pre-wrap; }
  .dp-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
  .dp-tag { background: #2b2d31; color: var(--text-normal); padding: 2px 8px; border-radius: 4px; font-size: 11px; }
  .status-pill { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 700; }
  .status-pill.on { background: rgba(35,165,90,0.2); color: #23a55a; }
  .status-pill.off { background: rgba(255,255,255,0.06); color: var(--text-muted); }

  .mob-drawer-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 940; }
  .mob-bottom-nav { display: none; height: 52px; background: #1e1f22; border-top: 1px solid var(--border); grid-template-columns: repeat(5, 1fr); align-items: center; flex-shrink: 0; z-index: 960; }
  .mob-nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 100%; color: var(--text-muted); font-size: 10px; font-weight: 600; cursor: pointer; }
  .mob-nav-item.active { color: #fff; }

  @media (max-width: 900px) {
    .streamer-bar, .top-ch-desc, .top-search-box { display: none; }
    .app-layout { flex-direction: column; }
    .workspace { display: flex; flex-direction: column; flex: 1; }
    .main-chat { flex: 1; width: 100%; height: 100%; }
    .mob-top-btn { display: inline-flex; }
    .mob-bottom-nav { display: grid; }
    .servers-rail { position: fixed; top: 0; bottom: 52px; left: 0; width: 72px; z-index: 955; transform: translateX(-340px); transition: transform 0.24s; }
    .channels-panel { position: fixed; top: 0; bottom: 52px; left: 72px; width: calc(100vw - 72px); max-width: 250px; z-index: 955; transform: translateX(-340px); transition: transform 0.24s; }
    body.mob-left-open .servers-rail, body.mob-left-open .channels-panel, body.mob-right-open .right-panel { transform: translateX(0); }
    .right-panel { position: fixed; top: 0; bottom: 52px; right: 0; width: min(86vw, 280px); z-index: 955; transform: translateX(105%); transition: transform 0.24s; }
    body.mob-left-open .mob-drawer-backdrop, body.mob-right-open .mob-drawer-backdrop { display: block; }
    .chat-inp { font-size: 16px; }
    .floating-call-overlay { right: 10px; left: 10px; width: auto; bottom: 60px; }
    .settings-modal-box { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: 92dvh; }
    .settings-nav { flex-direction: row; overflow-x: auto; padding: 8px; }
    .settings-nav-label { display: none; }
    .settings-grid-2, .theme-pills-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="app-layout">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>

    <!-- 1. ЛЕВАЯ ПАНЕЛЬ СЕРВЕРОВ (72px) -->
    <div class="servers-rail">
      <div class="srv-pill-wrap" title="Личные сообщения и профиль" onclick="openSettingsModal('profile')">
        <span class="srv-pill-bar"></span>
        <div class="srv-ico home-ico">💬</div>
      </div>
      <div class="rail-sep"></div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:8px;align-items:center;width:100%;"></div>
      <div class="srv-ico-action" title="Добавить сервер" onclick="openCreateServerModal()">+</div>
      <div class="srv-ico-action neutral" title="Путешествие по серверам" onclick="openInviteModal()">🧭</div>
      <div class="rail-sep"></div>
      <div class="srv-ico-action neutral" title="Настройки и фильтры" onclick="openSettingsModal('voice')">⚙️</div>
    </div>

    <!-- ПРАВАЯ ЧАСТЬ ЭКРАНА -->
    <div class="right-area">
      <!-- Фиолетовый баннер режима стримера сверху как в примере -->
      <div class="streamer-bar" id="streamer-bar">
        <span>Включён режим стримера — некоторая информация скрыта.</span>
        <button class="streamer-btn-disable" onclick="openSettingsModal('safety')">Настроить 18+</button>
        <button class="streamer-btn-hide" onclick="document.getElementById('streamer-bar').classList.add('hidden')">Скрыть</button>
      </div>

      <div class="workspace">
        <!-- 2. КОЛОНКА КАНАЛОВ (240px) -->
        <div class="channels-panel">
          <div class="srv-header" onclick="openInviteModal()" title="Пригласить людей на сервер">
            <div class="srv-title" id="srv-title-label">Sezorgame</div>
            <span class="srv-chevron">⌄</span>
          </div>

          <div class="channels-scroll">
            <div class="boost-box">
              <div class="boost-top">
                <span>Нужно бустов</span>
                <span class="boost-count">Бусты: 0/26 ›</span>
              </div>
              <div class="boost-bar-bg"><div class="boost-bar-fill"></div></div>
            </div>

            <div class="QuickNav-item" onclick="openInviteModal()">
              <span class="QuickNav-ico">👤+</span>
              <span>Пригласить людей</span>
            </div>
            <div class="QuickNav-item" onclick="document.body.classList.toggle('hide-members-panel')">
              <span class="QuickNav-ico">👥</span>
              <span>Участники</span>
            </div>
            <div class="QuickNav-item" onclick="openSettingsModal('appearance')">
              <span class="QuickNav-ico">💎</span>
              <span>Бусты сервера</span>
            </div>

            <div class="sidebar-divider"></div>

            <div class="cat-header">
              <span>Текстовые каналы ⌄</span>
              <button class="cat-add-btn" title="Создать текстовый канал" onclick="openCreateChannelModal('text')">+</button>
            </div>
            <div id="text-channels-list"></div>

            <div class="cat-header" style="margin-top:8px;">
              <span>Голосовые каналы ⌄</span>
              <button class="cat-add-btn" title="Создать голосовой канал" onclick="openCreateChannelModal('voice')">+</button>
            </div>
            <div id="voice-channels-list"></div>
          </div>

          <!-- Нижний бар пользователя (52px) как в примере -->
          <div class="user-bar">
            <div class="user-info" onclick="openSettingsModal('profile')">
              <div class="user-ava-wrap">
                <div class="user-ava" id="user-ava">ГО</div>
                <div class="user-presence-dot" id="user-presence-dot"></div>
              </div>
              <div style="overflow:hidden;min-width:0;">
                <div class="user-name" id="user-name-label">Гость</div>
                <div class="user-sub" id="user-email-label">В сети</div>
              </div>
            </div>
            <div class="user-bar-controls">
              <button class="ub-ctrl-btn" id="ub-mic-btn" title="Микрофон" onclick="if(inVoice)toggleMute();else toggleVoiceCall();">🎙️</button>
              <button class="ub-ctrl-btn" id="ub-deaf-btn" title="Звук" onclick="if(inVoice)toggleDeafen();else openSettingsModal('voice');">🎧</button>
              <button class="ub-ctrl-btn" title="Настройки пользователя" onclick="openSettingsModal('profile')">⚙️</button>
            </div>
          </div>
        </div>

        <!-- 3. ЦЕНТРАЛЬНАЯ КОЛОНКА ЧАТА -->
        <div class="main-chat">
          <div class="chat-topbar">
            <div class="chat-topbar-left">
              <button class="mob-top-btn" onclick="toggleMobileLeft()">☰</button>
              <span class="hash-large">#</span>
              <div class="top-ch-name" id="top-ch-name">общий</div>
              <div class="top-ch-desc" id="top-ch-desc">Общение участников сообщества</div>
            </div>
            <div class="chat-topbar-right">
              <button class="top-ico-btn" title="Уведомления" onclick="openSettingsModal('notifications')">🔔</button>
              <button class="top-ico-btn" title="Закреплённые и ссылка" onclick="openInviteModal()">📌</button>
              <button class="top-ico-btn" title="Показать/скрыть список участников" onclick="if(window.innerWidth<=900)toggleMobileRight();else document.body.classList.toggle('hide-members-panel');">👥</button>
              <div class="top-search-box">
                <input type="text" id="top-search-inp" placeholder="Искать на сервере" readonly onclick="document.getElementById('chat-input').focus()">
                <span>🔍</span>
              </div>
            </div>
          </div>

          <div class="chat-scroll-area" id="chat-scroll">
            <div class="hero-banner">
              <h2>Добро пожаловать на канал!</h2>
              <p id="banner-desc">Это начало истории канала. Включайте голос, камеру, демонстрацию экрана или оверлей.</p>
              <div class="pill-tags-row">
                <span class="pill-tag" onclick="openSettingsModal('profile')">👤 Мой профиль</span>
                <span class="pill-tag" onclick="openSettingsModal('safety')">🛡️ Фильтр 18+</span>
                <span class="pill-tag pink" onclick="openInviteModal()">+ Пригласить людей</span>
              </div>
            </div>

            <div class="date-divider"><span>Сегодня</span></div>
            <div class="messages-container" id="messages-list"></div>

            <div class="voice-panel" id="voice-panel-card">
              <div class="voice-panel-top">
                <div>
                  <div class="voice-label">ГОЛОСОВАЯ СВЯЗЬ И СТРИМ // WEBRTC P2P</div>
                  <div class="voice-title" id="voice-panel-title">Голосовой канал («Ночной эфир»)</div>
                  <div class="voice-sub">Звонок удерживается активным при сворачивании браузера на телефоне и ПК.</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                  <button class="btn-mute" id="mute-btn" style="display:none;" onclick="toggleMute()">🎤 Микр. вкл</button>
                  <button class="btn-mute" id="deafen-btn" style="display:none;" onclick="toggleDeafen()">🎧 Звук вкл</button>
                  <button class="btn-mute" id="cam-btn" onclick="toggleWebcam()">📷 Камера</button>
                  <button class="btn-mute" id="screen-btn" onclick="toggleScreenShare()">🖥️ Экран</button>
                  <button class="btn-mute" id="pip-overlay-btn" onclick="toggleExternalOverlay()">🪟 Оверлей</button>
                  <button class="btn-mute" onclick="openSettingsModal('voice')">⚙️</button>
                  <button class="btn-cyan" id="connect-voice-btn" onclick="toggleVoiceCall()">Подключиться</button>
                </div>
              </div>
              <div class="voice-active-area" id="voice-active-area">
                <div class="voice-user-card"><span class="vu-dot"></span><span id="voice-my-name" style="font-size:12px;font-weight:700;">Гость (Вы)</span></div>
                <div class="screen-grid" id="screen-grid"></div>
                <div id="audio-box"></div>
              </div>
            </div>
          </div>

          <div class="chat-bottom">
            <form class="input-row" onsubmit="sendChatMessage(event)">
              <button type="button" class="input-plus-btn" title="Пригласить или вставить медиа-ссылку" onclick="openInviteModal()">+</button>
              <input type="text" id="chat-input" class="chat-inp" placeholder="Написать в #общий" autocomplete="off" maxlength="1000">
              <div class="input-right-icons">
                <span title="Голосовой канал" onclick="toggleVoiceCall()">🎙️</span>
                <span title="Оверлей поверх окон" onclick="toggleExternalOverlay()">🪟</span>
                <span title="Отправить сообщение" onclick="sendChatMessage(event)">➤</span>
              </div>
            </form>
          </div>
        </div>

        <!-- 4. ПРАВАЯ КОЛОНКА УЧАСТНИКОВ (240px) -->
        <div class="right-panel">
          <div class="right-sec-title">В сети — <span id="online-count">1</span></div>
          <div id="online-users-box"></div>

          <div class="right-sec-title" id="offline-sec-header">Не в сети — <span id="total-members-count">0</span></div>
          <div id="offline-users-box"></div>

          <div class="sidebar-divider"></div>
          <div class="right-sec-title">Друзья — <span id="friends-count">0</span></div>
          <div id="requests-box"></div>
          <div id="friends-box"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Плавающий виджет звонка -->
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

  <!-- Мобильное нижнее меню -->
  <div class="mob-bottom-nav" id="mob-bottom-nav">
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()"><span class="ico">☰</span><span>Каналы</span></div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span class="ico">💬</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="scrollToVoiceMobile()"><span class="ico">🔊</span><span>Голос</span></div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()"><span class="ico">👥</span><span>Участники</span></div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('profile')"><span class="ico">👤</span><span>Профиль</span></div>
  </div>

  <!-- Модальное окно настроек -->
  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Настройки пользователя</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">👤 Мой профиль</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🔑 Учётная запись</div>
        <div class="settings-nav-label">Безопасность</div>
        <div class="settings-nav-btn" data-pane="safety" onclick="switchSettingsPane('safety')">🛡️ Фильтр контента</div>
        <div class="settings-nav-label">Настройки приложения</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и видео</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;"><button class="btn-login-mini" style="width:100%;" onclick="closeSettingsModal()">✕ Закрыть (ESC)</button></div>
      </div>
      <div class="settings-content">
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head"><h3>Мой профиль</h3><button class="btn-cyan" onclick="saveProfileSettings()">Сохранить изменения</button></div>
          <div class="discord-profile-card"><div class="dp-banner" id="preview-banner"></div><div class="dp-body"><div class="dp-ava" id="preview-ava">ГО</div><div class="dp-nick" id="preview-nick">Гость</div><div class="dp-status" id="preview-status"></div><div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ</div><div class="dp-bio" id="preview-bio"></div></div><div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="preview-tags"></div></div></div></div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <div><label class="field-label">Отображаемое имя</label><input type="text" id="prof-nick-inp" maxlength="24" oninput="updateProfilePreview()"></div>
              <div><label class="field-label">Статус</label><select id="prof-presence-sel" onchange="updateProfilePreview()"><option value="online">🟢 В сети</option><option value="idle">🌙 Не активен</option><option value="dnd">⛔ Не беспокоить</option><option value="invisible">⚪ Невидимка</option></select></div>
            </div>
            <div><label class="field-label">Пользовательский статус</label><input type="text" id="prof-status-inp" maxlength="60" oninput="updateProfilePreview()"></div>
            <div><label class="field-label">Обо мне</label><textarea id="prof-bio-inp" rows="2" maxlength="220" oninput="updateProfilePreview()"></textarea></div>
            <div><label class="field-label">Интересы (через запятую)</label><input type="text" id="prof-interests-inp" maxlength="160" oninput="updateProfilePreview()"></div>
            <div class="settings-grid-2">
              <div><label class="field-label">Цвет баннера</label><div class="color-swatches"><div class="color-swatch" style="background:#5865f2;" onclick="selectBannerColor('#5865f2')"></div><div class="color-swatch" style="background:#eb459e;" onclick="selectBannerColor('#eb459e')"></div><div class="color-swatch" style="background:#23a55a;" onclick="selectBannerColor('#23a55a')"></div><div class="color-swatch" style="background:#f0b232;" onclick="selectBannerColor('#f0b232')"></div><div class="color-swatch" style="background:#f23f43;" onclick="selectBannerColor('#f23f43')"></div></div></div>
              <div><label class="field-label">Цвет аватара</label><div class="color-swatches"><div class="color-swatch" style="background:#5865f2;" onclick="selectAvatarColor('#5865f2')"></div><div class="color-swatch" style="background:#23a55a;" onclick="selectAvatarColor('#23a55a')"></div><div class="color-swatch" style="background:#eb459e;" onclick="selectAvatarColor('#eb459e')"></div><div class="color-swatch" style="background:#f23f43;" onclick="selectAvatarColor('#f23f43')"></div><div class="color-swatch" style="background:#f0b232;" onclick="selectAvatarColor('#f0b232')"></div></div></div>
            </div>
          </div>
        </div>
        <div class="settings-pane" id="pane-safety">
          <div class="settings-head"><h3>🛡️ Фильтр контента 18+ и режим стримера</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">🔞 Блокировать откровенный контент (18+)</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-sexual" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🩸 Блокировать шок-контент и насилие</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-gore" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🔗 Проверять мои исходящие сообщения</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-outgoing" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Действие при обнаружении</label><select id="sel-filter-action" onchange="saveSafetySettings()"><option value="block">🚫 Блокировать сообщение</option><option value="blur">👁️ Скрывать под спойлером</option></select></div>
            <div><label class="field-label">Собственный фильтр слов (через запятую)</label><input type="text" id="inp-custom-blocklist" oninput="saveSafetySettings()"></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head"><h3>Голос, видео и игровой оверлей</h3><button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 Обновить устройства</button></div>
          <div class="settings-card">
            <div class="settings-grid-2"><div><label class="field-label">Устройство ввода</label><select id="set-mic-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Устройство вывода</label><select id="set-spk-select" onchange="saveAudioVideoSettings()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Громкость микрофона: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость звука: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Проверка микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ Давайте проверим</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Камера</label><select id="set-cam-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Разрешение камеры</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
            <div class="toggle-row"><div><div class="toggle-title">🪟 Показывать плавающий виджет звонка</div></div><label class="cyber-switch"><input type="checkbox" id="chk-auto-overlay" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Шумоподавление</div></div><label class="cyber-switch"><input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Эхоподавление</div></div><label class="cyber-switch"><input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Авторегулировка усиления</div></div><label class="cyber-switch"><input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head"><h3>Внешний вид</h3></div>
          <div class="settings-card">
            <div class="theme-pills-grid">
              <button class="theme-pill-btn" onclick="setAccentTheme('#5865f2','#5865f2')"><span class="theme-dot-swatch" style="background:#5865f2;"></span><span>Discord Blurple</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#14b8a6','#2dd4bf')"><span class="theme-dot-swatch" style="background:#2dd4bf;"></span><span>Кибер Бирюза</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#db2777','#f43f5e')"><span class="theme-dot-swatch" style="background:#f43f5e;"></span><span>Розовый Неон</span></button>
              <button class="theme-pill-btn" onclick="setAccentTheme('#d97706','#fbbf24')"><span class="theme-dot-swatch" style="background:#fbbf24;"></span><span>Золотой</span></button>
            </div>
            <div class="toggle-row"><div><div class="toggle-title">Компактный режим сообщений</div></div><label class="cyber-switch"><input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Размер шрифта чата</label><select id="sel-font-size" onchange="applyAppearanceSettings()"><option value="13px">13px</option><option value="14px" selected>14px (Стандарт)</option><option value="16px">16px</option></select></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head"><h3>Уведомления</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">Звук при новом сообщении</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Звук подключения к голосовому каналу</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>
        <div class="settings-pane" id="pane-account">
          <div class="settings-head"><h3>Учётная запись</h3></div>
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

  <!-- Карточка участника -->
  <div class="modal-backdrop" id="view-profile-modal" onclick="if(event.target===this)closeViewProfileModal()">
    <div class="modal-box" style="padding:0;width:340px;"><div class="discord-profile-card"><div class="dp-banner" id="vp-banner"></div><div class="dp-body"><div class="dp-ava" id="vp-ava">УЧ</div><div style="display:flex;justify-content:space-between;align-items:center;"><div class="dp-nick" id="vp-nick"></div><span class="status-pill on" id="vp-online-pill">В сети</span></div><div class="dp-status" id="vp-status"></div><div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ</div><div class="dp-bio" id="vp-bio"></div></div><div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="vp-tags"></div></div><div style="margin-top:14px;display:flex;gap:8px;"><button class="btn-cyan" id="vp-friend-btn" style="flex:1;">Добавить в друзья</button><button class="btn-login-mini" onclick="closeViewProfileModal()">Закрыть</button></div></div></div></div>
  </div>

  <!-- Модальное окно приглашения -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box"><h3 style="color:#fff;font-size:16px;margin-bottom:8px;">Пригласить друзей на сервер</h3><a class="link-box" id="public-invite-url" href="#" target="_blank"></a><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button><button class="btn-login-mini" style="width:100%;" onclick="closeInviteModal()">Закрыть</button></div>
  </div>

  <!-- Модальное окно авторизации -->
  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="color:#fff;font-size:16px;">Вход в аккаунт</h3><span style="font-size:10px;background:var(--brand);color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;">СИГНАЛ ID</span></div>
      <div class="auth-tabs"><div class="auth-tab active" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ Через Telegram</div><div class="auth-tab" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 По паролю</div></div>
      <input type="text" id="nick-inp" placeholder="Ваш никнейм" maxlength="24">
      <div id="auth-tg-panel">
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;" id="tg-status-hint">Откройте бота и нажмите /start — вход выполнится автоматически:</p>
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

  <!-- Модальное окно создания сервера -->
  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">
    <div class="modal-box"><h3 style="color:#fff;font-size:16px;margin-bottom:8px;">Создать свой сервер</h3><input type="text" id="new-srv-name" placeholder="Название сервера (например: Sezorgame)" maxlength="28"><input type="text" id="new-srv-desc" placeholder="Описание сообщества" maxlength="80"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">Создать</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateServerModal()">Отмена</button></div>
  </div>

  <!-- Модальное окно создания канала -->
  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannelModal()">
    <div class="modal-box"><h3 id="create-ch-title" style="color:#fff;font-size:16px;margin-bottom:6px;">Создать канал</h3><p id="create-ch-sub" style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"></p><input type="text" id="new-ch-name" placeholder="новый-канал" maxlength="28"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">Создать канал</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateChannelModal()">Отмена</button></div>
  </div>

<script>
  const params = new URLSearchParams(window.location.search);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

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
    const open = document.body.classList.contains('mob-left-open');
    document.body.classList.remove('mob-right-open');
    if (open) { document.body.classList.remove('mob-left-open'); setMobActiveTab('mob-tab-chat'); }
    else { document.body.classList.add('mob-left-open'); setMobActiveTab('mob-tab-left'); }
  }
  function toggleMobileRight() {
    const open = document.body.classList.contains('mob-right-open');
    document.body.classList.remove('mob-left-open');
    if (open) { document.body.classList.remove('mob-right-open'); setMobActiveTab('mob-tab-chat'); }
    else { document.body.classList.add('mob-right-open'); setMobActiveTab('mob-tab-right'); }
  }
  function scrollToVoiceMobile() {
    closeMobileDrawers(); setMobActiveTab('mob-tab-voice');
    const vp = document.getElementById('voice-panel-card');
    if (vp && vp.scrollIntoView) vp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setPersistCookie(n, v) {
    try { document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=31536000; SameSite=Lax'; } catch (e) {}
  }
  function getPersistCookie(n) {
    try { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }

  let myUid = '';
  try { myUid = localStorage.getItem('cyber_uid') || ''; } catch (e) {}
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) myUid = getPersistCookie('cyber_uid');
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
    myUid = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  try { localStorage.setItem('cyber_uid', myUid); } catch (e) {}
  setPersistCookie('cyber_uid', myUid);

  let currentRoom = params.get('room') || params.get('server');
  if (!currentRoom) { try { currentRoom = localStorage.getItem('cyber_last_room'); } catch (e) {} }
  currentRoom = currentRoom || 'cy-4371';
  try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}

  let currentChannel = params.get('channel') || 'общий', currentVoiceChannel = 'Ночной эфир';
  let myNick = 'Гость_' + Math.floor(100 + Math.random() * 899);
  try { const sn = localStorage.getItem('cyber_nick') || getPersistCookie('cyber_nick'); if (sn) myNick = sn; } catch (e) {}

  let myVerified = false;
  try { myVerified = localStorage.getItem('cyber_verified') === '1' || getPersistCookie('cyber_verified') === '1'; } catch (e) {}
  let authLocked = !myVerified;

  function updateBrowserUrl() {
    try { window.history.replaceState({}, '', window.location.pathname + '?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel)); } catch (e) {}
  }

  let myProfile = { bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#5865f2', avatarColor: '#5865f2' };
  try { myProfile = Object.assign(myProfile, JSON.parse(localStorage.getItem('cyber_profile') || '{}')); } catch (e) {}

  let appSettings = { micDeviceId: '', spkDeviceId: '', camDeviceId: '', micVolume: 100, outVolume: 100, camRes: '720', autoOverlay: true, noiseSuppression: true, echoCancellation: true, autoGainControl: true, compactChat: false, fontSize: '14px', soundMsg: true, soundVoice: true, filterSexual: true, filterGore: true, filterOutgoing: true, filterAction: 'block', customBlockedWords: '' };
  try { appSettings = Object.assign(appSettings, JSON.parse(localStorage.getItem('cyber_settings') || '{}')); } catch (e) {}

  let localVault = { knownUsers: {}, friends: [], incoming: [], outgoing: [], servers: [], messages: {} };
  try {
    const rv = JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}');
    if (rv && typeof rv === 'object') localVault = Object.assign(localVault, rv);
  } catch (e) {}

  function rememberUserInVault(u) {
    if (!u || !u.pid || u.nick === '?') return;
    const prev = localVault.knownUsers[u.pid] || {};
    localVault.knownUsers[u.pid] = {
      pid: u.pid, nick: u.nick || prev.nick || 'Участник',
      bio: u.bio !== undefined ? u.bio : (prev.bio || ''),
      interests: u.interests !== undefined ? u.interests : (prev.interests || ''),
      customStatus: u.customStatus !== undefined ? u.customStatus : (prev.customStatus || ''),
      presence: u.presence || prev.presence || 'online',
      bannerColor: u.bannerColor || prev.bannerColor || '#5865f2',
      avatarColor: u.avatarColor || prev.avatarColor || '#5865f2'
    };
  }

  function saveLocalVault() {
    try {
      if (Array.isArray(social.friends) && social.friends.length > 0) {
        localVault.friends = social.friends.map(function (f) { rememberUserInVault(f); return f.pid; });
      }
      if (Array.isArray(social.incoming)) {
        localVault.incoming = social.incoming.map(function (i) { rememberUserInVault(i); return i.pid; });
      }
      if (Array.isArray(social.outgoing)) localVault.outgoing = social.outgoing.slice();
      if (Array.isArray(lastMembers)) lastMembers.forEach(rememberUserInVault);
      if (Array.isArray(serversList) && serversList.length > 0) localVault.servers = serversList.slice(0, 40);
      if (currentRoom && roomMessagesCache) {
        if (!localVault.messages) localVault.messages = {};
        const rc = {};
        Object.keys(roomMessagesCache).forEach(function (ch) {
          if (Array.isArray(roomMessagesCache[ch]) && roomMessagesCache[ch].length) rc[ch] = roomMessagesCache[ch].slice(-80);
        });
        localVault.messages[currentRoom] = rc;
      }
      localStorage.setItem('cyber_vault_v1', JSON.stringify(localVault));
    } catch (e) {}
  }

  async function pushLocalVaultToServer() {
    try {
      const knownArr = Object.values(localVault.knownUsers || {});
      await fetch('/api/vault-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: myUid, nick: myNick, profile: myProfile,
          friends: localVault.friends || [], incoming: localVault.incoming || [], outgoing: localVault.outgoing || [],
          knownUsers: knownArr, servers: localVault.servers || [], room: currentRoom,
          roomMembersPids: knownArr.map(function (u) { return u.pid; }), messages: localVault.messages || {}
        })
      });
    } catch (e) {}
  }

  const CLIENT_SEXUAL_RX = [/порн/i, /секс/i, /эротик/i, /интим/i, /хентай/i, /минет/i, /трах/i, /шлюх/i, /проститут/i, /сиськ/i, /вагин/i, /член/i, /голая/i, /голые/i, /обнажен/i, /porn/i, /nsfw/i, /xxx/i, /hentai/i, /onlyfans/i, /xvideos/i, /pornhub/i, /rule34/i, /nude/i, /boobs/i, /pussy/i, /dick/i];
  const CLIENT_GORE_RX = [/расчлен/i, /кишки/i, /труп/i, /казнь/i, /пытк/i, /убийств/i, /самоубийств/i, /суицид/i, /резня/i, /кровопролит/i, /увечь/i, /жесть/i, /насили/i, /террор/i, /gore/i, /liveleak/i, /bestgore/i, /behead/i, /torture/i, /suicide/i, /murder/i];
  const IMAGE_URL_RX = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'<>]*)?/i;
  const ANY_URL_RX = /(https?:\/\/[^\s"'<>]+)/g;

  function checkContentViolation(text, serverFlags) {
    const s = String(text || ''), reasons = [];
    if (appSettings.filterSexual && ((serverFlags && serverFlags.sexual) || CLIENT_SEXUAL_RX.some(function (rx) { return rx.test(s); }))) reasons.push('Сексуальный контент 18+');
    if (appSettings.filterGore && ((serverFlags && serverFlags.gore) || CLIENT_GORE_RX.some(function (rx) { return rx.test(s); }))) reasons.push('Насилие / Шокирующий контент');
    if (appSettings.customBlockedWords) {
      const list = String(appSettings.customBlockedWords).split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
      const lower = s.toLowerCase();
      if (list.some(function (w) { return lower.includes(w); })) reasons.push('Чёрный список слов');
    }
    return reasons;
  }

  function toggleSpoiler(w) { if (w) w.classList.toggle('revealed'); }

  let clientId = Math.random().toString(36).substring(2, 10), evtSource = null, tgSessionToken = '', tgBotUsername = '', tgPollTimer = null;
  let roomMessagesCache = {}, unreadByChannel = {}, cachedMessages = [], profileSyncTimer = null;
  let serversList = [], currentServerMeta = { id: currentRoom, name: 'Ночной клуб', icon: 'НК', desc: 'Игры, идеи и разговоры после полуночи', textChannels: ['игровая-комната', 'общий', 'знакомства', 'музыка'], voiceChannels: ['Ночной эфир'] };
  let rawMicStream = null, localStream = null, micGainNode = null, audioCtx = null;
  let screenStream = null, webcamStream = null, peer = null, myPeerId = null;
  let inVoice = false, inScreen = false, inWebcam = false, isMuted = false, isDeafened = false;
  let screenCalls = {}, camCalls = {}, myPid = null, lastMembers = [], social = { friends: [], incoming: [], outgoing: [], servers: [] };
  let pendingChannelType = 'text', micTestStream = null, micTestTimer = null;

  let callStartTime = 0, voiceLockRelease = null, wakeLockSentinel = null, keepAliveAudioEl = null, bgWorker = null;
  let pipCanvas = null, pipCtx = null, canvasPipVideo = null, popupOverlayWin = null;

  const SILENT_WAV_BASE64 = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  let subsonicWavUrl = null;

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function playUiBeep(freq, dur) { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(), o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq || 580; g.gain.value = 0.06; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (dur || 0.08)); } catch (e) {} }
  function formatCallTime(sec) { return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }

  function getSubsonicWavUrl() {
    if (subsonicWavUrl) return subsonicWavUrl;
    try {
      const sr = 8000, dur = 2, num = sr * dur, buf = new ArrayBuffer(44 + num * 2), view = new DataView(buf);
      const wr = function (o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
      wr(0, 'RIFF'); view.setUint32(4, 36 + num * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); wr(36, 'data'); view.setUint32(40, num * 2, true);
      for (let i = 0; i < num; i++) view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 20 * (i / sr)) * 45, true);
      subsonicWavUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      return subsonicWavUrl;
    } catch (e) {
      return SILENT_WAV_BASE64;
    }
  }

  function ensurePipCanvasAndVideo() {
    if (!pipCanvas) { pipCanvas = document.createElement('canvas'); pipCanvas.width = 460; pipCanvas.height = 260; pipCtx = pipCanvas.getContext('2d', { alpha: false }); drawSystemPipOverlayFrame(); }
    if (!canvasPipVideo) {
      canvasPipVideo = document.createElement('video'); canvasPipVideo.muted = true; canvasPipVideo.autoplay = true; canvasPipVideo.playsInline = true; canvasPipVideo.autoPictureInPicture = true;
      canvasPipVideo.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:1;';
      document.body.appendChild(canvasPipVideo);
      try { canvasPipVideo.srcObject = pipCanvas.captureStream(25); canvasPipVideo.play().catch(function () {}); } catch (e) {}
      canvasPipVideo.addEventListener('enterpictureinpicture', function () {
        const b1 = document.getElementById('pip-overlay-btn'), b2 = document.getElementById('fco-pip-btn');
        if (b1) b1.classList.add('active-cam'); if (b2) b2.classList.add('active-pip');
      });
      canvasPipVideo.addEventListener('leavepictureinpicture', function () {
        const b1 = document.getElementById('pip-overlay-btn'), b2 = document.getElementById('fco-pip-btn');
        if (b1) b1.classList.remove('active-cam'); if (b2) b2.classList.remove('active-pip');
      });
    } else if (canvasPipVideo.paused) { canvasPipVideo.play().catch(function () {}); }
  }

  document.addEventListener('pointerdown', function () { ensurePipCanvasAndVideo(); }, { once: true });

  function drawSystemPipOverlayFrame() {
    if (!pipCanvas || !pipCtx) return;
    const ctx = pipCtx, w = pipCanvas.width, h = pipCanvas.height;
    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, w, h);
    const activeVideoEl = document.querySelector('#screen-grid .screen-card:not(.nsfw-masked) video');
    if (activeVideoEl && activeVideoEl.readyState >= 2) {
      try { ctx.drawImage(activeVideoEl, 0, 38, w, h - 38); } catch (e) {}
      ctx.fillStyle = 'rgba(17, 18, 20, 0.88)'; ctx.fillRect(0, 0, w, 38);
    } else {
      ctx.fillStyle = '#2b2d31';
      ctx.fillRect(14, 48, w - 28, 34);
      ctx.fillStyle = isMuted ? '#f23f43' : '#23a55a'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText((isMuted ? '🔇 Микрофон выкл' : '🎤 Микрофон вкл') + (isDeafened ? ' • 🔇 Звук выкл' : ' • 🎧 Звук вкл'), 26, 70);
      ctx.fillStyle = '#949ba4'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('УЧАСТНИКИ В ГОЛОСОВОМ КАНАЛЕ:', 16, 104);
      getVoiceChannelMembers().slice(0, 5).forEach(function (u, i) {
        const y = 128 + i * 25; ctx.fillStyle = '#2b2d31'; ctx.fillRect(14, y - 16, w - 28, 22);
        ctx.fillStyle = '#23a55a'; ctx.beginPath(); ctx.arc(26, y - 5, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 13px sans-serif';
        ctx.fillText(u.nick + (u.pid === myPid ? ' (Вы)' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''), 38, y);
      });
    }
    ctx.fillStyle = '#5865f2'; ctx.fillRect(14, 9, 72, 20); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('СИГНАЛ', 23, 23);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('🔊 ' + String(currentVoiceChannel || 'Эфир').slice(0, 20), 96, 24);
    ctx.fillStyle = '#dbdee1'; ctx.font = 'bold 13px monospace'; ctx.fillText(formatCallTime(callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0), w - 58, 24);
  }

  function openStandalonePopupOverlay() {
    if (popupOverlayWin && !popupOverlayWin.closed) { popupOverlayWin.focus(); return; }
    popupOverlayWin = window.open('', 'SignalCallOverlay', 'width=340,height=250,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!popupOverlayWin) return;
    const doc = popupOverlayWin.document; doc.open();
    doc.write('<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>СИГНАЛ — Оверлей</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif;}body{background:#1e1f22;color:#f2f3f5;padding:12px;height:100vh;display:flex;flex-direction:column;justify-content:space-between;}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:8px;}.badge{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#23a55a;}.dot{width:8px;height:8px;border-radius:50%;background:#23a55a;}.timer{font-family:monospace;font-size:11px;color:#dbdee1;}.peers{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;overflow-y:auto;flex:1;align-content:flex-start;}.chip{display:inline-flex;align-items:center;gap:6px;background:#2b2d31;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;color:#fff;}.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);}button{background:#2b2d31;border:none;color:#fff;padding:8px 6px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;}button.off{background:#f23f43;}button.hang{background:#f23f43;color:#fff;}</style></head><body><div class="top"><div class="badge"><span class="dot"></span><span id="pop-ch"></span></div><span class="timer" id="pop-timer">00:00</span></div><div class="peers" id="pop-peers"></div><div class="btns"><button id="pop-mute"></button><button id="pop-deaf"></button><button class="hang" id="pop-hang">🛑 Выход</button></div></body></html>');
    doc.close();
    doc.getElementById('pop-mute').onclick = function () { toggleMute(); };
    doc.getElementById('pop-deaf').onclick = function () { toggleDeafen(); };
    doc.getElementById('pop-hang').onclick = function () { toggleVoiceCall(); popupOverlayWin.close(); };
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
      getVoiceChannelMembers().forEach(function (u) { const c = doc.createElement('div'); c.className = 'chip'; c.textContent = '🟢 ' + u.nick; pb.appendChild(c); });
    } catch (e) {}
  }

  function toggleExternalOverlay() {
    if (document.pictureInPictureElement || (popupOverlayWin && !popupOverlayWin.closed)) { closeExternalOverlay(); return; }
    ensurePipCanvasAndVideo(); drawSystemPipOverlayFrame();
    if (canvasPipVideo && typeof canvasPipVideo.requestPictureInPicture === 'function') {
      canvasPipVideo.requestPictureInPicture().then(function () {
        const b1 = document.getElementById('pip-overlay-btn'), b2 = document.getElementById('fco-pip-btn');
        if (b1) b1.classList.add('active-cam'); if (b2) b2.classList.add('active-pip');
      }).catch(function () {
        canvasPipVideo.play().then(function () { return canvasPipVideo.requestPictureInPicture(); }).catch(function () { openStandalonePopupOverlay(); });
      });
    } else { openStandalonePopupOverlay(); }
    if (!inVoice) ensureVoiceConnected();
  }

  function closeExternalOverlay() {
    if (document.pictureInPictureElement) try { document.exitPictureInPicture(); } catch (e) {}
    if (popupOverlayWin && !popupOverlayWin.closed) try { popupOverlayWin.close(); } catch (e) {}
    popupOverlayWin = null;
    const b1 = document.getElementById('pip-overlay-btn'), b2 = document.getElementById('fco-pip-btn');
    if (b1) b1.classList.remove('active-cam'); if (b2) b2.classList.remove('active-pip');
  }

  function startBackgroundCallPersistence() {
    if (navigator.locks && navigator.locks.request && !voiceLockRelease) {
      navigator.locks.request('signal_active_voice_call', { mode: 'exclusive' }, function () {
        return new Promise(function (r) { voiceLockRelease = r; });
      }).catch(function () {});
    }
    if (navigator.wakeLock && navigator.wakeLock.request && !wakeLockSentinel) {
      navigator.wakeLock.request('screen').then(function (s) { wakeLockSentinel = s; }).catch(function () {});
    }
    try {
      if (!keepAliveAudioEl) {
        keepAliveAudioEl = document.createElement('audio');
        keepAliveAudioEl.setAttribute('playsinline', '');
        keepAliveAudioEl.setAttribute('webkit-playsinline', '');
        keepAliveAudioEl.loop = true;
        keepAliveAudioEl.volume = 0.02;
        document.body.appendChild(keepAliveAudioEl);
      }
      keepAliveAudioEl.src = getSubsonicWavUrl();
      keepAliveAudioEl.play().catch(function () {
        keepAliveAudioEl.src = SILENT_WAV_BASE64;
        keepAliveAudioEl.play().catch(function () {});
      });
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
      bgWorker.onmessage = function () {
        if (!inVoice) return;
        cnt++;
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const tStr = formatCallTime(elapsed);
        const tEl = document.getElementById('fco-timer-label'); if (tEl) tEl.textContent = tStr;
        if (popupOverlayWin && !popupOverlayWin.closed) {
          try { popupOverlayWin.document.getElementById('pop-timer').textContent = tStr; } catch (e) {}
        }
        if (cnt % 3 === 0) {
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
          if (keepAliveAudioEl && keepAliveAudioEl.paused) keepAliveAudioEl.play().catch(function () {});
          document.querySelectorAll('#audio-box audio').forEach(function (a) { if (a.paused && !isDeafened) a.play().catch(function () {}); });
          if (document.hidden) fetch('/healthz?t=' + Date.now(), { keepalive: true }).catch(function () {});
        }
        drawSystemPipOverlayFrame();
      };
    } catch (e) {}

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '🔊 В эфире: ' + currentVoiceChannel,
          artist: 'СИГНАЛ // ' + (currentServerMeta.name || currentRoom),
          album: 'Активный звонок'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', function () {
          if (isMuted) toggleMute();
          if (keepAliveAudioEl && keepAliveAudioEl.paused) keepAliveAudioEl.play().catch(function () {});
        });
        navigator.mediaSession.setActionHandler('pause', function () {
          toggleMute();
          if (keepAliveAudioEl && keepAliveAudioEl.paused) keepAliveAudioEl.play().catch(function () {});
          navigator.mediaSession.playbackState = 'playing';
        });
        navigator.mediaSession.setActionHandler('hangup', function () {
          if (inVoice) toggleVoiceCall();
        });
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

  document.addEventListener('visibilitychange', function () {
    if (!inVoice) return;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    document.querySelectorAll('#audio-box audio').forEach(function (a) { if (a.paused && !isDeafened) a.play().catch(function () {}); });
    if (keepAliveAudioEl && keepAliveAudioEl.paused) keepAliveAudioEl.play().catch(function () {});
    if (canvasPipVideo && canvasPipVideo.paused) canvasPipVideo.play().catch(function () {});
    drawSystemPipOverlayFrame();
  });

  function getVoiceChannelMembers() {
    const uList = (lastMembers || []).filter(function (u) { return u.online && u.inVoice && (!u.voiceChannel || u.voiceChannel === currentVoiceChannel); });
    if (!uList.some(function (u) { return u.pid === myPid; }) && inVoice) {
      uList.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen });
    }
    return uList;
  }

  function updateFloatingOverlayUI() {
    const box = document.getElementById('floating-call-overlay'); if (!box) return;
    if (!inVoice || appSettings.autoOverlay === false) box.classList.remove('show'); else box.classList.add('show');
    document.getElementById('fco-channel-label').textContent = '🔊 ' + currentVoiceChannel;
    document.getElementById('fco-mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('fco-deaf-btn').textContent = isDeafened ? '🔇 Глух' : '🎧 Вкл';
    const ubMic = document.getElementById('ub-mic-btn'), ubDeaf = document.getElementById('ub-deaf-btn');
    if (ubMic) ubMic.classList.toggle('off', isMuted);
    if (ubDeaf) ubDeaf.classList.toggle('off', isDeafened);
    const pb = document.getElementById('fco-peers-box'); pb.innerHTML = '';
    getVoiceChannelMembers().forEach(function (u) {
      const c = el('div', 'fco-peer-chip'); c.appendChild(el('span', 'fco-pulse')); c.appendChild(el('span', '', u.nick)); pb.appendChild(c);
    });
    drawSystemPipOverlayFrame();
    renderPopupOverlayContent();
  }

  (function () {
    const card = document.getElementById('floating-call-overlay'), handle = document.getElementById('fco-drag-handle');
    if (!card || !handle) return;
    let drag = false, sx = 0, sy = 0, or = 18, ob = 72;
    const start = function (x, y) { drag = true; sx = x; sy = y; const rect = card.getBoundingClientRect(); or = window.innerWidth - rect.right; ob = window.innerHeight - rect.bottom; };
    const move = function (x, y) { if (!drag) return; card.style.left = 'auto'; card.style.right = Math.max(8, Math.min(window.innerWidth - 120, or - (x - sx))) + 'px'; card.style.bottom = Math.max(8, Math.min(window.innerHeight - 80, ob - (y - sy))) + 'px'; };
    const end = function () { drag = false; };
    handle.addEventListener('mousedown', function (e) { start(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); }); window.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', function (e) { if (e.touches[0]) start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchmove', function (e) { if (drag && e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchend', end);
  })();

  function switchAuthTab(m) {
    const isTg = m === 'tg';
    document.getElementById('tab-tg-btn').classList.toggle('active', isTg);
    document.getElementById('tab-pass-btn').classList.toggle('active', !isTg);
    document.getElementById('auth-tg-panel').style.display = isTg ? 'block' : 'none';
    document.getElementById('auth-pass-panel').style.display = isTg ? 'none' : 'block';
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    const ava = document.getElementById('user-ava'); ava.textContent = myNick.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#5865f2';
    document.getElementById('user-presence-dot').className = 'user-presence-dot ' + (myProfile.presence || 'online');
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    const stViol = checkContentViolation(myProfile.customStatus || '');
    const sStat = stViol.length ? '' : myProfile.customStatus;
    if (sStat) { document.getElementById('user-email-label').textContent = sStat; }
    else { document.getElementById('user-email-label').textContent = 'В сети'; }
  }

  function renderServersRail() {
    const box = document.getElementById('servers-list-box'); box.innerHTML = '';
    (serversList.length ? serversList : [currentServerMeta]).forEach(function (srv) {
      const wrap = el('div', 'srv-pill-wrap' + (srv.id === currentRoom ? ' active' : ''));
      wrap.appendChild(el('span', 'srv-pill-bar'));
      const b = el('div', 'srv-ico', srv.icon || srv.name.slice(0, 2));
      b.title = srv.name;
      wrap.onclick = function () { if (srv.id !== currentRoom) switchServer(srv.id); };
      wrap.appendChild(b);
      box.appendChild(wrap);
    });
  }

  function renderServerChannels() {
    const sName = currentServerMeta.name || currentRoom;
    document.getElementById('srv-title-label').textContent = sName;
    const searchInp = document.getElementById('top-search-inp');
    if (searchInp) searchInp.placeholder = 'Искать «' + sName + '»';

    const tList = currentServerMeta.textChannels || ['общий'];
    if (!tList.includes(currentChannel)) currentChannel = tList[0] || 'общий';
    const vList = currentServerMeta.voiceChannels || ['Ночной эфир'];
    if (!vList.includes(currentVoiceChannel)) currentVoiceChannel = vList[0] || 'Ночной эфир';

    const tBox = document.getElementById('text-channels-list'); tBox.innerHTML = '';
    tList.forEach(function (ch) {
      const row = el('div', 'ch-btn' + (ch === currentChannel ? ' active' : '')); row.setAttribute('data-ch', ch);
      const left = el('div', 'ch-left');
      left.appendChild(el('span', 'ch-hash', '#'));
      left.appendChild(el('span', 'ch-name-txt', ch));
      row.appendChild(left);

      const unread = unreadByChannel[ch] || 0;
      if (unread > 0 && ch !== currentChannel) {
        row.appendChild(el('span', 'ch-unread-badge', String(unread)));
      } else {
        const ri = el('div', 'ch-right-icons');
        ri.innerHTML = '<span>👤+</span><span>⚙️</span>';
        row.appendChild(ri);
      }
      row.onclick = function () { setChannel(ch); };
      tBox.appendChild(row);
    });

    const vBox = document.getElementById('voice-channels-list'); vBox.innerHTML = '';
    vList.forEach(function (vch) {
      const isAct = inVoice && currentVoiceChannel === vch;
      const row = el('div', 'voice-ch-box' + (isAct ? ' active' : ''));
      const left = el('div', 'ch-left');
      left.appendChild(el('span', 'ch-hash', '🔊'));
      left.appendChild(el('span', 'ch-name-txt', vch));
      row.appendChild(left);
      row.appendChild(el('span', 'off-badge' + (isAct ? ' on' : ''), isAct ? 'LIVE' : ''));
      row.onclick = function () { selectVoiceChannel(vch); };
      vBox.appendChild(row);
    });
    applyChannelUI(currentChannel); updateVoicePanelUI();
  }

  function applyChannelUI(ch) {
    const sName = currentServerMeta.name || 'Ночной клуб';
    document.getElementById('top-ch-name').textContent = ch;
    document.getElementById('top-ch-desc').textContent = 'Канал сообщества «' + sName + '»';
    document.getElementById('banner-desc').textContent = 'Это начало канала #' + ch + ' на сервере «' + sName + '».';
    document.getElementById('chat-input').placeholder = 'Написать в #' + ch;
    document.querySelectorAll('.ch-btn').forEach(function (i) { i.classList.toggle('active', i.getAttribute('data-ch') === ch); });
  }

  function updateVoicePanelUI() {
    document.getElementById('voice-panel-title').textContent = 'Голосовой канал («' + currentVoiceChannel + '»)';
    updateFloatingOverlayUI();
  }

  async function switchServer(roomId) {
    const clean = String(roomId || '').trim();
    if (!clean || clean === currentRoom) { closeMobileDrawers(); return; }
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
        pushLocalVaultToServer();
      } else if (data.type === 'servers') {
        serversList = data.payload.list || [];
        const f = serversList.find(function (s) { return s.id === currentRoom; }); if (f) currentServerMeta = f;
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
          if (call) { call.on('stream', function (s) { playStream(pid, s); }); call.on('close', function () { removeAudio(pid); }); call.on('error', function () { removeAudio(pid); }); }
          if (inScreen && screenStream) callPeerWithScreen(pid);
          if (inWebcam && webcamStream) callPeerWithWebcam(pid);
        }
      } else if (data.type === 'screen-stop' && data.payload && data.payload.peerId) { removeMediaTile('screen-' + data.payload.peerId); }
      else if (data.type === 'cam-stop' && data.payload && data.payload.peerId) { removeMediaTile('cam-' + data.payload.peerId); }
    };
  }

  function rerenderChatMessages() {
    const box = document.getElementById('messages-list'); box.innerHTML = '';
    if (!cachedMessages || !cachedMessages.length) { box.innerHTML = '<div id="empty-hint" style="font-size:13px;color:var(--text-muted);padding:8px 16px;">Сообщений пока нет. Напишите первым!</div>'; return; }
    cachedMessages.forEach(addMsgToDOM);
  }

  function buildMessageBodyHTML(text, violations) {
    const safeText = escapeHtml(text).replace(ANY_URL_RX, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const imgMatch = String(text || '').match(IMAGE_URL_RX);
    let inner = '<div>' + safeText + '</div>';
    if (imgMatch) inner += '<img class="chat-inline-media" src="' + escapeHtml(imgMatch[0]) + '" alt="media" loading="lazy">';
    if (!violations || !violations.length) return inner;
    const rStr = escapeHtml(violations.join(', '));
    if (appSettings.filterAction === 'blur') {
      return '<div class="spoiler-blur-wrap" onclick="toggleSpoiler(this)" title="Показать/скрыть"><div class="spoiler-badge">🛡️ Скрыто фильтром (' + rStr + ') — нажмите для просмотра</div><div class="spoiler-blur-content">' + inner + '</div></div>';
    }
    return '<div class="filtered-block-card">🛡️ Заблокировано фильтром безопасности (' + rStr + ')</div>';
  }

  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list'), hint = document.getElementById('empty-hint'); if (hint) hint.remove();
    const author = String(m.author || '?'), viol = checkContentViolation(m.text, m.flags);
    const div = el('div', 'msg-item');
    div.innerHTML = '<div class="msg-ava">' + escapeHtml(author.slice(0, 2).toUpperCase()) + '</div><div style="flex:1;min-width:0;"><div><span class="msg-author">' + escapeHtml(author) + '</span><span class="msg-time">' + escapeHtml(m.time) + '</span></div><div class="msg-text">' + buildMessageBodyHTML(m.text, viol) + '</div></div>';
    box.appendChild(div);
    const scrollArea = document.getElementById('chat-scroll'); scrollArea.scrollTop = scrollArea.scrollHeight;
  }

  function friendAction(action, pid) {
    if (!myVerified) { openAuthModal(true); return Promise.resolve(); }
    if (action === 'remove') { localVault.friends = (localVault.friends || []).filter(function (x) { return x !== pid; }); saveLocalVault(); }
    return fetch('/api/friend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, action: action, target: pid }) })
      .then(function (r) { return r.json(); }).then(function (d) { if (d.error) alert(d.error); }).catch(function () {});
  }

  function renderMemberRow(u, friendPids, isFirstOnline) {
    const d = el('div', 'online-user-item' + (u.online ? ' is-online' : ''));
    if (!u.online) d.style.opacity = '0.55';

    const avaWrap = el('div', 'member-ava-wrap');
    const ava = el('div', 'member-ava', String(u.nick || '?').slice(0, 2).toUpperCase());
    ava.style.background = u.avatarColor || '#5865f2';
    avaWrap.appendChild(ava);
    avaWrap.appendChild(el('span', 'online-dot ' + (u.online ? (u.presence || 'online') : 'off')));
    d.appendChild(avaWrap);

    const col = el('div', 'member-text-col');
    const nr = el('div', 'member-nick-row');
    nr.appendChild(el('span', '', u.nick + (isFirstOnline ? ' 👑' : '') + (u.inVoice ? ' 🔊' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '')));
    col.appendChild(nr);
    if (u.customStatus) {
      const sv = checkContentViolation(u.customStatus);
      col.appendChild(el('div', 'member-status-sub', sv.length ? '🛡️ [Статус скрыт]' : u.customStatus));
    }
    d.appendChild(col);

    if (myPid && u.pid !== myPid) {
      if (friendPids.includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'друг'));
      else if ((social.outgoing || []).includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'заявка'));
      else if ((social.incoming || []).some(function (i) { return i.pid === u.pid; })) {
        const b = el('button', 'mini-btn', 'принять'); b.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', u.pid); }; d.appendChild(b);
      } else {
        const b = el('button', 'mini-btn', '+'); b.title = 'Добавить в друзья'; b.onclick = function (ev) { ev.stopPropagation(); friendAction('request', u.pid); }; d.appendChild(b);
      }
    }
    d.onclick = function () { openUserProfileCard(u); };
    return d;
  }

  function renderUsers(list) {
    lastMembers = list || [];
    const online = lastMembers.filter(function (u) { return u.online; });
    const offline = lastMembers.filter(function (u) { return !u.online; });
    document.getElementById('online-count').textContent = online.length;
    document.getElementById('total-members-count').textContent = offline.length;

    const onBox = document.getElementById('online-users-box'); onBox.innerHTML = '';
    const offBox = document.getElementById('offline-users-box'); offBox.innerHTML = '';
    const friendPids = (social.friends || []).map(function (f) { return f.pid; });

    online.forEach(function (u, idx) { onBox.appendChild(renderMemberRow(u, friendPids, idx === 0)); });
    offline.forEach(function (u) { offBox.appendChild(renderMemberRow(u, friendPids, false)); });
  }

  function renderSocial() {
    const friends = social.friends || [], incoming = social.incoming || [];
    document.getElementById('friends-count').textContent = friends.length;
    const rq = document.getElementById('requests-box'); rq.innerHTML = '';
    incoming.forEach(function (r) {
      const d = el('div', 'online-user-item');
      const nm = el('span', '', r.nick + ' (заявка)'); nm.style.cssText = 'flex:1;font-size:12px;';
      const ok = el('button', 'mini-btn', '✓'); ok.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕'); no.onclick = function (ev) { ev.stopPropagation(); friendAction('decline', r.pid); };
      d.appendChild(nm); d.appendChild(ok); d.appendChild(no); rq.appendChild(d);
    });
    const fb = document.getElementById('friends-box'); fb.innerHTML = '';
    friends.forEach(function (f) {
      const d = el('div', 'online-user-item');
      if (!f.online) d.style.opacity = '0.55';
      const avaWrap = el('div', 'member-ava-wrap');
      const ava = el('div', 'member-ava', String(f.nick || '?').slice(0, 2).toUpperCase());
      ava.style.background = f.avatarColor || '#5865f2';
      avaWrap.appendChild(ava);
      avaWrap.appendChild(el('span', 'online-dot ' + (f.online ? (f.presence || 'online') : 'off')));
      d.appendChild(avaWrap);
      const nm = el('span', 'member-nick-row', f.nick); nm.style.flex = '1'; d.appendChild(nm);
      const rm = el('button', 'mini-btn', '✕'); rm.onclick = function (ev) { ev.stopPropagation(); if (confirm('Удалить из друзей?')) friendAction('remove', f.pid); };
      d.appendChild(rm); d.onclick = function () { openUserProfileCard(f); }; fb.appendChild(d);
    });
  }

  function openUserProfileCard(u) {
    if (!u) return;
    document.getElementById('vp-banner').style.background = u.bannerColor || '#5865f2';
    const ava = document.getElementById('vp-ava'); ava.textContent = String(u.nick || '?').slice(0, 2).toUpperCase(); ava.style.background = u.avatarColor || '#5865f2';
    document.getElementById('vp-nick').textContent = u.nick || 'Участник';
    const pill = document.getElementById('vp-online-pill'); pill.className = 'status-pill ' + (u.online ? 'on' : 'off'); pill.textContent = u.online ? 'В сети' : 'Не в сети';
    document.getElementById('vp-status').textContent = checkContentViolation(u.customStatus || '').length ? '🛡️ [Статус скрыт]' : (u.customStatus || '');
    document.getElementById('vp-bio').textContent = checkContentViolation(u.bio || '').length ? '🛡️ [Скрыто фильтром]' : (u.bio || 'Участник пока ничего о себе не указал.');
    const tb = document.getElementById('vp-tags'); tb.innerHTML = '';
    String(u.interests || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean).forEach(function (tg) { if (!checkContentViolation(tg).length) tb.appendChild(el('span', 'dp-tag', tg)); });
    if (!tb.childNodes.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Нет тегов</span>';
    const fBtn = document.getElementById('vp-friend-btn'), friendPids = (social.friends || []).map(function (f) { return f.pid; });
    if (u.pid === myPid) { fBtn.textContent = '✏️ Редактировать профиль'; fBtn.onclick = function () { closeViewProfileModal(); openSettingsModal('profile'); }; }
    else if (friendPids.includes(u.pid)) { fBtn.textContent = '✓ В друзьях'; fBtn.onclick = function () { closeViewProfileModal(); }; }
    else { fBtn.textContent = '+ Добавить в друзья'; fBtn.onclick = function () { friendAction('request', u.pid); closeViewProfileModal(); }; }
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
    document.getElementById('sel-font-size').value = appSettings.fontSize || '14px';
    document.getElementById('chk-snd-msg').checked = appSettings.soundMsg !== false;
    document.getElementById('chk-snd-voice').checked = appSettings.soundVoice !== false;
    refreshMediaDevices(); switchSettingsPane(pane || 'profile');
    document.getElementById('settings-modal').classList.add('open');
  }

  function closeSettingsModal() { stopMicTest(); document.getElementById('settings-modal').classList.remove('open'); setMobActiveTab('mob-tab-chat'); }
  function switchSettingsPane(pId) {
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
    const intr = document.getElementById('prof-interests-inp').value.trim().slice(0, 160);

    document.getElementById('preview-banner').style.background = myProfile.bannerColor || '#5865f2';
    const ava = document.getElementById('preview-ava'); ava.textContent = n.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#5865f2';
    document.getElementById('preview-nick').textContent = n; document.getElementById('preview-status').textContent = st || 'В сети'; document.getElementById('preview-bio').textContent = bio || 'О себе...';
    const tb = document.getElementById('preview-tags'); tb.innerHTML = '';
    const tags = intr.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!tags.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Нет тегов</span>';
    else tags.forEach(function (tg) { tb.appendChild(el('span', 'dp-tag', tg)); });

    if (!skipSync) {
      myNick = n; myProfile.presence = pr; myProfile.customStatus = st; myProfile.bio = bio; myProfile.interests = intr;
      try { localStorage.setItem('cyber_nick', myNick); localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
      setPersistCookie('cyber_nick', myNick); saveLocalVault(); applyNickUI();
      if (profileSyncTimer) clearTimeout(profileSyncTimer);
      profileSyncTimer = setTimeout(function () { syncProfileToServer(); }, 350);
    }
  }

  function syncProfileToServer() {
    return fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, presence: myProfile.presence, customStatus: myProfile.customStatus, bio: myProfile.bio, interests: myProfile.interests, bannerColor: myProfile.bannerColor, avatarColor: myProfile.avatarColor }) }).catch(function () {});
  }
  async function saveProfileSettings() { updateProfilePreview(false); await syncProfileToServer(); closeSettingsModal(); }

  async function refreshMediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mSel = document.getElementById('set-mic-select'), sSel = document.getElementById('set-spk-select'), cSel = document.getElementById('set-cam-select');
      mSel.innerHTML = ''; sSel.innerHTML = ''; cSel.innerHTML = '';
      devs.forEach(function (d) {
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
    document.querySelectorAll('#audio-box audio').forEach(function (a) { a.volume = vol; a.muted = isDeafened; if (appSettings.spkDeviceId && typeof a.setSinkId === 'function') a.setSinkId(appSettings.spkDeviceId).catch(function () {}); });
  }

  function saveAudioVideoSettings() {
    const mEl = document.getElementById('set-mic-select'), sEl = document.getElementById('set-spk-select'), cEl = document.getElementById('set-cam-select');
    appSettings.micDeviceId = mEl ? mEl.value : '';
    appSettings.spkDeviceId = sEl ? sEl.value : '';
    appSettings.camDeviceId = cEl ? cEl.value : '';
    appSettings.camRes = document.getElementById('set-cam-res').value || '720';
    appSettings.autoOverlay = document.getElementById('chk-auto-overlay').checked;
    appSettings.noiseSuppression = document.getElementById('chk-noise').checked;
    appSettings.echoCancellation = document.getElementById('chk-echo').checked;
    appSettings.autoGainControl = document.getElementById('chk-agc').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
  }

  async function toggleMicTest() {
    if (micTestTimer) { stopMicTest(); return; }
    try {
      micTestStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: appSettings.micDeviceId ? { ideal: appSettings.micDeviceId } : undefined } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createMediaStreamSource(micTestStream), an = ctx.createAnalyser();
      an.fftSize = 256; src.connect(an); const d = new Uint8Array(an.frequencyBinCount);
      document.getElementById('btn-mic-test').textContent = '🛑 Остановить';
      micTestTimer = setInterval(function () { an.getByteFrequencyData(d); let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i]; document.getElementById('mic-test-bar').style.width = Math.min(100, Math.round((sum / d.length / 90) * 100)) + '%'; }, 60);
    } catch (e) { alert('Ошибка доступа к микрофону.'); }
  }

  function stopMicTest() {
    if (micTestTimer) { clearInterval(micTestTimer); micTestTimer = null; }
    if (micTestStream) { micTestStream.getTracks().forEach(function (t) { t.stop(); }); micTestStream = null; }
    const b = document.getElementById('btn-mic-test'); if (b) b.textContent = '🎙️ Давайте проверим';
    const bar = document.getElementById('mic-test-bar'); if (bar) bar.style.width = '0%';
  }

  function setAccentTheme(m, b) { document.documentElement.style.setProperty('--brand', m); document.documentElement.style.setProperty('--cyan', m); document.documentElement.style.setProperty('--cyan-bright', b); appSettings.accentMain = m; appSettings.accentBright = b; try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {} }
  function applyAppearanceSettings() {
    appSettings.compactChat = document.getElementById('chk-compact').checked; appSettings.fontSize = document.getElementById('sel-font-size').value || '14px';
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {} applyAppearanceFromStorage();
  }
  function applyAppearanceFromStorage() {
    document.body.classList.toggle('compact-chat', !!appSettings.compactChat);
    document.documentElement.style.setProperty('--chat-font-size', appSettings.fontSize || '14px');
    if (appSettings.accentMain) { document.documentElement.style.setProperty('--brand', appSettings.accentMain); }
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
    if (e && e.preventDefault) e.preventDefault();
    if (!myVerified) { openAuthModal(true); return; }
    const inp = document.getElementById('chat-input'), text = inp.value.trim(); if (!text) return;
    if (appSettings.filterOutgoing !== false && checkContentViolation(text).length) { alert('🛡️ Отправка заблокирована фильтром безопасности.'); return; }
    fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, channel: currentChannel, author: myNick, text: text }) }).catch(function () {});
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
    else postVoiceState({ inVoice: true, inScreen: inScreen, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel }).then(function (d) { if (d && d.peers) d.peers.forEach(function (p) { if (inScreen) callPeerWithScreen(p); if (inWebcam) callPeerWithWebcam(p); }); });
  }

  function openCreateServerModal() {
    if (!myVerified) return openAuthModal(true);
    closeMobileDrawers();
    document.getElementById('new-srv-name').value = '';
    document.getElementById('new-srv-desc').value = '';
    document.getElementById('create-server-modal').classList.add('open');
  }
  function closeCreateServerModal() { document.getElementById('create-server-modal').classList.remove('open'); }
  async function submitCreateServer() {
    const name = document.getElementById('new-srv-name').value.trim();
    const desc = document.getElementById('new-srv-desc').value.trim();
    if (!name) return alert('Введите название сервера!');
    const res = await fetch('/api/server/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, name: name, desc: desc }) });
    const d = await res.json(); if (d.error) return alert(d.error);
    closeCreateServerModal(); await switchServer(d.serverId);
  }

  function openCreateChannelModal(type) {
    if (!myVerified) return openAuthModal(true);
    closeMobileDrawers(); pendingChannelType = type === 'voice' ? 'voice' : 'text';
    document.getElementById('create-ch-title').textContent = pendingChannelType === 'voice' ? 'Создать голосовой канал' : 'Создать текстовый канал';
    document.getElementById('create-ch-sub').textContent = pendingChannelType === 'voice' ? 'Участники смогут общаться голосом, включать камеру и стрим экрана:' : 'Участники смогут отправлять сообщения и ссылки:';
    document.getElementById('new-ch-name').value = '';
    document.getElementById('create-channel-modal').classList.add('open');
  }
  function closeCreateChannelModal() { document.getElementById('create-channel-modal').classList.remove('open'); }
  async function submitCreateChannel() {
    const name = document.getElementById('new-ch-name').value.trim(); if (!name) return alert('Введите название!');
    const res = await fetch('/api/channel/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, room: currentRoom, type: pendingChannelType, name: name }) });
    const d = await res.json(); if (d.error) return alert(d.error); closeCreateChannelModal();
    if (pendingChannelType === 'text' && d.channel) {
      roomMessagesCache[d.channel] = [];
      if (!currentServerMeta.textChannels.includes(d.channel)) currentServerMeta.textChannels.push(d.channel);
      saveLocalVault(); setChannel(d.channel);
    } else if (pendingChannelType === 'voice' && d.channel) {
      if (!currentServerMeta.voiceChannels.includes(d.channel)) currentServerMeta.voiceChannels.push(d.channel);
      currentVoiceChannel = d.channel; saveLocalVault(); renderServerChannels();
    }
  }

  function openInviteModal() {
    closeMobileDrawers(); document.getElementById('invite-modal').classList.add('open');
    const u = window.location.origin + '/?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel);
    document.getElementById('public-invite-url').textContent = u; document.getElementById('public-invite-url').href = u;
  }
  function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
  async function copyInviteLink() {
    const u = document.getElementById('public-invite-url').textContent;
    try { await navigator.clipboard.writeText(u); alert('Ссылка скопирована!'); } catch (e) { prompt('Скопируйте ссылку:', u); }
  }

  async function initTelegramSession() {
    try {
      const res = await fetch('/api/tg-init'); const d = await res.json(); tgSessionToken = d.token || ''; tgBotUsername = d.botUsername || '';
      if (tgBotUsername) document.getElementById('tg-open-bot-btn').innerHTML = '<span>✈️ Открыть @' + escapeHtml(tgBotUsername) + ' и войти</span>';
    } catch (e) {}
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

  function openTelegramBot() {
    if (!tgBotUsername) { switchAuthTab('pass'); return; }
    window.open('https://t.me/' + encodeURIComponent(tgBotUsername) + '?start=auth_' + encodeURIComponent(tgSessionToken), '_blank');
    startTgPolling();
  }

  async function verifyTelegramCode() {
    const code = document.getElementById('tg-code-inp').value.trim(); if (!code) return alert('Введите 4-значный код!');
    const res = await fetch('/api/tg-verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, code: code, nick: document.getElementById('nick-inp').value.trim() }) });
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
    document.getElementById('auth-modal').classList.add('open'); initTelegramSession().then(function () { startTgPolling(); });
  }
  function closeAuthModal() {
    if (authLocked && !myVerified) return;
    if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; }
    document.getElementById('auth-modal').classList.remove('open');
  }

  async function loginWithPassword() {
    const nick = document.getElementById('nick-inp').value.trim(), pass = document.getElementById('pass-inp').value;
    if (!nick) return alert('Введите ваш никнейм!'); if (!pass && !myVerified) return alert('Введите пароль!');
    const res = await fetch('/api/auth-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick: nick, password: pass }) });
    const d = await res.json(); if (d.error) return alert(d.error); completeClientAuth(d);
  }

  function postVoiceState(st) {
    return fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: clientId }, st)) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  }

  function createProcessedAudioStream(stream) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream); micGainNode = audioCtx.createGain(); micGainNode.gain.value = (appSettings.micVolume || 100) / 100;
      const dst = audioCtx.createMediaStreamDestination(); src.connect(micGainNode); micGainNode.connect(dst); return dst.stream;
    } catch (e) { return stream; }
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
    document.getElementById('connect-voice-btn').textContent = 'Отключиться'; document.getElementById('connect-voice-btn').className = 'btn-danger';
    document.getElementById('mute-btn').style.display = 'inline-block'; document.getElementById('deafen-btn').style.display = 'inline-block';
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Микр. вкл';
    document.getElementById('voice-active-area').classList.add('show');
    startBackgroundCallPersistence(); renderServerChannels();

    return new Promise(function (resolve) {
      peer = new Peer();
      peer.on('open', function (id) { myPeerId = id; postVoiceState({ inVoice: true, inScreen: inScreen, inCam: inWebcam, peerId: id, voiceChannel: currentVoiceChannel }).then(function () { resolve(true); }); });
      peer.on('call', function (call) {
        const kind = (call.metadata && call.metadata.kind) || 'audio', n = (call.metadata && call.metadata.nick) || 'Участник';
        if (kind === 'screen' || kind === 'cam') {
          call.answer(); call.on('stream', function (st) { renderMediaTile(kind + '-' + call.peer, st, n + (kind === 'cam' ? ' (Камера)' : ' (Экран)'), false, kind); });
          call.on('close', function () { removeMediaTile(kind + '-' + call.peer); }); call.on('error', function () { removeMediaTile(kind + '-' + call.peer); });
        } else {
          call.answer(localStream || undefined); call.on('stream', function (st) { playStream(call.peer, st); });
          call.on('close', function () { removeAudio(call.peer); }); call.on('error', function () { removeAudio(call.peer); });
        }
      });
      peer.on('error', function () { resolve(false); });
    });
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (inScreen) stopScreenShare(true); if (inWebcam) stopWebcam(true);
      if (rawMicStream) rawMicStream.getTracks().forEach(function (t) { t.stop(); });
      if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
      if (peer) peer.destroy();
      rawMicStream = null; localStream = null; peer = null; myPeerId = null; inVoice = false; isMuted = false; isDeafened = false;
      if (appSettings.soundVoice) playUiBeep(420, 0.09);
      document.getElementById('connect-voice-btn').textContent = 'Подключиться'; document.getElementById('connect-voice-btn').className = 'btn-cyan';
      document.getElementById('mute-btn').style.display = 'none'; document.getElementById('deafen-btn').style.display = 'none';
      document.getElementById('voice-active-area').classList.remove('show');
      document.getElementById('audio-box').innerHTML = ''; document.getElementById('screen-grid').innerHTML = '';
      stopBackgroundCallPersistence(); renderServerChannels(); postVoiceState({ inVoice: false, inScreen: false, inCam: false }); return;
    }
    await ensureVoiceConnected();
  }

  function callPeerWithWebcam(pid) {
    if (!peer || !webcamStream || !pid || pid === myPeerId) return;
    if (camCalls[pid]) try { camCalls[pid].close(); } catch (e) {}
    const c = peer.call(pid, webcamStream, { metadata: { kind: 'cam', nick: myNick, voiceChannel: currentVoiceChannel } });
    if (c) { camCalls[pid] = c; c.on('close', function () { delete camCalls[pid]; }); c.on('error', function () { delete camCalls[pid]; }); }
  }

  async function toggleWebcam() {
    if (!myVerified) return openAuthModal(true);
    if (inWebcam) { stopWebcam(false); return; }
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: appSettings.camDeviceId ? { ideal: appSettings.camDeviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) { alert('Разрешите доступ к камере!'); return; }
    if (!(await ensureVoiceConnected())) { webcamStream.getTracks().forEach(function (t) { t.stop(); }); return; }
    inWebcam = true; document.getElementById('cam-btn').textContent = '🛑 Выкл камеру'; document.getElementById('cam-btn').classList.add('active-cam');
    document.getElementById('voice-active-area').classList.add('show');
    webcamStream.getVideoTracks()[0].onended = function () { stopWebcam(false); };
    renderMediaTile('cam-local', webcamStream, myNick + ' (Ваша камера)', true, 'cam');
    const d = await postVoiceState({ inVoice: true, inScreen: inScreen, inCam: true, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d && d.peers) d.peers.forEach(function (p) { callPeerWithWebcam(p); });
    updateFloatingOverlayUI();
  }

  function stopWebcam(silent) {
    if (webcamStream) { webcamStream.getTracks().forEach(function (t) { t.stop(); }); webcamStream = null; }
    Object.keys(camCalls).forEach(function (p) { try { camCalls[p].close(); } catch (e) {} }); camCalls = {};
    inWebcam = false; document.getElementById('cam-btn').textContent = '📷 Камера'; document.getElementById('cam-btn').classList.remove('active-cam');
    removeMediaTile('cam-local');
    if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: inScreen, inCam: false, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateFloatingOverlayUI();
  }

  function callPeerWithScreen(pid) {
    if (!peer || !screenStream || !pid || pid === myPeerId) return;
    if (screenCalls[pid]) try { screenCalls[pid].close(); } catch (e) {}
    const c = peer.call(pid, screenStream, { metadata: { kind: 'screen', nick: myNick, voiceChannel: currentVoiceChannel } });
    if (c) { screenCalls[pid] = c; c.on('close', function () { delete screenCalls[pid]; }); c.on('error', function () { delete screenCalls[pid]; }); }
  }

  async function toggleScreenShare() {
    if (!myVerified) return openAuthModal(true);
    if (inScreen) { stopScreenShare(false); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { alert('Демонстрация экрана недоступна на этом устройстве.'); return; }
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', frameRate: { ideal: 30 } }, audio: true }); } catch (e) { return; }
    if (!(await ensureVoiceConnected())) { screenStream.getTracks().forEach(function (t) { t.stop(); }); return; }
    inScreen = true; document.getElementById('screen-btn').textContent = '🛑 Стоп экран'; document.getElementById('screen-btn').classList.add('active-screen');
    document.getElementById('voice-active-area').classList.add('show');
    screenStream.getVideoTracks()[0].onended = function () { stopScreenShare(false); };
    renderMediaTile('screen-local', screenStream, myNick + ' (Ваш экран)', true, 'screen');
    const d = await postVoiceState({ inVoice: true, inScreen: true, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    if (d && d.peers) d.peers.forEach(function (p) { callPeerWithScreen(p); });
    updateFloatingOverlayUI();
  }

  function stopScreenShare(silent) {
    if (screenStream) { screenStream.getTracks().forEach(function (t) { t.stop(); }); screenStream = null; }
    Object.keys(screenCalls).forEach(function (p) { try { screenCalls[p].close(); } catch (e) {} }); screenCalls = {};
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
      const shieldBtn = el('button', 'btn-fs', '🛡️ Скрыть 18+'); shieldBtn.onclick = function () { toggleMediaNsfwShield(card, shieldBtn); }; right.appendChild(shieldBtn);
      const pipBtn = el('button', 'btn-fs', '🪟 В окне'); pipBtn.onclick = function () { toggleExternalOverlay(); }; right.appendChild(pipBtn);
      const fsBtn = el('button', 'btn-fs', '⛶ Полный экран'); fsBtn.onclick = function () { const v = card.querySelector('video'); if (v && v.requestFullscreen) v.requestFullscreen(); }; right.appendChild(fsBtn);
      if (isLocal) { const stopBtn = el('button', 'btn-fs', '✕ Выкл'); stopBtn.style.background = '#f23f43'; stopBtn.onclick = function () { if (kind === 'cam') stopWebcam(false); else stopScreenShare(false); }; right.appendChild(stopBtn); }
      head.appendChild(left); head.appendChild(right);
      const wrap = el('div', 'screen-video-wrap'), vid = document.createElement('video'); vid.autoplay = true; vid.playsInline = true; if (isLocal) vid.muted = true;
      const shield = el('div', 'media-nsfw-shield'); shield.innerHTML = '<div>🔞 Видеопоток скрыт фильтром 18+</div><span class="btn-cyan" style="padding:5px 12px;font-size:11px;">👁️ Показать видео</span>';
      shield.onclick = function () { toggleMediaNsfwShield(card, shieldBtn); };
      wrap.appendChild(vid); wrap.appendChild(shield); card.appendChild(head); card.appendChild(wrap); grid.appendChild(card);
    } else {
      card.querySelector('.screen-card-head span').textContent = icon + title;
    }
    const vEl = card.querySelector('video'); if (vEl && vEl.srcObject !== stream) { vEl.srcObject = stream; vEl.play().catch(function () {}); }
  }

  function removeMediaTile(id) { const c = document.getElementById('media-tile-' + id); if (c) c.remove(); }

  function toggleMute() {
    if (!localStream) return; isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    if (rawMicStream) rawMicStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    document.getElementById('mute-btn').textContent = isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл'; updateFloatingOverlayUI();
  }

  function toggleDeafen() {
    isDeafened = !isDeafened; document.getElementById('deafen-btn').textContent = isDeafened ? '🔇 Звук выкл' : '🎧 Звук вкл';
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
  }

  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const a = document.createElement('audio'); a.id = 'aud-' + id; a.srcObject = stream; a.autoplay = true; a.playsInline = true;
    document.getElementById('audio-box').appendChild(a); applyOutputVolumeToAll(); a.play().catch(function () {});
  }
  function removeAudio(id) { const a = document.getElementById('aud-' + id); if (a) a.remove(); }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSettingsModal(); closeViewProfileModal(); closeInviteModal(); closeMobileDrawers(); } });

  applyNickUI(); applyAppearanceFromStorage(); renderServersRail(); renderServerChannels(); connectEventStream();
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

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(JSON.stringify({
        name: 'СИГНАЛ — Ночной клуб', short_name: 'СИГНАЛ', start_url: '/', display: 'standalone', background_color: '#040609', theme_color: '#040609',
        icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23e11d48' width='100' height='100' rx='22'/><text y='.88em' font-size='68' x='16' fill='white'>⚡</text></svg>", sizes: '192x192 512x512', type: 'image/svg+xml' }]
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
      return sendJson(res, 200, (rooms[room] && rooms[room][ch]) || []);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') return sendJson(res, 200, { publicUrl: null });

    if (req.method === 'POST' && url.pathname === '/api/auth-password') {
      const body = await readBody(req), nick = cleanNick(body.nick), pass = String(body.password || ''), room = safeRoom(body.room), prevUid = validUid(body.uid) ? body.uid : null;
      if (!nick || nick.length < 2) return sendJson(res, 400, { error: 'Введите позывной!' });
      if (prevUid && users[prevUid] && users[prevUid].verified && !pass) {
        users[prevUid].nick = nick; scheduleSave(); notifyAllRoomsOfUser(prevUid); notifyFriendsOf(prevUid); sendSocial(prevUid);
        return sendJson(res, 200, { ok: true, uid: prevUid, pid: users[prevUid].pid, nick });
      }
      if (pass.length < 4) return sendJson(res, 400, { error: 'Пароль от 4 символов!' });
      const exUid = nickToUid[nick.toLowerCase()];
      if (exUid && users[exUid] && users[exUid].passHash) {
        if (!verifyPassword(pass, users[exUid].passHash)) return sendJson(res, 400, { error: 'Неверный пароль!' });
        const u = mergeAccount(prevUid, exUid, nick, '', '', ''); addMember(room, exUid);
        scheduleSave(); notifyAllRoomsOfUser(exUid); notifyFriendsOf(exUid); sendSocial(exUid);
        return sendJson(res, 200, { ok: true, uid: exUid, pid: u.pid, nick: u.nick });
      }
      const finalUid = exUid || (prevUid && (!users[prevUid] || !users[prevUid].verified) ? prevUid : crypto.randomBytes(16).toString('hex'));
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
      if (!validUid(uid)) return sendJson(res, 403, { error: 'Войдите в аккаунт' });
      const u = ensureUser(uid, body.author || (c && c.nick) || 'Участник', true);
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log('⚡ СЕРВЕР СИГНАЛ ЗАПУЩЕН НА ПОРТУ ' + PORT);
    startTelegramBotPolling();
  });
}
boot();

async function shutdown() {
  setTimeout(() => process.exit(0), 4000).unref();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await saveNow(); process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, shutdown));