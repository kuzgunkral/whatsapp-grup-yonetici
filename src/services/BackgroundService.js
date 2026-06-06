/**
 * Background Service - Arka planda Node.js engine'i çalıştırır
 * Telefon kilitliyken bile bot aktif kalır.
 * WhatsApp açık olmadan çalışır.
 */

import BackgroundService from 'react-native-background-actions';
import nodejs from 'nodejs-mobile-react-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const backgroundTask = async (taskData) => {
  // Node.js engine zaten başlatıldı, burada sadece alive tutuyoruz
  while (BackgroundService.isRunning()) {
    await sleep(taskData.delay);
  }
};

const options = {
  taskName: 'WhatsApp Bot',
  taskTitle: 'WhatsApp Grup Yönetici',
  taskDesc: 'Bot arka planda aktif - WhatsApp açık olmadan çalışıyor',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#00a884',
  linkingURI: 'whatsappgrupyonetici://home',
  parameters: { delay: 30000 },
};

class BackgroundServiceManager {
  isRunning = false;

  async start() {
    if (this.isRunning) return;
    try {
      await BackgroundService.start(backgroundTask, options);
      this.isRunning = true;
    } catch (e) {
      console.error('BG service error:', e);
    }
  }

  async stop() {
    try {
      await BackgroundService.stop();
      this.isRunning = false;
    } catch (e) {}
  }
}

const backgroundServiceManager = new BackgroundServiceManager();
export default backgroundServiceManager;
