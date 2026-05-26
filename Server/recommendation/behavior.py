from .storage import apply_decay_if_needed, cleanup_tally_data, load_tally_data, save_tally_data


def update_transition(previous_song_id, current_song_id):
    previous_song_id = str(previous_song_id or "").strip()
    current_song_id = str(current_song_id or "").strip()
    if not previous_song_id or not current_song_id or previous_song_id == current_song_id:
        return

    data = apply_decay_if_needed(load_tally_data())
    transitions = data.setdefault("transitions", {})
    source_targets = transitions.setdefault(previous_song_id, {})
    source_targets[current_song_id] = int(source_targets.get(current_song_id, 0)) + 1

    song_order = data.setdefault("_meta", {}).setdefault("song_order", [])
    if previous_song_id in song_order:
        song_order.remove(previous_song_id)
    song_order.append(previous_song_id)

    save_tally_data(cleanup_tally_data(data))


def get_behavior_recommendations(song_id, limit=5):
    song_id = str(song_id or "").strip()
    if not song_id:
        return []

    data = apply_decay_if_needed(load_tally_data())
    save_tally_data(data)

    target_map = data.get("transitions", {}).get(song_id, {})
    ordered_targets = sorted(target_map.items(), key=lambda item: (-int(item[1]), item[0]))
    return [target_id for target_id, _ in ordered_targets[: max(0, int(limit))]]
