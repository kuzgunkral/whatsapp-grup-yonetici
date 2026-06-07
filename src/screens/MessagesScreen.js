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
    if (botBridge.groups.length === 0) {
      Alert.alert('Uyarı', 'Grup yok veya bağlı değil');
      return null;
    }
    return botBridge.groups[0]?.id;
  };

  const handleSendRules = () => {
    const gid = getGroupId();
    if (gid) botBridge.sendRules(gid);
    Alert.alert('✅', 'Kurallar gönderildi');
  };

  const handleSendCustom = () => {
    const gid = getGroupId();
    if (!gid) return;
    if (!customMsg.trim()) { Alert.alert('Uyarı', 'Mesaj yazın'); return; }
    botBridge.sendMessage(gid, customMsg);
    Alert.alert('✅', 'Gönderildi');
    setCustomMsg('');
  };

  const handleSendAnnouncement = () => {
    const gid = getGroupId();
    if (!gid) return;
    if (!announcement.trim()) { Alert.alert('Uyarı', 'Duyuru yazın'); return; }
    botBridge.sendAnnouncement(gid, announcement);
    Alert.alert('✅', 'Duyuru gönderildi + sabitlendi');
    setAnnouncement('');
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📨 Hızlı Mesajlar</Text>
        <TouchableOpacity style={styles.quickBtn} onPress={handleSendRules}>
          <Text style={styles.quickBtnText}>📋 Kural Hatırlatması Gönder</Text>
        </TouchableOpacity>
      </View>

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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📌 Duyuru (5000 karakter)</Text>
        <TextInput
          style={[styles.input, { minHeight: 150 }]}
          placeholder="Duyuru metni..."
          placeholderTextColor="#8696a0"
          value={announcement}
          onChangeText={setAnnouncement}
          multiline
          maxLength={5000}
          textAlignVertical="top"
        />
        <Text style={styles.charCount}>{announcement.length}/5000</Text>
        <TouchableOpacity style={[styles.sendBtn, { backgroundColor: '#f7c948' }]} onPress={handleSendAnnouncement}>
          <Text style={[styles.sendBtnText, { color: '#111' }]}>📌 Duyuru Gönder + Sabitle</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21', padding: 16 },
  section: { backgroundColor: '#1f2c33', borderRadius: 12, padding: 16, marginBottom: 12 },
  sectionTitle: { color: '#00a884', fontSize: 13, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase' },
  quickBtn: { backgroundColor: '#1c3a2a', borderWidth: 1, borderColor: '#00a884', borderRadius: 8, padding: 14, alignItems: 'center' },
  quickBtnText: { color: '#e9edef', fontSize: 14 },
  input: { backgroundColor: '#2a3942', borderRadius: 8, padding: 14, color: '#e9edef', borderWidth: 1, borderColor: '#3b4a54', minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  charCount: { color: '#8696a0', fontSize: 11, textAlign: 'right', marginTop: -8, marginBottom: 8 },
  sendBtn: { backgroundColor: '#00a884', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

export default MessagesScreen;
