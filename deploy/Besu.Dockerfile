FROM public.ecr.aws/docker/library/eclipse-temurin:25-jre
ADD --checksum=sha256:927429dd887aca3deb09196c42c88f883258b97d3b9269a12e0204f00d8a5d96 https://github.com/besu-eth/besu/releases/download/26.10.0/besu-26.10.0.tar.gz /tmp/besu.tar.gz
RUN mkdir -p /opt/besu /var/lib/besu && tar -xzf /tmp/besu.tar.gz --strip-components=1 -C /opt/besu && rm /tmp/besu.tar.gz && groupadd -r besu && useradd -r -g besu -u 1001 besu && chown -R besu:besu /var/lib/besu
COPY deploy/besu-entrypoint.sh /opt/besu-entrypoint.sh
USER besu
ENV JAVA_OPTS="-Xms128m -Xmx512m"
ENTRYPOINT ["/bin/sh","/opt/besu-entrypoint.sh"]
