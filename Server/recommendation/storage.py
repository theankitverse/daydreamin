import json
import math
import os
from datetime import datetime, timedelta, timezone
from tempfile import NamedTemporaryFile


BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DEFAULT_TALLY_PATH = os.path.join(DATA_DIR, "tally_counter.json")

MAX_STORED_SONGS = 50
MAX_TRANSITIONS_PER_SONG = 3
DECAY_INTERVAL = timedelta(days=7)
DECAY_FACTOR = 0.5


def _utc_now():
    return datetime.now(timezone.utc)


def _to_iso8601(value):
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _from_iso8601(value):
    if not value:
        return _utc_now()
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def get_tally_path():
    return os.environ.get("BITSONGS_TALLY_PATH", DEFAULT_TALLY_PATH)


def ensure_data_dir():
    os.makedirs(os.path.dirname(get_tally_path()), exist_ok=True)


def default_tally_data():
    return {
        "_meta": {
            "last_decay_at": _to_iso8601(_utc_now()),
            "song_order": [],
        },
        "transitions": {},
    }


def _normalize_data(data):
    normalized = default_tally_data()
    if isinstance(data, dict):
        meta = data.get("_meta", {})
        transitions = data.get("transitions", {})
        if isinstance(meta, dict):
            last_decay_at = meta.get("last_decay_at")
            song_order = meta.get("song_order", [])
            normalized["_meta"]["last_decay_at"] = last_decay_at or normalized["_meta"]["last_decay_at"]
            normalized["_meta"]["song_order"] = [str(song_id) for song_id in song_order if song_id]
        if isinstance(transitions, dict):
            for source_id, targets in transitions.items():
                source_id = str(source_id)
                if not source_id or not isinstance(targets, dict):
                    continue
                normalized_targets = {}
                for target_id, count in targets.items():
                    try:
                        integer_count = int(count)
                    except (TypeError, ValueError):
                        continue
                    if integer_count > 0:
                        normalized_targets[str(target_id)] = integer_count
                if normalized_targets:
                    normalized["transitions"][source_id] = normalized_targets
    return normalized


def load_tally_data():
    ensure_data_dir()
    path = get_tally_path()
    if not os.path.exists(path):
        data = default_tally_data()
        save_tally_data(data)
        return data

    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw_data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        raw_data = default_tally_data()

    data = _normalize_data(raw_data)
    return cleanup_tally_data(data)


def save_tally_data(data):
    ensure_data_dir()
    path = get_tally_path()
    directory = os.path.dirname(path)
    cleaned = cleanup_tally_data(data)
    with NamedTemporaryFile("w", delete=False, dir=directory, encoding="utf-8") as handle:
        json.dump(cleaned, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_path = handle.name
    os.replace(temp_path, path)


def apply_decay_if_needed(data, now=None):
    now = now or _utc_now()
    meta = data["_meta"]
    last_decay_at = _from_iso8601(meta.get("last_decay_at"))
    elapsed = now - last_decay_at
    intervals = int(elapsed.total_seconds() // DECAY_INTERVAL.total_seconds())
    if intervals <= 0:
        return data

    multiplier = DECAY_FACTOR ** intervals
    transitions = data.get("transitions", {})
    for source_id, target_map in list(transitions.items()):
        for target_id, count in list(target_map.items()):
            decayed_count = math.floor(count * multiplier)
            if decayed_count <= 0:
                del target_map[target_id]
            else:
                target_map[target_id] = decayed_count
        if not target_map:
            del transitions[source_id]

    meta["last_decay_at"] = _to_iso8601(last_decay_at + (DECAY_INTERVAL * intervals))
    return cleanup_tally_data(data)


def cleanup_tally_data(data):
    meta = data.setdefault("_meta", {})
    transitions = data.setdefault("transitions", {})

    meta["last_decay_at"] = meta.get("last_decay_at") or _to_iso8601(_utc_now())
    song_order = [str(song_id) for song_id in meta.get("song_order", []) if song_id]

    cleaned_transitions = {}
    for source_id, target_map in list(transitions.items()):
        if not isinstance(target_map, dict):
            continue
        normalized_targets = []
        for target_id, count in target_map.items():
            try:
                integer_count = int(count)
            except (TypeError, ValueError):
                continue
            target_id = str(target_id)
            if integer_count > 0 and target_id:
                normalized_targets.append((target_id, integer_count))
        normalized_targets.sort(key=lambda item: (-item[1], item[0]))
        top_targets = dict(normalized_targets[:MAX_TRANSITIONS_PER_SONG])
        if top_targets:
            cleaned_transitions[str(source_id)] = top_targets

    transitions.clear()
    transitions.update(cleaned_transitions)

    song_order = [song_id for song_id in song_order if song_id in transitions]
    for source_id in transitions:
        if source_id not in song_order:
            song_order.append(source_id)

    while len(song_order) > MAX_STORED_SONGS:
        evicted_song = song_order.pop(0)
        transitions.pop(evicted_song, None)
        for source_id in list(transitions.keys()):
            transitions[source_id].pop(evicted_song, None)
            if not transitions[source_id]:
                del transitions[source_id]
                if source_id in song_order:
                    song_order.remove(source_id)

    meta["song_order"] = song_order
    return data
