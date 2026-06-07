const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore;

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
// Restart'ta aktif grubu dosyadan oku
try { const saved = fs.readFileSync(ACTIVE_GROUP_FILE, 'utf8').trim(); if (saved) activeGroupId = saved; } catch(e) {}
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

const AUTH_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'baileys-auth') : './baileys-auth';
const LOG_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'deleted-ads-log.json') : './deleted-ads-log.json';
const CONFIG_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'bot-config.json') : './bot-config.json';
const ACTIVE_GROUP_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'active-group.txt') : './active-group.txt';

function loadDeletedLog() { try { if (fs.existsSync(LOG_FILE)) deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {} }
function saveDeletedLog() { try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch(e) {} }
function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {} }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch(e) {} }

async function connect(phoneNumber) {
  try {
    // Baileys'i dynamic import et (ESM modül)
    if (!makeWASocket) {
      const baileys = await import('baileys');
      makeWASocket = baileys.makeWASocket;
      useMultiFileAuthState = baileys.useMultiFileAuthState;
      makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    }

    // Eski bağlantıyı kapat
    if (sock) {
      try { sock.end(); } catch(e) {}
      sock = null;
    }

    debugLog('connect() called with phone: ' + (phoneNumber || 'none'));

    loadDeletedLog();
    loadConfig();
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

    debugLog('Socket created, requesting pairing code...');

    // QR veya Pairing Code
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
        // 405 = IP blocked, 401/403 = auth error - reconnect etme
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
      m.messages.forEach(msg => handleMessage(msg));
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

    // Bot'un kendi mesajlarını atla
    if (isFromMe && msgText && (msgText.includes('Grup Yönetimi') || msgText.includes('tespit edildi') || msgText.includes('susturulm') || msgText.includes('━━━'))) return;
    if (isFromMe && msgText && (msgText.includes('Bu ilan reklam') || msgText.includes('Reklam ücreti') || msgText.includes('Geri Yüklenen'))) return;

    const userId = msg.key.participant || msg.key.remoteJid;
    let isAdmin = isFromMe;
    let groupName = chatId;
    try {
      const meta = await sock.groupMetadata(chatId);
      groupName = meta.subject;
      const p = meta.participants.find(x => x.id === userId);
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
    } catch(e) {}

    // Susturulan üye kontrolü
    if (mutedUsers.has(userId) && !isAdmin) {
      try { await sock.sendMessage(chatId, { delete: msg.key }); } catch(e) {}
      return;
    }

    // Adminler muaf (GEÇİCİ KAPALI - TEST İÇİN)
    // if (isAdmin) return;

    // Admin reklam onayı: admin belirli kelimeleri yazarsa son fiyatsız mesajı muaf et
    if (isAdmin && msgText) {
      const reklamKelimeleri = ['bu ilan reklam', 'reklam ücreti', 'ücretli reklam', 'sponsor', 'ücreti alınmıştır', 'ücretli ilan', 'onaylı ilan', 'onaylanarak yayınlanmıştır'];
      if (reklamKelimeleri.some(kw => msgText.toLowerCase().includes(kw))) {
        // Son fiyatsız mesajları muaf et
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

    // === FIYAT ALGILAMA ===
    const hasFiyat = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b|son\b)/i.test(msgText) ||
      /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i.test(msgText) ||
      /\d{1,3}([.,]\d{3})+([.,]\d{2})?/.test(msgText) ||
      ((/\d{4,}/.test(msgText) || /\d{1,3}[\.,]\d{3}/.test(msgText)) && !/km/i.test(msgText) && !/model/i.test(msgText) && !/kilometre/i.test(msgText) && !/\d{4,}\s*da\b/i.test(msgText) && !/\d{4,}\s*de\b/i.test(msgText));

    // === TOPLU RESİM + 1DK KURAL ===
    if (hasMedia) {
      if (!spamTracker[userId]) spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, hasPaid: false, paidTime: 0, ozelUyari: false, firstAdTime: 0, adCount: 0 };
      const now = Date.now();
      
      // 1dk'dan fazla geçtiyse yeni dönem
      if (now - spamTracker[userId].firstAdTime > 60000) {
        spamTracker[userId].count = 0;
        spamTracker[userId].warned10 = false;
        spamTracker[userId].hasPaid = false;
        spamTracker[userId].ozelUyari = false;
        spamTracker[userId].adCount = 0;
      }
      
      spamTracker[userId].count++;
      spamTracker[userId].lastTime = now;

      // Fiyat varsa hasPaid işaretle
      if (hasFiyat) { spamTracker[userId].hasPaid = true; spamTracker[userId].paidTime = Date.now(); }

      // İlk ilan mı yoksa 2. ilan mı?
      // İlk ilan: firstAdTime 0 ise veya 1dk geçtiyse
      if (spamTracker[userId].adCount === 0) {
        spamTracker[userId].adCount = 1;
        spamTracker[userId].firstAdTime = now;
      }
      
      // 5sn içinde gelenler aynı toplu ilan (ilk ilanın parçası)
      const isPartOfFirst = (now - spamTracker[userId].firstAdTime < 5000);
      
      // 2. ilan (5sn'den sonra, 1dk'dan önce gelen) → sil + DM 1 kere
      if (!isPartOfFirst && (now - spamTracker[userId].firstAdTime < 60000) && spamTracker[userId].adCount >= 1) {
        spamTracker[userId].adCount++;
        if (!spamTracker[userId].ozelUyari) {
          spamTracker[userId].ozelUyari = true;
          try { await sock.sendMessage(userId, { text: `⚠️ 1 dakikada 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _Grup Yönetimi_` }); } catch(e) {}
        }
        const delKey = msg.key;
        const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        return;
      }

      // İlk ilanın parçası - 10 limit kontrolü
      if (spamTracker[userId].count > 10) {
        if (!spamTracker[userId].warned10) {
          spamTracker[userId].warned10 = true;
          try { await sock.sendMessage(chatId, { text: `⚠️ 10 adetten fazla resim yüklenemez.\n🛡️ _Grup Yönetimi_` }); } catch(e) {}
        }
        const delKey = msg.key;
        const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        return;
      }

      // Fiyatlı (toplu dahil) → geç
      if (spamTracker[userId].hasPaid) return;

      // Fiyatsız resim → 30sn bekle (fiyat geç gelebilir, admin reklam yazabilir)
      const delKey = msg.key;
      const delUserId = userId;
      const delMsgId = msg.key.id;
      setTimeout(() => {
        // 30sn sonra: fiyat gelmiş mi veya reklam muafiyeti var mı kontrol et
        if (spamTracker[delUserId] && spamTracker[delUserId].hasPaid) return;
        if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
        const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
      }, 30000);
      stats.messagesDeleted++;
      return;
    }

    // === FIYAT VARSA (medyasız) → geç ===
    if (hasFiyat) return;

    // === SORU / SOHBET FİLTRESİ ===
    const soruIfadeleri = ['?', ' mı', ' mi', ' mu', ' mü', 'hala ', 'halen ', 'satıldı', 'satildi', 'ne kadar', 'kaça', 'kaca', 'fiyat ne', 'fiyatı ne', 'almak istiyorum', 'arıyorum', 'ariyorum', 'alıcı', 'alici', 'bakıyorum', 'bakiyorum', 'ilgilenirim', 'var mı', 'varmı', 'ister misin', 'olur mu', 'nerede', 'nerden', 'tavsiye', 'öneri'];
    const sohbetIfadeleri = ['bende var', 'bende bi', 'verelim', 'vereyim', 'gondereyim', 'atayım', 'atıyorum'];
    if (!hasMedia) {
      if (soruIfadeleri.some(kw => msgLower.includes(kw))) return;
      if (sohbetIfadeleri.some(kw => msgLower.includes(kw))) return;
      const ilanKeywords = ['satılık', 'satilik', 'satlık', 'satlik', 'satıyorum', 'satiyorum', 'satılır', 'satilir', 'satlır', 'satlir', 'satis', 'satış', 'takas', 'devren', 'kiralık', 'kiralik', 'verilir', 'sahibinden', 'acilen', 'temiz', 'sorunsuz', 'ikinci el', 'ikinciel', '2.el', 'sıfır gibi', 'sifir gibi', 'az kullanılmış', 'az kullanilmis'];
      if (!ilanKeywords.some(kw => msgLower.includes(kw))) return;
    }

    // === ÖZELDEN YAZ FİLTRESİ ===
    const ozeldenIfadeler = ['özelden yaz', 'özelden', 'dm', 'özel mesaj', 'özele gel', 'fiyat özelden', 'fiyat dm', 'fiyat özel', 'özelim'];
    if (ozeldenIfadeler.some(kw => msgLower.includes(kw)) && !hasMedia) {
      await sock.sendMessage(chatId, { text: `⚠️ Fiyatı grupta belirtin! Özelden fiyat vermek yasaktır.\n🛡️ _Grup Yönetimi_` });
      return;
    }

    // === FIYATSIZ İLAN KESİNLEŞTİ ===

    if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
    const quota = noPriceCounter[userId];
    if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

    // 2. kez (15dk içinde): sessiz sil
    if (quota.warned) {
      const delKey2 = msg.key;
      const tryDel2 = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey2 }); } catch(e) { if (a < 20) setTimeout(() => tryDel2(a+1), 3000); } };
      tryDel2(1);
      stats.messagesDeleted++;
      io.emit('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
      return;
    }

    // 1. kez: DM'ye uyar + 1dk sonra sil
    quota.warned = true;
    quota.warnedTime = Date.now();
    try { await sock.sendMessage(userId, { text: `⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}

    const msgKey = msg.key;
    setTimeout(async () => {
      const tryDel3 = async (a) => { try { await sock.sendMessage(chatId, { delete: msgKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel3(a+1), 3000); } };
      tryDel3(1);
      stats.messagesDeleted++;
      io.emit('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
    }, config.deleteDelay);

  } catch(e) { debugLog('handleMessage error: ' + e.message); }
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
  console.log('Connect request received, phone:', phoneNumber);
  connect(phoneNumber);
  res.json({ success: true, message: 'Bağlantı başlatıldı, pairing code bekleniyor...' });
});

// Debug endpoint
let debugLogs = [];
function debugLog(msg) { console.log(msg); debugLogs.push({ time: new Date().toISOString(), msg }); if (debugLogs.length > 50) debugLogs.shift(); }
app.get('/api/debug', (req, res) => { res.json(debugLogs); });

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
  // Dosyaya kaydet (restart'ta kaybolmasın)
  try { fs.writeFileSync('./active-group.txt', activeGroupId || '', 'utf8'); } catch(e) {}
  res.json({ success: true });
});

// Tüm fiyatsız ilanları sil (son 100 mesaj)
app.post('/api/clean-no-price', async (req, res) => {
  const { groupId } = req.body;
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    let deletedCount = 0;
    // Baileys 7'de store yok, direkt silme yapamayız ama en azından bilgi dönelim
    res.json({ success: true, count: deletedCount, message: 'Otomatik silme aktif - yeni ilanlar kontrol ediliyor' });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  // Eğer daha önce kayıtlı session varsa otomatik bağlan
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log('Kayıtlı oturum bulundu, otomatik bağlanılıyor...');
    connect();
  } else {
    console.log('Oturum yok, panel üzerinden bağlantı bekleniyor...');
  }
});
