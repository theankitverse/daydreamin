FROM python:3.11-slim

# Install system dependencies (ffmpeg for yt-dlp audio processing)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user (HF Spaces requirement)
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Copy requirements first (better Docker layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .
COPY ytmusic_service.py .
COPY recommendation/ recommendation/

# Create data and cache directories with proper permissions
RUN mkdir -p data song_cache && \
    chown -R appuser:appuser /app

# Copy seed data files
COPY data/songs.json data/songs.json
COPY data/tally_counter.json data/tally_counter.json
RUN chown -R appuser:appuser /app/data /app/song_cache

USER appuser

# HF Spaces expects port 7860
EXPOSE 7860

# Start the server on port 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
