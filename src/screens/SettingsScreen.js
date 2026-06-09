/**
 * Ayarlar Ekranı - Otomasyon toggle + Süre ayarları
 * Ayarlar AsyncStorage + sunucu ile senkronize kalır
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Switch, TextInput, TouchableOpacity, Alert,
} from 'react-native';
import Slider from '@react-native-community/slider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import botBridge from '../services/BotBridge';

const SettingsScreen = () => {
  const [welcome, setWelcome] = useState(true);
  const [noPrice, setNoPrice] = useState(true);
  const [rules, setRules] = useState(true);
  const [deleteDelay, setDeleteDelay] = useState(60);
  const [ruleInterval, setRuleInterval] = useState(6);
  const [customRule, setCustomRule] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Sayfa açılışında ayarları yükle (önce lokal, sonra sunucu)
  useEffect(() => {
    loadSettings();
    const onStatus = (data) => {
      if (data.config) {
        setWelcome(data.config.welcome ?? true);
        setNoPrice(data.config.noPrice ?? true);
        setRules(data.config.rules ?? true);
      }
    };
    botBridge.on('status', onStatus);
    return () => botBridge.off('status', onStatus);
  }, []);

  const loadSettings = async () => {
    try {
      const saved = await AsyncStorage.getItem('botSettings');
      if (saved) {
        const s = JSON.parse(saved);
        setWelcome(s.welcome ?? true);
        setNoPrice(s.noPrice ?? true);
        setRules(s.rules ?? true);
        setDeleteDelay(s.deleteDelay ?? 60);
        setRuleInterval(s.ruleInterval ?? 6);
        setCustomRule(s.customRule || '');
      }
    } catch (e) {}
    setLoaded(true);
  };

  const saveLocal = async (key, value) => {
    try {
      const saved = await AsyncStorage.getItem('botSettings');
      const s = saved ? JSON.parse(saved) : {};
      s[key] = value;
      await AsyncStorage.setItem('botSettings', JSON.stringify(s));
    } catch (e) {}
  };

  const toggle = (type, val) => {
    if (type === 'welcome') { setWelcome(val); saveLocal('welcome', val); }
    if (type === 'noPrice') { setNoPrice(val); saveLocal('noPrice', val); }
    if (type === 'rules') { setRules(val); saveLocal('rules', val); }
    botBridge.setAutomation(type, val);
  };

  const handleDelayChange = (v) => {
    const s = Math.round(v);
    setDeleteDelay(s);
    saveLocal('deleteDelay', s);
    botBridge.setDeleteDelay(s);
  };

  const handleIntervalChange = (v) => {
    const h = Math.round(v);
    setRuleInterval(h);
    saveLocal('ruleInterval', h);
    botBridge.setRuleInterval(h);
  };

  const handleSaveRule = () => {
    saveLocal('customRule', customRule);
    botBridge.setCustomRule(customRule);
    Alert.alert('✅', 'Kaydedildi');
  };

  const handleClearLogs = () => {
    Alert.alert('Logları Sil', 'Tüm silinen ilan kayıtları silinecek.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Sil', style: 'destructive', onPress: () => botBridge.clearLogs() },
    ]);
  };

  const handleClearMedia = () => {
    botBridge.clearMediaCache();
    Alert.alert('✅', 'Medya önbelleği temizlendi');
  };

  const handleRestart = () => {
    Alert.alert('Bot Restart', 'Bot yeniden bağlanacak.', [
      { text: 'İptal', style: 'cancel' },
      { text: 'Restart', onPress: () => botBridge.restart() },
    ]);
  };

  return (
    <ScrollView style={styles.container}>
      {/* Otomasyon */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🤖 Otomasyon</Text>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Hoş Geldin Mesajı</Text>
            <Text style={styles.desc}>Yeni üyelere otomatik karşılama</Text>
          </View>
          <Switch value={welcome} onValueChange={(v) => toggle('welcome', v)} trackColor={{ false: '#3b4a54', true: '#00a884' }} thumbColor="#fff" />
        </View>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Fiyatsız İlan Silme</Text>
            <Text style={styles.desc}>1. uyar + sil, 2. anında sessiz sil</Text>
          </View>
          <Switch value={noPrice} onValueChange={(v) => toggle('noPrice', v)} trackColor={{ false: '#3b4a54', true: '#00a884' }} thumbColor="#fff" />
        </View>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Kural Hatırlatma</Text>
            <Text style={styles.desc}>Periyodik kural mesajı</Text>
          </View>
          <Switch value={rules} onValueChange={(v) => toggle('rules', v)} trackColor={{ false: '#3b4a54', true: '#00a884' }} thumbColor="#fff" />
        </View>
      </View>

      {/* Zamanlama */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⏱️ Zamanlama</Text>
        <Text style={styles.sliderLabel}>Silme Süresi: {deleteDelay} saniye</Text>
        <Slider
          minimumValue={10} maximumValue={120} step={5}
          value={deleteDelay} onSlidingComplete={handleDelayChange}
          minimumTrackTintColor="#00a884" maximumTrackTintColor="#3b4a54" thumbTintColor="#00a884"
        />
        <Text style={[styles.sliderLabel, { marginTop: 16 }]}>Kural Hatırlatma: Her {ruleInterval} saat</Text>
        <Slider
          minimumValue={1} maximumValue={12} step={1}
          value={ruleInterval} onSlidingComplete={handleIntervalChange}
          minimumTrackTintColor="#00a884" maximumTrackTintColor="#3b4a54" thumbTintColor="#00a884"
        />
      </View>

      {/* Özel Kural */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📝 Özel Kural Mesajı</Text>
        <TextInput
          style={styles.textArea}
          placeholder="Boş = varsayılan kural mesajı"
          placeholderTextColor="#8696a0"
          value={customRule}
          onChangeText={setCustomRule}
          multiline
          maxLength={2000}
          textAlignVertical="top"
        />
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveRule}>
          <Text style={styles.saveBtnText}>💾 Kaydet</Text>
        </TouchableOpacity>
      </View>

      {/* Veri */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🗄️ Veri</Text>
        <TouchableOpacity style={styles.dataBtn} onPress={handleClearMedia}>
          <Text style={styles.dataBtnText}>🖼️ Medya Önbelleğini Temizle</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.dataBtn, { borderColor: '#ea0038' }]} onPress={handleClearLogs}>
          <Text style={styles.dataBtnText}>🗑️ Tüm Logları Sil</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.dataBtn, { borderColor: '#f7c948', marginTop: 4 }]} onPress={handleRestart}>
          <Text style={[styles.dataBtnText, { color: '#f7c948' }]}>🔄 Bot Restart</Text>
        </TouchableOpacity>
      </View>

      {/* Bilgi */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ℹ️ Hakkında</Text>
        <Text style={styles.info}>WhatsApp Grup Yönetici v1.0</Text>
        <Text style={styles.info}>By KuZGuN</Text>
        <Text style={styles.info}>WP İletişim: 0539 681 47 93</Text>
        <Text style={styles.info}>Telefonda çalışır - PC gerekmez</Text>
        <Text style={styles.info}>WhatsApp açık olmadan arka planda çalışır</Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111b21', padding: 16 },
  section: { backgroundColor: '#1f2c33', borderRadius: 12, padding: 16, marginBottom: 12 },
  sectionTitle: { color: '#00a884', fontSize: 13, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#2a3942' },
  label: { color: '#e9edef', fontSize: 14 },
  desc: { color: '#8696a0', fontSize: 11, marginTop: 2 },
  sliderLabel: { color: '#e9edef', fontSize: 13, marginBottom: 4 },
  textArea: { backgroundColor: '#2a3942', borderRadius: 8, padding: 14, color: '#e9edef', borderWidth: 1, borderColor: '#3b4a54', minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  saveBtn: { backgroundColor: '#00a884', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '600' },
  dataBtn: { backgroundColor: '#2a3942', padding: 14, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#3b4a54' },
  dataBtnText: { color: '#e9edef', fontSize: 13 },
  info: { color: '#8696a0', fontSize: 12, marginBottom: 4 },
});

export default SettingsScreen;
