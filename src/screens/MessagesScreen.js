/**
 * Mesajlar Ekranı - Duyuru / Kural / Özel Mesaj
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import botBridge from '../services/BotBridge';

const MessagesScreen = () => {
  const [customMsg, setCustomMsg] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [ruleText, setRuleText] = useState('');

  useEffect(() => {
    // Önce sunucudan çek, yoksa AsyncStorage'dan yükle
    botBridge.getRuleMessage().then((res) => {
      if (res && res.message) {
        setRuleText(res.message);
      } else {
        AsyncStorage.getItem('botSettings').then((saved) => {
          if (saved) {
            const s = JSON.parse(saved);
            if (s.customRule) setRuleText(s.customRule);
          }
        }).catch(() => {});
      }
    }).catch(() => {
      AsyncStorage.getItem('botSettings').then((saved) => {
        if (saved) {
          const s = JSON.parse(saved);
          if (s.customRule) setRuleText(s.customRule);
        }
      }).catch(() => {});
    });
  }, []);

  const getGroupId = () => {
    const active = botBridge.activeGroupId;
    if (active) return active;
    if (botBridge.groups && botBridge.groups.length > 0) return botBridge.groups[0]?.id;
    Alert.alert('Uyarı', 'Grup yok veya bağlı değil');
    return null;
  };

  const handleSaveRule = async () => {
    try {
      const saved = await AsyncStorage.getItem('botSettings');
      const s = saved ? JSON.parse(saved) : {};
      s.customRule = ruleText;
      await AsyncStorage.setItem('botSettings', JSON.stringify(s));
      botBridge.setCustomRule(ruleText);
      Alert.alert('✅', 'Kural mesajı kaydedildi');
    } catch (e) {
      Alert.alert('❌', 'Kaydedilemedi');
    }
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
    // Mesajın altına ve üstüne çizgi ekle
    const formatted = `━━━━━━━━━━━━━━━━\n${customMsg.trim()}\n━━━━━━━━━━━━━━━━`;
    await botBridge.sendMessage(gid, formatted);
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
      {/* Kural Mesajı Düzenle */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📋 Kural Mesajı</Text>
        <TextInput
          style={[styles.input, { minHeight: 160 }]}
          placeholder="Kural metnini buraya yazın..."
          placeholderTextColor="#8696a0"
          value={ruleText}
          onChangeText={setRuleText}
          multiline
          maxLength={5000}
          textAlignVertical="top"
        />
        <Text style={styles.charCount}>{ruleText.length}/5000</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.sendBtn, { flex: 1, backgroundColor: '#2a3942', borderWidth: 1, borderColor: '#00a884' }]} onPress={handleSaveRule}>
            <Text style={[styles.sendBtnText, { color: '#00a884' }]}>💾 Kaydet</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.sendBtn, { flex: 1 }]} onPress={handleSendRules}>
            <Text style={styles.sendBtnText}>📋 Kural Gönder</Text>
          </TouchableOpacity>
        </View>
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
  input: { backgroundColor: '#2a3942', borderRadius: 8, padding: 14, color: '#e9edef', borderWidth: 1, borderColor: '#3b4a54', minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  charCount: { color: '#8696a0', fontSize: 11, textAlign: 'right', marginTop: -8, marginBottom: 8 },
  btnRow: { flexDirection: 'row', gap: 8 },
  sendBtn: { backgroundColor: '#00a884', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

export default MessagesScreen;
