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
<meta name="theme-color" content="#04070d">
<title>СИГНАЛ // P2P СИНХРОНИЗАЦИЯ</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root {
    --bg-darkest: #04070d;
    --bg-servers: #050911;
    --bg-channels: #070d17;
    --bg-chat: #08101c;
    --bg-members: #070d17;
    --bg-userbar: #040810;
    --bg-card: rgba(10, 19, 32, 0.88);
    --bg-input: #091320;
    --bg-hover: rgba(20, 241, 217, 0.09);
    --bg-active: rgba(20, 241, 217, 0.17);
    --brand: #14f1d9;
    --brand-hover: #5ffbf1;
    --pink: #ff1e56;
    --green: #10b981;
    --red: #ff1e56;
    --yellow: #fcee09;
    --purple: #b829ff;
    --text-main: #e6f7ff;
    --text-normal: #b4cde0;
    --text-muted: #5e7a94;
    --text-dim: #3b536b;
    --border: rgba(20, 241, 217, 0.16);
    --pink-border: rgba(255, 30, 86, 0.45);
    --cyan-border: rgba(20, 241, 217, 0.38);
    --chat-font-size: 14px;
    --hex: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
    --pcb-pattern: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cg fill='none' stroke='%2314f1d9' stroke-width='0.9' stroke-opacity='0.06'%3E%3Cpath d='M0 24h36l16 16v36l16 16h44l20-20h28M24 0v30l20 20h40l16-16h60M0 110h30l22 22v28M90 160v-30l22-22h48M60 160v-34l-16-16H16L0 94M124 0v34l-16 16v28'/%3E%3C/g%3E%3Cg fill='%2314f1d9' fill-opacity='0.08'%3E%3Ccircle cx='36' cy='24' r='2.2'/%3E%3Ccircle cx='52' cy='40' r='2.2'/%3E%3Ccircle cx='68' cy='92' r='2.2'/%3E%3Ccircle cx='100' cy='34' r='2.2'/%3E%3Ccircle cx='52' cy='132' r='2.2'/%3E%3Ccircle cx='112' cy='108' r='2.2'/%3E%3C/g%3E%3Cg fill='%23ff1e56' fill-opacity='0.06'%3E%3Ccircle cx='44' cy='50' r='2'/%3E%3Ccircle cx='108' cy='78' r='2'/%3E%3Ccircle cx='30' cy='110' r='2'/%3E%3C/g%3E%3C/svg%3E");
  }

  @keyframes neonSpin {
    0% { transform: translate(-50%, -50%) rotate(0deg); }
    100% { transform: translate(-50%, -50%) rotate(360deg); }
  }
  @keyframes eqPulse {
    0%, 100% { transform: scaleY(0.25); opacity: 0.5; }
    50% { transform: scaleY(1); opacity: 1; }
  }
  @keyframes badgeShimmer {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes glitchPulse {
    0%, 100% { box-shadow: 0 0 12px rgba(255, 30, 86, 0.55), inset 0 0 10px rgba(20, 241, 217, 0.25); }
    50% { box-shadow: 0 0 22px rgba(20, 241, 217, 0.7), inset 0 0 16px rgba(255, 30, 86, 0.35); }
  }
  @keyframes bgScanMove {
    0% { background-position: 0 0, 0 0; }
    100% { background-position: 0 120px, -120px 0; }
  }

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    background-color: var(--bg-darkest);
    background-image:
      radial-gradient(circle at 20% 20%, rgba(20, 241, 217, 0.05), transparent 45%),
      radial-gradient(circle at 85% 80%, rgba(255, 30, 86, 0.05), transparent 45%),
      var(--pcb-pattern);
    color: var(--text-main);
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    user-select: none;
  }

  /* ШЕСТИУГОЛЬНЫЙ ЗНАЧОК ПРОФИЛЯ С 3 АНИМАЦИЯМИ НАБОРОВ */
  .hex-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .hex-border {
    position: relative;
    width: 100%;
    height: 100%;
    clip-path: var(--hex);
    background: rgba(20, 241, 217, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2.2px;
    overflow: hidden;
  }
  .hex-wrap[class*="fx-set"] .hex-border::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 220%;
    height: 220%;
    animation: neonSpin 2s linear infinite;
    z-index: 0;
  }
  /* Набор 1: Edgerunners S1 (Жёлто-изумрудный Сандевистан Дэвида) */
  .hex-wrap.fx-set1 .hex-border {
    background: rgba(252, 238, 9, 0.25);
    filter: drop-shadow(0 0 7px rgba(252, 238, 9, 0.8));
  }
  .hex-wrap.fx-set1 .hex-border::before {
    background: conic-gradient(from 0deg, transparent 0%, transparent 52%, #00ff9d 74%, #fcee09 92%, #ffffff 100%);
  }
  /* Набор 2: Edgerunners S2 (Пурпурно-голографический протокол Люси / Новое поколение) */
  .hex-wrap.fx-set2 .hex-border {
    background: rgba(184, 41, 255, 0.25);
    filter: drop-shadow(0 0 8px rgba(184, 41, 255, 0.85));
  }
  .hex-wrap.fx-set2 .hex-border::before {
    background: conic-gradient(from 0deg, transparent 0%, transparent 52%, #00f0ff 74%, #b829ff 90%, #ff00a0 100%);
  }
  /* Набор 3: Cyberpunk 2077 (Красно-бирюзовый Relic / Джонни Сильверхенд) */
  .hex-wrap.fx-set3 .hex-border {
    background: rgba(255, 30, 86, 0.25);
    filter: drop-shadow(0 0 8px rgba(255, 30, 86, 0.9));
  }
  .hex-wrap.fx-set3 .hex-border::before {
    background: conic-gradient(from 0deg, transparent 0%, transparent 54%, #ff003c 76%, #14f1d9 92%, #ffffff 100%);
  }

  .hex-core {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    clip-path: var(--hex);
    background: linear-gradient(145deg, #101d30, #08101c);
    color: #fff;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0.4px;
  }
  .hex-status-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 11px;
    height: 11px;
    clip-path: var(--hex);
    background: var(--green);
    border: 1.5px solid #04070d;
    z-index: 3;
  }
  .hex-status-dot.idle { background: var(--yellow); }
  .hex-status-dot.dnd { background: var(--red); }
  .hex-status-dot.invisible, .hex-status-dot.offline, .hex-status-dot.off { background: var(--text-dim); }

  /* АНИМИРОВАННЫЙ БЕЙДЖ СПРАВА ОТ ЗНАЧКА ПРОФИЛЯ */
  .cyber-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1.5px 6px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
    background-size: 200% 200%;
    animation: badgeShimmer 2.6s ease infinite;
  }
  .cyber-badge.b-set1 {
    background-image: linear-gradient(90deg, #fcee09, #00ff9d, #fcee09);
    color: #04120c;
    box-shadow: 0 0 8px rgba(252, 238, 9, 0.55);
  }
  .cyber-badge.b-set2 {
    background-image: linear-gradient(90deg, #b829ff, #00f0ff, #ff00a0);
    color: #fff;
    box-shadow: 0 0 8px rgba(184, 41, 255, 0.6);
  }
  .cyber-badge.b-set3 {
    background-image: linear-gradient(90deg, #ff003c, #14f1d9, #ff003c);
    color: #fff;
    box-shadow: 0 0 8px rgba(255, 0, 60, 0.65);
  }

  /* АНИМИРОВАННЫЕ РАМКИ И ЖИВЫЕ ФОНЫ КАРТОЧЕК ПРОФИЛЯ (3 НАБОРА) */
  .profile-surface {
    position: relative;
    background: #050a14;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: 0.25s;
  }
  /* Set 1: Edgerunners S1 (Луна Люси и жёлто-изумрудный контур Сандевистана) */
  .profile-surface.theme-set1 {
    border: 2px solid #fcee09;
    box-shadow: 0 0 22px rgba(252, 238, 9, 0.35), inset 0 0 18px rgba(0, 255, 157, 0.15);
    background-color: #061116;
    background-image:
      radial-gradient(circle at 82% 22%, rgba(252, 238, 9, 0.28) 0%, rgba(252, 238, 9, 0.05) 28%, transparent 55%),
      linear-gradient(135deg, rgba(252, 238, 9, 0.1) 0%, rgba(0, 255, 157, 0.08) 50%, rgba(5, 10, 20, 0.96) 100%);
  }
  .profile-surface.theme-set1 .dp-banner {
    background:
      radial-gradient(circle at 78% 50%, #fffbe6 0%, #fcee09 22%, rgba(0, 255, 157, 0.4) 52%, transparent 72%),
      linear-gradient(90deg, #051923 0%, #092c29 55%, #1f2408 100%) !important;
  }
  /* Set 2: Edgerunners S2 (Пурпурный неон и матрица взлома) */
  .profile-surface.theme-set2 {
    border: 2px solid #b829ff;
    box-shadow: 0 0 24px rgba(184, 41, 255, 0.45), inset 0 0 20px rgba(0, 240, 255, 0.18);
    background-color: #0a0618;
    background-image:
      repeating-linear-gradient(0deg, rgba(184, 41, 255, 0.07) 0px, rgba(184, 41, 255, 0.07) 1px, transparent 1px, transparent 16px),
      repeating-linear-gradient(90deg, rgba(0, 240, 255, 0.06) 0px, rgba(0, 240, 255, 0.06) 1px, transparent 1px, transparent 16px),
      radial-gradient(circle at 80% 20%, rgba(255, 0, 160, 0.22), transparent 60%);
    animation: bgScanMove 8s linear infinite;
  }
  .profile-surface.theme-set2 .dp-banner {
    background: linear-gradient(125deg, #240046 0%, #7b2cbf 45%, #ff00a0 80%, #00f0ff 100%) !important;
  }
  /* Set 3: Cyberpunk 2077 (Relic Чип, красный глитч Арасака / Самурай) */
  .profile-surface.theme-set3 {
    border: 2px solid #ff003c;
    animation: glitchPulse 2.8s infinite;
    background-color: #11050c;
    background-image:
      repeating-linear-gradient(135deg, rgba(255, 0, 60, 0.07) 0px, rgba(255, 0, 60, 0.07) 2px, transparent 2px, transparent 12px),
      radial-gradient(circle at 85% 15%, rgba(20, 241, 217, 0.2), transparent 55%);
  }
  .profile-surface.theme-set3 .dp-banner {
    background:
      linear-gradient(90deg, #ff003c 0%, #8a0020 45%, #071e26 80%, #14f1d9 100%) !important;
  }

  /* ВЕРХНЯЯ ТЕЛЕМЕТРИЧЕСКАЯ ШАПКА */
  .top-telemetry-bar {
    height: 40px;
    background: rgba(4, 7, 13, 0.94);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    gap: 12px;
    flex-shrink: 0;
    z-index: 30;
  }
  .tt-left, .tt-right { display: flex; align-items: center; gap: 10px; }
  .tt-logo { display: flex; align-items: center; gap: 7px; font-weight: 900; font-size: 13px; letter-spacing: 1px; color: #fff; }
  .tt-logo-bolt { color: var(--brand); font-size: 15px; text-shadow: 0 0 8px var(--brand); }
  .tt-cyber-tag { background: rgba(255, 30, 86, 0.2); border: 1px solid var(--pink-border); color: #ff6b8b; font-size: 9.5px; font-weight: 800; padding: 2px 7px; border-radius: 4px; letter-spacing: 0.8px; }
  .tt-proto-pill { background: rgba(20, 241, 217, 0.06); border: 1px solid var(--border); color: var(--text-muted); font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 4px; letter-spacing: 0.6px; }
  .tt-node-pill { display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; font-size: 11px; font-weight: 700; padding: 4px 11px; border-radius: 6px; }
  .tt-node-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .tt-invite-btn { background: linear-gradient(135deg, rgba(255, 30, 86, 0.28), rgba(157, 23, 77, 0.4)); border: 1px solid var(--pink); color: #fff; font-size: 11px; font-weight: 800; padding: 5px 13px; border-radius: 6px; cursor: pointer; letter-spacing: 0.5px; transition: 0.15s; }
  .tt-invite-btn:hover { background: var(--pink); }

  /* ВТОРАЯ СТРОКА P2P СИНХРОНИЗАЦИИ (БЕЗ ДУБЛИРУЮЩИХ ВКЛАДОК) */
  .sub-sync-bar {
    height: 32px;
    background: rgba(6, 11, 20, 0.88);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    font-size: 11px;
    flex-shrink: 0;
  }
  .ss-left { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: 0.6px; color: var(--brand); }
  .ss-left span.white { color: #fff; font-weight: 800; }
  .ss-right { display: flex; align-items: center; gap: 8px; }
  .ss-btn {
    background: rgba(20, 241, 217, 0.07);
    border: 1px solid var(--border);
    color: var(--text-main);
    font-size: 10.5px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: 0.15s;
  }
  .ss-btn:hover { border-color: var(--brand); color: var(--brand); }
  .ss-btn.fx-btn {
    background: linear-gradient(90deg, rgba(255, 30, 86, 0.22), rgba(184, 41, 255, 0.22));
    border-color: var(--pink);
    color: #ff99b8;
  }
  .ss-btn.fx-btn:hover { background: var(--pink); color: #fff; }

  /* ОСНОВНАЯ СЕТКА ПРИЛОЖЕНИЯ */
  .app-layout {
    flex: 1;
    display: flex;
    width: 100%;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  /* 1. ЛЕВАЯ КОЛОНКА СЕРВЕРОВ (68px, ШЕСТИУГОЛЬНЫЕ ЗНАЧКИ) */
  .servers-rail {
    width: 68px;
    background: rgba(4, 7, 13, 0.9);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 0;
    gap: 10px;
    overflow-y: auto;
    flex-shrink: 0;
    z-index: 20;
  }
  .servers-rail::-webkit-scrollbar { display: none; }

  .srv-pill-wrap { position: relative; width: 68px; display: flex; justify-content: center; align-items: center; }
  .srv-pill-bar { position: absolute; left: 0; width: 3px; height: 10px; background: var(--brand); box-shadow: 0 0 8px var(--brand); opacity: 0; transition: 0.18s; }
  .srv-pill-wrap:hover .srv-pill-bar { opacity: 1; height: 20px; }
  .srv-pill-wrap.active .srv-pill-bar { opacity: 1; height: 36px; }

  .srv-ico {
    width: 44px;
    height: 44px;
    clip-path: var(--hex);
    background: #0c1626;
    color: var(--text-normal);
    font-weight: 800;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: 0.18s;
  }
  .srv-ico:hover, .srv-pill-wrap.active .srv-ico {
    background: var(--brand);
    color: #031518;
    box-shadow: 0 0 16px rgba(20, 241, 217, 0.6);
    transform: scale(1.05);
  }
  .srv-ico.home-ico { background: #0d1829; color: var(--yellow); font-size: 18px; }
  .srv-ico-action {
    width: 44px;
    height: 44px;
    clip-path: var(--hex);
    background: rgba(255, 30, 86, 0.16);
    color: var(--pink);
    font-size: 20px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: 0.18s;
  }
  .srv-ico-action:hover { background: var(--pink); color: #fff; transform: scale(1.05); }

  /* РАБОЧАЯ ОБЛАСТЬ */
  .workspace {
    flex: 1;
    display: grid;
    grid-template-columns: 250px 1fr 245px;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }
  body.hide-members-panel .workspace { grid-template-columns: 250px 1fr; }
  body.hide-members-panel .right-panel { display: none; }

  /* 2. ЛЕВАЯ КОЛОНКА КАНАЛОВ (250px) */
  .channels-panel {
    background: rgba(6, 11, 20, 0.86);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
  }

  .srv-header {
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .srv-sub-label { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--brand); letter-spacing: 0.8px; }
  .srv-title { font-size: 17px; font-weight: 900; color: #fff; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .srv-badge-open { background: rgba(20, 241, 217, 0.08); border: 1px solid var(--cyan-border); color: var(--brand); font-size: 9.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }

  .packet-card {
    margin: 10px 10px 6px;
    padding: 10px 12px;
    background: linear-gradient(135deg, rgba(255, 30, 86, 0.14), rgba(10, 19, 32, 0.9));
    border: 1px solid var(--pink-border);
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .pk-left { display: flex; flex-direction: column; gap: 2px; }
  .pk-label { font-size: 9px; font-weight: 800; color: var(--text-normal); text-transform: uppercase; }
  .pk-val { font-size: 11px; font-weight: 800; color: #fff; font-family: monospace; }
  .pk-live { font-size: 9.5px; font-weight: 800; color: var(--pink); letter-spacing: 0.5px; }

  .channels-scroll { flex: 1; overflow-y: auto; padding: 6px 10px 12px; }
  .channels-scroll::-webkit-scrollbar { width: 4px; }
  .channels-scroll::-webkit-scrollbar-thumb { background: rgba(20, 241, 217, 0.25); }

  .btn-create-ch-wide {
    width: 100%;
    background: rgba(20, 241, 217, 0.05);
    border: 1px solid var(--border);
    color: var(--text-main);
    font-size: 11px;
    font-weight: 800;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 6px 0 10px;
    letter-spacing: 0.5px;
    transition: 0.15s;
  }
  .btn-create-ch-wide:hover { border-color: var(--brand); color: var(--brand); background: var(--bg-hover); }

  .cat-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 4px 5px; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-muted); }
  .cat-add-btn { background: rgba(20, 241, 217, 0.08); border: 1px solid var(--border); color: var(--brand); width: 20px; height: 20px; border-radius: 4px; font-size: 14px; font-weight: 800; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .cat-add-btn:hover { background: var(--brand); color: #031518; }

  .ch-btn, .voice-ch-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-normal);
    cursor: pointer;
    margin-bottom: 3px;
    border: 1px solid transparent;
    transition: 0.15s;
  }
  .ch-btn:hover, .voice-ch-box:hover { background: var(--bg-hover); color: #fff; }
  .ch-btn.active { background: var(--bg-active); border-color: var(--cyan-border); color: #fff; }
  .voice-ch-box.active { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.45); color: #6ee7b7; }
  .ch-left { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
  .ch-hash { color: var(--brand); font-size: 13px; font-weight: 800; width: 16px; text-align: center; }
  .ch-name-txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch-unread-badge { background: var(--pink); color: #fff; font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; }
  .off-badge { font-size: 9px; color: var(--text-muted); font-weight: 800; }
  .off-badge.on { color: var(--green); }

  .voice-connected-users { display: flex; flex-direction: column; gap: 4px; padding: 2px 0 6px 18px; }
  .voice-connected-users:empty { display: none; }
  .vc-user-row { display: flex; align-items: center; gap: 7px; padding: 3px 6px; border-radius: 4px; font-size: 12px; color: var(--text-normal); cursor: pointer; }
  .vc-user-row:hover { background: var(--bg-hover); }

  /* ГОЛОСОВОЙ ДОК СНИЗУ В ЛЕВОМ СТОЛБЦЕ (КАК В DISCORD) */
  .sidebar-voice-dock {
    background: rgba(6, 16, 26, 0.96);
    border-top: 1px solid var(--cyan-border);
    padding: 9px 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    flex-shrink: 0;
  }
  .svd-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .svd-status { display: flex; flex-direction: column; min-width: 0; }
  .svd-state-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 800; color: var(--green); text-transform: uppercase; letter-spacing: 0.4px; }
  .svd-state-row.idle { color: var(--text-muted); }
  .svd-channel-name { font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .svd-hangup-btn { background: rgba(255, 30, 86, 0.2); border: 1px solid var(--pink); color: #ff80a0; padding: 4px 8px; border-radius: 5px; font-size: 11px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
  .svd-hangup-btn:hover { background: var(--pink); color: #fff; }
  .svd-connect-btn { background: var(--brand); border: none; color: #031518; padding: 5px 10px; border-radius: 5px; font-size: 10.5px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
  .svd-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .svd-btn { background: #0d1829; border: 1px solid var(--border); color: var(--text-normal); padding: 5px 4px; border-radius: 5px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: 0.15s; }
  .svd-btn:hover { border-color: var(--brand); color: #fff; }
  .svd-btn.active-cam { background: rgba(16, 185, 129, 0.25); border-color: var(--green); color: #6ee7b7; }
  .svd-btn.active-screen { background: rgba(255, 30, 86, 0.25); border-color: var(--pink); color: #ffaec2; }

  /* Нижняя панель пользователя (54px) с 6-угольным значком и бейджем справа */
  .user-bar {
    height: 54px;
    padding: 0 10px;
    background: var(--bg-userbar);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-shrink: 0;
  }
  .user-info { display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 6px; cursor: pointer; flex: 1; min-width: 0; }
  .user-info:hover { background: var(--bg-hover); }
  .user-name-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .user-name { font-size: 13px; font-weight: 800; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-sub { font-size: 10px; color: var(--brand); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-bar-controls { display: flex; align-items: center; gap: 4px; }
  .ub-ctrl-btn { width: 30px; height: 30px; clip-path: var(--hex); background: #0d1829; border: none; color: var(--brand); font-size: 13px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .ub-ctrl-btn:hover { background: var(--brand); color: #031518; }
  .ub-ctrl-btn.off { background: rgba(255, 30, 86, 0.25); color: var(--pink); }

  /* 3. ЦЕНТРАЛЬНАЯ ЗОНА */
  .main-chat { background: transparent; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }

  .audio-stream-header-card {
    margin: 10px 14px 4px;
    padding: 10px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-shrink: 0;
  }
  .ash-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ash-title-col { display: flex; flex-direction: column; }
  .ash-label { font-size: 10px; font-weight: 800; color: var(--brand); letter-spacing: 0.8px; text-transform: uppercase; }
  .ash-channel { font-size: 14px; font-weight: 800; color: #fff; }
  .ash-wave { flex: 1; height: 28px; display: flex; align-items: center; justify-content: center; gap: 3px; overflow: hidden; max-width: 420px; }
  .ash-bar { width: 3px; height: 100%; background: var(--brand); border-radius: 2px; opacity: 0.35; transform: scaleY(0.25); transition: 0.2s; }
  body.voice-live .ash-bar { animation: eqPulse 0.9s ease-in-out infinite; box-shadow: 0 0 6px var(--brand); }
  .ash-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  /* СЦЕНА ТРАНСЛЯЦИЙ КАМЕР И ЭКРАНОВ */
  .media-stage-dock {
    margin: 6px 14px;
    background: rgba(5, 10, 18, 0.95);
    border: 1px solid var(--cyan-border);
    border-radius: 10px;
    padding: 10px;
    display: none;
    flex-direction: column;
    gap: 8px;
    max-height: 54vh;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .media-stage-dock.show { display: flex; }
  .msd-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .msd-title { font-size: 11px; font-weight: 800; color: var(--brand); text-transform: uppercase; letter-spacing: 0.6px; }
  .msd-layout-btns { display: flex; gap: 6px; }
  .msd-layout-btn { background: #0d1829; border: 1px solid var(--border); color: var(--text-normal); padding: 3px 9px; border-radius: 4px; font-size: 10.5px; font-weight: 700; cursor: pointer; }
  .msd-layout-btn.active { background: var(--brand); color: #031518; border-color: var(--brand); }

  .screen-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; width: 100%; }
  .screen-grid.spotlight-mode { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .screen-grid.spotlight-mode .screen-card.featured-tile { grid-column: 1 / -1; }
  .screen-card { background: #04070d; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; transition: border-color 0.15s; }
  .screen-card:hover, .screen-card.featured-tile { border-color: var(--brand); }
  .screen-card-head { display: flex; justify-content: space-between; align-items: center; padding: 5px 9px; background: rgba(4, 7, 13, 0.92); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--text-main); gap: 6px; flex-wrap: wrap; }
  .screen-live-pill { background: var(--pink); color: #fff; font-size: 9px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  .screen-live-pill.cam { background: var(--green); color: #031518; }
  .screen-video-wrap { position: relative; width: 100%; background: #000; display: flex; align-items: center; justify-content: center; min-height: 140px; max-height: 290px; overflow: hidden; }
  .screen-card.featured-tile .screen-video-wrap { max-height: 360px; }
  .screen-video-wrap video { width: 100%; max-height: 360px; object-fit: contain; background: #000; display: block; transition: filter 0.25s; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter: blur(26px) brightness(0.3); }
  .media-nsfw-shield { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: rgba(4, 7, 13, 0.85); color: var(--pink); font-size: 12px; font-weight: 800; text-align: center; padding: 14px; z-index: 5; cursor: pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display: flex; }
  .btn-fs { background: #0d1829; border: 1px solid var(--border); color: var(--brand); padding: 3px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; cursor: pointer; }
  .btn-fs.active-shield { background: var(--pink); border-color: var(--pink); color: #fff; }

  /* Лента сообщений */
  .chat-scroll-area { flex: 1; overflow-y: auto; padding: 8px 14px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
  .chat-scroll-area::-webkit-scrollbar { width: 6px; }
  .chat-scroll-area::-webkit-scrollbar-thumb { background: rgba(20, 241, 217, 0.25); border-radius: 3px; }

  .messages-container { display: flex; flex-direction: column; gap: 6px; }
  .msg-item { display: flex; gap: 12px; padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; }
  body.compact-chat .msg-item { padding: 4px 10px; }
  .msg-head-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .msg-author { font-size: 13.5px; font-weight: 800; color: var(--brand); cursor: pointer; }
  .msg-author:hover { text-decoration: underline; }
  .msg-time { font-size: 10.5px; color: var(--text-muted); font-family: monospace; }
  .msg-text { font-size: var(--chat-font-size); color: var(--text-main); margin-top: 3px; line-height: 1.4; user-select: text; word-break: break-word; }
  .msg-text a { color: var(--brand); text-decoration: none; border-bottom: 1px dashed var(--brand); }
  .chat-inline-media { max-width: min(100%, 420px); max-height: 260px; border-radius: 6px; margin-top: 6px; display: block; border: 1px solid var(--cyan-border); }

  .filtered-block-card { display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 30, 86, 0.12); border: 1px dashed var(--pink-border); color: #ff80a0; padding: 6px 10px; border-radius: 6px; font-size: 12px; margin-top: 4px; }
  .spoiler-blur-wrap { position: relative; display: inline-block; width: 100%; background: #060b14; border: 1px solid var(--pink-border); border-radius: 6px; padding: 8px 10px; margin-top: 4px; cursor: pointer; }
  .spoiler-blur-content { filter: blur(8px); user-select: none; pointer-events: none; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter: none; user-select: text; pointer-events: auto; }
  .spoiler-badge { font-size: 11px; font-weight: 700; color: var(--pink); margin-bottom: 4px; }
  .spoiler-blur-wrap.revealed .spoiler-badge { display: none; }

  /* НИЖНЯЯ КОНСОЛЬ ВВОДА */
  .chat-bottom { padding: 6px 14px 10px; flex-shrink: 0; }
  .console-box { background: var(--bg-card); border: 1px solid var(--cyan-border); border-radius: 8px; padding: 6px 12px 8px; display: flex; flex-direction: column; gap: 5px; }
  .console-top-label { display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; font-weight: 800; color: var(--text-muted); letter-spacing: 0.8px; text-transform: uppercase; }
  .input-row { display: flex; align-items: center; gap: 10px; }
  .chat-inp { flex: 1; min-width: 0; background: #050a12; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text-main); font-size: 13.5px; outline: none; }
  .chat-inp:focus { border-color: var(--brand); }

  /* 4. ПРАВАЯ КОЛОНКА УЧАСТНИКОВ (245px) */
  .right-panel {
    width: 245px;
    background: rgba(6, 11, 20, 0.86);
    border-left: 1px solid var(--border);
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    height: 100%;
  }
  .right-panel::-webkit-scrollbar { width: 4px; }
  .right-panel::-webkit-scrollbar-thumb { background: rgba(20, 241, 217, 0.25); }

  .telemetry-mini-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; margin-bottom: 6px; font-size: 10.5px; }
  .tm-row { display: flex; justify-content: space-between; color: var(--text-normal); margin-top: 4px; font-family: monospace; }
  .tm-val { color: var(--brand); font-weight: 700; }

  .right-sec-title { font-size: 10.5px; text-transform: uppercase; color: var(--brand); font-weight: 800; padding: 8px 6px 4px; letter-spacing: 0.7px; }
  .online-user-item { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 6px; cursor: pointer; min-width: 0; transition: 0.15s; }
  .online-user-item:hover { background: var(--bg-hover); }
  .member-text-col { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
  .member-nick-row { display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 700; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .member-status-sub { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mini-btn { background: rgba(20, 241, 217, 0.08); border: 1px solid var(--border); color: var(--brand); padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
  .mini-btn:hover { background: var(--brand); color: #031518; }
  .friend-tag { font-size: 9.5px; color: var(--green); font-weight: 800; }

  /* ВЫЕЗЖАЮЩИЙ СПРАВА ПРОФИЛЬ УЧАСТНИКА (DISCORD SLIDE-OUT DRAWER) */
  .profile-drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(2, 5, 10, 0.55);
    backdrop-filter: blur(2px);
    z-index: 970;
    display: none;
  }
  .profile-drawer-backdrop.open { display: block; }
  .profile-slide-drawer {
    position: fixed;
    top: 40px;
    right: 0;
    bottom: 24px;
    width: 350px;
    max-width: 92vw;
    z-index: 975;
    transform: translateX(106%);
    transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex;
    flex-direction: column;
    padding: 12px;
    pointer-events: none;
  }
  .profile-slide-drawer.open {
    transform: translateX(0);
    pointer-events: auto;
  }
  .psd-inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .dp-banner { height: 105px; background: linear-gradient(90deg, var(--brand), var(--pink)); position: relative; flex-shrink: 0; }
  .dp-close-x {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: rgba(4, 7, 13, 0.75);
    border: 1px solid var(--border);
    color: #fff;
    font-weight: 800;
    cursor: pointer;
  }
  .dp-body { padding: 40px 16px 16px; position: relative; flex: 1; display: flex; flex-direction: column; gap: 10px; }
  .dp-ava-pos { position: absolute; top: -34px; left: 16px; width: 68px; height: 68px; }
  .dp-nick-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dp-nick { font-size: 18px; font-weight: 900; color: #fff; }
  .dp-status { font-size: 12.5px; color: var(--brand); }
  .dp-sec { background: rgba(4, 7, 13, 0.65); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 8px; padding: 10px 12px; }
  .dp-sec-title { font-size: 10px; font-weight: 800; color: var(--brand); margin-bottom: 5px; letter-spacing: 0.6px; text-transform: uppercase; }
  .dp-bio { font-size: 12.5px; color: var(--text-normal); white-space: pre-wrap; line-height: 1.4; }
  .dp-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
  .dp-tag { background: rgba(20, 241, 217, 0.12); border: 1px solid var(--border); color: var(--brand); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .dp-actions-col { display: flex; flex-direction: column; gap: 7px; margin-top: auto; padding-top: 10px; }
  .status-pill { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 800; }
  .status-pill.on { background: rgba(16, 185, 129, 0.18); color: var(--green); }
  .status-pill.off { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }

  /* НИЖНЯЯ СТРОКА СТАТУСА СЕТИ */
  .bottom-status-footer {
    height: 24px;
    background: #03060b;
    border-top: 1px solid var(--border);
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    font-family: monospace;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .bsf-green { color: var(--brand); font-weight: 700; }

  /* Кнопки */
  .btn-cyan { background: var(--brand); color: #031518; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 800; font-size: 11.5px; text-transform: uppercase; cursor: pointer; white-space: nowrap; transition: 0.15s; }
  .btn-cyan:hover { background: var(--brand-hover); box-shadow: 0 0 12px rgba(20, 241, 217, 0.5); }
  .btn-danger { background: var(--pink); color: #fff; border: none; padding: 7px 12px; border-radius: 6px; font-weight: 800; font-size: 11.5px; text-transform: uppercase; cursor: pointer; }
  .btn-login-mini { background: #0d1829; border: 1px solid var(--border); color: var(--brand); padding: 6px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
  .btn-login-mini:hover { border-color: var(--brand); background: var(--bg-hover); }
  .btn-tg { background: var(--brand); color: #031518; border: none; width: 100%; padding: 10px 14px; border-radius: 6px; font-weight: 800; font-size: 12.5px; text-transform: uppercase; cursor: pointer; margin-bottom: 10px; }

  /* Плавающий виджет звонка */
  .floating-call-overlay { position: fixed; right: 18px; bottom: 40px; width: 285px; background: rgba(5, 9, 16, 0.96); border: 1px solid var(--brand); border-radius: 8px; padding: 10px 12px; z-index: 980; box-shadow: 0 0 25px rgba(20, 241, 217, 0.25); display: none; flex-direction: column; gap: 8px; }
  .floating-call-overlay.show { display: flex; }
  .fco-head { display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .fco-live { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; color: var(--green); }
  .fco-pulse { width: 8px; height: 8px; clip-path: var(--hex); background: var(--green); }
  .fco-timer { font-size: 11px; font-family: monospace; color: var(--brand); }
  .fco-peers { display: flex; flex-wrap: wrap; gap: 5px; max-height: 70px; overflow-y: auto; }
  .fco-peer-chip { display: inline-flex; align-items: center; gap: 5px; background: #0d1829; border: 1px solid var(--border); padding: 3px 8px; border-radius: 4px; font-size: 11px; color: #fff; }
  .fco-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
  .fco-btn { background: #0d1829; border: 1px solid var(--border); color: var(--brand); padding: 6px 4px; border-radius: 4px; font-size: 10.5px; font-weight: 700; cursor: pointer; }
  .fco-btn.danger { background: var(--pink); border-color: var(--pink); color: #fff; }

  /* Модальные окна */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(2, 5, 10, 0.84); backdrop-filter: blur(5px); display: none; align-items: center; justify-content: center; z-index: 999; padding: 12px; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background-color: #070d17; background-image: var(--pcb-pattern); border: 1px solid var(--brand); border-radius: 10px; padding: 20px; width: 400px; max-width: 100%; box-shadow: 0 0 35px rgba(20, 241, 217, 0.2); }
  .modal-box input[type="text"], .modal-box input[type="password"], .modal-box textarea, .modal-box select { width: 100%; padding: 10px; background: #040810; border: 1px solid var(--border); border-radius: 6px; color: #fff; margin-bottom: 10px; font-size: 13px; outline: none; }
  .link-box { background: #040810; border: 1px dashed var(--brand); padding: 10px; color: var(--brand); font-size: 12px; word-break: break-all; margin-bottom: 10px; border-radius: 6px; display: block; text-align: center; text-decoration: none; }
  .auth-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 12px; background: #040810; padding: 4px; border-radius: 6px; border: 1px solid var(--border); }
  .auth-tab { padding: 7px; font-size: 12px; font-weight: 700; text-align: center; cursor: pointer; color: var(--text-muted); border-radius: 4px; }
  .auth-tab.active { background: var(--brand); color: #031518; }

  .settings-modal-box { background-color: #070d17; background-image: var(--pcb-pattern); border: 1px solid var(--brand); border-radius: 10px; width: 880px; max-width: 100%; height: 630px; max-height: 92vh; display: grid; grid-template-columns: 225px minmax(0, 1fr); overflow: hidden; }
  .settings-nav { background: #050911; border-right: 1px solid var(--border); padding: 16px 10px; display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
  .settings-nav-label { font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--brand); padding: 8px 10px 4px; letter-spacing: 0.8px; }
  .settings-nav-btn { padding: 8px 10px; border-radius: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .settings-nav-btn:hover { background: var(--bg-hover); color: var(--text-main); }
  .settings-nav-btn.active { background: var(--bg-active); color: var(--brand); border-left: 2px solid var(--brand); }
  .settings-content { padding: 20px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .settings-pane { display: none; flex-direction: column; gap: 12px; min-width: 0; }
  .settings-pane.active { display: flex; }
  .settings-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 10px; flex-wrap: wrap; }
  .settings-head h3 { font-size: 16px; font-weight: 800; color: var(--brand); text-transform: uppercase; }
  .field-label { font-size: 10.5px; font-weight: 800; text-transform: uppercase; color: var(--brand); margin-bottom: 6px; display: block; }
  .settings-card { background: rgba(4, 8, 16, 0.88); border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .settings-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; width: 100%; }
  .settings-card input[type="text"], .settings-card textarea, .settings-card select { width: 100%; min-width: 0; padding: 8px 10px; background: #03060c; border: 1px solid var(--border); border-radius: 6px; color: #fff; font-size: 13px; outline: none; margin: 0; }
  .toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-title { font-size: 13px; font-weight: 600; color: #fff; }
  .cyber-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; cursor: pointer; }
  .cyber-switch input { opacity: 0; width: 0; height: 0; }
  .cyber-slider { position: absolute; inset: 0; background: #101929; border: 1px solid var(--border); border-radius: 20px; transition: 0.2s; }
  .cyber-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: var(--text-muted); clip-path: var(--hex); transition: 0.2s; }
  .cyber-switch input:checked + .cyber-slider { background: rgba(20, 241, 217, 0.22); border-color: var(--brand); }
  .cyber-switch input:checked + .cyber-slider::before { transform: translateX(18px); background: var(--brand); }
  .cyber-range { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: #03060c; border: 1px solid var(--border); border-radius: 4px; outline: none; margin-top: 4px; }
  .cyber-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; clip-path: var(--hex); background: var(--brand); cursor: pointer; }
  .color-swatches { display: flex; gap: 8px; flex-wrap: wrap; }
  .color-swatch { width: 26px; height: 26px; clip-path: var(--hex); cursor: pointer; }
  .mic-meter-wrap { width: 100%; height: 8px; background: #03060c; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .mic-meter-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--green), var(--brand), var(--pink)); transition: width 0.06s; }

  /* КАРТОЧКИ 3 КИБЕРПАНК-НАБОРОВ ВО ВКЛАДКЕ "ЭФФЕКТЫ" */
  .fx-sets-grid { display: flex; flex-direction: column; gap: 12px; }
  .fx-bundle-card {
    position: relative;
    border-radius: 10px;
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border: 1px solid var(--border);
    background: rgba(5, 10, 18, 0.92);
    transition: 0.2s;
  }
  .fx-bundle-card.set1-card {
    border-color: rgba(252, 238, 9, 0.6);
    background: linear-gradient(135deg, rgba(252, 238, 9, 0.12), rgba(0, 255, 157, 0.08), rgba(5, 10, 18, 0.95));
  }
  .fx-bundle-card.set2-card {
    border-color: rgba(184, 41, 255, 0.65);
    background: linear-gradient(135deg, rgba(184, 41, 255, 0.16), rgba(0, 240, 255, 0.08), rgba(5, 10, 18, 0.95));
  }
  .fx-bundle-card.set3-card {
    border-color: rgba(255, 0, 60, 0.65);
    background: linear-gradient(135deg, rgba(255, 0, 60, 0.16), rgba(20, 241, 217, 0.08), rgba(5, 10, 18, 0.95));
  }
  .fxb-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
  .fxb-items- pills { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .fxb-pill { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--text-normal); }

  /* ГОРЯЧИЕ КЛАВИШИ (KEYBIND RECORDER) */
  .keybind-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 12px;
    background: #040810;
    border: 1px solid var(--border);
    border-radius: 6px;
    gap: 10px;
  }
  .kb-btn {
    background: #0d1829;
    border: 1px solid var(--cyan-border);
    color: var(--brand);
    font-family: monospace;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 14px;
    border-radius: 5px;
    cursor: pointer;
    min-width: 140px;
    text-align: center;
  }
  .kb-btn.recording {
    background: rgba(255, 30, 86, 0.25);
    border-color: var(--pink);
    color: #fff;
    animation: glitchPulse 1s infinite;
  }

  .mob-top-btn { display: none; background: transparent; border: none; color: var(--brand); font-size: 20px; cursor: pointer; }
  .mob-drawer-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.72); z-index: 940; }
  .mob-bottom-nav { display: none; height: 52px; background: #04070d; border-top: 1px solid var(--border); grid-template-columns: repeat(5, 1fr); align-items: center; flex-shrink: 0; z-index: 960; }
  .mob-nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 100%; color: var(--text-muted); font-size: 10px; font-weight: 700; cursor: pointer; }
  .mob-nav-item.active { color: var(--brand); background: rgba(20, 241, 217, 0.08); }

  @media (max-width: 900px) {
    .tt-proto-pill, .ash-wave, .bottom-status-footer { display: none; }
    .workspace { display: flex; flex-direction: column; flex: 1; }
    .main-chat { flex: 1; width: 100%; height: 100%; }
    .mob-top-btn { display: inline-flex; }
    .mob-bottom-nav { display: grid; }
    .servers-rail { position: fixed; top: 0; bottom: 52px; left: 0; width: 68px; z-index: 955; transform: translateX(-340px); transition: transform 0.24s; }
    .channels-panel { position: fixed; top: 0; bottom: 52px; left: 68px; width: calc(100vw - 68px); max-width: 260px; z-index: 955; transform: translateX(-340px); transition: transform 0.24s; }
    body.mob-left-open .servers-rail, body.mob-left-open .channels-panel, body.mob-right-open .right-panel { transform: translateX(0); }
    .right-panel { position: fixed; top: 0; bottom: 52px; right: 0; width: min(86vw, 280px); z-index: 955; transform: translateX(105%); transition: transform 0.24s; }
    body.mob-left-open .mob-drawer-backdrop, body.mob-right-open .mob-drawer-backdrop { display: block; }
    .chat-inp { font-size: 16px; }
    .floating-call-overlay { right: 10px; left: 10px; width: auto; bottom: 60px; }
    .settings-modal-box { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: 92dvh; }
    .settings-nav { flex-direction: row; overflow-x: auto; padding: 8px; }
    .settings-nav-label { display: none; }
    .settings-grid-2, .fx-bundle-card { grid-template-columns: 1fr; flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>
  <!-- 1. ВЕРХНЯЯ ТЕЛЕМЕТРИЧЕСКАЯ ШАПКА -->
  <div class="top-telemetry-bar">
    <div class="tt-left">
      <button class="mob-top-btn" onclick="toggleMobileLeft()">☰</button>
      <div class="tt-logo"><span class="tt-logo-bolt">⚡</span><span>СИГНАЛ</span></div>
      <span class="tt-cyber-tag">CYBER.NET</span>
      <span class="tt-proto-pill">МЕСТО ДЛЯ СВОИХ // P2P ПРОТОКОЛ</span>
    </div>
    <div class="tt-right">
      <div class="tt-node-pill"><span class="tt-node-dot"></span><span id="tt-node-label">Узел активен • cy-4371</span></div>
      <button class="tt-invite-btn" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА</button>
    </div>
  </div>

  <!-- 2. ВТОРАЯ СТРОКА P2P СИНХРОНИЗАЦИИ (БЕЗ ДУБЛИРУЮЩИХ ВКЛАДОК) -->
  <div class="sub-sync-bar">
    <div class="ss-left">
      <span>● АКТИВНАЯ СЕТЬ:</span>
      <span class="white">P2P СИНХРОНИЗАЦИЯ</span>
    </div>
    <div class="ss-right">
      <button class="ss-btn fx-btn" onclick="openSettingsModal('fx')">✨ ЭФФЕКТЫ</button>
      <button class="ss-btn" onclick="openSettingsModal('keybinds')">⌨️ БИНДЫ</button>
      <button class="ss-btn" onclick="openSettingsModal('profile')">👤 ПРОФИЛЬ</button>
      <button class="ss-btn" onclick="if(window.innerWidth<=900)toggleMobileRight();else document.body.classList.toggle('hide-members-panel');">👥 УЧАСТНИКИ</button>
    </div>
  </div>

  <!-- 3. ОСНОВНАЯ РАБОЧАЯ ОБЛАСТЬ -->
  <div class="app-layout">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>

    <!-- ЛЕВАЯ РЕЛЬСА СЕРВЕРОВ -->
    <div class="servers-rail">
      <div class="srv-pill-wrap" title="Мой профиль и эффекты" onclick="openSettingsModal('fx')">
        <span class="srv-pill-bar"></span>
        <div class="srv-ico home-ico">⚡</div>
      </div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;width:100%;"></div>
      <div class="srv-ico-action" title="Создать новый сервер" onclick="openCreateServerModal()">+</div>
    </div>

    <div class="workspace">
      <!-- ЛЕВАЯ КОЛОНКА КАНАЛОВ + ГОЛОСОВОЙ ДОК СНИЗУ -->
      <div class="channels-panel">
        <div class="srv-header">
          <div style="min-width:0;">
            <div class="srv-sub-label">ОТКРЫТЫЙ СЕРВЕР</div>
            <div class="srv-title" id="srv-title-label">Ночной клуб</div>
          </div>
          <span class="srv-badge-open" onclick="openInviteModal()">Ссылка</span>
        </div>

        <div class="packet-card">
          <div class="pk-left">
            <span class="pk-label">ОЧЕРЕДЬ ПАКЕТОВ</span>
            <span class="pk-val">108.4 FM // P2P</span>
          </div>
          <span class="pk-live">▲ LIVE</span>
        </div>

        <div class="channels-scroll">
          <div class="cat-header">
            <span>◈ ТЕКСТОВЫЕ КАНАЛЫ</span>
            <button class="cat-add-btn" title="Создать текстовый канал" onclick="openCreateChannelModal('text')">+</button>
          </div>
          <div id="text-channels-list"></div>

          <button class="btn-create-ch-wide" onclick="openCreateChannelModal('text')">
            <span>СОЗДАТЬ НОВЫЙ КАНАЛ</span>
            <span style="color:var(--brand);">+</span>
          </button>

          <div class="cat-header" style="margin-top:6px;">
            <span>🔊 ГОЛОСОВЫЕ КАНАЛЫ</span>
            <button class="cat-add-btn" title="Создать голосовой канал" onclick="openCreateChannelModal('voice')">+</button>
          </div>
          <div id="voice-channels-list"></div>
          <div class="voice-connected-users" id="sidebar-voice-peers"></div>
        </div>

        <!-- ГОЛОСОВОЙ БЛОК В ЛЕВОМ СТОЛБЦЕ СНИЗУ КАК В DISCORD -->
        <div class="sidebar-voice-dock" id="voice-panel-card">
          <div class="svd-top">
            <div class="svd-status">
              <div class="svd-state-row idle" id="svd-state-text">📡 ГОЛОСОВОЙ КАНАЛ</div>
              <div class="svd-channel-name" id="voice-panel-title">Ночной эфир</div>
            </div>
            <button class="svd-connect-btn" id="connect-voice-btn" onclick="toggleVoiceCall()">ВОЙТИ</button>
          </div>
          <div class="svd-actions">
            <button class="svd-btn" id="cam-btn" onclick="toggleWebcam()" title="Включить камеру">📷 Камера</button>
            <button class="svd-btn" id="screen-btn" onclick="toggleScreenShare()" title="Демонстрация экрана">🖥️ Экран</button>
            <button class="svd-btn" id="pip-overlay-btn" onclick="toggleExternalOverlay()" title="Оверлей поверх окон">🪟 Оверлей</button>
          </div>
          <div id="audio-box" style="display:none;"></div>
        </div>

        <!-- НИЖНИЙ БАР ПОЛЬЗОВАТЕЛЯ С 6-УГОЛЬНЫМ ЗНАЧКОМ И БЕЙДЖЕМ СПРАВА -->
        <div class="user-bar">
          <div class="user-info" onclick="openUserProfileCard(getMyMemberObject())">
            <div class="hex-wrap" id="user-ava-wrap" style="width:36px;height:36px;">
              <div class="hex-border">
                <div class="hex-core" id="user-ava" style="font-size:11px;">ГО</div>
              </div>
              <span class="hex-status-dot" id="user-presence-dot"></span>
            </div>
            <div style="overflow:hidden;min-width:0;flex:1;">
              <div class="user-name-row">
                <span class="user-name" id="user-name-label">Гость</span>
                <span id="user-bar-badge-slot"></span>
              </div>
              <div class="user-sub" id="user-email-label">В сети</div>
            </div>
          </div>
          <div class="user-bar-controls">
            <button class="ub-ctrl-btn" id="mute-btn" title="Микрофон вкл/выкл" onclick="if(inVoice)toggleMute();else toggleVoiceCall();">🎤</button>
            <button class="ub-ctrl-btn" id="deafen-btn" title="Звук вкл/выкл" onclick="if(inVoice)toggleDeafen();else openSettingsModal('voice');">🎧</button>
            <button class="ub-ctrl-btn" title="Настройки и эффекты" onclick="openSettingsModal('profile')">⚙️</button>
          </div>
        </div>
      </div>

      <!-- ЦЕНТРАЛЬНАЯ КОЛОНКА -->
      <div class="main-chat">
        <div class="audio-stream-header-card">
          <div class="ash-left">
            <span style="color:var(--brand);font-size:18px;font-weight:900;">#</span>
            <div class="ash-title-col">
              <span class="ash-label" id="top-ch-desc">АКТИВНЫЙ АУДИО ПОТОК // КАНАЛ</span>
              <span class="ash-channel" id="top-ch-name">общий</span>
            </div>
          </div>
          <div class="ash-wave">
            <div class="ash-bar" style="animation-delay:0.0s"></div><div class="ash-bar" style="animation-delay:0.2s"></div><div class="ash-bar" style="animation-delay:0.4s"></div><div class="ash-bar" style="animation-delay:0.1s"></div><div class="ash-bar" style="animation-delay:0.3s"></div><div class="ash-bar" style="animation-delay:0.5s"></div><div class="ash-bar" style="animation-delay:0.15s"></div><div class="ash-bar" style="animation-delay:0.35s"></div><div class="ash-bar" style="animation-delay:0.05s"></div><div class="ash-bar" style="animation-delay:0.25s"></div><div class="ash-bar" style="animation-delay:0.45s"></div><div class="ash-bar" style="animation-delay:0.12s"></div><div class="ash-bar" style="animation-delay:0.32s"></div><div class="ash-bar" style="animation-delay:0.52s"></div><div class="ash-bar" style="animation-delay:0.18s"></div><div class="ash-bar" style="animation-delay:0.38s"></div><div class="ash-bar" style="animation-delay:0.08s"></div><div class="ash-bar" style="animation-delay:0.28s"></div><div class="ash-bar" style="animation-delay:0.48s"></div><div class="ash-bar" style="animation-delay:0.22s"></div>
          </div>
          <div class="ash-right">
            <button class="btn-login-mini" onclick="openSettingsModal('fx')">✨ Эффекты</button>
            <button class="btn-login-mini" onclick="openSettingsModal('safety')">🛡️ Фильтр 18+</button>
          </div>
        </div>

        <!-- ОБЪЕДИНЁННАЯ ОБЛАСТЬ ТРАНСЛЯЦИЙ КАМЕР И ЭКРАНОВ -->
        <div class="media-stage-dock" id="media-stage-dock">
          <div class="msd-header">
            <span class="msd-title">📹 АКТИВНЫЕ ТРАНСЛЯЦИИ В КАНАЛЕ (КЛИК ПО ОКНУ — УВЕЛИЧИТЬ)</span>
            <div class="msd-layout-btns">
              <button class="msd-layout-btn active" id="btn-stage-grid" onclick="setStageLayout('grid')">⊞ Сетка (Все окна)</button>
              <button class="msd-layout-btn" id="btn-stage-spot" onclick="setStageLayout('spotlight')">⊡ Фокус (Сцена)</button>
            </div>
          </div>
          <div class="screen-grid" id="screen-grid"></div>
        </div>

        <!-- Лента сообщений -->
        <div class="chat-scroll-area" id="chat-scroll">
          <div class="messages-container" id="messages-list"></div>
        </div>

        <!-- Консоль ввода сообщения -->
        <div class="chat-bottom">
          <div class="console-box">
            <div class="console-top-label">
              <span>ОКНО ВВОДА // КОНСОЛЬ</span>
              <span id="banner-desc">P2P КАНАЛ АКТИВЕН</span>
            </div>
            <form class="input-row" onsubmit="sendChatMessage(event)">
              <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение в #общий..." autocomplete="off" maxlength="1000">
              <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
            </form>
          </div>
        </div>
      </div>

      <!-- ПРАВАЯ КОЛОНКА УЧАСТНИКОВ (245px) -->
      <div class="right-panel">
        <div class="telemetry-mini-card">
          <div style="font-size:9.5px;font-weight:800;color:var(--brand);letter-spacing:0.6px;">СТАТИСТИКА КАНАЛА</div>
          <div class="tm-row"><span>P2P Stability:</span><span class="tm-val">99.8%</span></div>
          <div class="tm-row"><span>Latency:</span><span class="tm-val">18ms</span></div>
        </div>

        <div class="right-sec-title">⬢ В сети — <span id="online-count">1</span></div>
        <div id="online-users-box"></div>

        <div class="right-sec-title" id="offline-sec-header">⬡ Не в сети — <span id="total-members-count">0</span></div>
        <div id="offline-users-box"></div>

        <div class="right-sec-title" style="margin-top:6px;">◈ Друзья — <span id="friends-count">0</span></div>
        <div id="requests-box"></div>
        <div id="friends-box"></div>
      </div>
    </div>
  </div>

  <!-- 4. ВЫЕЗЖАЮЩАЯ СПРАВА КАРТОЧКА ПРОФИЛЯ УЧАСТНИКА (DISCORD-STYLE DRAWER) -->
  <div class="profile-drawer-backdrop" id="view-profile-backdrop" onclick="closeViewProfileModal()"></div>
  <div class="profile-slide-drawer" id="view-profile-drawer">
    <div class="profile-surface psd-inner" id="vp-surface">
      <div class="dp-banner" id="vp-banner">
        <button class="dp-close-x" onclick="closeViewProfileModal()">✕</button>
      </div>
      <div class="dp-body">
        <div class="hex-wrap dp-ava-pos" id="vp-ava-wrap">
          <div class="hex-border"><div class="hex-core" id="vp-ava" style="font-size:20px;">УЧ</div></div>
          <span class="hex-status-dot" id="vp-status-dot"></span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="dp-nick-line">
            <span class="dp-nick" id="vp-nick">Участник</span>
            <span id="vp-badge-slot"></span>
          </div>
          <span class="status-pill on" id="vp-online-pill">ОНЛАЙН</span>
        </div>
        <div class="dp-status" id="vp-status"></div>

        <div class="dp-sec">
          <div class="dp-sec-title">ОБО МНЕ // ДОСЬЕ</div>
          <div class="dp-bio" id="vp-bio"></div>
        </div>

        <div class="dp-sec">
          <div class="dp-sec-title">ИНТЕРЕСЫ И ТЕГИ</div>
          <div class="dp-tags" id="vp-tags"></div>
        </div>

        <div class="dp-sec">
          <div class="dp-sec-title">АКТИВНЫЙ НАБОР ЭФФЕКТОВ</div>
          <div style="font-size:12px;color:var(--text-normal);font-weight:700;" id="vp-fx-label">Стандартный кибер-контур</div>
        </div>

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

  <!-- 5. НИЖНЯЯ СТРОКА ТЕЛЕМЕТРИИ -->
  <div class="bottom-status-footer">
    <span id="footer-keybind-hint">ГОРЯЧИЕ КЛАВИШИ АКТИВНЫ // НАСТРОЙКА В БИНДАХ</span>
    <span class="bsf-green">P2P ONLINE // Secure // E2EE // Latency 18ms</span>
  </div>

  <!-- Плавающий мини-виджет звонка -->
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
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span class="ico">◈</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="toggleMobileLeft()"><span class="ico">🔊</span><span>Голос</span></div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()"><span class="ico">⬢</span><span>Участники</span></div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('fx')"><span class="ico">✨</span><span>Эффекты</span></div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО НАСТРОЕК (С ВКЛАДКАМИ "ЭФФЕКТЫ" И "ГОРЯЧИЕ КЛАВИШИ") -->
  <div class="modal-backdrop" id="settings-modal" onclick="if(event.target===this)closeSettingsModal()">
    <div class="settings-modal-box">
      <div class="settings-nav">
        <div class="settings-nav-label">Профиль и кастомизация</div>
        <div class="settings-nav-btn active" data-pane="profile" onclick="switchSettingsPane('profile')">⬢ Мой профиль</div>
        <div class="settings-nav-btn" data-pane="fx" onclick="switchSettingsPane('fx')">✨ Эффекты (3 набора)</div>
        <div class="settings-nav-btn" data-pane="keybinds" onclick="switchSettingsPane('keybinds')">⌨️ Горячие клавиши</div>
        <div class="settings-nav-btn" data-pane="account" onclick="switchSettingsPane('account')">🔑 Учётная запись</div>
        <div class="settings-nav-label">Безопасность</div>
        <div class="settings-nav-btn" data-pane="safety" onclick="switchSettingsPane('safety')">🛡️ Фильтр 18+</div>
        <div class="settings-nav-label">Система</div>
        <div class="settings-nav-btn" data-pane="voice" onclick="switchSettingsPane('voice')">🎙️ Голос и видео</div>
        <div class="settings-nav-btn" data-pane="appearance" onclick="switchSettingsPane('appearance')">🎨 Внешний вид</div>
        <div class="settings-nav-btn" data-pane="notifications" onclick="switchSettingsPane('notifications')">🔔 Уведомления</div>
        <div style="margin-top:auto;padding-top:10px;"><button class="btn-login-mini" style="width:100%;" onclick="closeSettingsModal()">✕ ЗАКРЫТЬ (ESC)</button></div>
      </div>
      <div class="settings-content">
        <!-- Вкладка 1: Профиль -->
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head"><h3>⬢ Мой профиль</h3><button class="btn-cyan" onclick="saveProfileSettings()">СОХРАНИТЬ</button></div>
          <div class="profile-surface" id="preview-surface">
            <div class="dp-banner" id="preview-banner" style="height:75px;"></div>
            <div class="dp-body" style="padding-top:36px;">
              <div class="hex-wrap dp-ava-pos" id="preview-ava-wrap" style="width:60px;height:60px;top:-30px;">
                <div class="hex-border"><div class="hex-core" id="preview-ava" style="font-size:18px;">ГО</div></div>
              </div>
              <div class="dp-nick-line">
                <span class="dp-nick" id="preview-nick">Гость</span>
                <span id="preview-badge-slot"></span>
              </div>
              <div class="dp-status" id="preview-status"></div>
              <div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ</div><div class="dp-bio" id="preview-bio"></div></div>
              <div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="preview-tags"></div></div>
            </div>
          </div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <div><label class="field-label">Позывной (Никнейм)</label><input type="text" id="prof-nick-inp" maxlength="24" oninput="updateProfilePreview()"></div>
              <div><label class="field-label">Статус присутствия</label><select id="prof-presence-sel" onchange="updateProfilePreview()"><option value="online">⬢ В сети</option><option value="idle">🌙 Не активен</option><option value="dnd">⛔ Не беспокоить</option><option value="invisible">⬡ Невидимка</option></select></div>
            </div>
            <div><label class="field-label">Пользовательский статус</label><input type="text" id="prof-status-inp" maxlength="60" oninput="updateProfilePreview()"></div>
            <div><label class="field-label">О себе</label><textarea id="prof-bio-inp" rows="2" maxlength="220" oninput="updateProfilePreview()"></textarea></div>
            <div><label class="field-label">Интересы (через запятую)</label><input type="text" id="prof-interests-inp" maxlength="140" oninput="updateProfilePreview()"></div>
            <div class="settings-grid-2">
              <div><label class="field-label">Цвет баннера</label><div class="color-swatches"><div class="color-swatch" style="background:#14f1d9;" onclick="selectBannerColor('#14f1d9')"></div><div class="color-swatch" style="background:#ff1e56;" onclick="selectBannerColor('#ff1e56')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectBannerColor('#10b981')"></div><div class="color-swatch" style="background:#fcee09;" onclick="selectBannerColor('#fcee09')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectBannerColor('#b829ff')"></div></div></div>
              <div><label class="field-label">Цвет 6-угольника аватара</label><div class="color-swatches"><div class="color-swatch" style="background:#ff1e56;" onclick="selectAvatarColor('#ff1e56')"></div><div class="color-swatch" style="background:#14f1d9;" onclick="selectAvatarColor('#14f1d9')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectAvatarColor('#10b981')"></div><div class="color-swatch" style="background:#fcee09;" onclick="selectAvatarColor('#fcee09')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectAvatarColor('#b829ff')"></div></div></div>
            </div>
          </div>
        </div>

        <!-- Вкладка 2: ✨ ЭФФЕКТЫ (3 ТЕМАТИЧЕСКИХ НАБОРА В ПОДАРОК) -->
        <div class="settings-pane" id="pane-fx">
          <div class="settings-head">
            <h3>✨ Эффекты профиля, аватара и бейджа</h3>
            <button class="btn-login-mini" id="btn-disable-fx" onclick="selectEffectSet('')">Отключить эффекты</button>
          </div>
          <div style="font-size:12px;color:var(--text-normal);">Выберите любой из 3 коллекционных наборов бесплатно в подарок. Каждый набор активирует анимацию 6-угольного значка, анимированный бейдж справа от ника, неоновую рамку профиля и живой фон карточки:</div>

          <div class="fx-sets-grid">
            <!-- Набор 1: Edgerunners Сезон 1 -->
            <div class="fx-bundle-card set1-card">
              <div class="fxb-left">
                <div class="hex-wrap fx-set1" style="width:64px;height:64px;">
                  <div class="hex-border"><div class="hex-core" style="font-size:18px;background:#10b981;color:#04120c;">DL</div></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#fcee09;">Набор 1: Edgerunners // Сезон 1 (Дэвид и Люси)</span>
                    <span class="cyber-badge b-set1">⚡ SANDY</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:3px;">Жёлто-изумрудный импульс импланта Сандевистан вокруг 6-угольника, купол Луны для Люси на фоне профиля и бейдж «⚡ SANDY».</div>
                  <div class="fxb-items-pills">
                    <span class="fxb-pill">⬢ Аватар: Сандевистан</span>
                    <span class="fxb-pill">🏷️ Бейдж: ⚡ SANDY</span>
                    <span class="fxb-pill">🖼️ Фон и рамка: Луна (Дэвид и Люси)</span>
                  </div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set1" onclick="selectEffectSet('set1')">🎁 ЗАБРАТЬ НАБОР</button>
            </div>

            <!-- Набор 2: Edgerunners Сезон 2 -->
            <div class="fx-bundle-card set2-card">
              <div class="fxb-left">
                <div class="hex-wrap fx-set2" style="width:64px;height:64px;">
                  <div class="hex-border"><div class="hex-core" style="font-size:18px;background:#b829ff;">NX</div></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#e08aff;">Набор 2: Edgerunners // Сезон 2 (Новое поколение)</span>
                    <span class="cyber-badge b-set2">🔮 NETRUN</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:3px;">Фиолетово-пурпурный плазменный луч нетраннера, движущаяся голографическая матрица взлома протокола в профиле и бейдж «🔮 NETRUN».</div>
                  <div class="fxb-items-pills">
                    <span class="fxb-pill">⬢ Аватар: Плазма Нетраннера</span>
                    <span class="fxb-pill">🏷️ Бейдж: 🔮 NETRUN</span>
                    <span class="fxb-pill">🖼️ Фон и рамка: Матрица Протокола</span>
                  </div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set2" onclick="selectEffectSet('set2')">🎁 ЗАБРАТЬ НАБОР</button>
            </div>

            <!-- Набор 3: Игра Cyberpunk 2077 -->
            <div class="fx-bundle-card set3-card">
              <div class="fxb-left">
                <div class="hex-wrap fx-set3" style="width:64px;height:64px;">
                  <div class="hex-border"><div class="hex-core" style="font-size:18px;background:#ff003c;">V</div></div>
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#ff4d79;">Набор 3: Cyberpunk 2077 // Night City (V & Сильверхенд)</span>
                    <span class="cyber-badge b-set3">🔥 RELIC</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:3px;">Бегущий красный неон с бирюзовым отблеском биочипа Relic, пульсирующая рамка Самурая и диагональный радар Найт-Сити.</div>
                  <div class="fxb-items-pills">
                    <span class="fxb-pill">⬢ Аватар: Красный неон Relic</span>
                    <span class="fxb-pill">🏷️ Бейдж: 🔥 RELIC</span>
                    <span class="fxb-pill">🖼️ Фон и рамка: Night City Samurai</span>
                  </div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set3" onclick="selectEffectSet('set3')">🎁 ЗАБРАТЬ НАБОР</button>
            </div>
          </div>
        </div>

        <!-- Вкладка 3: ⌨️ ГОРЯЧИЕ КЛАВИШИ (KEYBIND RECORDER) -->
        <div class="settings-pane" id="pane-keybinds">
          <div class="settings-head">
            <h3>⌨️ Настройка горячих клавиш</h3>
            <button class="btn-login-mini" onclick="resetKeybindsToDefault()">Сбросить по умолчанию</button>
          </div>
          <div style="font-size:12px;color:var(--text-normal);">Нажмите на кнопку напротив нужного действия и нажмите любую клавишу или сочетание клавиш (например, <b>Alt+M</b>, <b>F9</b>, <b>Ctrl+Shift+M</b>). Горячие клавиши работают везде на сайте, когда вы не печатаете текст в поле чата.</div>
          <div class="settings-card">
            <div class="keybind-row">
              <div><div class="toggle-title">🎤 Включить / выключить микрофон (Mute)</div></div>
              <button class="kb-btn" id="kb-btn-mute" onclick="startKeybindRecord('mute')"></button>
            </div>
            <div class="keybind-row">
              <div><div class="toggle-title">🎧 Включить / выключить звук (Deafen)</div></div>
              <button class="kb-btn" id="kb-btn-deafen" onclick="startKeybindRecord('deafen')"></button>
            </div>
            <div class="keybind-row">
              <div><div class="toggle-title">📷 Включить / выключить веб-камеру</div></div>
              <button class="kb-btn" id="kb-btn-cam" onclick="startKeybindRecord('cam')"></button>
            </div>
            <div class="keybind-row">
              <div><div class="toggle-title">🖥️ Запустить / остановить демонстрацию экрана</div></div>
              <button class="kb-btn" id="kb-btn-screen" onclick="startKeybindRecord('screen')"></button>
            </div>
            <div class="keybind-row">
              <div><div class="toggle-title">🪟 Открыть / скрыть оверлей поверх окон</div></div>
              <button class="kb-btn" id="kb-btn-pip" onclick="startKeybindRecord('pip')"></button>
            </div>
          </div>
        </div>

        <!-- Вкладка 4: Фильтр 18+ -->
        <div class="settings-pane" id="pane-safety">
          <div class="settings-head"><h3>🛡️ Фильтр контента 18+</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">🔞 Блокировать откровенный контент (18+)</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-sexual" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🩸 Блокировать шок-контент и насилие</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-gore" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">🔗 Проверять мои исходящие сообщения</div></div><label class="cyber-switch"><input type="checkbox" id="chk-filter-outgoing" checked onchange="saveSafetySettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Действие при обнаружении</label><select id="sel-filter-action" onchange="saveSafetySettings()"><option value="block">🚫 Блокировать сообщение</option><option value="blur">👁️ Скрывать под спойлером</option></select></div>
            <div><label class="field-label">Собственный фильтр слов (через запятую)</label><input type="text" id="inp-custom-blocklist" oninput="saveSafetySettings()"></div>
          </div>
        </div>

        <!-- Вкладка 5: Голос и видео -->
        <div class="settings-pane" id="pane-voice">
          <div class="settings-head"><h3>🎙️ Голос, видео и оверлей</h3><button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 ОБНОВИТЬ</button></div>
          <div class="settings-card">
            <div class="settings-grid-2"><div><label class="field-label">Микрофон</label><select id="set-mic-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Аудиовыход</label><select id="set-spk-select" onchange="saveAudioVideoSettings()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Усиление микрофона: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость эфира: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Проверка микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ ПРОВЕРИТЬ</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Камера</label><select id="set-cam-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Разрешение</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
            <div class="toggle-row"><div><div class="toggle-title">🪟 Показывать мини-виджет звонка</div></div><label class="cyber-switch"><input type="checkbox" id="chk-auto-overlay" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Подавление шумов</div></div><label class="cyber-switch"><input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Подавление эха</div></div><label class="cyber-switch"><input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Автоусиление голоса</div></div><label class="cyber-switch"><input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <!-- Вкладка 6: Внешний вид -->
        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head"><h3>🎨 Внешний вид</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">Компактный режим чата</div></div><label class="cyber-switch"><input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Размер шрифта</label><select id="sel-font-size" onchange="applyAppearanceSettings()"><option value="13px">13px</option><option value="14px" selected>14px (Стандарт)</option><option value="16px">16px</option></select></div>
          </div>
        </div>

        <!-- Вкладка 7: Уведомления -->
        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head"><h3>🔔 Звуковые сигналы</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div><div class="toggle-title">Сигнал при новом сообщении</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div><div class="toggle-title">Сигнал подключения к голосовому каналу</div></div><label class="cyber-switch"><input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <!-- Вкладка 8: Учётная запись -->
        <div class="settings-pane" id="pane-account">
          <div class="settings-head"><h3>🔑 Учётная запись</h3></div>
          <div class="settings-card">
            <div class="settings-grid-2">
              <button class="btn-cyan" onclick="closeSettingsModal();openAuthModal(false)">✈️ СМЕНИТЬ АККАУНТ</button>
              <button class="btn-danger" onclick="logoutAccount()">ВЫЙТИ</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Модальное окно приглашения -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box"><h3 style="color:var(--brand);font-size:16px;margin-bottom:8px;">⚡ ПРИГЛАСИТЬ ДРУГА В УЗЕЛ</h3><a class="link-box" id="public-invite-url" href="#" target="_blank"></a><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">СКОПИРОВАТЬ ССЫЛКУ</button><button class="btn-login-mini" style="width:100%;" onclick="closeInviteModal()">ЗАКРЫТЬ</button></div>
  </div>

  <!-- Модальное окно авторизации -->
  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="color:var(--brand);font-size:16px;">⚡ АВТОРИЗАЦИЯ</h3><span style="font-size:10px;background:var(--pink);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;">P2P ID</span></div>
      <div class="auth-tabs"><div class="auth-tab active" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ TELEGRAM</div><div class="auth-tab" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 ПАРОЛЬ</div></div>
      <input type="text" id="nick-inp" placeholder="Ваш позывной (никнейм)" maxlength="24">
      <div id="auth-tg-panel">
        <p style="font-size:12px;color:var(--text-normal);margin-bottom:10px;" id="tg-status-hint">Откройте бота и нажмите /start — вход выполнится автоматически:</p>
        <button type="button" class="btn-tg" id="tg-open-bot-btn" onclick="openTelegramBot()">✈️ ОТКРЫТЬ TELEGRAM И ПОЛУЧИТЬ КОД</button>
        <input type="text" id="tg-code-inp" placeholder="КОД (4 ЦИФРЫ)" maxlength="6" style="text-align:center;font-size:15px;font-weight:800;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="verifyTelegramCode()">ПОДТВЕРДИТЬ И ВОЙТИ</button>
      </div>
      <div id="auth-pass-panel" style="display:none;">
        <input type="password" id="pass-inp" placeholder="Пароль (минимум 4 символа)" maxlength="64">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithPassword()">ВОЙТИ НАВСЕГДА</button>
      </div>
      <button class="btn-login-mini" id="auth-close-btn" style="width:100%;margin-top:8px;" onclick="closeAuthModal()">ЗАКРЫТЬ</button>
    </div>
  </div>

  <!-- Модальное окно создания сервера -->
  <div class="modal-backdrop" id="create-server-modal" onclick="if(event.target===this)closeCreateServerModal()">
    <div class="modal-box"><h3 style="color:var(--brand);font-size:16px;margin-bottom:8px;">⬢ СОЗДАТЬ НОВЫЙ СЕРВЕР</h3><input type="text" id="new-srv-name" placeholder="Название узла" maxlength="28"><input type="text" id="new-srv-desc" placeholder="Описание" maxlength="80"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateServer()">СОЗДАТЬ</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateServerModal()">ОТМЕНА</button></div>
  </div>

  <!-- Модальное окно создания канала -->
  <div class="modal-backdrop" id="create-channel-modal" onclick="if(event.target===this)closeCreateChannelModal()">
    <div class="modal-box"><h3 id="create-ch-title" style="color:var(--brand);font-size:16px;margin-bottom:6px;">◈ СОЗДАТЬ КАНАЛ</h3><p id="create-ch-sub" style="font-size:12px;color:var(--text-normal);margin-bottom:10px;"></p><input type="text" id="new-ch-name" placeholder="название-канала" maxlength="28"><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="submitCreateChannel()">СОЗДАТЬ</button><button class="btn-login-mini" style="width:100%;" onclick="closeCreateChannelModal()">ОТМЕНА</button></div>
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

  // ---------- СИСТЕМА 3 ТЕМАТИЧЕСКИХ НАБОРОВ ЭФФЕКТОВ (АВАТАР + БЕЙДЖ + РАМКА + ФОН) ----------
  const FX_SETS_META = {
    set1: {
      code: '⚡FX:SET1',
      avaClass: 'fx-set1',
      badgeClass: 'b-set1',
      badgeText: '⚡ SANDY',
      surfaceClass: 'theme-set1',
      title: 'Edgerunners // Сезон 1 (Дэвид и Люси — Сандевистан и Луна)'
    },
    set2: {
      code: '⚡FX:SET2',
      avaClass: 'fx-set2',
      badgeClass: 'b-set2',
      badgeText: '🔮 NETRUN',
      surfaceClass: 'theme-set2',
      title: 'Edgerunners // Сезон 2 (Новое поколение — Протокол Нетраннера)'
    },
    set3: {
      code: '⚡FX:SET3',
      avaClass: 'fx-set3',
      badgeClass: 'b-set3',
      badgeText: '🔥 RELIC',
      surfaceClass: 'theme-set3',
      title: 'Cyberpunk 2077 // Night City (V & Сильверхенд — Биочип Relic)'
    }
  };

  let myProfile = { bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#14f1d9', avatarColor: '#ff1e56', fxSet: '' };
  try { myProfile = Object.assign(myProfile, JSON.parse(localStorage.getItem('cyber_profile') || '{}')); } catch (e) {}

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
    if (!m) return '';
    return '<span class="cyber-badge ' + m.badgeClass + '">' + m.badgeText + '</span>';
  }

  function cleanInterestsForDisplay(raw) {
    return String(raw || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) {
      return x && !x.startsWith('⚡FX:');
    });
  }

  function selectEffectSet(setKey) {
    myProfile.fxSet = FX_SETS_META[setKey] ? setKey : '';
    const tags = cleanInterestsForDisplay(myProfile.interests);
    if (myProfile.fxSet && FX_SETS_META[myProfile.fxSet]) {
      tags.push(FX_SETS_META[myProfile.fxSet].code);
    }
    myProfile.interests = tags.join(', ');
    try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
    updateFxButtonsUI();
    applyNickUI();
    updateProfilePreview(true);
    syncProfileToServer();
    renderUsers(lastMembers);
    rerenderChatMessages();
  }

  function updateFxButtonsUI() {
    const cur = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    ['set1', 'set2', 'set3'].forEach(function (k) {
      const b = document.getElementById('btn-fx-' + k);
      if (b) b.textContent = (cur === k) ? '✓ НАБОР АКТИВЕН' : '🎁 ЗАБРАТЬ НАБОР';
    });
    const dis = document.getElementById('btn-disable-fx');
    if (dis) dis.style.display = cur ? 'inline-block' : 'none';
  }

  function getMyMemberObject() {
    return {
      pid: myPid,
      nick: myNick,
      online: true,
      presence: myProfile.presence,
      customStatus: myProfile.customStatus,
      bio: myProfile.bio,
      interests: myProfile.interests,
      bannerColor: myProfile.bannerColor,
      avatarColor: myProfile.avatarColor,
      fxSet: myProfile.fxSet
    };
  }

  // ---------- СИСТЕМА ГОРЯЧИХ КЛАВИШ (KEYBINDS) ----------
  const DEFAULT_KEYBINDS = {
    mute: 'Alt+KeyM',
    deafen: 'Alt+KeyD',
    cam: 'Alt+KeyC',
    screen: 'Alt+KeyS',
    pip: 'Alt+KeyP'
  };
  let userKeybinds = Object.assign({}, DEFAULT_KEYBINDS);
  try {
    const savedKb = JSON.parse(localStorage.getItem('cyber_keybinds') || '{}');
    userKeybinds = Object.assign(userKeybinds, savedKb);
  } catch (e) {}
  let recordingAction = null;

  function formatKeybindCode(combo) {
    if (!combo) return 'Не назначено';
    return String(combo)
      .replace('Key', '')
      .replace('Digit', '')
      .replace('Control', 'Ctrl');
  }

  function renderKeybindsUI() {
    ['mute', 'deafen', 'cam', 'screen', 'pip'].forEach(function (act) {
      const btn = document.getElementById('kb-btn-' + act);
      if (!btn) return;
      if (recordingAction === act) {
        btn.textContent = 'Нажмите клавишу...';
        btn.classList.add('recording');
      } else {
        btn.textContent = formatKeybindCode(userKeybinds[act]);
        btn.classList.remove('recording');
      }
    });
    const hint = document.getElementById('footer-keybind-hint');
    if (hint) {
      hint.textContent = 'БИНДЫ: МИКР [' + formatKeybindCode(userKeybinds.mute) + '] • ЗВУК [' + formatKeybindCode(userKeybinds.deafen) + '] • ОВЕРЛЕЙ [' + formatKeybindCode(userKeybinds.pip) + ']';
    }
  }

  function startKeybindRecord(act) {
    recordingAction = (recordingAction === act) ? null : act;
    renderKeybindsUI();
  }

  function resetKeybindsToDefault() {
    userKeybinds = Object.assign({}, DEFAULT_KEYBINDS);
    recordingAction = null;
    try { localStorage.setItem('cyber_keybinds', JSON.stringify(userKeybinds)); } catch (e) {}
    renderKeybindsUI();
  }

  function eventToComboString(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const ignore = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
    if (e.code && !ignore.includes(e.code)) {
      parts.push(e.code);
    }
    return parts.join('+');
  }

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
      bannerColor: u.bannerColor || prev.bannerColor || '#14f1d9',
      avatarColor: u.avatarColor || prev.avatarColor || '#ff1e56'
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
  let stageLayoutMode = 'grid';

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
    ctx.fillStyle = '#05080f'; ctx.fillRect(0, 0, w, h);
    const activeVideoEl = document.querySelector('#screen-grid .screen-card:not(.nsfw-masked) video');
    if (activeVideoEl && activeVideoEl.readyState >= 2) {
      try { ctx.drawImage(activeVideoEl, 0, 38, w, h - 38); } catch (e) {}
      ctx.fillStyle = 'rgba(4, 7, 13, 0.88)'; ctx.fillRect(0, 0, w, 38);
    } else {
      ctx.fillStyle = '#0c1422';
      ctx.fillRect(14, 48, w - 28, 34);
      ctx.strokeStyle = isMuted ? '#ff1e56' : '#14f1d9'; ctx.lineWidth = 1.5; ctx.strokeRect(14, 48, w - 28, 34);
      ctx.fillStyle = isMuted ? '#ff1e56' : '#10b981'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText((isMuted ? '🔇 Микрофон выкл' : '🎤 Микрофон вкл') + (isDeafened ? ' • 🔇 Звук выкл' : ' • 🎧 Звук вкл'), 26, 70);
      ctx.fillStyle = '#14f1d9'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('УЧАСТНИКИ В ЭФИРЕ:', 16, 104);
      getVoiceChannelMembers().slice(0, 5).forEach(function (u, i) {
        const y = 128 + i * 25; ctx.fillStyle = '#0c1422'; ctx.fillRect(14, y - 16, w - 28, 22);
        ctx.fillStyle = '#10b981'; ctx.beginPath(); ctx.arc(26, y - 5, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#e6f7ff'; ctx.font = 'bold 13px sans-serif';
        ctx.fillText(u.nick + (u.pid === myPid ? ' (Вы)' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''), 38, y);
      });
    }
    ctx.strokeStyle = '#14f1d9'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = '#ff1e56'; ctx.fillRect(14, 9, 72, 20); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('СИГНАЛ', 23, 23);
    ctx.fillStyle = '#14f1d9'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('🔊 ' + String(currentVoiceChannel || 'Эфир').slice(0, 20), 96, 24);
    ctx.fillStyle = '#e6f7ff'; ctx.font = 'bold 13px monospace'; ctx.fillText(formatCallTime(callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0), w - 58, 24);
  }

  function openStandalonePopupOverlay() {
    if (popupOverlayWin && !popupOverlayWin.closed) { popupOverlayWin.focus(); return; }
    popupOverlayWin = window.open('', 'SignalCallOverlay', 'width=340,height=250,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!popupOverlayWin) return;
    const doc = popupOverlayWin.document; doc.open();
    doc.write('<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>СИГНАЛ — Оверлей</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif;}body{background:#05080f;color:#e6f7ff;padding:12px;height:100vh;display:flex;flex-direction:column;justify-content:space-between;border:1px solid #14f1d9;}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(20,241,217,0.2);padding-bottom:8px;}.badge{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#10b981;}.dot{width:8px;height:8px;background:#10b981;}.timer{font-family:monospace;font-size:11px;color:#14f1d9;}.peers{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;overflow-y:auto;flex:1;align-content:flex-start;}.chip{display:inline-flex;align-items:center;gap:6px;background:#0c1422;border:1px solid rgba(20,241,217,0.3);padding:4px 9px;font-size:11px;font-weight:700;color:#fff;}.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding-top:6px;border-top:1px solid rgba(20,241,217,0.2);}button{background:#0c1422;border:1px solid #14f1d9;color:#14f1d9;padding:8px 6px;font-size:11px;font-weight:700;cursor:pointer;}button.off{background:#ff1e56;border-color:#ff1e56;color:#fff;}button.hang{background:#ff1e56;border-color:#ff1e56;color:#fff;}</style></head><body><div class="top"><div class="badge"><span class="dot"></span><span id="pop-ch"></span></div><span class="timer" id="pop-timer">00:00</span></div><div class="peers" id="pop-peers"></div><div class="btns"><button id="pop-mute"></button><button id="pop-deaf"></button><button class="hang" id="pop-hang">🛑 Выход</button></div></body></html>');
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
      getVoiceChannelMembers().forEach(function (u) { const c = doc.createElement('div'); c.className = 'chip'; c.textContent = '⬢ ' + u.nick; pb.appendChild(c); });
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
    document.body.classList.add('voice-live');
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
        const stEl = document.getElementById('svd-state-text'); if (stEl) stEl.textContent = '🟢 В ЭФИРЕ • ' + tStr;
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
    document.body.classList.remove('voice-live');
    if (voiceLockRelease) { try { voiceLockRelease(); } catch (e) {} voiceLockRelease = null; }
    if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch (e) {} wakeLockSentinel = null; }
    if (keepAliveAudioEl) { try { keepAliveAudioEl.pause(); keepAliveAudioEl.removeAttribute('src'); } catch (e) {} }
    if (bgWorker) { try { bgWorker.terminate(); } catch (e) {} bgWorker = null; }
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'none'; } catch (e) {} }
    const stEl = document.getElementById('svd-state-text');
    if (stEl) { stEl.textContent = '📡 ГОЛОСОВОЙ КАНАЛ'; stEl.classList.add('idle'); }
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
      uList.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen, interests: myProfile.interests, avatarColor: myProfile.avatarColor });
    }
    return uList;
  }

  function renderSidebarVoicePeers() {
    const box = document.getElementById('sidebar-voice-peers');
    if (!box) return;
    box.innerHTML = '';
    const vMembers = getVoiceChannelMembers();
    vMembers.forEach(function (u) {
      const setKey = getUserFxSet(u);
      const r = el('div', 'vc-user-row');
      const hw = el('div', 'hex-wrap' + (setKey && FX_SETS_META[setKey] ? ' ' + FX_SETS_META[setKey].avaClass : ''));
      hw.style.cssText = 'width:24px;height:24px;';
      const hb = el('div', 'hex-border');
      const hc = el('div', 'hex-core', String(u.nick || '?').slice(0, 2).toUpperCase());
      hc.style.cssText = 'font-size:8.5px;background:' + (u.avatarColor || '#14f1d9') + ';';
      hb.appendChild(hc); hw.appendChild(hb);
      r.appendChild(hw);
      const nameSpan = el('span', '', u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''));
      r.appendChild(nameSpan);
      r.onclick = function () { openUserProfileCard(u); };
      box.appendChild(r);
    });
  }

  function updateFloatingOverlayUI() {
    const box = document.getElementById('floating-call-overlay'); if (!box) return;
    if (!inVoice || appSettings.autoOverlay === false) box.classList.remove('show'); else box.classList.add('show');
    document.getElementById('fco-channel-label').textContent = '🔊 ' + currentVoiceChannel;
    document.getElementById('fco-mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('fco-deaf-btn').textContent = isDeafened ? '🔇 Глух' : '🎧 Вкл';
    const ubMic = document.getElementById('mute-btn'), ubDeaf = document.getElementById('deafen-btn');
    if (ubMic) { ubMic.classList.toggle('off', isMuted); ubMic.textContent = isMuted ? '🔇' : '🎤'; }
    if (ubDeaf) { ubDeaf.classList.toggle('off', isDeafened); ubDeaf.textContent = isDeafened ? '🔇' : '🎧'; }
    const pb = document.getElementById('fco-peers-box'); pb.innerHTML = '';
    getVoiceChannelMembers().forEach(function (u) {
      const c = el('div', 'fco-peer-chip'); c.appendChild(el('span', 'fco-pulse')); c.appendChild(el('span', '', u.nick)); pb.appendChild(c);
    });
    renderSidebarVoicePeers();
    drawSystemPipOverlayFrame();
    renderPopupOverlayContent();
  }

  (function () {
    const card = document.getElementById('floating-call-overlay'), handle = document.getElementById('fco-drag-handle');
    if (!card || !handle) return;
    let drag = false, sx = 0, sy = 0, or = 18, ob = 40;
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
    const ava = document.getElementById('user-ava'); ava.textContent = myNick.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#ff1e56';
    const curSet = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    const meta = FX_SETS_META[curSet];
    const wrap = document.getElementById('user-ava-wrap');
    if (wrap) wrap.className = 'hex-wrap' + (meta ? ' ' + meta.avaClass : '');
    const badgeSlot = document.getElementById('user-bar-badge-slot');
    if (badgeSlot) badgeSlot.innerHTML = getBadgeHTML(curSet);
    document.getElementById('user-presence-dot').className = 'hex-status-dot ' + (myProfile.presence || 'online');
    const stViol = checkContentViolation(myProfile.customStatus || '');
    const sStat = stViol.length ? '' : myProfile.customStatus;
    document.getElementById('user-email-label').textContent = sStat || 'В сети';
    updateFxButtonsUI();
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
    const nodeLbl = document.getElementById('tt-node-label');
    if (nodeLbl) nodeLbl.textContent = 'Узел активен • ' + currentRoom;

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
      if (unread > 0 && ch !== currentChannel) row.appendChild(el('span', 'ch-unread-badge', String(unread)));
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
    document.getElementById('top-ch-desc').textContent = 'АКТИВНЫЙ АУДИО ПОТОК // ' + sName.toUpperCase();
    document.getElementById('banner-desc').textContent = 'КАНАЛ #' + ch.toUpperCase();
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(function (i) { i.classList.toggle('active', i.getAttribute('data-ch') === ch); });
  }

  function updateVoicePanelUI() {
    document.getElementById('voice-panel-title').textContent = currentVoiceChannel;
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
        const det = detectFxSetFromInterests(myProfile.interests);
        if (det) myProfile.fxSet = det;
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
    if (appSettings.filterAction === 'blur') {
      return '<div class="spoiler-blur-wrap" onclick="toggleSpoiler(this)" title="Показать/скрыть"><div class="spoiler-badge">🛡️ Скрыто фильтром (' + rStr + ') — нажмите для просмотра</div><div class="spoiler-blur-content">' + inner + '</div></div>';
    }
    return '<div class="filtered-block-card">🛡️ Заблокировано фильтром безопасности (' + rStr + ')</div>';
  }

  function addMsgToDOM(m) {
    const box = document.getElementById('messages-list'), hint = document.getElementById('empty-hint'); if (hint) hint.remove();
    const author = String(m.author || '?'), viol = checkContentViolation(m.text, m.flags);
    const memberObj = (lastMembers || []).find(function (u) { return u.nick === author; }) || (author === myNick ? getMyMemberObject() : { nick: author });
    const setKey = getUserFxSet(memberObj);
    const fxMeta = FX_SETS_META[setKey];
    const fxCls = fxMeta ? ' ' + fxMeta.avaClass : '';
    const avaCol = (memberObj && memberObj.avatarColor) || '#14f1d9';

    const div = el('div', 'msg-item');
    div.innerHTML =
      '<div class="hex-wrap' + fxCls + '" style="width:38px;height:38px;margin-top:2px;cursor:pointer;">' +
        '<div class="hex-border"><div class="hex-core" style="font-size:12px;background:' + escapeHtml(avaCol) + ';">' + escapeHtml(author.slice(0, 2).toUpperCase()) + '</div></div>' +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="msg-head-line">' +
          '<span class="msg-author">' + escapeHtml(author) + '</span>' +
          getBadgeHTML(setKey) +
          '<span class="msg-time">' + escapeHtml(m.time) + '</span>' +
        '</div>' +
        '<div class="msg-text">' + buildMessageBodyHTML(m.text, viol) + '</div>' +
      '</div>';

    const avaClick = div.querySelector('.hex-wrap');
    const nameClick = div.querySelector('.msg-author');
    if (avaClick) avaClick.onclick = function () { openUserProfileCard(memberObj); };
    if (nameClick) nameClick.onclick = function () { openUserProfileCard(memberObj); };

    box.appendChild(div);
    const scrollArea = document.getElementById('chat-scroll'); scrollArea.scrollTop = scrollArea.scrollHeight;
  }

  function friendAction(action, pid) {
    if (!myVerified) { openAuthModal(true); return Promise.resolve(); }
    if (action === 'remove') { localVault.friends = (localVault.friends || []).filter(function (x) { return x !== pid; }); saveLocalVault(); }
    return fetch('/api/friend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, action: action, target: pid }) })
      .then(function (r) { return r.json(); }).then(function (d) { if (d.error) alert(d.error); }).catch(function () {});
  }

  function renderMemberRow(u, friendPids) {
    const d = el('div', 'online-user-item' + (u.online ? ' is-online' : ''));
    if (!u.online) d.style.opacity = '0.5';

    const setKey = getUserFxSet(u);
    const fxMeta = FX_SETS_META[setKey];
    const avaWrap = el('div', 'hex-wrap' + (fxMeta ? ' ' + fxMeta.avaClass : ''));
    avaWrap.style.cssText = 'width:34px;height:34px;';
    const hb = el('div', 'hex-border');
    const ava = el('div', 'hex-core', String(u.nick || '?').slice(0, 2).toUpperCase());
    ava.style.cssText = 'font-size:11px;background:' + (u.avatarColor || '#14f1d9') + ';';
    hb.appendChild(ava);
    avaWrap.appendChild(hb);
    avaWrap.appendChild(el('span', 'hex-status-dot ' + (u.online ? (u.presence || 'online') : 'off')));
    d.appendChild(avaWrap);

    const col = el('div', 'member-text-col');
    const nr = el('div', 'member-nick-row');
    const nickTxt = el('span', '', u.nick + (u.inVoice ? ' 🔊' : '') + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''));
    nickTxt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    nr.appendChild(nickTxt);
    if (fxMeta) {
      const bSpan = document.createElement('span');
      bSpan.innerHTML = getBadgeHTML(setKey);
      if (bSpan.firstChild) nr.appendChild(bSpan.firstChild);
    }
    col.appendChild(nr);
    if (u.customStatus) {
      const sv = checkContentViolation(u.customStatus);
      col.appendChild(el('div', 'member-status-sub', sv.length ? '🛡️ [Статус скрыт]' : u.customStatus));
    }
    d.appendChild(col);

    if (myPid && u.pid !== myPid) {
      if (friendPids.includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'друг'));
      else if ((social.outgoing || []).includes(u.pid)) d.appendChild(el('span', 'friend-tag', 'запрос'));
      else if ((social.incoming || []).some(function (i) { return i.pid === u.pid; })) {
        const b = el('button', 'mini-btn', '✓'); b.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', u.pid); }; d.appendChild(b);
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

    online.forEach(function (u) { onBox.appendChild(renderMemberRow(u, friendPids)); });
    offline.forEach(function (u) { offBox.appendChild(renderMemberRow(u, friendPids)); });
    renderSidebarVoicePeers();
  }

  function renderSocial() {
    const friends = social.friends || [], incoming = social.incoming || [];
    document.getElementById('friends-count').textContent = friends.length;
    const rq = document.getElementById('requests-box'); rq.innerHTML = '';
    incoming.forEach(function (r) {
      const d = el('div', 'online-user-item');
      const nm = el('span', '', r.nick + ' (запрос)'); nm.style.cssText = 'flex:1;font-size:12px;';
      const ok = el('button', 'mini-btn', '✓'); ok.onclick = function (ev) { ev.stopPropagation(); friendAction('accept', r.pid); };
      const no = el('button', 'mini-btn', '✕'); no.onclick = function (ev) { ev.stopPropagation(); friendAction('decline', r.pid); };
      d.appendChild(nm); d.appendChild(ok); d.appendChild(no); rq.appendChild(d);
    });
    const fb = document.getElementById('friends-box'); fb.innerHTML = '';
    friends.forEach(function (f) {
      const setKey = getUserFxSet(f);
      const fxMeta = FX_SETS_META[setKey];
      const d = el('div', 'online-user-item');
      if (!f.online) d.style.opacity = '0.5';
      const avaWrap = el('div', 'hex-wrap' + (fxMeta ? ' ' + fxMeta.avaClass : ''));
      avaWrap.style.cssText = 'width:32px;height:32px;';
      const hb = el('div', 'hex-border');
      const ava = el('div', 'hex-core', String(f.nick || '?').slice(0, 2).toUpperCase());
      ava.style.cssText = 'font-size:10px;background:' + (f.avatarColor || '#14f1d9') + ';';
      hb.appendChild(ava); avaWrap.appendChild(hb);
      avaWrap.appendChild(el('span', 'hex-status-dot ' + (f.online ? (f.presence || 'online') : 'off')));
      d.appendChild(avaWrap);
      const nm = el('span', 'member-nick-row', f.nick); nm.style.flex = '1'; d.appendChild(nm);
      const rm = el('button', 'mini-btn', '✕'); rm.onclick = function (ev) { ev.stopPropagation(); if (confirm('Удалить из друзей?')) friendAction('remove', f.pid); };
      d.appendChild(rm); d.onclick = function () { openUserProfileCard(f); }; fb.appendChild(d);
    });
  }

  // ---------- ВЫЕЗЖАЮЩИЙ СПРАВА ПРОФИЛЬ УЧАСТНИКА С АНИМИРОВАННОЙ РАМКОЙ, ФОНОМ И ДЕЙСТВИЯМИ ----------
  function openUserProfileCard(u) {
    if (!u) return;
    const setKey = getUserFxSet(u);
    const fxMeta = FX_SETS_META[setKey];

    const surf = document.getElementById('vp-surface');
    surf.className = 'profile-surface psd-inner' + (fxMeta ? ' ' + fxMeta.surfaceClass : '');

    document.getElementById('vp-banner').style.background = u.bannerColor || '#14f1d9';
    const ava = document.getElementById('vp-ava');
    ava.textContent = String(u.nick || '?').slice(0, 2).toUpperCase();
    ava.style.background = u.avatarColor || '#ff1e56';

    const vpWrap = document.getElementById('vp-ava-wrap');
    vpWrap.className = 'hex-wrap dp-ava-pos' + (fxMeta ? ' ' + fxMeta.avaClass : '');
    document.getElementById('vp-status-dot').className = 'hex-status-dot ' + (u.online ? (u.presence || 'online') : 'off');

    document.getElementById('vp-nick').textContent = u.nick || 'Участник';
    document.getElementById('vp-badge-slot').innerHTML = getBadgeHTML(setKey);
    document.getElementById('vp-fx-label').textContent = fxMeta ? fxMeta.title : 'Стандартный кибер-контур';

    const pill = document.getElementById('vp-online-pill');
    pill.className = 'status-pill ' + (u.online ? 'on' : 'off');
    pill.textContent = u.online ? 'В СЕТИ' : 'НЕ В СЕТИ';

    document.getElementById('vp-status').textContent = checkContentViolation(u.customStatus || '').length ? '🛡️ [Статус скрыт]' : (u.customStatus || 'В эфире СИГНАЛ');
    document.getElementById('vp-bio').textContent = checkContentViolation(u.bio || '').length ? '🛡️ [Скрыто фильтром]' : (u.bio || 'Оператор пока не добавил описание.');

    const tb = document.getElementById('vp-tags'); tb.innerHTML = '';
    cleanInterestsForDisplay(u.interests).forEach(function (tg) { if (!checkContentViolation(tg).length) tb.appendChild(el('span', 'dp-tag', tg)); });
    if (!tb.childNodes.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Интересы не указаны</span>';

    document.getElementById('vp-mention-btn').onclick = function () {
      closeViewProfileModal();
      closeMobileDrawers();
      const inp = document.getElementById('chat-input');
      inp.value = '@' + (u.nick || '') + ' ' + inp.value;
      inp.focus();
    };
    document.getElementById('vp-call-btn').onclick = function () {
      closeViewProfileModal();
      if (!inVoice) toggleVoiceCall();
    };

    const fBtn = document.getElementById('vp-friend-btn'), friendPids = (social.friends || []).map(function (f) { return f.pid; });
    if (u.pid === myPid || u.nick === myNick) {
      fBtn.textContent = '✨ Настроить мой профиль и эффекты';
      fBtn.className = 'btn-cyan';
      fBtn.onclick = function () { closeViewProfileModal(); openSettingsModal('fx'); };
    } else if (friendPids.includes(u.pid)) {
      fBtn.textContent = '✕ Удалить из друзей';
      fBtn.className = 'btn-danger';
      fBtn.onclick = function () { friendAction('remove', u.pid); closeViewProfileModal(); };
    } else {
      fBtn.textContent = '+ Добавить в друзья';
      fBtn.className = 'btn-cyan';
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
    closeMobileDrawers(); setMobActiveTab('mob-tab-profile');
    document.getElementById('prof-nick-inp').value = myNick;
    document.getElementById('prof-presence-sel').value = myProfile.presence || 'online';
    document.getElementById('prof-status-inp').value = myProfile.customStatus || '';
    document.getElementById('prof-bio-inp').value = myProfile.bio || '';
    document.getElementById('prof-interests-inp').value = cleanInterestsForDisplay(myProfile.interests).join(', ');
    updateProfilePreview(true);
    updateFxButtonsUI();
    renderKeybindsUI();
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

  function closeSettingsModal() {
    recordingAction = null;
    stopMicTest();
    document.getElementById('settings-modal').classList.remove('open');
    setMobActiveTab('mob-tab-chat');
  }
  function switchSettingsPane(pId) {
    recordingAction = null;
    renderKeybindsUI();
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
    const curSet = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    const fxMeta = FX_SETS_META[curSet];
    if (fxMeta) cleanTags.push(fxMeta.code);
    const finalIntr = cleanTags.join(', ');

    const prevSurf = document.getElementById('preview-surface');
    if (prevSurf) prevSurf.className = 'profile-surface' + (fxMeta ? ' ' + fxMeta.surfaceClass : '');

    document.getElementById('preview-banner').style.background = myProfile.bannerColor || '#14f1d9';
    const ava = document.getElementById('preview-ava'); ava.textContent = n.slice(0, 2).toUpperCase(); ava.style.background = myProfile.avatarColor || '#ff1e56';
    const prevWrap = document.getElementById('preview-ava-wrap');
    if (prevWrap) prevWrap.className = 'hex-wrap dp-ava-pos' + (fxMeta ? ' ' + fxMeta.avaClass : '');
    document.getElementById('preview-nick').textContent = n;
    document.getElementById('preview-badge-slot').innerHTML = getBadgeHTML(curSet);
    document.getElementById('preview-status').textContent = st || 'В сети';
    document.getElementById('preview-bio').textContent = bio || 'О себе...';
    const tb = document.getElementById('preview-tags'); tb.innerHTML = '';
    const displayTags = cleanInterestsForDisplay(finalIntr);
    if (!displayTags.length) tb.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Нет тегов</span>';
    else displayTags.forEach(function (tg) { tb.appendChild(el('span', 'dp-tag', tg)); });

    if (!skipSync) {
      myNick = n; myProfile.presence = pr; myProfile.customStatus = st; myProfile.bio = bio; myProfile.interests = finalIntr;
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
      document.getElementById('btn-mic-test').textContent = '🛑 СТОП';
      micTestTimer = setInterval(function () { an.getByteFrequencyData(d); let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i]; document.getElementById('mic-test-bar').style.width = Math.min(100, Math.round((sum / d.length / 90) * 100)) + '%'; }, 60);
    } catch (e) { alert('Ошибка доступа к микрофону.'); }
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
    document.getElementById('create-ch-title').textContent = pendingChannelType === 'voice' ? '🔊 СОЗДАТЬ ГОЛОСОВОЙ КАНАЛ' : '◈ СОЗДАТЬ ТЕКСТОВЫЙ КАНАЛ';
    document.getElementById('create-ch-sub').textContent = pendingChannelType === 'voice' ? 'Участники смогут общаться голосом, включать камеру и стрим экрана:' : 'Участники смогут обмениваться сообщениями и ссылками:';
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
      if (tgBotUsername) document.getElementById('tg-open-bot-btn').innerHTML = '<span>✈️ ОТКРЫТЬ @' + escapeHtml(tgBotUsername) + ' И ВОЙТИ</span>';
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
    if (!nick) return alert('Введите ваш позывной!'); if (!pass && !myVerified) return alert('Введите пароль!');
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
    const cBtn = document.getElementById('connect-voice-btn');
    if (cBtn) { cBtn.textContent = 'ВЫЙТИ'; cBtn.className = 'svd-hangup-btn'; }
    const stEl = document.getElementById('svd-state-text');
    if (stEl) { stEl.textContent = '🟢 ГОЛОС ПОДКЛЮЧЕН'; stEl.classList.remove('idle'); }
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
      const cBtn = document.getElementById('connect-voice-btn');
      if (cBtn) { cBtn.textContent = 'ВОЙТИ'; cBtn.className = 'svd-connect-btn'; }
      document.getElementById('audio-box').innerHTML = '';
      document.getElementById('screen-grid').innerHTML = '';
      updateMediaStageVisibility();
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
    inWebcam = true; document.getElementById('cam-btn').textContent = '🛑 Камера'; document.getElementById('cam-btn').classList.add('active-cam');
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
    inScreen = true; document.getElementById('screen-btn').textContent = '🛑 Стоп'; document.getElementById('screen-btn').classList.add('active-screen');
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

  function setStageLayout(mode) {
    stageLayoutMode = mode === 'spotlight' ? 'spotlight' : 'grid';
    const grid = document.getElementById('screen-grid');
    if (!grid) return;
    grid.classList.toggle('spotlight-mode', stageLayoutMode === 'spotlight');
    document.getElementById('btn-stage-grid').classList.toggle('active', stageLayoutMode === 'grid');
    document.getElementById('btn-stage-spot').classList.toggle('active', stageLayoutMode === 'spotlight');
    if (stageLayoutMode === 'spotlight' && !grid.querySelector('.featured-tile') && grid.firstElementChild) {
      grid.firstElementChild.classList.add('featured-tile');
    }
  }

  function updateMediaStageVisibility() {
    const grid = document.getElementById('screen-grid');
    const dock = document.getElementById('media-stage-dock');
    if (!grid || !dock) return;
    dock.classList.toggle('show', grid.children.length > 0);
  }

  function toggleMediaNsfwShield(card, btn) {
    if (!card) return;
    const isMasked = card.classList.toggle('nsfw-masked');
    if (btn) { btn.textContent = isMasked ? '👁️ Показать' : '🛡️ 18+'; btn.classList.toggle('active-shield', isMasked); }
    drawSystemPipOverlayFrame();
  }

  function renderMediaTile(id, stream, title, isLocal, kind) {
    const grid = document.getElementById('screen-grid'); let card = document.getElementById('media-tile-' + id);
    const icon = kind === 'cam' ? '📷 ' : '🖥️ ';
    if (!card) {
      card = el('div', 'screen-card'); card.id = 'media-tile-' + id;
      card.onclick = function (ev) {
        if (ev.target.tagName === 'BUTTON') return;
        grid.querySelectorAll('.screen-card').forEach(function (c) { c.classList.remove('featured-tile'); });
        card.classList.add('featured-tile');
        setStageLayout('spotlight');
      };
      const head = el('div', 'screen-card-head'), left = el('div', ''), right = el('div', ''); right.style.cssText = 'display:flex;gap:5px;align-items:center;flex-wrap:wrap;';
      left.appendChild(el('span', '', icon + title)); left.appendChild(el('span', 'screen-live-pill' + (kind === 'cam' ? ' cam' : ''), kind === 'cam' ? 'КАМЕРА' : 'СТРИМ'));
      const shieldBtn = el('button', 'btn-fs', '🛡️ 18+'); shieldBtn.onclick = function () { toggleMediaNsfwShield(card, shieldBtn); }; right.appendChild(shieldBtn);
      const pipBtn = el('button', 'btn-fs', '🪟 Окно'); pipBtn.onclick = function () { toggleExternalOverlay(); }; right.appendChild(pipBtn);
      const fsBtn = el('button', 'btn-fs', '⛶'); fsBtn.onclick = function () { const v = card.querySelector('video'); if (v && v.requestFullscreen) v.requestFullscreen(); }; right.appendChild(fsBtn);
      if (isLocal) { const stopBtn = el('button', 'btn-fs', '✕'); stopBtn.style.background = '#ff1e56'; stopBtn.style.color = '#fff'; stopBtn.onclick = function () { if (kind === 'cam') stopWebcam(false); else stopScreenShare(false); }; right.appendChild(stopBtn); }
      head.appendChild(left); head.appendChild(right);
      const wrap = el('div', 'screen-video-wrap'), vid = document.createElement('video'); vid.autoplay = true; vid.playsInline = true; if (isLocal) vid.muted = true;
      const shield = el('div', 'media-nsfw-shield'); shield.innerHTML = '<div>🔞 Скрыто фильтром 18+</div><span class="btn-cyan" style="padding:4px 10px;font-size:10px;">👁️ Показать</span>';
      shield.onclick = function () { toggleMediaNsfwShield(card, shieldBtn); };
      wrap.appendChild(vid); wrap.appendChild(shield); card.appendChild(head); card.appendChild(wrap); grid.appendChild(card);
    } else {
      card.querySelector('.screen-card-head span').textContent = icon + title;
    }
    const vEl = card.querySelector('video'); if (vEl && vEl.srcObject !== stream) { vEl.srcObject = stream; vEl.play().catch(function () {}); }
    updateMediaStageVisibility();
  }

  function removeMediaTile(id) {
    const c = document.getElementById('media-tile-' + id);
    if (c) c.remove();
    updateMediaStageVisibility();
  }

  function toggleMute() {
    if (!localStream) return; isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    if (rawMicStream) rawMicStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    playUiBeep(isMuted ? 380 : 640, 0.05);
    updateFloatingOverlayUI();
  }

  function toggleDeafen() {
    isDeafened = !isDeafened;
    playUiBeep(isDeafened ? 320 : 680, 0.05);
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
  }

  function playStream(id, stream) {
    if (document.getElementById('aud-' + id)) return;
    const a = document.createElement('audio'); a.id = 'aud-' + id; a.srcObject = stream; a.autoplay = true; a.playsInline = true;
    document.getElementById('audio-box').appendChild(a); applyOutputVolumeToAll(); a.play().catch(function () {});
  }
  function removeAudio(id) { const a = document.getElementById('aud-' + id); if (a) a.remove(); }

  // Глобальный обработчик горячих клавиш и записи биндов
  document.addEventListener('keydown', function (e) {
    if (recordingAction) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        recordingAction = null;
        renderKeybindsUI();
        return;
      }
      const combo = eventToComboString(e);
      if (combo && !['Ctrl', 'Alt', 'Shift'].includes(combo)) {
        userKeybinds[recordingAction] = combo;
        try { localStorage.setItem('cyber_keybinds', JSON.stringify(userKeybinds)); } catch (err) {}
        recordingAction = null;
        renderKeybindsUI();
      }
      return;
    }

    if (e.key === 'Escape') {
      closeSettingsModal();
      closeViewProfileModal();
      closeInviteModal();
      closeMobileDrawers();
      return;
    }

    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const pressedCombo = eventToComboString(e);
    if (!pressedCombo) return;

    if (pressedCombo === userKeybinds.mute) {
      e.preventDefault();
      if (inVoice) toggleMute(); else toggleVoiceCall();
    } else if (pressedCombo === userKeybinds.deafen) {
      e.preventDefault();
      if (inVoice) toggleDeafen();
    } else if (pressedCombo === userKeybinds.cam) {
      e.preventDefault();
      toggleWebcam();
    } else if (pressedCombo === userKeybinds.screen) {
      e.preventDefault();
      toggleScreenShare();
    } else if (pressedCombo === userKeybinds.pip) {
      e.preventDefault();
      toggleExternalOverlay();
    }
  });

  applyNickUI();
  renderKeybindsUI();
  applyAppearanceFromStorage();
  renderServersRail();
  renderServerChannels();
  connectEventStream();
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