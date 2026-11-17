"""Opcional: dispara o scan do Navidrome pela API Subsonic depois de gravar tags."""
import hashlib
import os
import secrets
import urllib.parse
import urllib.request
import json

ND_URL = os.environ.get("ND_URL", "").rstrip("/")
ND_USER = os.environ.get("ND_USER", "")
ND_PASS = os.environ.get("ND_PASS", "")


def configured():
    return bool(ND_URL and ND_USER and ND_PASS)


def start_scan():
    salt = secrets.token_hex(6)
    params = {
        "u": ND_USER, "t": hashlib.md5((ND_PASS + salt).encode()).hexdigest(), "s": salt,
        "v": "1.16.1", "c": "volume-doctor", "f": "json",
    }
    url = f"{ND_URL}/rest/startScan?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=10) as r:  # noqa: S310 (URL vem da config do usuário)
        body = json.loads(r.read().decode())
    status = body.get("subsonic-response", {}).get("status")
    if status != "ok":
        raise RuntimeError(str(body)[:200])


def after_change():
    if not configured():
        return "O Navidrome pega a mudança sozinho (watcher ou scan agendado)."
    try:
        start_scan()
        return "Scan do Navidrome disparado."
    except Exception as exc:  # noqa: BLE001
        return f"Não consegui disparar o scan do Navidrome: {exc}"
