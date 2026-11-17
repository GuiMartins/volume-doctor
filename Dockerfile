FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY volume_doctor ./volume_doctor

ENV DATA_DIR=/data MUSIC_DIR=/music WORKERS=3 NICE=15 PYTHONUNBUFFERED=1
EXPOSE 8992
CMD ["uvicorn", "volume_doctor.webapp:app", "--host", "0.0.0.0", "--port", "8992"]
