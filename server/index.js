const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// State
let sock = null;
let isReady = false;
let botStartTime = 0;
let connectedGroups = [];
let activeGroupId = null;
let spamTracker = {};
let pausedGroups = new Set();
let mutedUsers = new Set();
let noPriceCounter = {};
let noPriceTimers = {};
let reklamMuafMsgIds = new Set();
let deletedAdsLog = [];
let stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
let config = { automation: { welcome: true, noPrice: true, rules: true }, deleteDelay: 60000, ruleIntervalHours: 6, customRuleMessage: null };
let currentQR = null;
let currentPairingCode = null;

const AUTH_DIR = './baileys-auth';
const LOG_FILE = './deleted-ads-log.json';
const CONFIG_FILE = './bot-config.json';

function loadDeletedLog() { try { if (fs.existsSync(LOG_FILE)) deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {} }
function saveDeletedLog() { try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch(e) {} }
function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {} }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch(e) {} }

async function connect(phoneNumber) {
  try {
    loadDeletedLog();
    loadConfig();
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Grup Yonetici', 'Chrome', '131.0.0'],
    });

    // QR veya Pairing Code
    if (!state.creds.registered && phoneNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          currentPairingCode = code;
          io.emit('pairing_code', code);
          console.log('Pairing Code:', code);
        } catch(e) { console.log('Pairing error:', e.message); }
      }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        io.emit('qr', qr);
        console.log('QR code generated');
      }

      if (connection === 'close') {
        isReady = false;
        io.emit('status', { connected: false });
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== 401 && code !== 403) {
          setTimeout(() => connect(), 5000);
        }
      }

      if (connection === 'open') {
        isReady = true;
        currentQR = null;
        currentPairingCode = null;
        botStartTime = Math.floor(Date.now() / 1000);
        io.emit('status', { connected: true });
        loadGroups();
        console.log('WhatsApp connected!');
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      messages.forEach(msg => handleMessage(msg));
    });

    sock.ev.on('group-participants.update', (update) => {
      if (!config.automation.welcome || update.action !== 'add') return;
      handleGroupJoin(update);
    });

  } catch(e) {
    console.error('Connection error:', e.message);
    setTimeout(() => connect(), 10000);
  }
}

async function loadGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    connectedGroups = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
    io.emit('groups', connectedGroups);
  } catch(e) {}
}

async function handleGroupJoin(update) {
  try {
    const meta = await sock.groupMetadata(update.id);
    for (const p of update.participants) {
      const name = p.split('@')[0];
      await sock.sendMessage(update.id, { text: `👋 Hoş geldin *${name}*!\n\nGrubumuza katıldığın için teşekkürler 🎉\n\n📌 *Hatırlatma:*\n• İlan verirken fiyat belirtin\n• Saygılı olalım\n\n_İyi alışverişler!_ 🛒\n🛡️ _${meta.subject} Yönetimi_` });
      stats.welcomesSent++;
      io.emit('log', { type: 'welcome', user: name, group: meta.subject });
    }
  } catch(e) {}
}

async function handleMessage(msg) {
  try {
    if (msg.messageTimestamp && msg.messageTimestamp < botStartTime - 5) return;
    const chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return;
    if (pausedGroups.has(chatId)) return;
    if (activeGroupId && chatId !== activeGroupId) return;

    const isFromMe = msg.key.fromMe;
    let msgText = '';
    if (msg.message) {
      msgText = msg.message.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
    }
    const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);

    if (isFromMe && msgText && (msgText.includes('Grup Yönetimi') || msgText.includes('tespit edildi'))) return;

    const userId = msg.key.participant || msg.key.remoteJid;
    let isAdmin = isFromMe;
    try {
      const meta = await sock.groupMetadata(chatId);
      const p = meta.participants.find(x => x.id === userId);
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
    } catch(e) {}

    if (mutedUsers.has(userId) && !isAdmin) {
      try { await sock.sendMessage(chatId, { delete: msg.key }); } catch(e) {}
      return;
    }

    if (!config.automation.noPrice) return;

    const hasFiyat = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b)/i.test(msgText) ||
      /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i.test(msgText) ||
      ((/\d{5,}/.test(msgText) || /\d{1,3}[\.,]\d{3}/.test(msgText)) && !/km/i.test(msgText));

    if (hasFiyat) return;

    const msgLower = msgText.toLowerCase();
    const soruIfadeleri = ['?', ' mı', ' mi', ' mu', ' mü', 'ne kadar', 'kaça', 'var mı', 'satıldı'];
    if (!hasMedia) {
      if (soruIfadeleri.some(k => msgLower.includes(k))) return;
      const ilanKeywords = ['satılık', 'satilik', 'satıyorum', 'satiyorum', 'takas', 'devren', 'kiralık', 'sahibinden', 'acilen', 'temiz', 'sorunsuz'];
      if (!ilanKeywords.some(k => msgLower.includes(k))) return;
    }

    if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
    const quota = noPriceCounter[userId];
    if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

    let groupName = chatId;
    try { const gm = await sock.groupMetadata(chatId); groupName = gm.subject; } catch(e) {}

    if (quota.warned) {
      await sock.sendMessage(chatId, { delete: msg.key });
      stats.messagesDeleted++;
      io.emit('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
      return;
    }

    quota.warned = true;
    quota.warnedTime = Date.now();
    await sock.sendMessage(chatId, { text: `⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` });

    setTimeout(async () => {
      try { await sock.sendMessage(chatId, { delete: msg.key }); } catch(e) {}
      stats.messagesDeleted++;
      io.emit('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
    }, config.deleteDelay);

  } catch(e) {}
}

