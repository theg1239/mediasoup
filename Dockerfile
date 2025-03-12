FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3-pip \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x ./node_modules/mediasoup/worker/out/Release/mediasoup-worker

EXPOSE 3001
EXPOSE 40000-49999/udp

CMD [ "npm", "start" ]
