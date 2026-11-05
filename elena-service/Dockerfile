FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY media ./media
ENV NODE_ENV=production PORT=3010
EXPOSE 3010
USER node
CMD ["node", "src/main.ts"]
