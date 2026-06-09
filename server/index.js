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

function loadDeletedLog() { 
  try { 
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      // 10MB'den buyukse sifirla
      if (stat.size > 10 * 1024 * 1024) {
        console.log('⚠️ Log dosyası çok büyük, sıfırlanıyor...');
        fs.writeFileSync(LOG_FILE, '[]', 'utf8');
        deletedAdsLog = [];
        return;
      }
      deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      // Max 500 kayit
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
    
    debugLog('handleMsg: chatId=' + chatId + ' activeGroupId=' + activeGroupId);
    
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

    // Admin reklam onayı: admin belirli kelimeleri yazarsa son fiyatsız mesajı muaf et
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

    // Adminler muaf
    if (isAdmin) return;

    if (!config.automation.noPrice) return;

    const msgLower = msgText.toLowerCase();

    // === FIYAT ALGILAMA ===
    const hasFiyat = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b|son\b)/i.test(msgText) ||
      /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i.test(msgText) ||
      /\d{1,3}([.,]\d{3})+([.,]\d{2})?/.test(msgText) ||
      ((/\d{4,9}/.test(msgText) || /\d{1,3}[\.,]\d{3}/.test(msgText)) && !/km/i.test(msgText) && !/model/i.test(msgText) && !/kilometre/i.test(msgText) && !/\d{4,}\s*da\b/i.test(msgText) && !/\d{4,}\s*de\b/i.test(msgText) && !/0?5\d{9}/.test(msgText));

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

      // İlk ilan başlangıcı
      if (spamTracker[userId].adCount === 0) {
        spamTracker[userId].adCount = 1;
        spamTracker[userId].firstAdTime = now;
      }
      
      // 5sn içinde gelenler aynı toplu ilan
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

      // Fiyatlı ilan → ilk 10 kalır, 11+ silinir
      if (spamTracker[userId].hasPaid) {
        if (spamTracker[userId].count > 10) {
          if (!spamTracker[userId].warned10) {
            spamTracker[userId].warned10 = true;
            try { await sock.sendMessage(chatId, { text: `⚠️ 10 adetten fazla resim yüklenemez.\n🛡️ _Grup Yönetimi_` }); } catch(e) {}
          }
          const delKey = msg.key;
          const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
          tryDel(1);
          stats.messagesDeleted++;
        }
        return;
      }

      // Fiyatsız resim → 10 limit + 30sn bekle
      if (spamTracker[userId].count > 10) {
        const delKey = msg.key;
        const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        return;
      }

      // Fiyatsız ilk 10 resim → 30sn bekle (fiyat geç gelebilir)
      const delKey = msg.key;
      const delUserId = userId;
      const delMsgId = msg.key.id;
      const delChatId = chatId;
      const delText = msgText;
      const delGroupName = groupName;
      setTimeout(() => {
        if (spamTracker[delUserId] && spamTracker[delUserId].hasPaid) return;
        if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
        const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        
        // Toplu ilan loglama: aynı kullanıcıdan 10sn içinde gelen silinenleri birleştir
        const telefon = delUserId.split('@')[0];
        const existingLog = deletedAdsLog.find(l => l.kullanici === telefon && l.grupId === delChatId && (Date.now() - new Date(l.timestamp).getTime() < 60000));
        if (existingLog) {
          // Mevcut loga ekle
          existingLog.topluAdet = (existingLog.topluAdet || 1) + 1;
          existingLog.mesaj = `[${existingLog.topluAdet} resimli ilan] ${(delText || '📷').substring(0, 50)}`;
        } else {
          deletedAdsLog.unshift({ id: Date.now().toString(), tarih: new Date().toLocaleDateString('tr-TR'), saat: new Date().toLocaleTimeString('tr-TR'), timestamp: new Date().toISOString(), kullanici: telefon, telefon: telefon, grupId: delChatId, grup: delGroupName, mesaj: delText || '(Resimli ilan)', sebep: 'Fiyatsız ilan (otomatik)', topluAdet: 1 });
        }
        if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
        saveDeletedLog();
        io.emit('log', { type: 'deleted', user: telefon, group: delGroupName });
      }, 30000);
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
      const telefon2 = userId.split('@')[0];
      deletedAdsLog.unshift({ id: Date.now().toString(), tarih: new Date().toLocaleDateString('tr-TR'), saat: new Date().toLocaleTimeString('tr-TR'), timestamp: new Date().toISOString(), kullanici: telefon2, telefon: telefon2, grupId: chatId, grup: groupName, mesaj: msgText || '(ilan)', sebep: 'Fiyatsız ilan (sessiz)', topluAdet: 1 });
      if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
      saveDeletedLog();
      io.emit('log', { type: 'deleted', user: telefon2, group: groupName });
      return;
    }

    // 1. kez: DM'ye uyar + 1dk sonra sil
    quota.warned = true;
    quota.warnedTime = Date.now();
    try { await sock.sendMessage(userId, { text: `⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}

    const msgKey = msg.key;
    const delUserId2 = userId;
    const delText2 = msgText;
    const delGroupName2 = groupName;
    const delChatId2 = chatId;
    setTimeout(async () => {
      const tryDel3 = async (a) => { try { await sock.sendMessage(delChatId2, { delete: msgKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel3(a+1), 3000); } };
      tryDel3(1);
      stats.messagesDeleted++;
      const telefon3 = delUserId2.split('@')[0];
      deletedAdsLog.unshift({ id: Date.now().toString(), tarih: new Date().toLocaleDateString('tr-TR'), saat: new Date().toLocaleTimeString('tr-TR'), timestamp: new Date().toISOString(), kullanici: telefon3, telefon: telefon3, grupId: delChatId2, grup: delGroupName2, mesaj: delText2 || '(ilan)', sebep: 'Fiyatsız ilan (otomatik)', topluAdet: 1 });
      if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
      saveDeletedLog();
      io.emit('log', { type: 'deleted', user: telefon3, group: delGroupName2 });
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

// Tüm fiyatsız ilanları sil (son 24 saat)
app.post('/api/clean-no-price', async (req, res) => {
  const { groupId } = req.body;
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    let deletedCount = 0;
    const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 3600);
    
    // Son mesajları çek
    let messages = [];
    try {
      // Baileys fetchMessages farklı çalışabilir, store yoksa chatHistory dene
      const store = sock.store;
      if (store && store.messages && store.messages[groupId]) {
        messages = [...store.messages[groupId].array];
      }
    } catch(e) {}
    
    // Store yoksa veya boşsa, direkt silme yapamayız - kullanıcıya bildir
    if (!messages || !messages.length) {
      return res.json({ success: true, count: 0, message: 'Mesaj geçmişi bulunamadı. Bot açıkken gelen mesajlar otomatik taranır.' });
    }
    
    const fiyatRegex = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b|son\b)/i;
    const fiyatKelime = /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i;
    const fiyatBuyuk = /\d{4,9}/;
    const fiyatNoktali = /\d{1,3}[\.,]\d{3}/;
    const kmExclude = /km|model|kilometre/i;
    const phoneExclude = /0?5\d{9}/;
    
    // Toplu silinen ilanları kullanıcıya göre grupla (tek log olarak kaydet)
    const topluLog = {}; // { userId: { count, mesajlar, ilkMesaj, ... } }
    
    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      if (msg.messageTimestamp && msg.messageTimestamp < twentyFourHoursAgo) continue;
      
      // Admin kontrol
      const userId = msg.key.participant || msg.key.remoteJid;
      try {
        const meta = await sock.groupMetadata(groupId);
        const p = meta.participants.find(x => x.id === userId);
        if (p && (p.admin === 'admin' || p.admin === 'superadmin')) continue;
      } catch(e) {}
      
      // Reklam muaf kontrolü
      if (reklamMuafMsgIds.has(msg.key.id)) continue;
      
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
      const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);
      
      const hasFiyat = fiyatRegex.test(text) || fiyatKelime.test(text) || 
        ((fiyatBuyuk.test(text) || fiyatNoktali.test(text)) && !kmExclude.test(text) && !phoneExclude.test(text));
      
      if (hasFiyat) continue;
      
      // Resimli + fiyatsız VEYA yazılı ilan
      let shouldDelete = false;
      if (hasMedia) {
        shouldDelete = true;
      } else if (text.length > 15) {
        const ilanKeywords = ['satılık', 'satilik', 'satlık', 'satlik', 'satıyorum', 'satiyorum', 'acil', 'acilen', 'temiz', 'sorunsuz', 'sahibinden', 'takas', 'devren', 'kiralık', 'kiralik'];
        shouldDelete = ilanKeywords.some(kw => text.toLowerCase().includes(kw));
      }
      
      if (shouldDelete) {
        try { 
          await sock.sendMessage(groupId, { delete: msg.key }); 
          deletedCount++;
          
          // Toplu log: aynı kullanıcının ilanlarını grupla
          const telefon = userId.split('@')[0];
          if (!topluLog[userId]) {
            topluLog[userId] = { count: 0, telefon, ilkMesaj: text || '(Resimli ilan)', mesajlar: [] };
          }
          topluLog[userId].count++;
          if (topluLog[userId].mesajlar.length < 3) {
            topluLog[userId].mesajlar.push(text || '📷 Resimli');
          }
        } catch(e) {}
        
        // Rate limit
        if (deletedCount % 5 === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    // Toplu logları kaydet (kullanıcı başına 1 log)
    let groupName = groupId;
    try { const meta = await sock.groupMetadata(groupId); groupName = meta.subject; } catch(e) {}
    
    for (const [uid, data] of Object.entries(topluLog)) {
      deletedAdsLog.unshift({ 
        id: Date.now().toString() + uid.substring(0, 5), 
        tarih: new Date().toLocaleDateString('tr-TR'), 
        saat: new Date().toLocaleTimeString('tr-TR'), 
        timestamp: new Date().toISOString(), 
        kullanici: data.telefon, 
        telefon: data.telefon,
        grupId: groupId, 
        grup: groupName, 
        mesaj: data.count > 1 ? `[${data.count} ilan] ${data.mesajlar.join(' | ')}` : data.ilkMesaj,
        sebep: 'Toplu tarama (Fiyatsız)',
        topluAdet: data.count
      });
    }
    
    // Max 500 log tut
    if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
    
    stats.messagesDeleted += deletedCount;
    saveDeletedLog();
    res.json({ success: true, count: deletedCount });
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
  const { kullanici } = req.query;
  let results = [...deletedAdsLog];
  if (kullanici) {
    const q = kullanici.toLowerCase();
    results = results.filter(r => 
      (r.kullanici && r.kullanici.toLowerCase().includes(q)) ||
      (r.telefon && r.telefon.includes(q)) ||
      (r.mesaj && r.mesaj.toLowerCase().includes(q))
    );
  }
  // medyaData'yi response'dan cikar (cok buyuk olabilir)
  const lightResults = results.map(r => {
    // Telefon numarasını bul: telefon alanı > kullaniciId'den çıkar > kullanici alanı (numara ise)
    let tel = r.telefon || '';
    if (!tel && r.kullaniciId && r.kullaniciId.includes('@')) {
      tel = r.kullaniciId.split('@')[0];
    }
    if (!tel && r.kullanici && /^\d{10,}$/.test(r.kullanici)) {
      tel = r.kullanici;
    }
    return {
      ...r,
      medyaData: undefined,
      medyaVar: !!(r.medyaData),
      telefon: tel
    };
  });
  res.json({ success: true, count: lightResults.length, data: lightResults });
});

// Tek log sil
app.delete('/api/deleted-ads/:id', (req, res) => {
  deletedAdsLog = deletedAdsLog.filter(e => e.id !== req.params.id);
  saveDeletedLog();
  res.json({ success: true });
});

app.post('/api/restore-ad', async (req, res) => {
  const { id } = req.body;
  const entry = deletedAdsLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ success: false, error: 'Log bulunamadı' });
  if (sock && isReady) {
    try {
      const groupId = entry.grupId || entry.groupId;
      // Toplu ilan ise bilgilendirme mesajı gönder
      const topluBilgi = entry.topluAdet && entry.topluAdet > 1 ? `\n\n📦 _Bu ilan ${entry.topluAdet} resimden oluşuyordu_` : '';
      const mesaj = (entry.mesaj || '(ilan)').replace(/^\[\d+ resimli ilan\]\s*/, '').replace(/^\[\d+ ilan\]\s*/, '');
      await sock.sendMessage(groupId, { text: `🔄 *Geri Yüklenen İlan*\n\n${mesaj}${topluBilgi}\n\n👤 ${entry.kullanici || 'Bilinmeyen'}` });
    } catch(e) {}
  }
  deletedAdsLog = deletedAdsLog.filter(e => e.id !== id);
  saveDeletedLog();
  res.json({ success: true });
});

app.post('/api/restore-as-ad', async (req, res) => {
  const { id } = req.body;
  const entry = deletedAdsLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ success: false, error: 'Log bulunamadı' });
  if (sock && isReady) {
    try {
      const groupId = entry.grupId || entry.groupId;
      const topluBilgi = entry.topluAdet && entry.topluAdet > 1 ? ` (${entry.topluAdet} resimli)` : '';
      const mesaj = (entry.mesaj || '(ilan)').replace(/^\[\d+ resimli ilan\]\s*/, '').replace(/^\[\d+ ilan\]\s*/, '');
      if (mesaj && mesaj !== '(ilan)') {
        await sock.sendMessage(groupId, { text: mesaj });
      }
      let meta;
      try { meta = await sock.groupMetadata(groupId); } catch(e) { meta = { subject: 'Grup' }; }
      await sock.sendMessage(groupId, { text: `Bu ilan reklam / hizmet paylaşımıdır${topluBilgi}\nReklam ücreti alınmış, onaylanarak yayınlanmıştır.\nİlgilenenler iletişime geçebilir\n\n${(meta.subject || 'GRUP').toUpperCase()} YÖNETİM` });
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
