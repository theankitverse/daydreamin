import importlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone


class RecommendationModuleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["BITSONGS_TALLY_PATH"] = os.path.join(self.temp_dir.name, "tally_counter.json")
        os.environ["BITSONGS_SONGS_PATH"] = os.path.join(self.temp_dir.name, "songs.json")

        import recommendation.behavior as behavior
        import recommendation.content as content
        import recommendation.engine as engine
        import recommendation.storage as storage

        self.storage = importlib.reload(storage)
        self.content = importlib.reload(content)
        self.behavior = importlib.reload(behavior)
        self.engine = importlib.reload(engine)

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("BITSONGS_TALLY_PATH", None)
        os.environ.pop("BITSONGS_SONGS_PATH", None)

    def seed_catalog(self):
        songs = [
            {
                "id": "song_1",
                "title": "Alpha",
                "artist": "Artist A",
                "genre": "synthwave",
                "tempo": 170,
                "energy": 0.8,
                "cover": "",
                "cover_xl": "",
                "album": "Album A",
                "duration": 210,
            },
            {
                "id": "song_2",
                "title": "Beta",
                "artist": "Artist A",
                "genre": "synthwave",
                "tempo": 168,
                "energy": 0.75,
                "cover": "",
                "cover_xl": "",
                "album": "Album A",
                "duration": 200,
            },
            {
                "id": "song_3",
                "title": "Gamma",
                "artist": "Artist B",
                "genre": "rock",
                "tempo": 110,
                "energy": 0.4,
                "cover": "",
                "cover_xl": "",
                "album": "Album B",
                "duration": 195,
            },
            {
                "id": "song_4",
                "title": "Delta",
                "artist": "Artist C",
                "genre": "ambient",
                "tempo": 90,
                "energy": 0.1,
                "cover": "",
                "cover_xl": "",
                "album": "Album C",
                "duration": 220,
            },
        ]
        self.content.upsert_song_records(songs)

    def test_update_transition_keeps_top_three_and_caps_song_history(self):
        self.behavior.update_transition("song_a", "song_b")
        self.behavior.update_transition("song_a", "song_c")
        self.behavior.update_transition("song_a", "song_d")
        self.behavior.update_transition("song_a", "song_e")
        self.behavior.update_transition("song_a", "song_b")

        data = self.storage.load_tally_data()
        self.assertEqual(list(data["transitions"]["song_a"].keys()), ["song_b", "song_c", "song_d"])

        for index in range(52):
            self.behavior.update_transition(f"source_{index}", f"target_{index}")

        capped = self.storage.load_tally_data()
        self.assertEqual(len(capped["_meta"]["song_order"]), 50)
        self.assertNotIn("source_0", capped["transitions"])

    def test_decay_removes_zero_value_transitions(self):
        old_timestamp = (datetime.now(timezone.utc) - timedelta(days=7)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        self.storage.save_tally_data(
            {
                "_meta": {"last_decay_at": old_timestamp, "song_order": ["song_a"]},
                "transitions": {"song_a": {"song_b": 10, "song_c": 1}},
            }
        )

        recommendations = self.behavior.get_behavior_recommendations("song_a")
        self.assertEqual(recommendations, ["song_b"])

        data = self.storage.load_tally_data()
        self.assertEqual(data["transitions"]["song_a"]["song_b"], 5)
        self.assertNotIn("song_c", data["transitions"]["song_a"])

    def test_content_similarity_and_up_next_prioritize_behavior(self):
        self.seed_catalog()
        self.behavior.update_transition("song_1", "song_3")
        self.behavior.update_transition("song_1", "song_3")
        self.behavior.update_transition("song_1", "song_2")

        similar = self.content.get_similar_songs("song_1")
        self.assertEqual(similar[0], "song_2")
        self.assertNotIn("song_1", similar)

        combined = self.engine.get_recommendations("song_1")
        self.assertEqual(combined["behavior_based"], ["song_3", "song_2"])
        self.assertNotIn("song_3", combined["content_based"])

        up_next = self.engine.get_up_next("song_1", limit=3)
        self.assertEqual(up_next[0], {"song_id": "song_3", "reason": "behavior"})
        self.assertEqual(up_next[1], {"song_id": "song_2", "reason": "behavior"})
        self.assertTrue(all(entry["song_id"] != "song_1" for entry in up_next))


if __name__ == "__main__":
    unittest.main()
