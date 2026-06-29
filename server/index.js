const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { hasFiyatMi, kuralResim, kuralFiyatliResim, kural3SetPaidTime, kural3Check, kuralFiyatsizMetin, setMediaDir, saveMediaToDir, getK3PaidTime, kural3ResetUser } = require('./messageHandler');

// ─── GLOBAL HATA YAKALAYICI ──────────────────────────────────────────────────
// Baileys "closed session" ve diğer unhandled promise hatalarının process'i
// çökümlememesi için — sadece logla, devam et.
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message : String(reason);
  console.error('[unhandledRejection]', msg);
  // Closed session hatası gelirse bağlantıyı yeniden kur
  if (msg.includes('closed') || msg.includes('Connection Closed') || msg.includes('closed session')) {
    console.log('[unhandledRejection] Closed session detected, scheduling reconnect...');
    setTimeout(() => { try { connect(); } catch(e) {} }, 5000);
  }
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore;

// ─── DATA_DIR (önce belirlenmeli — debugLog buna bağlı) ──────────────────────
const _rawDataDir = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
const DATA_DIR = _rawDataDir || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {} }
console.log(`📂 DATA_DIR: ${DATA_DIR}`);

const AUTH_DIR = path.join(DATA_DIR, 'baileys-auth');
const LOG_FILE = path.join(DATA_DIR, 'deleted-ads-log.json');
const CONFIG_FILE = path.join(DATA_DIR, 'bot-config.json');
const ACTIVE_GROUP_FILE = path.join(DATA_DIR, 'active-group.txt');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
if (!fs.existsSync(MEDIA_DIR)) { try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch(e) {} }
setMediaDir(MEDIA_DIR);
console.log(`📂 MEDIA_DIR: ${MEDIA_DIR}`);

