/**
 * Bot Bridge - React Native <-> Node.js Engine haberleşme
 * nodejs-mobile-react-native üzerinden çalışır
 */

import nodejs from 'nodejs-mobile-react-native';
import { EventEmitter } from 'events';

class BotBridge extends EventEmitter {
  constructor() {
    super();
    this.isEngineReady = false;
    this.isConnected = false;
    this.groups = [];
    this.stats = { messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 };
  }

  init() {
    // Node.js engine'i başlat
    nodejs.start('main.js');

    // Engine'den gelen mesajları dinle
    nodejs.channel.addListener('message', (raw) => {
      try {
        const { event, data } = JSON.parse(raw);

        switch (event) {
          case 'engine_ready':
            this.isEngineReady = true;
            this.emit('engine_ready');
            break;

          case 'pairing_code':
            this.emit('pairing_code', data.code);
            break;

          case 'status':
            this.isConnected = data.connected;
            if (data.groups) this.groups = data.groups;
            if (data.stats) this.stats = data.stats;
            this.emit('status', data);
            break;

          case 'groups':
            this.groups = data.groups;
            this.emit('groups', data.groups);
            break;

          case 'members':
            this.emit('members', data.members);
            break;

          case 'deleted_ads':
            this.emit('deleted_ads', data.data);
            break;

          case 'restore_done':
            this.emit('restore_done', data.id);
            break;

          case 'cache_cleared':
            this.emit('cache_cleared', data.cleared);
            break;

          case 'log':
            this.emit('log', data);
            break;

          case 'logged_out':
            this.isConnected = false;
            this.emit('logged_out');
            break;

          case 'error':
            this.emit('error', data.message);
            break;
        }
      } catch (e) {}
    });
  }

  // Engine'e komut gönder
  send(action, data = {}) {
    nodejs.channel.send(JSON.stringify({ action, data }));
  }

  // ============ API ============

  connect(phoneNumber) {
    this.send('connect', { phoneNumber });
  }

  getStatus() {
    this.send('get_status');
  }

  setActiveGroup(groupId) {
    this.send('set_active_group', { groupId });
  }

  sendMessage(groupId, message) {
    this.send('send_message', { groupId, message });
  }

  sendRules(groupId) {
    this.send('send_rules', { groupId });
  }

  sendAnnouncement(groupId, message) {
    this.send('send_announcement', { groupId, message });
  }

  closeGroup(groupId) {
    this.send('close_group', { groupId });
  }

  openGroup(groupId) {
    this.send('open_group', { groupId });
  }

  pauseGroup(groupId) {
    this.send('pause_group', { groupId });
  }

  muteMember(groupId, memberId) {
    this.send('mute_member', { groupId, memberId });
  }

  unmuteMember(groupId, memberId) {
    this.send('unmute_member', { groupId, memberId });
  }

  removeMember(groupId, memberId) {
    this.send('remove_member', { groupId, memberId });
  }

  banMember(groupId, memberId) {
    this.send('ban_member', { groupId, memberId });
  }

  getMembers(groupId) {
    this.send('get_members', { groupId });
  }

  getDeletedAds() {
    this.send('get_deleted_ads');
  }

  restoreAd(id) {
    this.send('restore_ad', { id });
  }

  restoreAsAd(id) {
    this.send('restore_as_ad', { id });
  }

  clearLogs() {
    this.send('clear_logs');
  }

  clearMediaCache() {
    this.send('clear_media_cache');
  }

  setAutomation(type, enabled) {
    this.send('set_automation', { type, enabled });
  }

  setDeleteDelay(seconds) {
    this.send('set_delete_delay', { seconds });
  }

  setRuleInterval(hours) {
    this.send('set_rule_interval', { hours });
  }

  setCustomRule(message) {
    this.send('set_custom_rule', { message });
  }

  restart() {
    this.send('restart');
  }
}

const botBridge = new BotBridge();
export default botBridge;
