FROM nginx:1.29-alpine

ENV WEB_PORT=8080 \
    BRIDGE_URL=http://127.0.0.1:4242

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY web /usr/share/nginx/html

EXPOSE 8080
