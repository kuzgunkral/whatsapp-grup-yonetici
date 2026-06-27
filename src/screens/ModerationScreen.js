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
  const [mutedSet, setMutedSet] = useState(new Set());
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const onStatus = (data) => {
      if (data.groups && data.groups.length > 0) {
        const activeId = botBridge._activeGroupId;
        const group = data.groups.find(g => g.id === activeId) || data.groups[0];
        setActiveGroupName(group ? group.name : 'Seçilmedi');
      }
    };
    const onMembers = (list) => { setMembers(list); setLoading(false); };
    botBridge.on('status', onStatus);
    botBridge.on('members', onMembers);
    // Sayfa açılınca otomatik yükle
    loadMembersAuto();
    return () => {
      botBridge.off('status', onStatus);
      botBridge.off('members', onMembers);
    };
  }, []);

  const getActiveGroupId = () => {
    return botBridge._activeGroupId || botBridge.groups[0]?.id || null;
  };

  const loadMembersAuto = async () => {
    if (!botBridge.isConnected) return;
    const gid = getActiveGroupId();
    if (!gid) return;
    setLoading(true);
    try {
      const res = await fetch(`${botBridge.constructor._serverUrl || 'https://whatsapp-grup-yonetici-production.up.railway.app'}/api/members?groupId=${gid}`);
      const data = await res.json();
      if (data.members) { setMembers(data.members); }
    } catch(e) {}
    setLoading(false);
  };

  const loadMembers = async () => {
    const gid = getActiveGroupId();
    if (!gid) { Alert.alert('Uyarı', 'Önce Ana Sayfa\'dan grup seçin'); return; }
    setLoading(true);
    try {
      const res = await fetch(`https://whatsapp-grup-yonetici-production.up.railway.app/api/members?groupId=${gid}`);
      const data = await res.json();
      if (data.members) { setMembers(data.members); }
    } catch(e) { Alert.alert('Hata', 'Üyeler yüklenemedi'); }
    setLoading(false);
  };

  const handleMute = (member) => {
    const isMuted = mutedSet.has(member.id);
    const title = isMuted ? '🔊 Susturmayı Kaldır' : '🔇 Sustur';
    const btnLabel = isMuted ? 'Aç' : 'Sustur';
    Alert.alert(title, `${member.name || member.number}`, [
      { text: 'İptal', style: 'cancel' },
      {
        text: btnLabel,
        onPress: async () => {
          const res = await botBridge.muteMember(botBridge.groups[0]?.id, member.id);
          if (res && res.muted === false) {
            setMutedSet(prev => { const s = new Set(prev); s.delete(member.id); return s; });
            Alert.alert('🔊', `${member.name || member.number} susturması kaldırıldı`);
          } else {
            setMutedSet(prev => new Set(prev).add(member.id));
            Alert.alert('🔇', `${member.name || member.number} susturuldu`);
          }
        },
      },
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

  const handleSendRules = async () => {
    const gid = botBridge.groups[0]?.id;
    if (!gid) { Alert.alert('Uyarı', 'Grup seçilmedi'); return; }
    const res = await botBridge.sendRules(gid);
    if (res && res.success) Alert.alert('✅', 'Kurallar gönderildi');
    else Alert.alert('Bilgi', res?.error || 'Gönderildi');
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
  const handlePause = async () => {
    const gid = botBridge.groups[0]?.id;
    if (!gid) { Alert.alert('Uyarı', 'Grup seçilmedi'); return; }
    const res = await botBridge.pauseGroup(gid);
    if (res && res.paused === false) {
      setIsPaused(false);
      Alert.alert('✅ Bot Aktif', 'Bot tekrar aktif hale getirildi');
    } else {
      setIsPaused(true);
      Alert.alert('⏸️ Bot Pasif', 'Bot duraklatıldı');
    }
  };

  const filteredMembers = searchText
    ? members.filter((m) =>
        (m.name || '').toLowerCase().includes(searchText.toLowerCase()) ||
        (m.number || '').includes(searchText)
      )
    : members;

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🛡️ Grup İşlemleri</Text>
        <TouchableOpacity style={[styles.btn, styles.btnGreen, { marginBottom: 10 }]} onPress={handleSendRules}>
          <Text style={styles.btnText}>📋 Kural Gönder</Text>
        </TouchableOpacity>
        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.btn, styles.btnRed]} onPress={handleCloseGroup}>
            <Text style={styles.btnText}>🔒 Kapat</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnGreen]} onPress={handleOpenGroup}>
            <Text style={styles.btnText}>🔓 Aç</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, isPaused ? styles.btnGreen : styles.btnYellow]} onPress={handlePause}>
            <Text style={styles.btnText}>{isPaused ? '▶️ Bot Aktif' : '⏸️ Duraklat'}</Text>
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
            placeholder="İsim veya numara ara..."
            placeholderTextColor="#8696a0"
            value={searchText}
            onChangeText={setSearchText}
          />
          <TouchableOpacity style={styles.searchBtn} onPress={loadMembers}>
            <Text style={styles.searchBtnText}>{loading ? '⏳' : '🔄'}</Text>
          </TouchableOpacity>
        </View>

        {filteredMembers.map((m) => (
          <View key={m.id} style={[styles.memberRow, m.isMuted && { opacity: 0.5 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.memberName}>
                {m.name && m.name !== m.number ? m.name : `+${m.number}`}
                {m.isAdmin ? ' 👑' : ''}
                {m.isMuted ? ' 🔇' : ''}
              </Text>
              {m.name && m.name !== m.number && (
                <Text style={styles.memberNum}>+{m.number}</Text>
              )}
            </View>
            {!m.isAdmin && (
              <View style={styles.actionRow}>
                <TouchableOpacity onPress={() => handleMute(m)}>
                  <Text style={styles.actionIcon}>{m.isMuted ? '🔊' : '🔇'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleRemove(m)}>
                  <Text style={styles.actionIcon}>🚫</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleBan(m)}>
                  <Text style={styles.actionIcon}>⛔</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
        {members.length === 0 && !loading && (
          <Text style={styles.empty}>Üye bulunamadı — 🔍 ile yenile</Text>
        )}
        {loading && <Text style={styles.empty}>⏳ Yükleniyor...</Text>}
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
