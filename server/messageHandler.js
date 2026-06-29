/**
 * messageHandler.js
 * WhatsApp grup mesaj kuralları — modüler yapı
 *
 * MEDYA DEPOLAMA:
 *  - Resimler RAM'de base64 olarak saklanmaz (OOM önleme).
 *  - Her silinen resim MEDIA_DIR klasörüne dosya olarak yazılır.
 *  - Log kaydında medyaListesi = [{ file: 'filename.jpg', mimetype, caption }]
 *  - Sunucu /api/media/:filename endpoint'i ile serve eder.
 *  - MEDIA_DIR dışarıdan set edilir (index.js'ten setMediaDir çağrılır).
 *
 * LOG BATCH SİSTEMİ:
 *  - Aynı kullanıcının aynı ilan penceresindeki TÜM silinen resimler
 *    tek bir log kaydında toplanır (batchKey = userId_windowStart).
 *  - Farklı ilanlar → farklı batchKey → farklı log kaydı → karışmaz.
 */

const fs = require('fs');
const path = require('path');

// ─── MEDIA DIR ───────────────────────────────────────────────────────────────
let MEDIA_DIR = null;
function setMediaDir(dir) {
  MEDIA_DIR = dir;
  if (!fs.existsSync(MEDIA_DIR)) {
    try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch(e) {}
  }
}

/**
 * Medyayı diske kaydeder. Başarılıysa { file, mimetype } döner, yoksa null.
 * file = sadece dosya adı (path değil), sunucu /api/media/:file ile serve eder.
 */
