import runpy
import unittest


qa = runpy.run_path("scripts/audit-voice-quality.py")
reading = qa["to_katakana_reading"]
cer = qa["reading_error_rate"]


class NumeralReadingRegression(unittest.TestCase):
    def test_asr_digit_spelling_does_not_create_reading_errors(self):
        for expected, actual in (
            ("しかし、この一週間後。", "しかしこの1週間後"),
            ("ななじゅうよんさい。", "74歳"),
            ("三十八歳でした。", "38歳でした"),
            ("二十日", "20日"),
            ("三月", "３月"),
        ):
            with self.subTest(expected=expected, actual=actual):
                self.assertEqual(cer(expected, "", actual), 0)

    def test_wrong_number_and_missing_number_still_fail(self):
        self.assertGreater(cer("一週間", "", "2週間"), .13)
        self.assertGreater(cer("七十四歳", "", "47歳"), .13)
        self.assertGreater(cer("七十四歳", "", "歳"), .13)

    def test_explicit_confirmed_reading_is_not_replaced_by_dictionary(self):
        self.assertEqual(cer("七十四歳", "ナナジュウヨンサイ", "74歳"), 0)
        self.assertGreater(cer("七十四歳", "シチジュウヨンサイ", "74歳"), 0)

    def test_numeric_information_is_preserved(self):
        self.assertEqual(qa["japanese_integer_surface"]("10002"), "一万二")
        self.assertEqual(qa["japanese_integer_surface"]("2026"), "二千二十六")
        self.assertEqual(qa["japanese_integer_surface"]("007"), "〇〇七")
        self.assertNotEqual(reading("1.25倍"), reading("1.52倍"))


unittest.main()
