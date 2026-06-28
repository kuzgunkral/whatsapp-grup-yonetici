const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { hasFiyatMi, kural5dkLimit, kural10Limit, kuralFiyatsizResim, kuralFiyatsizMetin } = require('./messageHandler');

let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore;

// ─── DEBUG LOG ────────────────────────────────────────────────────────────────
const debugLog = (() => {
  const LOG_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'debug.log') : './debug.log';
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_PATH, line); } catch(e) {}
  };
})();

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
let contactNames = {};
let lastSentKeys = {};
let reklamMuafMsgIds = new Set();
const groupMessages = {};
let deletedAdsLog = [];
let stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
let config = {
  automation: { welcome: true, noPrice: true, rules: true },
  deleteDelay: 60000,
  ruleIntervalHours: 6,
  customRuleMessage: null,
  photoWaitSec: 30,
  adIntervalMin: 5
};
let currentQR = null;
let currentPairingCode = null;

const AUTH_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'baileys-auth') : './baileys-auth';
const LOG_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'deleted-ads-log.json') : './deleted-ads-log.json';
const CONFIG_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'bot-config.json') : './bot-config.json';
const ACTIVE_GROUP_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'active-group.txt') : './active-group.txt';

// Restart'ta aktif grubu dosyadan oku
try { const saved = fs.readFileSync(ACTIVE_GROUP_FILE, 'utf8').trim(); if (saved) activeGroupId = saved; } catch(e) {}

function loadDeletedLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > 10 * 1024 * 1024) {
        console.log('⚠️ Log dosyası çok büyük, sıfırlanıyor...');
        fs.writeFileSync(LOG_FILE, '[]', 'utf8');
        deletedAdsLog = [];
        return;
      }
      deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (deletedAdsLog.length > 500) {
        deletedAdsLog = deletedAdsLog.slice(0, 500);
        fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8');
      }
    }
  } catch(e) {
    console.error('Log okunamadı:', e.message);
    deletedAdsLog = [];
  }
}
function saveDeletedLog() { try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch(e) {} }
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Shallow alanları merge et, automation nested objesini ayrı merge et
      config = {
        ...config,
        ...saved,
        automation: {
          ...config.automation,
          ...(saved.automation || {})
        }
      };
    }
  } catch(e) { console.error('Config okunamadı:', e.message); }
}
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch(e) {} }

// Startup'ta log ve config yükle
loadDeletedLog();
loadConfig();

