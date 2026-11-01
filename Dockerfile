# Multi-stage build: compile TypeScript in one stage, ship the compiled output
# plus the exact node_modules that were built and generated there.
#
# Why node_modules is copied instead of reinstalled with --omit=dev: the
# `prisma` CLI is a devDependency, and the start command needs it to run
# migrations. A bare `npx prisma` with no local copy downloads the LATEST
# major version, which does not match this project's schema.

FROM node:20-slim AS build
WORKDIR /app
# Prisma's engine needs OpenSSL, which the slim image does not include.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 4000
# Apply any new migrations, then start. Safe on every deploy: migrate deploy
# only runs migrations that have not been applied yet.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/index.js"]