async function saveMediaFile(msg, downloadFn, batchKey, index) {
  if (!MEDIA_DIR) return null;
  try {
    if (!msg.message) return null;
    const { downloadMediaMessage } = await import('baileys');
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer) return null;
    let mimetype = 'image/jpeg';
    let ext = 'jpg';
    if (msg.message.imageMessage) { mimetype = msg.message.imageMessage.mimetype || 'image/jpeg'; }
    else if (msg.message.videoMessage) { mimetype = msg.message.videoMessage.mimetype || 'video/mp4'; ext = 'mp4'; }
    else if (msg.message.documentMessage) { mimetype = msg.message.documentMessage.mimetype || 'application/octet-stream'; ext = 'bin'; }
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) ext = 'jpg';
    else if (mimetype.includes('png')) ext = 'png';
    else if (mimetype.includes('webp')) ext = 'webp';
    else if (mimetype.includes('mp4')) ext = 'mp4';
    // Güvenli dosya adı: batchKey içindeki @ ve özel karakterleri temizle
    const safeKey = batchKey.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = `${safeKey}_${index}_${Date.now()}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return { file: filename, mimetype };
  } catch(e) {
    console.error('[saveMediaFile] Hata:', e.message);
    return null;
  }
}

// ─── FIYAT ALGILAMA ─────────────────────────────────────────────────────────
function hasFiyatMi(text) {
  if (!text) return false;
  const YAZILI_SAYI = '(?:bir|iki|üç|uc|dort|dört|bes|beş|alti|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|kırk|elli|altmis|altmış|yetmiş|yetmis|seksen|doksan|yüz|yuz|bin|milyon|milyar)';
  const yaziliSayiRegex = new RegExp(
    `(\\d+|${YAZILI_SAYI})(\\s*(\\d+|${YAZILI_SAYI}))*\\s*(tl|lira|₺|bin|milyon|milyar|k)(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)`,
    'i'
  );
  return (
    /\d+[\.,]?\d*\s*(tl|lira|₺|milyon|milyar|son)/i.test(text) ||
    /\d+[\.,]?\d*\s*k(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    /\d+[\.,]?\d*\s*bin(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    /\d+[\.,]?\d*\s*m(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    yaziliSayiRegex.test(text) ||
    /(?:bir|iki|üç|uc|dort|dört|bes|beş|alti|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|kırk|elli|altmis|altmış|yetmiş|yetmis|seksen|doksan)\s+(?:yüz\s+)?(?:bin|milyon|milyar)/i.test(text) ||
    /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i.test(text) ||
    /\d{1,3}([.,]\d{3})+([.,]\d{2})?/.test(text) ||
    (
      (/\d{4,9}/.test(text) || /\d{1,3}[\.,]\d{3}/.test(text)) &&
      !/km/i.test(text) &&
      !/model/i.test(text) &&
      !/kilometre/i.test(text) &&
      !/\d{4,}\s*da\b/i.test(text) &&
      !/\d{4,}\s*de\b/i.test(text) &&
      !/0?5\d{9}/.test(text)
    )
  );
}

// ─── GLOBAL WARN10 TRACKER ────────────────────────────────────────────────────
const globalWarn10Tracker = {};

// ─── BATCH LOG TRACKER ───────────────────────────────────────────────────────
// batchLogTracker[batchKey] = { entry, mediaIndex }
const batchLogTracker = {};

function getOrCreateBatchLog({
  batchKey, deletedAdsLog,
  userId, userName, userPhone, chatId, groupName, sebep
}) {
  if (batchLogTracker[batchKey]) {
    return batchLogTracker[batchKey];
  }
  const entry = {
    id: batchKey,
    tarih: new Date().toLocaleDateString('tr-TR'),
    saat: new Date().toLocaleTimeString('tr-TR'),
    timestamp: new Date().toISOString(),
    kullanici: userName || userPhone,
    telefon: userPhone,
    userId,
    grupId: chatId,
    grup: groupName,
    mesaj: '',
    sebep,
    topluAdet: 0,
    // Medya dosya listesi — base64 değil, dosya adı
    medyaListesi: [],
    // Geriye dönük uyumluluk için (restore endpoint'i okur)
    medyaData: null,
    medyaMimetype: null
  };
  deletedAdsLog.unshift(entry);
  batchLogTracker[batchKey] = { entry, mediaIndex: 0 };
  return batchLogTracker[batchKey];
}

/**
 * Medyayı diske kaydedip batch log'a ekler.
 * Medya kaydedilemezse sadece topluAdet artar (resim olmadan log düşer).
 */
async function addMediaToBatch({ batchKey, msg, caption, deletedAdsLog }) {
  const tracker = batchLogTracker[batchKey];
  if (!tracker) return;
  const { entry } = tracker;

  const mediaResult = await saveMediaFile(msg, null, batchKey, tracker.mediaIndex);
  tracker.mediaIndex++;

  if (mediaResult) {
    entry.medyaListesi.push({ file: mediaResult.file, mimetype: mediaResult.mimetype, caption: caption || '' });
    // İlk dosyayı medyaData olarak da sakla (geriye dönük uyumluluk)
    if (!entry.medyaData) {
      entry.medyaData = mediaResult.file; // artık base64 değil, dosya adı
      entry.medyaMimetype = mediaResult.mimetype;
    }
  }
  entry.topluAdet = (entry.topluAdet || 0) + 1;
  if (!entry.mesaj && caption) entry.mesaj = caption;
  if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
}

// ─── KURAL 1: FIYATSIZ TOPLU RESİM ───────────────────────────────────────────
async function kuralResim({
  sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
  spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io,
  getDeleteKey, downloadMediaMessage, config
}) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  const POST_WARN_GRACE = 3000;

  if (!spamTracker[userId]) {
    spamTracker[userId] = { imgCount: 0, warn10Time: 0, windowStart: now };
  }
  const t = spamTracker[userId];

  if (now - (t.windowStart || 0) > WAIT_MS + 2000) {
    t.imgCount = 0;
    t.windowStart = now;
  } else if (t.imgCount >= 10 && t.warn10Time && now - t.warn10Time > POST_WARN_GRACE) {
    t.imgCount = 0;
    t.windowStart = now;
  }

  t.imgCount++;
  const batchKey = `${userId}_${t.windowStart}`;

  // 10+ → uyarı + anında sil
  if (t.imgCount > 10) {
    if (!t.warn10Time) t.warn10Time = now;
    const gw = globalWarn10Tracker[userId] || 0;
    if (Date.now() - gw > ONE_HOUR) {
      globalWarn10Tracker[userId] = Date.now();
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${(realUserId||userId).split('@')[0]} 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_`,
          mentions: [realUserId || userId]
        });
      } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [K1-10+] user=${userId} count=${t.imgCount}`);

    getOrCreateBatchLog({ batchKey, deletedAdsLog, userId, userName, userPhone, chatId, groupName, sebep: 'Fiyatsız resim (10+ adet)' });
    await addMediaToBatch({ batchKey, msg, caption: msgText, deletedAdsLog });
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    setTimeout(() => { delete batchLogTracker[batchKey]; }, WAIT_MS + 10000);
    return 'deleted';
  }

  // ≤10 → WAIT_MS bekle
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;
  const batchWindowStart = t.windowStart;
  const capturedMsg = msg;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    if (hasFiyatMi(delText)) return;

    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [K1-30SN] user=${delUserId} caption="${(delText||'').substring(0,30)}"`);

    const bKey = `${delUserId}_${batchWindowStart}`;
    getOrCreateBatchLog({ batchKey: bKey, deletedAdsLog, userId: delUserId, userName: delUserName, userPhone: delUserPhone, chatId: delChatId, groupName: delGroupName, sebep: 'Fiyatsız resim (30sn)' });
    await addMediaToBatch({ batchKey: bKey, msg: capturedMsg, caption: delText, deletedAdsLog });
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    setTimeout(() => { delete batchLogTracker[bKey]; }, 10000);
  }, WAIT_MS);

  return 'waiting';
}