// Static dosyalar
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfa - Web Panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API
app.get('/api/status', (req, res) => {
  res.json({ connected: isReady, groups: connectedGroups, stats, config: config.automation, qr: currentQR, pairingCode: currentPairingCode });
});

app.post('/api/connect', (req, res) => {
  const { phoneNumber } = req.body;
  connect(phoneNumber);
  res.json({ success: true });
});

app.get('/api/qr', async (req, res) => {
  if (isReady) return res.json({ connected: true });
  if (currentQR) {
    const qrImage = await QRCode.toDataURL(currentQR);
    return res.json({ connected: false, qr: qrImage });
  }
  res.json({ connected: false, qr: null });
});

app.post('/api/send-rules', async (req, res) => {
  const { groupId } = req.body;
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    const meta = await sock.groupMetadata(groupId);
    await sock.sendMessage(groupId, { text: `📢 *${meta.subject}*\n━━━━━━━━━━━━━━━━\n\n📋 *Grup Kuralları*\n\n• İlanlarınızda mutlaka fiyat belirtin\n• Aynı ilanı tekrar tekrar atmayın\n• Saygılı olalım\n\n⚠️ Kurallara uymayan ilanlar silinecektir.\n\n🛡️ Grup Yönetimi` });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-message', async (req, res) => {
  const { groupId, message } = req.body;
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    await sock.sendMessage(groupId, { text: message });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/set-active-group', (req, res) => {
  activeGroupId = req.body.groupId || null;
  res.json({ success: true });
});

app.post('/api/automation', (req, res) => {
  const { type, enabled } = req.body;
  if (config.automation.hasOwnProperty(type)) { config.automation[type] = enabled; saveConfig(); }
  res.json({ success: true });
});

app.post('/api/mute-member', (req, res) => {
  mutedUsers.add(req.body.memberId);
  res.json({ success: true });
});

app.post('/api/unmute-member', (req, res) => {
  mutedUsers.delete(req.body.memberId);
  res.json({ success: true });
});

app.post('/api/remove-member', async (req, res) => {
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    await sock.groupParticipantsUpdate(req.body.groupId, [req.body.memberId], 'remove');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/close-group', async (req, res) => {
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    await sock.groupSettingUpdate(req.body.groupId, 'announcement');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-group', async (req, res) => {
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    await sock.groupSettingUpdate(req.body.groupId, 'not_announcement');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/members', async (req, res) => {
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    const meta = await sock.groupMetadata(req.query.groupId);
    res.json({ members: meta.participants.map(p => ({ id: p.id, number: p.id.split('@')[0], name: p.id.split('@')[0], isAdmin: p.admin === 'admin' || p.admin === 'superadmin' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pause-group', (req, res) => {
  pausedGroups.add(req.body.groupId);
  res.json({ success: true });
});

app.post('/api/ban-member', async (req, res) => {
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    await sock.groupParticipantsUpdate(req.body.groupId, [req.body.memberId], 'remove');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deleted-ads', (req, res) => {
  res.json({ success: true, count: deletedAdsLog.length, data: deletedAdsLog });
});

app.post('/api/restore-ad', async (req, res) => {
  const { id } = req.body;
  const entry = deletedAdsLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ success: false });
  if (sock && isReady) {
    try { await sock.sendMessage(entry.grupId || entry.groupId, { text: entry.mesaj || entry.message || '(ilan)' }); } catch(e) {}
  }
  deletedAdsLog = deletedAdsLog.filter(e => e.id !== id);
  saveDeletedLog();
  res.json({ success: true });
});

app.post('/api/restore-as-ad', async (req, res) => {
  const { id } = req.body;
  const entry = deletedAdsLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ success: false });
  if (sock && isReady) {
    try {
      const groupId = entry.grupId || entry.groupId;
      await sock.sendMessage(groupId, { text: entry.mesaj || entry.message || '(ilan)' });
      await sock.sendMessage(groupId, { text: 'Bu ilan reklam/hizmet paylaşımıdır.\nReklam ücreti alınmış, onaylanarak yayınlanmıştır.\n\n🛡️ Grup Yönetimi' });
    } catch(e) {}
  }
  deletedAdsLog = deletedAdsLog.filter(e => e.id !== id);
  saveDeletedLog();
  res.json({ success: true });
});

app.post('/api/clear-all-logs', (req, res) => {
  deletedAdsLog = [];
  saveDeletedLog();
  res.json({ success: true });
});

app.post('/api/clear-media-cache', (req, res) => {
  let cleared = 0;
  deletedAdsLog.forEach(e => { if (e.medyaData) { e.medyaData = null; cleared++; } });
  saveDeletedLog();
  res.json({ success: true, cleared });
});

app.post('/api/set-delete-delay', (req, res) => {
  const { delay } = req.body;
  if (delay >= 1 && delay <= 120) { config.deleteDelay = delay * 1000; saveConfig(); }
  res.json({ success: true });
});

app.post('/api/set-rule-interval', (req, res) => {
  const { hours } = req.body;
  if (hours >= 1 && hours <= 24) { config.ruleIntervalHours = hours; saveConfig(); }
  res.json({ success: true });
});

app.post('/api/set-rule-message', (req, res) => {
  config.customRuleMessage = req.body.message || null;
  saveConfig();
  res.json({ success: true });
});

app.post('/api/restart', (req, res) => {
  res.json({ success: true, message: 'Reconnecting...' });
  if (sock) { try { sock.end(); } catch(e) {} }
  setTimeout(() => connect(), 2000);
});

// Socket.IO
io.on('connection', (socket) => {
  socket.emit('status', { connected: isReady, groups: connectedGroups, stats });
  if (currentQR) socket.emit('qr', currentQR);
  if (currentPairingCode) socket.emit('pairing_code', currentPairingCode);
});

// Start
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  connect();
});
