# Offline regression checks using an already built, trusted local project image.
# Does not update the production image or any running container/data volume.
ARG VALIDATION_BASE=ccf-engineering-check-contentproof:latest
FROM ${VALIDATION_BASE}
USER root
ENV NODE_ENV=test
WORKDIR /validation
COPY package.json package-lock.json ./
RUN npm ci --offline --include=dev --no-audit --no-fund
COPY . .
RUN mkdir -p data/app/results && npm test -- --reporter=default --reporter=json --outputFile=data/app/results/linux-current-tests.json && NODE_ENV=production npm run build
