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
<meta name="theme-color" content="#04070d">
<title>СИГНАЛ // P2P СИНХРОНИЗАЦИЯ</title>
<script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
<style>
  :root {
    --bg-darkest:#04070d; --bg-servers:#050911; --bg-channels:#070d17; --bg-chat:#08101c;
    --bg-members:#070d17; --bg-userbar:#040810; --bg-card:rgba(10,19,32,0.88); --bg-input:#091320;
    --bg-hover:rgba(20,241,217,0.09); --bg-active:rgba(20,241,217,0.17);
    --brand:#14f1d9; --brand-hover:#5ffbf1; --pink:#ff1e56; --green:#10b981; --red:#ff1e56; --yellow:#fcee09;
    --text-main:#e6f7ff; --text-normal:#b4cde0; --text-muted:#5e7a94; --text-dim:#3b536b;
    --border:rgba(20,241,217,0.16); --pink-border:rgba(255,30,86,0.45); --cyan-border:rgba(20,241,217,0.38);
    --chat-font-size:14px; --hex:polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
    --pcb:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cg fill='none' stroke='%2314f1d9' stroke-width='0.8' stroke-opacity='0.055'%3E%3Cpath d='M0 20h30l15 15v30l15 15h40l20-20h20M20 0v25l20 20h35l15-15h50M0 95h25l20 20v25M80 140v-25l20-20h40'/%3E%3C/g%3E%3C/svg%3E");
  }
  @keyframes neonSpin { 0%{transform:translate(-50%,-50%) rotate(0deg);} 100%{transform:translate(-50%,-50%) rotate(360deg);} }
  @keyframes neonSpinRev { 0%{transform:translate(-50%,-50%) rotate(360deg);} 100%{transform:translate(-50%,-50%) rotate(0deg);} }
  @keyframes boltStrike { 0%,68%,100%{opacity:0;stroke-dashoffset:120;} 72%,84%{opacity:1;stroke-dashoffset:0;} 78%{opacity:0.25;} }
  @keyframes sparkFloat { 0%{transform:translateY(0) scale(0.7);opacity:0;} 40%{opacity:1;} 100%{transform:translateY(-22px) scale(1.15);opacity:0;} }
  @keyframes eqPulse { 0%,100%{transform:scaleY(0.25);opacity:0.45;} 50%{transform:scaleY(1);opacity:1;} }
  @keyframes badgeFlow { 0%{background-position:0% 50%;} 50%{background-position:100% 50%;} 100%{background-position:0% 50%;} }
  @keyframes charBreath { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-3px) scale(1.015);} }
  @keyframes rainFall { 0%{background-position:0 0;} 100%{background-position:-40px 160px;} }

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  body {
    font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;
    background-color:var(--bg-darkest); background-image:var(--pcb); color:var(--text-main);
    height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden; user-select:none;
  }

  /* МИНИ-ШЕСТИУГОЛЬНИКИ В ЧАТЕ И СПИСКЕ УЧАСТНИКОВ С ДВОЙНЫМ НЕОНОМ */
  .hex-wrap { position:relative; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
  .hex-border {
    position:relative; width:100%; height:100%; clip-path:var(--hex);
    background:rgba(20,241,217,0.3); display:flex; align-items:center; justify-content:center;
    padding:2.5px; overflow:hidden; z-index:2;
  }
  .hex-wrap[class*="fx-set"] .hex-border::before,
  .hex-wrap[class*="fx-set"] .hex-border::after {
    content:''; position:absolute; top:50%; left:50%; width:220%; height:220%; z-index:0;
  }
  .hex-wrap[class*="fx-set"] .hex-border::before { animation:neonSpin 2.1s linear infinite; }
  .hex-wrap[class*="fx-set"] .hex-border::after { width:190%; height:190%; animation:neonSpinRev 2.9s linear infinite; opacity:0.9; }

  /* Набор 1: Люси из видео (Двойной контур Розовый + Голубой циан + электро-свечение) */
  .hex-wrap.fx-set1 { filter:drop-shadow(0 0 6px #00f0ff) drop-shadow(0 0 11px #ff1e8a); }
  .hex-wrap.fx-set1 .hex-border::before { background:conic-gradient(from 0deg, #ff1e8a 0%, #00f0ff 35%, transparent 50%, #ff1e8a 75%, #00f0ff 100%); }
  .hex-wrap.fx-set1 .hex-border::after { background:conic-gradient(from 180deg, #00f0ff 0%, transparent 40%, #ff1e8a 70%, #ffffff 100%); }

  /* Набор 2: Дэвид Сандевистан (Жёлтый + Изумрудный неон) */
  .hex-wrap.fx-set2 { filter:drop-shadow(0 0 6px #fcee09) drop-shadow(0 0 11px #00ff9d); }
  .hex-wrap.fx-set2 .hex-border::before { background:conic-gradient(from 0deg, #fcee09 0%, #00ff9d 40%, transparent 55%, #ff0055 80%, #fcee09 100%); }
  .hex-wrap.fx-set2 .hex-border::after { background:conic-gradient(from 90deg, #00ff9d 0%, transparent 45%, #fcee09 80%, #ffffff 100%); }

  /* Набор 3: Джонни Сильверхенд & V (Красный Relic + Циан) */
  .hex-wrap.fx-set3 { filter:drop-shadow(0 0 7px #ff003c) drop-shadow(0 0 12px #00f0ff); }
  .hex-wrap.fx-set3 .hex-border::before { background:conic-gradient(from 0deg, #ff003c 0%, #00f0ff 35%, transparent 50%, #ff003c 75%, #fcee09 100%); }
  .hex-wrap.fx-set3 .hex-border::after { background:conic-gradient(from 180deg, #00f0ff 0%, transparent 45%, #ff003c 80%, #ffffff 100%); }

  .hex-core {
    position:relative; z-index:2; width:100%; height:100%; clip-path:var(--hex);
    background:linear-gradient(145deg,#101d30,#08101c); color:#fff; font-weight:800;
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .hex-status-dot {
    position:absolute; right:-2px; bottom:-2px; width:11px; height:11px;
    clip-path:var(--hex); background:var(--green); border:1.5px solid #04070d; z-index:4;
  }
  .hex-status-dot.idle { background:var(--yellow); }
  .hex-status-dot.dnd { background:var(--red); }
  .hex-status-dot.invisible,.hex-status-dot.offline,.hex-status-dot.off { background:var(--text-dim); }

  /* СЦЕНА ПРОФИЛЯ КАК НА ВИДЕО: ДВОЙНОЙ 6-УГОЛЬНИК + ЗИГЗАГИ МОЛНИЙ + ИСКРЫ + ПЕРСОНАЖ СПРАВА ВНАХЛЁСТ */
  .cyber-diode-scene {
    position:relative; width:195px; height:136px; margin-top:-58px; margin-left:6px;
    display:flex; align-items:center; justify-content:flex-start; flex-shrink:0;
  }
  .cds-hex-frame {
    position:relative; width:128px; height:128px; z-index:2;
  }
  .cds-inner-art {
    position:absolute; inset:16px; clip-path:var(--hex); z-index:1;
    display:flex; align-items:center; justify-content:center; overflow:hidden;
    background:#09111e;
  }
  .cds-nick-overlay {
    position:relative; z-index:3; font-size:22px; font-weight:900; color:#fff;
    text-shadow:0 0 10px rgba(0,0,0,0.9), 0 0 14px #00f0ff; letter-spacing:1px;
  }
  .cds-neon-svg {
    position:absolute; inset:-14px; width:156px; height:156px; z-index:3;
    pointer-events:none; overflow:visible;
  }
  .cds-bolt {
    fill:none; stroke-width:2.3; stroke-linecap:round; stroke-linejoin:round;
    stroke-dasharray:120; animation:boltStrike 2.3s infinite;
  }
  .cds-bolt.b2 { animation-delay:0.8s; }
  .cds-bolt.b3 { animation-delay:1.5s; }
  .cds-spark { animation:sparkFloat 2.1s ease-in-out infinite; }
  .cds-spark.s2 { animation-delay:0.7s; }
  .cds-spark.s3 { animation-delay:1.3s; }
  .cds-character-right {
    position:absolute; right:-8px; bottom:-4px; width:108px; height:142px;
    z-index:4; pointer-events:none; animation:charBreath 3.4s ease-in-out infinite;
  }

  /* БЕЙДЖИ СПРАВА ОТ НИКА */
  .cyber-badge {
    display:inline-flex; align-items:center; gap:3px; padding:1.5px 6px; border-radius:4px;
    font-size:9px; font-weight:900; letter-spacing:0.5px; text-transform:uppercase;
    white-space:nowrap; flex-shrink:0; background-size:200% 200%; animation:badgeFlow 2.5s ease infinite;
  }
  .cyber-badge.b-set1 { background-image:linear-gradient(90deg,#ff1e8a,#00f0ff,#ff1e8a); color:#fff; box-shadow:0 0 8px rgba(0,240,255,0.65); }
  .cyber-badge.b-set2 { background-image:linear-gradient(90deg,#fcee09,#00ff9d,#fcee09); color:#04120c; box-shadow:0 0 8px rgba(252,238,9,0.65); }
  .cyber-badge.b-set3 { background-image:linear-gradient(90deg,#ff003c,#00f0ff,#ff003c); color:#fff; box-shadow:0 0 8px rgba(255,0,60,0.7); }

  /* ТЕМАТИЧЕСКИЕ ФОНЫ И РАМКИ КАРТОЧЕК ПРОФИЛЯ (НАЙТ-СИТИ В ДОЖДЕ, ЛУНА, АРАСАКА) */
  .profile-surface { position:relative; background:#050a14; border:1px solid var(--border); border-radius:12px; overflow:hidden; transition:0.25s; }
  /* Набор 1: Дождливый Найт-Сити из видео с Люси */
  .profile-surface.theme-set1 {
    border:2px solid #00f0ff;
    box-shadow:0 0 26px rgba(0,240,255,0.45), 0 0 14px rgba(255,30,138,0.45), inset 0 0 24px rgba(255,30,138,0.22);
    background:
      repeating-linear-gradient(108deg, rgba(0,240,255,0.06) 0px, rgba(0,240,255,0.06) 1px, transparent 1px, transparent 18px),
      radial-gradient(circle at 80% 18%, rgba(255,30,138,0.28), rgba(0,240,255,0.14) 45%, #050914 92%);
  }
  /* Набор 2: Изумрудно-жёлтый овердрайв Дэвида и купол Луны */
  .profile-surface.theme-set2 {
    border:2px solid #fcee09;
    box-shadow:0 0 26px rgba(252,238,9,0.45), inset 0 0 22px rgba(0,255,157,0.22);
    background:radial-gradient(circle at 80% 18%, rgba(252,238,9,0.25), rgba(0,255,157,0.12) 48%, #041012 94%);
  }
  /* Набор 3: Багрово-бирюзовый глитч Cyberpunk 2077 */
  .profile-surface.theme-set3 {
    border:2px solid #ff003c;
    box-shadow:0 0 26px rgba(255,0,60,0.55), inset 0 0 22px rgba(0,240,255,0.2);
    background:radial-gradient(circle at 80% 18%, rgba(255,0,60,0.28), rgba(0,240,255,0.1) 52%, #110409 95%);
  }

  /* ВЕРХНЯЯ ШАПКА */
  .top-telemetry-bar { height:40px; background:rgba(4,7,13,0.95); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 14px; gap:10px; flex-shrink:0; z-index:30; }
  .tt-left,.tt-right { display:flex; align-items:center; gap:10px; }
  .tt-logo { display:flex; align-items:center; gap:7px; font-weight:900; font-size:13px; letter-spacing:1px; color:#fff; }
  .tt-cyber-tag { background:rgba(255,30,86,0.2); border:1px solid var(--pink-border); color:#ff6b8b; font-size:9.5px; font-weight:800; padding:2px 7px; border-radius:4px; }
  .tt-proto-pill { background:rgba(20,241,217,0.06); border:1px solid var(--border); color:var(--text-muted); font-size:10px; font-weight:700; padding:3px 10px; border-radius:4px; }
  .tt-node-pill { display:flex; align-items:center; gap:6px; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.4); color:#6ee7b7; font-size:11px; font-weight:700; padding:4px 11px; border-radius:6px; }
  .tt-node-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 8px var(--green); }
  .tt-invite-btn { background:linear-gradient(135deg,rgba(255,30,86,0.3),rgba(157,23,77,0.45)); border:1px solid var(--pink); color:#fff; font-size:11px; font-weight:800; padding:5px 13px; border-radius:6px; cursor:pointer; }

  .sub-sync-bar { height:32px; background:rgba(6,11,20,0.9); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 14px; font-size:11px; flex-shrink:0; }
  .ss-left { display:flex; align-items:center; gap:8px; font-weight:700; color:var(--brand); }
  .ss-right { display:flex; align-items:center; gap:8px; }
  .ss-btn { background:rgba(20,241,217,0.07); border:1px solid var(--border); color:var(--text-main); font-size:10.5px; font-weight:700; padding:3px 10px; border-radius:4px; cursor:pointer; display:flex; align-items:center; gap:5px; }
  .ss-btn:hover { border-color:var(--brand); color:var(--brand); }
  .ss-btn.fx-btn { background:linear-gradient(90deg,rgba(255,30,138,0.28),rgba(0,240,255,0.25)); border-color:#ff1e8a; color:#fff; }

  /* СЕТКА ПРИЛОЖЕНИЯ */
  .app-layout { flex:1; display:flex; width:100%; min-height:0; overflow:hidden; position:relative; }
  .servers-rail { width:68px; background:rgba(4,7,13,0.92); border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:10px; overflow-y:auto; flex-shrink:0; z-index:20; }
  .servers-rail::-webkit-scrollbar { display:none; }
  .srv-pill-wrap { position:relative; width:68px; display:flex; justify-content:center; align-items:center; }
  .srv-pill-bar { position:absolute; left:0; width:3px; height:10px; background:var(--brand); opacity:0; transition:0.18s; }
  .srv-pill-wrap:hover .srv-pill-bar { opacity:1; height:20px; }
  .srv-pill-wrap.active .srv-pill-bar { opacity:1; height:36px; }
  .srv-ico { width:44px; height:44px; clip-path:var(--hex); background:#0c1626; color:var(--text-normal); font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:0.18s; }
  .srv-ico:hover,.srv-pill-wrap.active .srv-ico { background:var(--brand); color:#031518; box-shadow:0 0 14px rgba(20,241,217,0.6); }
  .srv-ico.home-ico { background:#0d1829; color:var(--yellow); font-size:18px; }
  .srv-ico-action { width:44px; height:44px; clip-path:var(--hex); background:rgba(255,30,86,0.16); color:var(--pink); font-size:20px; font-weight:800; display:flex; align-items:center; justify-content:center; cursor:pointer; }

  .workspace { flex:1; display:grid; grid-template-columns:250px 1fr 245px; min-height:0; overflow:hidden; position:relative; }
  body.hide-members-panel .workspace { grid-template-columns:250px 1fr; }
  body.hide-members-panel .right-panel { display:none; }

  /* ЛЕВАЯ КОЛОНКА КАНАЛОВ */
  .channels-panel { background:rgba(6,11,20,0.88); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; height:100%; }
  .srv-header { padding:12px 14px 10px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .srv-sub-label { font-size:9px; font-weight:800; text-transform:uppercase; color:var(--brand); letter-spacing:0.8px; }
  .srv-title { font-size:17px; font-weight:900; color:#fff; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .srv-badge-open { background:rgba(20,241,217,0.08); border:1px solid var(--cyan-border); color:var(--brand); font-size:9.5px; font-weight:700; padding:3px 8px; border-radius:4px; cursor:pointer; }
  .packet-card { margin:10px 10px 6px; padding:9px 12px; background:linear-gradient(135deg,rgba(255,30,86,0.14),rgba(10,19,32,0.9)); border:1px solid var(--pink-border); border-radius:8px; display:flex; justify-content:space-between; align-items:center; }
  .pk-label { font-size:9px; font-weight:800; color:var(--text-normal); }
  .pk-val { font-size:11px; font-weight:800; color:#fff; font-family:monospace; }
  .pk-live { font-size:9.5px; font-weight:800; color:var(--pink); }
  .channels-scroll { flex:1; overflow-y:auto; padding:6px 10px 12px; }
  .channels-scroll::-webkit-scrollbar { width:4px; }
  .btn-create-ch-wide { width:100%; background:rgba(20,241,217,0.05); border:1px solid var(--border); color:var(--text-main); font-size:11px; font-weight:800; padding:8px 10px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; margin:6px 0 10px; }
  .cat-header { display:flex; align-items:center; justify-content:space-between; padding:8px 4px 5px; font-size:10.5px; font-weight:800; text-transform:uppercase; color:var(--text-muted); }
  .cat-add-btn { background:rgba(20,241,217,0.08); border:1px solid var(--border); color:var(--brand); width:20px; height:20px; border-radius:4px; font-size:14px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .ch-btn,.voice-ch-box { display:flex; align-items:center; justify-content:space-between; padding:7px 10px; border-radius:6px; font-size:13px; font-weight:600; color:var(--text-normal); cursor:pointer; margin-bottom:3px; border:1px solid transparent; }
  .ch-btn:hover,.voice-ch-box:hover { background:var(--bg-hover); color:#fff; }
  .ch-btn.active { background:var(--bg-active); border-color:var(--cyan-border); color:#fff; }
  .voice-ch-box.active { background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.45); color:#6ee7b7; }
  .ch-left { display:flex; align-items:center; gap:7px; min-width:0; flex:1; }
  .ch-hash { color:var(--brand); font-size:13px; font-weight:800; width:16px; text-align:center; }
  .ch-name-txt { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ch-unread-badge { background:var(--pink); color:#fff; font-size:10px; font-weight:800; padding:1px 6px; border-radius:999px; }
  .off-badge { font-size:9px; color:var(--text-muted); font-weight:800; }
  .off-badge.on { color:var(--green); }
  .voice-connected-users { display:flex; flex-direction:column; gap:4px; padding:2px 0 6px 18px; }
  .vc-user-row { display:flex; align-items:center; gap:7px; padding:3px 6px; border-radius:4px; font-size:12px; color:var(--text-normal); cursor:pointer; }

  /* ГОЛОСОВОЙ ДОК СНИЗУ СЛЕВА */
  .sidebar-voice-dock { background:rgba(6,16,26,0.96); border-top:1px solid var(--cyan-border); padding:9px 10px; display:flex; flex-direction:column; gap:7px; flex-shrink:0; }
  .svd-top { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .svd-state-row { font-size:10.5px; font-weight:800; color:var(--green); text-transform:uppercase; }
  .svd-state-row.idle { color:var(--text-muted); }
  .svd-channel-name { font-size:12px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .svd-hangup-btn { background:rgba(255,30,86,0.2); border:1px solid var(--pink); color:#ff80a0; padding:4px 8px; border-radius:5px; font-size:11px; font-weight:800; cursor:pointer; }
  .svd-connect-btn { background:var(--brand); border:none; color:#031518; padding:5px 10px; border-radius:5px; font-size:10.5px; font-weight:800; cursor:pointer; }
  .svd-actions { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
  .svd-btn { background:#0d1829; border:1px solid var(--border); color:var(--text-normal); padding:5px 4px; border-radius:5px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; }
  .svd-btn.active-cam { background:rgba(16,185,129,0.25); border-color:var(--green); color:#6ee7b7; }
  .svd-btn.active-screen { background:rgba(255,30,86,0.25); border-color:var(--pink); color:#ffaec2; }

  .user-bar { height:54px; padding:0 10px; background:var(--bg-userbar); border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:6px; flex-shrink:0; }
  .user-info { display:flex; align-items:center; gap:8px; padding:4px; border-radius:6px; cursor:pointer; flex:1; min-width:0; }
  .user-name-row { display:flex; align-items:center; gap:5px; min-width:0; }
  .user-name { font-size:13px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-sub { font-size:10px; color:var(--brand); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-bar-controls { display:flex; align-items:center; gap:4px; }
  .ub-ctrl-btn { width:30px; height:30px; clip-path:var(--hex); background:#0d1829; border:none; color:var(--brand); font-size:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .ub-ctrl-btn.off { background:rgba(255,30,86,0.25); color:var(--pink); }

  /* ЦЕНТРАЛЬНАЯ ЗОНА И СЦЕНА КАМЕР */
  .main-chat { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; }
  .audio-stream-header-card { margin:10px 14px 4px; padding:10px 14px; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; display:flex; align-items:center; justify-content:space-between; gap:14px; flex-shrink:0; }
  .ash-left { display:flex; align-items:center; gap:10px; min-width:0; }
  .ash-label { font-size:10px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .ash-channel { font-size:14px; font-weight:800; color:#fff; }
  .ash-wave { flex:1; height:26px; display:flex; align-items:center; justify-content:center; gap:3px; overflow:hidden; max-width:380px; }
  .ash-bar { width:3px; height:100%; background:var(--brand); border-radius:2px; opacity:0.35; transform:scaleY(0.25); }
  body.voice-live .ash-bar { animation:eqPulse 0.9s ease-in-out infinite; }
  .ash-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }

  .media-stage-dock { margin:6px 14px; background:rgba(5,10,18,0.95); border:1px solid var(--cyan-border); border-radius:10px; padding:10px; display:none; flex-direction:column; gap:8px; max-height:52vh; overflow-y:auto; flex-shrink:0; }
  .media-stage-dock.show { display:flex; }
  .msd-header { display:flex; justify-content:space-between; align-items:center; gap:8px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .msd-title { font-size:11px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .msd-layout-btn { background:#0d1829; border:1px solid var(--border); color:var(--text-normal); padding:3px 9px; border-radius:4px; font-size:10.5px; font-weight:700; cursor:pointer; }
  .msd-layout-btn.active { background:var(--brand); color:#031518; border-color:var(--brand); }
  .screen-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; width:100%; }
  .screen-grid.spotlight-mode { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  .screen-grid.spotlight-mode .screen-card.featured-tile { grid-column:1 / -1; }
  .screen-card { background:#04070d; border:1px solid var(--border); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; cursor:pointer; }
  .screen-card.featured-tile { border-color:var(--brand); }
  .screen-card-head { display:flex; justify-content:space-between; align-items:center; padding:5px 9px; background:rgba(4,7,13,0.92); border-bottom:1px solid var(--border); font-size:11px; font-weight:700; color:var(--text-main); gap:6px; flex-wrap:wrap; }
  .screen-live-pill { background:var(--pink); color:#fff; font-size:9px; padding:1px 6px; border-radius:4px; margin-left:6px; }
  .screen-live-pill.cam { background:var(--green); color:#031518; }
  .screen-video-wrap { position:relative; width:100%; background:#000; display:flex; align-items:center; justify-content:center; min-height:140px; max-height:290px; overflow:hidden; }
  .screen-card.featured-tile .screen-video-wrap { max-height:360px; }
  .screen-video-wrap video { width:100%; max-height:360px; object-fit:contain; background:#000; display:block; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter:blur(26px) brightness(0.3); }
  .media-nsfw-shield { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:rgba(4,7,13,0.85); color:var(--pink); font-size:12px; font-weight:800; z-index:5; cursor:pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display:flex; }
  .btn-fs { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:3px 7px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; }

  .chat-scroll-area { flex:1; overflow-y:auto; padding:8px 14px; display:flex; flex-direction:column; gap:6px; min-height:0; }
  .messages-container { display:flex; flex-direction:column; gap:6px; }
  .msg-item { display:flex; gap:12px; padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:8px; }
  body.compact-chat .msg-item { padding:4px 10px; }
  .msg-head-line { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .msg-author { font-size:13.5px; font-weight:800; color:var(--brand); cursor:pointer; }
  .msg-time { font-size:10.5px; color:var(--text-muted); font-family:monospace; }
  .msg-text { font-size:var(--chat-font-size); color:var(--text-main); margin-top:3px; line-height:1.4; user-select:text; word-break:break-word; }
  .msg-text a { color:var(--brand); text-decoration:none; border-bottom:1px dashed var(--brand); }
  .chat-inline-media { max-width:min(100%,420px); max-height:260px; border-radius:6px; margin-top:6px; display:block; border:1px solid var(--cyan-border); }
  .filtered-block-card { display:inline-flex; align-items:center; gap:8px; background:rgba(255,30,86,0.12); border:1px dashed var(--pink-border); color:#ff80a0; padding:6px 10px; border-radius:6px; font-size:12px; margin-top:4px; }
  .spoiler-blur-wrap { position:relative; display:inline-block; width:100%; background:#060b14; border:1px solid var(--pink-border); border-radius:6px; padding:8px 10px; margin-top:4px; cursor:pointer; }
  .spoiler-blur-content { filter:blur(8px); user-select:none; pointer-events:none; }
  .spoiler-blur-wrap.revealed .spoiler-blur-content { filter:none; user-select:text; pointer-events:auto; }
  .spoiler-badge { font-size:11px; font-weight:700; color:var(--pink); margin-bottom:4px; }
  .spoiler-blur-wrap.revealed .spoiler-badge { display:none; }

  .chat-bottom { padding:6px 14px 10px; flex-shrink:0; }
  .console-box { background:var(--bg-card); border:1px solid var(--cyan-border); border-radius:8px; padding:6px 12px 8px; display:flex; flex-direction:column; gap:5px; }
  .console-top-label { display:flex; justify-content:space-between; font-size:9.5px; font-weight:800; color:var(--text-muted); text-transform:uppercase; }
  .input-row { display:flex; align-items:center; gap:10px; }
  .chat-inp { flex:1; min-width:0; background:#050a12; border:1px solid var(--border); border-radius:6px; padding:8px 12px; color:var(--text-main); font-size:13.5px; outline:none; }

  /* ПРАВАЯ КОЛОНКА И ВЫЕЗЖАЮЩИЙ ПРОФИЛЬ */
  .right-panel { width:245px; background:rgba(6,11,20,0.88); border-left:1px solid var(--border); padding:12px 10px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; height:100%; }
  .telemetry-mini-card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:9px 10px; margin-bottom:6px; font-size:10.5px; }
  .tm-row { display:flex; justify-content:space-between; color:var(--text-normal); margin-top:4px; font-family:monospace; }
  .tm-val { color:var(--brand); font-weight:700; }
  .right-sec-title { font-size:10.5px; text-transform:uppercase; color:var(--brand); font-weight:800; padding:8px 6px 4px; }
  .online-user-item { display:flex; align-items:center; gap:8px; padding:5px 7px; border-radius:6px; cursor:pointer; min-width:0; }
  .online-user-item:hover { background:var(--bg-hover); }
  .member-text-col { flex:1; overflow:hidden; display:flex; flex-direction:column; min-width:0; }
  .member-nick-row { display:flex; align-items:center; gap:5px; font-size:13px; font-weight:700; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .member-status-sub { font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mini-btn { background:rgba(20,241,217,0.08); border:1px solid var(--border); color:var(--brand); padding:2px 7px; border-radius:4px; font-size:10px; font-weight:800; cursor:pointer; }
  .friend-tag { font-size:9.5px; color:var(--green); font-weight:800; }

  .profile-drawer-backdrop { position:fixed; inset:0; background:rgba(2,5,10,0.55); backdrop-filter:blur(2px); z-index:970; display:none; }
  .profile-drawer-backdrop.open { display:block; }
  .profile-slide-drawer { position:fixed; top:40px; right:0; bottom:24px; width:365px; max-width:94vw; z-index:975; transform:translateX(106%); transition:transform 0.28s cubic-bezier(0.16,1,0.3,1); display:flex; flex-direction:column; padding:12px; pointer-events:none; }
  .profile-slide-drawer.open { transform:translateX(0); pointer-events:auto; }
  .psd-inner { flex:1; display:flex; flex-direction:column; overflow-y:auto; }
  .dp-banner { height:118px; background:linear-gradient(90deg,var(--brand),var(--pink)); position:relative; flex-shrink:0; overflow:hidden; }
  .dp-banner-svg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; pointer-events:none; }
  .dp-close-x { position:absolute; top:10px; right:10px; width:28px; height:28px; border-radius:6px; background:rgba(4,7,13,0.78); border:1px solid var(--border); color:#fff; font-weight:800; cursor:pointer; z-index:5; }
  .dp-body { padding:10px 16px 16px; position:relative; flex:1; display:flex; flex-direction:column; gap:10px; }
  .dp-nick-line { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .dp-nick { font-size:18px; font-weight:900; color:#fff; }
  .dp-status { font-size:12.5px; color:var(--brand); }
  .dp-sec { background:rgba(4,7,13,0.72); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px; }
  .dp-sec-title { font-size:10px; font-weight:800; color:var(--brand); margin-bottom:5px; text-transform:uppercase; }
  .dp-bio { font-size:12.5px; color:var(--text-normal); white-space:pre-wrap; }
  .dp-tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:4px; }
  .dp-tag { background:rgba(20,241,217,0.12); border:1px solid var(--border); color:var(--brand); padding:3px 8px; border-radius:4px; font-size:11px; font-weight:700; }
  .dp-actions-col { display:flex; flex-direction:column; gap:7px; margin-top:auto; padding-top:8px; }
  .status-pill { font-size:10px; padding:2px 7px; border-radius:4px; font-weight:800; }
  .status-pill.on { background:rgba(16,185,129,0.18); color:var(--green); }
  .status-pill.off { background:rgba(255,255,255,0.06); color:var(--text-muted); }

  .bottom-status-footer { height:24px; background:#03060b; border-top:1px solid var(--border); padding:0 14px; display:flex; align-items:center; justify-content:space-between; font-size:10px; font-family:monospace; color:var(--text-muted); flex-shrink:0; }
  .bsf-green { color:var(--brand); font-weight:700; }

  .btn-cyan { background:var(--brand); color:#031518; border:none; padding:7px 14px; border-radius:6px; font-weight:800; font-size:11.5px; text-transform:uppercase; cursor:pointer; white-space:nowrap; }
  .btn-danger { background:var(--pink); color:#fff; border:none; padding:7px 12px; border-radius:6px; font-weight:800; font-size:11.5px; text-transform:uppercase; cursor:pointer; }
  .btn-login-mini { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:6px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; }
  .btn-tg { background:var(--brand); color:#031518; border:none; width:100%; padding:10px 14px; border-radius:6px; font-weight:800; font-size:12.5px; text-transform:uppercase; cursor:pointer; margin-bottom:10px; }

  .floating-call-overlay { position:fixed; right:18px; bottom:40px; width:285px; background:rgba(5,9,16,0.96); border:1px solid var(--brand); border-radius:8px; padding:10px 12px; z-index:980; display:none; flex-direction:column; gap:8px; }
  .floating-call-overlay.show { display:flex; }
  .fco-head { display:flex; justify-content:space-between; align-items:center; cursor:move; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .fco-live { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:800; color:var(--green); }
  .fco-pulse { width:8px; height:8px; clip-path:var(--hex); background:var(--green); }
  .fco-timer { font-size:11px; font-family:monospace; color:var(--brand); }
  .fco-peers { display:flex; flex-wrap:wrap; gap:5px; max-height:70px; overflow-y:auto; }
  .fco-peer-chip { display:inline-flex; align-items:center; gap:5px; background:#0d1829; border:1px solid var(--border); padding:3px 8px; border-radius:4px; font-size:11px; color:#fff; }
  .fco-actions { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
  .fco-btn { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:6px 4px; border-radius:4px; font-size:10.5px; font-weight:700; cursor:pointer; }
  .fco-btn.danger { background:var(--pink); border-color:var(--pink); color:#fff; }

  .modal-backdrop { position:fixed; inset:0; background:rgba(2,5,10,0.84); backdrop-filter:blur(5px); display:none; align-items:center; justify-content:center; z-index:999; padding:12px; }
  .modal-backdrop.open { display:flex; }
  .modal-box { background:#070d17; border:1px solid var(--brand); border-radius:10px; padding:20px; width:400px; max-width:100%; }
  .modal-box input[type="text"],.modal-box input[type="password"],.modal-box textarea,.modal-box select { width:100%; padding:10px; background:#040810; border:1px solid var(--border); border-radius:6px; color:#fff; margin-bottom:10px; font-size:13px; outline:none; }
  .link-box { background:#040810; border:1px dashed var(--brand); padding:10px; color:var(--brand); font-size:12px; word-break:break-all; margin-bottom:10px; border-radius:6px; display:block; text-align:center; text-decoration:none; }
  .auth-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:12px; background:#040810; padding:4px; border-radius:6px; border:1px solid var(--border); }
  .auth-tab { padding:7px; font-size:12px; font-weight:700; text-align:center; cursor:pointer; color:var(--text-muted); border-radius:4px; }
  .auth-tab.active { background:var(--brand); color:#031518; }

  .settings-modal-box { background:#070d17; border:1px solid var(--brand); border-radius:10px; width:900px; max-width:100%; height:640px; max-height:92vh; display:grid; grid-template-columns:220px minmax(0,1fr); overflow:hidden; }
  .settings-nav { background:#050911; border-right:1px solid var(--border); padding:16px 10px; display:flex; flex-direction:column; gap:3px; overflow-y:auto; }
  .settings-nav-label { font-size:10px; font-weight:800; text-transform:uppercase; color:var(--brand); padding:8px 10px 4px; }
  .settings-nav-btn { padding:8px 10px; border-radius:6px; font-size:12.5px; font-weight:600; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; gap:8px; white-space:nowrap; }
  .settings-nav-btn.active { background:var(--bg-active); color:var(--brand); border-left:2px solid var(--brand); }
  .settings-content { padding:20px 24px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; min-width:0; }
  .settings-pane { display:none; flex-direction:column; gap:12px; min-width:0; }
  .settings-pane.active { display:flex; }
  .settings-head { display:flex; justify-content:space-between; align-items:center; gap:10px; border-bottom:1px solid var(--border); padding-bottom:10px; flex-wrap:wrap; }
  .settings-head h3 { font-size:16px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .field-label { font-size:10.5px; font-weight:800; text-transform:uppercase; color:var(--brand); margin-bottom:6px; display:block; }
  .settings-card { background:rgba(4,8,16,0.9); border:1px solid var(--border); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:10px; }
  .settings-grid-2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; }
  .settings-card input[type="text"],.settings-card textarea,.settings-card select { width:100%; padding:8px 10px; background:#03060c; border:1px solid var(--border); border-radius:6px; color:#fff; font-size:13px; outline:none; }
  .toggle-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid var(--border); }
  .toggle-row:last-child { border-bottom:none; }
  .toggle-title { font-size:13px; font-weight:600; color:#fff; }
  .cyber-switch { position:relative; display:inline-block; width:40px; height:22px; flex-shrink:0; cursor:pointer; }
  .cyber-switch input { opacity:0; width:0; height:0; }
  .cyber-slider { position:absolute; inset:0; background:#101929; border:1px solid var(--border); border-radius:20px; transition:0.2s; }
  .cyber-slider::before { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; background:var(--text-muted); clip-path:var(--hex); transition:0.2s; }
  .cyber-switch input:checked + .cyber-slider { background:rgba(20,241,217,0.22); border-color:var(--brand); }
  .cyber-switch input:checked + .cyber-slider::before { transform:translateX(18px); background:var(--brand); }
  .cyber-range { -webkit-appearance:none; appearance:none; width:100%; height:6px; background:#03060c; border:1px solid var(--border); border-radius:4px; outline:none; margin-top:4px; }
  .cyber-range::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; clip-path:var(--hex); background:var(--brand); cursor:pointer; }
  .color-swatches { display:flex; gap:8px; flex-wrap:wrap; }
  .color-swatch { width:26px; height:26px; clip-path:var(--hex); cursor:pointer; }
  .mic-meter-wrap { width:100%; height:8px; background:#03060c; border:1px solid var(--border); border-radius:4px; overflow:hidden; }
  .mic-meter-bar { height:100%; width:0%; background:linear-gradient(90deg,var(--green),var(--brand),var(--pink)); transition:width 0.06s; }

  .fx-sets-grid { display:flex; flex-direction:column; gap:14px; }
  .fx-bundle-card { border-radius:12px; padding:14px 18px; display:flex; align-items:center; justify-content:space-between; gap:16px; border:1.5px solid var(--border); background:rgba(5,10,18,0.94); }
  .fx-bundle-card.set1-card { border-color:#00f0ff; box-shadow:0 0 20px rgba(255,30,138,0.28); background:linear-gradient(135deg,rgba(255,30,138,0.18),rgba(0,240,255,0.12),rgba(5,10,18,0.96)); }
  .fx-bundle-card.set2-card { border-color:#fcee09; box-shadow:0 0 20px rgba(252,238,9,0.24); background:linear-gradient(135deg,rgba(252,238,9,0.16),rgba(0,255,157,0.12),rgba(5,10,18,0.96)); }
  .fx-bundle-card.set3-card { border-color:#ff003c; box-shadow:0 0 20px rgba(255,0,60,0.28); background:linear-gradient(135deg,rgba(255,0,60,0.2),rgba(0,240,255,0.1),rgba(5,10,18,0.96)); }
  .fxb-left { display:flex; align-items:center; gap:16px; min-width:0; flex:1; }

  .keybind-row { display:flex; justify-content:space-between; align-items:center; padding:9px 12px; background:#040810; border:1px solid var(--border); border-radius:6px; gap:10px; }
  .kb-btn { background:#0d1829; border:1px solid var(--cyan-border); color:var(--brand); font-family:monospace; font-size:12px; font-weight:800; padding:6px 14px; border-radius:5px; cursor:pointer; min-width:140px; text-align:center; }
  .kb-btn.recording { background:rgba(255,30,86,0.25); border-color:var(--pink); color:#fff; }

  .mob-top-btn { display:none; background:transparent; border:none; color:var(--brand); font-size:20px; cursor:pointer; }
  .mob-drawer-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.72); z-index:940; }
  .mob-bottom-nav { display:none; height:52px; background:#04070d; border-top:1px solid var(--border); grid-template-columns:repeat(5,1fr); align-items:center; flex-shrink:0; z-index:960; }
  .mob-nav-item { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; height:100%; color:var(--text-muted); font-size:10px; font-weight:700; cursor:pointer; }
  .mob-nav-item.active { color:var(--brand); background:rgba(20,241,217,0.08); }

  @media (max-width:900px) {
    .tt-proto-pill,.ash-wave,.bottom-status-footer { display:none; }
    .workspace { display:flex; flex-direction:column; flex:1; }
    .main-chat { flex:1; width:100%; height:100%; }
    .mob-top-btn { display:inline-flex; }
    .mob-bottom-nav { display:grid; }
    .servers-rail { position:fixed; top:0; bottom:52px; left:0; width:68px; z-index:955; transform:translateX(-340px); transition:transform 0.24s; }
    .channels-panel { position:fixed; top:0; bottom:52px; left:68px; width:calc(100vw - 68px); max-width:260px; z-index:955; transform:translateX(-340px); transition:transform 0.24s; }
    body.mob-left-open .servers-rail,body.mob-left-open .channels-panel,body.mob-right-open .right-panel { transform:translateX(0); }
    .right-panel { position:fixed; top:0; bottom:52px; right:0; width:min(86vw,280px); z-index:955; transform:translateX(105%); transition:transform 0.24s; }
    body.mob-left-open .mob-drawer-backdrop,body.mob-right-open .mob-drawer-backdrop { display:block; }
    .chat-inp { font-size:16px; }
    .floating-call-overlay { right:10px; left:10px; width:auto; bottom:60px; }
    .settings-modal-box { grid-template-columns:1fr; grid-template-rows:auto 1fr; height:92dvh; }
    .settings-nav { flex-direction:row; overflow-x:auto; padding:8px; }
    .settings-nav-label { display:none; }
    .settings-grid-2,.fx-bundle-card,.fxb-left { grid-template-columns:1fr; flex-direction:column; align-items:flex-start; }
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
      <div class="tt-node-pill"><span class="tt-node-dot"></span><span id="tt-node-label">Узел активен • cy-4371</span></div>
      <button class="tt-invite-btn" onclick="openInviteModal()">+ ПРИГЛАСИТЬ ДРУГА</button>
    </div>
  </div>

  <div class="sub-sync-bar">
    <div class="ss-left"><span>● АКТИВНАЯ СЕТЬ:</span><span style="color:#fff;font-weight:800;">P2P СИНХРОНИЗАЦИЯ</span></div>
    <div class="ss-right">
      <button class="ss-btn fx-btn" onclick="openSettingsModal('fx')">✨ ЭФФЕКТЫ</button>
      <button class="ss-btn" onclick="openSettingsModal('keybinds')">⌨️ БИНДЫ</button>
      <button class="ss-btn" onclick="openSettingsModal('profile')">👤 ПРОФИЛЬ</button>
      <button class="ss-btn" onclick="if(window.innerWidth<=900)toggleMobileRight();else document.body.classList.toggle('hide-members-panel');">👥 УЧАСТНИКИ</button>
    </div>
  </div>

  <div class="app-layout">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>
    <div class="servers-rail">
      <div class="srv-pill-wrap" title="Эффекты и профиль" onclick="openSettingsModal('fx')">
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
            <button class="svd-btn" id="pip-overlay-btn" onclick="toggleExternalOverlay()">🪟 Оверлей</button>
          </div>
          <div id="audio-box" style="display:none;"></div>
        </div>

        <div class="user-bar">
          <div class="user-info" onclick="openUserProfileCard(getMyMemberObject())">
            <div class="hex-wrap" id="user-ava-wrap" style="width:36px;height:36px;">
              <div class="hex-border"><div class="hex-core" id="user-ava" style="font-size:11px;">ГО</div></div>
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
            <button class="ub-ctrl-btn" onclick="openSettingsModal('profile')">⚙️</button>
          </div>
        </div>
      </div>

      <div class="main-chat">
        <div class="audio-stream-header-card">
          <div class="ash-left">
            <span style="color:var(--brand);font-size:18px;font-weight:900;">#</span>
            <div><div class="ash-label" id="top-ch-desc">АКТИВНЫЙ АУДИО ПОТОК // КАНАЛ</div><div class="ash-channel" id="top-ch-name">общий</div></div>
          </div>
          <div class="ash-wave">
            <div class="ash-bar" style="animation-delay:0s"></div><div class="ash-bar" style="animation-delay:.2s"></div><div class="ash-bar" style="animation-delay:.4s"></div><div class="ash-bar" style="animation-delay:.1s"></div><div class="ash-bar" style="animation-delay:.3s"></div><div class="ash-bar" style="animation-delay:.5s"></div><div class="ash-bar" style="animation-delay:.15s"></div><div class="ash-bar" style="animation-delay:.35s"></div><div class="ash-bar" style="animation-delay:.05s"></div><div class="ash-bar" style="animation-delay:.25s"></div><div class="ash-bar" style="animation-delay:.45s"></div><div class="ash-bar" style="animation-delay:.12s"></div>
          </div>
          <div class="ash-right">
            <button class="btn-login-mini" onclick="openSettingsModal('fx')">✨ Эффекты</button>
            <button class="btn-login-mini" onclick="openSettingsModal('safety')">🛡️ 18+</button>
          </div>
        </div>

        <div class="media-stage-dock" id="media-stage-dock">
          <div class="msd-header">
            <span class="msd-title">📹 ТРАНСЛЯЦИИ В КАНАЛЕ (КЛИК ПО ОКНУ — ФОКУС)</span>
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
        <div class="right-sec-title">⬢ В сети — <span id="online-count">1</span></div>
        <div id="online-users-box"></div>
        <div class="right-sec-title">⬡ Не в сети — <span id="total-members-count">0</span></div>
        <div id="offline-users-box"></div>
        <div class="right-sec-title" style="margin-top:6px;">◈ Друзья — <span id="friends-count">0</span></div>
        <div id="requests-box"></div><div id="friends-box"></div>
      </div>
    </div>
  </div>

  <!-- ВЫЕЗЖАЮЩИЙ СПРАВА ПРОФИЛЬ С ДВОЙНЫМ 6-УГОЛЬНЫМ МЕДАЛЬОНОМ, МОЛНИЯМИ И ЛЮСИ/ДЭВИДОМ/СИЛЬВЕРХЕНДОМ -->
  <div class="profile-drawer-backdrop" id="view-profile-backdrop" onclick="closeViewProfileModal()"></div>
  <div class="profile-slide-drawer" id="view-profile-drawer">
    <div class="profile-surface psd-inner" id="vp-surface">
      <div class="dp-banner" id="vp-banner">
        <div id="vp-banner-art"></div>
        <button class="dp-close-x" onclick="closeViewProfileModal()">✕</button>
      </div>
      <div class="dp-body">
        <div class="cyber-diode-scene" id="vp-hero-stage"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="dp-nick-line"><span class="dp-nick" id="vp-nick">Участник</span><span id="vp-badge-slot"></span></div>
          <span class="status-pill on" id="vp-online-pill">В СЕТИ</span>
        </div>
        <div class="dp-status" id="vp-status"></div>
        <div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ // ДОСЬЕ</div><div class="dp-bio" id="vp-bio"></div></div>
        <div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ И ТЕГИ</div><div class="dp-tags" id="vp-tags"></div></div>
        <div class="dp-sec"><div class="dp-sec-title">АКТИВНАЯ РАМКА И НАБОР</div><div style="font-size:12px;color:var(--text-normal);font-weight:700;" id="vp-fx-label">Стандартный контур</div></div>
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
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()"><span>☰</span><span>Каналы</span></div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span>◈</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="toggleMobileLeft()"><span>🔊</span><span>Голос</span></div>
    <div class="mob-nav-item" id="mob-tab-right" onclick="toggleMobileRight()"><span>⬢</span><span>Участники</span></div>
    <div class="mob-nav-item" id="mob-tab-profile" onclick="openSettingsModal('fx')"><span>✨</span><span>Эффекты</span></div>
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
        <div style="margin-top:auto;padding-top:10px;"><button class="btn-login-mini" style="width:100%;" onclick="closeSettingsModal()">✕ ЗАКРЫТЬ (ESC)</button></div>
      </div>
      <div class="settings-content">
        <div class="settings-pane active" id="pane-profile">
          <div class="settings-head"><h3>⬢ Мой профиль</h3><button class="btn-cyan" onclick="saveProfileSettings()">СОХРАНИТЬ</button></div>
          <div class="profile-surface" id="preview-surface">
            <div class="dp-banner" id="preview-banner" style="height:105px;"><div id="preview-banner-art"></div></div>
            <div class="dp-body">
              <div class="cyber-diode-scene" id="preview-hero-stage"></div>
              <div class="dp-nick-line"><span class="dp-nick" id="preview-nick">Гость</span><span id="preview-badge-slot"></span></div>
              <div class="dp-status" id="preview-status"></div>
              <div class="dp-sec"><div class="dp-sec-title">ОБО МНЕ</div><div class="dp-bio" id="preview-bio"></div></div>
              <div class="dp-sec"><div class="dp-sec-title">ИНТЕРЕСЫ</div><div class="dp-tags" id="preview-tags"></div></div>
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
              <div><label class="field-label">Цвет баннера</label><div class="color-swatches"><div class="color-swatch" style="background:#14f1d9;" onclick="selectBannerColor('#14f1d9')"></div><div class="color-swatch" style="background:#ff1e56;" onclick="selectBannerColor('#ff1e56')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectBannerColor('#10b981')"></div><div class="color-swatch" style="background:#fcee09;" onclick="selectBannerColor('#fcee09')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectBannerColor('#b829ff')"></div></div></div>
              <div><label class="field-label">Цвет 6-угольника</label><div class="color-swatches"><div class="color-swatch" style="background:#ff1e56;" onclick="selectAvatarColor('#ff1e56')"></div><div class="color-swatch" style="background:#14f1d9;" onclick="selectAvatarColor('#14f1d9')"></div><div class="color-swatch" style="background:#10b981;" onclick="selectAvatarColor('#10b981')"></div><div class="color-swatch" style="background:#fcee09;" onclick="selectAvatarColor('#fcee09')"></div><div class="color-swatch" style="background:#b829ff;" onclick="selectAvatarColor('#b829ff')"></div></div></div>
            </div>
          </div>
        </div>

        <div class="settings-pane" id="pane-fx">
          <div class="settings-head">
            <h3>✨ Эффекты (Неоновые 6-угольные рамки с молниями и персонажами)</h3>
            <button class="btn-login-mini" id="btn-disable-fx" onclick="selectEffectSet('')">Отключить</button>
          </div>
          <div class="fx-sets-grid">
            <div class="fx-bundle-card set1-card">
              <div class="fxb-left">
                <div id="fx-demo-slot-1"></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#00f0ff;">Набор 1: Люси Кушинада // Edgerunners S1 (Из вашего видео)</span>
                    <span class="cyber-badge b-set1">🌙 LUCY NET</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Двойная 6-угольная неоновая рамка (розовая маджента + циан), зигзаги электрических молний по граням, летящие искры, геймерский кибер-арт внутри и Люси справа внахлёст на рамку на фоне дождливого Найт-Сити.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set1" onclick="selectEffectSet('set1')">🎁 ЗАБРАТЬ</button>
            </div>

            <div class="fx-bundle-card set2-card">
              <div class="fxb-left">
                <div id="fx-demo-slot-2"></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#fcee09;">Набор 2: Дэвид Мартинес // Sandevistan Overdrive (Сезон 2)</span>
                    <span class="cyber-badge b-set2">⚡ SANDY S2</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Двойная жёлто-изумрудная 6-угольная рамка ускорения времени с зелёными молниями, голографический купол Луны и Дэвид в жёлтой куртке с имплантом Сандевистан справа от рамки.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set2" onclick="selectEffectSet('set2')">🎁 ЗАБРАТЬ</button>
            </div>

            <div class="fx-bundle-card set3-card">
              <div class="fxb-left">
                <div id="fx-demo-slot-3"></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:15px;font-weight:900;color:#ff4d79;">Набор 3: Джонни Сильверхенд & V // Cyberpunk 2077 Relic</span>
                    <span class="cyber-badge b-set3">🔥 RELIC MAX</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Багрово-бирюзовый 6-угольный контур биочипа Relic с алыми молниями, небоскрёбы Arasaka Tower на фоне и Джонни Сильверхенд с серебряной рукой справа от рамки.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set3" onclick="selectEffectSet('set3')">🎁 ЗАБРАТЬ</button>
            </div>
          </div>
        </div>

        <div class="settings-pane" id="pane-keybinds">
          <div class="settings-head"><h3>⌨️ Горячие клавиши</h3><button class="btn-login-mini" onclick="resetKeybindsToDefault()">Сбросить</button></div>
          <div class="settings-card">
            <div class="keybind-row"><div class="toggle-title">🎤 Микрофон вкл/выкл (Mute)</div><button class="kb-btn" id="kb-btn-mute" onclick="startKeybindRecord('mute')"></button></div>
            <div class="keybind-row"><div class="toggle-title">🎧 Звук вкл/выкл (Deafen)</div><button class="kb-btn" id="kb-btn-deafen" onclick="startKeybindRecord('deafen')"></button></div>
            <div class="keybind-row"><div class="toggle-title">📷 Веб-камера</div><button class="kb-btn" id="kb-btn-cam" onclick="startKeybindRecord('cam')"></button></div>
            <div class="keybind-row"><div class="toggle-title">🖥️ Демонстрация экрана</div><button class="kb-btn" id="kb-btn-screen" onclick="startKeybindRecord('screen')"></button></div>
            <div class="keybind-row"><div class="toggle-title">🪟 Оверлей поверх окон</div><button class="kb-btn" id="kb-btn-pip" onclick="startKeybindRecord('pip')"></button></div>
          </div>
        </div>

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

        <div class="settings-pane" id="pane-voice">
          <div class="settings-head"><h3>🎙️ Голос и видео</h3><button class="btn-login-mini" onclick="refreshMediaDevices()">🔄 ОБНОВИТЬ</button></div>
          <div class="settings-card">
            <div class="settings-grid-2"><div><label class="field-label">Микрофон</label><select id="set-mic-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Аудиовыход</label><select id="set-spk-select" onchange="saveAudioVideoSettings()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Усиление микр.: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Тест микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ ПРОВЕРИТЬ</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Камера</label><select id="set-cam-select" onchange="saveAudioVideoSettings()"></select></div><div><label class="field-label">Разрешение</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
            <div class="toggle-row"><div class="toggle-title">🪟 Мини-виджет звонка</div><label class="cyber-switch"><input type="checkbox" id="chk-auto-overlay" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Шумоподавление</div><label class="cyber-switch"><input type="checkbox" id="chk-noise" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Эхоподавление</div><label class="cyber-switch"><input type="checkbox" id="chk-echo" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Автоусиление</div><label class="cyber-switch"><input type="checkbox" id="chk-agc" checked onchange="saveAudioVideoSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <div class="settings-pane" id="pane-appearance">
          <div class="settings-head"><h3>🎨 Внешний вид</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div class="toggle-title">Компактный чат</div><label class="cyber-switch"><input type="checkbox" id="chk-compact" onchange="applyAppearanceSettings()"><span class="cyber-slider"></span></label></div>
            <div><label class="field-label">Размер шрифта</label><select id="sel-font-size" onchange="applyAppearanceSettings()"><option value="13px">13px</option><option value="14px" selected>14px</option><option value="16px">16px</option></select></div>
          </div>
        </div>

        <div class="settings-pane" id="pane-notifications">
          <div class="settings-head"><h3>🔔 Звуковые сигналы</h3></div>
          <div class="settings-card">
            <div class="toggle-row"><div class="toggle-title">Звук нового сообщения</div><label class="cyber-switch"><input type="checkbox" id="chk-snd-msg" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
            <div class="toggle-row"><div class="toggle-title">Звук голосового канала</div><label class="cyber-switch"><input type="checkbox" id="chk-snd-voice" checked onchange="saveNotificationSettings()"><span class="cyber-slider"></span></label></div>
          </div>
        </div>

        <div class="settings-pane" id="pane-account">
          <div class="settings-head"><h3>🔑 Учётная запись</h3></div>
          <div class="settings-card"><div class="settings-grid-2"><button class="btn-cyan" onclick="closeSettingsModal();openAuthModal(false)">✈️ СМЕНИТЬ АККАУНТ</button><button class="btn-danger" onclick="logoutAccount()">ВЫЙТИ</button></div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box"><h3 style="color:var(--brand);font-size:16px;margin-bottom:8px;">⚡ ПРИГЛАСИТЬ ДРУГА</h3><a class="link-box" id="public-invite-url" href="#" target="_blank"></a><button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">СКОПИРОВАТЬ ССЫЛКУ</button><button class="btn-login-mini" style="width:100%;" onclick="closeInviteModal()">ЗАКРЫТЬ</button></div>
  </div>

  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="color:var(--brand);font-size:16px;">⚡ АВТОРИЗАЦИЯ</h3><span style="font-size:10px;background:var(--pink);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;">P2P ID</span></div>
      <div class="auth-tabs"><div class="auth-tab active" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ TELEGRAM</div><div class="auth-tab" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 ПАРОЛЬ</div></div>
      <input type="text" id="nick-inp" placeholder="Ваш позывной (никнейм)" maxlength="24">
      <div id="auth-tg-panel">
        <p style="font-size:12px;color:var(--text-normal);margin-bottom:10px;">Откройте бота и нажмите /start — вход выполнится автоматически:</p>
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
  function closeMobileDrawers() { document.body.classList.remove('mob-left-open', 'mob-right-open'); setMobActiveTab('mob-tab-chat'); }
  function toggleMobileLeft() { const o = document.body.classList.contains('mob-left-open'); document.body.classList.remove('mob-right-open'); if (o) closeMobileDrawers(); else { document.body.classList.add('mob-left-open'); setMobActiveTab('mob-tab-left'); } }
  function toggleMobileRight() { const o = document.body.classList.contains('mob-right-open'); document.body.classList.remove('mob-left-open'); if (o) closeMobileDrawers(); else { document.body.classList.add('mob-right-open'); setMobActiveTab('mob-tab-right'); } }

  function setPersistCookie(n, v) { try { document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=31536000; SameSite=Lax'; } catch (e) {} }
  function getPersistCookie(n) { try { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; } }

  let myUid = '';
  try { myUid = localStorage.getItem('cyber_uid') || ''; } catch (e) {}
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) myUid = getPersistCookie('cyber_uid');
  if (!myUid || !/^[a-f0-9]{32}$/.test(myUid)) {
    const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
    myUid = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  try { localStorage.setItem('cyber_uid', myUid); } catch (e) {}
  setPersistCookie('cyber_uid', myUid);

  let currentRoom = params.get('room') || params.get('server') || localStorage.getItem('cyber_last_room') || 'cy-4371';
  try { localStorage.setItem('cyber_last_room', currentRoom); } catch (e) {}
  let currentChannel = params.get('channel') || 'общий', currentVoiceChannel = 'Ночной эфир';
  let myNick = localStorage.getItem('cyber_nick') || getPersistCookie('cyber_nick') || ('Гость_' + Math.floor(100 + Math.random() * 899));
  let myVerified = localStorage.getItem('cyber_verified') === '1' || getPersistCookie('cyber_verified') === '1', authLocked = !myVerified;

  function updateBrowserUrl() { try { window.history.replaceState({}, '', window.location.pathname + '?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(currentChannel)); } catch (e) {} }

  // --- ДЕТАЛИЗИРОВАННЫЕ СЦЕНЫ 3 НАБОРОВ (ПО ВАШЕМУ ВИДЕО С ЛЮСИ + ДЭВИД + СИЛЬВЕРХЕНД) ---
  const FX_SETS_META = {
    set1: {
      code: '⚡FX:SET1', avaClass: 'fx-set1', badgeClass: 'b-set1', badgeText: '🌙 LUCY NET', surfaceClass: 'theme-set1',
      cOuter: '#ff1e8a', cInner: '#00f0ff', cBolt: '#5ffbf1',
      title: 'Набор 1: Люси Кушинада // Edgerunners S1 (Двойной неон + молнии)',
      // Фон баннера: ночной дождливый Найт-Сити с неоновыми вывесками и летающим спиннером как в видео
      bannerSvg: '<svg class="dp-banner-svg" viewBox="0 0 360 118" preserveAspectRatio="none"><rect width="360" height="118" fill="#060913"/><rect x="14" y="12" width="38" height="106" fill="#0b1324"/><rect x="20" y="24" width="26" height="42" fill="#ff1e8a" opacity="0.28"/><rect x="62" y="28" width="45" height="90" fill="#091020"/><rect x="118" y="8" width="52" height="110" fill="#0c1528"/><rect x="126" y="18" width="36" height="14" fill="#00f0ff" opacity="0.35"/><rect x="250" y="16" width="48" height="102" fill="#0b1222"/><rect x="260" y="30" width="12" height="55" fill="#ff1e8a" opacity="0.35"/><rect x="308" y="22" width="42" height="96" fill="#09101d"/><ellipse cx="78" cy="42" rx="18" ry="5" fill="#101d33" stroke="#00f0ff" stroke-width="1.2"/><circle cx="68" cy="43" r="2" fill="#ff1e8a"/><circle cx="88" cy="43" r="2" fill="#00f0ff"/><g stroke="#00f0ff" stroke-width="0.8" opacity="0.35"><line x1="40" y1="0" x2="20" y2="118"/><line x1="110" y1="0" x2="90" y2="118"/><line x1="190" y1="0" x2="170" y2="118"/><line x1="270" y1="0" x2="250" y2="118"/><line x1="330" y1="0" x2="310" y2="118"/></g></svg>',
      // Внутренний арт шестиугольника: кирпичная стена с неоном, геймерский стол и персонаж в кепке из видео
      innerSvg: '<svg viewBox="0 0 100 100" width="100%" height="100%"><rect width="100" height="100" fill="#0b1324"/><g stroke="#1b2942" stroke-width="1"><line x1="0" y1="25" x2="100" y2="25"/><line x1="0" y1="45" x2="100" y2="45"/><line x1="0" y1="65" x2="100" y2="65"/><line x1="35" y1="25" x2="35" y2="45"/><line x1="70" y1="45" x2="70" y2="65"/></g><circle cx="65" cy="40" r="28" fill="#00f0ff" opacity="0.18"/><circle cx="30" cy="55" r="24" fill="#ff1e8a" opacity="0.2"/><polygon points="8,72 44,58 48,66 12,82" fill="#142238" stroke="#00ff9d" stroke-width="1.2"/><rect x="26" y="48" width="14" height="7" rx="1" fill="#ff1e56"/><circle cx="64" cy="44" r="9" fill="#e2c6b6"/><path d="M54 42 Q64 32 74 42 Z" fill="#1e293b"/><rect x="58" y="42" width="12" height="4" rx="1" fill="#00f0ff"/><path d="M50 75 Q52 54 64 54 Q76 54 78 75 Z" fill="#1e3a5f" stroke="#00f0ff" stroke-width="1"/></svg>',
      // Детализированная Люси справа внахлёст на шестиугольник (бело-пастельное каре, красные глаза и подводка, белая куртка с открытыми плечами, чёрный бодисьют с красными деталями)
      charSvg: '<svg class="cds-character-right" viewBox="0 0 110 145"><defs><linearGradient id="lucyHair" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="#d8f3ff"/><stop offset="85%" stop-color="#ffc2e2"/><stop offset="100%" stop-color="#00f0ff"/></linearGradient><linearGradient id="lucyJacket" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f1f5f9"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient></defs><g filter="drop-shadow(0 0 6px rgba(0,240,255,0.55))"><path d="M38 144 L44 102 L78 104 L84 144 Z" fill="#1e2436" stroke="#00f0ff" stroke-width="1.2"/><path d="M44 102 L48 56 L74 56 L78 104 Z" fill="#0d111a" stroke="#ff1e8a" stroke-width="1.3"/><polygon points="58,64 64,64 62,88 56,88" fill="#ff1e56"/><path d="M30 88 C28 66 36 56 46 56 L48 92 C38 94 32 92 30 88 Z" fill="url(#lucyJacket)" stroke="#cbd5e1" stroke-width="1.2"/><path d="M74 56 C86 58 94 70 92 94 L76 92 Z" fill="url(#lucyJacket)" stroke="#cbd5e1" stroke-width="1.2"/><ellipse cx="60" cy="48" rx="9" ry="6" fill="#fbd5c8"/><path d="M45 26 C45 12 77 12 77 28 C77 40 68 48 60 48 C52 48 45 40 45 26 Z" fill="#fde2d8"/><path d="M38 30 C36 10 52 4 63 6 C78 8 86 20 82 42 C80 32 75 22 68 20 C64 28 56 28 48 22 C44 28 42 38 43 45 C39 40 38 35 38 30 Z" fill="url(#lucyHair)"/><path d="M49 30 L56 31" stroke="#ff1e56" stroke-width="2" stroke-linecap="round"/><path d="M64 31 L71 30" stroke="#ff1e56" stroke-width="2" stroke-linecap="round"/><circle cx="53" cy="32" r="2.2" fill="#ff0055"/><circle cx="67" cy="32" r="2.2" fill="#ff0055"/><path d="M57 41 Q60 43 63 41" fill="none" stroke="#e11d48" stroke-width="1.4"/></g></svg>'
    },
    set2: {
      code: '⚡FX:SET2', avaClass: 'fx-set2', badgeClass: 'b-set2', badgeText: '⚡ SANDY S2', surfaceClass: 'theme-set2',
      cOuter: '#fcee09', cInner: '#00ff9d', cBolt: '#fcee09',
      title: 'Набор 2: Дэвид Мартинес // Sandevistan Overdrive (Сезон 2)',
      bannerSvg: '<svg class="dp-banner-svg" viewBox="0 0 360 118" preserveAspectRatio="none"><rect width="360" height="118" fill="#04120e"/><circle cx="285" cy="48" r="36" fill="#fcee09" opacity="0.22"/><circle cx="285" cy="48" r="26" fill="#fffbe6" opacity="0.35"/><path d="M0 95 L60 65 L120 85 L190 45 L260 80 L360 50 L360 118 L0 118 Z" fill="#07221b" opacity="0.7"/><g stroke="#00ff9d" stroke-width="1.2" opacity="0.4"><line x1="20" y1="20" x2="140" y2="20"/><line x1="40" y1="38" x2="190" y2="38"/><line x1="15" y1="56" x2="110" y2="56"/></g></svg>',
      innerSvg: '<svg viewBox="0 0 100 100" width="100%" height="100%"><rect width="100" height="100" fill="#061914"/><circle cx="50" cy="50" r="34" fill="none" stroke="#00ff9d" stroke-width="1.5" stroke-dasharray="6 4"/><path d="M50 18 L50 82 M36 30 L64 30 M32 50 L68 50 M36 70 L64 70" stroke="#fcee09" stroke-width="3" stroke-linecap="round"/><circle cx="50" cy="30" r="4" fill="#00ff9d"/><circle cx="50" cy="50" r="4" fill="#00ff9d"/><circle cx="50" cy="70" r="4" fill="#00ff9d"/></svg>',
      // Дэвид Мартинес в культовой жёлтой куртке с неоновым воротником и зелёным свечением Сандевистана
      charSvg: '<svg class="cds-character-right" viewBox="0 0 110 145"><g filter="drop-shadow(0 0 6px rgba(252,238,9,0.55))"><path d="M30 144 L36 62 L24 50 L42 42 L78 42 L94 52 L84 64 L88 144 Z" fill="#fcee09" stroke="#04120c" stroke-width="1.5"/><path d="M46 52 L74 52 L70 144 L48 144 Z" fill="#0f172a"/><path d="M38 42 L46 28 L74 28 L82 42 Z" fill="#1e293b" stroke="#00ff9d" stroke-width="1.8"/><circle cx="60" cy="28" r="13" fill="#f1c2a5"/><path d="M44 22 L48 8 L58 14 L64 6 L72 14 L78 10 L76 26 Z" fill="#111827"/><circle cx="55" cy="28" r="2" fill="#fcee09"/><circle cx="66" cy="28" r="2" fill="#fcee09"/><path d="M48 68 L72 68 M50 84 L70 84" stroke="#00ff9d" stroke-width="2.5"/></g></svg>'
    },
    set3: {
      code: '⚡FX:SET3', avaClass: 'fx-set3', badgeClass: 'b-set3', badgeText: '🔥 RELIC MAX', surfaceClass: 'theme-set3',
      cOuter: '#ff003c', cInner: '#00f0ff', cBolt: '#ff003c',
      title: 'Набор 3: Джонни Сильверхенд & V // Cyberpunk 2077 Relic',
      bannerSvg: '<svg class="dp-banner-svg" viewBox="0 0 360 118" preserveAspectRatio="none"><rect width="360" height="118" fill="#120308"/><rect x="145" y="0" width="70" height="118" fill="#1f050d" stroke="#ff003c" stroke-width="1"/><circle cx="180" cy="34" r="14" fill="none" stroke="#ff003c" stroke-width="2.2"/><g stroke="#00f0ff" stroke-width="1" opacity="0.45"><line x1="0" y1="28" x2="130" y2="28"/><line x1="230" y1="64" x2="360" y2="64"/><line x1="30" y1="88" x2="160" y2="88"/></g></svg>',
      innerSvg: '<svg viewBox="0 0 100 100" width="100%" height="100%"><rect width="100" height="100" fill="#16040a"/><polygon points="50,14 82,34 72,78 50,90 28,78 18,34" fill="#2b0610" stroke="#ff003c" stroke-width="2"/><circle cx="38" cy="48" r="6" fill="#00f0ff"/><circle cx="62" cy="48" r="6" fill="#00f0ff"/><path d="M34 68 L44 74 L56 74 L66 68" fill="none" stroke="#fcee09" stroke-width="2.5"/></svg>',
      // Джонни Сильверхенд в бронежилете, красных очках-авиаторах и с серебряной бионической рукой
      charSvg: '<svg class="cds-character-right" viewBox="0 0 110 145"><g filter="drop-shadow(0 0 6px rgba(255,0,60,0.6))"><path d="M36 144 L40 54 L80 54 L84 144 Z" fill="#18181b" stroke="#ff003c" stroke-width="1.5"/><path d="M22 98 C20 72 28 56 40 56 L42 104 Z" fill="#94a3b8" stroke="#00f0ff" stroke-width="1.6"/><line x1="25" y1="72" x2="40" y2="72" stroke="#0f172a" stroke-width="2"/><line x1="24" y1="84" x2="41" y2="84" stroke="#0f172a" stroke-width="2"/><circle cx="60" cy="30" r="13" fill="#e2b89b"/><path d="M44 18 C46 8 74 8 76 18 L78 46 L72 44 L72 24 L48 24 L48 44 L42 46 Z" fill="#09090b"/><rect x="48" y="25" width="11" height="7" rx="2" fill="#ff003c" stroke="#cbd5e1" stroke-width="1"/><rect x="61" y="25" width="11" height="7" rx="2" fill="#ff003c" stroke="#cbd5e1" stroke-width="1"/><path d="M52 38 L68 38 L64 43 L56 43 Z" fill="#18181b"/></g></svg>'
    }
  };

  // Генератор двойной 6-угольной неоновой рамки с молниями, искрами и персонажем справа (точно как на видео)
  function buildHeroHexMedallionHTML(letters, avaColor, setKey, statusCls) {
    const m = FX_SETS_META[setKey];
    if (!m) {
      return '<div class="hex-wrap" style="width:82px;height:82px;margin-top:26px;">' +
        '<div class="hex-border"><div class="hex-core" style="font-size:22px;background:' + escapeHtml(avaColor || '#ff1e56') + ';">' + escapeHtml(letters) + '</div></div>' +
        (statusCls ? '<span class="hex-status-dot ' + statusCls + '"></span>' : '') +
      '</div>';
    }
    return '<div class="cds-hex-frame">' +
      '<div class="cds-inner-art">' + m.innerSvg +
        '<span class="cds-nick-overlay" style="position:absolute;bottom:8px;font-size:13px;">' + escapeHtml(letters) + '</span>' +
      '</div>' +
      '<svg class="cds-neon-svg" viewBox="0 0 140 140">' +
        '<defs>' +
          '<filter id="glow-' + setKey + '"><feGaussianBlur stdDeviation="2.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
        '</defs>' +
        '<!-- Внешний неоновый шестиугольник (Розовый/Жёлтый/Красный) -->' +
        '<polygon points="70,6 126,38 126,102 70,134 14,102 14,38" fill="none" stroke="' + m.cOuter + '" stroke-width="3.4" filter="url(#glow-' + setKey + ')"/>' +
        '<!-- Внутренний неоновый шестиугольник (Яркий циан/Изумруд) -->' +
        '<polygon points="70,13 119,41 119,99 70,127 21,99 21,41" fill="none" stroke="' + m.cInner + '" stroke-width="2.6" filter="url(#glow-' + setKey + ')"/>' +
        '<!-- Зигзагообразные электрические разряды и молнии вдоль граней как на 00:03 и 00:07 видео -->' +
        '<polyline class="cds-bolt" points="70,3 42,16 48,22 18,35 10,44 16,66" stroke="' + m.cBolt + '" filter="url(#glow-' + setKey + ')"/>' +
        '<polyline class="cds-bolt b2" points="12,96 34,114 28,120 62,136 74,132 104,118" stroke="#ffffff" filter="url(#glow-' + setKey + ')"/>' +
        '<polyline class="cds-bolt b3" points="128,42 134,68 124,76 130,98 96,122" stroke="' + m.cInner + '" filter="url(#glow-' + setKey + ')"/>' +
        '<!-- Светящиеся искры вокруг шестиугольника -->' +
        '<circle class="cds-spark" cx="24" cy="22" r="2.2" fill="#fff"/>' +
        '<circle class="cds-spark s2" cx="10" cy="78" r="2" fill="' + m.cInner + '"/>' +
        '<circle class="cds-spark s3" cx="55" cy="136" r="2.2" fill="' + m.cOuter + '"/>' +
        '<circle class="cds-spark" cx="108" cy="18" r="1.8" fill="' + m.cInner + '"/>' +
      '</svg>' +
    '</div>' + m.charSvg;
  }

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
    try { localStorage.setItem('cyber_profile', JSON.stringify(myProfile)); } catch (e) {}
    updateFxButtonsUI(); applyNickUI(); updateProfilePreview(true); syncProfileToServer();
    renderUsers(lastMembers); rerenderChatMessages();
  }

  function updateFxButtonsUI() {
    const cur = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests);
    ['set1', 'set2', 'set3'].forEach(function (k, idx) {
      const b = document.getElementById('btn-fx-' + k);
      if (b) b.textContent = (cur === k) ? '✓ АКТИВЕН' : '🎁 ЗАБРАТЬ';
      const slot = document.getElementById('fx-demo-slot-' + (idx + 1));
      if (slot) slot.innerHTML = '<div class="cyber-diode-scene" style="margin:0;transform:scale(0.78);transform-origin:left center;width:165px;height:112px;">' + buildHeroHexMedallionHTML(myNick.slice(0, 2).toUpperCase(), myProfile.avatarColor, k, '') + '</div>';
    });
    const dis = document.getElementById('btn-disable-fx');
    if (dis) dis.style.display = cur ? 'inline-block' : 'none';
  }

  function getMyMemberObject() {
    return { pid: myPid, nick: myNick, online: true, presence: myProfile.presence, customStatus: myProfile.customStatus, bio: myProfile.bio, interests: myProfile.interests, bannerColor: myProfile.bannerColor, avatarColor: myProfile.avatarColor, fxSet: myProfile.fxSet };
  }

  // --- ГОРЯЧИЕ КЛАВИШИ ---
  const DEFAULT_KEYBINDS = { mute: 'Alt+KeyM', deafen: 'Alt+KeyD', cam: 'Alt+KeyC', screen: 'Alt+KeyS', pip: 'Alt+KeyP' };
  let userKeybinds = Object.assign({}, DEFAULT_KEYBINDS);
  try { userKeybinds = Object.assign(userKeybinds, JSON.parse(localStorage.getItem('cyber_keybinds') || '{}')); } catch (e) {}
  let recordingAction = null;

  function formatKeybindCode(c) { return c ? String(c).replace('Key', '').replace('Digit', '').replace('Control', 'Ctrl') : 'Не назначено'; }
  function renderKeybindsUI() {
    ['mute', 'deafen', 'cam', 'screen', 'pip'].forEach(function (act) {
      const btn = document.getElementById('kb-btn-' + act);
      if (!btn) return;
      btn.textContent = (recordingAction === act) ? 'Нажмите клавишу...' : formatKeybindCode(userKeybinds[act]);
      btn.classList.toggle('recording', recordingAction === act);
    });
    const hint = document.getElementById('footer-keybind-hint');
    if (hint) hint.textContent = 'БИНДЫ: МИКР [' + formatKeybindCode(userKeybinds.mute) + '] • ЗВУК [' + formatKeybindCode(userKeybinds.deafen) + '] • ОВЕРЛЕЙ [' + formatKeybindCode(userKeybinds.pip) + ']';
  }
  function startKeybindRecord(act) { recordingAction = (recordingAction === act) ? null : act; renderKeybindsUI(); }
  function resetKeybindsToDefault() { userKeybinds = Object.assign({}, DEFAULT_KEYBINDS); recordingAction = null; try { localStorage.setItem('cyber_keybinds', JSON.stringify(userKeybinds)); } catch (e) {} renderKeybindsUI(); }
  function eventToComboString(e) {
    const p = []; if (e.ctrlKey || e.metaKey) p.push('Ctrl'); if (e.altKey) p.push('Alt'); if (e.shiftKey) p.push('Shift');
    const ign = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
    if (e.code && !ign.includes(e.code)) p.push(e.code);
    return p.join('+');
  }

  let appSettings = Object.assign({ micDeviceId: '', spkDeviceId: '', camDeviceId: '', micVolume: 100, outVolume: 100, camRes: '720', autoOverlay: true, noiseSuppression: true, echoCancellation: true, autoGainControl: true, compactChat: false, fontSize: '14px', soundMsg: true, soundVoice: true, filterSexual: true, filterGore: true, filterOutgoing: true, filterAction: 'block', customBlockedWords: '' }, JSON.parse(localStorage.getItem('cyber_settings') || '{}'));
  let localVault = Object.assign({ knownUsers: {}, friends: [], incoming: [], outgoing: [], servers: [], messages: {} }, JSON.parse(localStorage.getItem('cyber_vault_v1') || '{}'));

  function rememberUserInVault(u) {
    if (!u || !u.pid || u.nick === '?') return;
    const prev = localVault.knownUsers[u.pid] || {};
    localVault.knownUsers[u.pid] = { pid: u.pid, nick: u.nick || prev.nick || 'Участник', bio: u.bio !== undefined ? u.bio : (prev.bio || ''), interests: u.interests !== undefined ? u.interests : (prev.interests || ''), customStatus: u.customStatus !== undefined ? u.customStatus : (prev.customStatus || ''), presence: u.presence || prev.presence || 'online', bannerColor: u.bannerColor || prev.bannerColor || '#14f1d9', avatarColor: u.avatarColor || prev.avatarColor || '#ff1e56' };
  }
  function saveLocalVault() {
    try {
      if (social.friends && social.friends.length) localVault.friends = social.friends.map(function (f) { rememberUserInVault(f); return f.pid; });
      if (social.incoming) localVault.incoming = social.incoming.map(function (i) { rememberUserInVault(i); return i.pid; });
      if (social.outgoing) localVault.outgoing = social.outgoing.slice();
      if (lastMembers) lastMembers.forEach(rememberUserInVault);
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
    try {
      const ka = Object.values(localVault.knownUsers || {});
      await fetch('/api/vault-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, nick: myNick, profile: myProfile, friends: localVault.friends || [], incoming: localVault.incoming || [], outgoing: localVault.outgoing || [], knownUsers: ka, servers: localVault.servers || [], room: currentRoom, roomMembersPids: ka.map(function (u) { return u.pid; }), messages: localVault.messages || {} }) });
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
  let callStartTime = 0, voiceLockRelease = null, wakeLockSentinel = null, keepAliveAudioEl = null, bgWorker = null;
  let pipCanvas = null, pipCtx = null, canvasPipVideo = null, subsonicWavUrl = null;
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

  function ensurePipCanvasAndVideo() {
    if (!pipCanvas) { pipCanvas = document.createElement('canvas'); pipCanvas.width = 460; pipCanvas.height = 260; pipCtx = pipCanvas.getContext('2d', { alpha: false }); drawSystemPipOverlayFrame(); }
    if (!canvasPipVideo) {
      canvasPipVideo = document.createElement('video'); canvasPipVideo.muted = true; canvasPipVideo.autoplay = true; canvasPipVideo.playsInline = true; canvasPipVideo.autoPictureInPicture = true;
      canvasPipVideo.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:1;';
      document.body.appendChild(canvasPipVideo);
      try { canvasPipVideo.srcObject = pipCanvas.captureStream(25); canvasPipVideo.play().catch(function () {}); } catch (e) {}
    } else if (canvasPipVideo.paused) canvasPipVideo.play().catch(function () {});
  }
  document.addEventListener('pointerdown', function () { ensurePipCanvasAndVideo(); }, { once: true });

  function drawSystemPipOverlayFrame() {
    if (!pipCanvas || !pipCtx) return;
    const ctx = pipCtx, w = pipCanvas.width, h = pipCanvas.height;
    ctx.fillStyle = '#05080f'; ctx.fillRect(0, 0, w, h);
    const activeVideoEl = document.querySelector('#screen-grid .screen-card:not(.nsfw-masked) video');
    if (activeVideoEl && activeVideoEl.readyState >= 2) {
      try { ctx.drawImage(activeVideoEl, 0, 38, w, h - 38); } catch (e) {}
      ctx.fillStyle = 'rgba(4,7,13,0.88)'; ctx.fillRect(0, 0, w, 38);
    } else {
      ctx.fillStyle = '#0c1422'; ctx.fillRect(14, 48, w - 28, 34);
      ctx.fillStyle = isMuted ? '#ff1e56' : '#10b981'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText((isMuted ? '🔇 Микр. выкл' : '🎤 Микр. вкл') + (isDeafened ? ' • 🔇 Звук выкл' : ' • 🎧 Звук вкл'), 26, 70);
      getVoiceChannelMembers().slice(0, 5).forEach(function (u, i) {
        const y = 115 + i * 25; ctx.fillStyle = '#e6f7ff'; ctx.font = 'bold 13px sans-serif';
        ctx.fillText('⬢ ' + u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : ''), 24, y);
      });
    }
    ctx.strokeStyle = '#14f1d9'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = '#14f1d9'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('🔊 ' + String(currentVoiceChannel || 'Эфир').slice(0, 22), 16, 25);
    ctx.fillStyle = '#e6f7ff'; ctx.font = 'bold 13px monospace'; ctx.fillText(formatCallTime(callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0), w - 58, 25);
  }

  function toggleExternalOverlay() {
    if (document.pictureInPictureElement) { try { document.exitPictureInPicture(); } catch (e) {} return; }
    ensurePipCanvasAndVideo(); drawSystemPipOverlayFrame();
    if (canvasPipVideo && canvasPipVideo.requestPictureInPicture) canvasPipVideo.requestPictureInPicture().catch(function () {});
    if (!inVoice) ensureVoiceConnected();
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
        const tEl = document.getElementById('fco-timer-label'); if (tEl) tEl.textContent = tStr;
        const stEl = document.getElementById('svd-state-text'); if (stEl) stEl.textContent = '🟢 В ЭФИРЕ • ' + tStr;
        drawSystemPipOverlayFrame();
      };
    } catch (e) {}
    updateFloatingOverlayUI();
  }

  function stopBackgroundCallPersistence() {
    document.body.classList.remove('voice-live');
    if (voiceLockRelease) { try { voiceLockRelease(); } catch (e) {} voiceLockRelease = null; }
    if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch (e) {} wakeLockSentinel = null; }
    if (keepAliveAudioEl) { try { keepAliveAudioEl.pause(); } catch (e) {} }
    if (bgWorker) { try { bgWorker.terminate(); } catch (e) {} bgWorker = null; }
    const stEl = document.getElementById('svd-state-text'); if (stEl) { stEl.textContent = '📡 ГОЛОСОВОЙ КАНАЛ'; stEl.classList.add('idle'); }
    updateFloatingOverlayUI();
  }

  function getVoiceChannelMembers() {
    const uList = (lastMembers || []).filter(function (u) { return u.online && u.inVoice && (!u.voiceChannel || u.voiceChannel === currentVoiceChannel); });
    if (!uList.some(function (u) { return u.pid === myPid; }) && inVoice) uList.unshift({ pid: myPid, nick: myNick, online: true, inVoice: true, inCam: inWebcam, inScreen: inScreen, interests: myProfile.interests, avatarColor: myProfile.avatarColor });
    return uList;
  }

  function renderSidebarVoicePeers() {
    const box = document.getElementById('sidebar-voice-peers'); if (!box) return; box.innerHTML = '';
    getVoiceChannelMembers().forEach(function (u) {
      const setKey = getUserFxSet(u), m = FX_SETS_META[setKey];
      const r = el('div', 'vc-user-row');
      const hw = el('div', 'hex-wrap' + (m ? ' ' + m.avaClass : '')); hw.style.cssText = 'width:24px;height:24px;';
      const hb = el('div', 'hex-border'), hc = el('div', 'hex-core', String(u.nick || '?').slice(0, 2).toUpperCase());
      hc.style.cssText = 'font-size:8.5px;background:' + (u.avatarColor || '#14f1d9') + ';';
      hb.appendChild(hc); hw.appendChild(hb); r.appendChild(hw);
      r.appendChild(el('span', '', u.nick + (u.inCam ? ' 📷' : '') + (u.inScreen ? ' 🖥️' : '')));
      r.onclick = function () { openUserProfileCard(u); };
      box.appendChild(r);
    });
  }

  function updateFloatingOverlayUI() {
    const box = document.getElementById('floating-call-overlay'); if (!box) return;
    box.classList.toggle('show', inVoice && appSettings.autoOverlay !== false);
    document.getElementById('fco-channel-label').textContent = '🔊 ' + currentVoiceChannel;
    document.getElementById('fco-mute-btn').textContent = isMuted ? '🔇 Выкл' : '🎤 Вкл';
    document.getElementById('fco-deaf-btn').textContent = isDeafened ? '🔇 Глух' : '🎧 Вкл';
    const ubMic = document.getElementById('mute-btn'), ubDeaf = document.getElementById('deafen-btn');
    if (ubMic) { ubMic.classList.toggle('off', isMuted); ubMic.textContent = isMuted ? '🔇' : '🎤'; }
    if (ubDeaf) { ubDeaf.classList.toggle('off', isDeafened); ubDeaf.textContent = isDeafened ? '🔇' : '🎧'; }
    const pb = document.getElementById('fco-peers-box'); pb.innerHTML = '';
    getVoiceChannelMembers().forEach(function (u) { const c = el('div', 'fco-peer-chip'); c.appendChild(el('span', 'fco-pulse')); c.appendChild(el('span', '', u.nick)); pb.appendChild(c); });
    renderSidebarVoicePeers(); drawSystemPipOverlayFrame();
  }

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
    const curSet = myProfile.fxSet || detectFxSetFromInterests(myProfile.interests), meta = FX_SETS_META[curSet];
    const wrap = document.getElementById('user-ava-wrap'); if (wrap) wrap.className = 'hex-wrap' + (meta ? ' ' + meta.avaClass : '');
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
    const nodeLbl = document.getElementById('tt-node-label'); if (nodeLbl) nodeLbl.textContent = 'Узел активен • ' + currentRoom;
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
    document.getElementById('top-ch-desc').textContent = 'АКТИВНЫЙ АУДИО ПОТОК // ' + sName.toUpperCase();
    document.getElementById('banner-desc').textContent = 'КАНАЛ #' + ch.toUpperCase();
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(function (i) { i.classList.toggle('active', i.getAttribute('data-ch') === ch); });
  }
  function updateVoicePanelUI() { document.getElementById('voice-panel-title').textContent = currentVoiceChannel; updateFloatingOverlayUI(); }

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
        pushLocalVaultToServer();
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
        renderUsers(data.payload); updateFloatingOverlayUI(); saveLocalVault();
      } else if (data.type === 'social') {
        myPid = data.payload.pid; social = data.payload;
        if (data.payload.nick) { myNick = data.payload.nick; try { localStorage.setItem('cyber_nick', myNick); } catch (err) {} setPersistCookie('cyber_nick', myNick); }
        if (data.payload.verified) { myVerified = true; authLocked = false; try { localStorage.setItem('cyber_verified', '1'); } catch (err) {} setPersistCookie('cyber_verified', '1'); closeAuthModal(); }
        if (data.payload.bio !== undefined) Object.assign(myProfile, { bio: data.payload.bio || myProfile.bio, interests: data.payload.interests || myProfile.interests, customStatus: data.payload.customStatus || myProfile.customStatus, presence: data.payload.presence || myProfile.presence, bannerColor: data.payload.bannerColor || myProfile.bannerColor, avatarColor: data.payload.avatarColor || myProfile.avatarColor });
        const det = detectFxSetFromInterests(myProfile.interests); if (det) myProfile.fxSet = det;
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
    const setKey = getUserFxSet(memberObj), fxMeta = FX_SETS_META[setKey];
    const fxCls = fxMeta ? ' ' + fxMeta.avaClass : '', avaCol = (memberObj && memberObj.avatarColor) || '#14f1d9';
    const div = el('div', 'msg-item');
    div.innerHTML =
      '<div class="hex-wrap' + fxCls + '" style="width:38px;height:38px;margin-top:2px;cursor:pointer;">' +
        '<div class="hex-border"><div class="hex-core" style="font-size:12px;background:' + escapeHtml(avaCol) + ';">' + escapeHtml(author.slice(0, 2).toUpperCase()) + '</div></div>' +
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
    if (action === 'remove') { localVault.friends = (localVault.friends || []).filter(function (x) { return x !== pid; }); saveLocalVault(); }
    return fetch('/api/friend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: myUid, action: action, target: pid }) }).then(function (r) { return r.json(); }).catch(function () {});
  }

  function renderMemberRow(u, friendPids) {
    const d = el('div', 'online-user-item' + (u.online ? ' is-online' : '')); if (!u.online) d.style.opacity = '0.5';
    const setKey = getUserFxSet(u), fxMeta = FX_SETS_META[setKey];
    const avaWrap = el('div', 'hex-wrap' + (fxMeta ? ' ' + fxMeta.avaClass : '')); avaWrap.style.cssText = 'width:34px;height:34px;';
    const hb = el('div', 'hex-border'), ava = el('div', 'hex-core', String(u.nick || '?').slice(0, 2).toUpperCase());
    ava.style.cssText = 'font-size:11px;background:' + (u.avatarColor || '#14f1d9') + ';';
    hb.appendChild(ava); avaWrap.appendChild(hb); avaWrap.appendChild(el('span', 'hex-status-dot ' + (u.online ? (u.presence || 'online') : 'off')));
    d.appendChild(avaWrap);

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
    const setKey = getUserFxSet(u), fxMeta = FX_SETS_META[setKey];
    document.getElementById('vp-surface').className = 'profile-surface psd-inner' + (fxMeta ? ' ' + fxMeta.surfaceClass : '');
    document.getElementById('vp-banner').style.background = u.bannerColor || '#14f1d9';
    document.getElementById('vp-banner-art').innerHTML = fxMeta ? fxMeta.bannerSvg : '';
    document.getElementById('vp-hero-stage').innerHTML = buildHeroHexMedallionHTML(String(u.nick || '?').slice(0, 2).toUpperCase(), u.avatarColor || '#ff1e56', setKey, u.online ? (u.presence || 'online') : 'off');
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
      fBtn.textContent = '✨ Настроить мой профиль и эффекты'; fBtn.className = 'btn-cyan';
      fBtn.onclick = function () { closeViewProfileModal(); openSettingsModal('fx'); };
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
    closeMobileDrawers(); setMobActiveTab('mob-tab-profile');
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
    document.getElementById('preview-banner').style.background = myProfile.bannerColor || '#14f1d9';
    document.getElementById('preview-banner-art').innerHTML = fxMeta ? fxMeta.bannerSvg : '';
    document.getElementById('preview-hero-stage').innerHTML = buildHeroHexMedallionHTML(n.slice(0, 2).toUpperCase(), myProfile.avatarColor || '#ff1e56', curSet, pr);
    document.getElementById('preview-nick').textContent = n;
    document.getElementById('preview-badge-slot').innerHTML = getBadgeHTML(curSet);
    document.getElementById('preview-status').textContent = st || 'В сети';
    document.getElementById('preview-bio').textContent = bio || 'О себе...';
    const tb = document.getElementById('preview-tags'); tb.innerHTML = '';
    cleanInterestsForDisplay(finalIntr).forEach(function (tg) { tb.appendChild(el('span', 'dp-tag', tg)); });

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
    appSettings.autoOverlay = document.getElementById('chk-auto-overlay').checked;
    try { localStorage.setItem('cyber_settings', JSON.stringify(appSettings)); } catch (e) {}
    applyOutputVolumeToAll(); updateFloatingOverlayUI();
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
    if (!confirm('Выйти из аккаунта?')) return;
    try { localStorage.removeItem('cyber_verified'); localStorage.removeItem('cyber_uid'); } catch (e) {}
    setPersistCookie('cyber_verified', ''); setPersistCookie('cyber_uid', ''); myVerified = false; openAuthModal(true);
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
    if (d.uid && d.uid !== myUid) myUid = d.uid; if (d.nick) myNick = d.nick; myVerified = true; authLocked = false;
    try { localStorage.setItem('cyber_uid', myUid); localStorage.setItem('cyber_nick', myNick); localStorage.setItem('cyber_verified', '1'); } catch (e) {}
    setPersistCookie('cyber_uid', myUid); setPersistCookie('cyber_nick', myNick); setPersistCookie('cyber_verified', '1');
    applyNickUI(); closeAuthModal(); connectEventStream();
  }
  function openAuthModal(lock) {
    authLocked = !!lock || !myVerified; document.getElementById('auth-close-btn').style.display = authLocked ? 'none' : 'block';
    if (myNick && !myNick.startsWith('Гость_')) document.getElementById('nick-inp').value = myNick;
    document.getElementById('auth-modal').classList.add('open'); initTelegramSession().then(function () { startTgPolling(); });
  }
  function closeAuthModal() { if (authLocked && !myVerified) return; if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; } document.getElementById('auth-modal').classList.remove('open'); }
  async function loginWithPassword() {
    const nick = document.getElementById('nick-inp').value.trim(), pass = document.getElementById('pass-inp').value;
    if (!nick) return alert('Введите позывной!'); if (!pass && !myVerified) return alert('Введите пароль!');
    const res = await fetch('/api/auth-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: clientId, uid: myUid, room: currentRoom, nick: nick, password: pass }) });
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
    updateFloatingOverlayUI();
  }
  function stopWebcam(silent) {
    if (webcamStream) { webcamStream.getTracks().forEach(function (t) { t.stop(); }); webcamStream = null; }
    inWebcam = false; document.getElementById('cam-btn').textContent = '📷 Камера'; document.getElementById('cam-btn').classList.remove('active-cam');
    removeMediaTile('cam-local'); if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: inScreen, inCam: false, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateFloatingOverlayUI();
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
    updateFloatingOverlayUI();
  }
  function stopScreenShare(silent) {
    if (screenStream) { screenStream.getTracks().forEach(function (t) { t.stop(); }); screenStream = null; }
    inScreen = false; document.getElementById('screen-btn').textContent = '🖥️ Экран'; document.getElementById('screen-btn').classList.remove('active-screen');
    removeMediaTile('screen-local'); if (!silent && inVoice) postVoiceState({ inVoice: true, inScreen: false, inCam: inWebcam, peerId: myPeerId, voiceChannel: currentVoiceChannel });
    updateFloatingOverlayUI();
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
    playUiBeep(isMuted ? 380 : 640, 0.05); updateFloatingOverlayUI();
  }
  function toggleDeafen() { isDeafened = !isDeafened; playUiBeep(isDeafened ? 320 : 680, 0.05); applyOutputVolumeToAll(); updateFloatingOverlayUI(); }
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
    else if (pressed === userKeybinds.pip) { e.preventDefault(); toggleExternalOverlay(); }
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