async function connect(phoneNumber) {
  try {
    if (!makeWASocket) {
      const baileys = await import('baileys');
      makeWASocket = baileys.makeWASocket;
      useMultiFileAuthState = baileys.useMultiFileAuthState;
      makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    }
    if (sock) {
      try { sock.end(); } catch(e) {}
      sock = null;
    }
    debugLog('connect() called with phone: ' + (phoneNumber || 'none'));
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    debugLog('Auth state loaded, registered: ' + state.creds.registered);
    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: false,
    });
    if (!state.creds.registered && phoneNumber) {
      setTimeout(async () => {
        try {
          debugLog('Requesting pairing code for: ' + phoneNumber);
          const code = await sock.requestPairingCode(phoneNumber);
          currentPairingCode = code;
          io.emit('pairing_code', code);
          debugLog('Pairing Code generated: ' + code);
        } catch(e) { debugLog('Pairing error: ' + e.message); }
      }, 5000);
    } else {
      debugLog('Skipped pairing: registered=' + state.creds.registered + ' phone=' + phoneNumber);
    }
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      debugLog('connection.update: ' + JSON.stringify({ connection, qr: !!qr, lastDisconnect: lastDisconnect?.error?.message }));
      if (qr) {
        currentQR = qr;
        io.emit('qr', qr);
        debugLog('QR code generated');
      }
      if (connection === 'close') {
        isReady = false;
        io.emit('status', { connected: false });
        const code = lastDisconnect?.error?.output?.statusCode;
        debugLog('Connection closed, statusCode: ' + code);
        if (code !== 401 && code !== 403 && code !== 405) {
          setTimeout(() => connect(phoneNumber), 5000);
        } else {
          debugLog('Not reconnecting due to status: ' + code);
        }
      }
      if (connection === 'open') {
        isReady = true;
        currentQR = null;
        currentPairingCode = null;
        botStartTime = Math.floor(Date.now() / 1000);
        io.emit('status', { connected: true });
        loadGroups();
        debugLog('WhatsApp connected!');
      }
    });
    sock.ev.on('messages.upsert', (m) => {
      debugLog('messages.upsert received: ' + (m.messages ? m.messages.length : 0) + ' msgs, type: ' + m.type);
      if (m.type !== 'notify') return;
      m.messages.forEach(msg => {
        if (msg.messageStubType === 27 || msg.messageStubType === 'GROUP_PARTICIPANT_ADD') {
          if (config.automation.welcome && msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
            const participants = msg.messageStubParameters || [];
            if (participants.length > 0) {
              debugLog('Detected group join via messageStub: ' + JSON.stringify(participants));
              handleGroupJoin({ id: msg.key.remoteJid, participants, action: 'add' });
            }
          }
          return;
        }
        handleMessage(msg);
      });
    });
    sock.ev.on('group-participants.update', (update) => {
      debugLog('group-participants.update: action=' + update.action + ' group=' + update.id + ' participants=' + JSON.stringify(update.participants));
      if (!config.automation.welcome) { debugLog('Welcome disabled, skipping'); return; }
      if (update.action !== 'add') return;
      if (activeGroupId && update.id !== activeGroupId) { debugLog('Welcome skipped: not active group'); return; }
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
    if (!activeGroupId || update.id !== activeGroupId) return;
    debugLog('handleGroupJoin: sending welcome to ' + update.id);
    const meta = await sock.groupMetadata(update.id);
    for (const p of update.participants) {
      const participantId = typeof p === 'string' ? p : (p.id || p.phoneNumber || String(p));
      let mentionId = participantId;
      if (typeof p === 'object' && p.phoneNumber) {
        mentionId = p.phoneNumber;
      }
      let name = mentionId.split('@')[0];
      try {
        const participant = meta.participants.find(x => x.id === participantId || x.id === mentionId);
        if (participant && participant.notify) name = participant.notify;
      } catch(e) {}
      const welcomeMsg =
        `╔══════════════════════╗\n` +
        `║   👋 HOŞ GELDİN!   ║\n` +
        `╚══════════════════════╝\n\n` +
        `Merhaba @${mentionId.split('@')[0]} 🎉\n\n` +
        `*${meta.subject}* grubuna hoş geldin!\n\n` +
        `📌 *Grup Kuralları:*\n` +
        `• İlanlarında mutlaka fiyat belirt\n` +
        `• Aynı ilanı tekrar tekrar atma\n` +
        `• Saygılı ol\n` +
        `• Konu dışı paylaşım yapma\n\n` +
        `⚠️ Kurallara uymayan ilanlar silinir.\n\n` +
        `_İyi alışverişler!_ 🛒\n` +
        `🛡️ _${meta.subject} Yönetimi_`;
      await sock.sendMessage(update.id, { text: welcomeMsg, mentions: [mentionId] });
      stats.welcomesSent++;
      io.emit('log', { type: 'welcome', user: name, group: meta.subject });
      debugLog('Welcome sent to: ' + name + ' in ' + meta.subject);
    }
  } catch(e) {
    debugLog('handleGroupJoin ERROR: ' + e.message);
  }
}

function getDeleteKey(msg) {
  const key = { ...msg.key };
  if (key.remoteJid && key.remoteJid.endsWith('@g.us')) {
    if (!key.participant) {
      key.participant = msg.key.participant || msg.participant || msg.author || undefined;
    }
  }
  return key;
}

async function downloadMediaMessage(msg) {
  try {
    if (!msg.message) return null;
    const { downloadMediaMessage } = await import('baileys');
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (buffer) {
      const base64 = buffer.toString('base64');
      let mimetype = 'image/jpeg';
      if (msg.message.imageMessage) mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
      else if (msg.message.videoMessage) mimetype = msg.message.videoMessage.mimetype || 'video/mp4';
      else if (msg.message.documentMessage) mimetype = msg.message.documentMessage.mimetype || 'application/octet-stream';
      return { data: base64, mimetype };
    }
  } catch(e) { debugLog('downloadMedia error: ' + e.message); }
  return null;
}

