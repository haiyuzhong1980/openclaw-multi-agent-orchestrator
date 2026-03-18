FROM node:22-slim

WORKDIR /app

# Copy OMA plugin source
COPY . /app/

# Install dependencies if package-lock.json exists
RUN if [ -f package-lock.json ]; then npm ci --omit=dev 2>/dev/null || true; fi
RUN if [ -f package.json ]; then npm install 2>/dev/null || true; fi

# Create shared-memory directory
RUN mkdir -p /root/.openclaw/shared-memory

# Default: run the 30-day simulation
ENTRYPOINT ["node", "--experimental-strip-types"]
CMD ["tests/simulation/simulate-days.ts", "--days", "30", "--messages-per-day", "40", "--verbose"]
