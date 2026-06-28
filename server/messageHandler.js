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

// ─── KURAL 1: 5 DAKİKADA 1 İLAN LİMİTİ ──────────────────────────────────────
// Aynı kullanıcı 5dk içinde 2. ilan atarsa sil + DM uyarı (1 saatte 1 kez)
async function kural5dkLimit({ sock, chatId, realUserId, groupName, msg, userId, msgText, hasFiyat, spamTracker, stats, getDeleteKey, config, deletedAdsLog, saveDeletedLog, io, downloadMediaMessage }) {
  const now = Date.now();
  const ONE_HOUR = 24 * 60 * 60 * 1000; // 24 saatte 1 DM uyarı
  const FIVE_MIN = (config.adIntervalMin || 5) * 60 * 1000;

  if (!spamTracker[userId]) {
    spamTracker[userId] = { count: 0, lastTime: 0, warned10: false, warned10Time: 0, hasPaid: false, paidTime: 0, ozelUyari: false, ozelUyariTime: 0, firstAdTime: 0, adCount: 0 };
  }
  const t = spamTracker[userId];

  // 1 saatte bir uyarı flag'lerini sıfırla
  if (now - t.warned10Time > ONE_HOUR) t.warned10 = false;
  if (now - t.ozelUyariTime > ONE_HOUR) t.ozelUyari = false;

  // 5dk dönem geçtiyse sıfırla
  if (t.firstAdTime > 0 && now - t.firstAdTime > FIVE_MIN) {
    t.count = 0;
    t.hasPaid = false;
    t.adCount = 0;
    t.firstAdTime = 0;
  }

  t.lastTime = now;

  // İlk resim — dönem başlat, devam et
  if (t.adCount === 0) {
    t.adCount = 1;
    t.firstAdTime = now;
    t.count = 1;
    if (hasFiyat) { t.hasPaid = true; t.paidTime = now; }
    return 'continue';
  }

  // Dönem aktifse count artır
  t.count++;

  // Fiyatlı resim gelince hasPaid set et, firstAdTime güncelle
  if (hasFiyat && !t.hasPaid) {
    t.hasPaid = true;
    t.paidTime = now;
    t.firstAdTime = now;
    t.count = 1;
    return 'continue';
  }
  if (hasFiyat) { t.hasPaid = true; t.paidTime = now; }

  // hasPaid=true ve 5dk içinde → sil
  if (t.hasPaid && t.firstAdTime > 0 && (now - t.firstAdTime < FIVE_MIN)) {
    // Fiyatlı hak kullanıldı, 5dk içinde tekrar resim atıldı → sil
      if (!t.ozelUyari || (now - t.ozelUyariTime > ONE_HOUR)) {
        t.ozelUyari = true;
        t.ozelUyariTime = now;
        // 24 saatte 1 kez — grup içinde @mention uyarı (DM değil)
        try {
          await sock.sendMessage(chatId, {
            text: `⚠️ @${realUserId.split('@')[0]} ${config.adIntervalMin || 5} dakikada 1 ilan atabilirsiniz. Lütfen bekleyiniz.\n\n🛡️ _${groupName} Yönetimi_`,
            mentions: [realUserId]
          });
        } catch(e) {}
      }
      const delKey = getDeleteKey(msg);
      const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
      tryDel(1);
      stats.messagesDeleted++;
      console.log(`🗑️ [5DK-SİL] user=${realUserId} group=${groupName} msg="${(msgText||'').substring(0,40)}"`);

      // Medyayı indir (geri yükleme için)
      let mediaInfo5dk = null;
      if (msg.message?.imageMessage || msg.message?.videoMessage) {
        try { if (downloadMediaMessage) mediaInfo5dk = await downloadMediaMessage(msg); } catch(e) {}
      }

      deletedAdsLog.unshift({
        id: Date.now().toString(),
        tarih: new Date().toLocaleDateString('tr-TR'),
        saat: new Date().toLocaleTimeString('tr-TR'),
        timestamp: new Date().toISOString(),
        kullanici: msg.pushName || realUserId.split('@')[0],
        telefon: realUserId.split('@')[0],
        userId: realUserId,
        grupId: chatId,
        grup: groupName,
        mesaj: msgText || '(ilan)',
        sebep: '5dk spam',
        topluAdet: 1,
        medyaData: mediaInfo5dk ? mediaInfo5dk.data : null,
        medyaMimetype: mediaInfo5dk ? mediaInfo5dk.mimetype : null,
        medyaListesi: mediaInfo5dk ? [{ data: mediaInfo5dk.data, mimetype: mediaInfo5dk.mimetype, caption: msgText || '' }] : []
      });
      if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
      saveDeletedLog();
      io.emit('log', { type: 'deleted', user: msg.pushName || realUserId.split('@')[0], group: groupName });
      io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
      return 'deleted';
  }

  return 'continue'; // Bu kural devreye girmedi
}

