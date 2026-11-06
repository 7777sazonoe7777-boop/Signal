const http = require('http');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'cy-4371';
const CHANNELS = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
const MAX_HISTORY = 500;
const MAX_BODY = 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;


function makeRoom() {
  const r = Object.create(null);
  CHANNELS.forEach(c => { r[c] = []; });
  return r;
}

// Object.create(null) защищает от ключей вроде "__proto__"
const rooms = Object.create(null);
rooms[DEFAULT_ROOM] = makeRoom();
rooms[DEFAULT_ROOM]['игровая-комната'].push({
  author: 'СИСТЕМА',
  time: '00:00',
  text: 'Сервер запущен в публичной сети! Нажмите «Пригласить друга», чтобы получить кликабельную интернет-ссылку.'
});

const emailCodes = Object.create(null);
let clients = [];

function safeRoom(v) {
  const s = String(v || '').trim();
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(s) ? s : DEFAULT_ROOM;
}
function safeChannel(v) {
  const s = String(v || '');
  return CHANNELS.includes(s) ? s : CHANNELS[0];
}
function cleanNick(v) {
  return String(v || '').trim().slice(0, 24) || 'Гость';
}
function getRoom(room) {
  if (!rooms[room]) rooms[room] = makeRoom();
  return rooms[room];
}

function broadcast(room, eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload });
  clients.forEach(c => {
    if (c.room === room) c.res.write('data: ' + data + '\n\n');
  });
}

function broadcastUsers(room) {
  const list = clients
    .filter(c => c.room === room)
    .map(c => ({ nick: c.nick, inVoice: c.inVoice, peerId: c.peerId }));
  broadcast(room, 'users', list);
}

