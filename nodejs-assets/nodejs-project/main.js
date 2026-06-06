var rn_bridge = require('rn-bridge');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

// crypto polyfill for Baileys
if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}
if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = crypto.webcrypto ? crypto.webcrypto.subtle : undefined;
}
if (!globalThis.crypto.subtle) {
  // Fallback: use crypto.webcrypto
  try {
    var webcrypto = require('crypto').webcrypto;
    globalThis.crypto = webcrypto;
  } catch(e) {}
}

var sock = null;
var isReady = false;
var botStartTime = 0;
var connectedGroups = [];
var activeGroupId = null;
var spamTracker = {};
var pausedGroups = {};
var mutedUsers = {};
var noPriceCounter = {};
var config = { automation: { welcome: true, noPrice: true, rules: true }, deleteDelay: 60000, ruleIntervalHours: 6, customRuleMessage: null };
var stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
var deletedAdsLog = [];

var AUTH_DIR = path.join(rn_bridge.app.datadir(), 'baileys-auth');
var LOG_FILE = path.join(rn_bridge.app.datadir(), 'deleted-ads-log.json');
var CONFIG_FILE = path.join(rn_bridge.app.datadir(), 'bot-config.json');

function send(event, data) {
  rn_bridge.channel.send(JSON.stringify({ event: event, data: data || {} }));
}

function loadDeletedLog() { try { if (fs.existsSync(LOG_FILE)) deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {} }
function saveDeletedLog() { try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch(e) {} }
function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {} }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch(e) {} }

async function connect(phoneNumber) {
  try {
    loadDeletedLog();
    loadConfig();
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    var baileys = await import('@whiskeysockets/baileys');
    var makeWASocket = baileys.default;
    var useMultiFileAuthState = baileys.useMultiFileAuthState;
    var DisconnectReason = baileys.DisconnectReason;
    var makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;

    var pino;
    try { pino = require('pino'); } catch(e) { pino = function() { return { level: 'silent' }; }; }

    var authState = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: { creds: authState.state.creds, keys: makeCacheableSignalKeyStore(authState.state.keys, pino({ level: 'silent' })) },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Grup Yonetici', 'Android', '1.0.0'],
      syncFullHistory: false,
    });

    if (!authState.state.creds.registered && phoneNumber) {
      setTimeout(async function() {
        try {
          var code = await sock.requestPairingCode(phoneNumber);
          send('pairing_code', { code: code });
        } catch(e) { send('error', { message: 'Pairing code hatasi: ' + e.message }); }
      }, 3000);
    }

    sock.ev.on('creds.update', authState.saveCreds);

    sock.ev.on('connection.update', function(update) {
      if (update.connection === 'close') {
        isReady = false;
        var code = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output ? update.lastDisconnect.error.output.statusCode : null;
        // Pairing sureci devam ediyorsa reconnect yapma
        if (code === 405 || code === 515) {
          // Pairing icin normal kapanis, bekle
          return;
        }
        send('status', { connected: false });
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(function() { connect(); }, 5000);
        } else {
          send('logged_out', {});
        }
      }
      if (update.connection === 'open') {
        isReady = true;
        botStartTime = Math.floor(Date.now() / 1000);
        send('status', { connected: true });
        loadGroups();
      }
    });

    sock.ev.on('messages.upsert', function(m) {
      if (m.type !== 'notify') return;
      for (var i = 0; i < m.messages.length; i++) { handleMessage(m.messages[i]); }
    });

    sock.ev.on('group-participants.update', function(update) {
      if (!config.automation.welcome || update.action !== 'add') return;
      handleGroupJoin(update);
    });

  } catch(e) {
    send('error', { message: 'Baglanti hatasi: ' + e.message });
  }
}

async function loadGroups() {
  try {
    var groups = await sock.groupFetchAllParticipating();
    connectedGroups = Object.values(groups).map(function(g) { return { id: g.id, name: g.subject }; });
    send('groups', { groups: connectedGroups });
  } catch(e) {}
}

