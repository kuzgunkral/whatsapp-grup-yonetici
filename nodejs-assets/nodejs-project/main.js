var rn_bridge = require('rn-bridge');
var path = require('path');
var fs = require('fs');

// Baileys lazy load — crash olursa yakalanır
var makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore;
try {
  var baileys = require('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
} catch(e) {
  send('error', { message: 'Baileys yuklenemedi: ' + e.message });
}

var pino;
try { pino = require('pino'); } catch(e) { pino = function() { return { level: 'silent' }; }; }

// State
var sock = null;
var isReady = false;
var botStartTime = 0;
var connectedGroups = [];
var activeGroupId = null;
var spamTracker = {};
var pausedGroups = {};
var mutedUsers = {};
var noPriceCounter = {};
var noPriceTimers = {};
var reklamMuafMsgIds = {};
var botSendingMedia = 0;
var deletedAdsLog = [];
var stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
var config = { automation: { welcome: true, noPrice: true, rules: true }, deleteDelay: 60000, ruleIntervalHours: 6, customRuleMessage: null };

var AUTH_DIR = path.join(rn_bridge.app.datadir(), 'baileys-auth');
var LOG_FILE = path.join(rn_bridge.app.datadir(), 'deleted-ads-log.json');
var CONFIG_FILE = path.join(rn_bridge.app.datadir(), 'bot-config.json');

function send(event, data) {
  rn_bridge.channel.send(JSON.stringify({ event: event, data: data || {} }));
}

function loadDeletedLog() {
  try { if (fs.existsSync(LOG_FILE)) deletedAdsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
}

function saveDeletedLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(deletedAdsLog), 'utf8'); } catch(e) {}
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf8'); } catch(e) {}
}

// Connect
async function connect(phoneNumber) {
  try {
    loadDeletedLog();
    loadConfig();

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    var version = (await fetchLatestBaileysVersion()).version;
    var authState = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version: version,
      auth: {
        creds: authState.state.creds,
        keys: makeCacheableSignalKeyStore(authState.state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Grup Yonetici', 'Android', '1.0.0'],
      syncFullHistory: false,
    });

    // Pairing code
    if (!authState.state.creds.registered && phoneNumber) {
      var code = await sock.requestPairingCode(phoneNumber);
      send('pairing_code', { code: code });
    }

    sock.ev.on('creds.update', authState.saveCreds);

    sock.ev.on('connection.update', function(update) {
      var connection = update.connection;
      var lastDisconnect = update.lastDisconnect;

      if (connection === 'close') {
        isReady = false;
        send('status', { connected: false });
        var code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : null;
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(function() { connect(); }, 5000);
        } else {
          send('logged_out', {});
        }
      }

      if (connection === 'open') {
        isReady = true;
        botStartTime = Math.floor(Date.now() / 1000);
        send('status', { connected: true });
        loadGroups();
      }
    });

    sock.ev.on('messages.upsert', function(m) {
      if (m.type !== 'notify') return;
      for (var i = 0; i < m.messages.length; i++) {
        handleMessage(m.messages[i]);
      }
    });

    sock.ev.on('group-participants.update', function(update) {
      if (!config.automation.welcome) return;
      if (update.action !== 'add') return;
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
      var welcomeMsg = '👋 Hoş geldin *' + name + '*!\n\nGrubumuza katıldığın için teşekkürler 🎉\n\n📌 *Hatırlatma:*\n• İlan verirken fiyat belirtin\n• Saygılı olalım\n• Konu dışı mesaj atmayalım\n\n_İyi alışverişler!_ 🛒\n🛡️ _' + meta.subject + ' Yönetimi_';
      await sock.sendMessage(update.id, { text: welcomeMsg });
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
    var msgText = (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || (msg.message.imageMessage && msg.message.imageMessage.caption) || (msg.message.videoMessage && msg.message.videoMessage.caption))) || '';
    var hasMedia = !!(msg.message && (msg.message.imageMessage || msg.message.videoMessage));

    if (isFromMe && msgText && (msgText.indexOf('Grup Yönetimi') >= 0 || msgText.indexOf('tespit edildi') >= 0)) return;

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

    // Fiyat algilama
    var fiyatPattern = /\d+[\.,]?\d*\s*(tl|lira|₺|k\b|bin\b|m\b|milyon\b|milyar\b)/i;
    var fiyatKelime = /(fiyat|tane|adet)\s*:?\s*\d+[\.,]?\d*|\d+[\.,]?\d*\s*(fiyat|tane|adet)/i;
    var fiyatBuyukSayi = /\d{5,}/;
    var fiyatNoktali = /\d{1,3}[\.,]\d{3}/;
    var kmVar = /km/i;
    var hasFiyat = fiyatPattern.test(msgText) || fiyatKelime.test(msgText) || ((fiyatBuyukSayi.test(msgText) || fiyatNoktali.test(msgText)) && !kmVar.test(msgText));

    if (hasFiyat) return;

    // Soru filtresi
    var msgLower = msgText.toLowerCase();
    var soruIfadeleri = ['?', ' mı', ' mi', ' mu', ' mü', 'ne kadar', 'kaça', 'var mı', 'satıldı'];
    if (!hasMedia) {
      for (var i = 0; i < soruIfadeleri.length; i++) {
        if (msgLower.indexOf(soruIfadeleri[i]) >= 0) return;
      }
      var ilanKeywords = ['satılık', 'satilik', 'satıyorum', 'satiyorum', 'takas', 'devren', 'kiralık', 'sahibinden', 'acilen', 'temiz', 'sorunsuz'];
      var isIlan = false;
      for (var i = 0; i < ilanKeywords.length; i++) {
        if (msgLower.indexOf(ilanKeywords[i]) >= 0) { isIlan = true; break; }
      }
      if (!isIlan) return;
    }

    // Fiyatsiz ilan
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
    await sock.sendMessage(chatId, { text: '⚠️ İlanınıza fiyat girmediniz. 1 dakika içerisinde silinecektir.\nLütfen fiyat girerek tekrar gönderiniz.\n\n🛡️ _' + groupName + ' Yönetimi_' });

    var msgKey = msg.key;
    setTimeout(async function() {
      try { await sock.sendMessage(chatId, { delete: msgKey }); } catch(e) {}
      stats.messagesDeleted++;
      send('log', { type: 'deleted', user: userId.split('@')[0], group: groupName });
    }, config.deleteDelay);

  } catch(e) {}
}

