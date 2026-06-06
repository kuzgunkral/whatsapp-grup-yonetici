/**
 * WhatsApp Bot Engine - Telefonda çalışan Node.js
 * Baileys ile WhatsApp bağlantısı (Pairing Code - QR yok)
 * React Native UI ile bridge üzerinden haberleşir
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const rn_bridge = require('rn-bridge');

const AUTH_DIR = path.join(rn_bridge.app.datadir(), 'baileys-auth');
const LOG_FILE = path.join(rn_bridge.app.datadir(), 'deleted-ads-log.json');
const CONFIG_FILE = path.join(rn_bridge.app.datadir(), 'bot-config.json');

// ============ DURUM ============
let sock = null;
let isReady = false;
let botStartTime = 0;
let connectedGroups = [];
let spamTracker = {};
let pausedGroups = new Set();
let mutedUsers = new Set();
let activeGroupId = null;
let noPriceCounter = {};
let noPriceTimers = {};
let reklamMuafMsgIds = new Set();
let botSendingMedia = 0;
let bannedUsers = {};
let deletedAdsLog = [];
let stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };

let config = {
  automation: { welcome: true, noPrice: true, rules: true },
  deleteDelay: 60000,
  warningLimit: 10,
  ruleIntervalHours: 6,
  customRuleMessage: null,
};

let ruleIntervalTimer = null;

// ============ YARDIMCI ============

function loadDeletedLog() {
  try { if (fs.existsSync(LOG_FILE)) deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { deletedAdsLog = []; }
}

function saveDeletedLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch (e) {}
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch (e) {}
}

function send(event, data) {
  rn_bridge.channel.send(JSON.stringify({ event, data }));
}

function logDeletedAd(data) {
  const entry = {
    id: Date.now().toString(),
    tarih: new Date().toLocaleDateString('tr-TR'),
    saat: new Date().toLocaleTimeString('tr-TR'),
    timestamp: new Date().toISOString(),
    kullanici: data.user,
    kullaniciId: data.userId,
    grup: data.group,
    grupId: data.groupId,
    mesaj: data.message,
    medya: data.hasMedia || false,
    medyaData: data.mediaData || null,
    medyaMimetype: data.mediaMimetype || null,
    sebep: data.reason || 'Fiyatsız ilan',
  };
  deletedAdsLog.unshift(entry);
  saveDeletedLog();
  send('log', { type: 'deleted', user: entry.kullanici, group: entry.grup });
  return entry;
}

// ============ MESAJ ŞABLONLARI ============

function getRulesMessage(groupName) {
  return `📢 *${groupName}*\n━━━━━━━━━━━━━━━━\n\n📋 *Grup Kuralları*\n\n• İlanlarınızda mutlaka fiyat belirtin\n• Aynı ilanı tekrar tekrar atmayın\n• Saygılı olalım\n• Konu dışı paylaşım yapmayın\n• Hakaret/küfür kesinlikle yasaktır\n\n⚠️ Kurallara uymayan ilanlar silinecektir.\n\n_İyi alışverişler dileriz!_ 🛒\n🛡️ Grup Yönetimi`;
}

function getWelcomeMessage(name, groupName) {
  return `👋 Hoş geldin *${name}*!\n\nGrubumuza katıldığın için teşekkürler 🎉\n\n📌 *Hatırlatma:*\n• İlan verirken fiyat belirtin\n• Saygılı olalım\n• Konu dışı mesaj atmayalım\n\n_İyi alışverişler!_ 🛒\n🛡️ _${groupName} Yönetimi_`;
}

// ============ BAĞLANTI ============

async function connect(phoneNumber) {
  loadDeletedLog();
  loadConfig();

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Grup Yönetici', 'Android', '1.0.0'],
    syncFullHistory: false,
  });

  // Pairing Code ile bağlan (QR yok)
  if (!state.creds.registered && phoneNumber) {
    const code = await sock.requestPairingCode(phoneNumber);
    send('pairing_code', { code });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      isReady = false;
      send('status', { connected: false });
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => connect(), 5000);
      } else {
        send('logged_out', {});
      }
    }

    if (connection === 'open') {
      isReady = true;
      botStartTime = Math.floor(Date.now() / 1000);
      send('status', { connected: true });
      loadGroups();
      startRuleReminder();
      startPeriodicCleanup();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(msg);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    if (!config.automation.welcome) return;
    if (update.action !== 'add') return;
    try {
      const meta = await sock.groupMetadata(update.id);
      for (const p of update.participants) {
        const name = p.split('@')[0];
        await sock.sendMessage(update.id, { text: getWelcomeMessage(name, meta.subject) });
        stats.welcomesSent++;
        send('log', { type: 'welcome', user: name, group: meta.subject });
      }
    } catch (e) {}
  });
}

async function loadGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    connectedGroups = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participantCount: g.participants.length,
    }));
    send('groups', { groups: connectedGroups });
  } catch (e) {}
}

// ============ MESAJ İŞLEME (TÜM KURALLAR) ============

async function handleMessage(msg) {
  try {
    if (msg.messageTimestamp && msg.messageTimestamp < botStartTime - 5) return;

    const chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return;
    if (pausedGroups.has(chatId)) return;
    if (activeGroupId && chatId !== activeGroupId) return;

    const isFromMe = msg.key.fromMe;
    const msgText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
    const hasMedia = !!msg.message?.imageMessage || !!msg.message?.videoMessage;

    // Bot kendi mesajlarını atla
    if (isFromMe && msgText && (msgText.includes('Grup Yönetimi') || msgText.includes('tespit edildi') || msgText.includes('susturulm') || msgText.includes('━━━'))) return;
    if (isFromMe && msgText && (msgText.includes('Bu ilan reklam') || msgText.includes('Reklam ücreti') || msgText.includes('Geri Yüklenen'))) return;
    if (isFromMe && botSendingMedia && (Date.now() - botSendingMedia < 5000)) return;

    const msgId = msg.key.id;
    if (reklamMuafMsgIds.has(msgId)) return;

    const userId = msg.key.participant || msg.key.remoteJid;
    const userName = userId.split('@')[0];
    let isAdmin = false;

    try {
      const meta = await sock.groupMetadata(chatId);
      const p = meta.participants.find((x) => x.id === userId);
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
    } catch (e) {}
    if (isFromMe) isAdmin = true;

    // Admin reklam onayı
    if (isFromMe && !msgText.includes('✅')) {
      const tempLower = msgText.toLowerCase();
      const reklamKelimeleri = ['bu ilan reklam', 'reklam ücreti', 'ücretli reklam', 'sponsor', 'ücreti alınmıştır', 'ücretli ilan', 'onaylı ilan'];
      if (reklamKelimeleri.some((kw) => tempLower.includes(kw))) {
        if (msg.message?.extendedTextMessage?.contextInfo?.stanzaId) {
          const quotedId = msg.message.extendedTextMessage.contextInfo.stanzaId;
          reklamMuafMsgIds.add(quotedId);
          if (noPriceTimers[quotedId]) {
            clearTimeout(noPriceTimers[quotedId].silTimer);
            delete noPriceTimers[quotedId];
          }
          setTimeout(() => reklamMuafMsgIds.delete(quotedId), 5 * 60 * 1000);
        }
        return;
      }
    }

    // Susturulan üye
    if (mutedUsers.has(userId) && !isAdmin) {
      try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (e) {}
      return;
    }

    if (!config.automation.noPrice) return;

    const msgLower = msgText.toLowerCase();

    // ============ FİYAT ALGILAMA ============
    const fiyatPattern = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b)/i;
    const fiyatKelime = /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i;
    const fiyatBuyukSayi = /(?<!\d)\d{5,}(?!\s*(km|model|motor|cc|hp|beygir))/i;
    const fiyatNoktali = /\d{1,3}[\.,]\d{3}/;
    const kmVar = /km/i;
    const hasFiyat = fiyatPattern.test(msgText) || fiyatKelime.test(msgText) || ((fiyatBuyukSayi.test(msgText) || fiyatNoktali.test(msgText)) && !kmVar.test(msgText));

    // ============ 10 RESİM LİMİTİ ============
    if (hasMedia) {
      if (!spamTracker[userId]) spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, hasPaid: false, paidTime: 0, ozelUyari: false };
      const now = Date.now();
      if (now - spamTracker[userId].lastTime > 60000) { spamTracker[userId].count = 0; spamTracker[userId].warned10 = false; spamTracker[userId].hasPaid = false; }
      spamTracker[userId].count++;
      spamTracker[userId].lastTime = now;

      if (spamTracker[userId].count > 9 && spamTracker[userId].hasPaid) {
        if (!hasFiyat) {
          if (!spamTracker[userId].warned10) {
            await sock.sendMessage(chatId, { text: '⚠️ 10 adetten fazla resim yüklenemez.\n🛡️ _Grup Yönetimi_' });
            spamTracker[userId].warned10 = true;
          }
          await deleteMsg(chatId, msg.key);
          return;
        }
      }
    }

    // ============ FİYAT VARSA MUAF ============
    if (hasFiyat) {
      if (!spamTracker[userId]) spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, hasPaid: false, paidTime: 0, ozelUyari: false };
      if (spamTracker[userId].hasPaid && (Date.now() - spamTracker[userId].paidTime > 5000) && (Date.now() - spamTracker[userId].paidTime < 60000)) {
        await deleteMsg(chatId, msg.key);
        if (!spamTracker[userId].ozelUyari) {
          spamTracker[userId].ozelUyari = true;
          try { await sock.sendMessage(userId, { text: '⚠️ 1 dakikada 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _Grup Yönetimi_' }); } catch (e) {}
        }
        return;
      }
      spamTracker[userId].hasPaid = true;
      spamTracker[userId].paidTime = Date.now();
      if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
      noPriceCounter[userId].warned = true;
      noPriceCounter[userId].warnedTime = Date.now();
      return;
    }

    // ============ 1DK'DA 1 İLAN HAKKI ============
    if (spamTracker[userId] && spamTracker[userId].hasPaid) {
      const since = Date.now() - spamTracker[userId].paidTime;
      if (since < 5000) return;
      if (since < 60000) {
        await deleteMsg(chatId, msg.key);
        if (!spamTracker[userId].ozelUyari) {
          spamTracker[userId].ozelUyari = true;
          try { await sock.sendMessage(userId, { text: '⚠️ 1 dakikada 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _Grup Yönetimi_' }); } catch (e) {}
        }
        return;
      }
    }

    // ============ SORU / SOHBET FİLTRESİ ============
    const soruIfadeleri = ['?', ' mı', ' mi', ' mu', ' mü', 'hala ', 'halen ', 'satıldı', 'satildi', 'ne kadar', 'kaça', 'kaca', 'fiyat ne', 'fiyatı ne', 'almak istiyorum', 'arıyorum', 'ariyorum', 'alıcı', 'alici', 'bakıyorum', 'bakiyorum', 'ilgilenirim', 'var mı', 'varmı', 'ister misin', 'olur mu', 'nerede', 'nerden', 'tavsiye', 'öneri'];
    const sohbetIfadeleri = ['bende var', 'bende bi', 'verelim', 'vereyim', 'gondereyim', 'atayım', 'atıyorum'];

    if (!hasMedia) {
      if (soruIfadeleri.some((kw) => msgLower.includes(kw))) return;
      if (sohbetIfadeleri.some((kw) => msgLower.includes(kw))) return;
      const ilanKeywords = ['satılık', 'satilik', 'satlık', 'satlik', 'satıyorum', 'satiyorum', 'satılır', 'satilir', 'satlır', 'satlir', 'satis', 'satış', 'takas', 'devren', 'kiralık', 'kiralik', 'verilir', 'item', 'sahibinden', 'acilen', 'temiz', 'sorunsuz', 'ikinci el', 'ikinciel', '2.el', 'sıfır gibi', 'sifir gibi', 'az kullanılmış', 'az kullanilmis'];
      if (!ilanKeywords.some((kw) => msgLower.includes(kw))) return;
    }

    // ============ ÖZELDEN YAZ FİLTRESİ ============
    const ozeldenIfadeler = ['özelden yaz', 'özelden', 'dm', 'özel mesaj', 'özele gel', 'fiyat özelden', 'fiyat dm', 'fiyat özel', 'özelim'];
    if (ozeldenIfadeler.some((kw) => msgLower.includes(kw)) && !hasMedia) {
      await sock.sendMessage(chatId, { text: '⚠️ Fiyatı grupta belirtin! Özelden fiyat vermek yasaktır.\n🛡️ _Grup Yönetimi_' });
      return;
    }

    // ============ FİYATSIZ İLAN KESİNLEŞTİ ============

    let mediaData = null;
    let mediaMimetype = null;
    if (hasMedia) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        mediaData = buffer.toString('base64');
        mediaMimetype = msg.message?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || 'image/jpeg';
      } catch (e) {}
    }

    if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
    const quota = noPriceCounter[userId];
    if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

    let groupName = chatId;
    try { const meta = await sock.groupMetadata(chatId); groupName = meta.subject; } catch (e) {}

    // 2.Cİ KEZ: anında sessiz sil
    if (quota.warned) {
      if (hasFiyat) return;
      await deleteMsg(chatId, msg.key);
      stats.messagesDeleted++;
      let logMsg = msgText || '(Resimli ilan)';
      if (hasMedia) logMsg = `📷 [Resimli ilan] ${msgText || '(yazı yok)'}`;
      logDeletedAd({ user: userName, userId, group: groupName, groupId: chatId, message: logMsg, hasMedia, mediaData, mediaMimetype, reason: 'Fiyatsız ilan (sessiz)' });
      return;
    }

    // 1.Cİ KEZ: uyar + 1dk sonra sil
    quota.warned = true;
    quota.warnedTime = Date.now();

    await sock.sendMessage(chatId, { text: `⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` });

    const silTimer = setTimeout(async () => {
      if (reklamMuafMsgIds.has(msgId)) { reklamMuafMsgIds.delete(msgId); return; }
      await deleteMsg(chatId, msg.key);
      stats.messagesDeleted++;
      let logMsg = msgText || '(Resimli ilan)';
      if (hasMedia) logMsg = `📷 [Resimli ilan] ${msgText || '(yazı yok)'}`;
      logDeletedAd({ user: userName, userId, group: groupName, groupId: chatId, message: logMsg, hasMedia, mediaData, mediaMimetype, reason: 'Fiyatsız ilan (otomatik)' });
    }, config.deleteDelay);
    noPriceTimers[msgId] = { silTimer };

  } catch (err) {
    console.error('Mesaj işleme hatası:', err.message);
  }
}

async function deleteMsg(chatId, key, retries = 0) {
  try { await sock.sendMessage(chatId, { delete: key }); } catch (e) {
    if (retries < 5) setTimeout(() => deleteMsg(chatId, key, retries + 1), 3000);
  }
}

// ============ PERİYODİK GÖREVLER ============

function startRuleReminder() {
  if (ruleIntervalTimer) clearInterval(ruleIntervalTimer);
  ruleIntervalTimer = setInterval(async () => {
    if (!isReady || !config.automation.rules || !activeGroupId) return;
    try {
      const meta = await sock.groupMetadata(activeGroupId);
      const msg = config.customRuleMessage || getRulesMessage(meta.subject);
      await sock.sendMessage(activeGroupId, { text: msg });
      stats.rulesReminded++;
      send('log', { type: 'rules_reminder', group: meta.subject });
    } catch (e) {}
  }, config.ruleIntervalHours * 60 * 60 * 1000);
}

function startPeriodicCleanup() {
  setInterval(() => { spamTracker = {}; }, 30 * 60 * 1000);
  setInterval(() => { noPriceCounter = {}; }, 60 * 60 * 1000);
}

// ============ REACT NATIVE BRIDGE ============

rn_bridge.channel.on('message', async (raw) => {
  try {
    const { action, data } = JSON.parse(raw);

    switch (action) {
      case 'connect':
        await connect(data.phoneNumber);
        break;

      case 'get_status':
        send('status', { connected: isReady, stats, groups: connectedGroups, config: config.automation });
        break;

      case 'set_active_group':
        activeGroupId = data.groupId || null;
        break;

      case 'send_message':
        if (!isReady) break;
        await sock.sendMessage(data.groupId, { text: `✦══════ ${data.message} ══════✦` });
        send('log', { type: 'sent', group: data.groupId });
        break;

      case 'send_rules':
        if (!isReady) break;
        const meta1 = await sock.groupMetadata(data.groupId);
        await sock.sendMessage(data.groupId, { text: getRulesMessage(meta1.subject) });
        stats.rulesReminded++;
        break;

      case 'send_announcement':
        if (!isReady) break;
        const meta2 = await sock.groupMetadata(data.groupId);
        await sock.sendMessage(data.groupId, { text: `📌 *Sabit Duyuru*\n━━━━━━━━━━━━━━━━\n\n${data.message}\n\n_Bu duyuru grup açıklamasına sabitlenmiştir._\n🛡️ Grup Yönetimi` });
        await sock.groupUpdateDescription(data.groupId, `📌 ${data.message}`);
        break;

      case 'close_group':
        if (!isReady) break;
        await sock.groupSettingUpdate(data.groupId, 'announcement');
        const meta3 = await sock.groupMetadata(data.groupId);
        await sock.sendMessage(data.groupId, { text: `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n┃  🔒 *GRUP KAPATILDI*\n┃  🛡️ *${meta3.subject}*\n┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n🚫 Sadece yöneticiler yazabilir.\n\n🛡️ *GRUP YÖNETİMİ*` });
        break;

      case 'open_group':
        if (!isReady) break;
        await sock.groupSettingUpdate(data.groupId, 'not_announcement');
        pausedGroups.delete(data.groupId);
        const meta4 = await sock.groupMetadata(data.groupId);
        await sock.sendMessage(data.groupId, { text: `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n┃  🔓 *GRUP AÇILDI*\n┃  🛡️ *${meta4.subject}*\n┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n✅ Herkes mesaj atabilir.\n\n🛡️ *GRUP YÖNETİMİ*` });
        break;

      case 'pause_group':
        pausedGroups.add(data.groupId);
        if (isReady) {
          const meta5 = await sock.groupMetadata(data.groupId);
          await sock.sendMessage(data.groupId, { text: `⏸️ *${meta5.subject}* grubu duraklatıldı. Bot geçici olarak devre dışı.\n🛡️ _Grup Yönetimi_` });
        }
        break;

      case 'mute_member':
        mutedUsers.add(data.memberId);
        if (isReady) {
          const name = data.memberId.split('@')[0];
          await sock.sendMessage(data.groupId, { text: `🔇 *${name}* 5 dakika susturuldu.\n🛡️ _Grup Yönetimi_` });
          setTimeout(async () => {
            mutedUsers.delete(data.memberId);
            delete spamTracker[data.memberId];
            try { await sock.sendMessage(data.groupId, { text: `🔊 *${name}* susturması kaldırıldı.\n🛡️ _Grup Yönetimi_` }); } catch (e) {}
          }, 5 * 60 * 1000);
        }
        break;

      case 'unmute_member':
        mutedUsers.delete(data.memberId);
        delete spamTracker[data.memberId];
        delete noPriceCounter[data.memberId];
        if (isReady) {
          const name = data.memberId.split('@')[0];
          await sock.sendMessage(data.groupId, { text: `🔊 *${name}* susturması kaldırıldı.\n🛡️ _Grup Yönetimi_` });
        }
        break;

      case 'remove_member':
        if (isReady) await sock.groupParticipantsUpdate(data.groupId, [data.memberId], 'remove');
        break;

      case 'ban_member':
        if (isReady) {
          await sock.groupParticipantsUpdate(data.groupId, [data.memberId], 'remove');
          if (!bannedUsers[data.groupId]) bannedUsers[data.groupId] = [];
          bannedUsers[data.groupId].push(data.memberId);
        }
        break;

      case 'get_members':
        if (isReady) {
          const meta6 = await sock.groupMetadata(data.groupId);
          const members = meta6.participants.map((p) => ({
            id: p.id,
            number: p.id.split('@')[0],
            name: p.id.split('@')[0],
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          }));
          send('members', { members });
        }
        break;

      case 'get_deleted_ads':
        send('deleted_ads', { data: deletedAdsLog });
        break;

      case 'restore_ad':
        const entry = deletedAdsLog.find((e) => e.id === data.id);
        if (entry && isReady) {
          botSendingMedia = Date.now();
          if (entry.medyaData && entry.medyaMimetype) {
            const buffer = Buffer.from(entry.medyaData, 'base64');
            const caption = (entry.mesaj || '').replace(/^📷 \[Resimli ilan\]\s*/, '').replace(/\(yazı yok\)/, '').trim();
            await sock.sendMessage(entry.grupId, { image: buffer, caption: caption || undefined });
          } else {
            const temiz = (entry.mesaj || '').replace(/^📷 \[Resimli ilan\]\s*/, '').replace(/\(yazı yok\)/, '').trim();
            if (temiz) await sock.sendMessage(entry.grupId, { text: temiz });
          }
          deletedAdsLog = deletedAdsLog.filter((e) => e.id !== data.id);
          saveDeletedLog();
          send('restore_done', { id: data.id });
        }
        break;

      case 'restore_as_ad':
        const entry2 = deletedAdsLog.find((e) => e.id === data.id);
        if (entry2 && isReady) {
          botSendingMedia = Date.now();
          const meta7 = await sock.groupMetadata(entry2.grupId);
          if (entry2.medyaData && entry2.medyaMimetype) {
            const buffer = Buffer.from(entry2.medyaData, 'base64');
            const caption = (entry2.mesaj || '').replace(/^📷 \[Resimli ilan\]\s*/, '').replace(/\(yazı yok\)/, '').trim();
            await sock.sendMessage(entry2.grupId, { image: buffer, caption: caption || undefined });
          } else {
            const temiz = (entry2.mesaj || '').replace(/^📷 \[Resimli ilan\]\s*/, '').replace(/\(yazı yok\)/, '').trim();
            if (temiz) await sock.sendMessage(entry2.grupId, { text: temiz });
          }
          await sock.sendMessage(entry2.grupId, { text: `Bu ilan reklam / hizmet paylaşımıdır\nReklam ücreti alınmış, grup kuralları kapsamında onaylanarak yayınlanmıştır.\n\n${meta7.subject.toUpperCase()} YÖNETİM` });
          deletedAdsLog = deletedAdsLog.filter((e) => e.id !== data.id);
          saveDeletedLog();
          send('restore_done', { id: data.id });
        }
        break;

      case 'clear_logs':
        deletedAdsLog = [];
        saveDeletedLog();
        break;

      case 'clear_media_cache':
        let cleared = 0;
        deletedAdsLog.forEach((e) => { if (e.medyaData) { e.medyaData = null; cleared++; } });
        saveDeletedLog();
        send('cache_cleared', { cleared });
        break;

      case 'set_automation':
        if (config.automation.hasOwnProperty(data.type)) {
          config.automation[data.type] = data.enabled;
          saveConfig();
        }
        break;

      case 'set_delete_delay':
        config.deleteDelay = data.seconds * 1000;
        saveConfig();
        break;

      case 'set_rule_interval':
        config.ruleIntervalHours = data.hours;
        saveConfig();
        startRuleReminder();
        break;

      case 'set_custom_rule':
        config.customRuleMessage = data.message || null;
        saveConfig();
        break;

      case 'restart':
        if (sock) { sock.end(); sock = null; }
        isReady = false;
        setTimeout(() => connect(), 2000);
        break;
    }
  } catch (e) {
    send('error', { message: e.message });
  }
});

send('engine_ready', {});