// ─── KURAL 3: FIYATLI İLAN SONRASI 5DK SPAM ──────────────────────────────────
const spam5dkTracker = {};

function kural3SetPaidTime(userId) {
  spam5dkTracker[userId] = { paidTime: Date.now() };
}

async function kural3Check({
  sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
  stats, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config
}) {
  const now = Date.now();
  const FIVE_MIN = (config.adIntervalMin || 5) * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  const tracker = spam5dkTracker[userId];
  if (!tracker || !tracker.paidTime) return 'continue';
  if (now - tracker.paidTime > FIVE_MIN) {
    delete spam5dkTracker[userId];
    return 'continue';
  }

  if (!tracker.warnedTime || now - tracker.warnedTime > ONE_HOUR) {
    tracker.warnedTime = now;
    try {
      await sock.sendMessage(chatId, {
        text: `⚠️ @${(realUserId||userId).split('@')[0]} 5 dakikada yalnızca 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _${groupName} Yönetimi_`,
        mentions: [realUserId || userId]
      });
    } catch(e) {}
  }

  const delKey = getDeleteKey(msg);
  const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
  tryDel(1);
  stats.messagesDeleted++;
  console.log(`🗑️ [K3-5DK] user=${userId}`);

  const batchKey = `${userId}_k3_${tracker.paidTime}`;
  getOrCreateBatchLog({ batchKey, deletedAdsLog, userId, userName, userPhone, chatId, groupName, sebep: '5dk spam (Kural 3)' });
  await addMediaToBatch({ batchKey, msg, caption: msgText, deletedAdsLog });
  saveDeletedLog();
  io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
  io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  // K3 batch tracker'ını 5dk sonra temizle (paidTime süresi kadar)
  const FIVE_MIN = (config.adIntervalMin || 5) * 60 * 1000;
  setTimeout(() => { delete batchLogTracker[batchKey]; }, FIVE_MIN + 5000);

  return 'deleted';
}

// ─── KURAL 2: FIYATLI TOPLU RESİM ────────────────────────────────────────────
const fiyatliResimTracker = {};

async function kuralFiyatliResim({
  sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
  stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io,
  getDeleteKey, downloadMediaMessage, config, kural3SetPaidTime,
  k2BatchHasFiyat, onWarn10
}) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  const existingFt = fiyatliResimTracker[userId];
  if (!existingFt || Date.now() - (existingFt.windowStart || 0) > WAIT_MS + 2000) {
    fiyatliResimTracker[userId] = {
      count: 0,
      warn10Time: existingFt?.warn10Time || 0,
      cleanupScheduled: false,
      windowStart: Date.now()
    };
  }
  const ft = fiyatliResimTracker[userId];
  ft.count++;

  const batchKey = `${userId}_k2_${ft.windowStart}`;

  // 10+ → anında sil
  if (ft.count > 10) {
    const gw = globalWarn10Tracker[userId] || 0;
    if (Date.now() - gw > ONE_HOUR) {
      globalWarn10Tracker[userId] = Date.now();
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${(realUserId||userId).split('@')[0]} 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_`,
          mentions: [realUserId || userId]
        });
      } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [K2-10+] user=${userId} count=${ft.count}`);
    if (typeof onWarn10 === 'function') onWarn10(userId);

    getOrCreateBatchLog({ batchKey, deletedAdsLog, userId, userName, userPhone, chatId, groupName, sebep: 'Fiyatlı resim (10+ adet)' });
    await addMediaToBatch({ batchKey, msg, caption: msgText, deletedAdsLog });
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    setTimeout(() => { delete batchLogTracker[batchKey]; }, WAIT_MS + 10000);
    return 'deleted';
  }

  // ≤10 → 30sn bekle
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;
  const batchFiyatliSnapshot = k2BatchHasFiyat;
  const batchWindowStart = ft.windowStart;
  const capturedMsg = msg;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    if (batchFiyatliSnapshot) {
      console.log(`[K2-MUAF] user=${delUserId} → koru`);
      if (typeof kural3SetPaidTime === 'function') kural3SetPaidTime(delUserId);
      return;
    }
    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;

    const bKey = `${delUserId}_k2_${batchWindowStart}`;
    getOrCreateBatchLog({ batchKey: bKey, deletedAdsLog, userId: delUserId, userName: delUserName, userPhone: delUserPhone, chatId: delChatId, groupName: delGroupName, sebep: 'Fiyatlı resim fiyatsız bulundu (30sn)' });
    await addMediaToBatch({ batchKey: bKey, msg: capturedMsg, caption: delText, deletedAdsLog });
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    setTimeout(() => { delete batchLogTracker[bKey]; }, 10000);
  }, WAIT_MS);

  if (!ft.cleanupScheduled) {
    ft.cleanupScheduled = true;
    setTimeout(() => { delete fiyatliResimTracker[userId]; }, WAIT_MS + 5000);
  }

  return 'waiting';
}

