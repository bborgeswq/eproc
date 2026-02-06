# Use puppeteer's official recommended base image
FROM ghcr.io/puppeteer/puppeteer:24.2.0

USER root
WORKDIR /app

# Install pnpm via npm (avoids corepack signature issues)
RUN npm install -g pnpm@10.28.2

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies (won't download Chrome due to env vars above)
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY . .
RUN pnpm build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
