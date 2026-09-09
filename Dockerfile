# Run the Bun subscription service in a container.
# Used by the "app" profile in docker-compose.yml.
FROM oven/bun:1 AS runtime

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json ./
RUN bun install --production

# Copy application source.
COPY . .

# The service reads its port from the PORT env var at runtime (see src/index.ts).
# EXPOSE is informational only; pass --build-arg PORT=xxxx to document another
# port, and set PORT in the environment (docker-compose env_file: .env) to
# actually listen on it.
ARG PORT=3000
EXPOSE ${PORT}

CMD ["bun", "run", "src/index.ts"]
