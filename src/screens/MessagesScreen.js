/**
 * Mesajlar Ekranı - Duyuru / Kural / Özel Mesaj
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
} from 'react-native';
import botBridge from '../services/BotBridge';

const MessagesScreen = () => {
  const [customMsg, setCustomMsg] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const getGroupId = () => {
    const active = botBridge.activeGroupId;
    if (active) return active;
    if (botBridge.groups && botBridge.groups.length > 0) return botBridge.groups[0]?.id;
    Alert.alert('Uyarı', 'Grup yok veya bağlı değil');
    return null;
  };

  const handleSendRules = async () => {
    const gid = getGroupId();
    if (!gid) return;
    await botBridge.sendRules(gid);
    Alert.alert('✅', 'Kurallar gönderildi');
  };

  const handleSendCustom = async () => {
    const gid = getGroupId();
    if (!gid) return;
    if (!customMsg.trim()) { Alert.alert('Uyarı', 'Mesaj yazın'); return; }
    await botBridge.sendMessage(gid, customMsg);
    Alert.alert('✅', 'Gönderildi');
    setCustomMsg('');
  };

  const handleSendAnnouncement = async () => {
    const gid = getGroupId();
    if (!gid) return;
    if (!announcement.trim()) { Alert.alert('Uyarı', 'Duyuru yazın'); return; }
    try {
      const res = await botBridge.sendAnnouncement(gid, announcement);
      if (res && res.success) {
        Alert.alert('✅', 'Duyuru gönderildi');
        setAnnouncement('');
      } else {
        Alert.alert('❌', 'Gönderilemedi: ' + (res?.error || 'Bilinmeyen hata'));
      }
    } catch (e) {
      Alert.alert('❌', 'Hata: ' + e.message);
    }
  };

  return (
    <ScrollView style={styles.container}>
      {/* Kural Hatırlatması */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📨 Hızlı Mesajlar</Text>
        <Text style={styles.hint}>Kural metnini Ayarlar → Özel Kural Mesajı'ndan düzenleyebilirsiniz.</Text>
        <TouchableOpacity style={styles.quickBtn} onPress={handleSendRules}>
          <Text style={styles.quickBtnText}>📋 Kural Hatırlatması Gönder</Text>
        </TouchableOpacity>
      </View>

      {/* Özel Mesaj */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>✉️ Özel Mesaj</Text>
        <TextInput
          style={styles.input}
          placeholder="Mesajınızı yazın..."
          placeholderTextColor="#8696a0"
          value={customMsg}
          onChangeText={setCustomMsg}
          multiline
          maxLength={1000}
        />
        <TouchableOpacity style={styles.sendBtn} onPress={handleSendCustom}>
          <Text style={styles.sendBtnText}>Gönder</Text>
        </TouchableOpacity>
      </View>

      {/* Duyuru */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📢 Duyuru Gönder</Text>
        <TextInput
          style={[styles.input, { minHeight: 120 }]}
          placeholder="Duyuru metni..."
          placeholderTextColor="#8696a0"
          value={announcement}
          onChangeText={setAnnouncement}
          multiline
          maxLength={5000}
          textAlignVertical="top"
        />
        <Text style={styles.charCount}>{announcement.length}/5000</Text>
        <TouchableOpacity style={styles.sendBtn} onPress={handleSendAnnouncement}>
          <Text style={styles.sendBtnText}>📢 Duyuru Gönder</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21', padding: 16 },
  section: { backgroundColor: '#1f2c33', borderRadius: 12, padding: 16, marginBottom: 12 },
  sectionTitle: { color: '#00a884', fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  hint: { color: '#8696a0', fontSize: 11, marginBottom: 10 },
  quickBtn: { backgroundColor: '#1c3a2a', borderWidth: 1, borderColor: '#00a884', borderRadius: 8, padding: 14, alignItems: 'center' },
  quickBtnText: { color: '#e9edef', fontSize: 14 },
  input: { backgroundColor: '#2a3942', borderRadius: 8, padding: 14, color: '#e9edef', borderWidth: 1, borderColor: '#3b4a54', minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  charCount: { color: '#8696a0', fontSize: 11, textAlign: 'right', marginTop: -8, marginBottom: 8 },
  sendBtn: { backgroundColor: '#00a884', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

export default MessagesScreen;
