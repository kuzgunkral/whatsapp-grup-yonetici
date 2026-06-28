/**
 * messageHandler.js
 * WhatsApp grup mesaj kuralları — modüler yapı
 * Her kural kendi fonksiyonunda, bağımsız çalışır.
 */

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

// ─── KURAL 1: FIYATSIZ TOPLU RESİM ───────────────────────────────────────────
// Her resim için imgCount artar (pencere bazlı — WAIT_MS+2sn sonra sıfırlanır).
// imgCount > 10 → anında sil
// imgCount <= 10 → WAIT_MS bekle
//   30sn sonunda: caption fiyatlıysa VEYA userActiveBatch.hasFiyat=true ise muaf tut
//   aksi halde sil
// spamTracker[userId] = { imgCount, warn10Time, windowStart }
async function kuralResim({
  sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
  spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io,
  getDeleteKey, downloadMediaMessage, config
}) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  const now = Date.now();
  const POST_WARN_GRACE = 3000; // 10 bırakıldıktan 3sn sonra yeni batch sayılır

  // Tracker yoksa sıfırla
  if (!spamTracker[userId]) {
    spamTracker[userId] = { imgCount: 0, warn10Time: 0, windowStart: now };
  }
  const t = spamTracker[userId];

  // Pencere dolmuşsa sıfırla
  if (now - (t.windowStart || 0) > WAIT_MS + 2000) {
    t.imgCount = 0;
    t.windowStart = now;
  }
  // 10 bırakılıp 3sn geçtiyse → yeni batch: sıfırla ve 30sn bekleme path'ine gir
  else if (t.imgCount >= 10 && t.warn10Time && now - t.warn10Time > POST_WARN_GRACE) {
    t.imgCount = 0;
    t.windowStart = now;
  }

  t.imgCount++;

  // 10+ → uyarı (saatlik 1 kez, global tracker) + anında sil
  if (t.imgCount > 10) {
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
    return 'deleted';
  }

  // ≤10 → WAIT_MS bekle, sonra karar ver (lazy medya)
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    if (hasFiyatMi(delText)) return;

    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [K1-30SN] user=${delUserId} caption="${(delText||'').substring(0,30)}"`);
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName || delUserPhone, telefon: delUserPhone, userId: delUserId,
      grupId: delChatId, grup: delGroupName, mesaj: delText || '',
      sebep: 'Fiyatsız resim (30sn)', topluAdet: 1,
      medyaData: mediaInfo?.data || null, medyaMimetype: mediaInfo?.mimetype || null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, WAIT_MS);

  return 'waiting';
}

// ─── GLOBAL WARN10 TRACKER ────────────────────────────────────────────────────
// Kural 1 ve Kural 2'nin "10+ resim" uyarısı saatlik 1 kez — ortak tracker
const globalWarn10Tracker = {};

// ─── KURAL 3: FIYATLI İLAN SONRASI 5DK SPAM ──────────────────────────────────
// Kural 2 muafiyeti bittikten sonra aktif olur (paidTime set edilince).
// 5dk içinde gelen her resim (fiyatlı/fiyatsız) anında silinir.
// spam5dkTracker[userId] = { paidTime, warnedTime }
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

  // 5dk içinde → saatlik 1 kez uyarı gönder, her seferinde sessiz sil
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
  return 'deleted';
}

// ─── KURAL 2: FIYATLI TOPLU RESİM ────────────────────────────────────────────
// Batch içinde en az 1 fiyatlı resim varsa tüm batch muaf tutulur.
// 10+ resim → anında 10'a düşür (sil)
// ≤10 resim → 30sn bekle → batch fiyatlıysa muaf, değilse sil
// fiyatliResimTracker[userId] = { count, warn10Time, cleanupScheduled, windowStart }
const fiyatliResimTracker = {};

async function kuralFiyatliResim({
  sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText,
  stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io,
  getDeleteKey, downloadMediaMessage, config, kural3SetPaidTime,
  k2BatchHasFiyat, onWarn10
}) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // Tracker yoksa veya pencere dolmuşsa yeni batch başlat
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

  // 10+ → uyarı (saatlik 1 kez, global tracker) + anında sil
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
    return 'deleted';
  }

  // ≤10 → 30sn bekle → batch fiyatlıysa muaf, değilse sil
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;
  // k2BatchHasFiyat snapshot olarak sakla — batch'te fiyatlı resim var mı
  const batchFiyatliSnapshot = k2BatchHasFiyat;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    // Batch fiyatlıysa → muaf tut (snapshot veya tracker'dan)
    if (batchFiyatliSnapshot) {
      console.log(`[K2-MUAF] user=${delUserId} → koru`);
      if (typeof kural3SetPaidTime === 'function') kural3SetPaidTime(delUserId);
      return;
    }
    // Fiyat yok → sil
    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName || delUserPhone, telefon: delUserPhone, userId: delUserId,
      grupId: delChatId, grup: delGroupName, mesaj: delText || '',
      sebep: 'Fiyatlı resim fiyatsız bulundu (30sn)', topluAdet: 1,
      medyaData: mediaInfo?.data || null, medyaMimetype: mediaInfo?.mimetype || null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, WAIT_MS);

  // Cleanup timer sadece 1 kez — 30sn timeout'lardan sonra
  if (!ft.cleanupScheduled) {
    ft.cleanupScheduled = true;
    setTimeout(() => {
      delete fiyatliResimTracker[delUserId];
    }, WAIT_MS + 5000);
  }

  return 'waiting';
}

// ─── KURAL: FIYATSIZ METİN İLANI ─────────────────────────────────────────────
// 1. kez: grup içinde @mention uyarı + deleteDelay sonra sil
// 2. kez (15dk içinde): sessiz anında sil
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

  if (quota.warned) {
    // 2. kez: anında sessiz sil
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 3) setTimeout(() => tryDel(a+1), 5000); } };
    tryDel(1);
    stats.messagesDeleted++;
    let mediaInfo = null;
    try { if (hasMedia) mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: userName || userPhone, telefon: userPhone, userId,
      grupId: chatId, grup: groupName, mesaj: msgText || '(ilan)',
      sebep: 'Fiyatsız ilan (sessiz)', topluAdet: 1,
      medyaData: mediaInfo?.data || null, medyaMimetype: mediaInfo?.mimetype || null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: msgText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    return 'deleted';
  }

  // 1. kez: grup içinde @mention uyarı
  quota.warned = true;
  quota.warnedTime = Date.now();
  try {
    await sock.sendMessage(chatId, {
      text: `⚠️ @${realUserId.split('@')[0]} İlanınıza fiyat girmediniz. ${Math.round((config.deleteDelay || 60000) / 1000)} saniye içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_`,
      mentions: [realUserId]
    });
  } catch(e) {}

  let mediaInfo = null;
  try { if (hasMedia) mediaInfo = await downloadMediaMessage(msg); } catch(e) {}

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
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName2 || delUserPhone2, telefon: delUserPhone2, userId: delUserId2,
      grupId: delChatId2, grup: delGroupName2, mesaj: delText2 || '(ilan)',
      sebep: 'Fiyatsız ilan (otomatik)', topluAdet: 1,
      medyaData: mediaInfo?.data || null, medyaMimetype: mediaInfo?.mimetype || null
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName2 || delUserPhone2, group: delGroupName2 });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, config.deleteDelay || 60000);

  return 'warned';
}

module.exports = { hasFiyatMi, kuralResim, kuralFiyatliResim, kural3SetPaidTime, kural3Check, kuralFiyatsizMetin };