// Поддерживаем SSE-соединения живыми (туннель и прокси обрывают «тихие» соединения)
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

  .servers-rail { background: #030508; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 10px; }
  .bolt-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--cyan-bright); font-size: 18px; margin-bottom: 4px; }
  .srv-ico { width: 42px; height: 42px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .srv-ico.active { background: var(--cyan-bright); color: #042f2e; border-color: var(--cyan-bright); box-shadow: 0 0 12px rgba(45, 212, 191, 0.4); }
  .srv-ico-add { background: transparent; border: 1px dashed var(--border); color: var(--pink); font-size: 18px; border-radius: 12px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; }

  .channels-panel { background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .srv-header { padding: 12px 14px 8px; display: flex; justify-content: space-between; align-items: center; }
  .srv-label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .srv-title { font-size: 16px; font-weight: 800; color: #fff; margin-top: 2px; }
  .btn-code-modal { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }

  .freq-card { margin: 4px 10px 10px; padding: 12px; border-radius: 10px; background: linear-gradient(135deg, #111a24 0%, #0a0f16 100%); border: 1px solid var(--border); }
  .freq-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .freq-tag { font-size: 9px; color: var(--text-muted); font-weight: 700; }
  .live-badge { font-size: 9px; background: #9d174d; color: #fff; padding: 1px 6px; border-radius: 4px; font-weight: 700; }
  .freq-card h4 { font-size: 15px; font-weight: 800; line-height: 1.2; margin-bottom: 6px; }
  .freq-card p { font-size: 10px; color: var(--text-dim); line-height: 1.35; }

  .channels-scroll { flex: 1; overflow-y: auto; padding: 0 8px; }
  .cat-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
  .ch-btn { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; margin-bottom: 2px; }
  .ch-btn:hover { background: rgba(255,255,255,0.03); color: #fff; }
  .ch-btn.active { background: rgba(20, 184, 166, 0.12); color: #fff; font-weight: 600; }
  .ch-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--cyan-bright); display: none; }
  .ch-btn.active .ch-dot { display: block; }

  .voice-ch-box { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border-radius: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
  .off-badge { font-size: 9px; background: rgba(255,255,255,0.05); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; font-weight: 700; }

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
  .online-dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; }
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
  /* Кликабельная ссылка */
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
    <span><b>РЕАЛЬНАЯ СЕТЬ:</b> Скопируйте публичную ссылку и отправьте другу — всё синхронизируется через ваш ПК</span>
    <span style="font-weight:700;color:var(--cyan-bright);" id="room-code-label">Код комнаты: <b>cy-4371</b> НА СВЯЗИ</span>
  </div>

  <div class="workspace">
    <div class="servers-rail">
      <div class="bolt-icon">⚡</div>
      <div class="srv-ico active">НК</div>
      <div class="srv-ico">HC</div>
      <div class="srv-ico">MA</div>
      <div class="srv-ico-add">+</div>
    </div>

    <div class="channels-panel">
      <div class="srv-header">
        <div>
          <div class="srv-label">ОТКРЫТЫЙ СЕРВЕР</div>
          <div class="srv-title">Ночной клуб</div>
        </div>
        <button class="btn-code-modal" onclick="promptRoomCode()">Ввести код</button>
      </div>

      <div class="freq-card">
        <div class="freq-top">
          <span class="freq-tag">ЧАСТОТА 108.4 FM</span>
          <span class="live-badge">LIVE</span>
        </div>
        <h4>Лови свою частоту.</h4>
        <p>Игры, идеи и разговоры после полуночи</p>
      </div>

      <div class="channels-scroll">
        <div class="cat-header"><span>ТЕКСТОВЫЕ КАНАЛЫ</span><span>+</span></div>
        <div id="text-channels-list">
          <div class="ch-btn active" data-ch="игровая-комната" onclick="setChannel('игровая-комната', this)"><span># игровая-комната</span><span class="ch-dot"></span></div>
          <div class="ch-btn" data-ch="общий" onclick="setChannel('общий', this)"><span># общий</span><span class="ch-dot"></span></div>
          <div class="ch-btn" data-ch="знакомства" onclick="setChannel('знакомства', this)"><span># знакомства</span><span class="ch-dot"></span></div>
          <div class="ch-btn" data-ch="музыка" onclick="setChannel('музыка', this)"><span># музыка</span><span class="ch-dot"></span></div>
        </div>

        <div class="cat-header" style="margin-top: 8px;"><span>ГОЛОСОВЫЕ КАНАЛЫ</span></div>
        <div class="voice-ch-box" id="sidebar-voice-btn" onclick="toggleVoiceCall()">
          <span>🔊 Ночной эфир</span>
          <span class="off-badge" id="voice-off-badge">OFF</span>
        </div>
      </div>

      <div class="connect-friend-box">
        <div class="connect-title">СВЯЗЬ С ДРУГОМ <span style="color:var(--cyan-bright);">// P2P</span></div>
        <div class="connect-row">
          <input type="text" id="friend-code-inp" class="connect-inp" placeholder="Код комнаты...">
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
            <div class="welcome-tag">НАЧАЛО КАНАЛА // СЕРВЕР ПК</div>
            <h2>Кто сегодня на связи?</h2>
            <p id="banner-desc">Это #игровая-комната на сервере «Ночной клуб». Общайтесь с друзьями через ваш ПК.</p>
            <div class="pill-tags-row">
              <span class="pill-tag">ТЕКСТОМ — ТЕКСТ РАВНО ИГРОК</span>
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
              <div class="voice-title">Общий разговор участников канала («Ночной эфир»)</div>
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
          <span id="auth-bar-text">Вы в сети как <b>Гость_932</b> — сообщения синхронизируются через ваш сервер</span>
          <button class="btn-login-mini" onclick="openAuthModal()">Регистрация по коду</button>
        </div>
        <form class="input-row" onsubmit="sendChatMessage(event)">
          <input type="text" id="chat-input" class="chat-inp" placeholder="Написать сообщение..." autocomplete="off" maxlength="1000">
          <button type="submit" class="btn-cyan">ОТПРАВИТЬ</button>
        </form>
        <div class="bottom-hint">ENTER — ОТПРАВИТЬ • ПУБЛИЧНЫЙ СЕРВЕР</div>
      </div>
    </div>

    <div class="right-panel">
      <div class="right-sec-title">НА ЧАСТОТЕ (<span id="online-count">1</span>)</div>
      <div id="online-users-box"></div>
      <div class="invite-banner-card">
        <h5>Зови друзей в канал</h5>
        <p>Отправьте другу публичную ссылку — он сразу появится в списке участников.</p>
        <button class="btn-pink-card" onclick="openInviteModal()">🔗 СОЗДАТЬ ПРИГЛАШЕНИЕ</button>
      </div>
    </div>
  </div>

  <!-- Модальное окно приглашения с кликабельной ссылкой -->
  <div class="modal-backdrop" id="invite-modal" onclick="if(event.target===this)closeInviteModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Публичная ссылка для друга</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Нажмите на ссылку, чтобы открыть её, или скопируйте её:</p>
      <a class="link-box" id="public-invite-url" href="#" target="_blank" rel="noopener">Генерация публичного адреса...</a>
      <button class="btn-cyan" style="width:100%;margin-bottom:6px;" onclick="copyInviteLink()">Скопировать ссылку</button>
      <button class="btn-login-mini" style="width:100%;text-align:center;" onclick="closeInviteModal()">Закрыть</button>
    </div>
  </div>

  <div class="modal-backdrop" id="auth-modal" onclick="if(event.target===this)closeAuthModal()">
    <div class="modal-box">
      <h3 style="color:var(--cyan-bright);font-size:16px;margin-bottom:6px;">Верификация по почте</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Введите ваш Email для получения кода.</p>
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

<script>
  const CHANNEL_LIST = ['игровая-комната', 'общий', 'знакомства', 'музыка'];
  const params = new URLSearchParams(window.location.search);
  const currentRoom = params.get('room') || 'cy-4371';
  let currentChannel = params.get('channel') || 'игровая-комната';
  if (CHANNEL_LIST.indexOf(currentChannel) === -1) currentChannel = CHANNEL_LIST[0];
  let myNick = 'Гость_932';
  try { myNick = localStorage.getItem('cyber_nick') || 'Гость_932'; } catch (e) {}
  const clientId = Math.random().toString(36).substring(2, 10);

  // Voice state (объявлено заранее, чтобы обработчики SSE не обращались к необъявленным переменным)
  let localStream = null, peer = null, myPeerId = null, inVoice = false, isMuted = false;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyNickUI() {
    document.getElementById('user-name-label').textContent = myNick;
    document.getElementById('user-ava').textContent = myNick.slice(0, 2).toUpperCase();
    document.getElementById('voice-my-name').textContent = myNick + ' (Вы)';
    document.getElementById('auth-bar-text').innerHTML = 'Вы в сети как <b>' + escapeHtml(myNick) + '</b> — сообщения синхронизируются через ваш сервер';
  }

  function applyChannelUI(ch) {
    document.getElementById('top-ch-name').textContent = ch;
    document.getElementById('top-ch-desc').textContent = 'Канал сервера «Ночной клуб»';
    document.getElementById('banner-desc').textContent = 'Это #' + ch + ' на сервере «Ночной клуб». Общайтесь с друзьями в реальном времени.';
    document.getElementById('chat-input').placeholder = 'Написать сообщение в #' + ch + '...';
    document.querySelectorAll('.ch-btn').forEach(i => {
      i.classList.toggle('active', i.getAttribute('data-ch') === ch);
    });
  }

  applyNickUI();
  applyChannelUI(currentChannel);
  document.getElementById('node-badge').textContent = 'Узел активен, ' + currentRoom;
  document.getElementById('room-code-label').innerHTML = 'Код комнаты: <b>' + escapeHtml(currentRoom) + '</b> НА СВЯЗИ';

  const evtSource = new EventSource('/api/events?id=' + clientId + '&room=' + encodeURIComponent(currentRoom) + '&nick=' + encodeURIComponent(myNick));

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    if (data.type === 'msg' && data.payload.channel === currentChannel) {
      addMsgToDOM(data.payload.msg);
    } else if (data.type === 'users') {
      renderUsers(data.payload);
    } else if (data.type === 'tunnel') {
      if (document.getElementById('invite-modal').classList.contains('open')) refreshInviteLink();
    } else if (data.type === 'voice-join') {
      if (inVoice && peer && localStream && myPeerId && data.payload.peerId !== myPeerId) {
        const pid = data.payload.peerId;
        const call = peer.call(pid, localStream);
        if (!call) return;
        call.on('stream', (remoteStream) => playStream(pid, remoteStream));
        call.on('close', () => removeAudio(pid));
        call.on('error', () => removeAudio(pid));
      }
    }
  };

  function loadHistory() {
    const ch = currentChannel;
    fetch('/api/history?room=' + encodeURIComponent(currentRoom) + '&channel=' + encodeURIComponent(ch))
      .then(r => r.json())
      .then(msgs => {
        if (ch !== currentChannel) return; // пользователь уже переключил канал
        const box = document.getElementById('messages-list');
        box.innerHTML = '';
        if (msgs.length === 0) {
          box.innerHTML = '<div id="empty-hint" style="font-size:11px;color:var(--text-muted);">Здесь пока тихо. Напишите первым.</div>';
          return;
        }
        msgs.forEach(addMsgToDOM);
      })
      .catch(() => {});
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

  function renderUsers(users) {
    document.getElementById('online-count').textContent = users.length;
    const box = document.getElementById('online-users-box');
    box.innerHTML = '';
    users.forEach(u => {
      const d = document.createElement('div');
      d.className = 'online-user-item';
      d.innerHTML = '<span class="online-dot"></span><span>' + escapeHtml(u.nick) + (u.inVoice ? ' 🔊' : '') + '</span>';
      box.appendChild(d);
    });
  }

  function sendChatMessage(e) {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text) return;
    fetch('/api/message', {
      method: 'POST',
      body: JSON.stringify({ id: clientId, room: currentRoom, channel: currentChannel, author: myNick, text })
    }).catch(() => alert('Не удалось отправить сообщение. Проверьте соединение.'));
    inp.value = '';
  }

  function setChannel(ch, el) {
    currentChannel = ch;
    applyChannelUI(ch);
    loadHistory();
  }

  function connectToFriend() {
    const code = document.getElementById('friend-code-inp').value.trim();
    if (!code) return alert('Введите код комнаты!');
    window.location.href = window.location.origin + '/?room=' + encodeURIComponent(code) + '&channel=' + encodeURIComponent(currentChannel);
  }

  function promptRoomCode() {
    const code = prompt('Введите код комнаты друга:', 'cy-');
    if (code && code.trim()) {
      window.location.href = window.location.origin + '/?room=' + encodeURIComponent(code.trim()) + '&channel=' + encodeURIComponent(currentChannel);
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
  function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
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
      const res = await fetch('/api/send-code', { method: 'POST', body: JSON.stringify({ email }) });
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
      const res = await fetch('/api/verify-code', { method: 'POST', body: JSON.stringify({ id: clientId, email, code, nick }) });
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
    return fetch('/api/voice', { method: 'POST', body: JSON.stringify(Object.assign({ id: clientId }, state)) }).catch(() => {});
  }

  function resetVoiceUI() {
    document.getElementById('connect-voice-btn').textContent = 'ПОДКЛЮЧИТЬСЯ';
    document.getElementById('connect-voice-btn').className = 'btn-cyan';
    document.getElementById('mute-btn').style.display = 'none';
    document.getElementById('mute-btn').textContent = '🎤 Микр. вкл';
    document.getElementById('voice-active-area').classList.remove('show');
    document.getElementById('sidebar-voice-btn').style.color = 'var(--text-dim)';
    document.getElementById('voice-off-badge').textContent = 'OFF';
    document.getElementById('audio-box').innerHTML = '';
  }

  async function toggleVoiceCall() {
    if (inVoice) {
      if (localStream) localStream.getTracks().forEach(t => t.stop());
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
    document.getElementById('sidebar-voice-btn').style.color = '#4ade80';
    document.getElementById('voice-off-badge').textContent = 'ON';

    peer = new Peer();
    peer.on('open', (id) => {
      myPeerId = id;
      postVoiceState({ inVoice: true, peerId: id });
    });
    peer.on('call', (call) => {
      call.answer(localStream);
      call.on('stream', (remoteStream) => playStream(call.peer, remoteStream));
      call.on('close', () => removeAudio(call.peer));
      call.on('error', () => removeAudio(call.peer));
    });
    peer.on('error', (err) => {
      console.log('PeerJS error:', err && err.type ? err.type : err);
    });
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
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

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      getRoom(room);

      const client = { id, room, nick, inVoice: false, peerId: null, res };
      clients.push(client);
      broadcastUsers(room);

      req.on('close', () => {
        clients = clients.filter(c => c !== client);
        broadcastUsers(room);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const room = safeRoom(url.searchParams.get('room'));
      const channel = safeChannel(url.searchParams.get('channel'));
      const list = (rooms[room] && rooms[room][channel]) ? rooms[room][channel] : [];
      return sendJson(res, 200, list);
    }

    if (req.method === 'GET' && url.pathname === '/api/invite-info') {
      return sendJson(res, 200, { publicUrl: null });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const room = safeRoom(body.room);
      const channel = safeChannel(body.channel);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

      // Ник берём с сервера (по id соединения), чтобы его нельзя было подменить в запросе
      const c = clients.find(x => x.id === body.id);
      const author = c ? c.nick : cleanNick(body.author);

      const now = new Date();
      const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const msg = { author, time, text };

      const list = getRoom(room)[channel];
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);

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
      // Демо-режим: код возвращается на страницу, т.к. реальная отправка почты не настроена
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
        c.nick = nick;
        broadcastUsers(c.room);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req);
      const c = clients.find(x => x.id === body.id);
      if (c) {
        c.inVoice = !!body.inVoice;
        c.peerId = body.peerId ? String(body.peerId).slice(0, 64) : null;
        broadcastUsers(c.room);
        if (c.inVoice && c.peerId) broadcast(c.room, 'voice-join', { peerId: c.peerId });
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
    console.log('❌ Порт ' + PORT + ' уже занят. Закройте другой запущенный сервер и повторите.');
  } else {
    console.log('❌ Ошибка сервера:', err && err.message ? err.message : err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log('⚡ СЕРВЕР ЗАПУЩЕН, порт ' + PORT);
  console.log('====================================================');
});