// ─── MESAJ İŞLEME (modüler kurallar) ─────────────────────────────────────────
async function handleMessage(msg) {
  try {
    if (msg.messageTimestamp && msg.messageTimestamp < botStartTime - 5) return;
    const chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return;
    if (pausedGroups.has(chatId)) return;
    // Aktif grup seçili değilse veya bu mesaj aktif gruptan değilse işleme
    if (!activeGroupId || chatId !== activeGroupId) return;
    debugLog('handleMsg: chatId=' + chatId + ' activeGroupId=' + activeGroupId);

    const isFromMe = msg.key.fromMe;

    // Mesajı cache'e ekle
    if (!isFromMe) {
      if (!groupMessages[chatId]) groupMessages[chatId] = [];
      groupMessages[chatId].push(msg);
      if (groupMessages[chatId].length > 500) groupMessages[chatId].shift();
    }

    let msgText = '';
    if (msg.message) {
      msgText = msg.message.conversation || msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
    }
    const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage ||
      msg.message?.documentMessage || msg.message?.documentWithCaptionMessage ||
      msg.message?.stickerMessage || msg.message?.audioMessage ||
      msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2);

    // Bot mesajlarını atla
    if (isFromMe && msgText && (msgText.includes('Grup Yönetimi') || msgText.includes('tespit edildi') || msgText.includes('susturulm') || msgText.includes('━━━'))) return;
    if (isFromMe && msgText && (msgText.includes('Bu ilan reklam') || msgText.includes('Reklam ücreti') || msgText.includes('Geri Yüklenen'))) return;

    const userId = msg.key.participant || msg.key.remoteJid;
    let isAdmin = isFromMe;
    let groupName = chatId;
    let userName = msg.pushName || '';
    let userPhone = '';
    let realUserId = userId;

    try {
      const meta = await sock.groupMetadata(chatId);
      groupName = meta.subject;
      const p = meta.participants.find(x => x.id === userId);
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
      if (userId.includes('@lid')) {
        if (p && p.phoneNumber && p.phoneNumber.includes('@')) {
          userPhone = p.phoneNumber.split('@')[0];
          realUserId = p.phoneNumber;
        } else {
          userPhone = userName || userId.split('@')[0];
        }
      } else {
        userPhone = userId.split('@')[0];
        realUserId = userId;
      }
    } catch(e) {
      userPhone = userId.split('@')[0];
      // groupMetadata başarısız olduysa chatId'yi temizle
      if (groupName === chatId) groupName = 'Bilinmeyen Grup';
    }
    if (!userName) userName = userPhone;

    // pushName kaydet
    if (msg.pushName && userId) {
      contactNames[userId] = msg.pushName;
      if (realUserId && realUserId !== userId) contactNames[realUserId] = msg.pushName;
    }

    // Susturulan üye
    if (mutedUsers.has(userId)) {
      try { await sock.sendMessage(chatId, { delete: getDeleteKey(msg) }); } catch(e) {}
      return;
    }

    // Admin reklam onayı
    if (isAdmin && msgText) {
      const reklamKelimeleri = ['bu ilan reklam', 'reklam ücreti', 'ücretli reklam', 'sponsor', 'ücreti alınmıştır', 'ücretli ilan', 'onaylı ilan', 'onaylanarak yayınlanmıştır'];
      if (reklamKelimeleri.some(kw => msgText.toLowerCase().includes(kw))) {
        Object.keys(spamTracker).forEach(uid => {
          if (!spamTracker[uid].hasPaid && spamTracker[uid].lastTime && (Date.now() - spamTracker[uid].lastTime < 35000)) {
            spamTracker[uid].hasPaid = true;
          }
        });
        return;
      }
    }

    if (!config.automation.noPrice) return;

    const msgLower = msgText.toLowerCase();
    const hasFiyat = hasFiyatMi(msgText);

    // ── KURAL: Toplu resim işleme ──
    if (hasMedia) {
      const ctx = { sock, chatId, realUserId, groupName, msg, userId, msgText, hasFiyat, spamTracker, stats, getDeleteKey, config, deletedAdsLog, saveDeletedLog, io, downloadMediaMessage };

      // 1. 5dk limit
      const res5dk = await kural5dkLimit(ctx);
      if (res5dk === 'deleted') return;
      // res5dk === 'new_period' veya 'continue' → devam

      // 2. Fiyatlı resim ise (caption'da fiyat var) → kural10 kontrol et, koru
      if (hasFiyat) {
        const res10 = await kural10Limit({ ...ctx, spamTracker });
        if (res10 === 'deleted') return;
        return; // Fiyatlı resim → koru
      }

      // 3. Aynı fiyatlı toplu ilanın caption'sız resimleri (30sn, hasPaid aktif) → koru
      const trk = spamTracker[userId];
      if (trk && trk.hasPaid && trk.firstAdTime > 0 && (Date.now() - trk.firstAdTime < 30000)) {
        const res10d = await kural10Limit({ ...ctx, spamTracker });
        if (res10d === 'deleted') return;
        return; // Toplu fiyatlı ilanın parçası → koru
      }

      // 4. Fiyatsız resim → 30sn bekle
      await kuralFiyatsizResim({
        sock, chatId, msg, userId, userName, userPhone, groupName, msgText, spamTracker,
        stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config
      });
      return;
    }

    // ── Fiyatlı metin → geç ──
    if (hasFiyat) return;

    // ── Soru/sohbet filtresi ──
    const soruIfadeleri = ['?', ' mı', ' mi', ' mu', ' mü', 'hala ', 'halen ', 'satıldı', 'satildi', 'ne kadar', 'kaça', 'kaca', 'fiyat ne', 'fiyatı ne', 'almak istiyorum', 'arıyorum', 'ariyorum', 'alıcı', 'alici', 'bakıyorum', 'bakiyorum', 'ilgilenirim', 'var mı', 'varmı', 'ister misin', 'olur mu', 'nerede', 'nerden', 'tavsiye', 'öneri'];
    const sohbetIfadeleri = ['bende var', 'bende bi', 'verelim', 'vereyim', 'gondereyim', 'atayım', 'atıyorum'];
    if (!hasMedia) {
      if (soruIfadeleri.some(kw => msgLower.includes(kw))) return;
      if (sohbetIfadeleri.some(kw => msgLower.includes(kw))) return;
      const ilanKeywords = ['satılık', 'satilik', 'satlık', 'satlik', 'satıyorum', 'satiyorum', 'satılır', 'satilir', 'satlır', 'satlir', 'satis', 'satış', 'takas', 'devren', 'kiralık', 'kiralik', 'verilir', 'sahibinden', 'acilen', 'temiz', 'sorunsuz', 'ikinci el', 'ikinciel', '2.el', 'sıfır gibi', 'sifir gibi', 'az kullanılmış', 'az kullanilmis'];
      if (!ilanKeywords.some(kw => msgLower.includes(kw))) return;
    }

    // ── Özelden fiyat filtresi ──
    const ozeldenIfadeler = ['özelden yaz', 'özelden', 'dm', 'özel mesaj', 'özele gel', 'fiyat özelden', 'fiyat dm', 'fiyat özel', 'özelim'];
    if (ozeldenIfadeler.some(kw => msgLower.includes(kw)) && !hasMedia) {
      await sock.sendMessage(chatId, { text: `⚠️ Fiyatı grupta belirtin! Özelden fiyat vermek yasaktır.\n🛡️ _${groupName} Yönetimi_` });
      return;
    }

    // ── KURAL: Fiyatsız metin ilanı ──
    await kuralFiyatsizMetin({
      sock, chatId, realUserId, groupName, msg, userId, userName, userPhone, msgText, hasMedia,
      noPriceCounter, deletedAdsLog, saveDeletedLog, io, stats, getDeleteKey, downloadMediaMessage,
      reklamMuafMsgIds, config
    });

  } catch(e) { debugLog('handleMessage error: ' + e.message); }
}

