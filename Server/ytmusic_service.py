"""
YouTube Music service — wraps ytmusicapi for recommendations, search, and video ID resolution.
Runs in unauthenticated mode (no Google account needed).
"""

import logging
import time
from functools import lru_cache
from threading import Lock

logger = logging.getLogger(__name__)

# ── Lazy singleton ──────────────────────────────────────────────────────────
_yt = None
_yt_lock = Lock()


def _get_client():
    """Thread-safe lazy init of the YTMusic client."""
    global _yt
    if _yt is None:
        with _yt_lock:
            if _yt is None:
                from ytmusicapi import YTMusic
                _yt = YTMusic()
                logger.info("YTMusic client initialised (unauthenticated)")
    return _yt


# ── In-memory cache for video ID lookups ────────────────────────────────────
_vid_cache: dict[str, tuple[str, float]] = {}   # key → (videoId, timestamp)
_VID_TTL = 3600  # 1 hour


def _cache_key(artist: str, title: str) -> str:
    return f"{artist.strip().lower()}|{title.strip().lower()}"


def resolve_video_id(artist: str, title: str) -> str | None:
    """
    Find the best YouTube Music videoId for an artist + title pair.
    Cached in memory for 1 hour.
    """
    import re
    if not artist and " by " in title.lower():
        parts = re.split(r"\s+by\s+", title, flags=re.IGNORECASE)
        title = parts[0].strip()
        artist = parts[1].strip()

    key = _cache_key(artist, title)
    cached = _vid_cache.get(key)
    if cached and (time.time() - cached[1]) < _VID_TTL:
        return cached[0]

    try:
        yt = _get_client()
        query = f"{artist} {title}".strip()
        results = yt.search(query, filter="songs", limit=5)
        if not results:
            results = yt.search(query, filter="videos", limit=5)
        if not results:
            return None

        # Score candidates to avoid picking a cover/remix/live version as seed
        scored = []
        for idx, r in enumerate(results):
            vid = r.get("videoId")
            if not vid:
                continue
            r_title = r.get("title", "")
            r_artists = r.get("artists") or []
            r_artist = ", ".join(a.get("name", "") for a in r_artists if a.get("name")) or "Unknown"
            
            # Base score starts high and drops slightly with search rank
            r_score = 100.0 - idx * 10.0
            
            # Heavy penalty for covers/remixes/live if they are not part of the search title/artist
            r_title_lower = r_title.lower()
            r_artist_lower = r_artist.lower()
            bad_keywords = ["remix", "cover", "karaoke", "instrumental", "tribute", "mashup", "lofi", "slowed", "reverb", "sped up", "nightcore", "live", "concert", "performance"]
            for word in bad_keywords:
                if word in r_title_lower and word not in title.lower() and word not in artist.lower():
                    r_score -= 1500.0
                if word in r_artist_lower and word not in artist.lower():
                    r_score -= 1500.0
                    
            # Boost matching artist names (+200.0) and titles (+300.0)
            q_title_words = set(re.findall(r"\w+", title.lower()))
            q_artist_words = set(re.findall(r"\w+", artist.lower()))
            t_words = set(re.findall(r"\w+", r_title_lower))
            a_words = set(re.findall(r"\w+", r_artist_lower))
            if q_title_words.intersection(t_words):
                r_score += 300.0
            if q_artist_words.intersection(a_words):
                r_score += 200.0
                
            scored.append((r_score, vid))
            
        if scored:
            scored.sort(key=lambda x: x[0], reverse=True)
            video_id = scored[0][1]
        else:
            video_id = results[0].get("videoId")

        if video_id:
            _vid_cache[key] = (video_id, time.time())
        return video_id
    except Exception as exc:
        logger.warning("resolve_video_id failed for '%s - %s': %s", artist, title, exc)
        return None


