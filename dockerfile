# ---------- STAGE 1 ----------
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY lambda/youtube-downloader.ts ./lambda/

RUN npx esbuild lambda/youtube-downloader.ts \
    --bundle --platform=node --target=node20 \
    --external:@aws-sdk/* \
    --outfile=lambda/youtube-downloader.js


# ---------- STAGE 2 ----------
FROM public.ecr.aws/lambda/nodejs:20-arm64

# Install runtime deps, ffmpeg, and yt-dlp
RUN dnf install -y python3.11 tar xz gzip zlib && \
    dnf clean all && \
    ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    ln -sf /usr/bin/python3.11 /usr/bin/python

# Use the official static builds that work on Amazon Linux 2023 ARM64
# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 \
    -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

# Install ffmpeg
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz \
    -o /tmp/ffmpeg.tar.xz && \
    tar -C /tmp -xf /tmp/ffmpeg.tar.xz && \
    mv /tmp/ffmpeg-*-arm64-static/ffmpeg /usr/local/bin/ffmpeg && \
    chmod +x /usr/local/bin/ffmpeg && \
    rm -rf /tmp/ffmpeg*

# Confirm they work
RUN /usr/local/bin/yt-dlp --version && /usr/local/bin/ffmpeg -version

# Ensure binaries are in PATH
ENV PATH="/usr/local/bin:${PATH}"

# Optional sanity checks (runs at build time)
RUN yt-dlp --version && ffmpeg -version

# Copy built Lambda handler
COPY --from=builder /app/lambda/youtube-downloader.js /var/task/lambda/

CMD ["lambda/youtube-downloader.handler"]