// ─── RULE INTERVAL ────────────────────────────────────────────────────────────
let ruleTimer = null;
function scheduleRuleReminder() {
  if (ruleTimer) clearInterval(ruleTimer);
  const ms = (config.ruleIntervalHours || 6) * 60 * 60 * 1000;
  ruleTimer = setInterval(async () => {
    if (!isReady || !activeGroupId || !config.automation.rules) return;
    try {
      const msg = config.customRuleMessage ||
        `📋 *GRUP KURALLARI*\n\n` +
        `• İlanlarınıza mutlaka fiyat yazınız\n` +
        `• ${config.adIntervalMin || 5} dakikada 1 ilan atabilirsiniz\n` +
        `• Tek seferde en fazla 10 resim\n` +
        `• Konu dışı mesaj atmayınız\n\n` +
        `⚠️ Kurallara uymayan ilanlar otomatik silinir.\n🛡️ _Grup Yönetimi_`;
      await sock.sendMessage(activeGroupId, { text: msg });
      stats.rulesReminded++;
      io.emit('log', { type: 'rules', group: activeGroupId });
    } catch(e) {}
  }, ms);
}

// ─── EXPRESS STATIC ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: STATUS ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    connected: isReady,
    groups: connectedGroups,
    activeGroupId,
    stats,
    config,
    pairedPhone: isReady && sock?.authState?.creds?.me?.id ? sock.authState.creds.me.id.split(':')[0] : null
  });
});

