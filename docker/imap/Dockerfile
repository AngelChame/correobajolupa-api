# Servidor IMAP del laboratorio (D-043): Dovecot 2.3.x sobre Ubuntu 22.04, como en la prueba del
# 13 nov. Solo IMAP en el puerto 143, sin SSH ni otros servicios. Todo corre como el usuario vmail.
# Base fijada por etiqueta y digest; al actualizarla, cambia los dos y anota las versiones en el README.
FROM ubuntu:22.04@sha256:f64b2ffc2f10ab8f8505aa56b2664bd846cbb9df87c7e2532e30f7667021c0e6

ENV DEBIAN_FRONTEND=noninteractive

# Versiones instaladas: ver docker/imap/README.md. No se fijan en apt porque Ubuntu retira del
# archivo las versiones viejas en cuanto publica un parche de seguridad (rompería la construcción).
RUN apt-get update \
  && apt-get install -y --no-install-recommends dovecot-core dovecot-imapd \
  && rm -rf /var/lib/apt/lists/* \
  # Configuración de ejemplo del paquete fuera: solo vale la nuestra (sin conf.d).
  && rm -rf /etc/dovecot/conf.d /etc/dovecot/*.conf.ext /etc/dovecot/dovecot.conf \
  && groupadd -r -g 5000 vmail \
  && useradd -r -u 5000 -g vmail -d /var/vmail -s /usr/sbin/nologin vmail \
  # /var/vmail: buzones (volumen imap-data). /run/dovecot: sockets. /run/dovecot-lab: archivo de
  # usuarios que arma el script de arranque. /var/lib/dovecot: estado interno de Dovecot.
  && mkdir -p /var/vmail /run/dovecot /run/dovecot-lab /var/lib/dovecot \
  && chown vmail:vmail /var/vmail /run/dovecot /run/dovecot-lab /var/lib/dovecot \
  && chmod 0700 /var/vmail /run/dovecot-lab

COPY dovecot.conf /etc/dovecot/dovecot.conf
# ACL global (M7, nº 2): legible por Dovecot, sin permisos de escritura para nadie.
COPY --chmod=0444 dovecot-acl /etc/dovecot/dovecot-acl
COPY --chmod=0755 arranque.sh /usr/local/bin/arranque.sh
COPY --chmod=0755 salud.sh /usr/local/bin/salud.sh

USER vmail
EXPOSE 143
VOLUME ["/var/vmail"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 CMD ["/usr/local/bin/salud.sh"]

ENTRYPOINT ["/usr/local/bin/arranque.sh"]