// ─── DEBUG LOG ────────────────────────────────────────────────────────────────
const DEBUG_LOG_PATH = () => path.join(DATA_DIR, 'debug.log');
const debugLog = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(DEBUG_LOG_PATH(), line); } catch(e) {}
};

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
const fiyatliGonderimIds = new Set();
// Kural 2 batch tracker: batch içinde fiyatlı resim geldiyse tüm batch Kural 2'ye gider
// { userId: { hasFiyat: bool, windowStart: number } }
const k2BatchTracker = {};
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
        const errMsg = lastDisconnect?.error?.message || '';
        debugLog('Connection closed, statusCode: ' + code + ' errMsg: ' + errMsg);

        // Auth dizini hâlâ var mı kontrol et — disk mount sorunu varsa logla
        const authExists = fs.existsSync(AUTH_DIR);
        const authFiles = authExists ? fs.readdirSync(AUTH_DIR).length : 0;
        debugLog('Auth dir exists: ' + authExists + ', file count: ' + authFiles);

        if (!authExists || authFiles === 0) {
          debugLog('⚠️ Auth dizini boş veya yok! DATA_DIR=' + (process.env.DATA_DIR || 'TANIMLI DEĞİL'));
          io.emit('log', { type: 'error', message: 'Session dosyaları kayboldu, yeniden QR/pairing gerekiyor' });
        }

        // "Decrypted message with closed session" — oturum bozuk, auth temizle ve yeniden bağlan
        if (errMsg.includes('closed session') || errMsg.includes('Decrypted message')) {
          debugLog('⚠️ Closed session error — auth temizleniyor ve yeniden bağlanılıyor...');
          io.emit('log', { type: 'error', message: 'Oturum bozuk, yeniden bağlanılıyor...' });
          try {
            if (fs.existsSync(AUTH_DIR)) {
              fs.readdirSync(AUTH_DIR).forEach(f => {
                try { fs.unlinkSync(require('path').join(AUTH_DIR, f)); } catch(e2) {}
              });
            }
          } catch(e2) { debugLog('Auth temizleme hatası: ' + e2.message); }
          setTimeout(() => connect(phoneNumber), 3000);
        } else if (code === 401 || code === 403 || code === 405) {
          debugLog('Not reconnecting due to status: ' + code);
          io.emit('log', { type: 'error', message: 'WhatsApp bağlantısı reddedildi (kod: ' + code + '), yeniden giriş gerekiyor' });
        } else {
          const delay = (code === 408 || errMsg.includes('timed out')) ? 10000 : 5000;
          debugLog('Reconnecting in ' + delay + 'ms...');
          setTimeout(() => connect(phoneNumber), delay);
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

    // Restore edilen mesajları en başta atla — kurallar işlemesin
    if (msg.key && msg.key.id && reklamMuafMsgIds.has(msg.key.id)) {
      reklamMuafMsgIds.delete(msg.key.id);
      return;
    }
    // Bot kendi uyarı/sistem mesajlarını atla — döngü önleme
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
    // TEST MODU: tüm muafiyet kaldırıldı, bot/admin da kurallara tabi
    // if (isFromMe) return;

    const msgLower = msgText.toLowerCase();
    const hasFiyat = hasFiyatMi(msgText);

    // ── Resim ilanı ──
    if (hasMedia) {
      const WAIT_MS_CFG = (config.photoWaitSec || 30) * 1000;
      const POST_WARN_GRACE = 3000;
      const st = spamTracker[userId];

      // Kural 2 batch tracker: pencere dolmuşsa sıfırla
      if (!k2BatchTracker[userId] || Date.now() - k2BatchTracker[userId].windowStart > WAIT_MS_CFG + 2000) {
        k2BatchTracker[userId] = { hasFiyat: false, windowStart: Date.now(), warn10Time: 0 };
      }
      if (hasFiyat) k2BatchTracker[userId].hasFiyat = true;
      const k2BatchHasFiyat = k2BatchTracker[userId].hasFiyat;
      const k2Warn10Time = k2BatchTracker[userId].warn10Time || 0;

      // K3 aktifse POST-WARN'ı atla — K2 muafiyeti biter bitmez K3 devreye girer
      const k3PaidTimeCheck = getK3PaidTime(userId);
      const k3ActiveNow = k3PaidTimeCheck && (Date.now() - k3PaidTimeCheck < ((config.adIntervalMin || 5) * 60 * 1000));

      // Kural 1'de 10 bırakıldıktan 3sn sonra gelen FIYATSIZ resimler → tüm kurallardan bağımsız, direkt 30sn bekle
      // Kural 2'de 10 bırakıldıktan 3sn sonra da bu path'e girer (fiyatlı da olsa)
      // K3 aktifse bu bloğu tamamen atla — K3 check'e geç
      if (!k3ActiveNow && (((!k2BatchHasFiyat && st && st.warn10Time && Date.now() - st.warn10Time > POST_WARN_GRACE)) ||
          (k2Warn10Time && Date.now() - k2Warn10Time > POST_WARN_GRACE))) {
        const delKey = getDeleteKey(msg);
        const delMsgId = msg.key.id;
        const delText = msgText;
        const delUserId = userId;
        const delChatId = chatId;
        const delGroupName = groupName;
        const delUserPhone = userPhone;
        const delUserName = userName;
        // POST-WARN'a özel ayrı batch key — K1 log'una karışmasın
        const postWarnWindowKey = st && st.warn10Time ? st.warn10Time : (k2BatchTracker[userId] && k2BatchTracker[userId].warn10Time ? k2BatchTracker[userId].warn10Time : Date.now());
        const postWarnBatchKey = `${userId}_pw_${postWarnWindowKey}`;
        const capturedMsg = msg;
        setTimeout(async () => {
          if (hasFiyatMi(delText)) return;
          const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
          tryDel(1);
          stats.messagesDeleted++;
          console.log(`🗑️ [POST-WARN-30SN] user=${delUserId} caption="${(delText||'').substring(0,30)}"`);
          // Aynı penceredeki resimler tek log kaydında toplanır
          let entry = deletedAdsLog.find(a => a.id === postWarnBatchKey);
          if (!entry) {
            entry = {
              id: postWarnBatchKey,
              tarih: new Date().toLocaleDateString('tr-TR'),
              saat: new Date().toLocaleTimeString('tr-TR'),
              timestamp: new Date().toISOString(),
              kullanici: delUserName || delUserPhone, telefon: delUserPhone, userId: delUserId,
              grupId: delChatId, grup: delGroupName, mesaj: delText || '',
              sebep: 'Fiyatsız resim (10 sonrası 30sn)', topluAdet: 0,
              medyaData: null, medyaMimetype: null, medyaListesi: []
            };
            deletedAdsLog.unshift(entry);
          }
          // Medyayı diske kaydet (saveMediaToDir top-level import'tan gelir)
          try {
            const mediaResult = await saveMediaToDir(capturedMsg, postWarnBatchKey, entry.medyaListesi.length);
            if (mediaResult) {
              entry.medyaListesi.push({ file: mediaResult.file, mimetype: mediaResult.mimetype, caption: delText || '' });
              if (!entry.medyaData) { entry.medyaData = mediaResult.file; entry.medyaMimetype = mediaResult.mimetype; }
            }
          } catch(e) {}
          entry.topluAdet = (entry.topluAdet || 0) + 1;
          if (!entry.mesaj && delText) entry.mesaj = delText;
          if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
          saveDeletedLog();
          io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
          io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
        }, WAIT_MS_CFG);
        return;
      }

      // KURAL 3: Her resimde önce kontrol edilir.
      // Sadece Kural 2 muafiyeti bittikten sonra aktif olur.
      // Fiyatsız resimler K3'e takılmamalı — K3 yalnızca fiyatlı ilan sonrası tekrarlayan ilanları yakalar.
      // Fiyatsız resim gelirse K3'ü atla, K1'e git.
      const res3 = hasFiyat
        ? await kural3Check({ sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText, stats, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config, reklamMuafMsgIds })
        : 'continue';
      if (res3 === 'deleted') {
        // Kural 3 aktifken k2BatchTracker sıfırla — sonraki resimler Kural 2'ye gitmesin
        delete k2BatchTracker[userId];
        return;
      }

      if (k2BatchHasFiyat) {
        // Batch'te fiyatlı resim var → Kural 2 (caption'sız resimler de dahil)
        // kural3SetPaidTime çağrılınca k2BatchTracker da sıfırla
        const kural3SetPaidTimeWrapped = (uid) => {
          kural3SetPaidTime(uid);
          delete k2BatchTracker[uid];
        };
        const onWarn10 = (uid) => {
          if (k2BatchTracker[uid]) k2BatchTracker[uid].warn10Time = Date.now();
        };
        await kuralFiyatliResim({
          sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
          stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey,
          downloadMediaMessage, config, kural3SetPaidTime: kural3SetPaidTimeWrapped, k2BatchHasFiyat, onWarn10
        });
      } else {
        // Henüz fiyatlı resim yok → Kural 1
        // getK2BatchHasFiyat: 30sn beklerken batch'e fiyatlı resim geldiyse K1'i koru, K3 başlat
        const kural3SetPaidTimeWrappedK1 = (uid) => {
          kural3SetPaidTime(uid);
          delete k2BatchTracker[uid];
          // K3 başlarken spamTracker'ı sıfırla — eski warn10Time POST-WARN'a düşmesin
          if (spamTracker[uid]) { spamTracker[uid].imgCount = 0; spamTracker[uid].warn10Time = 0; spamTracker[uid].windowStart = Date.now(); }
        };
        await kuralResim({
          sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
          spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey,
          downloadMediaMessage, config,
          getK2BatchHasFiyat: (uid, k1WindowStart) => {
            const t2 = k2BatchTracker[uid];
            if (!t2 || !t2.hasFiyat) return false;
            const WAIT_MS_CHECK = (config.photoWaitSec || 30) * 1000;
            if (Date.now() - t2.windowStart > WAIT_MS_CHECK + 2000) return false;
            // K1 ve K2 pencereleri aynı zamanda açılmış olmalı (500ms tolerans)
            if (Math.abs(t2.windowStart - k1WindowStart) > 500) return false;
            return true;
          },
          kural3SetPaidTime: kural3SetPaidTimeWrappedK1
        });
      }
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
  const authExists = fs.existsSync(AUTH_DIR);
  const authFiles = authExists ? fs.readdirSync(AUTH_DIR).length : 0;
  res.json({
    connected: isReady,
    groups: connectedGroups,
    activeGroupId,
    stats,
    config,
    pairedPhone: isReady && sock?.authState?.creds?.me?.id ? sock.authState.creds.me.id.split(':')[0] : null,
    dataDir: DATA_DIR,
    authDirExists: authExists,
    authFileCount: authFiles
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
    const LOG_PATH = DEBUG_LOG_PATH();
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
    fs.writeFileSync(DEBUG_LOG_PATH(), '', 'utf8');
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

// ─── YARDIMCI: mesajı muaf mı? (restore edilmiş veya log'dan yüklenen) ────────
function isMuafMsg(m) {
  if (!m || !m.key || !m.key.id) return false;
  return reklamMuafMsgIds.has(m.key.id);
}

// ─── YARDIMCI: mesaj son 6 saat içinde mi? ───────────────────────────────────
function isSon6Saat(m) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const ts = (m.messageTimestamp || 0) * 1000;
  return (Date.now() - ts) < SIX_HOURS;
}

// ─── YARDIMCI: mesaj metnini çıkar ───────────────────────────────────────────
function getMsgText(m) {
  if (!m || !m.message) return '';
  return m.message.conversation || m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption || m.message?.videoMessage?.caption ||
    m.message?.documentMessage?.caption || '';
}

// ─── API: CLEAN NO PRICE ─────────────────────────────────────────────────────
// Son 6 saati tarar; muaf, fiyatlı ve restore edilenler hariç fiyatsızları siler
app.post('/api/clean-no-price', async (req, res) => {
  if (!isReady || !activeGroupId) return res.json({ success: false });
  const msgs = (groupMessages[activeGroupId] || []).filter(isSon6Saat);
  let deleted = 0;
  for (const m of msgs) {
    try {
      if (isMuafMsg(m)) continue;               // restore edilmiş → atla
      const text = getMsgText(m);
      if (hasFiyatMi(text)) continue;            // fiyatlı → atla
      await sock.sendMessage(activeGroupId, { delete: getDeleteKey(m) });
      deleted++;
      stats.messagesDeleted++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {}
  }
  // Silinen mesajları cache'den çıkar
  groupMessages[activeGroupId] = (groupMessages[activeGroupId] || []).filter(m => !isSon6Saat(m) || isMuafMsg(m) || hasFiyatMi(getMsgText(m)));
  res.json({ success: true, deleted, count: deleted });
});

// ─── PERİYODİK TARAMA: her dakika son 6 saati tara ───────────────────────────
// Fiyatsız + muaf olmayan + log'da olmayan ilanları siler
// config.automation.noPrice kapalıysa çalışmaz
let periodicScanActive = false;
async function periodicNoPriceScan() {
  if (!isReady || !activeGroupId || !config.automation.noPrice) return;
  if (periodicScanActive) return; // önceki tarama bitmemişse atla
  periodicScanActive = true;
  try {
    const msgs = (groupMessages[activeGroupId] || []).filter(isSon6Saat);
    for (const m of msgs) {
      try {
        if (isMuafMsg(m)) continue;              // muaf → atla
        const text = getMsgText(m);
        if (hasFiyatMi(text)) continue;           // fiyatlı → atla
        // Log'da bu mesaj ID'si var mı? (restore edilmiş olabilir)
        const msgId = m.key && m.key.id;
        if (msgId && deletedAdsLog.some(a =>
          a.medyaListesi && a.medyaListesi.some(ml => ml.file && ml.file.includes(msgId))
        )) continue;
        await sock.sendMessage(activeGroupId, { delete: getDeleteKey(m) });
        stats.messagesDeleted++;
        await new Promise(r => setTimeout(r, 300));
      } catch(e) {}
    }
  } catch(e) {}
  periodicScanActive = false;
}
// Her dakika çalıştır
setInterval(periodicNoPriceScan, 60 * 1000);

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

// ─── API: TOGGLE GROUP (aç/kapat tek buton) ──────────────────────────────────
app.post('/api/toggle-group', async (req, res) => {
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const groupId = req.body.groupId || activeGroupId;
  if (!groupId) return res.json({ success: false, error: 'Grup yok' });
  try {
    const meta = await sock.groupMetadata(groupId);
    const isClosed = meta.announce === true || meta.announce === 'true';
    if (isClosed) {
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      res.json({ success: true, closed: false });
    } else {
      await sock.groupSettingUpdate(groupId, 'announcement');
      res.json({ success: true, closed: true });
    }
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

// ─── RESTORE QUEUE (sıralı gönderim — art arda restore'lar çakışmasın) ────────
let restoreQueue = Promise.resolve();

// ─── MEDYA DOSYASI OKU (disk'ten buffer) ─────────────────────────────────────
function readMediaFile(filename) {
  try {
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
    const filePath = path.join(MEDIA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch(e) { return null; }
}

// ─── API: MEDIA SERVE ─────────────────────────────────────────────────────────
app.get('/api/media/:filename', (req, res) => {
  const { filename } = req.params;
  const buf = readMediaFile(filename);
  if (!buf) return res.status(404).json({ error: 'Dosya bulunamadı' });
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.bin': 'application/octet-stream' };
  res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.send(buf);
});

// ─── API: RESTORE AD ─────────────────────────────────────────────────────────
// Tüm resimler dискten okunur, tek blokta sıralı gönderilir.
app.post('/api/restore-ad', async (req, res) => {
  const { adId, id, groupId } = req.body;
  const lookupId = adId || id;
  if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
  const ad = deletedAdsLog.find(a => a.id === lookupId);
  if (!ad) return res.json({ success: false, error: 'İlan bulunamadı' });
  const target = groupId || activeGroupId;
  if (!target) return res.json({ success: false, error: 'Hedef grup yok' });
  let result = { success: false, error: 'Bilinmeyen hata' };
  restoreQueue = restoreQueue.then(async () => {
    try {
      const validMedia = (ad.medyaListesi || []).filter(m => m && m.file);
      if (validMedia.length > 0) {
        // Meta verileri topla (buf yok — RAM tasarrufu)
        const metaItems = validMedia.map(m => ({
          file: m.file,
          isVideo: !!(m.mimetype && m.mimetype.startsWith('video')),
          rawCaption: (m.caption && m.caption !== 'muaf') ? m.caption : ''
        }));
        if (metaItems.length === 0) { result = { success: false, error: 'Geri yüklenecek içerik yok' }; return; }
        const firstValidMeta = metaItems.find(i => !!readMediaFile(i.file));
        if (!firstValidMeta) { result = { success: false, error: 'Geri yüklenecek içerik yok' }; return; }
        const firstCaption = firstValidMeta.rawCaption || ad.mesaj || '';
        if (metaItems.length === 1) {
          // Tek resim — albüm gereksiz
          const buf = readMediaFile(metaItems[0].file);
          if (buf) {
            const sent = await sock.sendMessage(target, metaItems[0].isVideo
              ? { video: buf, caption: firstCaption }
              : { image: buf, caption: firstCaption }
            );
            if (sent && sent.key && sent.key.id) reklamMuafMsgIds.add(sent.key.id);
          }
        } else {
          // Çoklu resim — Baileys album API
          const imageCount = metaItems.filter(i => !i.isVideo).length;
          const videoCount = metaItems.filter(i => i.isVideo).length;
          const albumSent = await sock.sendMessage(target, {
            album: { expectedImageCount: imageCount, expectedVideoCount: videoCount }
          });
          const albumParentKey = albumSent && albumSent.key ? albumSent.key : null;
          if (albumSent && albumSent.key && albumSent.key.id) reklamMuafMsgIds.add(albumSent.key.id);
          let isFirst = true;
          for (const meta of metaItems) {
            const buf = readMediaFile(meta.file);
            if (!buf) continue;
            const caption = isFirst ? firstCaption : '';
            isFirst = false;
            const msgPayload = meta.isVideo
              ? { video: buf, caption }
              : { image: buf, caption };
            if (albumParentKey) msgPayload.albumParentKey = albumParentKey;
            const sent = await sock.sendMessage(target, msgPayload);
            if (sent && sent.key && sent.key.id) reklamMuafMsgIds.add(sent.key.id);
          }
        }
      } else if (ad.mesaj) {
        const sent = await sock.sendMessage(target, { text: ad.mesaj });
        if (sent && sent.key && sent.key.id) reklamMuafMsgIds.add(sent.key.id);
      } else { result = { success: false, error: 'Geri yüklenecek içerik yok' }; return; }
      // Restore sonrası kullanıcının K1 ve K2 sayaçlarını sıfırla —
      // geri yüklenen resimler bir sonraki ilanda eski sayaca eklenmesin
      if (ad.userId) {
        delete spamTracker[ad.userId];
        delete k2BatchTracker[ad.userId];
        kural3ResetUser(ad.userId);
      }
      deletedAdsLog = deletedAdsLog.filter(a => a.id !== lookupId);
      saveDeletedLog();
      io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
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
    const validMedia = (ad.medyaListesi || []).filter(m => m && m.file);
    if (validMedia.length > 0) {
      const metaItems = validMedia.map(m => ({
        file: m.file,
        isVideo: !!(m.mimetype && m.mimetype.startsWith('video')),
        rawCaption: (m.caption && m.caption !== 'muaf') ? m.caption : ''
      }));
      if (metaItems.length > 0) {
        const firstValidM = metaItems.find(i => !!readMediaFile(i.file));
        const firstCaption = firstValidM ? (firstValidM.rawCaption || ad.mesaj || '') : (ad.mesaj || '');
        if (metaItems.length === 1) {
          const buf = readMediaFile(metaItems[0].file);
          if (buf) {
            const sent = await sock.sendMessage(target, metaItems[0].isVideo
              ? { video: buf, caption: firstCaption }
              : { image: buf, caption: firstCaption }
            );
            if (sent && sent.key && sent.key.id) reklamMuafMsgIds.add(sent.key.id);
          }
        } else {
          const imageCount = metaItems.filter(i => !i.isVideo).length;
          const videoCount = metaItems.filter(i => i.isVideo).length;
          const albumSent = await sock.sendMessage(target, {
            album: { expectedImageCount: imageCount, expectedVideoCount: videoCount }
          });
          const albumParentKey = albumSent && albumSent.key ? albumSent.key : null;
          if (albumSent && albumSent.key && albumSent.key.id) reklamMuafMsgIds.add(albumSent.key.id);
          let isFirst = true;
          for (const meta of metaItems) {
            const buf = readMediaFile(meta.file);
            if (!buf) continue;
            const caption = isFirst ? firstCaption : '';
            isFirst = false;
            const msgPayload = meta.isVideo
              ? { video: buf, caption }
              : { image: buf, caption };
            if (albumParentKey) msgPayload.albumParentKey = albumParentKey;
            const sent = await sock.sendMessage(target, msgPayload);
            if (sent && sent.key && sent.key.id) reklamMuafMsgIds.add(sent.key.id);
          }
        }
      }
    } else if (ad.mesaj) {
      await sock.sendMessage(target, { text: ad.mesaj });
    }
    deletedAdsLog = deletedAdsLog.filter(a => a.id !== lookupId);
    saveDeletedLog();
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
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

// ─── MEDYA TEMİZLEME (24 saatlik) ────────────────────────────────────────────
// 24 saati geçen medya dosyaları diskten silinir + log kaydındaki referanslar temizlenir
function cleanOldMedia() {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 saat
  const now = Date.now();
  try {
    if (!fs.existsSync(MEDIA_DIR)) return;
    const files = fs.readdirSync(MEDIA_DIR);
    let deleted = 0;
    for (const filename of files) {
      const filePath = path.join(MEDIA_DIR, filename);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          deleted++;
          // Log kayıtlarındaki referansları temizle
          for (const ad of deletedAdsLog) {
            if (ad.medyaListesi) {
              const before = ad.medyaListesi.length;
              ad.medyaListesi = ad.medyaListesi.filter(m => m.file !== filename);
              if (ad.medyaListesi.length !== before && ad.medyaData === filename) {
                ad.medyaData = ad.medyaListesi.length > 0 ? ad.medyaListesi[0].file : null;
                ad.medyaMimetype = ad.medyaListesi.length > 0 ? ad.medyaListesi[0].mimetype : null;
              }
            }
          }
        }
      } catch(e) {}
    }
    if (deleted > 0) {
      saveDeletedLog();
      console.log(`🧹 Medya temizlendi: ${deleted} dosya silindi`);
    }
  } catch(e) { console.error('cleanOldMedia hata:', e.message); }
}
// Her 1 saatte bir çalıştır
setInterval(cleanOldMedia, 60 * 60 * 1000);

// ─── SERVER START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server ${PORT} portunda çalışıyor`);
  // loadDeletedLog() ve loadConfig() startup'ta (satır 90-91) zaten çağrıldı
  scheduleRuleReminder();
  cleanOldMedia(); // başlangıçta eski medyaları temizle
  connect().catch(e => console.error('Initial connect error:', e.message));
});
