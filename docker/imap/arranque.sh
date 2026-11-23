#!/bin/sh
# Arranque del IMAP de laboratorio: arma el archivo de usuarios con el hash de IMAP_LAB_PASSWORD
# y luego cede el proceso a Dovecot. Nunca imprime la contraseña ni el hash (sin set -x).
set -eu

if [ -z "${IMAP_LAB_PASSWORD:-}" ]; then
  echo "arranque: falta IMAP_LAB_PASSWORD; el IMAP de laboratorio no arranca" >&2
  exit 1
fi
if [ "${#IMAP_LAB_PASSWORD}" -lt 16 ]; then
  echo "arranque: IMAP_LAB_PASSWORD debe tener al menos 16 caracteres; el IMAP de laboratorio no arranca" >&2
  exit 1
fi

umask 077
USERS=/run/dovecot-lab/users
TMP="$USERS.tmp"

# Hash con sal aleatoria (SHA512-CRYPT). La contraseña en claro no se escribe en ningún archivo.
HASH=$(doveadm pw -s SHA512-CRYPT -p "$IMAP_LAB_PASSWORD")
unset IMAP_LAB_PASSWORD

: > "$TMP"
for usuario in student teacher staff; do
  # usuario:hash:uid:gid:gecos:home:shell (passwd-file de Dovecot)
  printf '%s@lab.example:%s:5000:5000::/var/vmail/lab.example/%s::\n' "$usuario" "$HASH" "$usuario" >> "$TMP"
done
unset HASH
mv "$TMP" "$USERS"

echo "arranque: usuarios del laboratorio listos (student, teacher y staff @lab.example)" >&2
exec dovecot -F
