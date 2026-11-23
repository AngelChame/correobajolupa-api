#!/bin/bash
# Healthcheck: Dovecot saluda en el 143 y su base de usuarios responde. Sin contraseña.
set -euo pipefail

exec 3<>/dev/tcp/127.0.0.1/143
IFS= read -r -t 3 saludo <&3
exec 3<&- 3>&-
[[ "$saludo" == "* OK"* ]]

doveadm user student@lab.example > /dev/null
