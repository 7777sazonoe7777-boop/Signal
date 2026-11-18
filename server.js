const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const DEFAULT_TEXT_CHANNELS = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
const DEFAULT_VOICE_CHANNELS = ['Ночной эфир'];
const MAX_HISTORY = 500, MAX_CHANNELS = 40, MAX_SERVERS = 100, MAX_MEMBERS = 500, MAX_FRIENDS = 200;
const MAX_BODY = 8 * 1024 * 1024, CODE_TTL_MS = 10 * 60 * 1000, ONLINE_TTL_MS = 60000;

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBotUsername = '', tgUpdateOffset = 0;

const serversMeta = Object.create(null), rooms = Object.create(null);
const tgCodes = Object.create(null), pendingTgTokens = Object.create(null), deviceLinkCodes = Object.create(null);
const users = Object.create(null), pidToUid = Object.create(null), userLastSeen = Object.create(null);
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
const cleanImgData = (v, maxLen = 550000) => {
  const s = String(v || '').trim();
  return (s && (s.startsWith('data:image/') || s.startsWith('https://') || s.startsWith('/')) && s.length <= maxLen) ? s : '';
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
      icon: String(icon || title.slice(0, 2)).trim().toUpperCase().slice(0, 3) || 'GK',
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
    author: 'СИСТЕМА GEEK', time: '00:00',
    text: 'Добро пожаловать в GEEK // CYBER.NET! Личные чаты, прямые звонки, индикатор голоса и синхронизация активны.'
  });
}

