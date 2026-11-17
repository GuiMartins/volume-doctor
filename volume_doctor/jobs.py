"""Tarefas longas (scan, aplicar, reverter), uma por vez, numa thread."""
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from . import db, navidrome
from .gains import compute, is_pending
from .measure import MeasureError, measure
from .tags import EXTS, FIELDS, read_info, write_rg

log = logging.getLogger("volume_doctor")
WORKERS = max(1, int(os.environ.get("WORKERS", "3")))

_lock = threading.Lock()
STATE = {
    "kind": None, "running": False, "phase": "", "done": 0, "total": 0,
    "started_at": None, "finished_at": None, "message": "", "errors": [],
}
_cancel = threading.Event()


class Busy(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def snapshot():
    with _lock:
        return dict(STATE, errors=STATE["errors"][-20:])


def _set(**kw):
    with _lock:
        STATE.update(kw)


def _err(msg):
    log.warning(msg)
    with _lock:
        STATE["errors"].append(msg)


def cancel():
    _cancel.set()


def start(kind, fn, *args):
    with _lock:
        if STATE["running"]:
            raise Busy(STATE["kind"])
        STATE.update(kind=kind, running=True, phase="", done=0, total=0,
                     started_at=now(), finished_at=None, message="", errors=[])
    _cancel.clear()

    def run():
        try:
            msg = fn(*args)
            _set(message=msg or "")
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s falhou", kind)
            _set(message=f"Falhou: {exc}")
        finally:
            _set(running=False, finished_at=now(), phase="")

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- scan

def _walk():
    for root, dirs, files in os.walk(db.MUSIC_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith(".") or os.path.splitext(name)[1].lower() not in EXTS:
                continue
            full = os.path.join(root, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            yield os.path.relpath(full, db.MUSIC_DIR), st.st_size, st.st_mtime


def _meta_values(info):
    return (info["artist"], info["albumartist"], info["album"], info["title"], info["duration"],
            info["tg"], info["tp"], info["ag"], info["ap"])


def scan(force=False):
    c = db.conn()
    _set(phase="Listando arquivos")
    files = list(_walk())
    if not files and not os.listdir(db.MUSIC_DIR):
        raise RuntimeError(f"{db.MUSIC_DIR} está vazio (HD desmontado?). Nada foi alterado.")
    known = {r["path"]: r for r in c.execute("SELECT id, path, size, mtime FROM tracks")}
    c.execute("UPDATE tracks SET seen = 0")
    _set(phase="Lendo tags", total=len(files), done=0)
    new = changed = 0
    for i, (rel, size, mtime) in enumerate(files, 1):
        if _cancel.is_set():
            c.execute("UPDATE tracks SET seen = 1")
            c.commit()
            return "Cancelado."
        row = known.get(rel)
        if row is None:
            info = read_info(db.abspath(rel))
            c.execute(
                "INSERT INTO tracks(path, size, mtime, artist, albumartist, album, title, duration,"
                " file_tg, file_tp, file_ag, file_ap, seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
                (rel, size, mtime, *_meta_values(info)))
            new += 1
        elif row["size"] != size or abs((row["mtime"] or 0) - mtime) > 0.001:
            info = read_info(db.abspath(rel))
            c.execute(
                "UPDATE tracks SET size=?, mtime=?, artist=?, albumartist=?, album=?, title=?, duration=?,"
                " file_tg=?, file_tp=?, file_ag=?, file_ap=?, lufs=NULL, peak_db=NULL, error=NULL, seen=1"
                " WHERE id=?", (size, mtime, *_meta_values(info), row["id"]))
            changed += 1
        else:
            c.execute("UPDATE tracks SET seen = 1 WHERE id = ?", (row["id"],))
        if i % 200 == 0:
            c.commit()
            _set(done=i)
    gone = c.execute("DELETE FROM tracks WHERE seen = 0").rowcount
    if force:
        c.execute("UPDATE tracks SET lufs = NULL, peak_db = NULL, error = NULL")
    c.commit()

    todo = [(r["id"], r["path"]) for r in
            c.execute("SELECT id, path FROM tracks WHERE lufs IS NULL AND error IS NULL ORDER BY path")]
    _set(phase="Medindo loudness", total=len(todo), done=0)
    measured = failed = 0
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = {ex.submit(measure, db.abspath(p)): (tid, p) for tid, p in todo}
        for n, fut in enumerate(as_completed(futs), 1):
            tid, p = futs[fut]
            try:
                lufs, peak = fut.result()
                c.execute("UPDATE tracks SET lufs=?, peak_db=?, measured_at=?, error=NULL WHERE id=?",
                          (lufs, peak, now(), tid))
                measured += 1
            except MeasureError as exc:
                c.execute("UPDATE tracks SET error=? WHERE id=?", (str(exc), tid))
                _err(f"{p}: {exc}")
                failed += 1
            except Exception as exc:  # noqa: BLE001
                _err(f"{p}: {exc}")
                failed += 1
            if n % 20 == 0:
                c.commit()
            eta = (time.time() - t0) / n * (len(todo) - n)
            _set(done=n, message=f"~{int(eta // 60)} min restantes" if n > 5 else "")
            if _cancel.is_set():
                ex.shutdown(cancel_futures=True)
                c.commit()
                db.set_meta("last_scan", now())
                return f"Cancelado depois de medir {measured} faixas."
    c.commit()
    db.set_meta("last_scan", now())
    parts = [f"{len(files)} arquivos", f"{new} novos", f"{changed} alterados", f"{gone} removidos",
             f"{measured} medidos"]
    if failed:
        parts.append(f"{failed} com erro")
    return "Scan concluído: " + ", ".join(parts) + "."


# ---------------------------------------------------------------- aplicar / reverter

def _rows():
    return [dict(r) for r in db.conn().execute("SELECT * FROM tracks")]


def _restat(c, tid, rel, values):
    st = os.stat(db.abspath(rel))
    c.execute("UPDATE tracks SET size=?, mtime=?, file_tg=?, file_tp=?, file_ag=?, file_ap=? WHERE id=?",
              (st.st_size, st.st_mtime, values.get("tg"), values.get("tp"), values.get("ag"), values.get("ap"), tid))


def apply(ids=None):
    c = db.conn()
    rows = _rows()
    calc = compute(rows, db.get_settings())
    wanted = set(ids) if ids else None
    todo = [r for r in rows if (wanted is None or r["id"] in wanted) and is_pending(r, calc.get(r["id"]))]
    _set(phase="Gravando tags", total=len(todo), done=0)
    ok = 0
    for n, r in enumerate(todo, 1):
        if _cancel.is_set():
            break
        values = {k: calc[r["id"]][k] for k in FIELDS}
        try:
            write_rg(db.abspath(r["path"]), values)
            if r["written_at"] is None:
                orig = {k: r["file_" + k] for k in FIELDS}
                c.execute("UPDATE tracks SET orig_rg=? WHERE id=?", (json.dumps(orig), r["id"]))
            c.execute("UPDATE tracks SET written_at=? WHERE id=?", (now(), r["id"]))
            _restat(c, r["id"], r["path"], values)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            _err(f"{r['path']}: {exc}")
        if n % 50 == 0:
            c.commit()
        _set(done=n)
    c.commit()
    msg = f"Tags gravadas em {ok} de {len(todo)} faixas."
    if ok:
        msg += " " + navidrome.after_change()
    return msg


def revert(ids=None):
    c = db.conn()
    wanted = set(ids) if ids else None
    todo = [r for r in _rows() if r["written_at"] is not None and (wanted is None or r["id"] in wanted)]
    _set(phase="Restaurando tags originais", total=len(todo), done=0)
    ok = 0
    for n, r in enumerate(todo, 1):
        if _cancel.is_set():
            break
        orig = json.loads(r["orig_rg"] or "{}")
        values = {k: orig.get(k) for k in FIELDS}
        try:
            write_rg(db.abspath(r["path"]), values)
            c.execute("UPDATE tracks SET written_at=NULL, orig_rg=NULL WHERE id=?", (r["id"],))
            _restat(c, r["id"], r["path"], values)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            _err(f"{r['path']}: {exc}")
        if n % 50 == 0:
            c.commit()
        _set(done=n)
    c.commit()
    msg = f"Tags originais restauradas em {ok} de {len(todo)} faixas."
    if ok:
        msg += " " + navidrome.after_change()
    return msg
