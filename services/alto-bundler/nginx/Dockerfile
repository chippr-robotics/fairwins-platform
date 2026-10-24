# Origin-lock ingress sidecar for the alto ERC-4337 bundler (spec 041 SC-009).
# A thin nginx that validates Cloudflare's X-Origin-Auth header, then proxies to the alto sidecar on
# localhost:3000. Deployed as the INGRESS container of a multi-container Cloud Run service; alto runs
# alongside it as a localhost-only sidecar (see ../deploy/service.yaml).
FROM nginx:1.30.5-alpine

# `envsubst` ships in the gettext package on alpine.
RUN apk add --no-cache gettext

# Remove the stock server block; our entrypoint renders conf.d/default.conf from the template.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY bundler.conf.template /etc/nginx/templates/bundler.conf.template
COPY docker-entrypoint.sh /docker-entrypoint-bundler.sh
RUN chmod +x /docker-entrypoint-bundler.sh

EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint-bundler.sh"]
