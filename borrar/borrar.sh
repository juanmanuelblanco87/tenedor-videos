#!/bin/bash
# 09/11/2026 (dueño: «creá el cron de borrado en Hostinger»): borra de videos-ig los videos por encima del tope por
# nivel, YA archivados y verificados en el repo privado tenedor-videos-archivo (release «archivo»). Lo corre un cron
# de Hostinger (la API no tiene «borrar archivo»). Idempotente: si se repite, no encuentra nada y no borra nada.
# Sólo nombres <letras/números/_/->.mp4 de la lista fija; nada fuera de videos-ig.
set -u
D="$HOME/domains/datos.tenedor.com.ar/public_html/videos-ig"
if [ ! -d "$D" ]; then echo "no existe $D"; ls "$HOME/domains" 2>&1; exit 1; fi
L=$(curl -fsS "https://raw.githubusercontent.com/juanmanuelblanco87/tenedor-videos/main/borrar/sobran-2026-11-09.txt") || { echo "no bajó la lista"; exit 1; }
n=0; b=0; total=0
for f in $L; do
  total=$((total + 1))
  [[ "$f" =~ ^[A-Za-z0-9_-]+\.mp4$ ]] || continue
  if [ -f "$D/$f" ]; then s=$(stat -c %s "$D/$f"); rm -f -- "$D/$f" && { n=$((n + 1)); b=$((b + s)); }; fi
done
echo "lista $total · borrados $n archivos · $((b / 1048576)) MB liberados"
du -sm "$D" 2>/dev/null
