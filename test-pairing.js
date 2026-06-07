const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('./nodejs-assets/nodejs-project/node_modules/baileys');
const pino = require('./nodejs-assets/nodejs-project/node_modules/pino');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = './test-auth';
const PHONE = '905396814793';

async function start() {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    console.log('Connection update:', JSON.stringify(update));
    if (update.connection === 'open') {
      console.log('BASARILI! Baglandi.');
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('Baglanti kapandi, statusCode:', code);
      if (code !== 401) {
        console.log('Reconnect ediliyor...');
        setTimeout(() => start(), 3000);
      }
    }
  });

  // 8 saniye sonra pairing code iste
  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(PHONE);
      console.log('\n========================================');
      console.log('  PAIRING CODE:', code);
      console.log('  Hemen WhatsApp\'a gir ve bu kodu yaz!');
      console.log('========================================\n');
    } catch(e) {
      console.log('Pairing error:', e.message);
    }
  }, 8000);
}

start();