const safeChannel = (r, c) => { const m = ensureServer(r); return m.textChannels.includes(String(c || '').trim()) ? String(c).trim() : m.textChannels[0]; };
const safeVoiceChannel = (r, c) => { const m = ensureServer(r); return m.voiceChannels.includes(String(c || '').trim()) ? String(c).trim() : String(c || m.voiceChannels[0]).trim().slice(0, 40); };
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
            await tgApi('sendMessage', { chat_id: m.chat.id, parse_mode: 'Markdown', text: '⚡ *GEEK // CYBER.NET*\n\n✅ Аккаунт подтверждён!\n🔑 Код: *' + code + '*' }).catch(() => {});
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
  Object.keys(users).forEach(uid => { if (users[uid] && users[uid].verified) o[uid] = Object.assign({}, users[uid]); });
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
    if (!u.verified && String(u.nick || '').startsWith('Гость_')) return;
    const ex = users[uid] || {}, nick = cleanNick(u.nick || ex.nick);
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
      if (!c.startsWith('dm_') && !meta.textChannels.includes(c) && meta.textChannels.length < MAX_CHANNELS) meta.textChannels.push(c);
      const exList = rm[c] || [], seen = new Set(exList.map(m => m.author + '|' + m.time + '|' + String(m.text || '').slice(0, 120)));
      d.messages[r][ch].slice(-MAX_HISTORY).forEach(m => {
        const cm = { author: String(m.author || '').slice(0, 24), time: String(m.time || '').slice(0, 5), text: String(m.text || '').slice(0, 600000) };
        cm.flags = detectFlags(cm.text.length < 2000 ? cm.text : '');
        const k = cm.author + '|' + cm.time + '|' + cm.text.slice(0, 120);
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
    if (!ver) return { pid: pidOf(uid), nick: n, verified: false, bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#00f0ff', avatarColor: '#3b82f6', avatarImg: '', bannerImg: '', friends: [], incoming: [], outgoing: [], servers: [] };
    u = users[uid] = { pid: pidOf(uid), nick: n, tgId: '', tgUsername: '', passHash: '', verified: true, bio: '', interests: '', customStatus: '', presence: 'online', bannerColor: '#00f0ff', avatarColor: '#3b82f6', avatarImg: '', bannerImg: '', friends: [], incoming: [], outgoing: [], servers: [] };
    pidToUid[u.pid] = uid; nickToUid[n.toLowerCase()] = uid; scheduleSave();
  } else if (ver && !u.verified) {
    u.verified = true; nickToUid[u.nick.toLowerCase()] = uid; scheduleSave();
  }
  return u;
}

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
  const prev = (prevUid && users[prevUid]) ? users[prevUid] : {}, ex = users[finalUid] || {};
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

function touchUser(uid, room) {
  if (!validUid(uid)) return;
  userLastSeen[uid] = Date.now();
  if (room && users[uid] && users[uid].verified) addMember(room, uid);
}

function isUserOnline(uid) {
  const u = users[uid];
  if (!u || u.presence === 'invisible') return false;
  return clients.some(c => c.uid === uid) || (Date.now() - (userLastSeen[uid] || 0)) < ONLINE_TTL_MS;
}

function sendToUid(targetUid, type, payload) {
  const msg = 'data: ' + JSON.stringify({ type, payload }) + '\n\n';
  clients.forEach(c => { if (c.uid === targetUid) { try { c.res.write(msg); } catch (e) {} } });
}

function publicProfileOf(uid) {
  const u = users[uid]; if (!u) return null;
  const on = isUserOnline(uid);
  return { pid: u.pid, nick: u.nick, tgUsername: u.tgUsername || '', hasPassword: !!u.passHash, verified: !!u.verified, online: on, presence: on ? (u.presence || 'online') : 'offline', bio: u.bio || '', interests: u.interests || '', customStatus: u.customStatus || '', bannerColor: u.bannerColor || '#00f0ff', avatarColor: u.avatarColor || '#3b82f6', avatarImg: u.avatarImg || '', bannerImg: u.bannerImg || '' };
}

function sendSocial(uid) {
  const u = users[uid]; if (!u || !u.verified) return;
  const info = p => (pidToUid[p] && users[pidToUid[p]]) ? publicProfileOf(pidToUid[p]) : { pid: p, nick: 'Друг (' + p.slice(0, 4) + ')', online: false, presence: 'offline' };
  const payload = Object.assign({}, publicProfileOf(uid), { servers: u.servers || [], friends: u.friends.map(info), incoming: u.incoming.map(info), outgoing: u.outgoing.slice() });
  const msg = 'data: ' + JSON.stringify({ type: 'social', payload }) + '\n\n';
  clients.forEach(c => { if (c.uid === uid) { try { c.res.write(msg); } catch (e) {} } });
}

const notifyFriendsOf = uid => { if (users[uid]) users[uid].friends.forEach(p => { if (pidToUid[p]) sendSocial(pidToUid[p]); }); };
const broadcast = (r, type, payload) => { const d = 'data: ' + JSON.stringify({ type, payload }) + '\n\n'; clients.forEach(c => { if (c.room === r) { try { c.res.write(d); } catch (e) {} } }); };
const broadcastAll = (type, payload) => { const d = 'data: ' + JSON.stringify({ type, payload }) + '\n\n'; clients.forEach(c => { try { c.res.write(d); } catch (e) {} }); };

function memberList(room) {
  const r = safeRoom(room), voiceMap = new Map();
  clients.forEach(c => {
    if (!c.uid || !users[c.uid] || !users[c.uid].verified) return;
    touchUser(c.uid, c.room);
    const pr = voiceMap.get(c.uid), inThisVoice = (c.voiceRoom || c.room) === r && !!c.inVoice;
    voiceMap.set(c.uid, {
      inVoice: !!(pr && pr.inVoice) || inThisVoice,
      inScreen: !!(pr && pr.inScreen) || (inThisVoice && !!c.inScreen),
      inCam: !!(pr && pr.inCam) || (inThisVoice && !!c.inCam),
      voiceChannel: inThisVoice ? c.voiceChannel : (pr ? pr.voiceChannel : null),
      peerId: inThisVoice ? c.peerId : (pr ? pr.peerId : null)
    });
  });

  const rawUids = (members[r] || []).filter(uid => users[uid] && users[uid].verified);
  const byNick = new Map();
  rawUids.forEach(uid => {
    const key = String(users[uid].nick || '').toLowerCase(), prevUid = byNick.get(key);
    if (!prevUid || (!isUserOnline(prevUid) && isUserOnline(uid))) byNick.set(key, uid);
  });

  return Array.from(byNick.values()).map(uid => {
    const u = users[uid], o = voiceMap.get(uid), isOn = isUserOnline(uid);
    return { pid: u.pid, nick: u.nick, verified: true, online: isOn, presence: isOn ? (u.presence || 'online') : 'offline', customStatus: u.customStatus || '', bio: u.bio || '', interests: u.interests || '', bannerColor: u.bannerColor || '#00f0ff', avatarColor: u.avatarColor || '#3b82f6', avatarImg: u.avatarImg || '', bannerImg: u.bannerImg || '', inVoice: !!(o && o.inVoice), inScreen: !!(o && o.inScreen), inCam: !!(o && o.inCam), voiceChannel: o ? o.voiceChannel : null, peerId: o ? o.peerId : null };
  });
}

const broadcastUsers = r => broadcast(r, 'users', memberList(r));
const notifyAllRoomsOfUser = uid => Object.keys(members).forEach(r => { if (members[r] && members[r].includes(uid)) broadcastUsers(r); });
const broadcastServers = () => broadcastAll('servers', { list: Object.values(serversMeta) });

setInterval(() => {
  clients.forEach(c => {
    if (c.uid && users[c.uid] && users[c.uid].verified) touchUser(c.uid, c.room);
    try { c.res.write(': ping\n\n'); } catch (e) {}
  });
  Object.keys(rooms).forEach(r => broadcastUsers(r));
}, 15000);

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
<title>GEEK // CYBER.NET</title>
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
  @keyframes speakWave { 0%,100%{transform:scaleY(0.35);opacity:0.6;} 50%{transform:scaleY(1.15);opacity:1;} }

  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html, body {
    font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;
    background-color:var(--bg-darkest); background-image:var(--pcb); color:var(--text-main);
    width:100%; height:100vh; height:100dvh; display:flex; flex-direction:column;
    overflow:hidden; user-select:none; overscroll-behavior:none;
    padding-top:env(safe-area-inset-top, 0px);
  }

  .hex-wrap { position:relative; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; overflow:visible !important; }
  .hex-border { position:relative; width:100%; height:100%; clip-path:var(--hex-regular); background:rgba(0,240,255,0.35); display:flex; align-items:center; justify-content:center; padding:2px; overflow:hidden; z-index:1; }
  .hex-wrap.has-custom-frame .hex-border { width:54%; height:58%; margin-right:5%; margin-top:4%; clip-path:var(--hex-inner-hole); padding:0; background:transparent; }
  .hex-core { position:relative; z-index:1; width:100%; height:100%; clip-path:inherit; background:linear-gradient(145deg,#14253d,#08111e); color:#fff; font-weight:800; display:flex; align-items:center; justify-content:center; overflow:hidden; background-size:cover !important; background-position:center !important; }
  .hex-core img.ava-custom-img, .cds-user-core img.ava-custom-img { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
  .mini-frame-overlay { position:absolute; width:146%; height:146%; left:-23%; top:-23%; object-fit:contain; mix-blend-mode:screen; pointer-events:none; z-index:4; }
  .hex-status-dot { position:absolute; right:-2px; bottom:-2px; width:10px; height:10px; clip-path:var(--hex-regular); background:var(--green); border:1.5px solid #04070d; z-index:6; }
  .hex-status-dot.idle { background:var(--yellow); }
  .hex-status-dot.dnd { background:var(--red); }
  .hex-status-dot.invisible,.hex-status-dot.offline,.hex-status-dot.off { background:var(--text-dim); }

  .cyber-diode-scene { position:relative; width:112px; height:112px; margin:0 auto 4px auto; display:flex; align-items:center; justify-content:center; flex-shrink:0; overflow:visible; cursor:pointer; }
  .cds-user-core { position:absolute; left:22.4%; top:24.8%; width:50.2%; height:56.8%; clip-path:var(--hex-inner-hole); background:#070d19; background-size:cover !important; background-position:center !important; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:900; color:#fff; z-index:1; border:1px solid rgba(0,240,255,0.35); box-shadow:inset 0 0 16px rgba(0,240,255,0.3); overflow:hidden; }
  .cds-frame-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; mix-blend-mode:screen; pointer-events:none; z-index:3; }

  .cyber-badge { display:inline-flex; align-items:center; gap:3px; padding:1.5px 6px; border-radius:4px; font-size:9px; font-weight:900; letter-spacing:0.5px; text-transform:uppercase; white-space:nowrap; flex-shrink:0; background-size:200% 200%; animation:badgeFlow 2.5s ease infinite; }
  .cyber-badge.b-set1 { background-image:linear-gradient(90deg,#ff2a85,#00f0ff,#ff2a85); color:#fff; box-shadow:0 0 8px rgba(0,240,255,0.6); }
  .cyber-badge.b-set2 { background-image:linear-gradient(90deg,#ff6a00,#fcee09,#00f0ff); color:#04120c; box-shadow:0 0 8px rgba(255,106,0,0.65); }
  .cyber-badge.b-set3 { background-image:linear-gradient(90deg,#ff003c,#ff5500,#ff003c); color:#fff; box-shadow:0 0 8px rgba(255,0,60,0.7); }

  .profile-surface { position:relative; background:#060a12; border:1px solid var(--border); border-radius:14px; overflow:hidden; transition:0.25s; background-size:cover; background-position:center; }
  .profile-custom-bg { position:absolute; inset:0; width:100%; height:100%; background-size:cover; background-position:center; opacity:0.45; pointer-events:none; z-index:1; }
  .profile-frame-overlay { position:absolute; inset:0; width:100%; height:100%; background-image:url('/profile_frames_3sets.jpg'); background-repeat:no-repeat; background-size:300% 100%; mix-blend-mode:screen; pointer-events:none; z-index:2 !important; opacity:0; transition:opacity 0.2s; }
  .profile-surface.theme-set1 .profile-frame-overlay { opacity:1; background-position:0% 0%; }
  .profile-surface.theme-set2 .profile-frame-overlay { opacity:1; background-position:50% 0%; }
  .profile-surface.theme-set3 .profile-frame-overlay { opacity:1; background-position:100% 0%; }
  .profile-surface.theme-set1 { border:1px solid rgba(184,41,255,0.55); box-shadow:0 0 26px rgba(184,41,255,0.35); background-color:#050811; }
  .profile-surface.theme-set2 { border:1px solid rgba(255,120,0,0.55); box-shadow:0 0 26px rgba(255,120,0,0.35); background-color:#060911; }
  .profile-surface.theme-set3 { border:1px solid rgba(255,0,60,0.6); box-shadow:0 0 26px rgba(255,0,60,0.4); background-color:#090508; }

  .dp-body { padding:28px 26px 20px 26px; position:relative; z-index:6 !important; flex:1; display:flex; flex-direction:column; gap:7px; }
  .profile-surface[class*="theme-set"] .dp-body { padding:116px 42px 22px 42px !important; }
  .profile-surface[class*="theme-set"] .cyber-diode-scene { width:104px !important; height:104px !important; margin:-16px auto 0 auto !important; }
  .dp-nick-line { display:flex; align-items:center; justify-content:center; gap:7px; flex-wrap:wrap; text-align:center; }
  .dp-nick { font-size:18px; font-weight:900; color:#fff; text-shadow:0 2px 6px #000; }
  .dp-status { font-size:12px; color:var(--brand); text-align:center; text-shadow:0 1px 4px #000; }
  .dp-sec { background:rgba(4,7,14,0.9) !important; border:1px solid rgba(0,240,255,0.24) !important; border-radius:8px; padding:7px 11px !important; backdrop-filter:blur(8px); box-shadow:0 4px 14px rgba(0,0,0,0.75); }
  .dp-sec-title { font-size:9.5px !important; font-weight:800; color:var(--brand); margin-bottom:2px !important; text-transform:uppercase; text-shadow:0 1px 4px #000; }
  .dp-bio { font-size:11.5px !important; line-height:1.3 !important; color:#eef8ff !important; white-space:pre-wrap; }
  .dp-tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:3px; }
  .dp-tag { background:rgba(0,240,255,0.12); border:1px solid var(--border); color:var(--brand); padding:2px 7px; border-radius:4px; font-size:10.5px; font-weight:700; }

  .profile-surface.theme-set1 .dp-sec:nth-of-type(2), .profile-surface.theme-set1 .dp-sec:nth-of-type(3), .profile-surface.theme-set1 .dp-actions-col { margin-left:104px !important; border-color:rgba(184,41,255,0.45) !important; }
  .profile-surface.theme-set2 .dp-sec:nth-of-type(1), .profile-surface.theme-set2 .dp-sec:nth-of-type(2), .profile-surface.theme-set2 .dp-sec:nth-of-type(3) { margin-right:86px !important; border-color:rgba(255,123,0,0.45) !important; }
  .profile-surface.theme-set3 .dp-sec:nth-of-type(2), .profile-surface.theme-set3 .dp-sec:nth-of-type(3) { margin-left:56px !important; margin-right:72px !important; border-color:rgba(255,0,60,0.45) !important; }
  .dp-actions-col { display:flex; flex-direction:column; gap:7px; margin-top:auto; padding-top:6px; position:relative; z-index:10 !important; }
  .status-pill { font-size:10px; padding:2px 7px; border-radius:4px; font-weight:800; }
  .status-pill.on { background:rgba(16,185,129,0.18); color:var(--green); }
  .status-pill.off { background:rgba(255,255,255,0.06); color:var(--text-muted); }
  #preview-surface { max-width:365px; margin:0 auto; }

  .photo-upload-bar { display:grid; grid-template-columns:1fr 1fr; gap:10px; background:rgba(0,240,255,0.06); border:1.5px dashed var(--cyan-border); border-radius:10px; padding:12px; }
  .pub-col { display:flex; flex-direction:column; gap:6px; }
  .pub-title { font-size:11px; font-weight:800; color:var(--brand); text-transform:uppercase; }

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

  .app-layout { flex:1; display:flex; width:100%; min-height:0; overflow:hidden; position:relative; }
  .servers-rail { width:68px; background:rgba(4,7,13,0.94); border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:10px; overflow-y:auto; flex-shrink:0; z-index:20; }
  .servers-rail::-webkit-scrollbar { display:none; }
  .srv-pill-wrap { position:relative; width:68px; display:flex; justify-content:center; align-items:center; }
  .srv-pill-bar { position:absolute; left:0; width:3px; height:10px; background:var(--brand); opacity:0; transition:0.18s; }
  .srv-pill-wrap.active .srv-pill-bar { opacity:1; height:36px; }
  .srv-ico { width:44px; height:44px; clip-path:var(--hex-regular); background:#0c1626; color:var(--text-normal); font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .srv-ico:hover,.srv-pill-wrap.active .srv-ico { background:var(--brand); color:#031518; box-shadow:0 0 14px rgba(0,240,255,0.6); }
  .srv-ico.friends-hub-ico { background:linear-gradient(135deg,#0d1b2e,#1a1033); color:var(--brand); font-size:19px; border:1px solid var(--cyan-border); position:relative; }
  .srv-pill-wrap.active .srv-ico.friends-hub-ico { background:linear-gradient(135deg,var(--brand),var(--pink)); color:#fff; box-shadow:0 0 16px rgba(0,240,255,0.7); }
  .dm-total-badge { position:absolute; top:-3px; right:6px; background:var(--pink); color:#fff; font-size:9.5px; font-weight:900; padding:1px 5px; border-radius:999px; box-shadow:0 0 8px var(--pink); pointer-events:none; z-index:5; display:none; }
  .srv-ico-action { width:44px; height:44px; clip-path:var(--hex-regular); background:rgba(255,42,133,0.18); color:var(--pink); font-size:20px; font-weight:800; display:flex; align-items:center; justify-content:center; cursor:pointer; }

  .workspace { flex:1; display:grid; grid-template-columns:250px 1fr 245px; min-height:0; overflow:hidden; position:relative; }
  body.hide-members-panel .workspace { grid-template-columns:250px 1fr; }
  body.hide-members-panel .right-panel { display:none; }

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

  /* СПИСОК ЛИЧНЫХ ЧАТОВ СЛЕВА */
  .dm-item-btn { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; border-radius:7px; cursor:pointer; margin-bottom:4px; border:1px solid transparent; background:rgba(10,18,30,0.55); transition:0.15s; }
  .dm-item-btn:hover { background:var(--bg-hover); border-color:var(--border); }
  .dm-item-btn.active { background:var(--bg-active); border-color:var(--cyan-border); }
  .dm-item-left { display:flex; align-items:center; gap:9px; min-width:0; flex:1; }
  .dm-item-nick { font-size:13px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dm-item-sub { font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* ИНДИКАТОР ГОЛОСА И ВСПЛЫВАЮЩЕЕ МЕНЮ УЧАСТНИКА В ГОЛОСОВОМ КАНАЛЕ */
  .voice-connected-users { display:flex; flex-direction:column; gap:6px; padding:4px 0 6px 12px; }
  .vc-user-row { position:relative; display:flex; align-items:center; gap:10px; padding:4px 8px; border-radius:6px; font-size:12px; color:var(--text-normal); cursor:pointer; border:1px solid transparent; transition:0.15s; }
  .vc-user-row:hover { background:var(--bg-hover); }
  .vc-user-row.is-speaking { background:rgba(16,185,129,0.16); border-color:rgba(16,185,129,0.55); box-shadow:0 0 12px rgba(16,185,129,0.25); color:#fff; }
  .vc-user-row.is-speaking .hex-wrap { filter:drop-shadow(0 0 7px #10b981) drop-shadow(0 0 12px #00f0ff) !important; }
  .vc-speak-indicator { display:inline-flex; align-items:center; gap:2px; height:12px; margin-left:auto; opacity:0; transition:opacity 0.12s; }
  .vc-user-row.is-speaking .vc-speak-indicator { opacity:1; }
  .vc-speak-bar { width:2.5px; height:10px; background:#10b981; border-radius:2px; box-shadow:0 0 6px #10b981; animation:speakWave 0.45s ease-in-out infinite; }
  .vc-speak-bar:nth-child(2) { animation-delay:0.15s; height:12px; }
  .vc-speak-bar:nth-child(3) { animation-delay:0.3s; height:8px; }

  .vc-user-popover { position:fixed; width:250px; background:rgba(6,11,20,0.98); border:1.5px solid var(--brand); box-shadow:0 10px 30px rgba(0,0,0,0.85), 0 0 18px rgba(0,240,255,0.28); border-radius:10px; padding:12px; z-index:1200; display:none; flex-direction:column; gap:9px; }
  .vc-user-popover.open { display:flex; }
  .vup-head { display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--border); padding-bottom:8px; }
  .vup-vol-box { background:#040810; border:1px solid var(--border); border-radius:7px; padding:8px 10px; }
  .vup-vol-top { display:flex; justify-content:space-between; font-size:10.5px; font-weight:800; color:var(--brand); margin-bottom:4px; }
  .vup-actions { display:flex; flex-direction:column; gap:5px; }
  .vup-btn { width:100%; text-align:left; padding:7px 10px; background:rgba(0,240,255,0.08); border:1px solid var(--border); color:var(--text-main); border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:7px; }
  .vup-btn:hover { background:var(--bg-active); border-color:var(--brand); color:#fff; }

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

  .main-chat { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; flex:1; }
  .audio-stream-header-card { margin:8px 12px 4px; padding:9px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-shrink:0; }
  .ash-left { display:flex; align-items:center; gap:8px; min-width:0; }
  .ash-label { font-size:9.5px; font-weight:800; color:var(--brand); text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ash-channel { font-size:14px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ash-wave { flex:1; height:24px; display:flex; align-items:center; justify-content:center; gap:3px; overflow:hidden; max-width:340px; }
  .ash-bar { width:3px; height:100%; background:var(--brand); border-radius:2px; opacity:0.35; transform:scaleY(0.25); }
  body.voice-live .ash-bar { animation:eqPulse 0.9s ease-in-out infinite; }
  .ash-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }

  .media-stage-dock { position:relative; margin:4px 12px; background:rgba(5,10,18,0.95); border:1px solid var(--cyan-border); border-radius:10px; padding:8px; display:none; flex-direction:column; gap:6px; height:var(--stage-height, 250px); min-height:42px; overflow:hidden; flex-shrink:0; }
  .media-stage-dock.show { display:flex; }
  .media-stage-dock.collapsed { height:42px !important; }
  .msd-header { display:flex; justify-content:space-between; align-items:center; gap:8px; border-bottom:1px solid var(--border); padding-bottom:5px; flex-wrap:wrap; flex-shrink:0; }
  .msd-title { font-size:10.5px; font-weight:800; color:var(--brand); text-transform:uppercase; }
  .msd-layout-btn { background:#0d1829; border:1px solid var(--border); color:var(--text-normal); padding:3px 8px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; }
  .msd-layout-btn.active { background:var(--brand); color:#031518; border-color:var(--brand); }
  .screen-grid { flex:1; overflow-y:auto; min-height:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:8px; width:100%; }
  .screen-grid.spotlight-mode { grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
  .screen-grid.spotlight-mode .screen-card.featured-tile { grid-column:1 / -1; }
  .screen-card { background:#04070d; border:1px solid var(--border); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; cursor:pointer; }
  .screen-card.featured-tile { border-color:var(--brand); }
  .screen-card-head { display:flex; justify-content:space-between; align-items:center; padding:5px 8px; background:rgba(4,7,13,0.92); border-bottom:1px solid var(--border); font-size:10.5px; font-weight:700; color:var(--text-main); gap:5px; flex-wrap:wrap; }
  .screen-live-pill { background:var(--pink); color:#fff; font-size:8.5px; padding:1px 5px; border-radius:4px; margin-left:4px; }
  .screen-live-pill.cam { background:var(--green); color:#031518; }
  .screen-video-wrap { position:relative; width:100%; background:#000; display:flex; align-items:center; justify-content:center; min-height:110px; max-height:260px; overflow:hidden; flex:1; }
  .screen-card.featured-tile .screen-video-wrap { max-height:360px; }
  .screen-video-wrap video { width:100%; height:100%; max-height:360px; object-fit:contain; background:#000; display:block; }
  .screen-card.nsfw-masked .screen-video-wrap video { filter:blur(26px) brightness(0.3); }
  .media-nsfw-shield { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:rgba(4,7,13,0.85); color:var(--pink); font-size:11.5px; font-weight:800; z-index:5; cursor:pointer; }
  .screen-card.nsfw-masked .media-nsfw-shield { display:flex; }
  .btn-fs { background:#0d1829; border:1px solid var(--border); color:var(--brand); padding:3px 7px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; }
  .stage-resize-handle { height:10px; width:100%; cursor:ns-resize; display:flex; align-items:center; justify-content:center; background:rgba(0,240,255,0.06); border-top:1px solid var(--border); flex-shrink:0; touch-action:none; }
  .stage-resize-handle::after { content:''; width:44px; height:4px; border-radius:4px; background:var(--brand); opacity:0.65; }

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
  .chat-inline-video { max-width:min(100%,400px); max-height:250px; border-radius:6px; margin-top:6px; display:block; border:1px solid var(--cyan-border); background:#000; }
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
  .chat-attach-btn { background:rgba(0,240,255,0.1); border:1px solid var(--cyan-border); color:var(--brand); width:36px; height:36px; border-radius:6px; font-size:17px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .chat-inp { flex:1; min-width:0; background:#050a12; border:1px solid var(--border); border-radius:6px; padding:8px 11px; color:var(--text-main); font-size:14px; outline:none; }

  .right-panel { width:245px; background:rgba(6,11,20,0.92); border-left:1px solid var(--border); padding:12px 10px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; height:100%; }
  .telemetry-mini-card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:9px 10px; margin-bottom:6px; font-size:10.5px; }
  .tm-row { display:flex; justify-content:space-between; color:var(--text-normal); margin-top:4px; font-family:monospace; }
  .tm-val { color:var(--brand); font-weight:700; }
  .right-sec-title { font-size:10.5px; text-transform:uppercase; color:var(--brand); font-weight:800; padding:8px 6px 4px; }
  .online-user-item { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:6px; cursor:pointer; min-width:0; overflow:visible; }
  .online-user-item:hover { background:var(--bg-hover); }
  .member-text-col { flex:1; overflow:hidden; display:flex; flex-direction:column; min-width:0; }
  .member-nick-row { display:flex; align-items:center; gap:5px; font-size:13px; font-weight:700; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .member-status-sub { font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mini-btn { background:rgba(0,240,255,0.08); border:1px solid var(--border); color:var(--brand); padding:2px 7px; border-radius:4px; font-size:10px; font-weight:800; cursor:pointer; flex-shrink:0; }
  .friend-tag { font-size:9.5px; color:var(--green); font-weight:800; }

  .incoming-call-toast { position:fixed; top:52px; right:16px; width:310px; max-width:calc(100vw - 32px); background:rgba(6,12,24,0.98); border:2px solid var(--green); box-shadow:0 0 26px rgba(16,185,129,0.5); border-radius:12px; padding:14px; z-index:1050; display:none; flex-direction:column; gap:10px; }
  .incoming-call-toast.show { display:flex; }

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
  .fxb-prof-thumb { width:72px; height:104px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background-image:url('/profile_frames_3sets.jpg'); background-repeat:no-repeat; background-size:300% 100%; flex-shrink:0; }

  .keybind-row { display:flex; justify-content:space-between; align-items:center; padding:9px 12px; background:#040810; border:1px solid var(--border); border-radius:6px; gap:10px; flex-wrap:wrap; }
  .kb-btn { background:#0d1829; border:1px solid var(--cyan-border); color:var(--brand); font-family:monospace; font-size:12px; font-weight:800; padding:6px 14px; border-radius:5px; cursor:pointer; min-width:130px; text-align:center; }
  .kb-btn.recording { background:rgba(255,42,133,0.25); border-color:var(--pink); color:#fff; }

  .mob-top-btn { display:none; background:rgba(0,240,255,0.08); border:1px solid var(--border); border-radius:6px; color:var(--brand); width:32px; height:32px; align-items:center; justify-content:center; font-size:17px; cursor:pointer; flex-shrink:0; }
  .mob-drawer-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.74); z-index:940; }
  .mob-bottom-nav { display:none; height:calc(54px + env(safe-area-inset-bottom, 0px)); padding-bottom:env(safe-area-inset-bottom, 0px); background:#04070d; border-top:1px solid var(--border); grid-template-columns:repeat(5,1fr); align-items:center; flex-shrink:0; z-index:960; }
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
    .servers-rail { position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px)); left:0; width:64px; z-index:955; transform:translateX(-340px); transition:transform 0.24s ease; }
    .channels-panel { position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px)); left:64px; width:calc(100vw - 64px); max-width:265px; z-index:955; transform:translateX(-340px); transition:transform 0.24s ease; box-shadow:8px 0 24px rgba(0,0,0,0.8); }
    body.mob-left-open .servers-rail, body.mob-left-open .channels-panel { transform:translateX(0); }
    .right-panel { position:fixed; top:0; bottom:calc(54px + env(safe-area-inset-bottom, 0px)); right:0; width:min(84vw,280px); z-index:955; transform:translateX(105%); transition:transform 0.24s ease; box-shadow:-8px 0 24px rgba(0,0,0,0.8); }
    body.mob-right-open .right-panel { transform:translateX(0); }
    body.mob-left-open .mob-drawer-backdrop, body.mob-right-open .mob-drawer-backdrop { display:block; }
    .audio-stream-header-card { margin:6px 10px 2px; padding:8px 10px; }
    .chat-scroll-area { padding:6px 10px; }
    .chat-bottom { padding:4px 10px 6px; }
    .chat-inp { font-size:16px; padding:8px 10px; }
    .profile-slide-drawer { width:100vw; max-width:100vw; padding:0; }
    .profile-slide-drawer .profile-surface { border-radius:0; height:100%; border:none; }
    .settings-modal-box { grid-template-columns:1fr; grid-template-rows:auto 1fr; width:100vw; height:100dvh; max-height:100dvh; border-radius:0; }
    .settings-nav { flex-direction:row; overflow-x:auto; padding:8px 10px; border-right:none; border-bottom:1px solid var(--border); gap:6px; }
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
      <div class="tt-logo"><span style="color:var(--brand);">⚡</span><span>GEEK</span></div>
      <span class="tt-cyber-tag">CYBER.NET</span>
      <span class="tt-proto-pill">МЕСТО ДЛЯ СВОИХ // P2P ПРОТОКОЛ</span>
    </div>
    <div class="tt-right">
      <div class="tt-node-pill"><span class="tt-node-dot"></span><span id="tt-node-label">cy-4371</span></div>
      <button class="tt-invite-btn" onclick="openInviteModal()">+ ПРИГЛАСИТЬ</button>
    </div>
  </div>

  <div class="sub-sync-bar">
    <div class="ss-left"><span>● АКТИВНАЯ СЕТЬ:</span><span style="color:#fff;font-weight:800;">P2P СИНХРОНИЗАЦИЯ</span></div>
    <div class="ss-right">
      <button class="ss-btn" onclick="if(window.innerWidth<=900)toggleMobileRight();else document.body.classList.toggle('hide-members-panel');">👥 УЧАСТНИКИ</button>
    </div>
  </div>

  <div class="app-layout">
    <div class="mob-drawer-backdrop" onclick="closeMobileDrawers()"></div>
    <div class="servers-rail">
      <!-- ЗНАЧОК ДРУЗЕЙ И ЛИЧНЫХ ЧАТОВ НАД СЕРВЕРАМИ -->
      <div class="srv-pill-wrap" id="friends-hub-pill" title="Друзья и Личные сообщения" onclick="openFriendsAndDmHub()">
        <span class="srv-pill-bar"></span>
        <div class="srv-ico friends-hub-ico">👥</div>
        <span class="dm-total-badge" id="dm-total-badge">0</span>
      </div>
      <div id="servers-list-box" style="display:flex;flex-direction:column;gap:10px;align-items:center;width:100%;"></div>
      <div class="srv-ico-action" title="Создать сервер" onclick="openCreateServerModal()">+</div>
    </div>

    <div class="workspace">
      <div class="channels-panel">
        <div class="srv-header">
          <div style="min-width:0;"><div class="srv-sub-label">ОТКРЫТЫЙ УЗЕЛ</div><div class="srv-title" id="srv-title-label">Ночной клуб</div></div>
          <span class="srv-badge-open" onclick="openInviteModal()">Ссылка</span>
        </div>
        <div class="packet-card">
          <div><div class="pk-label">ОЧЕРЕДЬ ПАКЕТОВ</div><div class="pk-val">108.4 FM // P2P</div></div>
          <span class="pk-live">▲ LIVE</span>
        </div>
        <div class="channels-scroll">
          <!-- БЛОК ЛИЧНЫХ СООБЩЕНИЙ СЛЕВА -->
          <div id="dm-left-section">
            <div class="cat-header" style="color:var(--pink);"><span>💬 ЛИЧНЫЕ СООБЩЕНИЯ</span></div>
            <div id="dm-channels-list"></div>
          </div>

          <div class="cat-header" style="margin-top:4px;"><span>◈ ТЕКСТОВЫЕ КАНАЛЫ</span><button class="cat-add-btn" onclick="openCreateChannelModal('text')">+</button></div>
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
            <span class="msd-title">📹 ТРАНСЛЯЦИИ В КАНАЛЕ (ТЯНИТЕ ПОЛОСУ СНИЗУ ДЛЯ РАЗМЕРА)</span>
            <div style="display:flex;gap:6px;">
              <button class="msd-layout-btn active" id="btn-stage-grid" onclick="setStageLayout('grid')">⊞ Сетка</button>
              <button class="msd-layout-btn" id="btn-stage-spot" onclick="setStageLayout('spotlight')">⊡ Фокус</button>
              <button class="msd-layout-btn" id="btn-stage-collapse" onclick="toggleStageCollapse()">▲ Свернуть</button>
            </div>
          </div>
          <div class="screen-grid" id="screen-grid"></div>
          <div class="stage-resize-handle" id="stage-resize-bar" title="Потяните вверх или вниз"></div>
        </div>

        <div class="chat-scroll-area" id="chat-scroll"><div class="messages-container" id="messages-list"></div></div>

        <div class="chat-bottom">
          <div class="console-box">
            <div class="console-top-label"><span>ОКНО ВВОДА // КОНСОЛЬ</span><span id="banner-desc">P2P КАНАЛ АКТИВЕН</span></div>
            <input type="file" id="chat-media-inp" accept="image/*,video/mp4,video/webm" style="display:none;" onchange="handleChatMediaUpload(event)">
            <form class="input-row" onsubmit="sendChatMessage(event)">
              <button type="button" class="chat-attach-btn" title="Отправить фото или видео" onclick="document.getElementById('chat-media-inp').click()">📎</button>
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

  <!-- ВСПЛЫВАЮЩЕЕ МЕНЮ УПРАВЛЕНИЯ СОБЕСЕДНИКОМ В ГОЛОСОВОМ КАНАЛЕ (ГРОМКОСТЬ, ЛС, ПРОФИЛЬ, ДРУЗЬЯ) -->
  <div class="vc-user-popover" id="vc-user-popover">
    <div class="vup-head">
      <div id="vup-ava"></div>
      <div style="flex:1;min-width:0;">
        <div id="vup-nick" style="font-size:14px;font-weight:900;color:#fff;overflow:hidden;text-overflow:ellipsis;">Собеседник</div>
        <div id="vup-sub" style="font-size:10px;color:var(--green);font-weight:700;">🔊 В голосовом эфире</div>
      </div>
    </div>
    <div class="vup-vol-box" id="vup-vol-wrap">
      <div class="vup-vol-top"><span>🔊 ГРОМКОСТЬ СОБЕСЕДНИКА</span><span id="vup-vol-lbl">100%</span></div>
      <input type="range" class="cyber-range" id="vup-vol-range" min="0" max="200" value="100">
    </div>
    <div class="vup-actions">
      <button class="vup-btn" id="vup-btn-dm">💬 Написать лично (ЛС)</button>
      <button class="vup-btn" id="vup-btn-call">📞 Личный звонок 1-на-1</button>
      <button class="vup-btn" id="vup-btn-prof">👤 Открыть профиль</button>
      <button class="vup-btn" id="vup-btn-friend">➕ Добавить в друзья</button>
    </div>
  </div>

  <!-- ВСПЛЫВАЮЩЕЕ ОКНО ВХОДЯЩЕГО ПРЯМОГО ЗВОНКА 1-НА-1 -->
  <div class="incoming-call-toast" id="incoming-call-toast">
    <div style="display:flex;align-items:center;gap:10px;">
      <div id="inc-call-ava"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:10px;font-weight:800;color:var(--green);text-transform:uppercase;">📞 ВХОДЯЩИЙ ЛИЧНЫЙ ЗВОНОК</div>
        <div id="inc-call-nick" style="font-size:15px;font-weight:900;color:#fff;overflow:hidden;text-overflow:ellipsis;">Собеседник</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <button class="btn-cyan" style="background:var(--green);color:#031518;" onclick="acceptDirectCall()">📞 ПРИНЯТЬ</button>
      <button class="btn-danger" onclick="declineDirectCall()">✕ СБРОСИТЬ</button>
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
            <button class="btn-login-mini" id="vp-mention-btn">💬 Личное сообщение</button>
            <button class="btn-login-mini" id="vp-call-btn">📞 Позвонить лично</button>
          </div>
          <button class="btn-cyan" id="vp-friend-btn" style="width:100%;">+ Добавить в друзья</button>
        </div>
      </div>
    </div>
  </div>

  <div class="bottom-status-footer">
    <span id="footer-keybind-hint">ГОРЯЧИЕ КЛАВИШИ АКТИВНЫ</span>
    <span class="bsf-green">GEEK P2P ONLINE // Secure // E2EE // Latency 18ms</span>
  </div>

  <div class="mob-bottom-nav" id="mob-bottom-nav">
    <div class="mob-nav-item" id="mob-tab-left" onclick="toggleMobileLeft()"><span>☰</span><span>Каналы</span></div>
    <div class="mob-nav-item active" id="mob-tab-chat" onclick="closeMobileDrawers()"><span>◈</span><span>Чат</span></div>
    <div class="mob-nav-item" id="mob-tab-voice" onclick="jumpToActiveVoiceChannel()"><span>🔊</span><span>Голос</span></div>
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

        <div class="settings-pane" id="pane-fx">
          <div class="settings-head">
            <h3>✨ Эффекты (Все 3 оригинальные рамки аватара + 3 рамки профиля)</h3>
            <button class="btn-login-mini" id="btn-disable-fx" onclick="selectEffectSet('')">Отключить</button>
          </div>
          <div class="fx-sets-grid">
            <div class="fx-bundle-card set1-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair"><div id="fx-demo-slot-1"></div><div class="fxb-prof-thumb" style="background-position:0% 0%;"></div></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:15px;font-weight:900;color:#00f0ff;">Набор 1: Люси Кушинада // Edgerunners S1</span><span class="cyber-badge b-set1">🌙 LUCY NET</span></div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная неоновая рамка аватара с Люси + фиолетовая неоновая рамка профиля с Луной и портретом Люси.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set1" onclick="selectEffectSet('set1')">🎁 ЗАБРАТЬ</button>
            </div>
            <div class="fx-bundle-card set2-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair"><div id="fx-demo-slot-2"></div><div class="fxb-prof-thumb" style="background-position:50% 0%;"></div></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:15px;font-weight:900;color:#fcee09;">Набор 2: Edgerunners // Граффити «ОПАСНО» (Сезон 2)</span><span class="cyber-badge b-set2">⚠️ EDGERUN</span></div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная огненно-жёлтая рамка аватара «CYBER» + граффити-рамка профиля с черепом в короне и колючей проволокой.</div>
                </div>
              </div>
              <button class="btn-cyan" id="btn-fx-set2" onclick="selectEffectSet('set2')">🎁 ЗАБРАТЬ</button>
            </div>
            <div class="fx-bundle-card set3-card">
              <div class="fxb-left">
                <div class="fxb-preview-pair"><div id="fx-demo-slot-3"></div><div class="fxb-prof-thumb" style="background-position:100% 0%;"></div></div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:15px;font-weight:900;color:#ff4d79;">Набор 3: Джонни Сильверхенд // SAMURAI (Cyberpunk 2077)</span><span class="cyber-badge b-set3">🔥 SAMURAI</span></div>
                  <div style="font-size:12px;color:var(--text-normal);margin-top:4px;">Оригинальная стальная рамка аватара «SAMURAI» с Джонни Сильверхендом + рамка профиля с цепями и горящей гитарой.</div>
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
            <div class="settings-grid-2"><div><label class="field-label">Микрофон</label><select id="set-mic-select" onchange="onMediaDeviceSelectChange()"></select></div><div><label class="field-label">Аудиовыход</label><select id="set-spk-select" onchange="onMediaDeviceSelectChange()"></select></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Усиление микр.: <span id="lbl-mic-vol">100%</span></label><input type="range" class="cyber-range" id="set-mic-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div><div><label class="field-label">Громкость: <span id="lbl-out-vol">100%</span></label><input type="range" class="cyber-range" id="set-out-vol" min="0" max="200" value="100" oninput="onAudioSlidersChange()"></div></div>
            <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><label class="field-label">Тест микрофона</label><button class="btn-login-mini" id="btn-mic-test" onclick="toggleMicTest()">🎙️ ПРОВЕРИТЬ</button></div><div class="mic-meter-wrap"><div class="mic-meter-bar" id="mic-test-bar"></div></div></div>
            <div class="settings-grid-2"><div><label class="field-label">Камера</label><select id="set-cam-select" onchange="onMediaDeviceSelectChange()"></select></div><div><label class="field-label">Разрешение</label><select id="set-cam-res" onchange="saveAudioVideoSettings()"><option value="720">HD 720p</option><option value="480">SD 480p</option></select></div></div>
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
          <div class="settings-head"><h3>🔑 Учётная запись (ПК и Телефон)</h3></div>
          <div class="settings-card">
            <div class="field-label">Быстрый вход в этот же аккаунт на телефоне</div>
            <p style="font-size:12px;color:var(--text-normal);">Нажмите кнопку ниже, чтобы получить 4-значный код, затем откройте приложение на телефоне и введите его во вкладке «📲 КОД ПК/ТЕЛ»:</p>
            <div style="display:flex;gap:10px;align-items:center;">
              <button class="btn-cyan" onclick="generateDeviceLinkCode()">📲 ПОЛУЧИТЬ КОД ДЛЯ ТЕЛЕФОНА</button>
              <span id="device-link-code-box" style="font-size:20px;font-weight:900;color:var(--yellow);letter-spacing:4px;font-family:monospace;"></span>
            </div>
          </div>
          <div class="settings-card">
            <div class="field-label">Установить или обновить пароль для входа по позывному</div>
            <p style="font-size:12px;color:var(--text-normal);">Позывной: <b id="acc-current-nick" style="color:var(--brand);"></b></p>
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

  <div class="modal-backdrop" id="auth-modal" onclick="if(!authLocked && event.target===this)closeAuthModal()">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="color:var(--brand);font-size:16px;">⚡ ВХОД В GEEK</h3><span style="font-size:10px;background:var(--pink);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;">ПК + ANDROID</span></div>
      <div class="auth-tabs">
        <div class="auth-tab active" id="tab-pass-btn" onclick="switchAuthTab('pass')">🔑 ПАРОЛЬ</div>
        <div class="auth-tab" id="tab-link-btn" onclick="switchAuthTab('link')">📲 КОД ПК/ТЕЛ</div>
        <div class="auth-tab" id="tab-tg-btn" onclick="switchAuthTab('tg')">✈️ TELEGRAM</div>
      </div>
      <div id="auth-pass-panel">
        <input type="text" id="nick-inp" placeholder="Ваш позывной (например: Sergo)" maxlength="24">
        <input type="password" id="pass-inp" placeholder="Пароль (минимум 4 символа)" maxlength="64">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithPassword()">ВОЙТИ В АККАУНТ</button>
      </div>
      <div id="auth-link-panel" style="display:none;">
        <input type="text" id="device-link-inp" placeholder="4 ЦИФРЫ КОДА" maxlength="6" style="text-align:center;font-size:16px;font-weight:900;letter-spacing:4px;">
        <button class="btn-cyan" style="width:100%;" onclick="loginWithDeviceCode()">ВОЙТИ В ТОТ ЖЕ АККАУНТ</button>
      </div>
      <div id="auth-tg-panel" style="display:none;">
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