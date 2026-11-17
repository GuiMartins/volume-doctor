"""Cálculo do ReplayGain. A mesma lógica existe em static/app.js (prévia ao vivo na UI): mantenha as duas iguais."""
import math
import os
from collections import defaultdict

TOLERANCE_DB = 0.05


def album_key(path, album):
    return os.path.dirname(path) + "\x00" + (album or "").strip().lower()


def _limit(gain, peak_db, clip_limit):
    """Com clip_limit, um ganho positivo nunca leva o pico acima de 0 dBFS (e nunca vira negativo)."""
    if clip_limit and gain > 0:
        capped = max(0.0, min(gain, -peak_db))
        return capped, capped < gain - 0.005
    return gain, False


def compute(rows, settings):
    """rows: dicts com id, path, album, lufs, peak_db, duration, offset_db.
    Devolve {id: {tg, tp, ag, ap, limited}} só para faixas medidas."""
    target = float(settings["target_lufs"])
    clip = bool(settings["clip_limit"])
    groups = defaultdict(list)
    for r in rows:
        if r["lufs"] is not None:
            groups[album_key(r["path"], r["album"])].append(r)
    albums = {}
    for key, lst in groups.items():
        total = sum((r["duration"] or 1.0) for r in lst)
        energy = sum((r["duration"] or 1.0) * 10 ** (r["lufs"] / 10) for r in lst)
        albums[key] = (10 * math.log10(energy / total), max(r["peak_db"] for r in lst))
    out = {}
    for key, lst in groups.items():
        al, ap = albums[key]
        ag_base, _ = _limit(target - al, ap, clip)
        for r in lst:
            tg_base, limited = _limit(target - r["lufs"], r["peak_db"], clip)
            off = r["offset_db"] or 0.0
            out[r["id"]] = {
                "tg": round(tg_base + off, 2),
                "tp": round(10 ** (r["peak_db"] / 20), 6),
                "ag": round(ag_base + off, 2),
                "ap": round(10 ** (ap / 20), 6),
                "limited": limited,
            }
    return out


def is_pending(row, calc):
    if calc is None:
        return False
    for fcol, k in (("file_tg", "tg"), ("file_ag", "ag")):
        v = row[fcol]
        if v is None or abs(v - calc[k]) > TOLERANCE_DB:
            return True
    return row["file_tp"] is None or row["file_ap"] is None
