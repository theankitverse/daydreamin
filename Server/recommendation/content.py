import json
import os
import statistics
from tempfile import NamedTemporaryFile

try:
    import numpy as np
except ImportError:  # pragma: no cover - exercised only in environments without numpy
    np = None


BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DEFAULT_SONGS_PATH = os.path.join(DATA_DIR, "songs.json")

_catalog_cache = None
_catalog_cache_mtime = None


def get_songs_path():
    return os.environ.get("BITSONGS_SONGS_PATH", DEFAULT_SONGS_PATH)


def _ensure_songs_file():
    path = get_songs_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump([], handle, indent=2)
            handle.write("\n")


def _normalize_song(song):
    song_id = str(song.get("id", "")).strip()
    if not song_id:
        return None

    normalized = {
        "id": song_id,
        "title": song.get("title", "Unknown") or "Unknown",
        "artist": song.get("artist", "") or "",
        "artist_id": int(song.get("artist_id", 0) or 0),
        "album": song.get("album", "Single") or "Single",
        "cover": song.get("cover", "") or "",
        "cover_xl": song.get("cover_xl", "") or "",
        "duration": int(song.get("duration", 0) or 0),
        "genre": song.get("genre", "") or "",
    }

    tempo = song.get("tempo")
    try:
        normalized["tempo"] = float(tempo) if tempo is not None else None
    except (TypeError, ValueError):
        normalized["tempo"] = None

    energy = song.get("energy")
    try:
        normalized["energy"] = float(energy) if energy is not None else None
    except (TypeError, ValueError):
        normalized["energy"] = None

    return normalized


def _read_catalog():
    global _catalog_cache, _catalog_cache_mtime

    _ensure_songs_file()
    path = get_songs_path()
    mtime = os.path.getmtime(path)
    if _catalog_cache is not None and _catalog_cache_mtime == mtime:
        return [dict(song) for song in _catalog_cache]

    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw_catalog = json.load(handle)
    except (OSError, json.JSONDecodeError):
        raw_catalog = []

    catalog = []
    if isinstance(raw_catalog, list):
        for song in raw_catalog:
            if isinstance(song, dict):
                normalized = _normalize_song(song)
                if normalized is not None:
                    catalog.append(normalized)

    _catalog_cache = catalog
    _catalog_cache_mtime = mtime
    return [dict(song) for song in catalog]


def _write_catalog(catalog):
    global _catalog_cache, _catalog_cache_mtime

    _ensure_songs_file()
    path = get_songs_path()
    directory = os.path.dirname(path)
    ordered_catalog = sorted(catalog, key=lambda song: song["id"])
    with NamedTemporaryFile("w", delete=False, dir=directory, encoding="utf-8") as handle:
        json.dump(ordered_catalog, handle, indent=2)
        handle.write("\n")
        temp_path = handle.name
    os.replace(temp_path, path)
    _catalog_cache = ordered_catalog
    _catalog_cache_mtime = os.path.getmtime(path)


def upsert_song_records(songs):
    catalog = {song["id"]: song for song in _read_catalog()}
    changed = False

    for song in songs or []:
        if not isinstance(song, dict):
            continue
        normalized = _normalize_song(song)
        if normalized is None:
            continue

        existing = catalog.get(normalized["id"], {})
        merged = dict(existing)
        merged.update({key: value for key, value in normalized.items() if value not in ("", None)})
        if "tempo" not in merged:
            merged["tempo"] = None
        if "energy" not in merged:
            merged["energy"] = None

        if existing != merged:
            catalog[normalized["id"]] = merged
            changed = True

    if changed:
        _write_catalog(list(catalog.values()))


def get_song_by_id(song_id):
    song_id = str(song_id or "").strip()
    if not song_id:
        return None
    catalog = {song["id"]: song for song in _read_catalog()}
    song = catalog.get(song_id)
    return dict(song) if song else None


def get_songs_by_ids(song_ids):
    catalog = {song["id"]: song for song in _read_catalog()}
    songs = []
    for song_id in song_ids:
        song = catalog.get(str(song_id))
        if song:
            songs.append(dict(song))
    return songs


def _build_feature_matrix(catalog):
    if not catalog:
        return [], []

    artists = sorted({song.get("artist", "") or "" for song in catalog})
    genres = sorted({song.get("genre", "") or "" for song in catalog})
    artist_index = {artist: idx for idx, artist in enumerate(artists)}
    genre_index = {genre: idx for idx, genre in enumerate(genres)}

    tempos = [song["tempo"] for song in catalog if song.get("tempo") is not None]
    tempo_median = float(statistics.median(tempos)) if tempos else 0.0
    filled_tempos = [float(song["tempo"]) if song.get("tempo") is not None else tempo_median for song in catalog]
    tempo_min = min(filled_tempos) if filled_tempos else 0.0
    tempo_max = max(filled_tempos) if filled_tempos else 0.0
    tempo_range = tempo_max - tempo_min

    vectors = []
    for song, tempo_value in zip(catalog, filled_tempos):
        vector = [0.0] * (len(artists) + len(genres) + 2)
        vector[artist_index[song.get("artist", "") or ""]] = 1.0
        vector[len(artists) + genre_index[song.get("genre", "") or ""]] = 1.0
        vector[-2] = 0.0 if tempo_range == 0 else (tempo_value - tempo_min) / tempo_range
        vector[-1] = float(song.get("energy") or 0.0)
        vectors.append(vector)

    if np is not None:
        return np.array(vectors, dtype=float), catalog
    return vectors, catalog


def get_similar_songs(song_id, limit=5):
    song_id = str(song_id or "").strip()
    if not song_id:
        return []

    matrix, catalog = _build_feature_matrix(_read_catalog())
    if (np is not None and getattr(matrix, "size", 0) == 0) or (np is None and not matrix):
        return []

    index_by_id = {song["id"]: idx for idx, song in enumerate(catalog)}
    target_index = index_by_id.get(song_id)
    if target_index is None:
        return []

    target_vector = matrix[target_index]
    if np is not None:
        target_norm = np.linalg.norm(target_vector)
    else:
        target_norm = sum(value * value for value in target_vector) ** 0.5
    if target_norm == 0:
        return []

    if np is not None:
        norms = np.linalg.norm(matrix, axis=1)
        safe_denominator = norms * target_norm
        similarities = np.divide(
            matrix @ target_vector,
            safe_denominator,
            out=np.zeros_like(norms),
            where=safe_denominator != 0,
        )
    else:
        similarities = []
        for vector in matrix:
            norm = sum(value * value for value in vector) ** 0.5
            denominator = norm * target_norm
            if denominator == 0:
                similarities.append(0.0)
            else:
                dot_product = sum(left * right for left, right in zip(vector, target_vector))
                similarities.append(dot_product / denominator)

    ranked = []
    for idx, similarity in enumerate(similarities):
        candidate_id = catalog[idx]["id"]
        if candidate_id == song_id:
            continue
        ranked.append((candidate_id, float(similarity)))

    ranked.sort(key=lambda item: (-item[1], item[0]))
    return [candidate_id for candidate_id, _ in ranked[: max(0, int(limit))]]
