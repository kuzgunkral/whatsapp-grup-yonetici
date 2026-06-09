/**
 * Loglar Ekranı - Silinen ilanlar + Geri yükleme + Reklam olarak yükleme
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, RefreshControl, TextInput,
} from 'react-native';
import botBridge from '../services/BotBridge';

const LogsScreen = () => {
  const [logs, setLogs] = useState([]);
  const [filteredLogs, setFilteredLogs] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    loadLogs();
    const onAds = (data) => { setLogs(data); setFilteredLogs(data); setRefreshing(false); };
    const onRestore = () => loadLogs();
    botBridge.on('deleted_ads', onAds);
    botBridge.on('restore_done', onRestore);
    return () => { botBridge.off('deleted_ads', onAds); botBridge.off('restore_done', onRestore); };
  }, []);

  const loadLogs = () => { setRefreshing(true); botBridge.getDeletedAds(); };

  const handleSearch = (text) => {
    setSearchText(text);
    if (!text) { setFilteredLogs(logs); return; }
    const q = text.toLowerCase();
    setFilteredLogs(logs.filter(ad =>
      (ad.kullanici && ad.kullanici.toLowerCase().includes(q)) ||
      (ad.telefon && ad.telefon.includes(q)) ||
      (ad.mesaj && ad.mesaj.toLowerCase().includes(q))
    ));
  };

  const handleRestore = (item) => {
    Alert.alert('Geri Yükle', `"${(item.mesaj || '').substring(0, 40)}..." gruba gönderilsin mi?`, [
      { text: 'İptal', style: 'cancel' },
      { text: 'Geri Yükle', onPress: () => botBridge.restoreAd(item.id) },
    ]);
  };

  const handleRestoreAsAd = (item) => {
    Alert.alert('Reklam Olarak Yükle', 'Reklam onaylı olarak geri yüklenecek.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Reklam Yükle', onPress: () => botBridge.restoreAsAd(item.id) },
    ]);
  };

  const handleDeleteLog = (item) => {
    Alert.alert('Log Sil', 'Bu log silinsin mi?', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Sil', style: 'destructive', onPress: async () => {
        await botBridge.deleteLog(item.id);
        loadLogs();
      }},
    ]);
  };

  const handleClearAll = () => {
    Alert.alert('Tüm Logları Temizle', 'Tüm silinen ilan logları silinecek. Geri alınamaz!', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Temizle', style: 'destructive', onPress: async () => {
        await botBridge.clearLogs();
        setLogs([]);
        setFilteredLogs([]);
      }},
    ]);
  };

  const renderItem = ({ item }) => {
    const telefon = item.telefon || '';
    const telefonGecerli = telefon && /^\d{10,}$/.test(telefon);

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardUser}>👤 {item.kullanici || 'Bilinmeyen'}</Text>
          <Text style={styles.cardTime}>{item.tarih} {item.saat}</Text>
        </View>
        {telefonGecerli && (
          <Text style={styles.cardPhone}>📞 +{telefon}</Text>
        )}
        {item.topluAdet && item.topluAdet > 1 && (
          <Text style={styles.cardToplu}>📦 {item.topluAdet} resimli toplu ilan</Text>
        )}
        <Text style={styles.cardGroup}>📍 {item.grup}</Text>
        <Text style={styles.cardMsg} numberOfLines={3}>
          {item.medya || item.medyaVar ? '📷 ' : ''}{item.mesaj || '(içerik yok)'}
        </Text>
        <Text style={styles.cardReason}>⚡ {item.sebep}</Text>
        <View style={styles.cardActions}>
          <TouchableOpacity style={[styles.cardBtn, styles.cardBtnGreen]} onPress={() => handleRestore(item)}>
            <Text style={styles.cardBtnText}>🔄 Geri Yükle</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cardBtn, styles.cardBtnBlue]} onPress={() => handleRestoreAsAd(item)}>
            <Text style={styles.cardBtnText}>📢 Reklam</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cardBtn, styles.cardBtnRed]} onPress={() => handleDeleteLog(item)}>
            <Text style={styles.cardBtnText}>🗑️</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>📋 Silinen İlanlar ({filteredLogs.length})</Text>
          <TouchableOpacity style={styles.clearBtn} onPress={handleClearAll}>
            <Text style={styles.clearBtnText}>🗑️ Temizle</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.searchInput}
          placeholder="Kullanıcı, numara veya mesaj ara..."
          placeholderTextColor="#8696a0"
          value={searchText}
          onChangeText={handleSearch}
        />
      </View>
      <FlatList
        data={filteredLogs}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={loadLogs} tintColor="#00a884" />}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>Silinen ilan yok</Text>
          </View>
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21' },
  header: { padding: 16, backgroundColor: '#1f2c33', borderBottomWidth: 1, borderBottomColor: '#2a3942' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  headerTitle: { color: '#e9edef', fontSize: 16, fontWeight: '600' },
  clearBtn: { backgroundColor: '#3a1c1c', borderWidth: 1, borderColor: '#ea0038', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  clearBtnText: { color: '#ea0038', fontSize: 11 },
  searchInput: { backgroundColor: '#2a3942', borderRadius: 8, padding: 10, color: '#e9edef', fontSize: 13, borderWidth: 1, borderColor: '#3b4a54' },
  card: { backgroundColor: '#1f2c33', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#2a3942' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  cardUser: { color: '#e9edef', fontSize: 13, fontWeight: '600' },
  cardTime: { color: '#8696a0', fontSize: 11 },
  cardPhone: { color: '#53bdeb', fontSize: 12, marginBottom: 4 },
  cardToplu: { color: '#f7c948', fontSize: 11, marginBottom: 4 },
  cardGroup: { color: '#53bdeb', fontSize: 12, marginBottom: 6 },
  cardMsg: { color: '#d1d7db', fontSize: 13, marginBottom: 6, lineHeight: 18 },
  cardReason: { color: '#f7c948', fontSize: 11, marginBottom: 10 },
  cardActions: { flexDirection: 'row', gap: 6 },
  cardBtn: { flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: 'center', borderWidth: 1 },
  cardBtnGreen: { borderColor: '#00a884', backgroundColor: '#1c3a2a' },
  cardBtnBlue: { borderColor: '#53bdeb', backgroundColor: '#1a2a3a' },
  cardBtnRed: { borderColor: '#ea0038', backgroundColor: '#3a1c1c', flex: 0.4 },
  cardBtnText: { color: '#e9edef', fontSize: 12 },
  emptyBox: { alignItems: 'center', paddingVertical: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { color: '#8696a0', fontSize: 16 },
});

export default LogsScreen;
