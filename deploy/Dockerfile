ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build && node -e "require('fs').rmSync('/app/data',{recursive:true,force:true})"
RUN npm prune --omit=dev --no-audit --no-fund && mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV NODE_ENV=production DEMO_MODE=false
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-app.mjs", "--built"]
