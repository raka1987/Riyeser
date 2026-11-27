# The Riyeser relay in a container (optional; setup.sh --docker). Built from Ubuntu 24.04 with Ubuntu's own Node
# package, so nothing comes from npm. The relay has no dependencies.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /var/lib/riyeser-relay riyeser-relay && install -d -o riyeser-relay /var/lib/riyeser-relay
COPY --chown=root:root . /opt/riyeser-relay/app
WORKDIR /opt/riyeser-relay/app
USER riyeser-relay
CMD ["node", "server.js"]