async function handleGroupJoin(update) {
  try {
    var meta = await sock.groupMetadata(update.id);
    for (var i = 0; i < update.participants.length; i++) {
      var name = update.participants[i].split('@')[0];
      await sock.sendMessage(update.id, { text: '\u{1F44B} Ho\u015f geldin *' + name + '*!\n\nGrubumuza kat\u0131ld\u0131\u011f\u0131n i\u00e7in te\u015fekkürler \u{1F389}\n\n\u{1F4CC} *Hat\u0131rlatma:*\n\u2022 \u0130lan verirken fiyat belirtin\n\u2022 Sayg\u0131l\u0131 olal\u0131m\n\n_\u0130yi al\u0131\u015fveri\u015fler!_ \u{1F6D2}\n\u{1F6E1}\uFE0F _' + meta.subject + ' Y\u00f6netimi_' });
      stats.welcomesSent++;
      send('log', { type: 'welcome', user: name, group: meta.subject });
    }
  } catch(e) {}
}

async function handleMessage(msg) {
  try {
    if (msg.messageTimestamp && msg.messageTimestamp < botStartTime - 5) return;
    var chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return;
    if (pausedGroups[chatId]) return;
    if (activeGroupId && chatId !== activeGroupId) return;

    var isFromMe = msg.key.fromMe;
    var msgText = '';
    if (msg.message) {
      msgText = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || (msg.message.imageMessage && msg.message.imageMessage.caption) || (msg.message.videoMessage && msg.message.videoMessage.caption) || '';
    }
    var hasMedia = !!(msg.message && (msg.message.imageMessage || msg.message.videoMessage));

    if (isFromMe && msgText && (msgText.indexOf('Grup Y\u00f6netimi') >= 0 || msgText.indexOf('tespit edildi') >= 0)) return;

    var userId = msg.key.participant || msg.key.remoteJid;
    var isAdmin = false;
    if (isFromMe) isAdmin = true;
    try {
      var meta = await sock.groupMetadata(chatId);
      var p = meta.participants.find(function(x) { return x.id === userId; });
      if (p && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
    } catch(e) {}

    if (mutedUsers[userId] && !isAdmin) {
      try { await sock.sendMessage(chatId, { delete: msg.key }); } catch(e) {}
      return;
    }

    if (!config.automation.noPrice) return;

    var fiyatPattern = /\d+[\.,]?\d*\s*(tl|lira|\u20ba|k\b|bin\b|m\b|milyon\b|milyar\b)/i;
    var fiyatKelime = /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i;
    var fiyatBuyukSayi = /\d{5,}/;
    var fiyatNoktali = /\d{1,3}[\.,]\d{3}/;
    var kmVar = /km/i;
    var hasFiyat = fiyatPattern.test(msgText) || fiyatKelime.test(msgText) || ((fiyatBuyukSayi.test(msgText) || fiyatNoktali.test(msgText)) && !kmVar.test(msgText));

    if (hasFiyat) return;

    var msgLower = msgText.toLowerCase();
    var soruIfadeleri = ['?', ' m\u0131', ' mi', ' mu', ' m\u00fc', 'ne kadar', 'ka\u00e7a', 'var m\u0131', 'sat\u0131ld\u0131'];
    if (!hasMedia) {
      for (var i = 0; i < soruIfadeleri.length; i++) { if (msgLower.indexOf(soruIfadeleri[i]) >= 0) return; }
      var ilanKeywords = ['sat\u0131l\u0131k', 'satilik', 'sat\u0131yorum', 'satiyorum', 'takas', 'devren', 'kiral\u0131k', 'sahibinden', 'acilen', 'temiz', 'sorunsuz'];
      var isIlan = false;
      for (var i = 0; i < ilanKeywords.length; i++) { if (msgLower.indexOf(ilanKeywords[i]) >= 0) { isIlan = true; break; } }
      if (!isIlan) return;
    }

    if (!noPriceCounter[userId]) noPriceCounter[userId] = { warned: false, warnedTime: 0 };
    var quota = noPriceCounter[userId];
    if (Date.now() - quota.warnedTime > 15 * 60 * 1000) quota.warned = false;

    var groupName = chatId;
    try { var gm = await sock.groupMetadata(chatId); groupName = gm.subject; } catch(e) {}

    if (quota.warned) {
      await sock.sendMessage(chatId, { delete: msg.key });
      stats.messagesDeleted++;
      send('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
      return;
    }

    quota.warned = true;
    quota.warnedTime = Date.now();
    await sock.sendMessage(chatId, { text: '\u26A0\uFE0F \u0130lan\u0131n\u0131za fiyat girmediniz. 1 dakika i\u00e7erisinde silinecektir.\nL\u00fctfen fiyat girerek tekrar g\u00f6nderiniz.\n\n\u{1F6E1}\uFE0F _' + groupName + ' Y\u00f6netimi_' });

    var msgKey = msg.key;
    var msgChatId = chatId;
    setTimeout(async function() {
      try { await sock.sendMessage(msgChatId, { delete: msgKey }); } catch(e) {}
      stats.messagesDeleted++;
      send('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
    }, config.deleteDelay);

  } catch(e) {}
}

rn_bridge.channel.on('message', function(raw) {
  try {
    var msg = JSON.parse(raw);
    switch(msg.action) {
      case 'connect': connect(msg.data.phoneNumber); break;
      case 'get_status': send('status', { connected: isReady, stats: stats, groups: connectedGroups }); break;
      case 'set_active_group': activeGroupId = msg.data.groupId || null; break;
      case 'send_rules':
        if (sock && isReady) { sock.groupMetadata(msg.data.groupId).then(function(m) { sock.sendMessage(msg.data.groupId, { text: '\u{1F4E2} *' + m.subject + '*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n\u{1F4CB} *Grup Kurallar\u0131*\n\n\u2022 \u0130lanlar\u0131n\u0131zda mutlaka fiyat belirtin\n\u2022 Ayn\u0131 ilan\u0131 tekrar tekrar atmay\u0131n\n\u2022 Sayg\u0131l\u0131 olal\u0131m\n\n\u26A0\uFE0F Kurallara uymayan ilanlar silinecektir.\n\n\u{1F6E1}\uFE0F Grup Y\u00f6netimi' }); }); }
        break;
      case 'send_message':
        if (sock && isReady) sock.sendMessage(msg.data.groupId, { text: msg.data.message });
        break;
      case 'set_automation':
        if (config.automation.hasOwnProperty(msg.data.type)) { config.automation[msg.data.type] = msg.data.enabled; saveConfig(); }
        break;
      case 'set_delete_delay': config.deleteDelay = msg.data.seconds * 1000; saveConfig(); break;
      case 'set_rule_interval': config.ruleIntervalHours = msg.data.hours; saveConfig(); break;
      case 'get_members':
        if (sock && isReady) { sock.groupMetadata(msg.data.groupId).then(function(m) { send('members', { members: m.participants.map(function(p) { return { id: p.id, number: p.id.split('@')[0], name: p.id.split('@')[0], isAdmin: p.admin === 'admin' || p.admin === 'superadmin' }; }) }); }); }
        break;
      case 'mute_member': mutedUsers[msg.data.memberId] = true; break;
      case 'unmute_member': delete mutedUsers[msg.data.memberId]; break;
      case 'remove_member': if (sock && isReady) sock.groupParticipantsUpdate(msg.data.groupId, [msg.data.memberId], 'remove'); break;
      case 'close_group': if (sock && isReady) sock.groupSettingUpdate(msg.data.groupId, 'announcement'); break;
      case 'open_group': if (sock && isReady) sock.groupSettingUpdate(msg.data.groupId, 'not_announcement'); break;
      case 'pause_group': pausedGroups[msg.data.groupId] = true; break;
      case 'restart':
        if (sock) { sock.end(); sock = null; }
        isReady = false;
        setTimeout(function() { connect(); }, 2000);
        break;
    }
  } catch(e) { send('error', { message: e.message }); }
});

send('engine_ready', {});
