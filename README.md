# tenedor-videos

Motor que recupera videos de Instagram cuyo enlace ya venció: obtiene un enlace nuevo con
[yt-dlp](https://github.com/yt-dlp/yt-dlp), lo achica con ffmpeg y lo guarda en el almacenamiento propio.

Corre en GitHub Actions cada 6 horas (`.github/workflows/motor.yml`). Las credenciales son secretos del
repositorio; este código no contiene ninguna.
