"""
Daydreamin — FastAPI backend
Streams music via yt-dlp, recommendations via YouTube Music (ytmusicapi).
"""

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests
import yt_dlp
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import ytmusic_service

# Legacy recommendation engine (fallback only)
from recommendation import (
    get_recommendations as get_song_recommendations,
    get_song_by_id,
    get_songs_by_ids,
    get_up_next as legacy_up_next,
    update_transition,
    upsert_song_records,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Daydreamin", version="3.0")
# ── CORS (single, clean setup) ─────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Paths ───────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = BASE_DIR / "song_cache"
CACHE_LIMIT_BYTES = 600 * 1024 * 1024

DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

executor = ThreadPoolExecutor(max_workers=4)

# ── In-memory stream URL cache ──────────────────────────────────────────────
_stream_cache: dict[str, dict] = {}   # key → {url, headers, timestamp}
_STREAM_TTL = 1800  # 30 minutes

# ── In-memory lyrics cache ──────────────────────────────────────────────────
_lyrics_cache: dict[str, dict] = {}   # "artist|title" → {syncedLyrics, plainLyrics, timestamp}
_LYRICS_TTL = 3600  # 1 hour


# ── Middleware ──────────────────────────────────────────────────────────────
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Accept-Ranges"] = "bytes"
    # Prevent browser from caching frontend files (HTML/CSS/JS)
    path = request.url.path
    if path == "/app" or path.startswith("/css") or path.startswith("/js") or path == "/manifest.json":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# ── Cache helpers ───────────────────────────────────────────────────────────
def is_song_cached(song_id):
    return (CACHE_DIR / f"{song_id}.m4a").exists()


def get_cache_size_bytes():
    return sum(entry.stat().st_size for entry in CACHE_DIR.iterdir() if entry.is_file())


def clear_audio_cache():
    for entry in CACHE_DIR.iterdir():
        if entry.is_file():
            try:
                entry.unlink()
            except OSError:
                pass


def clear_cache_if_needed():
    """LRU-style eviction: delete oldest 20% of cached files when over limit."""
    if get_cache_size_bytes() <= CACHE_LIMIT_BYTES:
        return
    files = sorted(
        [e for e in CACHE_DIR.iterdir() if e.is_file()],
        key=lambda f: f.stat().st_mtime  # oldest first
    )
    # Delete oldest 20% of files
    to_delete = max(1, len(files) // 5)
    for entry in files[:to_delete]:
        try:
            entry.unlink()
            logger.info("Cache evicted: %s", entry.name)
        except OSError:
            pass


def inject_cache_status(songs):
    for song in songs:
        song["cached"] = is_song_cached(song.get("id", ""))
    return songs


# ── iTunes helpers ──────────────────────────────────────────────────────────
def _itunes_to_song(item):
    art_url = item.get("artworkUrl100", "")
    cover = art_url.replace("100x100bb", "200x200bb") if art_url else ""
    cover_xl = art_url.replace("100x100bb", "600x600bb") if art_url else ""
    return {
        "id": str(item.get("trackId", item.get("collectionId", 0))),
        "title": item.get("trackName", "Unknown"),
        "artist": item.get("artistName", "Unknown"),
        "artist_id": item.get("artistId", 0),
        "album": item.get("collectionName", "Single"),
        "cover": cover,
        "cover_xl": cover_xl,
        "duration": item.get("trackTimeMillis", 0) // 1000,
        "genre": item.get("primaryGenreName", "Music"),
    }


def search_songs(query):
    if not query:
        return []
    try:
        response = requests.get(
            "https://itunes.apple.com/search",
            params={"term": query, "media": "music", "limit": 25, "country": "IN"},
            timeout=10,
        )
        data = response.json()
        songs = [_itunes_to_song(item) for item in data.get("results", []) if item.get("trackName")]
        upsert_song_records(songs)
        return inject_cache_status(songs)
    except Exception:
        return []


def get_chart():
    try:
        response = requests.get("https://itunes.apple.com/in/rss/topsongs/limit=25/json", timeout=10).json()
        entries = response.get("feed", {}).get("entry", [])
        songs = []
        for entry in entries:
            try:
                art_url = ""
                for img in entry.get("im:image", []):
                    art_url = img.get("label", "")
                cover = art_url.replace("170x170bb", "200x200bb") if art_url else ""
                cover_xl = art_url.replace("170x170bb", "600x600bb") if art_url else ""
                artist_id = 0
                artist_link = entry.get("im:artist", {}).get("attributes", {}).get("href", "")
                if "/id" in artist_link:
                    try:
                        artist_id = int(artist_link.split("/id")[-1].split("?")[0])
                    except Exception:
                        pass
                track_id = str(entry.get("id", {}).get("attributes", {}).get("im:id", "0") or "0")
                genre = entry.get("category", {}).get("attributes", {}).get("label", "Music")
                songs.append({
                    "id": track_id,
                    "title": entry.get("im:name", {}).get("label", "Unknown"),
                    "artist": entry.get("im:artist", {}).get("label", "Unknown"),
                    "artist_id": artist_id,
                    "album": entry.get("im:collection", {}).get("im:name", {}).get("label", "Single"),
                    "cover": cover,
                    "cover_xl": cover_xl,
                    "duration": 0,
                    "genre": genre,
                })
            except Exception:
                continue
        upsert_song_records(songs)
        return inject_cache_status(songs)
    except Exception:
        return []


# ── Lyrics ──────────────────────────────────────────────────────────────────

import re


def normalize_text(text: str) -> str:
    """Clean song/artist text for LRCLIB lookup."""
    if not text:
        return ""
    # Strip parenthetical / bracketed info like (From "Saiyaara") or [Deluxe]
    text = re.sub(r"\(.*?\)", "", text)
    text = re.sub(r"\[.*?\]", "", text)
    # Strip feat/ft. credits
    text = re.sub(r"\b(feat|ft)\.?\s.*", "", text, flags=re.IGNORECASE)
    return text.strip()


def fetch_lyrics(artist: str, title: str) -> dict:
    """Fast lyrics fetch with in-memory cache. Max 3 LRCLIB requests on miss."""
    if not artist and not title:
        return {"syncedLyrics": None, "plainLyrics": None}

    # Check cache first
    cache_key = f"{artist.lower().strip()}|{title.lower().strip()}"
    cached = _lyrics_cache.get(cache_key)
    if cached and (time.time() - cached["timestamp"]) < _LYRICS_TTL:
        logger.info("Lyrics cache HIT: %s", cache_key)
        return {"syncedLyrics": cached["syncedLyrics"], "plainLyrics": cached["plainLyrics"]}

    clean_artist = normalize_text(artist)
    clean_title = normalize_text(title)
    logger.info("Lyrics cache MISS — fetching: artist=%r title=%r", clean_artist, clean_title)

    # --- Try LRCLIB search endpoint ---
    try:
        resp = requests.get(
            "https://lrclib.net/api/search",
            params={"artist_name": clean_artist, "track_name": clean_title},
            headers={"User-Agent": "Daydreamin/3.0"},
            timeout=10,
        )
        data = resp.json()
        if isinstance(data, list) and data:
            for item in data:
                if item.get("syncedLyrics"):
                    return _cache_lyrics(cache_key, {"syncedLyrics": item["syncedLyrics"], "plainLyrics": item.get("plainLyrics")})
            for item in data:
                if item.get("plainLyrics"):
                    return _cache_lyrics(cache_key, {"syncedLyrics": None, "plainLyrics": item["plainLyrics"]})
    except Exception as e:
        logger.warning("LRCLIB search failed: %s", e)

    # --- Fallback: LRCLIB direct-get endpoint ---
    try:
        resp = requests.get(
            "https://lrclib.net/api/get",
            params={"artist_name": clean_artist, "track_name": clean_title},
            headers={"User-Agent": "Daydreamin/3.0"},
            timeout=10,
        )
        data = resp.json()
        if isinstance(data, dict):
            synced = data.get("syncedLyrics")
            plain = data.get("plainLyrics")
            if synced or plain:
                return _cache_lyrics(cache_key, {"syncedLyrics": synced, "plainLyrics": plain})
    except Exception as e:
        logger.warning("LRCLIB get failed: %s", e)

    # --- Last resort: try with raw (un-normalized) title ---
    if clean_title != title:
        try:
            resp = requests.get(
                "https://lrclib.net/api/search",
                params={"artist_name": artist, "track_name": title},
                headers={"User-Agent": "Daydreamin/3.0"},
                timeout=10,
            )
            data = resp.json()
            if isinstance(data, list) and data:
                for item in data:
                    if item.get("syncedLyrics"):
                        return _cache_lyrics(cache_key, {"syncedLyrics": item["syncedLyrics"], "plainLyrics": item.get("plainLyrics")})
                for item in data:
                    if item.get("plainLyrics"):
                        return _cache_lyrics(cache_key, {"syncedLyrics": None, "plainLyrics": item["plainLyrics"]})
        except Exception as e:
            logger.warning("LRCLIB raw search failed: %s", e)

    # Don't cache null results — allow retry on next request
    return {"syncedLyrics": None, "plainLyrics": None}


def _cache_lyrics(cache_key: str, result: dict) -> dict:
    """Store lyrics in cache and return the result."""
    _lyrics_cache[cache_key] = {**result, "timestamp": time.time()}
    return result


# ── Stream URL cache eviction ────────────────────────────────────────────────
_STREAM_CACHE_MAX = 100  # max entries before LRU eviction


def _evict_stream_cache():
    """Evict oldest 20% of stream cache entries when over limit."""
    if len(_stream_cache) > _STREAM_CACHE_MAX:
        sorted_keys = sorted(_stream_cache, key=lambda k: _stream_cache[k]["timestamp"])
        for k in sorted_keys[:_STREAM_CACHE_MAX // 5]:
            del _stream_cache[k]


def _resolve_stream(query: str, video_id: str = None):
    """
    Resolve a stream URL via yt-dlp.
    If video_id is provided, use it directly (faster + more accurate).
    Otherwise search YouTube.
    """
    cache_key = video_id or query
    cached = _stream_cache.get(cache_key)
    if cached and (time.time() - cached["timestamp"]) < _STREAM_TTL:
        return cached

    ydl_opts = {
        "format": "bestaudio/best",
        "quiet": True,
        "noplaylist": True,
        "check_formats": False,  # Bypass checking if format links are alive to save network roundtrips
        "socket_timeout": 10,     # Abort if YouTube hangs the connection (relaxed to 10s for slow DNS/handshakes on HF)
        "impersonate": "chrome",  # Impersonate Chrome browser TLS signature to bypass bot detection
        "extractor_args": {
            "youtube": {
                "player_client": ["web", "mweb", "android"]
            }
        },
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            if video_id:
                url = f"https://music.youtube.com/watch?v={video_id}"
            else:
                url = f"ytsearch1:{query}"

            info = ydl.extract_info(url, download=False)
            video = info["entries"][0] if "entries" in info else info
            result = {
                "url": video["url"],
                "headers": video.get("http_headers", {}),
                "video_id": video.get("id", video_id or ""),
                "timestamp": time.time(),
            }
            _evict_stream_cache()
            _stream_cache[cache_key] = result
            return result
    except Exception as exc:
        logger.error("Stream resolution failed: %s", exc)
        return None


def render_play_response(request: Request, song_id: str, artist: str, title: str, video_id: str = ""):
    """Build the play response — returns stream URL (cached file or yt-dlp proxy)."""
    filename = f"{song_id}.m4a"
    filepath = CACHE_DIR / filename

    # Check local cache first
    if filepath.exists():
        base_url = str(request.base_url).rstrip("/")
        return JSONResponse({"source": "local", "url": f"{base_url}/api/mobile/stream_cache/{filename}", "videoId": video_id})

    # Resolve video_id via YTMusic API if not provided (much faster and avoids yt-dlp search blocks)
    if not video_id:
        try:
            video_id = ytmusic_service.resolve_video_id(artist, title) or ""
        except Exception as e:
            logger.warning("Failed to resolve video_id via YTMusic: %s", e)

    # Format a clean search query for yt-dlp to find the official audio/video
    clean_title = title.lower()
    if any(w in clean_title for w in ["remix", "cover", "live", "acoustic", "mashup", "reverb", "slowed"]):
        query = f"{artist} {title}"
    else:
        query = f"{artist} {title} official audio"
    stream = _resolve_stream(query, video_id=video_id or None)
    if not stream:
        return JSONResponse({"error": "Song not found"}, status_code=404)

    base_url = str(request.base_url).rstrip("/")
    proxy_url = f"{base_url}/api/mobile/stream_proxy?url={quote(stream['url'])}&headers={quote(json.dumps(stream['headers']))}"

    return JSONResponse({
        "source": "youtube",
        "url": proxy_url,
        "stream_url": proxy_url,
        "direct_url": stream["url"],
        "headers": stream["headers"],
        "videoId": stream.get("video_id", video_id),
    })


def build_proxy_response(url: str, incoming_headers, headers_json: str):

    try:

        try:
            yt_headers = json.loads(headers_json or "{}")
        except Exception:
            yt_headers = {}

        headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36",

            "Accept":
                "*/*",

            "Accept-Language":
                "en-US,en;q=0.9",

            "Referer":
                "https://music.youtube.com/",

            "Origin":
                "https://music.youtube.com/",
        }

        # Preserve yt-dlp headers
        headers.update(yt_headers)

        # Preserve seeking
        if "range" in incoming_headers:
            headers["Range"] = incoming_headers["range"]

        req = requests.get(
            url,
            stream=True,
            headers=headers,
            timeout=30,
        )

        logger.info("Stream proxy status: %s", req.status_code)

        excluded_headers = {
            "content-encoding",
            "transfer-encoding",
            "connection"
        }

        response_headers = {
            name: value
            for name, value in req.headers.items()
            if name.lower() not in excluded_headers
        }

        response_headers["Accept-Ranges"] = "bytes"

        return StreamingResponse(
            req.iter_content(chunk_size=1024 * 256),
            status_code=req.status_code,
            media_type="audio/mp4",
            headers=response_headers,
        )

    except Exception as exc:

        return PlainTextResponse(
            f"Stream error: {exc}",
            status_code=500
        )

# ── Download helper ─────────────────────────────────────────────────────────
def download_task(song_id, artist, title):
    clear_cache_if_needed()
    filepath = CACHE_DIR / f"{song_id}.m4a"
    if filepath.exists():
        return
    query = f"{artist} - {title} audio"
    ydl_opts = {
        "format": "bestaudio[ext=m4a]/best",
        "outtmpl": str(filepath),
        "quiet": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"client": ["android", "ios"]}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([f"ytsearch1:{query}"])
        clear_cache_if_needed()
    except Exception:
        pass


def build_up_next_response(song_id: str, artist: str = "", title: str = "", limit: int = 15):
    """
    Primary: YouTube Music radio queue.
    Fallback: legacy behavior + content recommendation engine.
    """
    # Resolve artist/title from database if missing
    if song_id and (not artist or not title):
        try:
            db_songs = get_songs_by_ids([song_id])
            if db_songs:
                s = db_songs[0]
                if not artist:
                    artist = s.get("artist", "")
                if not title:
                    title = s.get("title", "")
        except Exception:
            pass

    # If song_id looks like a YouTube video ID, pass it as video_id
    video_id = None
    if song_id and len(song_id) == 11 and not song_id.isdigit():
        video_id = song_id

    # Try YouTube Music recommendations first
    tracks = ytmusic_service.get_radio_queue(
        video_id=video_id, artist=artist, title=title, limit=limit
    )

    # Check if seed song is clean (original version)
    seed_clean = True
    bad_rec_keywords = ["remix", "cover", "live", "concert", "karaoke", "instrumental", "tribute", "mashup", "lofi", "lo-fi", "slowed", "reverb", "reverbed", "sped up", "nightcore", "parody", "bootleg", "refix", "edit", "8d", "slow"]
    if title:
        title_lower = title.lower()
        if any(w in title_lower for w in bad_rec_keywords):
            seed_clean = False

    if tracks:
        result = []
        for t in tracks:
            t_title_lower = t["title"].lower()
            # Filter out unofficial/remix/live tracks if seed song is official
            if seed_clean and any(w in t_title_lower for w in bad_rec_keywords):
                continue
            result.append({
                "id": t["videoId"],
                "videoId": t["videoId"],
                "title": t["title"],
                "artist": t["artist"],
                "cover": t["thumbnail"],
                "cover_xl": t["thumbnail"],
                "duration": t["duration"],
                "reason": "ytmusic",
            })
        
        # If we filtered too aggressively, fallback to including unfiltered recommendations
        if len(result) < 5:
            for t in tracks:
                item = {
                    "id": t["videoId"],
                    "videoId": t["videoId"],
                    "title": t["title"],
                    "artist": t["artist"],
                    "cover": t["thumbnail"],
                    "cover_xl": t["thumbnail"],
                    "duration": t["duration"],
                    "reason": "ytmusic",
                }
                if item not in result:
                    result.append(item)
        return result

    # Fallback to legacy engine
    logger.info("YTMusic radio failed, falling back to legacy recommendations for %s", song_id)
    try:
        from recommendation import get_up_next as legacy_get_up_next
        entries = legacy_get_up_next(song_id, limit=limit)
        songs_by_id = {song["id"]: song for song in get_songs_by_ids([e["song_id"] for e in entries])}
        result = []
        for entry in entries:
            song = songs_by_id.get(entry["song_id"])
            if song:
                item = dict(song)
                item["reason"] = entry["reason"]
                result.append(item)
        return result
    except Exception:
        return []


# ── Preload endpoint ────────────────────────────────────────────────────────
def preload_stream(artist: str, title: str, video_id: str = ""):
    """Pre-resolve a stream URL so next play is instant."""
    query = f"{artist} - {title} audio"
    stream = _resolve_stream(query, video_id=video_id or None)
    if stream:
        return {"status": "preloaded", "videoId": stream.get("video_id", "")}
    return {"status": "failed"}


# ═══════════════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════════════

# Serve frontend files from parent directory (only if they exist, e.g. for local dev)
FRONTEND_DIR = BASE_DIR.parent / "frontend"

@app.get("/")
def root():
    if FRONTEND_DIR.exists() and (FRONTEND_DIR / "index.html").exists():
        return RedirectResponse("/app")
    return {"status": "ok", "message": "Daydreamin API Backend"}


if FRONTEND_DIR.exists() and (FRONTEND_DIR / "index.html").exists():
    @app.get("/app")
    def serve_app():
        return FileResponse(FRONTEND_DIR / "index.html", media_type="text/html")

    # Mount the modular CSS and JS directories
    app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")

    @app.get("/manifest.json")
    def serve_manifest():
        return FileResponse(BASE_DIR.parent / "manifest.json", media_type="application/json")

    @app.get("/logo-icon.png")
    def serve_logo_icon():
        return FileResponse(FRONTEND_DIR / "logo-icon.png", media_type="image/png")

    @app.get("/logo.png")
    def serve_logo():
        return FileResponse(FRONTEND_DIR / "logo.png", media_type="image/png")

    @app.get("/logo-icon.png")
    def serve_favicon():
        return FileResponse(FRONTEND_DIR / "logo-icon.png", media_type="image/png")


@app.get("/api/mobile/health")
def mobile_health():
    return JSONResponse({"status": "ok", "server": "Daydreamin", "version": "3.0", "timestamp": int(time.time())})


@app.get("/api/mobile/search")
def mobile_search(q: str = ""):
    return JSONResponse(search_songs(q))


# ── Smart Search Caching & Scoring Helpers ─────────────────────────────────────
import difflib

_smart_search_cache = {}
_SEARCH_CACHE_TTL = 300  # 5 minutes in-memory cache

def _get_cached_search(query: str):
    cached = _smart_search_cache.get(query)
    if cached and (time.time() - cached["timestamp"]) < _SEARCH_CACHE_TTL:
        return cached["results"]
    return None

def _set_cached_search(query: str, results: dict):
    if len(_smart_search_cache) > 200:
        _smart_search_cache.clear()
    _smart_search_cache[query] = {
        "results": results,
        "timestamp": time.time()
    }

def normalize_symbols(text: str) -> str:
    if not text:
        return ""
    text = text.lower()
    text = text.replace("$", "s").replace("@", "a").replace("&", "and")
    return text

def clean_search_query(q: str) -> str:
    # Replace " by " (case-insensitive) with a space
    q_clean = re.sub(r"\s+by\s+", " ", q, flags=re.IGNORECASE)
    # Replace " - " with a space
    q_clean = re.sub(r"\s*-\s*", " ", q_clean)
    return " ".join(q_clean.split())

# ── Intent Detection & Smart Query Mapping ───────────────────────────────────
MOOD_KEYWORDS = {
    "sad": "best sad hindi songs playlist",
    "breakup": "breakup hindi songs playlist",
    "gym": "gym workout motivational playlist",
    "workout": "gym workout motivational playlist",
    "night drive": "late night drive songs",
    "drive": "night drive songs playlist",
    "chill": "chill vibes lo-fi playlist",
    "relax": "relaxing instrumental acoustic playlist",
    "romantic": "romantic love songs hindi playlist",
    "love": "romantic love songs hindi playlist",
    "happy": "happy upbeat feel good playlist",
    "party": "party dance club hits mix",
    "dance": "dance club hits punjabi hindi",
    "motivational": "workout motivational songs",
    "energetic": "energetic workout gym music",
    "summer": "summer vibes party playlist",
    "rainy": "monsoon rain hindi romantic songs",
    "monsoon": "rainy day slow songs",
    "gaming": "gaming background music synthwave lo-fi",
    "focus": "study chill lofi focus beats",
    "study": "study chill lofi focus beats",
    "sleep": "deep sleep rain ambient music",
    "lofi": "lofi hip hop study relax beats",
    "retro": "retro classic 80s 90s bollywood hits",
    "classical": "indian classical relaxing instrumental",
    "jazz": "relaxing jazz cafe music",
    "rock": "rock guitar classics workout",
    "pop": "pop hits playlist",
    "rap": "indian hip hop rap mix",
    "hip hop": "hip hop rap hits",
    "punjabi": "latest punjabi party hits",
    "hindi": "best hindi songs hits playlist",
    "bollywood": "bollywood hit songs playlist"
}

def classify_search_query(query: str):
    """
    Classify query into songs_like, mood_discovery, or direct.
    """
    q_lower = query.lower().strip()
    
    # 1. Songs like [track]
    songs_like_match = re.match(r"^(?:songs?\s+like|music\s+like|similar\s+to|like)\s+(.+)$", q_lower)
    if songs_like_match:
        target = songs_like_match.group(1).strip()
        return {
            "intent": "songs_like",
            "target": target,
            "smart_query": f"songs like {target}"
        }
        
    # 2. Check for artist suffix ("by arijit singh")
    artist = None
    by_match = re.search(r"\s+by\s+([a-zA-Z0-9\s]+)$", q_lower)
    if by_match:
        artist = by_match.group(1).strip()
        q_clean = q_lower[:by_match.start()].strip()
    else:
        q_clean = q_lower

    # 3. Check for mood match
    matched_mood = None
    matched_key = None
    for kw, smart_q in MOOD_KEYWORDS.items():
        if re.search(rf"\b{re.escape(kw)}\b", q_clean):
            if matched_mood is None or len(kw) > len(matched_key):
                matched_key = kw
                matched_mood = smart_q

    if matched_mood:
        if artist:
            smart_query = f"{artist.title()} {matched_key} songs playlist"
        else:
            smart_query = matched_mood
        return {
            "intent": "mood_discovery",
            "mood": matched_key,
            "artist": artist,
            "smart_query": smart_query
        }

    return {
        "intent": "direct",
        "smart_query": query
    }

def get_dedup_key(artist: str, title: str) -> str:
    # Strip - Topic or Topic suffix
    artist_clean = re.sub(r"\s*-\s*topic\b", "", artist, flags=re.IGNORECASE)
    artist_clean = re.sub(r"\b(topic)\b", "", artist_clean, flags=re.IGNORECASE)
    artist_norm = normalize_symbols(artist_clean)
    title_norm = normalize_symbols(title)
    a = re.sub(r"[^\w\s]", "", artist_norm)
    t = re.sub(r"[^\w\s]", "", title_norm)
    a = " ".join(a.split())
    t = " ".join(t.split())
    a = re.sub(r"\b(feat|ft)\.?\s.*", "", a)
    t = re.sub(r"\(.*?\)", "", t)
    t = re.sub(r"\[.*?\]", "", t)
    return f"{a.strip()}|{t.strip()}"

def get_token_match_score(query: str, title: str, artist: str) -> float:
    q_norm = normalize_symbols(query)
    t_norm = normalize_symbols(title)
    a_norm = normalize_symbols(artist)
    
    q_words = set(re.findall(r"\w+", q_norm))
    t_words = set(re.findall(r"\w+", t_norm))
    a_words = set(re.findall(r"\w+", a_norm))
    
    stopwords = {"by", "the", "a", "an", "and", "of", "in", "feat", "ft"}
    q_words = q_words - stopwords
    
    if not q_words:
        return 0.0
        
    matches_title = q_words.intersection(t_words)
    matches_artist = q_words.intersection(a_words)
    
    score = 0.0
    score += len(matches_title) / len(q_words) * 50.0
    score += len(matches_artist) / len(q_words) * 30.0
    
    if matches_title and matches_artist:
        score += 20.0
        
    return score

def score_candidate(query: str, title: str, artist: str, source: str, itunes_rank: int = 999, yt_rank: int = 999, video_type: str = "") -> float:
    # Normalize strings: lowercase, remove punctuation for matching
    def canonical_clean(text: str) -> str:
        if not text:
            return ""
        text = text.lower()
        # Clean up - Topic
        text = re.sub(r"\s*-\s*topic\b", "", text)
        text = re.sub(r"\b(topic)\b", "", text)
        # Clean up "by" or " - " before removing punctuation
        text = re.sub(r"\s+by\s+", " ", text)
        text = re.sub(r"\s*-\s*", " ", text)
        # Replace common variations
        text = text.replace("$", "s").replace("@", "a").replace("&", "and")
        # Remove punctuation
        text = re.sub(r"[^\w\s]", "", text)
        return " ".join(text.split())

    def main_clean(text: str) -> str:
        if not text:
            return ""
        text = text.lower()
        # Clean up - Topic
        text = re.sub(r"\s*-\s*topic\b", "", text)
        text = re.sub(r"\b(topic)\b", "", text)
        # Strip parenthetical / bracketed info
        text = re.sub(r"\(.*?\)", "", text)
        text = re.sub(r"\[.*?\]", "", text)
        # Strip feat/ft. credits
        text = re.sub(r"\b(feat|ft|featuring)\b.*", "", text)
        # Clean up "by" or " - "
        text = re.sub(r"\s+by\s+", " ", text)
        text = re.sub(r"\s*-\s*", " ", text)
        # Replace common variations
        text = text.replace("$", "s").replace("@", "a").replace("&", "and")
        # Remove punctuation
        text = re.sub(r"[^\w\s]", "", text)
        return " ".join(text.split())

    def split_artists(artist_str: str) -> list[str]:
        if not artist_str:
            return []
        artist_str = re.sub(r"\s*-\s*topic\b", "", artist_str, flags=re.IGNORECASE)
        artist_str = re.sub(r"\b(topic)\b", "", artist_str, flags=re.IGNORECASE)
        parts = re.split(r"\b(?:feat\.?|ft\.?|featuring|and|\&|,|;|/)\b", artist_str.lower())
        artists_list = []
        for p in parts:
            p_clean = re.sub(r"[^\w\s]", "", p).strip()
            p_clean = " ".join(p_clean.split())
            if p_clean:
                artists_list.append(p_clean)
        return artists_list

    q_clean = canonical_clean(query)
    title_clean = canonical_clean(title)
    artist_clean = canonical_clean(artist)

    q_main = main_clean(query)
    title_main = main_clean(title)
    artist_main = main_clean(artist)
    
    score = 0.0
    
    # Parse query if it has explicit title / artist delimiters
    q_artist_part = None
    q_title_part = None
    if " by " in query.lower():
        parts = re.split(r"\s+by\s+", query, flags=re.IGNORECASE)
        q_title_part = parts[0].strip()
        q_artist_part = parts[1].strip()
    elif " - " in query:
        parts = re.split(r"\s*-\s*", query)
        if len(parts) >= 2:
            q_title_part = parts[0].strip()
            q_artist_part = parts[1].strip()

    q_title_part_clean = canonical_clean(q_title_part) if q_title_part else None
    q_title_part_main = main_clean(q_title_part) if q_title_part else None
    q_artist_part_clean = canonical_clean(q_artist_part) if q_artist_part else None
    q_artist_part_main = main_clean(q_artist_part) if q_artist_part else None

    # Check if artist matches one of candidate's individual artists
    cand_artists = split_artists(artist)
    artist_matched = False
    if q_artist_part_clean:
        if q_artist_part_clean == artist_clean or q_artist_part_main == artist_main or q_artist_part_clean in artist_clean or artist_clean in q_artist_part_clean:
            artist_matched = True
        else:
            q_artists = split_artists(q_artist_part)
            for qa in q_artists:
                for ca in cand_artists:
                    if qa == ca or difflib.SequenceMatcher(None, qa, ca).ratio() > 0.85:
                        artist_matched = True
                        break
                if artist_matched:
                    break
    else:
        # If no explicit delimiter, check if any of candidate's individual artists is in the query
        for ca in cand_artists:
            if len(ca) > 2 and f" {ca} " in f" {q_clean} ":
                artist_matched = True
                break
        if not artist_matched and (artist_clean in q_clean or artist_main in q_clean):
            artist_matched = True

    # Check if title matches
    title_matched = False
    if q_title_part_clean:
        if (q_title_part_clean == title_clean or 
            q_title_part_main == title_main or 
            difflib.SequenceMatcher(None, q_title_part_clean, title_clean).ratio() > 0.85 or 
            difflib.SequenceMatcher(None, q_title_part_main, title_main).ratio() > 0.85):
            title_matched = True
    else:
        if title_clean in q_clean or title_main in q_clean:
            title_matched = True
        elif difflib.SequenceMatcher(None, q_clean, title_clean).ratio() > 0.8 or difflib.SequenceMatcher(None, q_clean, title_main).ratio() > 0.8:
            title_matched = True

    if artist_matched and title_matched:
        score += 1000.0  # Boost for artist + title combined matches

    # ── Establish officiality and popularity ranks early for matching decisions ──
    is_atv = (video_type == "MUSIC_VIDEO_TYPE_ATV")
    is_omv = (video_type == "MUSIC_VIDEO_TYPE_OMV")
    is_ugc = (video_type == "MUSIC_VIDEO_TYPE_UGC")
    is_official_other = (video_type == "MUSIC_VIDEO_TYPE_OFFICIAL_OTHER")
    is_itunes_official = (source in ["itunes", "merged"])
    is_official = is_atv or is_omv or is_itunes_official or is_official_other
    min_rank = min(itunes_rank, yt_rank)

    # ── Mainstream artist weighting ──
    POPULAR_ARTISTS = {
        # Indian/Pakistani Mainstream & Legends
        "arijit singh", "nusrat fateh ali khan", "rahat fateh ali khan", "atif aslam", "sonu nigam",
        "kishore kumar", "lata mangeshkar", "mohammed rafi", "udit narayan", "alka yagnik", "asha bhosle",
        "shreya ghoshal", "kk", "pritam", "ar rahman", "anirudh ravichander", "diljit dosanjh",
        "sidhu moose wala", "karan aujla", "shubh", "ap dhillon", "gurinder gill", "badshah", "raftaar",
        "divine", "krsna", "kr$na", "seedhe maut", "talha anjum", "talha yunus", "young stunners",
        "emiway", "mc stan", "dino james", "king", "darshan raval", "jubin nautiyal", "neha kakkar",
        "tony kakkar", "bpraak", "b praak", "jaani", "harrdy sandhu", "guru randhawa", "jass manak",
        "yoyo honey singh", "honey singh", "abida parveen", "jagjit singh", "amit trivedi",
        
        # International Mainstream giants
        "drake", "taylor swift", "the weeknd", "eminem", "travis scott", "kanye west", "post malone",
        "justin bieber", "ed sheeran", "ariana grande", "billie eilish", "bruno mars", "coldplay",
        "bts", "blackpink", "jungkook", "jimin", "dua lipa", "rihanna", "beyonce", "shakira",
        "lady gaga", "selena gomez", "shawn mendes", "camila cabello", "halsey", "david guetta",
        "alan walker", "chainsmokers", "avicii", "calvin harris", "charlie puth", "newjeans"
    }

    is_mainstream_artist = False
    artist_lower = artist.lower() if artist else ""
    for pa in POPULAR_ARTISTS:
        if pa in artist_lower:
            is_mainstream_artist = True
            break

    if is_mainstream_artist:
        score += 450.0  # Mainstream artist authority boost!

    # ── Intent prediction ──
    # If the user does not specify an artist, but the candidate has a mainstream artist,
    # it fits the user's implicit intent of finding the popular version.
    query_mentions_popular_artist = any(pa in q_clean for pa in POPULAR_ARTISTS)
    if not query_mentions_popular_artist and is_mainstream_artist:
        score += 500.0

    # Check token matching
    q_words = [w for w in q_clean.split() if w not in {"by", "the", "a", "an", "and", "of", "in", "feat", "ft", "song", "songs", "video", "audio", "lyrics", "music", "official", "original", "hq"}]
    t_words = title_clean.split()
    a_words = artist_clean.split()
    
    if not q_words:
        return 0.0

    # Number of query words that match title or artist
    matches_title = [w for w in q_words if w in t_words]
    matches_artist = [w for w in q_words if w in a_words]
    
    # Exact full match checks (highest priority)
    is_exact_title = q_clean == title_clean or q_main == title_main
    is_exact_artist = q_clean == artist_clean or q_main == artist_main
    
    if q_title_part_clean and q_artist_part_clean:
        if (q_title_part_clean == title_clean or q_title_part_main == title_main) and (q_artist_part_clean == artist_clean or q_artist_part_main == artist_main):
            if min_rank <= 2 or is_official:
                score += 3000.0  # Mega boost for exact title + exact artist match!
            else:
                score += 800.0

    if q_clean == f"{artist_clean} {title_clean}" or q_clean == f"{title_clean} {artist_clean}" or q_main == f"{artist_main} {title_main}" or q_main == f"{title_main} {artist_main}":
        if min_rank <= 2 or is_official:
            score += 2500.0
        else:
            score += 600.0
    elif is_exact_title:
        # Avoid obscure exact title matches dominating globally popular versions
        if min_rank <= 2 or is_official:
            score += 2000.0
            # Strengthen official release dominance: Popular + Official + Exact Title Match gets aggressive boost (Task 5)
            if min_rank <= 1 and (is_atv or is_omv or is_itunes_official):
                score += 2500.0
        else:
            score += 400.0  # Obscure exact-title match gets way less boost
    elif is_exact_artist:
        if min_rank <= 2 or is_official:
            score += 1000.0
        else:
            score += 300.0
    
    # If ALL query words match either title or artist
    q_set = set(q_words)
    t_set = set(t_words)
    a_set = set(a_words)
    all_matched = q_set.issubset(t_set.union(a_set))
    if all_matched:
        score += 250.0
        # If it matched both at least one word from title and artist
        if q_set.intersection(t_set) and q_set.intersection(a_set):
            score += 200.0
            
    # Boost if both artist and title are matched even if not all query words match (artist + song combined queries)
    if q_set.intersection(t_set) and q_set.intersection(a_set):
        score += 400.0

    # Primary Artist specific boost for artist + song combined queries
    if cand_artists:
        primary_clean = cand_artists[0]
        primary_words = set(primary_clean.split())
        if primary_words and primary_words.issubset(q_set):
            score += 200.0
            t_words_main = {w for w in main_clean(title).split() if w not in {"by", "the", "a", "an", "and", "of", "in", "song", "music"}}
            if t_words_main and t_words_main.intersection(q_set):
                score += 350.0
            
    # Fuzzy similarity using difflib
    sim_title = difflib.SequenceMatcher(None, q_clean, title_clean).ratio()
    sim_artist = difflib.SequenceMatcher(None, q_clean, artist_clean).ratio()
    sim_combined = max(
        difflib.SequenceMatcher(None, q_clean, f"{artist_clean} {title_clean}").ratio(),
        difflib.SequenceMatcher(None, q_clean, f"{title_clean} {artist_clean}").ratio(),
        difflib.SequenceMatcher(None, q_main, f"{artist_main} {title_main}").ratio(),
        difflib.SequenceMatcher(None, q_main, f"{title_main} {artist_main}").ratio()
    )
    score += max(sim_title, sim_artist, sim_combined) * 80.0

    # Token-based word matches
    t_match_ratio = len(set(matches_title)) / len(q_set)
    a_match_ratio = len(set(matches_artist)) / len(q_set)
    score += t_match_ratio * 100.0
    score += a_match_ratio * 50.0
    if matches_title and matches_artist:
        score += 100.0

    # Weak match filter
    has_token_match = len(matches_title) > 0 or len(matches_artist) > 0
    has_strong_fuzzy = sim_combined > 0.65
    
    if not has_token_match and not has_strong_fuzzy:
        # Heavily penalize totally unrelated search results returned by API
        score -= 3000.0

    # ── Authority & Metadata Scoring boosts ──
    is_topic_channel = False
    if artist:
        artist_lower = artist.lower()
        if artist_lower.endswith("- topic") or artist_lower.endswith("-topic") or "topic" in artist_lower:
            is_topic_channel = True

    # Source base boost & authority hierarchy
    if is_atv:
        score += 650.0       # YouTube Music Official Audio Track Video
    if is_omv:
        score += 400.0       # Official Music Video
    if is_official_other:
        score += 200.0       # Official lyric videos, etc.
    if is_itunes_official:
        score += 500.0       # iTunes/Merged is highly official
    if is_topic_channel:
        score += 450.0       # Topic channel release boost

    # ── Popularity rank weighting ──
    if min_rank == 0:
        score += 800.0
    elif min_rank == 1:
        score += 500.0
    elif min_rank == 2:
        score += 300.0
    elif min_rank == 3:
        score += 200.0
    elif min_rank == 4:
        score += 100.0
    elif min_rank < 10:
        score += 50.0

    # Penalize obscure candidates with low rank that are not official releases
    if min_rank >= 5 and not is_official:
        score -= 800.0

    # Source adjustment fallback
    if source == "merged":
        score += 400.0
    elif source == "itunes":
        score += 300.0
    elif source == "ytmusic":
        score += 50.0
    elif source == "lrc":
        if len(q_words) >= 4:
            score += 40.0
        else:
            score -= 20.0

    # Penalties for low-quality / unofficial uploads (reposts, mashups, etc.)
    if is_ugc:
        user_wants_ugc = any(w in q_clean for w in ["remix", "cover", "lyrics", "lyric", "slowed", "reverb", "mashup", "repost", "bootleg", "fan", "lofi"])
        if not user_wants_ugc:
            score -= 2000.0

    bad_words = [
        "remix", "cover", "karaoke", "instrumental", "tribute", "mashup", "lounge", 
        "lofi", "lo-fi", "slowed", "reverb", "reverbed", "sped up", "nightcore", "parody",
        "bootleg", "refix", "edit", "8d", "slow", "repost", "lyrics", "lyric", "lyric video", 
        "full audio", "mp3", "download", "reupload", "bass boosted", "loop", "re-upload", "re upload"
    ]
    
    clean_indicators = bad_words + ["live", "concert", "performance", "tour", "session", "version"]

    for word in bad_words:
        if word in title_clean or word in artist_clean:
            if word not in q_clean:
                score -= 2500.0  # Strictly penalize unofficial version
            else:
                score += 500.0   # User explicitly wanted it

    # Official / Original indicators boost
    official_keywords = ["official", "original", "hq", "high quality"]
    for word in official_keywords:
        if word in title_clean and word not in q_clean:
            score += 200.0
            
    # Penalize live versions if not queried
    live_keywords = ["live", "concert", "performance", "tour", "session"]
    for word in live_keywords:
        if word in title_clean and word not in q_clean:
            score -= 1000.0

    # Boost clean version when no live/remix/lyrics was queried
    is_clean = not any(w in title_clean for w in clean_indicators)
    if is_clean and not any(w in q_clean for w in clean_indicators):
        score += 300.0

    return score


@app.get("/api/mobile/smart_search")
def mobile_smart_search(q: str = ""):
    """Unified discovery search: iTunes + YouTube Music + LRC lookup with intent mapping."""
    if not q or not q.strip():
        return JSONResponse({
            "type": "direct",
            "intent": "direct",
            "songs": [],
            "playlists": [],
            "artists": [],
            "mixes": [],
            "top_result": None
        })

    query = q.strip()
    
    # Check cache first
    cached_results = _get_cached_search(query)
    if cached_results is not None:
        return JSONResponse(cached_results)

    intent_data = classify_search_query(query)
    intent = intent_data["intent"]
    smart_query = intent_data["smart_query"]

    songs = []
    playlists = []
    artists = []
    mixes = []
    top_result = None

    def fetch_and_rank_songs(search_q: str):
        cleaned_query = clean_search_query(search_q)
        candidates = {}
        
        # 1. iTunes search
        try:
            itunes_results = search_songs(cleaned_query)
            for idx, s in enumerate(itunes_results):
                key = get_dedup_key(s.get("artist", ""), s.get("title", ""))
                if not key:
                    continue
                candidates[key] = {
                    "id": s.get("id"),
                    "videoId": s.get("videoId") or "",
                    "title": s.get("title"),
                    "artist": s.get("artist"),
                    "album": s.get("album", ""),
                    "cover": s.get("cover", ""),
                    "cover_xl": s.get("cover_xl", ""),
                    "duration": s.get("duration", 0),
                    "genre": s.get("genre", ""),
                    "source": "itunes",
                    "itunes_rank": idx,
                    "yt_rank": 999
                }
        except Exception:
            pass

        # 2. YouTube Music search
        try:
            yt_results = ytmusic_service.search_ytmusic(cleaned_query, limit=15)
            for idx, t in enumerate(yt_results):
                key = get_dedup_key(t.get("artist", ""), t.get("title", ""))
                if not key:
                    continue
                if key in candidates:
                    c = candidates[key]
                    c["videoId"] = t["videoId"]
                    if not c["cover"] and t["thumbnail"]:
                        c["cover"] = t["thumbnail"]
                        c["cover_xl"] = t["thumbnail"]
                    if not c["duration"] and t["duration"]:
                        c["duration"] = t["duration"]
                    c["source"] = "merged"
                    c["yt_rank"] = idx
                    c["videoType"] = t.get("videoType", "")
                else:
                    candidates[key] = {
                        "id": t["videoId"],
                        "videoId": t["videoId"],
                        "title": t["title"],
                        "artist": t["artist"],
                        "album": t.get("album", ""),
                        "cover": t["thumbnail"],
                        "cover_xl": t["thumbnail"],
                        "duration": t["duration"],
                        "source": "ytmusic",
                        "itunes_rank": 999,
                        "yt_rank": idx,
                        "videoType": t.get("videoType", "")
                    }
        except Exception as e:
            logger.exception("YouTube Music search failed for query %r: %s", cleaned_query, e)

        # 3. LRCLIB search
        if len(search_q.split()) >= 3:
            try:
                resp = requests.get(
                    "https://lrclib.net/api/search",
                    params={"q": search_q},
                    headers={"User-Agent": "Daydreamin/3.0"},
                    timeout=5,
                )
                data = resp.json()
                if isinstance(data, list):
                    for item in data[:6]:
                        artist = item.get("artistName", "")
                        title = item.get("trackName", "")
                        if not artist or not title:
                            continue
                        key = get_dedup_key(artist, title)
                        if key not in candidates:
                            candidates[key] = {
                                "id": f"lrc_{item.get('id', '')}",
                                "videoId": "",
                                "title": title,
                                "artist": artist,
                                "album": item.get("albumName", ""),
                                "cover": "",
                                "cover_xl": "",
                                "duration": item.get("duration", 0),
                                "source": "lrc",
                                "itunes_rank": 999,
                                "yt_rank": 999,
                                "videoType": ""
                            }
            except Exception:
                pass

        # Rank
        scored = []
        for c in candidates.values():
            itunes_rank = c.get("itunes_rank", 999)
            yt_rank = c.get("yt_rank", 999)
            video_type = c.get("videoType", "")
            score = score_candidate(search_q, c["title"], c["artist"], c["source"], itunes_rank=itunes_rank, yt_rank=yt_rank, video_type=video_type)
            scored.append((score, c))
            
        scored.sort(key=lambda x: x[0], reverse=True)
        
        # Filter: exclude candidates with negative or extremely low scores (e.g. penalized unrelated items)
        filtered_scored = [item for item in scored if item[0] > -100.0]
        if not filtered_scored and scored:
            # Fallback to top 3 if everything was filtered out
            filtered_scored = scored[:3]
            
        return [item[1] for item in filtered_scored]

    # Process intent
    if intent == "songs_like":
        target = intent_data["target"]
        vid = ytmusic_service.resolve_video_id("", target)
        if vid:
            try:
                yt_results = ytmusic_service.search_ytmusic(target, limit=3)
                if yt_results:
                    t = yt_results[0]
                    top_result = {
                        "type": "song",
                        "id": t["videoId"],
                        "videoId": t["videoId"],
                        "title": t["title"],
                        "artist": t["artist"],
                        "album": t.get("album", ""),
                        "cover": t["thumbnail"],
                        "cover_xl": t["thumbnail"],
                        "duration": t["duration"],
                        "source": "seed_track",
                        "badge": "Base Track"
                    }
            except Exception:
                pass

            rec_tracks = ytmusic_service.get_radio_queue(video_id=vid, limit=25)
            for t in rec_tracks:
                songs.append({
                    "id": t["videoId"],
                    "videoId": t["videoId"],
                    "title": t["title"],
                    "artist": t["artist"],
                    "album": "Similar Mix",
                    "cover": t["thumbnail"],
                    "cover_xl": t["thumbnail"],
                    "duration": t["duration"],
                    "source": "similarity"
                })
        else:
            songs = fetch_and_rank_songs(target)
            
        playlists = ytmusic_service.search_playlists(f"songs like {target}", limit=6)
        
    elif intent == "mood_discovery":
        # Search playlists with smart query
        playlists = ytmusic_service.search_playlists(smart_query, limit=8)
        songs = fetch_and_rank_songs(query)
        
        artist_query = intent_data.get("artist") or query
        artists = ytmusic_service.search_artists(artist_query, limit=5)
        
        mixes = ytmusic_service.search_playlists(f"{intent_data.get('mood', 'chill')} mix", limit=6)
        
        # Pick top playlist as top result
        if playlists:
            p = playlists[0]
            top_result = {
                "type": "playlist",
                "id": p["id"],
                "title": p["title"],
                "author": p["author"],
                "thumbnail": p["thumbnail"],
                "trackCount": p["trackCount"],
                "badge": "Featured Playlist"
            }
        elif songs:
            top_result = {
                "type": "song",
                **songs[0],
                "badge": "Top Match"
            }
            
    else: # direct
        songs = fetch_and_rank_songs(query)
        playlists = ytmusic_service.search_playlists(query, limit=6)
        artists = ytmusic_service.search_artists(query, limit=5)
        
        top_song = songs[0] if songs else None
        top_artist = artists[0] if artists else None
        
        if top_artist and top_song:
            if query.lower().strip() == top_artist["name"].lower().strip():
                top_result = {
                    "type": "artist",
                    "id": top_artist["id"],
                    "name": top_artist["name"],
                    "thumbnail": top_artist["thumbnail"],
                    "badge": "Top Artist"
                }
            else:
                top_result = {
                    "type": "song",
                    **top_song,
                    "badge": "Top Result"
                }
        elif top_song:
            top_result = {
                "type": "song",
                **top_song,
                "badge": "Top Result"
            }
        elif top_artist:
            top_result = {
                "type": "artist",
                "id": top_artist["id"],
                "name": top_artist["name"],
                "thumbnail": top_artist["thumbnail"],
                "badge": "Top Artist"
            }

    final_response = {
        "type": "discovery" if (intent != "direct" or playlists or artists) else "direct",
        "intent": intent,
        "query": query,
        "songs": songs,
        "playlists": playlists,
        "artists": artists,
        "mixes": mixes,
        "top_result": top_result
    }

    _set_cached_search(query, final_response)
    return JSONResponse(final_response)


@app.get("/api/mobile/playlist_details")
def mobile_playlist_details(id: str = ""):
    """Fetch tracks of a community or discovery playlist from YTMusic."""
    details = ytmusic_service.get_playlist_details(id)
    if not details:
        return JSONResponse({"error": "Playlist details not found"}, status_code=404)
    return JSONResponse(details)



@app.get("/api/mobile/chart")
def mobile_chart():
    return JSONResponse(get_chart())


@app.get("/api/mobile/lyrics")
async def mobile_lyrics(artist: str = "", title: str = ""):
    import asyncio
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(executor, fetch_lyrics, artist, title)
    return JSONResponse(result)


@app.get("/api/mobile/play")
def mobile_play(request: Request, id: str = "", artist: str = "", title: str = "",
                previous_song_id: str | None = None, videoId: str = ""):
    update_transition(previous_song_id, id)
    return render_play_response(request, id, artist, title, video_id=videoId)


@app.get("/api/mobile/test_ytmusic")
def test_ytmusic():
    import time
    t0 = time.time()
    try:
        import yt_dlp
        import curl_cffi
        cffi_ver = curl_cffi.__version__
    except Exception as e:
        cffi_ver = f"Failed to import: {e}"
        
    try:
        import ytmusic_service
        vid = ytmusic_service.resolve_video_id("Anirudh Ravichander", "Raga of Revenge")
        return {"status": "success", "videoId": vid, "curl_cffi": cffi_ver, "yt_dlp_version": yt_dlp.version.__version__, "time": f"{time.time() - t0:.2f}s"}
    except Exception as e:
        import traceback
        return {"status": "error", "error": traceback.format_exc(), "curl_cffi": cffi_ver, "time": f"{time.time() - t0:.2f}s"}


@app.get("/api/mobile/test_ytdlp")
def test_ytdlp():
    import time
    t0 = time.time()
    try:
        import yt_dlp
        ydl_opts = {
            "format": "bestaudio/best",
            "quiet": True,
            "noplaylist": True,
            "check_formats": False,
            "socket_timeout": 10,
            "impersonate": "chrome",
            "extractor_args": {
                "youtube": {
                    "player_client": ["web", "mweb", "android"]
                }
            },
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info("https://www.youtube.com/watch?v=dQw4w9WgXcQ", download=False)
            return {"status": "success", "url_len": len(info["url"]), "time": f"{time.time() - t0:.2f}s"}
    except Exception as e:
        import traceback
        return {"status": "error", "error": traceback.format_exc(), "time": f"{time.time() - t0:.2f}s"}


@app.get("/api/mobile/test_ytdlp_search")
def test_ytdlp_search():
    import time
    t0 = time.time()
    try:
        import yt_dlp
        ydl_opts = {
            "format": "bestaudio/best",
            "quiet": True,
            "noplaylist": True,
            "check_formats": False,
            "socket_timeout": 10,
            "impersonate": "chrome",
            "extractor_args": {
                "youtube": {
                    "player_client": ["web", "mweb", "android"]
                }
            },
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info("ytsearch1:Anirudh Ravichander Raga of Revenge", download=False)
            video = info["entries"][0] if "entries" in info else info
            return {"status": "success", "title": video.get("title"), "id": video.get("id"), "time": f"{time.time() - t0:.2f}s"}
    except Exception as e:
        import traceback
        return {"status": "error", "error": traceback.format_exc(), "time": f"{time.time() - t0:.2f}s"}



@app.get("/api/mobile/up_next")
def mobile_up_next(song_id: str = "", artist: str = "", title: str = "", limit: int = 15):
    return JSONResponse(build_up_next_response(song_id, artist=artist, title=title, limit=limit or 15))


@app.get("/api/mobile/preload")
def mobile_preload(artist: str = "", title: str = "", videoId: str = ""):
    return JSONResponse(preload_stream(artist, title, video_id=videoId))


@app.get("/api/mobile/recommend")
def mobile_recommend(song_id: str = ""):
    """Legacy recommendation endpoint — kept for backward compatibility."""
    try:
        from recommendation import get_recommendations
        from recommendation import get_songs_by_ids as get_by_ids
        grouped_ids = get_recommendations(song_id)
        return JSONResponse({
            "behavior_based": inject_cache_status(get_by_ids(grouped_ids.get("behavior_based", []))),
            "content_based": inject_cache_status(get_by_ids(grouped_ids.get("content_based", []))),
        })
    except Exception:
        return JSONResponse({"behavior_based": [], "content_based": []})


@app.get("/api/mobile/stream_cache/{filename:path}")
def mobile_stream_cache(filename: str):
    filepath = CACHE_DIR / filename
    if not filepath.exists():
        return PlainTextResponse("Not Found", status_code=404)
    return FileResponse(filepath)


@app.get("/api/mobile/stream_proxy")
def mobile_stream_proxy(request: Request, url: str = "", headers: str = "{}"):
    if not url:
        return PlainTextResponse("No URL", status_code=400)
    return build_proxy_response(url, request.headers, headers)


@app.post("/api/mobile/cache_song")
async def mobile_cache_song(request: Request):
    data = await request.json()
    if not data:
        return JSONResponse({"error": "No data"}, status_code=400)
    executor.submit(download_task, str(data.get("id")), data.get("artist"), data.get("title"))
    return JSONResponse({"status": "queued"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=499, reload=False)
