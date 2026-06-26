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
      m.messages.forEach(msg => {
        // Protocol mesajı: üye ekleme bildirimini yakala
        if (msg.messageStubType === 27 || msg.messageStubType === 'GROUP_PARTICIPANT_ADD') {
          // Grup katılım bildirimi
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
    debugLog('handleGroupJoin: sending welcome to ' + update.id);
    const meta = await sock.groupMetadata(update.id);
    for (const p of update.participants) {
      // participants hem string hem obje olabilir (Baileys versiyonuna göre)
      const participantId = typeof p === 'string' ? p : (p.id || p.phoneNumber || String(p));
      
      // Gerçek telefon numarasını bul: phoneNumber alanı varsa onu kullan (LID yerine)
      let mentionId = participantId;
      if (typeof p === 'object' && p.phoneNumber) {
        mentionId = p.phoneNumber; // "905060685034@s.whatsapp.net" formatı
      }
      
      // Görünen isim: metadata'dan bul, yoksa numara
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

      await sock.sendMessage(update.id, {
        text: welcomeMsg,
        mentions: [mentionId]
      });
      stats.welcomesSent++;
      io.emit('log', { type: 'welcome', user: name, group: meta.subject });
      debugLog('Welcome sent to: ' + name + ' in ' + meta.subject);
    }
  } catch(e) {
    debugLog('handleGroupJoin ERROR: ' + e.message);
  }
}

// Grup mesajı silme helper - participant alanını garanti et
function getDeleteKey(msg) {
  const key = { ...msg.key };
  // Grup mesajlarında participant zorunlu (yoksa "sadece benden sil" olur)
  if (key.remoteJid && key.remoteJid.endsWith('@g.us')) {
    if (!key.participant) {
      key.participant = msg.key.participant || msg.participant || msg.author || undefined;
    }
  }
  return key;
}

// Medya indirme helper
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
      msgText = msg.message.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
    }
    const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage || msg.message?.documentWithCaptionMessage || msg.message?.stickerMessage || msg.message?.audioMessage || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2);

    // Bot'un kendi mesajlarını atla
    if (isFromMe && msgText && (msgText.includes('Grup Yönetimi') || msgText.includes('tespit edildi') || msgText.includes('susturulm') || msgText.includes('━━━'))) return;
    if (isFromMe && msgText && (msgText.includes('Bu ilan reklam') || msgText.includes('Reklam ücreti') || msgText.includes('Geri Yüklenen'))) return;

    const userId = msg.key.participant || msg.key.remoteJid;
    let isAdmin = isFromMe;
    let groupName = chatId;
    let userName = msg.pushName || '';
    let userPhone = '';
    let realUserId = userId; // Gerçek @s.whatsapp.net ID (LID yerine)
    
    try {
      const meta = await sock.groupMetadata(chatId);
      groupName = meta.subject;
      const p = meta.participants.find(x => x.id === userId);
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
      
      // LID formatı: gerçek telefon numarasını phoneNumber alanından al
      if (userId.includes('@lid')) {
        if (p && p.phoneNumber && p.phoneNumber.includes('@')) {
          // "905060685034@s.whatsapp.net" → "905060685034"
          userPhone = p.phoneNumber.split('@')[0];
          realUserId = p.phoneNumber; // DM göndermek için gerçek ID
        } else {
          // Fallback: pushName veya LID numarası
          userPhone = userName || userId.split('@')[0];
        }
      } else {
        userPhone = userId.split('@')[0];
        realUserId = userId;
      }
    } catch(e) {
      userPhone = userId.split('@')[0];
    }
    
    if (!userName) userName = userPhone;

    // Susturulan üye kontrolü
    if (mutedUsers.has(userId)) {
      try { await sock.sendMessage(chatId, { delete: getDeleteKey(msg) }); } catch(e) {}
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

    // Admin muafiyeti DEVRE DISI - test modu
    // if (isAdmin) return;

    if (!config.automation.noPrice) return;

    const msgLower = msgText.toLowerCase();

    // === FIYAT ALGILAMA ===
    const hasFiyat = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b|son\b)/i.test(msgText) ||
      /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i.test(msgText) ||
      /\d{1,3}([.,]\d{3})+([.,]\d{2})?/.test(msgText) ||
      ((/\d{4,9}/.test(msgText) || /\d{1,3}[\.,]\d{3}/.test(msgText)) && !/km/i.test(msgText) && !/model/i.test(msgText) && !/kilometre/i.test(msgText) && !/\d{4,}\s*da\b/i.test(msgText) && !/\d{4,}\s*de\b/i.test(msgText) && !/0?5\d{9}/.test(msgText));

    // === TOPLU RESİM + 1DK KURAL ===
    if (hasMedia) {
      if (!spamTracker[userId]) spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, warned10Time: 0, hasPaid: false, paidTime: 0, ozelUyari: false, ozelUyariTime: 0, firstAdTime: 0, adCount: 0 };
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        
        // 1 saatte bir uyarı flag'lerini sıfırla (kullanıcı tekrar uyarı alabilsin)
        if (now - spamTracker[userId].warned10Time > ONE_HOUR) {
          spamTracker[userId].warned10 = false;
        }
        if (now - spamTracker[userId].ozelUyariTime > ONE_HOUR) {
          spamTracker[userId].ozelUyari = false;
        }
        
        // 1 saatten fazla geçtiyse yeni dönem (sayaçlar sıfırlanır)
        if (now - spamTracker[userId].firstAdTime > ONE_HOUR) {
          spamTracker[userId].count = 0;
          spamTracker[userId].hasPaid = false;
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
      
      // 2. ilan (5sn'den sonra, 1 saatten önce gelen) → sil + DM 1 kere (1 saatte bir tekrar uyarır)
      if (!isPartOfFirst && (now - spamTracker[userId].firstAdTime < ONE_HOUR) && spamTracker[userId].adCount >= 1) {
        spamTracker[userId].adCount++;
        if (!spamTracker[userId].ozelUyari) {
          spamTracker[userId].ozelUyari = true;
          spamTracker[userId].ozelUyariTime = now;
          try { await sock.sendMessage(realUserId, { text: `⚠️ 1 saatte 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}
        }
        const delKey = getDeleteKey(msg);
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
            spamTracker[userId].warned10Time = now;
            // Uyarıyı özele at (gruba değil), 1 saatte bir tekrar uyarır
            try { await sock.sendMessage(realUserId, { text: `⚠️ 1 saatte 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}
          }
          const delKey = getDeleteKey(msg);
          const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
          tryDel(1);
          stats.messagesDeleted++;
        }
        return;
      }

      // Fiyatsız resim → 10 limit + 30sn bekle
      if (spamTracker[userId].count > 10) {
        const delKey = getDeleteKey(msg);
        const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        return;
      }

      // Fiyatsız ilk 10 resim → 30sn bekle (fiyat geç gelebilir)
      const delKey = getDeleteKey(msg);
      const delUserId = userId;
      const delMsgId = msg.key.id;
      const delChatId = chatId;
      const delText = msgText;
      const delGroupName = groupName;
      const delUserPhone = userPhone;
      const delUserName = userName;
      
      // Resmi hemen indir (30sn sonra mesaj silinmiş olabilir)
      let mediaInfo = null;
      if (hasMedia) {
        mediaInfo = await downloadMediaMessage(msg);
      }
      
      setTimeout(() => {
        if (spamTracker[delUserId] && spamTracker[delUserId].hasPaid) return;
        if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
        const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
        tryDel(1);
        stats.messagesDeleted++;
        
        // Toplu ilan loglama: aynı kullanıcıdan 60sn içinde gelen silinenleri birleştir
        // userId veya telefon ile eşleştir (LID formatı için userId daha güvenli)
        const existingLog = deletedAdsLog.find(l =>
          l.grupId === delChatId &&
          (Date.now() - new Date(l.timestamp).getTime() < 60000) &&
          (l.telefon === delUserPhone || l.userId === delUserId || (delUserPhone && l.telefon && l.telefon === delUserPhone))
        );
        if (existingLog) {
          existingLog.topluAdet = (existingLog.topluAdet || 1) + 1;
          existingLog.mesaj = `[${existingLog.topluAdet} resimli ilan] ${(delText || '📷').substring(0, 50)}`;
          // Tüm resimleri medyaListesi array'inde sakla
          if (mediaInfo) {
            if (!existingLog.medyaListesi) existingLog.medyaListesi = [];
            existingLog.medyaListesi.push({ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' });
          }
          // Geriye dönük uyumluluk: ilk resmi medyaData'da tut
          if (mediaInfo && !existingLog.medyaData) {
            existingLog.medyaData = mediaInfo.data;
            existingLog.medyaMimetype = mediaInfo.mimetype;
          }
        } else {
          const yeniLog = {
            id: Date.now().toString(),
            tarih: new Date().toLocaleDateString('tr-TR'),
            saat: new Date().toLocaleTimeString('tr-TR'),
            timestamp: new Date().toISOString(),
            kullanici: delUserName || delUserPhone,
            telefon: delUserPhone,
            userId: delUserId,
            grupId: delChatId,
            grup: delGroupName,
            mesaj: delText || '(Resimli ilan)',
            sebep: 'Fiyatsız ilan (otomatik)',
            topluAdet: 1,
            medyaData: mediaInfo ? mediaInfo.data : null,
            medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
            medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
          };
          deletedAdsLog.unshift(yeniLog);
        }
        if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
        saveDeletedLog();
        io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
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
      await sock.sendMessage(chatId, { text: `⚠️ Fiyatı grupta belirtin! Özelden fiyat vermek yasaktır.\n🛡️ _${groupName} Yönetimi_` });
      return;
    }

    // === FIYATSIZ İLAN KESİNLEŞTİ ===

    if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
    const quota = noPriceCounter[userId];
    if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

    // 2. kez (15dk içinde): sessiz sil
    if (quota.warned) {
      const delKey2 = getDeleteKey(msg);
      const tryDel2 = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey2 }); } catch(e) { if (a < 20) setTimeout(() => tryDel2(a+1), 3000); } };
      tryDel2(1);
      stats.messagesDeleted++;
      // Resmi indir
      let mediaInfo2 = null;
      if (hasMedia) { mediaInfo2 = await downloadMediaMessage(msg); }
      deletedAdsLog.unshift({ id: Date.now().toString(), tarih: new Date().toLocaleDateString('tr-TR'), saat: new Date().toLocaleTimeString('tr-TR'), timestamp: new Date().toISOString(), kullanici: userName || userPhone, telefon: userPhone, grupId: chatId, grup: groupName, mesaj: msgText || '(ilan)', sebep: 'Fiyatsız ilan (sessiz)', topluAdet: 1, medyaData: mediaInfo2 ? mediaInfo2.data : null, medyaMimetype: mediaInfo2 ? mediaInfo2.mimetype : null });
      if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
      saveDeletedLog();
      io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
      return;
    }

    // 1. kez: DM'ye uyar + 1dk sonra sil
    quota.warned = true;
    quota.warnedTime = Date.now();
    try { await sock.sendMessage(realUserId, { text: `⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}

    // Resmi hemen indir
    let mediaInfo3 = null;
    if (hasMedia) { mediaInfo3 = await downloadMediaMessage(msg); }

    const msgKey = getDeleteKey(msg);
    const delUserId2 = userId;
    const delText2 = msgText;
    const delGroupName2 = groupName;
    const delChatId2 = chatId;
    const delUserPhone2 = userPhone;
    const delUserName2 = userName;
    const delMediaInfo3 = mediaInfo3;
    setTimeout(async () => {
      const tryDel3 = async (a) => { try { await sock.sendMessage(delChatId2, { delete: msgKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel3(a+1), 3000); } };
      tryDel3(1);
      stats.messagesDeleted++;
      deletedAdsLog.unshift({ id: Date.now().toString(), tarih: new Date().toLocaleDateString('tr-TR'), saat: new Date().toLocaleTimeString('tr-TR'), timestamp: new Date().toISOString(), kullanici: delUserName2 || delUserPhone2, telefon: delUserPhone2, grupId: delChatId2, grup: delGroupName2, mesaj: delText2 || '(ilan)', sebep: 'Fiyatsız ilan (otomatik)', topluAdet: 1, medyaData: delMediaInfo3 ? delMediaInfo3.data : null, medyaMimetype: delMediaInfo3 ? delMediaInfo3.mimetype : null });
      if (deletedAdsLog.length > 500) deletedAdsLog = deletedAdsLog.slice(0, 500);
      saveDeletedLog();
      io.emit('log', { type: 'deleted', user: delUserName2 || delUserPhone2, group: delGroupName2 });
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
    await sock.sendMessage(groupId, { text: `📢 *${meta.subject}*\n━━━━━━━━━━━━━━━━\n\n📋 *Grup Kuralları*\n\n• İlanlarınızda mutlaka fiyat belirtin\n• Aynı ilanı tekrar tekrar atmayın\n• Saygılı olalım\n\n⚠️ Kurallara uymayan ilanlar silinecektir.\n\n🛡️ _${meta.subject} Yönetimi_` });
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

app.post('/api/send-announcement', async (req, res) => {
  const { groupId, message } = req.body;
  if (!sock || !isReady) return res.status(500).json({ error: 'Not connected' });
  try {
    const meta = await sock.groupMetadata(groupId);
    const formatted = `📢 *DUYURU*\n━━━━━━━━━━━━━━━━\n\n${message}\n\n🛡️ _${meta.subject} Yönetimi_`;
    await sock.sendMessage(groupId, { text: formatted });
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
          await sock.sendMessage(groupId, { delete: getDeleteKey(msg) }); 
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
    const members = meta.participants.map(p => {
      // LID formatı: gerçek numarayı phoneNumber alanından al
      let number = '';
      let realId = p.id;
      if (p.id && p.id.includes('@lid')) {
        if (p.phoneNumber && p.phoneNumber.includes('@')) {
          number = p.phoneNumber.split('@')[0];
          realId = p.phoneNumber; // Ban/remove işlemleri için gerçek ID
        } else {
          number = p.id.split('@')[0]; // Fallback
        }
      } else {
        number = p.id.split('@')[0];
      }
      return {
        id: p.id,        // Baileys işlemleri için (LID)
        realId: realId,  // DM/remove için gerçek ID
        number: number,  // Görünen numara
        name: p.notify || number, // pushName varsa göster
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
      };
    });
    res.json({ members });
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

// Toplu resim gönderme helper - medyaListesi varsa tüm resimleri gönderir
async function sendMediaList(groupId, entry, extraCaption) {
  const liste = entry.medyaListesi && entry.medyaListesi.length > 0 ? entry.medyaListesi : null;
  
  if (liste && liste.length > 0) {
    // Tüm resimleri sırayla gönder
    for (let i = 0; i < liste.length; i++) {
      const m = liste[i];
      const buffer = Buffer.from(m.data, 'base64');
      const isVideo = m.mimetype && m.mimetype.startsWith('video');
      // Sadece ilk resme caption ekle
      const caption = i === 0 ? (extraCaption || m.caption || undefined) : undefined;
      try {
        if (isVideo) {
          await sock.sendMessage(groupId, { video: buffer, mimetype: m.mimetype, caption });
        } else {
          await sock.sendMessage(groupId, { image: buffer, mimetype: m.mimetype, caption });
        }
        // WhatsApp rate limit: resimler arası kısa bekleme
        if (i < liste.length - 1) await new Promise(r => setTimeout(r, 800));
      } catch(e) { debugLog('sendMediaList resim ' + i + ' hata: ' + e.message); }
    }
    return true;
  } else if (entry.medyaData && entry.medyaMimetype) {
    // Eski format: tek resim
    const buffer = Buffer.from(entry.medyaData, 'base64');
    const isVideo = entry.medyaMimetype.startsWith('video');
    const caption = extraCaption || (entry.mesaj || '').replace(/^\[\d+ resimli ilan\]\s*/, '').replace(/\(Resimli ilan\)/, '').replace(/\(ilan\)/, '').trim() || undefined;
    if (isVideo) {
      await sock.sendMessage(groupId, { video: buffer, mimetype: entry.medyaMimetype, caption });
    } else {
      await sock.sendMessage(groupId, { image: buffer, mimetype: entry.medyaMimetype, caption });
    }
    return true;
  }
  return false;
}

app.post('/api/restore-ad', async (req, res) => {
  const { id } = req.body;
  const entry = deletedAdsLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ success: false, error: 'Log bulunamadı' });
  if (sock && isReady) {
    try {
      const groupId = entry.grupId || entry.groupId;
      const hasSentMedia = await sendMediaList(groupId, entry, null);
      
      if (!hasSentMedia) {
        // Sadece metin
        const topluBilgi = entry.topluAdet && entry.topluAdet > 1 ? `\n\n📦 _Bu ilan ${entry.topluAdet} resimden oluşuyordu_` : '';
        const mesaj = (entry.mesaj || '(ilan)').replace(/^\[\d+ resimli ilan\]\s*/, '').replace(/^\[\d+ ilan\]\s*/, '');
        await sock.sendMessage(groupId, { text: `🔄 *Geri Yüklenen İlan*\n\n${mesaj}${topluBilgi}\n\n👤 ${entry.kullanici || 'Bilinmeyen'}` });
      }
    } catch(e) { debugLog('restore-ad error: ' + e.message); }
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
      let meta;
      try { meta = await sock.groupMetadata(groupId); } catch(e) { meta = { subject: 'Grup' }; }
      
      const hasSentMedia = await sendMediaList(groupId, entry, null);
      
      if (!hasSentMedia && entry.mesaj) {
        const temizMesaj = (entry.mesaj || '').replace(/^\[\d+ resimli ilan\]\s*/, '').replace(/\(Resimli ilan\)/, '').replace(/\(ilan\)/, '').trim();
        if (temizMesaj) await sock.sendMessage(groupId, { text: temizMesaj });
      }
      
      // Reklam onay yazısı
      const topluBilgi = entry.topluAdet && entry.topluAdet > 1 ? ` (${entry.topluAdet} resimli)` : '';
      await sock.sendMessage(groupId, { text: `Bu ilan reklam / hizmet paylaşımıdır${topluBilgi}\nReklam ücreti alınmış, onaylanarak yayınlanmıştır.\nİlgilenenler iletişime geçebilir\n\n${(meta.subject || 'GRUP').toUpperCase()} YÖNETİM` });
    } catch(e) { debugLog('restore-as-ad error: ' + e.message); }
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

// Oturumu kapat - auth dosyalarını sil, yeni numara ile bağlanmak için
app.post('/api/logout', async (req, res) => {
  try {
    // Bağlantıyı kapat
    if (sock) {
      try { await sock.logout(); } catch(e) {}
      try { sock.end(); } catch(e) {}
      sock = null;
    }
    isReady = false;
    currentQR = null;
    currentPairingCode = null;
    connectedGroups = [];
    
    // Auth klasörünü temizle
    if (fs.existsSync(AUTH_DIR)) {
      const files = fs.readdirSync(AUTH_DIR);
      for (const file of files) {
        try { fs.rmSync(path.join(AUTH_DIR, file), { recursive: true, force: true }); } catch(e) {}
      }
    }
    
    // Aktif grup bilgisini sıfırla
    activeGroupId = null;
    try { fs.writeFileSync(ACTIVE_GROUP_FILE, '', 'utf8'); } catch(e) {}
    
    io.emit('status', { connected: false });
    io.emit('logged_out');
    
    console.log('🔓 Oturum kapatıldı, auth temizlendi');
    res.json({ success: true, message: 'Oturum kapatıldı. Yeni numara ile bağlanabilirsiniz.' });
  } catch(e) {
    console.error('Logout error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
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