// RN Bridge listener
rn_bridge.channel.on('message', function(raw) {
  try {
    var msg = JSON.parse(raw);
    switch(msg.action) {
      case 'connect': connect(msg.data.phoneNumber); break;
      case 'get_status': send('status', { connected: isReady, stats: stats, groups: connectedGroups }); break;
      case 'set_active_group': activeGroupId = msg.data.groupId || null; break;
      case 'send_rules':
        if (sock && isReady) {
          sock.groupMetadata(msg.data.groupId).then(function(m) {
            sock.sendMessage(msg.data.groupId, { text: '📢 *' + m.subject + '*\n━━━━━━━━━━━━━━━━\n\n📋 *Grup Kuralları*\n\n• İlanlarınızda mutlaka fiyat belirtin\n• Aynı ilanı tekrar tekrar atmayın\n• Saygılı olalım\n\n⚠️ Kurallara uymayan ilanlar silinecektir.\n\n🛡️ Grup Yönetimi' });
          });
        }
        break;
      case 'send_message':
        if (sock && isReady) sock.sendMessage(msg.data.groupId, { text: '✦══════ ' + msg.data.message + ' ══════✦' });
        break;
      case 'set_automation':
        if (config.automation.hasOwnProperty(msg.data.type)) { config.automation[msg.data.type] = msg.data.enabled; saveConfig(); }
        break;
      case 'set_delete_delay': config.deleteDelay = msg.data.seconds * 1000; saveConfig(); break;
      case 'set_rule_interval': config.ruleIntervalHours = msg.data.hours; saveConfig(); break;
      case 'get_members':
        if (sock && isReady) {
          sock.groupMetadata(msg.data.groupId).then(function(m) {
            var members = m.participants.map(function(p) { return { id: p.id, number: p.id.split('@')[0], name: p.id.split('@')[0], isAdmin: p.admin === 'admin' || p.admin === 'superadmin' }; });
            send('members', { members: members });
          });
        }
        break;
      case 'mute_member': mutedUsers[msg.data.memberId] = true; break;
      case 'unmute_member': delete mutedUsers[msg.data.memberId]; break;
      case 'remove_member':
        if (sock && isReady) sock.groupParticipantsUpdate(msg.data.groupId, [msg.data.memberId], 'remove');
        break;
      case 'close_group':
        if (sock && isReady) sock.groupSettingUpdate(msg.data.groupId, 'announcement');
        break;
      case 'open_group':
        if (sock && isReady) sock.groupSettingUpdate(msg.data.groupId, 'not_announcement');
        break;
      case 'pause_group': pausedGroups[msg.data.groupId] = true; break;
      case 'restart':
        if (sock) { sock.end(); sock = null; }
        isReady = false;
        setTimeout(function() { connect(); }, 2000);
        break;
    }
  } catch(e) {
    send('error', { message: e.message });
  }
});

send('engine_ready', {});
