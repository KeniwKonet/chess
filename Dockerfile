# The ChessFront server (online play, plus the battle mode's online rooms).
# Runs anywhere that runs containers: Render, Railway, Fly.io, Koyeb, a VPS.
#   docker build -t chessfront-server .
#   docker run -p 8787:8787 -e DATABASE_URL=postgres://… chessfront-server
# Without DATABASE_URL it keeps an embedded database in /data (mount a volume there).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace @cr/server --include-workspace-root=false && npm cache clean --force
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "apps/server/src/main.ts"]
