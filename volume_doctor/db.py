import json
import os
import sqlite3
import threading

DATA_DIR = os.environ.get("DATA_DIR", "/data")
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
DB_PATH = os.path.join(DATA_DIR, "volume-doctor.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,          -- relativo a MUSIC_DIR
  size INTEGER,
  mtime REAL,
  artist TEXT, albumartist TEXT, album TEXT, title TEXT,
  duration REAL,
  lufs REAL,                          -- loudness integrada (EBU R128)
  peak_db REAL,                       -- pico de amostra em dBFS
  measured_at TEXT,
  error TEXT,
  file_tg REAL, file_tp REAL, file_ag REAL, file_ap REAL,   -- ReplayGain gravado no arquivo hoje
  offset_db REAL NOT NULL DEFAULT 0,  -- ajuste manual (soma no ganho de faixa e de álbum)
  orig_rg TEXT,                       -- JSON com o ReplayGain de antes da 1a gravação do app
  written_at TEXT,                    -- quando o app gravou tags (NULL = nunca/revertido)
  seen INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""

DEFAULTS = {"target_lufs": -14.0, "clip_limit": True}

_local = threading.local()


def conn():
    c = getattr(_local, "c", None)
    if c is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.executescript(SCHEMA)
        _local.c = c
    return c


def get_settings():
    s = dict(DEFAULTS)
    for row in conn().execute("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'"):
        s[row["key"]] = json.loads(row["value"])
    return s


def set_settings(values):
    c = conn()
    for k, v in values.items():
        if k in DEFAULTS:
            c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
    c.commit()
    return get_settings()


def get_meta(key, default=None):
    row = conn().execute("SELECT value FROM settings WHERE key = ?", ("_" + key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_meta(key, value):
    c = conn()
    c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", ("_" + key, json.dumps(value)))
    c.commit()


def abspath(rel):
    return os.path.join(MUSIC_DIR, rel)
