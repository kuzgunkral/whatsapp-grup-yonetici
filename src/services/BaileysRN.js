/**
 * Baileys React Native Adapter
 * Baileys'in Node.js bağımlılıklarını React Native alternatifleriyle değiştirir.
 * Bu dosya Baileys'i React Native'de çalıştırır.
 * 
 * Strateji: Baileys'in WebSocket + Protobuf katmanını kullanıp,
 * crypto/fs/net bağımlılıklarını RN native modülleriyle karşılıyoruz.
 */

import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Global polyfills
global.Buffer = Buffer;
global.process = global.process || require('process');
global.process.env = global.process.env || {};

/**
 * Auth State - AsyncStorage tabanlı (Baileys useMultiFileAuthState yerine)
 */
export async function useAsyncStorageAuthState() {
  const KEY_PREFIX = 'baileys_auth_';

  const writeData = async (key, data) => {
    try {
      await AsyncStorage.setItem(KEY_PREFIX + key, JSON.stringify(data));
    } catch (e) {}
  };

  const readData = async (key) => {
    try {
      const data = await AsyncStorage.getItem(KEY_PREFIX + key);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await AsyncStorage.removeItem(KEY_PREFIX + key);
    } catch (e) {}
  };

  // Creds yükle
  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const value = await readData(`${type}-${id}`);
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                await writeData(`${category}-${id}`, value);
              } else {
                await removeData(`${category}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

/**
 * Initial auth credentials
 */
function initAuthCreds() {
  return {
    noiseKey: generateKeyPair(),
    pairingEphemeralKeyPair: generateKeyPair(),
    signedIdentityKey: generateKeyPair(),
    signedPreKey: generateSignedPreKey(),
    registrationId: generateRegistrationId(),
    advSecretKey: generateRandomBase64(32),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
  };
}

function generateKeyPair() {
  // Placeholder - gerçek implementasyonda curve25519 kullanılır
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { private: Buffer.from(priv), public: Buffer.from(priv) };
}

function generateSignedPreKey() {
  return { keyPair: generateKeyPair(), signature: Buffer.alloc(64), keyId: 1 };
}

function generateRegistrationId() {
  return Math.floor(Math.random() * 16383) + 1;
}

function generateRandomBase64(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export default {
  useAsyncStorageAuthState,
};