def get_radio_queue(video_id: str | None = None, artist: str = "", title: str = "", limit: int = 25) -> list[dict]:
    """
    Get YouTube Music's radio queue (their recommendation engine).
    Returns a list of track dicts with: videoId, title, artist, thumbnail, duration.
    """
    if not video_id and artist and title:
        video_id = resolve_video_id(artist, title)
    if not video_id:
        return []

    watch = None
    max_retries = 3
    for attempt in range(max_retries):
        try:
            yt = _get_client()
            watch = yt.get_watch_playlist(videoId=video_id, radio=True, limit=limit)
            if watch and "tracks" in watch:
                break
        except Exception as exc:
            if attempt < max_retries - 1:
                logger.warning("get_radio_queue failed for videoId=%s on attempt %d (error: %s). Retrying...", video_id, attempt + 1, exc)
                time.sleep(0.5)
            else:
                logger.warning("get_radio_queue failed for videoId=%s after %d attempts: %s", video_id, max_retries, exc)
                return []

    if not watch or "tracks" not in watch:
        return []

    try:
        tracks = []
        for t in watch.get("tracks", []):
            if not t:
                continue
            vid = t.get("videoId", "")
            if not vid or vid == video_id:
                continue

            # Extract artist(s)
            artists_list = t.get("artists") or []
            artist_name = ", ".join(a.get("name", "") for a in artists_list if a.get("name")) or "Unknown"

            # Extract thumbnail (pick largest)
            thumb = ""
            thumbnails = t.get("thumbnail") or []
            if isinstance(thumbnails, list):
                for tn in thumbnails:
                    if isinstance(tn, dict):
                        thumb = tn.get("url", thumb)
            elif isinstance(thumbnails, dict):
                for tn in thumbnails.get("thumbnails", []):
                    thumb = tn.get("url", thumb)

            # Duration
            dur_str = t.get("duration", "") or ""
            dur_sec = _parse_duration(dur_str)

            tracks.append({
                "videoId": vid,
                "title": t.get("title", "Unknown"),
                "artist": artist_name,
                "thumbnail": thumb,
                "duration": dur_sec,
            })

        return tracks[:limit]
    except Exception as exc:
        logger.warning("get_radio_queue failed for videoId=%s: %s", video_id, exc)
        return []


def search_ytmusic(query: str, limit: int = 20) -> list[dict]:
    """
    Search YouTube Music. Returns normalised track dicts.
    """
    if not query or not query.strip():
        return []

    try:
        yt = _get_client()
        results = yt.search(query, filter="songs", limit=limit)
        tracks = []
        for r in results or []:
            vid = r.get("videoId", "")
            if not vid:
                continue

            artists_list = r.get("artists") or []
            artist_name = ", ".join(a.get("name", "") for a in artists_list if a.get("name")) or "Unknown"

            thumb = ""
            thumbnails = r.get("thumbnails") or []
            for tn in thumbnails:
                if isinstance(tn, dict):
                    thumb = tn.get("url", thumb)

            dur_str = r.get("duration", "") or ""
            dur_sec = _parse_duration(dur_str)

            album_info = r.get("album") or {}
            album_name = album_info.get("name", "Single") if isinstance(album_info, dict) else "Single"

            tracks.append({
                "videoId": vid,
                "title": r.get("title", "Unknown"),
                "artist": artist_name,
                "album": album_name,
                "thumbnail": thumb,
                "duration": dur_sec,
                "videoType": r.get("videoType", ""),
            })

        return tracks[:limit]
    except Exception as exc:
        logger.warning("search_ytmusic failed for '%s': %s", query, exc)
        return []


def _parse_duration(dur_str: str) -> int:
    """Parse "3:45" or "1:02:30" into seconds."""
    if not dur_str:
        return 0
    try:
        parts = dur_str.split(":")
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return 0
    except (ValueError, TypeError):
        return 0


