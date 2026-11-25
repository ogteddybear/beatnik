#
# install / build npm deps
#
FROM node:24-trixie AS deps-builder
WORKDIR /app
ARG TARGETARCH

# fix GCC14 issue with compiling opus on arm64
ENV CFLAGS="-Wno-error=implicit-function-declaration"

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Keep the standalone binaries available in the distroless runtime image.
RUN case "$TARGETARCH" in \
      amd64) YTDLP_ASSET=yt-dlp_linux; DENO_ARCH=x86_64 ;; \
      arm64) YTDLP_ASSET=yt-dlp_linux_aarch64; DENO_ARCH=aarch64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/$YTDLP_ASSET" -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v2.9.8/deno-$DENO_ARCH-unknown-linux-gnu.zip" -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip deno -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip

COPY package.json ./
COPY pnpm-lock.yaml ./

RUN corepack enable && corepack install
RUN pnpm install --frozen-lockfile

#
# build app for distroless / optimize deps
#
FROM deps-builder AS app-builder
WORKDIR /app

RUN mkdir -p library
COPY tsdown.config.ts ./
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# prune dev deps and clean up
RUN pnpm prune --prod \
 && find node_modules -type f \( \
      -name "*.md" -o -name "*.map" -o -name "*.ts" \
      -o -name "CHANGELOG*" -o -name "README*" \
      -o -name "LICENSE*" -o -name "*.test.js" \
    \) -delete \
 && find node_modules -type d \( -name "test" -o -name "tests" -o -name "__tests__" \) \
      -exec rm -rf {} + 2>/dev/null; true \
 && rm -rf node_modules/@discordjs/opus/build-tmp-napi-v3

#
# production
#
FROM gcr.io/distroless/nodejs24-debian13 AS prod
WORKDIR /app
ENV PATH="/usr/local/bin:/usr/bin:/bin"
ENV DATABASE_URL="/app/library.db" \
    LIBRARY_PATH="/app/library" \
    NODE_ENV="production"
COPY --from=app-builder /app/dist ./dist
COPY --from=app-builder /app/src/web/views ./src/web/views
COPY --from=app-builder /app/src/web/public ./src/web/public
COPY --from=app-builder /app/node_modules ./node_modules
COPY --from=app-builder /app/package.json ./
COPY --from=deps-builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=deps-builder /usr/local/bin/deno /usr/local/bin/deno
EXPOSE 8080
CMD ["dist/index.mjs"]

#
# dev server
# (bind mount required for src directory)
#
FROM deps-builder AS dev-server
WORKDIR /app
COPY tsconfig.json ./
CMD ["./node_modules/.bin/tsx", "watch", "src/index.ts"]