// ─── API: CONNECT ─────────────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    await connect(phoneNumber);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── API: DEBUG LOG ───────────────────────────────────────────────────────────
app.get('/api/debug-log', (req, res) => {
  try {
    const LOG_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'debug.log') : './debug.log';
    if (fs.existsSync(LOG_PATH)) {
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      res.json({ lines: lines.slice(-200) });
    } else {
      res.json({ lines: [] });
    }
  } catch(e) { res.json({ lines: [] }); }
});

app.delete('/api/debug-log', (req, res) => {
  try {
    const LOG_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'debug.log') : './debug.log';
    fs.writeFileSync(LOG_PATH, '', 'utf8');
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// ─── API: QR ──────────────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  if (!currentQR) return res.json({ qr: null, pairingCode: currentPairingCode || null });
  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR);
    res.json({ qr: qrDataUrl, pairingCode: currentPairingCode || null });
  } catch(e) { res.json({ qr: null, pairingCode: null }); }
});

// ─── API: SET ACTIVE GROUP ────────────────────────────────────────────────────
app.post('/api/set-active-group', (req, res) => {
  const { groupId } = req.body;
  activeGroupId = groupId || null;
  try { fs.writeFileSync(ACTIVE_GROUP_FILE, activeGroupId || '', 'utf8'); } catch(e) {}
  io.emit('active_group', activeGroupId);
  res.json({ success: true, activeGroupId });
});

