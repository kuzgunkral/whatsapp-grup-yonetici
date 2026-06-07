FROM node:20
RUN apt-get update && apt-get install -y git curl gnupg lsb-release && \
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" > /etc/apt/sources.list.d/cloudflare-client.list && \
    apt-get update && apt-get install -y cloudflare-warp && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
COPY start.sh .
RUN chmod +x start.sh
CMD ["./start.sh"]
