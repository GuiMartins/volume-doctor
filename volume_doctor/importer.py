"""Importa medições feitas fora do app (TSV: LUFS<TAB>pico_dBFS<TAB>caminho_absoluto).

    python -m volume_doctor.importer /data/seed.tsv
"""
import csv
import os
import sys

from . import db
from .jobs import now
from .tags import read_info


def main(path):
    c = db.conn()
    n = skipped = 0
    for row in csv.reader(open(path, encoding="utf-8"), delimiter="\t"):
        if len(row) != 3:
            continue
        try:
            lufs, peak = float(row[0]), float(row[1])
        except ValueError:
            skipped += 1
            continue
        rel = os.path.relpath(row[2], db.MUSIC_DIR)
        full = db.abspath(rel)
        if rel.startswith("..") or not os.path.isfile(full):
            skipped += 1
            continue
        st = os.stat(full)
        info = read_info(full)
        c.execute(
            "INSERT INTO tracks(path, size, mtime, artist, albumartist, album, title, duration,"
            " file_tg, file_tp, file_ag, file_ap, lufs, peak_db, measured_at, seen)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)"
            " ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,"
            " lufs=excluded.lufs, peak_db=excluded.peak_db, measured_at=excluded.measured_at, error=NULL",
            (rel, st.st_size, st.st_mtime, info["artist"], info["albumartist"], info["album"], info["title"],
             info["duration"], info["tg"], info["tp"], info["ag"], info["ap"], lufs, peak, now()))
        n += 1
        if n % 200 == 0:
            c.commit()
            print(f"{n}...", flush=True)
    c.commit()
    db.set_meta("last_scan", now())
    print(f"importadas={n} ignoradas={skipped}")


if __name__ == "__main__":
    main(sys.argv[1])