// ─── API: SEND RULES ──────────────────────────────────────────────────────────
app.post('/api/send-rules', async (req, res) => {
  if (!isReady || !activeGroupId) return res.json({ success: false, error: 'Bağlı değil veya grup seçili değil' });
  try {
    const msg = config.customRuleMessage ||
      `📋 *GRUP KURALLARI*\n\n` +
      `• İlanlarınıza mutlaka fiyat yazınız\n` +
      `• ${config.adIntervalMin || 5} dakikada 1 ilan atabilirsiniz\n` +
      `• Tek seferde en fazla 10 resim\n` +
      `• Konu dışı mesaj atmayınız\n\n` +
      `⚠️ Kurallara uymayan ilanlar otomatik silinir.\n🛡️ _Grup Yönetimi_`;
    await sock.sendMessage(activeGroupId, { text: msg });
    stats.rulesReminded++;
    io.emit('log', { type: 'rules', group: activeGroupId });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: SEND MESSAGE ────────────────────────────────────────────────────────
app.post('/api/send-message', async (req, res) => {
  const { groupId, message } = req.body;
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  try {
    const target = groupId || activeGroupId;
    if (!target) return res.json({ success: false, error: 'Hedef grup yok' });
    await sock.sendMessage(target, { text: message });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: SEND ANNOUNCEMENT ──────────────────────────────────────────────────
app.post('/api/send-announcement', async (req, res) => {
  const { message, groupIds } = req.body;
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  try {
    const targets = groupIds && groupIds.length > 0 ? groupIds : (activeGroupId ? [activeGroupId] : []);
    if (targets.length === 0) return res.json({ success: false, error: 'Hedef grup yok' });
    for (const gid of targets) {
      await sock.sendMessage(gid, { text: message });
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ success: true, sent: targets.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: CLEAN NO PRICE ─────────────────────────────────────────────────────
app.post('/api/clean-no-price', async (req, res) => {
  if (!isReady || !activeGroupId) return res.json({ success: false });
  const msgs = groupMessages[activeGroupId] || [];
  let deleted = 0;
  for (const m of msgs) {
    try {
      let text = m.message?.conversation || m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '';
      if (!hasFiyatMi(text)) {
        await sock.sendMessage(activeGroupId, { delete: getDeleteKey(m) });
        deleted++;
        stats.messagesDeleted++;
        await new Promise(r => setTimeout(r, 200));
      }
    } catch(e) {}
  }
  groupMessages[activeGroupId] = [];
  res.json({ success: true, deleted, count: deleted });
});

// ─── API: AUTOMATION ──────────────────────────────────────────────────────────
app.post('/api/automation', (req, res) => {
  const { type, value, enabled } = req.body;
  const newVal = (value !== undefined) ? value : enabled; // her ikisini de kabul et
  if (type && config.automation.hasOwnProperty(type)) {
    config.automation[type] = !!newVal;
    saveConfig();
    io.emit('config', config);
    res.json({ success: true, config });
  } else {
    res.json({ success: false, error: 'Geçersiz tür' });
  }
});

// ─── API: MUTE / UNMUTE MEMBER ───────────────────────────────────────────────
app.post('/api/mute-member', (req, res) => {
  const memberId = req.body.memberId || req.body.userId;
  if (!memberId) return res.json({ success: false, error: 'memberId gerekli' });
  const isMuted = mutedUsers.has(memberId);
  if (isMuted) {
    mutedUsers.delete(memberId);
    res.json({ success: true, muted: false });
  } else {
    mutedUsers.add(memberId);
    res.json({ success: true, muted: true });
  }
});

app.post('/api/unmute-member', (req, res) => {
  const memberId = req.body.memberId || req.body.userId;
  if (memberId) mutedUsers.delete(memberId);
  res.json({ success: true });
});

// ─── API: REMOVE / BAN MEMBER ────────────────────────────────────────────────
app.post('/api/remove-member', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  const memberId = req.body.memberId || req.body.userId;
  if (!groupId || !memberId) return res.json({ success: false, error: 'groupId ve memberId gerekli' });
  try {
    await sock.groupParticipantsUpdate(groupId, [memberId], 'remove');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/ban-member', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  const memberId = req.body.memberId || req.body.userId;
  if (!groupId || !memberId) return res.json({ success: false, error: 'groupId ve memberId gerekli' });
  try {
    await sock.groupParticipantsUpdate(groupId, [memberId], 'remove');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: CLOSE / OPEN GROUP ─────────────────────────────────────────────────
app.post('/api/close-group', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  if (!groupId) return res.json({ success: false, error: 'Grup yok' });
  try {
    await sock.groupSettingUpdate(groupId, 'announcement');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/open-group', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  if (!groupId) return res.json({ success: false, error: 'Grup yok' });
  try {
    await sock.groupSettingUpdate(groupId, 'not_announcement');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: PAUSE GROUP (toggle) ────────────────────────────────────────────────
app.post('/api/pause-group', (req, res) => {
  const groupId = req.body.groupId || activeGroupId;
  if (!groupId) return res.json({ success: false, error: 'Grup yok' });
  if (pausedGroups.has(groupId)) {
    pausedGroups.delete(groupId);
    res.json({ success: true, paused: false });
  } else {
    pausedGroups.add(groupId);
    res.json({ success: true, paused: true });
  }
});

// ─── API: SET GROUP DESCRIPTION ──────────────────────────────────────────────
app.post('/api/set-group-description', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  const { description } = req.body;
  if (!groupId) return res.json({ success: false, error: 'Grup yok' });
  try {
    await sock.groupUpdateDescription(groupId, description || '');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: PIN MESSAGE ─────────────────────────────────────────────────────────
app.post('/api/pin-message', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  const { messageId } = req.body;
  if (!groupId || !messageId) return res.json({ success: false, error: 'groupId ve messageId gerekli' });
  try {
    await sock.sendMessage(groupId, { pin: { type: 1, time: 604800 } }, { quoted: { key: { id: messageId, remoteJid: groupId } } });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: GET RULE MESSAGE ────────────────────────────────────────────────────
app.get('/api/get-rule-message', (req, res) => {
  res.json({ message: config.customRuleMessage || null });
});

// ─── API: CLEAR MEDIA CACHE ───────────────────────────────────────────────────
app.post('/api/clear-media-cache', (req, res) => {
  let cleared = 0;
  deletedAdsLog.forEach(e => {
    if (e.medyaData) { e.medyaData = null; cleared++; }
    if (e.medyaListesi) { e.medyaListesi.forEach(m => { m.data = null; }); }
  });
  saveDeletedLog();
  res.json({ success: true, cleared });
});

// ─── API: DELETED ADS ─────────────────────────────────────────────────────────
app.get('/api/deleted-ads', (req, res) => {
  res.json({ data: deletedAdsLog, total: deletedAdsLog.length });
});

// Tekil log silme
app.delete('/api/deleted-ads/:id', (req, res) => {
  const id = req.params.id;
  const before = deletedAdsLog.length;
  deletedAdsLog = deletedAdsLog.filter(a => a.id !== id);
  if (deletedAdsLog.length !== before) saveDeletedLog();
  res.json({ success: true });
});

// Tümünü sil
app.delete('/api/deleted-ads', (req, res) => {
  deletedAdsLog = [];
  saveDeletedLog();
  res.json({ success: true });
});

// clear-all-logs alias
app.post('/api/clear-all-logs', (req, res) => {
  deletedAdsLog = [];
  saveDeletedLog();
  res.json({ success: true });
});

// ─── RESTORE QUEUE (sıralı gönderim, çakışma önleme) ─────────────────────────
let restoreQueue = Promise.resolve();

// ─── API: RESTORE AD ─────────────────────────────────────────────────────────
app.post('/api/restore-ad', async (req, res) => {
  const { adId, id, groupId } = req.body;
  const lookupId = adId || id;
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const ad = deletedAdsLog.find(a => a.id === lookupId);
  if (!ad) return res.json({ success: false, error: 'İlan bulunamadı' });
  const target = groupId || activeGroupId;
  if (!target) return res.json({ success: false, error: 'Hedef grup yok' });

  // Sıralı kuyruk — eş zamanlı restore'lar çakışmasın
  let result = { success: false, error: 'Bilinmeyen hata' };
  restoreQueue = restoreQueue.then(async () => {
    try {
      const validMedia = (ad.medyaListesi || []).filter(m => m && m.data);
      if (validMedia.length > 0) {
        for (let i = 0; i < validMedia.length; i++) {
          const buf = Buffer.from(validMedia[i].data, 'base64');
          await sock.sendMessage(target, { image: buf, caption: '' });
          if (i < validMedia.length - 1) await new Promise(r => setTimeout(r, 150));
        }
      } else if (ad.medyaData) {
        const buf = Buffer.from(ad.medyaData, 'base64');
        const isVideo = ad.medyaMimetype && ad.medyaMimetype.startsWith('video');
        await sock.sendMessage(target, isVideo ? { video: buf, caption: '' } : { image: buf, caption: '' });
      } else if (ad.mesaj) {
        await sock.sendMessage(target, { text: ad.mesaj });
      } else {
        result = { success: false, error: 'Geri yüklenecek içerik yok' };
        return;
      }
      deletedAdsLog = deletedAdsLog.filter(a => a.id !== lookupId);
      saveDeletedLog();
      result = { success: true };
    } catch(e) { result = { success: false, error: e.message }; }
  });
  await restoreQueue;
  res.json(result);
});

// ─── API: RESTORE AS AD ──────────────────────────────────────────────────────
app.post('/api/restore-as-ad', async (req, res) => {
  const { adId, id, groupId } = req.body;
  const lookupId = adId || id;
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const ad = deletedAdsLog.find(a => a.id === lookupId);
  if (!ad) return res.json({ success: false, error: 'İlan bulunamadı' });
  try {
    const target = groupId || activeGroupId;
    if (!target) return res.json({ success: false, error: 'Hedef grup yok' });
    if (ad.medyaListesi && ad.medyaListesi.length > 0) {
      // Caption yok — sade resim gönder, delay yok
      for (let i = 0; i < ad.medyaListesi.length; i++) {
        const m = ad.medyaListesi[i];
        if (!m || !m.data) continue;
        const buf = Buffer.from(m.data, 'base64');
        await sock.sendMessage(target, { image: buf, caption: '' });
      }
    } else if (ad.medyaData) {
      const buf = Buffer.from(ad.medyaData, 'base64');
      await sock.sendMessage(target, { image: buf, caption: '' });
    } else if (ad.mesaj) {
      await sock.sendMessage(target, { text: ad.mesaj });
    }
    // Reklam olarak yüklenen logu listeden kaldır
    deletedAdsLog = deletedAdsLog.filter(a => a.id !== lookupId);
    saveDeletedLog();
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: SET DELETE DELAY ────────────────────────────────────────────────────
app.post('/api/set-delete-delay', (req, res) => {
  const { delay } = req.body;
  config.deleteDelay = parseInt(delay) || 60000;
  saveConfig();
  io.emit('config', config);
  res.json({ success: true, deleteDelay: config.deleteDelay });
});

// ─── API: SET RULE INTERVAL ───────────────────────────────────────────────────
app.post('/api/set-rule-interval', (req, res) => {
  const { hours } = req.body;
  config.ruleIntervalHours = parseFloat(hours) || 6;
  saveConfig();
  scheduleRuleReminder();
  io.emit('config', config);
  res.json({ success: true, ruleIntervalHours: config.ruleIntervalHours });
});

// ─── API: SET RULE MESSAGE ────────────────────────────────────────────────────
app.post('/api/set-rule-message', (req, res) => {
  const { message } = req.body;
  config.customRuleMessage = message || null;
  saveConfig();
  io.emit('config', config);
  res.json({ success: true });
});

// ─── API: SET PHOTO WAIT ──────────────────────────────────────────────────────
app.post('/api/set-photo-wait', (req, res) => {
  const { seconds } = req.body;
  config.photoWaitSec = parseInt(seconds) || 30;
  saveConfig();
  io.emit('config', config);
  res.json({ success: true, photoWaitSec: config.photoWaitSec });
});

// ─── API: SET AD INTERVAL ─────────────────────────────────────────────────────
app.post('/api/set-ad-interval', (req, res) => {
  const { minutes } = req.body;
  config.adIntervalMin = parseFloat(minutes) || 5;
  saveConfig();
  io.emit('config', config);
  res.json({ success: true, adIntervalMin: config.adIntervalMin });
});

// ─── API: SETTINGS ────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    deleteDelay: config.deleteDelay,
    ruleIntervalHours: config.ruleIntervalHours,
    customRuleMessage: config.customRuleMessage,
    automation: config.automation,
    photoWaitSec: config.photoWaitSec,
    adIntervalMin: config.adIntervalMin
  });
});

// ─── API: MEMBERS ─────────────────────────────────────────────────────────────
app.get('/api/members', async (req, res) => {
  const groupId = req.query.groupId || activeGroupId;
  if (!isReady || !groupId) return res.json({ members: [] });
  try {
    const meta = await sock.groupMetadata(groupId);
    const members = meta.participants.map(p => {
      const phone = p.id.includes('@lid')
        ? (p.phoneNumber ? p.phoneNumber.split('@')[0] : p.id.split('@')[0])
        : p.id.split('@')[0];
      const name = contactNames[p.id] || contactNames[p.phoneNumber] || p.notify || null;
      return {
        id: p.id,
        number: phone,
        name: name || phone,
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        isMuted: mutedUsers.has(p.id)
      };
    });
    members.sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      return (a.name || a.number).localeCompare(b.name || b.number, 'tr');
    });
    res.json({ members, total: members.length });
  } catch(e) { res.json({ members: [], error: e.message }); }
});

// ─── API: RESTART ─────────────────────────────────────────────────────────────
app.post('/api/restart', async (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(0), 500);
});

// ─── API: LOGOUT ──────────────────────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) { try { await sock.logout(); } catch(e) {} sock = null; }
    isReady = false;
    // Auth dizinini temizle
    try {
      const files = fs.readdirSync(AUTH_DIR);
      files.forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
    } catch(e) {}
    io.emit('status', { connected: false });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── API: GROUPS ─────────────────────────────────────────────────────────────
app.get('/api/groups', async (req, res) => {
  if (!isReady) return res.json([]);
  try {
    await loadGroups();
    res.json(connectedGroups);
  } catch(e) { res.json([]); }
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  debugLog('Socket.IO client connected: ' + socket.id);
  socket.emit('status', { connected: isReady });
  socket.emit('groups', connectedGroups);
  if (activeGroupId) socket.emit('active_group', activeGroupId);
  socket.emit('config', config);
  socket.emit('stats', stats);
});

// Stats broadcast her 10 saniyede bir
setInterval(() => { io.emit('stats', stats); }, 10000);

// ─── SERVER START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server ${PORT} portunda çalışıyor`);
  // loadDeletedLog() ve loadConfig() startup'ta (satır 90-91) zaten çağrıldı
  scheduleRuleReminder();
  connect().catch(e => console.error('Initial connect error:', e.message));
});
