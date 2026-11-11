#!/bin/bash
# Carga las claves de IA gratis que usa el encargado de cartas (cartas.yml) SIN mostrarlas: las toma de
# Proyecto Tenedor\Claves\env.local. Lo corre el dueño con cargar-secretos-cartas.cmd.
cd "$(dirname "$0")/.." || exit 1
R=juanmanuelblanco87/tenedor-videos
for k in GROQ_API_KEY GEMINI_API_KEY MISTRAL_API_KEY CEREBRAS_API_KEY; do
  v=$(grep -h "^$k=" ../Claves/env.local | head -1 | cut -d= -f2- | tr -d '\r\n"')
  if [ -n "$v" ]; then printf '%s' "$v" | gh secret set $k --repo $R && echo "$k cargada"; else echo "$k: no está en env.local (se saltea)"; fi
done
grep -o '"database_name": "tenedor-hechos", "database_id": "[0-9a-f-]*"' tenedor-cf-ig/wrangler.jsonc | grep -o '[0-9a-f-]\{36\}' | tr -d '\n' | gh secret set D1_HECHOS_ID --repo $R && echo "D1_HECHOS_ID cargada"
