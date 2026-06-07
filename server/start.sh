#!/bin/bash
# WARP'ı proxy modunda başlat
warp-cli --accept-tos registration new || true
warp-cli --accept-tos mode proxy || true
warp-cli --accept-tos proxy port 1080 || true
warp-cli --accept-tos connect || true

# 3 saniye bekle
sleep 3

# Node.js sunucuyu başlat
export USE_PROXY=true
node index.js
