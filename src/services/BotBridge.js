/**
 * Bot Bridge - React Native <-> Railway Server haberleşme
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
    this.pollInterval = null;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.isEngineReady = true;
    this.emit('engine_ready');
    this._startPolling();
  }

  _startPolling() {
    this._fetchStatus();
    this.pollInterval = setInterval(() => this._fetchStatus(), 5000);
  }

  async _fetchStatus() {
    try {
      const res = await fetch(`${SERVER_URL}/api/status`);
      const data = await res.json();
      this.isConnected = data.connected;
      if (data.groups) this.groups = data.groups;
      if (data.stats) this.stats = data.stats;
      this.emit('status', { connected: data.connected, groups: data.groups, stats: data.stats });
      if (data.pairingCode) this.emit('pairing_code', data.pairingCode);
    } catch (e) {}
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
      this.emit('error', 'Sunucuya bağlanılamadı');
      return { success: false };
    }
  }

  async _get(endpoint) {
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`);
      return await res.json();
    } catch (e) { return { success: false }; }
  }

  connect(phoneNumber) { this._post('/api/connect', { phoneNumber }); }
  getStatus() { this._fetchStatus(); }
  setActiveGroup(groupId) { this._post('/api/set-active-group', { groupId }); }
  sendMessage(groupId, message) { this._post('/api/send-message', { groupId, message }); }
  sendRules(groupId) { this._post('/api/send-rules', { groupId }); }
  sendAnnouncement(groupId, message) { this._post('/api/send-announcement', { groupId, message }); }
  closeGroup(groupId) { this._post('/api/close-group', { groupId }); }
  openGroup(groupId) { this._post('/api/open-group', { groupId }); }
  pauseGroup(groupId) { this._post('/api/pause-group', { groupId }); }
  muteMember(groupId, memberId) { this._post('/api/mute-member', { groupId, memberId }); }
  unmuteMember(groupId, memberId) { this._post('/api/unmute-member', { groupId, memberId }); }
  removeMember(groupId, memberId) { this._post('/api/remove-member', { groupId, memberId }); }
  banMember(groupId, memberId) { this._post('/api/ban-member', { groupId, memberId }); }
  async getMembers(groupId) { const data = await this._get(`/api/members?groupId=${groupId}`); if (data.members) this.emit('members', data.members); }
  async getDeletedAds() { const data = await this._get('/api/deleted-ads'); if (data.data) this.emit('deleted_ads', data.data); }
  async restoreAd(id) { const res = await this._post('/api/restore-ad', { id }); if (res.success) this.emit('restore_done', id); }
  async restoreAsAd(id) { const res = await this._post('/api/restore-as-ad', { id }); if (res.success) this.emit('restore_done', id); }
  async deleteLog(id) { await fetch(`${SERVER_URL}/api/deleted-ads/${id}`, { method: 'DELETE' }); }
  async clearLogs() { await this._post('/api/clear-all-logs'); }
  async clearMediaCache() { const res = await this._post('/api/clear-media-cache'); if (res.cleared !== undefined) this.emit('cache_cleared', res.cleared); }
  setAutomation(type, enabled) { this._post('/api/automation', { type, enabled }); }
  setDeleteDelay(seconds) { this._post('/api/set-delete-delay', { delay: seconds }); }
  setRuleInterval(hours) { this._post('/api/set-rule-interval', { hours }); }
  setCustomRule(message) { this._post('/api/set-rule-message', { message }); }
  async cleanNoPrice(groupId) { return await this._post('/api/clean-no-price', { groupId }); }
  restart() { this._post('/api/restart'); }
}

const botBridge = new BotBridge();
export default botBridge;
