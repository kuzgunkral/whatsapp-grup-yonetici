/**
 * messageHandler.js
 * WhatsApp grup mesaj kuralları — modüler yapı
 * Her kural kendi fonksiyonunda, bağımsız çalışır.
 */

// ─── FIYAT ALGILAMA ─────────────────────────────────────────────────────────
function hasFiyatMi(text) {
  if (!text) return false;
  return (
    /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b|son\b)/i.test(text) ||
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

// ─── KURAL 1: 5 DAKİKADA 1 İLAN LİMİTİ ──────────────────────────────────────
// Aynı kullanıcı 5dk içinde 2. ilan atarsa sil + DM uyarı (1 saatte 1 kez)
async function kural5dkLimit({ sock, chatId, realUserId, groupName, msg, userId, msgText, hasFiyat, spamTracker, stats, getDeleteKey, config }) {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const FIVE_MIN = (config.adIntervalMin || 5) * 60 * 1000;

  if (!spamTracker[userId]) {
    spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, warned10Time: 0, hasPaid: false, paidTime: 0, ozelUyari: false, ozelUyariTime: 0, firstAdTime: 0, adCount: 0 };
  }
  const t = spamTracker[userId];

  // 1 saatte bir uyarı flag'lerini sıfırla
  if (now - t.warned10Time > ONE_HOUR) t.warned10 = false;
  if (now - t.ozelUyariTime > ONE_HOUR) t.ozelUyari = false;

  // Dönem geçtiyse sıfırla
  if (now - t.firstAdTime > FIVE_MIN) {
    t.count = 0;
    t.hasPaid = false;
    t.adCount = 0;
  }

  t.count++;
  t.lastTime = now;

  // İlk ilan başlangıcı
  if (t.adCount === 0) {
    t.adCount = 1;
    t.firstAdTime = now;
  }

  // 5sn içinde gelenler aynı toplu ilan
  const isPartOfFirst = (now - t.firstAdTime < 5000);

  // Fiyat varsa hasPaid işaretle
  if (hasFiyat) {
    t.hasPaid = true;
    t.paidTime = now;
  }

  // 2. ilan (5sn'den sonra, adInterval'dan önce)
  if (!isPartOfFirst && (now - t.firstAdTime < FIVE_MIN) && t.adCount >= 1) {
    if (hasFiyat) {
      // Fiyatlı resim yeni dönem başlatır
      t.adCount = 1;
      t.firstAdTime = now;
      t.count = 1;
      // hasPaid zaten set edildi — bu resim aşağıdaki kural10'a düşer
      return 'new_period';
    } else {
      t.adCount++;
      if (!t.ozelUyari || (now - t.ozelUyariTime > ONE_HOUR)) {
        t.ozelUyari = true;
        t.ozelUyariTime = now;
        try { await sock.sendMessage(realUserId, { text: `⚠️ ${config.adIntervalMin || 5} dakikada 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}
      }
      const delKey = getDeleteKey(msg);
      const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
      tryDel(1);
      stats.messagesDeleted++;
      return 'deleted';
    }
  }

  return 'continue'; // Bu kural devreye girmedi
}

// ─── KURAL 2: 10 RESİM LİMİTİ (fiyatlı ilanlar için) ───────────────────────
async function kural10Limit({ sock, chatId, realUserId, groupName, msg, userId, spamTracker, stats, getDeleteKey }) {
  const t = spamTracker[userId];
  if (!t || !t.hasPaid) return 'continue';
  if (t.count > 10) {
    if (!t.warned10) {
      t.warned10 = true;
      t.warned10Time = Date.now();
      try { await sock.sendMessage(realUserId, { text: `⚠️ Tek seferde 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    return 'deleted';
  }
  return 'paid_ok'; // Fiyatlı, 10 veya altında → geç
}

// ─── KURAL 3: FIYATSIZ RESİM — 30SN BEKLE, CAPTION'DA FIYAT YOKSA SİL ───────
async function kuralFiyatsizResim({ sock, chatId, msg, userId, userName, userPhone, groupName, msgText, spamTracker, stats, reklamMuafMsgIds, deletedAdsLog, saveDeletedLog, io, getDeleteKey, downloadMediaMessage, config }) {
  const t = spamTracker[userId];
  const WAIT_MS = (config.photoWaitSec || 30) * 1000;

  // Fiyatsız ama 10+ → anında sil
  if (t && t.count > 10) {
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    return 'deleted';
  }

  // Fiyatsız, ilk 10 → WAIT_MS bekle, sonra caption'da fiyat yoksa sil
  const delKey = getDeleteKey(msg);
  const delMsgId = msg.key.id;
  const delText = msgText;
  const delUserId = userId;
  const delChatId = chatId;
  const delGroupName = groupName;
  const delUserPhone = userPhone;
  const delUserName = userName;

  // Resmi hemen indir (WAIT_MS sonra mesaj silinmiş olabilir)
  let mediaInfo = null;
  try { mediaInfo = await downloadMediaMessage(msg); } catch(e) {}

  setTimeout(() => {
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    // Caption'da fiyat varsa koru
    if (hasFiyatMi(delText)) return;

    const tryDel = async (a) => { try { await sock.sendMessage(delChatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;

    // Loglama: aynı kullanıcıdan 60sn içinde silinenleri birleştir
    const existingLog = deletedAdsLog.find(l =>
      l.grupId === delChatId &&
      (Date.now() - new Date(l.timestamp).getTime() < 60000) &&
      (l.userId === delUserId || (delUserPhone && l.telefon === delUserPhone))
    );
    if (existingLog) {
      existingLog.topluAdet = (existingLog.topluAdet || 1) + 1;
      if (delText) existingLog.mesaj = delText.substring(0, 100);
      if (mediaInfo) {
        if (!existingLog.medyaListesi) existingLog.medyaListesi = [];
        existingLog.medyaListesi.push({ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' });
        if (!existingLog.medyaData) { existingLog.medyaData = mediaInfo.data; existingLog.medyaMimetype = mediaInfo.mimetype; }
      }
    } else {
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
        mesaj: delText || '(Resimli ilan)',
        sebep: 'Fiyatsız ilan (otomatik)',
        topluAdet: 1,
        medyaData: mediaInfo ? mediaInfo.data : null,
        medyaMimetype: mediaInfo ? mediaInfo.mimetype : null,
        medyaListesi: mediaInfo ? [{ data: mediaInfo.data, mimetype: mediaInfo.mimetype, caption: delText || '' }] : []
      });
    }
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: delUserName || delUserPhone, group: delGroupName });
  }, WAIT_MS);

  return 'waiting';
}

// ─── KURAL 4: FIYATSIZ METİN İLANI ──────────────────────────────────────────
// 1. kez: DM uyarı + deleteDelay sonra sil
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
      medyaMimetype: mediaInfo2 ? mediaInfo2.mimetype : null
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: userName || userPhone, group: groupName });
    return 'deleted';
  }

  // 1. kez: DM uyarı + config.deleteDelay sonra sil
  quota.warned = true;
  quota.warnedTime = Date.now();
  try { await sock.sendMessage(realUserId, { text: `⚠️ İlanınıza fiyat girmediniz. ${Math.round((config.deleteDelay || 60000) / 1000)} saniye içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _${groupName} Yönetimi_` }); } catch(e) {}

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
  }, config.deleteDelay || 60000);

  return 'warned';
}

module.exports = { hasFiyatMi, kural5dkLimit, kural10Limit, kuralFiyatsizResim, kuralFiyatsizMetin };