// ─── KURAL 2: 10 RESİM LİMİTİ (fiyatlı ilanlar için) ───────────────────────
async function kural10Limit({ sock, chatId, realUserId, groupName, msg, userId, spamTracker, stats, getDeleteKey, deletedAdsLog, saveDeletedLog, io, downloadMediaMessage }) {
  const t = spamTracker[userId];
  if (!t || !t.hasPaid) return 'continue';
  if (t.count > 10) {
    if (!t.warned10) {
      t.warned10 = true;
      t.warned10Time = Date.now();
      // 24 saatte 1 kez — grup içinde @mention uyarı
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${realUserId.split('@')[0]} Tek seferde 10 adetten fazla resim yükleyemezsiniz.\n\n🛡️ _${groupName} Yönetimi_`,
          mentions: [realUserId]
        });
      } catch(e) {}
    }
    const delKey = getDeleteKey(msg);
    const tryDel = async (a) => { try { await sock.sendMessage(chatId, { delete: delKey }); } catch(e) { if (a < 20) setTimeout(() => tryDel(a+1), 3000); } };
    tryDel(1);
    stats.messagesDeleted++;
    console.log(`🗑️ [10RESİM-SİL] user=${realUserId} group=${groupName}`);

    // Medyayı indir
    let mediaInfo10 = null;
    if (msg.message?.imageMessage || msg.message?.videoMessage) {
      try { if (downloadMediaMessage) mediaInfo10 = await downloadMediaMessage(msg); } catch(e) {}
    }

    deletedAdsLog.unshift({
      id: Date.now().toString(),
      tarih: new Date().toLocaleDateString('tr-TR'),
      saat: new Date().toLocaleTimeString('tr-TR'),
      timestamp: new Date().toISOString(),
      kullanici: msg.pushName || realUserId.split('@')[0],
      telefon: realUserId.split('@')[0],
      userId: realUserId,
      grupId: chatId,
      grup: groupName,
      mesaj: '📷 [10+ resim spam]',
      sebep: '10 resim limiti aşıldı',
      topluAdet: 1,
      medyaData: mediaInfo10 ? mediaInfo10.data : null,
      medyaMimetype: mediaInfo10 ? mediaInfo10.mimetype : null,
      medyaListesi: mediaInfo10 ? [{ data: mediaInfo10.data, mimetype: mediaInfo10.mimetype, caption: '' }] : []
    });
    if (deletedAdsLog.length > 500) deletedAdsLog.splice(500);
    saveDeletedLog();
    io.emit('log', { type: 'deleted', user: msg.pushName || realUserId.split('@')[0], group: groupName });
    io.emit('deleted_ads_updated', { total: deletedAdsLog.length });
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
    console.log('[LOG-DEBUG] setTimeout fired, delMsgId=' + delMsgId + ' muaf=' + reklamMuafMsgIds.has(delMsgId) + ' hasFiyat=' + hasFiyatMi(delText));
    if (reklamMuafMsgIds.has(delMsgId)) { reklamMuafMsgIds.delete(delMsgId); return; }
    // Caption'da fiyat varsa koru
    if (hasFiyatMi(delText)) { console.log('[LOG-DEBUG] hasFiyat=true, SKIP LOG'); return; }
    // Aynı toplu fiyatlı ilanın caption'sız resimleri: paidTime<30sn VE adCount=1 (ilk ilan dönemi)
    const tDelCheck = spamTracker[delUserId];
    if (tDelCheck && tDelCheck.hasPaid && tDelCheck.paidTime > 0 &&
        tDelCheck.adCount === 1 &&
        (Date.now() - tDelCheck.paidTime < 30000)) {
      console.log('[LOG-DEBUG] paidTime<30sn+adCount=1, toplu fiyatlı ilanın parçası → koru');
      return;
    }

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
      sebep: 'Fiyatsız ilan (otomatik)',
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

module.exports = { hasFiyatMi, kural5dkLimit, kural10Limit, kuralFiyatsizResim, kuralFiyatsizMetin };
