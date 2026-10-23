import runpy, unittest
from unittest.mock import patch
import numpy as np

m = runpy.run_path("scripts/audit-voice-quality.py")
f = m["check_voice_quality"]
g = f.__globals__
stt = runpy.run_path("scripts/audit-manga-stt-verification.py")


def tone(seconds, amplitude, sr=16000):
    t = np.arange(int(seconds * sr)) / sr
    return np.sin(2 * np.pi * 220 * t) * amplitude


class NonverbalSegments(unittest.TestCase):
    def run_check(self, audio):
        with patch.dict(g, {
            "load_audio": lambda path: (audio, 16000, float(np.abs(audio).max() or 0.0)),
            "speech_spans": lambda *args: [(0., len(audio) / 16000)],
            "f0_semitone_std": lambda *args: (3., .8),
            "integrated_lufs": lambda *args: -23.,
            "transcribe": lambda clip: (_ for _ in ()).throw(AssertionError("nonverbal must not be transcribed")),
        }):
            return f({"audio": __file__, "computeUtmos": False,
                      "segments": [{"id": "u1", "start": 0., "end": 1., "expectedText": "っ!", "nonverbal": True}]})

    def test_voiced_nonverbal_passes_without_cer(self):
        result = self.run_check(np.concatenate([np.zeros(4000), tone(.4, .3), np.zeros(4000)]))
        row = result["metrics"]["segments"][0]
        self.assertTrue(row["nonverbal"])
        self.assertTrue(row["nonverbalVoiced"])
        self.assertNotIn("cer", row)
        self.assertNotIn("moraPerSec", row)
        self.assertFalse(any("nonverbal" in p for p in result["problems"]))

    def test_silent_nonverbal_fails(self):
        result = self.run_check(np.zeros(16000))
        row = result["metrics"]["segments"][0]
        self.assertFalse(row["nonverbalVoiced"])
        self.assertTrue(any("nonverbal[u1] silent" in p for p in result["problems"]))
        self.assertEqual(result["status"], "fail")

    def test_empty_reading_without_mark_is_unavailable_not_a_crash(self):
        audio = tone(1., .3)
        with patch.dict(g, {
            "load_audio": lambda path: (audio, 16000, .3),
            "speech_spans": lambda *args: [(0., 1.)],
            "f0_semitone_std": lambda *args: (3., .8),
            "integrated_lufs": lambda *args: -23.,
            "transcribe": lambda clip: "はっ",
        }):
            result = f({"audio": __file__, "computeUtmos": False,
                        "segments": [{"id": "u1", "start": 0., "end": 1., "expectedText": "!"}]})
        self.assertNotIn("cer", result["metrics"]["segments"][0])
        self.assertTrue(any("expected reading is empty" in u for u in result["unavailable"]))


class SttNonverbal(unittest.TestCase):
    def test_symbol_only_lines_are_nonverbal(self):
        for text in ["！", "…", "…ッ！", "？", "！？"]:
            self.assertTrue(stt["is_nonverbal_text"](text), text)
        for text in ["う…", "くっ…！", "そ、それは…", ""]:
            self.assertFalse(stt["is_nonverbal_text"](text), text)


unittest.main()
