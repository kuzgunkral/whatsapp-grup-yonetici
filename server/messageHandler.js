/**
 * messageHandler.js
 * WhatsApp grup mesaj kuralları — modüler yapı
 * Her kural kendi fonksiyonunda, bağımsız çalışır.
 */

// ─── FIYAT ALGILAMA ─────────────────────────────────────────────────────────
function hasFiyatMi(text) {
  if (!text) return false;

  // Türkçe yazılı rakamlar (bir, iki, üç ... dokuz yüz bin milyon)
  const YAZILI_SAYI = '(?:bir|iki|üç|uc|dort|dört|bes|beş|alti|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|kırk|elli|altmis|altmış|yetmiş|yetmis|seksen|doksan|yüz|yuz|bin|milyon|milyar)';
  const yaziliSayiRegex = new RegExp(
    `(\\d+|${YAZILI_SAYI})(\\s*(\\d+|${YAZILI_SAYI}))*\\s*(tl|lira|₺|bin|milyon|milyar|k)(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)`,
    'i'
  );

  return (
    // "5 TL", "500tl", "5milyon", "5 milyon" vb. — rakam + birim
    /\d+[\.,]?\d*\s*(tl|lira|₺|milyon|milyar|son)/i.test(text) ||
    // "5k" veya "5 k" — word boundary olmadan (bin kısaltması)
    /\d+[\.,]?\d*\s*k(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    // "5bin", "5 bin", "10bin", "10 bin" — boşluklu/boşuksuz her iki yazım
    /\d+[\.,]?\d*\s*bin(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    // "5m", "5 m" — milyon kısaltması
    /\d+[\.,]?\d*\s*m(?=[^a-zA-ZğüşıöçĞÜŞİÖÇ]|$)/i.test(text) ||
    // Yazılı Türkçe sayı + birim: "beş bin", "iki milyon", "üç yüz bin tl", "bir bin lira"
    yaziliSayiRegex.test(text) ||
    // Sadece "bin", "iki bin", "üç bin" gibi — birden fazla yazılı sayı
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
// Her resim için imgCount artar.
// imgCount > 10 → anında sil
// imgCount <= 10 → 30sn bekle, o resmin caption'ında fiyat yoksa sil
// spamTracker[userId] = { imgCount, imgCountReset }
async function kuralResim({ sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText, spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config }) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  if (!spamTracker[userId]) spamTracker[userId] = { imgCount: 0, warn10Time: 0, windowStart: Date.now() };
  const t = spamTracker[userId];

  // Toplu gönderim penceresi kapandıysa sayacı sıfırla (yeni gönderim başlıyor)
  if (t.windowStart && (Date.now() - t.windowStart > WAIT_MS + 2000)) {
    t.imgCount = 0;
    t.windowStart = Date.now();
  }
  if (!t.windowStart) t.windowStart = Date.now();

  t.imgCount++;

  // 10'u aştı → uyarı (saatlik 1 kez) + anında sil
  if (t.imgCount > 10) {
    if (!t.warn10Time || (Date.now() - t.warn10Time > ONE_HOUR)) {
      t.warn10Time = Date.now();
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${(realUserId||userId).split('@')[0]} 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_`,
          mentions: [realUserId || userId]
        });
      } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [10+RESİM] user=${userId} count=${t.imgCount}`);

    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: userName || userPhone,
      telefon: userPhone,
      userId,
      grupId: chatId,
      grup: groupName,
      mesaj: msgText || '',
      sebep: '10+ resim (anında silindi)',
      topluAdet: 1,
      medyaData: mediaInfo ? mediaInfo.data : null,
      medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: msgText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    return 'deleted';
  }

  // 10 veya altında → 30sn bekle, caption'da fiyat yoksa sil
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;

  // Medyayı BEKLETME — sadece silme kararı verilince indir (bellek tasarrufu)
  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    if (hasFiyatMi(delText)) { return; }

    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}

    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [30SN-SİL] user=${delUserId} caption="${(delText||'').substring(0,30)}"`);

    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName || delUserPhone,
      telefon: delUserPhone,
      userId: delUserId,
      grupId: delChatId,
      grup: delGroupName,
      mesaj: delText || '',
      sebep: 'Fiyatsız resim (30sn)',
      topluAdet: 1,
      medyaData: mediaInfo ? mediaInfo.data : null,
      medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, WAIT_MS);

  return 'waiting';
}

// ─── KURAL 3: FIYATLI İLAN SONRASI 5DK SPAM KURAL ───────────────────────────
// Fiyatlı ilan muaf alınınca paidTime kaydedilir.
// 5dk içinde gelen her resim anında silinir (fiyatlı veya fiyatsız fark etmez).
// Tamamen bağımsız — kural1 ve kural2 tracker'larına dokunmaz.
// spam5dkTracker[userId] = { paidTime }
const spam5dkTracker = {};

function kural3SetPaidTime(userId) {
  spam5dkTracker[userId] = { paidTime: Date.now() };
}

async function kural3Check({ sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText, stats, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config }) {
  const now = Date.now();
  const FIVE_MIN = (config.adIntervalMin || 5) * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  const tracker = spam5dkTracker[userId];
  if (!tracker || !tracker.paidTime) return 'continue';
  if (now - tracker.paidTime > FIVE_MIN) {
    // 5dk geçti — temizle
    delete spam5dkTracker[userId];
    return 'continue';
  }

  // 5dk içinde → saatlik 1 kez uyarı gönder + anında sil
  if (!tracker.warnedTime || (now - tracker.warnedTime > ONE_HOUR)) {
    tracker.warnedTime = now;
    try {
      await sock.sendMessage(chatId, {
        text: `⚠️ @${(realUserId||userId).split('@')[0]} 5 dakikada yalnızca 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _${groupName} Yönetimi_`,
        mentions: [realUserId || userId]
      });
    } catch(e) {}
  }

  const delKey = getDeleteKey(msg);
  const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
  tryDel(1);
  stats.messagesDeleted++;
  console.log(`🗑️ [5DK-SPAM] user=${userId}`);

  let mediaInfo = null;
  try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
  deletedAdsLog.unshift({
    id: Date.now().toString(),
    tarih: new Date().toLocaleDateString('tr-TR'),
    saat: new Date().toLocaleTimeString('tr-TR'),
    timestamp: new Date().toISOString(),
    kullanici: userName || userPhone,
    telefon: userPhone,
    userId,
    grupId: chatId,
    grup: groupName,
    mesaj: msgText || '',
    sebep: '5dk spam (fiyatlı ilan sonrası)',
    topluAdet: 1,
    medyaData: mediaInfo ? mediaInfo.data : null,
    medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
    medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: msgText || '' }] : []
  });
  if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
  saveDeletedLog();
  io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
  io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  return 'deleted';
}

// ─── KURAL 2: FIYATLI TOPLU RESİM ────────────────────────────────────────────
// Fiyatlı resim gelince:
//   - imgCount sıfırla (kural1 ile karışmasın), yeni sayaç başlat
//   - 10+ → anında sil
//   - ≤10 → 30sn bekle, bu kullanıcının son 30sn resimlerinden herhangi birinde fiyat varsa tüm 10'u muaf tut
// fiyatliResimTracker[userId] = { count, hasFiyat, msgIds: [{key, delKey, msgId}] }
const fiyatliResimTracker = {}; // modül seviyesinde, bağımsız tracker

async function kuralFiyatliResim({ sock, chatId, realUserId, msg, userId, userName, userPhone, groupName, msgText, spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config, kural3SetPaidTime }) {
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // Fiyatlı resim tracker — bu kullanıcı için yeni toplu gönderim başlat veya devam et
  const existingFt = fiyatliResimTracker[userId];
  // Toplu gönderim penceresi kapandıysa sıfırla (yeni bağımsız gönderim başlıyor)
  if (!existingFt || (existingFt.windowStart && Date.now() - existingFt.windowStart > WAIT_MS + 2000)) {
    fiyatliResimTracker[userId] = {
      count: 0,
      hasFiyat: false,
      pendingMsgs: [],
      warn10Time: existingFt ? existingFt.warn10Time : 0,
      cleanupScheduled: false,
      windowStart: Date.now()
    };
  }
  const ft = fiyatliResimTracker[userId];
  ft.count++;
  if (hasFiyatMi(msgText)) ft.hasFiyat = true;

  // 10+ → uyarı (saatlik 1 kez) + anında sil
  if (ft.count > 10) {
    if (!ft.warn10Time || (Date.now() - ft.warn10Time > ONE_HOUR)) {
      ft.warn10Time = Date.now();
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${(realUserId||userId).split('@')[0]} 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_`,
          mentions: [realUserId || userId]
        });
      } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [FIYATLI-10+] user=${userId} count=${ft.count}`);
    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: userName || userPhone,
      telefon: userPhone,
      userId,
      grupId: chatId,
      grup: groupName,
      mesaj: msgText || '',
      sebep: 'Fiyatlı resim 10+ (anında silindi)',
      topluAdet: 1,
      medyaData: mediaInfo ? mediaInfo.data : null,
      medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: msgText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    return 'deleted';
  }

  // ≤10 → pending listeye ekle, 30sn sonra karar ver
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;

  // Medyayı sadece silme kararı verilirse indir — bellek tasarrufu
  ft.pendingMsgs.push({ delKey, delMsgId, delText, delChatId, msg });

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    // Bu kullanıcının tracker'ında fiyat varsa → muaf tut (tüm toplu gönderim korunur)
    const tracker = fiyatliResimTracker[delUserId];
    if (tracker && tracker.hasFiyat) {
      console.log(`[FIYATLI-MUAF] user=${delUserId} hasFiyat=true → koru`);
      return;
    }
    // Fiyat yok → önce medyayı indir, sonra sil
    let mediaInfo = null;
    try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}
    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName || delUserPhone,
      telefon: delUserPhone,
      userId: delUserId,
      grupId: delChatId,
      grup: delGroupName,
      mesaj: delText || '',
      sebep: 'Fiyatlı resim fiyatsız bulundu (30sn)',
      topluAdet: 1,
      medyaData: mediaInfo ? mediaInfo.data : null,
      medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
      medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, WAIT_MS);

  // Cleanup timer sadece 1 kez planlanır — her resim için ayrı timer açılmasın.
  // İlk timer tracker'ı silerdi, sonraki resimler hasFiyat göremezdi → hepsi silinirdi.
  if (!ft.cleanupScheduled) {
    ft.cleanupScheduled = true;
    setTimeout(() => {
      const tracker = fiyatliResimTracker[delUserId];
      if (tracker && tracker.hasFiyat) {
        if (typeof kural3SetPaidTime === 'function') kural3SetPaidTime(delUserId);
      }
      delete fiyatliResimTracker[delUserId];
    }, WAIT_MS + 1000);
  }

  return 'waiting';
}

// ─── KURAL: FIYATSIZ METİN İLANI ─────────────────────────────────────────────
// 1. kez: grup içinde @mention uyarı + deleteDelay sonra sil
// 2. kez (15dk içinde): sessiz anında sil
async function kuralFiyatsizMetin({ sock, chatId, realUserId, groupName, msg, userId, userName, userPhone, msgText, hasMedia, noPriceCounter, deletedAdsLog, saveDeletedLog, io, stats, getDeleteKey, downloadMediaMessage, reklamMuafMsgIds, config }) {
  if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
  const quota = noPriceCounter[userId];
  if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

  const delKey = getDeleteKey(msg);
  const msgId = msg.key.id;

  if (quota.warned) {
    // 2. kez: anında sessiz sil
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    let mediaInfo2 = null;
    try { if (hasMedia) mediaInfo2 = await downloadMediaMessage(msg); } catch(e) {}
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: userName || userPhone,
      telefon: userPhone,
      userId,
      grupId: chatId,
      grup: groupName,
      mesaj: msgText || '(ilan)',
      sebep: 'Fiyatsız ilan (sessiz)',
      topluAdet: 1,
      medyaData: mediaInfo2 ? mediaInfo2.data : null,
      medyaMimetype: mediaInfo2 ? mediaInfo2.mimetype : null,
      medyaListesi: mediaInfo2 ? [{ data: mediaInfo2.data, mimetype: mediaInfo2.mimetype, caption: msgText || '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
    return 'deleted';
  }

  // 1. kez: grup içinde @mention uyarı (DM değil)
  quota.warned = true;
  quota.warnedTime = Date.now();
  try {
    await sock.sendMessage(chatId, {
      text: `⚠️ @${realUserId.split('@')[0]} İlanınıza fiyat girmediniz. ${Math.round((config.deleteDelay || 60000) / 1000)} saniye içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_`,
      mentions: [realUserId]
    });
  } catch(e) {}

  let mediaInfo3 = null;
  try { if (hasMedia) mediaInfo3 = await downloadMediaMessage(msg); } catch(e) {}

  const delUserId2 = userId;
  const delText2 = msgText;
  const delGroupName2 = groupName;
  const delChatId2 = chatId;
  const delUserPhone2 = userPhone;
  const delUserName2 = userName;

  setTimeout(async () => {
    if (reklamMuafMsgIds.has(msgId)) { reklamMuafMsgIds.delete(msgId); return; }
    const tryDel3 = async (a) => { try { await sock.sendMessage(delChatId2, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel3(a+1), 3000); } };
    tryDel3(1);
    stats.messagesDeleted++;
    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: delUserName2 || delUserPhone2,
      telefon: delUserPhone2,
      userId: delUserId2,
      grupId: delChatId2,
      grup: delGroupName2,
      mesaj: delText2 || '(ilan)',
      sebep: 'Fiyatsız ilan (otomatik)',
      topluAdet: 1,
      medyaData: mediaInfo3 ? mediaInfo3.data : null,
      medyaMimetype: mediaInfo3 ? mediaInfo3.mimetype : null
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName2 || delUserPhone2, group: delGroupName2 });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
  }, config.deleteDelay || 60000);

  return 'warned';
}

module.exports = { hasFiyatMi, kuralResim, kuralFiyatliResim, kural3SetPaidTime, kural3Check, kuralFiyatsizMetin };
