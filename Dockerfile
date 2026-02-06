# Use puppeteer's official recommended base image
FROM ghcr.io/puppeteer/puppeteer:24.2.0

# Switch to root for setup
USER root

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies (puppeteer needs to be installed to work with bundled Chrome)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Set environment
ENV NODE_ENV=production

# Switch back to pptruser (non-root) for security
USER pptruser

# Run the scraper
CMD ["node", "dist/index.js"]
