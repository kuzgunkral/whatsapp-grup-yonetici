/**
 * Bot Bridge - React Native <-> Render.com Server haberleşme
 * HTTP + Socket.IO ile uzak sunucuya bağlanır
 */

import { EventEmitter } from 'events';

const SERVER_URL = 'https://whatsapp-grup-yonetici-production.up.railway.app';

class BotBridge extends EventEmitter {
  constructor() {
    super();
    this.isEngineReady = false;
    this.isConnected = false;
    this.groups = [];
    this.stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
    this.initialized = false;
    this.socket = null;
    this.pollInterval = null;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.isEngineReady = true;
    this.emit('engine_ready');

    // Socket.IO bağlantısı
    this._connectSocket();

    // Polling ile durum takibi (yedek)
    this._startPolling();
  }

  _connectSocket() {
    try {
      // Socket.IO client import - react native uyumlu
      const io = require('socket.io-client');
      this.socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 3000,
      });

      this.socket.on('connect', () => {
        console.log('Socket connected to server');
      });

      this.socket.on('status', (data) => {
        this.isConnected = data.connected;
        if (data.groups) this.groups = data.groups;
        if (data.stats) this.stats = data.stats;
        this.emit('status', data);
      });

      this.socket.on('groups', (groups) => {
        this.groups = groups;
        this.emit('groups', groups);
      });

      this.socket.on('qr', (qr) => {
        this.emit('qr', qr);
      });

      this.socket.on('pairing_code', (code) => {
        this.emit('pairing_code', code);
      });

      this.socket.on('log', (data) => {
        this.emit('log', data);
      });

      this.socket.on('disconnect', () => {
        console.log('Socket disconnected');
      });
    } catch (e) {
      console.warn('Socket.IO not available, using polling only:', e.message);
    }
  }

  _startPolling() {
    // Her 5 saniyede durum sorgula
    this.pollInterval = setInterval(() => {
      this._fetchStatus();
    }, 5000);
  }

  async _fetchStatus() {
    try {
      const res = await fetch(`${SERVER_URL}/api/status`);
      const data = await res.json();
      this.isConnected = data.connected;
      if (data.groups) this.groups = data.groups;
      if (data.stats) this.stats = data.stats;
      this.emit('status', {
        connected: data.connected,
        groups: data.groups,
        stats: data.stats,
      });
      if (data.pairingCode) {
        this.emit('pairing_code', data.pairingCode);
      }
    } catch (e) {
      // Sunucuya ulaşılamıyor
    }
  }

  async _post(endpoint, body = {}) {
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      this.emit('error', 'Sunucuya bağlanılamadı: ' + e.message);
      return { success: false };
    }
  }

  async _get(endpoint) {
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`);
      return await res.json();
    } catch (e) {
      return { success: false };
    }
  }

  // === Komutlar ===

  connect(phoneNumber) {
    this._post('/api/connect', { phoneNumber });
  }

  getStatus() {
    this._fetchStatus();
  }

  setActiveGroup(groupId) {
    this._post('/api/set-active-group', { groupId });
  }

  sendMessage(groupId, message) {
    this._post('/api/send-message', { groupId, message });
  }

  sendRules(groupId) {
    this._post('/api/send-rules', { groupId });
  }

  sendAnnouncement(groupId, message) {
    this._post('/api/send-message', { groupId, message: `📢 *DUYURU*\n━━━━━━━━━━━━━━━━\n\n${message}\n\n🛡️ Grup Yönetimi` });
  }

  closeGroup(groupId) {
    this._post('/api/close-group', { groupId });
  }

  openGroup(groupId) {
    this._post('/api/open-group', { groupId });
  }

  pauseGroup(groupId) {
    this._post('/api/pause-group', { groupId });
  }

  muteMember(groupId, memberId) {
    this._post('/api/mute-member', { groupId, memberId });
  }

  unmuteMember(groupId, memberId) {
    this._post('/api/unmute-member', { groupId, memberId });
  }

  removeMember(groupId, memberId) {
    this._post('/api/remove-member', { groupId, memberId });
  }

  banMember(groupId, memberId) {
    this._post('/api/ban-member', { groupId, memberId });
  }

  async getMembers(groupId) {
    const data = await this._get(`/api/members?groupId=${groupId}`);
    if (data.members) {
      this.emit('members', data.members);
    }
  }

  async getDeletedAds() {
    const data = await this._get('/api/deleted-ads');
    if (data.data) {
      this.emit('deleted_ads', data.data);
    }
  }

  async restoreAd(id) {
    const res = await this._post('/api/restore-ad', { id });
    if (res.success) this.emit('restore_done', id);
  }

  async restoreAsAd(id) {
    const res = await this._post('/api/restore-as-ad', { id });
    if (res.success) this.emit('restore_done', id);
  }

  async clearLogs() {
    await this._post('/api/clear-all-logs');
  }

  async clearMediaCache() {
    const res = await this._post('/api/clear-media-cache');
    if (res.cleared !== undefined) this.emit('cache_cleared', res.cleared);
  }

  setAutomation(type, enabled) {
    this._post('/api/automation', { type, enabled });
  }

  setDeleteDelay(seconds) {
    this._post('/api/set-delete-delay', { delay: seconds });
  }

  setRuleInterval(hours) {
    this._post('/api/set-rule-interval', { hours });
  }

  setCustomRule(message) {
    this._post('/api/set-rule-message', { message });
  }

  restart() {
    this._post('/api/restart');
  }
}

const botBridge = new BotBridge();
export default botBridge;
