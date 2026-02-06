# Use puppeteer's official recommended base image
FROM ghcr.io/puppeteer/puppeteer:24.2.0

# Run as root (needed for some Docker environments)
USER root

WORKDIR /app

# Disable Chrome crash reporting via environment
ENV CHROME_CRASHPAD_HANDLER_ENABLED=0
ENV GOOGLE_CRASH_REPORTER_ENABLED=0

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Set environment
ENV NODE_ENV=production

# Create crashpad directory to prevent errors
RUN mkdir -p /tmp/crashpad && chmod 777 /tmp/crashpad

# Run the scraper (as root for compatibility)
CMD ["node", "dist/index.js"]
