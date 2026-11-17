"""Mede loudness integrada (EBU R128) e pico de amostra com o filtro ebur128 do ffmpeg."""
import os
import re
import subprocess

NICE = int(os.environ.get("NICE", "15"))
_I = re.compile(r"\bI:\s+(-?[\d.]+|-inf)\s+LUFS")
_P = re.compile(r"\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS")


class MeasureError(Exception):
    pass


def measure(path):
    cmd = [
        "nice", "-n", str(NICE),
        "ffmpeg", "-nostdin", "-nostats", "-hide_banner", "-i", path,
        "-map", "0:a:0", "-af", "ebur128=peak=sample:framelog=quiet", "-f", "null", "-",
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=900)
    except subprocess.TimeoutExpired as exc:
        raise MeasureError("ffmpeg demorou demais (timeout)") from exc
    out = p.stderr
    idx = out.rfind("Summary:")
    if idx < 0:
        tail = " | ".join(line.strip() for line in out.strip().splitlines()[-3:])
        raise MeasureError(f"ffmpeg falhou: {tail[:300]}")
    s = out[idx:]
    mi, mp = _I.search(s), _P.search(s)
    if not mi or not mp:
        raise MeasureError("saída do ffmpeg sem loudness/pico")
    if mi.group(1) == "-inf" or float(mi.group(1)) <= -70:
        raise MeasureError("faixa em silêncio")
    peak = -120.0 if mp.group(1) == "-inf" else float(mp.group(1))
    return float(mi.group(1)), peak
