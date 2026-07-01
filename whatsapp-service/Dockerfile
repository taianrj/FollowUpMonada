FROM node:20-alpine

# Cria e define o diretório de trabalho
WORKDIR /app

# Instala o git necessário para dependências que usam repositórios git no package.json
RUN apk add --no-cache git

# Copia os arquivos de dependências
COPY package.json ./

# Instala apenas as dependências de produção de forma limpa
RUN npm install --omit=dev

# Copia o código da aplicação
COPY server.js ./

# Configurações de ambiente padrão
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Expõe a porta HTTP
EXPOSE 8080

# Inicia o servidor Node.js
CMD ["npm", "start"]
