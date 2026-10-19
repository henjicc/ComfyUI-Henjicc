import importlib
from pathlib import Path
import sys
import types
import unittest

package = types.ModuleType("henjicc_presets_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
presets = importlib.import_module(package.__name__ + ".image.generation_presets")


class PresetTests(unittest.TestCase):
    def test_super_input_presets_keep_requirements_and_own_connected_size(self):
        for key in ("character_card", "three_views"):
            config = presets.PRESETS[key]
            self.assertIn("红色夹克", config["template"].format(prompt="红色夹克"))
            for mode in ("custom", "preset", "reference"):
                result = presets.resolution(mode=mode, width=768, height=1024,
                                            preset=config, megapixels=4.3)
                self.assertEqual((result["width"], result["height"], result["source"]),
                                 (config["width"], config["height"], "preset"))

    def test_anime_preset_leaves_reference_budget_and_alignment_to_the_board(self):
        settings = dict(mode="reference", profile="general", megapixels=1.23,
                        alignment="16", image_size=[1900, 1100])
        self.assertEqual(presets.resolution(**settings, preset=presets.PRESETS["anime_to_realistic"]),
                         presets.resolution(**settings))
        self.assertEqual(presets.resolution(mode="custom", width=768, height=512,
                                           preset=presets.PRESETS["anime_to_realistic"])["source"], "custom")




    def test_empty_or_disconnected_preset_restores_board_source(self):
        for preset in (None, {"width": None, "height": None}):
            for mode in ("preset", "custom"):
                result = presets.resolution(mode=mode, width=768, height=1024, preset=preset)
                self.assertEqual((result["width"], result["height"], result["source"]), (768, 1024, "custom"))
            result = presets.resolution(mode="reference", image_size=[1024, 1024], megapixels=1.048576, preset=preset)
            self.assertEqual((result["width"], result["height"], result["source"]), (1024, 1024, "reference"))

    def test_reference_budget_and_project_guardrail(self):
        result = presets.resolution(mode="reference", image_size=[1920, 1080], megapixels=1)
        self.assertLess(abs(result["width"] / result["height"] - 16 / 9), .05)
        result = presets.resolution(width=8192, height=8192)
        self.assertLessEqual(result["width"] * result["height"], 4_300_000)
        self.assertTrue(result["adjusted"])
        with self.assertRaises(ValueError):
            presets.resolution(width=8192, height=8192, fit=False)

    def test_invalid_values_fail_instead_of_silently_falling_back(self):
        for settings in ({"width": True}, {"height": 0}, {"megapixels": float("nan")},
                         {"profile": "unknown"}, {"preset": {"width": 1024}},
                         {"mode": "reference"}, {"fit": "false"}):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                presets.resolution(**settings)

    def test_budget_is_an_upper_limit_in_manual_and_preset_modes(self):
        for settings in ({"width": 2048, "height": 2048}, {"preset": {"width": 2048, "height": 2048}}):
            result = presets.resolution(megapixels=1, **settings)
            self.assertLessEqual(result["width"] * result["height"], 1_000_000)
            self.assertEqual(result["budget_pixels"], 1_000_000)
        result = presets.resolution(width=512, height=512, megapixels=1)
        self.assertEqual((result["width"], result["height"]), (512, 512))
        with self.assertRaises(ValueError):
            presets.resolution(width=2048, height=2048, megapixels=1, fit=False)

    def test_selected_alignment_and_model_minimum(self):
        for alignment in ("2", "8", "16", "32"):
            result = presets.resolution(profile="general", alignment=alignment, width=1010, height=719, megapixels=1)
            self.assertEqual(result["width"] % int(alignment), 0)
            self.assertEqual(result["height"] % int(alignment), 0)
            self.assertEqual(result["grid"], int(alignment))
        self.assertEqual(presets.resolution(alignment="2")["grid"], 32)
        with self.assertRaises(ValueError):
            presets.resolution(alignment="3")

    def test_extreme_aspects_and_reference_rounding_do_not_exceed_budget(self):
        for size in ([4096, 32], [32, 4096], [1900, 1100], [1, 60000]):
            for budget in (.01, 1, 2.36):
                result = presets.resolution(mode="reference", image_size=size, megapixels=budget)
                self.assertLessEqual(result["width"] * result["height"], budget * 1_000_000)
                self.assertEqual(result["width"] % 32, 0)
                self.assertEqual(result["height"] % 32, 0)


if __name__ == "__main__":
    unittest.main()