// ─── KURAL: FIYATSIZ METİN İLANI ─────────────────────────────────────────────
async function kuralFiyatsizMetin({
  sock, chatId, realUserId, groupName, msg, userId, userName, userPhone, msgText, hasMedia,
  noPriceCounter, deletedAdsLog, saveDeletedLog, io, stats, getDeleteKey, downloadMediaMessage,
  reklamMuafMsgIds, config
}) {
  if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
  const quota = noPriceCounter[userId];
  if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

  const delKey = getDeleteKey(msg);
  const msgId = msg.key.id;
  const batchKey = `${userId}_text_${msgId}`;
  const capturedMsg = msg;

  if (quota.warned) {
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;

    getOrCreateBatchLog({ batchKey, deletedAdsLog, userId, userName, userPhone, chatId, groupName, sebep: 'Fiyatsız ilan (sessiz)' });
    if (hasMedia) await addMediaToBatch({ batchKey, msg: capturedMsg, caption: msgText, deletedAdsLog });
    else { const t = batchLogTracker[batchKey]; if (t) { t.entry.topluAdet++; t.entry.mesaj = msgText || '(ilan)'; } }
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    return 'deleted';
  }

  quota.warned = true;
  quota.warnedTime = Date.now();
  try {
    await sock.sendMessage(chatId, {
      text: `⚠️ @${realUserId.split('@')[0]} İlanınıza fiyat girmediniz. ${Math.round((config.deleteDelay || 60000) / 1000)} saniye içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_`,
      mentions: [realUserId]
    });
  } catch(e) {}

  const delUserId2 = userId;
  const delText2 = msgText;
  const delGroupName2 = groupName;
  const delChatId2 = chatId;
  const delUserPhone2 = userPhone;
  const delUserName2 = userName;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(msgId)) { reklamMuafMsgIds.delete(msgId); return; }
    const tryDel3 = async (a) => { try { await sock.sendMessage(delChatId2, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel3(a+1), 5000); } };
    tryDel3(1);
    stats.messagesDeleted++;

    getOrCreateBatchLog({ batchKey, deletedAdsLog, userId: delUserId2, userName: delUserName2, userPhone: delUserPhone2, chatId: delChatId2, groupName: delGroupName2, sebep: 'Fiyatsız ilan (otomatik)' });
    if (hasMedia) await addMediaToBatch({ batchKey, msg: capturedMsg, caption: delText2, deletedAdsLog });
    else { const t = batchLogTracker[batchKey]; if (t) { t.entry.topluAdet++; t.entry.mesaj = delText2 || '(ilan)'; } }
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName2 || delUserPhone2, group: delGroupName2 });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, config.deleteDelay || 60000);

  return 'warned';
}

/**
 * POST-WARN bloğundan çağrılabilen standalone medya kaydetme fonksiyonu.
 * index.js'in MEDIA_DIR'ini kullanır (setMediaDir ile set edilmeli).
 */
async function saveMediaToDir(msg, batchKey, index) {
  return saveMediaFile(msg, null, batchKey, index);
}

/**
 * K3 (5dk spam) tracker'ının aktif olup olmadığını döner.
 * index.js POST-WARN bloğunda K3'e mi yoksa K1'e mi yazılacağını belirlemek için kullanılır.
 */
function getK3PaidTime(userId) {
  const tracker = spam5dkTracker[userId];
  if (!tracker || !tracker.paidTime) return null;
  return tracker.paidTime;
}

module.exports = {
  hasFiyatMi,
  kuralResim,
  kuralFiyatliResim,
  kural3SetPaidTime,
  kural3Check,
  kuralFiyatsizMetin,
  setMediaDir,
  saveMediaToDir,
  getK3PaidTime
};
