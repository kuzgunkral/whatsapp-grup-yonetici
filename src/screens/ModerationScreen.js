/**
 * Moderasyon Ekranı - Üye yönetimi + Grup işlemleri
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, Alert, FlatList,
} from 'react-native';
import botBridge from '../services/BotBridge';

const ModerationScreen = () => {
  const [members, setMembers] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeGroupName, setActiveGroupName] = useState('');

  useEffect(() => {
    const group = botBridge.groups.find((g) => g.id === botBridge.activeGroupId);
    setActiveGroupName(group ? group.name : 'Seçilmedi');

    const onMembers = (m) => { setMembers(m); setLoading(false); };
    botBridge.on('members', onMembers);
    return () => botBridge.off('members', onMembers);
  }, []);

  const checkGroup = () => {
    const gid = botBridge.groups.find((g) => g.id)?.id;
    // aktif grup kontrolü
    if (!botBridge.isConnected) { Alert.alert('Uyarı', 'Bot bağlı değil'); return null; }
    const active = botBridge.groups.find((g) => true); // en azından bir grup var mı
    return true;
  };

  const getActiveGroupId = () => {
    // BotBridge üzerinden aktif grup
    const groups = botBridge.groups;
    if (groups.length === 0) return null;
    // Eğer setActiveGroup yapıldıysa onu kullan
    return groups[0]?.id; // fallback
  };

  const loadMembers = () => {
    const groups = botBridge.groups;
    if (groups.length === 0) { Alert.alert('Uyarı', 'Önce Ana Sayfa\'dan grup seçin'); return; }
    setLoading(true);
    botBridge.getMembers(groups[0]?.id);
  };

  const handleMute = (member) => {
    Alert.alert('Sustur', `${member.name} 5dk susturulsun mu?`, [
      { text: 'İptal', style: 'cancel' },
      { text: 'Sustur', onPress: () => botBridge.muteMember(botBridge.groups[0]?.id, member.id) },
    ]);
  };

  const handleRemove = (member) => {
    Alert.alert('Çıkar', `${member.name} gruptan çıkarılsın mı?`, [
      { text: 'İptal', style: 'cancel' },
      { text: 'Çıkar', style: 'destructive', onPress: () => botBridge.removeMember(botBridge.groups[0]?.id, member.id) },
    ]);
  };

  const handleBan = (member) => {
    Alert.alert('Banla', `${member.name} banlanacak!`, [
      { text: 'İptal', style: 'cancel' },
      { text: 'Banla', style: 'destructive', onPress: () => botBridge.banMember(botBridge.groups[0]?.id, member.id) },
    ]);
  };

  const handleCloseGroup = () => {
    Alert.alert('Grubu Kapat', 'Sadece adminler yazabilecek.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Kapat', style: 'destructive', onPress: () => botBridge.closeGroup(botBridge.groups[0]?.id) },
    ]);
  };

  const handleCleanNoPrice = () => {
    const gid = botBridge.groups[0]?.id;
    if (!gid) { Alert.alert('Uyarı', 'Grup seçilmedi'); return; }
    Alert.alert('Fiyatsız İlanları Sil', 'Son 24 saatteki tüm fiyatsız ilanlar silinecek ve loga kaydedilecek.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Sil', style: 'destructive', onPress: async () => {
        const res = await botBridge.cleanNoPrice(gid);
        if (res && res.success) {
          Alert.alert('Tamamlandı', `${res.count} fiyatsız ilan silindi`);
        } else {
          Alert.alert('Bilgi', res?.message || res?.error || 'İşlem tamamlanamadı');
        }
      }},
    ]);
  };

  const handleOpenGroup = () => botBridge.openGroup(botBridge.groups[0]?.id);
  const handlePause = () => botBridge.pauseGroup(botBridge.groups[0]?.id);

  const filteredMembers = searchText
    ? members.filter((m) => m.name.includes(searchText) || m.number.includes(searchText))
    : members;

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🛡️ Grup İşlemleri</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.btn, styles.btnRed]} onPress={handleCloseGroup}>
            <Text style={styles.btnText}>🔒 Kapat</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnGreen]} onPress={handleOpenGroup}>
            <Text style={styles.btnText}>🔓 Aç</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnYellow]} onPress={handlePause}>
            <Text style={styles.btnText}>⏸️ Duraklat</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[styles.btn, styles.btnRed, { marginTop: 10 }]} onPress={handleCleanNoPrice}>
          <Text style={styles.btnText}>🗑️ Tüm Fiyatsız İlanları Sil</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>👥 Üye Yönetimi</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="Ara..."
            placeholderTextColor="#8696a0"
            value={searchText}
            onChangeText={setSearchText}
          />
          <TouchableOpacity style={styles.searchBtn} onPress={loadMembers}>
            <Text style={styles.searchBtnText}>{loading ? '⏳' : '🔍'}</Text>
          </TouchableOpacity>
        </View>

        {filteredMembers.map((m) => (
          <View key={m.id} style={styles.memberRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.memberName}>{m.name} {m.isAdmin ? '👑' : ''}</Text>
              <Text style={styles.memberNum}>{m.number}</Text>
            </View>
            {!m.isAdmin && (
              <View style={styles.actionRow}>
                <TouchableOpacity onPress={() => handleMute(m)}><Text style={styles.actionIcon}>🔇</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => handleRemove(m)}><Text style={styles.actionIcon}>🚫</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => handleBan(m)}><Text style={styles.actionIcon}>⛔</Text></TouchableOpacity>
              </View>
            )}
          </View>
        ))}
        {members.length === 0 && <Text style={styles.empty}>🔍 basarak üyeleri listele</Text>}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21', padding: 16 },
  section: { backgroundColor: '#1f2c33', borderRadius: 12, padding: 16, marginBottom: 12 },
  sectionTitle: { color: '#00a884', fontSize: 13, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase' },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
  btnRed: { borderColor: '#ea0038', backgroundColor: '#2a1a1a' },
  btnGreen: { borderColor: '#00a884', backgroundColor: '#1a2a22' },
  btnYellow: { borderColor: '#f7c948', backgroundColor: '#2a2a1a' },
  btnText: { color: '#e9edef', fontSize: 13 },
  searchRow: { flexDirection: 'row', marginBottom: 12, gap: 8 },
  searchInput: { flex: 1, backgroundColor: '#2a3942', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: '#e9edef', borderWidth: 1, borderColor: '#3b4a54' },
  searchBtn: { backgroundColor: '#00a884', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  searchBtnText: { fontSize: 18 },
  memberRow: { backgroundColor: '#2a3942', borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center' },
  memberName: { color: '#e9edef', fontSize: 14 },
  memberNum: { color: '#8696a0', fontSize: 11 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionIcon: { fontSize: 20 },
  empty: { color: '#8696a0', textAlign: 'center', paddingVertical: 16 },
});

export default ModerationScreen;