def search_playlists(query: str, limit: int = 10) -> list[dict]:
    """Search for playlists on YouTube Music."""
    if not query or not query.strip():
        return []
    try:
        yt = _get_client()
        results = yt.search(query, filter="playlists", limit=limit)
        playlists = []
        for r in results or []:
            playlist_id = r.get("browseId")
            if not playlist_id:
                continue

            # Author
            author = "YouTube Music"
            if "author" in r:
                if isinstance(r["author"], list):
                    author = ", ".join(a.get("name", "") for a in r["author"] if a.get("name"))
                elif isinstance(r["author"], dict):
                    author = r["author"].get("name", author)
                elif isinstance(r["author"], str):
                    author = r["author"]

            # Thumbnail
            thumb = ""
            thumbnails = r.get("thumbnails") or []
            for tn in thumbnails:
                if isinstance(tn, dict):
                    thumb = tn.get("url", thumb)

            playlists.append({
                "id": playlist_id,
                "title": r.get("title", "Unknown Playlist"),
                "author": author,
                "thumbnail": thumb,
                "trackCount": r.get("trackCount", 0),
            })
        return playlists[:limit]
    except Exception as exc:
        logger.warning("search_playlists failed for '%s': %s", query, exc)
        return []


def search_artists(query: str, limit: int = 5) -> list[dict]:
    """Search for artists on YouTube Music."""
    if not query or not query.strip():
        return []
    try:
        yt = _get_client()
        results = yt.search(query, filter="artists", limit=limit)
        artists = []
        for r in results or []:
            artist_id = r.get("browseId")
            if not artist_id:
                continue

            thumb = ""
            thumbnails = r.get("thumbnails") or []
            for tn in thumbnails:
                if isinstance(tn, dict):
                    thumb = tn.get("url", thumb)

            artists.append({
                "id": artist_id,
                "name": r.get("artist", "Unknown Artist"),
                "thumbnail": thumb,
            })
        return artists[:limit]
    except Exception as exc:
        logger.warning("search_artists failed for '%s': %s", query, exc)
        return []


def get_playlist_details(playlist_id: str, limit: int = 50) -> dict | None:
    """Get tracks and metadata for a playlist."""
    if not playlist_id:
        return None
    try:
        yt = _get_client()
        pl = yt.get_playlist(playlistId=playlist_id, limit=limit)
        if not pl:
            return None

        tracks = []
        for t in pl.get("tracks", []):
            if not t:
                continue
            vid = t.get("videoId")
            if not vid:
                continue

            artists_list = t.get("artists") or []
            artist_name = ", ".join(a.get("name", "") for a in artists_list if a.get("name")) or "Unknown"

            thumb = ""
            thumbnails = t.get("thumbnails") or []
            for tn in thumbnails:
                if isinstance(tn, dict):
                    thumb = tn.get("url", thumb)

            dur_sec = t.get("duration_seconds", 0)
            if not dur_sec and t.get("duration"):
                dur_sec = _parse_duration(t.get("duration"))

            album_info = t.get("album") or {}
            album_name = album_info.get("name", "Single") if isinstance(album_info, dict) else "Single"

            tracks.append({
                "videoId": vid,
                "title": t.get("title", "Unknown"),
                "artist": artist_name,
                "album": album_name,
                "thumbnail": thumb,
                "duration": dur_sec,
            })

        author = "YouTube Music"
        if "author" in pl:
            if isinstance(pl["author"], list):
                author = ", ".join(a.get("name", "") for a in pl["author"] if a.get("name"))
            elif isinstance(pl["author"], dict):
                author = pl["author"].get("name", author)
            elif isinstance(pl["author"], str):
                author = pl["author"]

        thumb = ""
        thumbnails = pl.get("thumbnails") or []
        for tn in thumbnails:
            if isinstance(tn, dict):
                thumb = tn.get("url", thumb)

        return {
            "id": playlist_id,
            "title": pl.get("title", "Playlist"),
            "description": pl.get("description", ""),
            "author": author,
            "thumbnail": thumb,
            "trackCount": pl.get("trackCount", len(tracks)),
            "tracks": tracks
        }
    except Exception as exc:
        logger.warning("get_playlist_details failed for '%s': %s", playlist_id, exc)
        return None

