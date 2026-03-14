FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && pip3 install --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
