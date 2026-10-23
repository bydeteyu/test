FROM node:22-alpine
# Threads 공개 페이지를 읽는 가상 브라우저(Chromium)
RUN apk add --no-cache chromium font-noto-cjk
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
