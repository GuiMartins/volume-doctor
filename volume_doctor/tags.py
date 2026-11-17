"""Leitura e gravação das tags ReplayGain (MP3/ID3, FLAC, Ogg Vorbis, M4A)."""
import os
import re

from mutagen import File as MFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3, TXXX, ID3NoHeaderError
from mutagen.mp4 import MP4, MP4FreeForm
from mutagen.oggvorbis import OggVorbis

EXTS = {".mp3", ".flac", ".m4a", ".ogg"}
KEYS = ("REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_PEAK", "REPLAYGAIN_ALBUM_GAIN", "REPLAYGAIN_ALBUM_PEAK")
FIELDS = ("tg", "tp", "ag", "ap")
MP4_PREFIX = "----:com.apple.iTunes:"
_num = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _parse(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
        if v is None:
            return None
    if isinstance(v, bytes):
        v = v.decode("utf-8", "replace")
    m = _num.search(str(v))
    return float(m.group().replace(",", ".")) if m else None


def _fmt(field, value):
    return f"{value:+.2f} dB" if field in ("tg", "ag") else f"{value:.6f}"


def read_info(path):
    """Metadados básicos + ReplayGain atual do arquivo."""
    out = dict.fromkeys(("artist", "albumartist", "album", "title", "duration"))
    try:
        easy = MFile(path, easy=True)
    except Exception:  # noqa: BLE001
        easy = None
    if easy is not None:
        out["duration"] = getattr(getattr(easy, "info", None), "length", None)
        for k in ("artist", "albumartist", "album", "title"):
            try:
                v = easy.get(k)
            except Exception:  # noqa: BLE001
                v = None
            out[k] = str(v[0]) if v else None
    try:
        out.update(read_rg(path))
    except Exception:  # noqa: BLE001
        out.update(dict.fromkeys(FIELDS))
    return out


def read_rg(path):
    ext = os.path.splitext(path)[1].lower()
    raw = {}
    if ext == ".mp3":
        try:
            id3 = ID3(path)
        except ID3NoHeaderError:
            return dict.fromkeys(FIELDS)
        frames = {f.desc.upper(): f.text for f in id3.getall("TXXX")}
        raw = {k: frames.get(k) for k in KEYS}
    elif ext in (".flac", ".ogg"):
        f = FLAC(path) if ext == ".flac" else OggVorbis(path)
        tags = f.tags
        raw = {k: (tags.get(k) if tags is not None else None) for k in KEYS}
    elif ext == ".m4a":
        tags = MP4(path).tags or {}
        lower = {k.lower(): v for k, v in tags.items()}
        raw = {k: lower.get((MP4_PREFIX + k).lower()) for k in KEYS}
    return {fld: _parse(raw.get(k)) for fld, k in zip(FIELDS, KEYS)}


def write_rg(path, values):
    """values: {tg, tp, ag, ap} -> float, ou None para remover a tag."""
    ext = os.path.splitext(path)[1].lower()
    items = [(k, fld, values.get(fld)) for k, fld in zip(KEYS, FIELDS)]
    if ext == ".mp3":
        try:
            id3 = ID3(path)
        except ID3NoHeaderError:
            id3 = ID3()
        old = [f.HashKey for f in id3.getall("TXXX") if f.desc.upper() in KEYS]
        for hk in old:
            id3.delall(hk)
        for k, fld, v in items:
            if v is not None:
                id3.add(TXXX(encoding=3, desc=k, text=[_fmt(fld, v)]))
        id3.save(path, v2_version=3 if id3.version[:2] == (2, 3) else 4)
    elif ext in (".flac", ".ogg"):
        f = FLAC(path) if ext == ".flac" else OggVorbis(path)
        if f.tags is None:
            f.add_tags()
        for k, fld, v in items:
            if k in f.tags:
                del f.tags[k]
            if v is not None:
                f.tags[k] = _fmt(fld, v)
        f.save()
    elif ext == ".m4a":
        f = MP4(path)
        if f.tags is None:
            f.add_tags()
        wanted = {(MP4_PREFIX + k).lower() for k in KEYS}
        for key in [key for key in f.tags.keys() if key.lower() in wanted]:
            del f.tags[key]
        for k, fld, v in items:
            if v is not None:
                f.tags[MP4_PREFIX + k.lower()] = [MP4FreeForm(_fmt(fld, v).encode())]
        f.save()
    else:
        raise ValueError(f"formato não suportado: {ext}")
