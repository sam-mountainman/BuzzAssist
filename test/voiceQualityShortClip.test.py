import runpy, unittest, tempfile, json
from pathlib import Path
from unittest.mock import patch
import numpy as np

m = runpy.run_path("scripts/audit-voice-quality.py")
f = m["check_voice_quality"]
g = f.__globals__

class ShortClipRegression(unittest.TestCase):
    def test_short_loudness_failure_preserves_other_metrics_and_next_check(self):
        with patch.dict(g, {
            "load_audio": lambda path: (np.ones(3200) * .1, 16000, .1),
            "speech_spans": lambda *args: [(0., .2)],
            "f0_semitone_std": lambda *args: (3., .8),
            "integrated_lufs": lambda *args: (_ for _ in ()).throw(ValueError("Audio must have length greater than the block size.")),
        }):
            short = f({"audio": __file__, "computeUtmos": False})
            required = f({"audio": __file__, "computeUtmos": False, "loudness": {"target": -14}})
        self.assertEqual(short["status"], "warn")
        self.assertEqual(required["status"], "fail")
        self.assertIn("required loudness measurement unavailable", required["problems"])
        self.assertEqual(short["metrics"]["durationSec"], .2)
        self.assertTrue(any("loudness:" in x for x in short["unavailable"]))
        self.assertEqual(short["problems"], [])
        self.assertFalse(any("pyloudnorm missing" in x for x in short["unavailable"]))
        with patch.dict(g, {
            "load_audio": lambda path: (np.ones(48000) * .1, 16000, .1),
            "speech_spans": lambda *args: [(0., 3.)],
            "f0_semitone_std": lambda *args: (3., .8),
            "integrated_lufs": lambda *args: -23.,
        }):
            normal = f({"audio": __file__, "computeUtmos": False})
        self.assertEqual(normal["status"], "pass")
        self.assertEqual(normal["metrics"]["lufs"], -23.)

class CacheRegression(unittest.TestCase):
    def test_cache_binds_input_config_runtime_and_preserves_failures(self):
        with tempfile.TemporaryDirectory() as d:
            audio = Path(d)/"input.wav"
            audio.write_bytes(b"original")
            check={"id":"one", "type":"voiceQuality", "audio":str(audio), "expectedText":"read A"}
            calls=[]
            def handler(c):
                calls.append(c.copy())
                return {"status":"fail", "metrics":{"cer":.8}, "problems":["reading mismatch"], "unavailable":[], "warnings":[]}
            run=lambda c=check,e="runtime-one":m["cached_check"](c,handler,Path(d)/"cache",e)
            self.assertEqual(run()["status"],"fail")
            self.assertEqual(run()["status"],"fail")
            self.assertEqual(len(calls),1)
            run({**check,"expectedText":"read B"}); self.assertEqual(len(calls),2)
            run(e="runtime-two"); self.assertEqual(len(calls),3)
            audio.write_bytes(b"different");run();self.assertEqual(len(calls),4)
            for f in (Path(d)/"cache").glob("*.json"): f.write_text("partial")
            run();self.assertEqual(len(calls),5)
    def test_nonfinite_is_unavailable_and_not_cached(self):
        with tempfile.TemporaryDirectory() as d:
            audio=Path(d)/"input.wav";audio.write_bytes(b"audio")
            check={"id":"one","type":"voiceQuality","audio":str(audio)}
            r=m["cached_check"](check,lambda c:{"status":"pass","metrics":{"lufs":float("-inf")},"unavailable":[]},Path(d)/"cache","env")
            self.assertEqual(r["status"],"fail")
            self.assertIsNone(r["metrics"]["lufs"])
            json.dumps(r,allow_nan=False)
            self.assertFalse((Path(d)/"cache").exists())

unittest.main()
