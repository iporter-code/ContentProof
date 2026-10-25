# Native C2PA's official GNU binary requires newer GLIBC symbols; validated with 2.41.
# Reuse the locked Linux dependencies; never modify the production image.
ARG DEPENDENCY_IMAGE=ccf-validation:c2pa
FROM ${DEPENDENCY_IMAGE}
USER root
WORKDIR /validation
# Upgrade only this disposable validation image through Debian's official repositories.
RUN node -e 'require("fs").writeFileSync("/tmp/contentproof-build-ca.pem",require("tls").rootCertificates.join("\n"))' && sed -i 's/bookworm/trixie/g;s|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::CaInfo=/tmp/contentproof-build-ca.pem -o APT::Update::Error-Mode=any update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::CaInfo=/tmp/contentproof-build-ca.pem -y dist-upgrade
COPY . .
RUN mkdir -p data/app/results && npm test -- --reporter=default --reporter=json --outputFile=data/app/results/linux-current-tests.json && NODE_ENV=production npm run build
