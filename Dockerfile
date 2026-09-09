# Run the Bun subscription service in a container.
# Used by the "app" profile in docker-compose.yml.
FROM oven/bun:1 AS runtime

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json ./
RUN bun install --production

# Copy application source.
COPY . .

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
