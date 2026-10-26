import runpy, unittest

# 2人同時の台詞の組の行は、2人の声が同じ時刻に混ざる。話者の続きの点検は、その行を
# 声の基準にも境目の照合にも使わない。
continuity = runpy.run_path("scripts/audit-manga-speaker-continuity.py")


def utterance(uid, speaker, start, group=None):
    timing = {"audioStartInCutSeconds": start}
    if group:
        timing["simultaneousGroupId"] = group
    return {"id": uid, "cutId": "cut-1", "speakerName": speaker, "timing": timing,
            "audio": {"speechStartSeconds": 0.1, "speechEndSeconds": 0.9}}


class SimultaneousSpeakerContinuity(unittest.TestCase):
    def test_simultaneous_group_lines_are_not_single_voice_windows(self):
        manifest = {
            "cuts": [{"id": "cut-1", "timing": {"startSeconds": 10.0}}],
            "utterances": [
                utterance("u0", "c", 0.0),
                utterance("u1", "a", 2.0, group="u1"),
                utterance("u2", "b", 2.0, group="u1"),
                utterance("u3", "a", 4.0),
            ],
        }
        rows = continuity["utterance_windows"](manifest)
        self.assertEqual([row["id"] for row in rows], ["u0", "u3"])

    def test_lines_without_a_group_are_unchanged(self):
        manifest = {
            "cuts": [{"id": "cut-1", "timing": {"startSeconds": 0.0}}],
            "utterances": [utterance("u0", "c", 0.0), utterance("u1", "a", 1.0)],
        }
        rows = continuity["utterance_windows"](manifest)
        self.assertEqual([row["id"] for row in rows], ["u0", "u1"])
        self.assertAlmostEqual(rows[1]["speechStartSeconds"], 1.1)


if __name__ == "__main__":
    unittest.main()
