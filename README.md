# volume-doctor

Iguala o volume de uma biblioteca de música (Navidrome/Symfonium) com ReplayGain.

- **Escanear**: mede a loudness integrada (EBU R128) e o pico de cada faixa com o `ffmpeg`. Faixas já medidas e não alteradas não são medidas de novo.
- **Ver**: histograma da loudness (hoje × depois da correção) e dispersão loudness × pico, que mostra quem não tem folga pra subir sem distorcer.
- **Ajustar**: alvo em LUFS (−18 ReplayGain, −16 Apple, −14 Spotify), limite pelo pico e ajuste manual por faixa ou em lote. O player toca no navegador com o ganho aplicado, com A/B entre corrigido e original (tecla `A`).
- **Aplicar**: grava `REPLAYGAIN_TRACK/ALBUM_GAIN/PEAK` em MP3, FLAC, M4A e Ogg. O áudio não muda. **Reverter** restaura as tags que existiam antes.

O ganho de álbum agrupa as faixas por pasta + tag de álbum, com loudness média ponderada pela duração.

## Rodar

No ZimaOS: `Apps/volume-doctor/docker-compose.yml` (porta 8992, `/data` = estado, `/music` = biblioteca com escrita).

Variáveis: `WORKERS` (ffmpegs em paralelo, padrão 3), `NICE` (padrão 15), e opcionalmente `ND_URL`/`ND_USER`/`ND_PASS` pra disparar o scan do Navidrome depois de gravar.

Importar medições feitas fora do app (TSV `LUFS<TAB>pico<TAB>caminho`): `python -m volume_doctor.importer arquivo.tsv`.

Local: `DATA_DIR=./data MUSIC_DIR=/caminho/musica uvicorn volume_doctor.webapp:app --port 8992`.
