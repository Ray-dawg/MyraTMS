# Microsoft's Playwright image — comes with Chromium + system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install dependencies first (cache-friendly layer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npx tsc -p tsconfig.json

# Don't run as root
USER pwuser

ENV NODE_ENV=production
ENV HEADLESS=true

CMD ["node", "dist/index.js"]
