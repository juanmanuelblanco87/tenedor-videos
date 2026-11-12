#!/bin/bash
# Carga las claves S3 de R2 (Proyecto Tenedor\Claves\cloudflare-r2.txt) como secretos del repo tenedor-videos SIN
# mostrarlas. Con ellas a-r2.mjs sube a R2 por la API S3 (no gasta el límite de 1.200 pedidos/5 min de api.cloudflare.com
# que comparten D1 y los demás procesos). Lo corre el dueño con cargar-secretos-r2.cmd.
cd "$(dirname "$0")/.." || exit 1
R=juanmanuelblanco87/tenedor-videos
F=../Claves/cloudflare-r2.txt
set -e
grep '^Access Key ID=' $F | cut -d= -f2- | tr -d '\r\n ' | gh secret set R2_ACCESS_KEY_ID --repo $R
grep '^Secret Access Key=' $F | cut -d= -f2- | tr -d '\r\n ' | gh secret set R2_SECRET_ACCESS_KEY --repo $R
grep '^S3 API endpoint=' $F | cut -d= -f2- | tr -d '\r\n ' | gh secret set R2_ENDPOINT --repo $R
echo
echo "Secretos cargados:"
gh secret list --repo $R | cut -f1
