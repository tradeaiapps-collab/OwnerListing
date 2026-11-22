FROM alpine:3.20
RUN apk add --no-cache stunnel
COPY stunnel.conf /etc/stunnel/stunnel.conf
USER stunnel
CMD ["stunnel", "/etc/stunnel/stunnel.conf"]
