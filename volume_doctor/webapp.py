import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, jobs, navidrome

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
STATIC = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="volume-doctor")
app.add_middleware(GZipMiddleware, minimum_size=1000)


class Settings(BaseModel):
    target_lufs: float
    clip_limit: bool


class ScanReq(BaseModel):
    force: bool = False


class IdsReq(BaseModel):
    ids: Optional[list[int]] = None


class OffsetReq(BaseModel):
    ids: list[int]
    offset_db: float
    relative: bool = False


def _start(kind, fn, *args):
    try:
        jobs.start(kind, fn, *args)
    except jobs.Busy as exc:
        raise HTTPException(409, f"Já tem uma tarefa rodando ({exc}).") from exc
    return jobs.snapshot()


@app.get("/api/state")
def state():
    c = db.conn()
    total, measured, written = c.execute(
        "SELECT count(*), count(lufs), count(written_at) FROM tracks").fetchone()
    return {
        "settings": db.get_settings(),
        "job": jobs.snapshot(),
        "last_scan": db.get_meta("last_scan"),
        "counts": {"total": total, "measured": measured, "written": written},
        "music_dir": db.MUSIC_DIR,
        "navidrome": navidrome.configured(),
    }


@app.get("/api/tracks")
def tracks():
    cols = ("id, path, artist, albumartist, album, title, duration, lufs, peak_db, error,"
            " file_tg, file_ag, file_tp, file_ap, offset_db, written_at")
    return [dict(r) for r in db.conn().execute(f"SELECT {cols} FROM tracks ORDER BY path")]


@app.post("/api/settings")
def save_settings(s: Settings):
    if not -30 <= s.target_lufs <= -5:
        raise HTTPException(400, "Alvo fora da faixa (-30 a -5 LUFS).")
    return db.set_settings(s.model_dump())


@app.post("/api/offset")
def set_offset(req: OffsetReq):
    if not req.ids:
        raise HTTPException(400, "Nenhuma faixa.")
    c = db.conn()
    q = ",".join("?" * len(req.ids))
    if req.relative:
        c.execute(f"UPDATE tracks SET offset_db = round(offset_db + ?, 2) WHERE id IN ({q})", (req.offset_db, *req.ids))
    else:
        c.execute(f"UPDATE tracks SET offset_db = round(?, 2) WHERE id IN ({q})", (req.offset_db, *req.ids))
    c.execute(f"UPDATE tracks SET offset_db = max(-24, min(24, offset_db)) WHERE id IN ({q})", req.ids)
    c.commit()
    rows = c.execute(f"SELECT id, offset_db FROM tracks WHERE id IN ({q})", req.ids)
    return {r["id"]: r["offset_db"] for r in rows}


@app.post("/api/scan")
def scan(req: ScanReq):
    return _start("scan", jobs.scan, req.force)


@app.post("/api/apply")
def apply(req: IdsReq):
    if req.ids is not None and not req.ids:
        raise HTTPException(400, "Nenhuma faixa selecionada.")
    return _start("apply", jobs.apply, req.ids)


@app.post("/api/revert")
def revert(req: IdsReq):
    if req.ids is not None and not req.ids:
        raise HTTPException(400, "Nenhuma faixa selecionada.")
    return _start("revert", jobs.revert, req.ids)


@app.post("/api/cancel")
def cancel():
    jobs.cancel()
    return jobs.snapshot()


@app.get("/api/audio/{track_id}")
def audio(track_id: int):
    row = db.conn().execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    full = os.path.realpath(db.abspath(row["path"]))
    if not full.startswith(os.path.realpath(db.MUSIC_DIR) + os.sep) or not os.path.isfile(full):
        raise HTTPException(404)
    ext = os.path.splitext(full)[1].lower()
    media = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg"}.get(ext)
    return FileResponse(full, media_type=media)


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
