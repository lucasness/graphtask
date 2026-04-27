FROM postgres:17

# Install pgRouting + Node.js
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-17-pgrouting \
       curl \
       ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# App setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
COPY public/ public/
COPY db/schema.sql db/schema.sql
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PGDATA=/var/lib/postgresql/data
ENV POSTGRES_HOST_AUTH_METHOD=trust

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
