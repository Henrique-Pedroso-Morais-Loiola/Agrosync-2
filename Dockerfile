FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["npm", "start"]
