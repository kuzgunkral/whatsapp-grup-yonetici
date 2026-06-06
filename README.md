# WhatsApp Grup Yönetici - Bağımsız Android APK

## Mimari

```
┌─────────────────────────────────────────┐
│            Tek APK                       │
├─────────────────────────────────────────┤
│  React Native UI (Expo)                  │
│  - 5 Tab (Ana, Moderasyon, Mesaj,        │
│    Log, Ayarlar)                         │
│  - Pairing Code ile bağlantı             │
├────────── localhost:3001 ────────────────┤
│  Gömülü Node.js Server                   │
│  - Baileys (WhatsApp bağlantısı)         │
│  - Express (API)                         │
│  - Tüm kurallar + filtreler             │
├─────────────────────────────────────────┤
│  Android Foreground Service              │
│  - Arka planda çalışır                   │
│  - WhatsApp açık olmadan aktif           │
│  - Bildirimde "Bot Aktif" yazar          │
└─────────────────────────────────────────┘
```

## Kurulum ve Build

### Gereksinimler
- Node.js 18+
- Expo CLI: `npm install -g eas-cli`
- Expo hesabı: https://expo.dev (ücretsiz)

### Build (APK oluşturma)

```bash
cd whatsapp-group-manager/mobile

# Bağımlılıkları kur
npm install

# Expo hesabına giriş
npx eas login

# APK derle (bulutta, ücretsiz)
npx eas build --platform android --profile preview

# APK linki terminalde görünür — indir, telefona kur
```

### İlk Kullanım

1. APK'yı kur, aç
2. Telefon numaranı gir (905XXXXXXXXX)
3. Eşleştirme kodu ekranda çıkar
4. WhatsApp → Bağlı Cihazlar → Telefon numarasıyla bağla → Kodu gir
5. Bitti. Arka planda çalışır.

## Teknik Not

Bu uygulama içinde gömülü bir Node.js sunucusu çalıştırır.
APK'nın içindeki `nodejs-assets/` klasöründeki Baileys engine,
uygulama açıldığında otomatik başlatılır ve localhost:3001'de dinler.
React Native UI bu sunucuya bağlanarak kontrol sağlar.

Telefon açık + internet olduğu sürece bot aktif kalır.
WhatsApp'ın açık olmasına gerek yoktur.
