/**
 * Ana Ekran - Pairing Code ile bağlantı + Grup seçimi + Durum
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
} from 'react-native';
import botBridge from '../services/BotBridge';
import backgroundService from '../services/BackgroundService';

const HomeScreen = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [pairingCode, setPairingCode] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [groups, setGroups] = useState([]);
  const [activeGroup, setActiveGroup] = useState(null);
  const [isServiceRunning, setIsServiceRunning] = useState(false);
  const [stats, setStats] = useState({ messagesDeleted: 0, welcomesSent: 0, rulesReminded: 0, spammersRemoved: 0 });
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const onStatus = (data) => {
      setIsConnected(data.connected);
      if (data.groups) setGroups(data.groups);
      if (data.stats) setStats(data.stats);
    };
    const onPairingCode = (code) => {
      setPairingCode(code);
      setShowPhoneInput(false);
    };
    const onGroups = (g) => setGroups(g);
    const onLog = (data) => {
      setLogs((prev) => [{
        id: Date.now().toString(),
        text: `${data.type === 'welcome' ? '👋' : data.type === 'deleted' ? '🗑️' : '📢'} ${data.user || ''} ${data.group || ''}`,
        time: new Date().toLocaleTimeString('tr-TR'),
      }, ...prev].slice(0, 50));
    };
    const onLoggedOut = () => {
      setIsConnected(false);
      setPairingCode(null);
      setShowPhoneInput(true);
      Alert.alert('Oturum Kapandı', 'WhatsApp bağlantısı kesildi. Tekrar bağlanın.');
    };

    botBridge.on('status', onStatus);
    botBridge.on('pairing_code', onPairingCode);
    botBridge.on('groups', onGroups);
    botBridge.on('log', onLog);
    botBridge.on('logged_out', onLoggedOut);

    // Durum sor
    setIsServiceRunning(backgroundService.isRunning);

    return () => {
      botBridge.off('status', onStatus);
      botBridge.off('pairing_code', onPairingCode);
      botBridge.off('groups', onGroups);
      botBridge.off('log', onLog);
      botBridge.off('logged_out', onLoggedOut);
    };
  }, []);

  const handleConnect = () => {
    if (!phoneNumber.trim()) {
      Alert.alert('Uyarı', 'Telefon numaranızı girin (başında ülke kodu ile)');
      return;
    }
    try {
      botBridge.init();
      botBridge.on('error', (msg) => Alert.alert('Hata', msg));
      const clean = phoneNumber.replace(/[^0-9]/g, '');
      setTimeout(() => botBridge.connect(clean), 2000);
    } catch(e) {
      Alert.alert('Hata', 'Bağlantı başlatılamadı: ' + e.message);
    }
  };

  const handleSelectGroup = (group) => {
    setActiveGroup(group);
    botBridge.setActiveGroup(group.id);
  };

  const handleRestart = () => {
    Alert.alert('Bot Restart', 'Bot yeniden başlatılacak.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Restart', onPress: () => botBridge.restart() },
    ]);
  };

  const handleStartService = async () => {
    await backgroundService.start();
    setIsServiceRunning(true);
  };

  // Bağlantı yoksa - telefon numarası girişi veya pairing code göster
  if (!isConnected) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.centerContent}>
        {pairingCode ? (
          // Pairing Code göster
          <View style={styles.pairingContainer}>
            <Text style={styles.pairingTitle}>📱 Eşleştirme Kodu</Text>
            <Text style={styles.pairingCode}>{pairingCode}</Text>
            <Text style={styles.pairingHint}>
              WhatsApp'ı aç → ⋮ Menü → Bağlı Cihazlar → Cihaz Bağla → Telefon Numarasıyla Bağla
            </Text>
            <Text style={styles.pairingStep}>
              Yukarıdaki kodu oraya gir, bitti ✓
            </Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => { setPairingCode(null); setShowPhoneInput(true); }}>
              <Text style={styles.retryBtnText}>🔄 Tekrar Dene</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Telefon numarası girişi
          <View style={styles.phoneContainer}>
            <Text style={styles.phoneTitle}>🤖 WhatsApp Grup Yönetici</Text>
            <Text style={styles.phoneSubtitle}>
              Telefon numaranı gir, eşleştirme kodu al
            </Text>
            <TextInput
              style={styles.phoneInput}
              placeholder="905XXXXXXXXX"
              placeholderTextColor="#8696a0"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              keyboardType="phone-pad"
              maxLength={15}
            />
            <Text style={styles.phoneHint}>
              Başında ülke kodu olacak (Türkiye: 90)
            </Text>
            <TouchableOpacity style={styles.connectBtn} onPress={handleConnect}>
              <Text style={styles.connectBtnText}>Bağlan</Text>
            </TouchableOpacity>

            {!isServiceRunning && (
              <TouchableOpacity
                style={[styles.connectBtn, { backgroundColor: '#2a3942', marginTop: 12 }]}
                onPress={handleStartService}>
                <Text style={styles.connectBtnText}>▶️ Arka Plan Servisini Başlat</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    );
  }

  // Bağlıysa - Ana panel
  return (
    <ScrollView style={styles.container}>
      {/* Durum */}
      <View style={styles.statusCard}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, styles.online]} />
          <Text style={styles.statusText}>Bağlı - Bot Aktif ✓</Text>
        </View>
        <Text style={styles.statusSub}>{groups.length} grup bulundu</Text>
      </View>

      {/* İstatistikler */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📊 İstatistikler</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.messagesDeleted}</Text>
            <Text style={styles.statLabel}>Silinen</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.welcomesSent}</Text>
            <Text style={styles.statLabel}>Hoş Geldin</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.rulesReminded}</Text>
            <Text style={styles.statLabel}>Kural</Text>
          </View>
        </View>
      </View>

      {/* Grup Seçimi */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📋 Aktif Grup Seç</Text>
        {groups.map((g) => (
          <TouchableOpacity
            key={g.id}
            style={[styles.groupItem, activeGroup?.id === g.id && styles.groupActive]}
            onPress={() => handleSelectGroup(g)}>
            <Text style={styles.groupName}>{g.name}</Text>
            {activeGroup?.id === g.id && <Text style={styles.checkMark}>✓</Text>}
          </TouchableOpacity>
        ))}
      </View>

      {/* Restart */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.restartBtn} onPress={handleRestart}>
          <Text style={styles.restartBtnText}>🔄 Bot Restart</Text>
        </TouchableOpacity>
      </View>

      {/* Log */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📝 Son İşlemler</Text>
        {logs.length === 0 && <Text style={styles.emptyText}>Henüz işlem yok</Text>}
        {logs.slice(0, 10).map((log) => (
          <Text key={log.id} style={styles.logItem}>[{log.time}] {log.text}</Text>
        ))}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21' },
  centerContent: { flex: 1, justifyContent: 'center', padding: 24 },

  // Pairing Code
  pairingContainer: { alignItems: 'center' },
  pairingTitle: { fontSize: 22, color: '#00a884', fontWeight: 'bold', marginBottom: 20 },
  pairingCode: { fontSize: 42, color: '#e9edef', fontWeight: 'bold', letterSpacing: 8, backgroundColor: '#1f2c33', paddingHorizontal: 32, paddingVertical: 20, borderRadius: 16, borderWidth: 2, borderColor: '#00a884', marginBottom: 24 },
  pairingHint: { color: '#8696a0', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 8 },
  pairingStep: { color: '#00a884', fontSize: 14, textAlign: 'center', fontWeight: '500' },
  retryBtn: { marginTop: 24, backgroundColor: '#2a3942', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#e9edef', fontSize: 14 },

  // Phone input
  phoneContainer: { alignItems: 'center' },
  phoneTitle: { fontSize: 24, color: '#00a884', fontWeight: 'bold', marginBottom: 8 },
  phoneSubtitle: { color: '#8696a0', fontSize: 14, marginBottom: 24 },
  phoneInput: { width: '100%', backgroundColor: '#2a3942', borderRadius: 12, padding: 16, fontSize: 20, color: '#e9edef', textAlign: 'center', borderWidth: 1, borderColor: '#3b4a54', letterSpacing: 2, marginBottom: 8 },
  phoneHint: { color: '#8696a0', fontSize: 12, marginBottom: 20 },
  connectBtn: { width: '100%', backgroundColor: '#00a884', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  connectBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // Status
  statusCard: { backgroundColor: '#1f2c33', margin: 16, marginBottom: 8, borderRadius: 12, padding: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  online: { backgroundColor: '#00a884' },
  statusText: { color: '#e9edef', fontSize: 16, fontWeight: '600' },
  statusSub: { color: '#8696a0', fontSize: 12, marginTop: 4 },

  // Sections
  section: { backgroundColor: '#1f2c33', marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 16 },
  sectionTitle: { color: '#00a884', fontSize: 13, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase' },

  // Stats
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  statBox: { alignItems: 'center' },
  statNum: { color: '#00a884', fontSize: 28, fontWeight: 'bold' },
  statLabel: { color: '#8696a0', fontSize: 11, marginTop: 4 },

  // Groups
  groupItem: { backgroundColor: '#2a3942', borderRadius: 8, padding: 14, marginBottom: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#3b4a54' },
  groupActive: { borderColor: '#00a884', backgroundColor: '#1c3a2a' },
  groupName: { color: '#e9edef', fontSize: 14, flex: 1 },
  checkMark: { color: '#00a884', fontSize: 18, fontWeight: 'bold' },

  // Restart
  restartBtn: { backgroundColor: '#2a3942', padding: 14, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#f7c948' },
  restartBtnText: { color: '#f7c948', fontSize: 14, fontWeight: '600' },

  // Logs
  emptyText: { color: '#8696a0', textAlign: 'center', paddingVertical: 12 },
  logItem: { color: '#8696a0', fontSize: 12, paddingVertical: 3 },
});

export default HomeScreen;
