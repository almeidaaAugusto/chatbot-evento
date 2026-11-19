# Imagem do painel. O contexto de build é a pasta painel/; lib/ é montada em /app/lib (somente leitura)
# pelo docker-compose.yml, porque server.js faz require('../lib/...').
FROM node:22-alpine
WORKDIR /app/painel
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "server.js"]
