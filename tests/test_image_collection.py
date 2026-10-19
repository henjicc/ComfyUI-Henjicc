import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from PIL import Image
import torch

# Load the actual processing module without starting ComfyUI's server entrypoint.
package = types.ModuleType("henjicc_test_package")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
collection = importlib.import_module("henjicc_test_package.image.image_collection")


class ImageCollectionTests(unittest.TestCase):
    def test_reference_resize_alignment_and_preallocation_limits(self):
        source = torch.ones(1, 45, 71, 4)
        unchanged = collection.resize_references([source], 0, "1")
        self.assertIs(unchanged[0], source)
        for grid in ("2", "8", "16", "32", "64"):
            result = collection.resize_references([source], .01, grid)[0]
            self.assertEqual(result.shape[1] % int(grid), 0)
            self.assertEqual(result.shape[2] % int(grid), 0)
        torch.testing.assert_close(source, torch.ones_like(source))
        for budget, grid in ((-1, "32"), (float("nan"), "32"), (33, "32"), (1, "3")):
            with self.assertRaises(ValueError):
                collection.resize_references([source], budget, grid)
        import comfy.utils
        with patch.object(comfy.utils, "common_upscale") as upscale:
            with self.assertRaisesRegex(ValueError, "Total pixels"):
                collection.resize_references([source] * 2, 32)
            upscale.assert_not_called()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        Image.new("RGB", (8, 4), "red").save(self.root / "red.png")
        Image.new("RGBA", (4, 8), (0, 255, 0, 128)).save(self.root / "透明.png")
        self.state = {"version": 1, "items": [
            {"id": "a", "path": "red.png", "enabled": True},
            {"id": "b", "path": "透明.png", "enabled": True}], "current": "b"}

    def load(self):
        return collection.load_collection(self.root, json.dumps(self.state))

    def test_order_current_alpha_and_disabled_missing_file(self):
        images, current = self.load()
        self.assertEqual([i.path for i in images], ["red.png", "透明.png"])
        self.assertEqual(tuple(images[0].image.shape), (1, 4, 8, 3))
        self.assertEqual(tuple(current.mask.shape), (1, 8, 4))
        self.assertTrue(torch.allclose(current.mask, torch.full_like(current.mask, 127 / 255)))
        self.assertEqual(images[0].mask.sum(), 0)
        self.state["items"][1].update(enabled=False, path="missing.png")
        images, current = self.load()
        self.assertEqual(len(images), 1)
        self.assertEqual(current.id, "a")

    def test_list_preserves_sizes_and_batch_pads_mask(self):
        images, _ = self.load()
        originals = [i.image.clone() for i in images]
        result, masks = collection.convert_collection(images, "list", "first", 8, 4, "contain", "#000000")
        self.assertEqual([tuple(i.shape) for i in result], [(1, 4, 8, 3), (1, 8, 4, 3)])
        result, masks = collection.convert_collection(images, "batch", "first", 8, 4, "contain", "#0000ff")
        self.assertEqual(tuple(result[0].shape), (2, 4, 8, 3))
        self.assertEqual(tuple(masks[0].shape), (2, 4, 8))
        self.assertTrue(torch.equal(result[0][1, :, 0], torch.tensor([0., 0., 1.]).expand(4, 3)))
        self.assertTrue(torch.equal(masks[0][1, :, 0], torch.ones(4)))
        self.assertTrue(torch.allclose(masks[0][1, :, 3:5], torch.full((4, 2), 127 / 255)))
        for image, original in zip(images, originals):
            self.assertTrue(torch.equal(image.image, original))

    def test_crop_custom_and_exif_orientation(self):
        images, _ = self.load()
        result, masks = collection.convert_collection(images, "batch", "custom", 6, 6, "crop", "#ffffff")
        self.assertEqual(tuple(result[0].shape), (2, 6, 6, 3))
        self.assertTrue(torch.allclose(masks[0][1], torch.full((6, 6), 127/255)))
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (8, 4)).save(self.root / "rotate.jpg", exif=exif)
        self.state["items"][0]["path"] = "rotate.jpg"
        self.assertEqual(tuple(self.load()[0][0].image.shape), (1, 8, 4, 3))

    def test_reject_invalid_missing_animated_and_budget(self):
        for value in ["{", "[]", '{"version":2,"items":[]}', json.dumps({**self.state, "current": []})]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                collection.parse_state(value)
        for path in ["../red.png", "missing.png", "broken.png", "animation.gif"]:
            (self.root / "broken.png").write_bytes(b"invalid")
            Image.new("RGB", (4, 4), "red").save(self.root / "animation.gif", save_all=True, append_images=[Image.new("RGB", (4, 4), "blue")])
            self.state["items"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.load()
        self.state["items"][0]["path"] = "red.png"
        with patch.object(collection, "MAX_PIXELS", 40), self.assertRaises(ValueError):
            self.load()
        for item in self.state["items"]:
            item["enabled"] = False
        with self.assertRaisesRegex(ValueError, "Enable at least"):
            self.load()

    def test_file_replacement_invalidates_fingerprint(self):
        value = json.dumps(self.state)
        before = collection.fingerprint(self.root, value)
        Image.new("RGB", (8, 4), "blue").save(self.root / "red.png")
        self.assertNotEqual(before, collection.fingerprint(self.root, value))

    def test_more_than_ten_images_and_batch_allocation_budget(self):
        self.state["items"] = [{"id": str(i), "path": "red.png", "enabled": True} for i in range(12)]
        self.state["current"] = "11"
        images, current = self.load()
        self.assertEqual(len(images), 12)
        self.assertEqual(current.id, "11")
        with self.assertRaisesRegex(ValueError, "Total pixels"):
            collection.convert_collection(images, "batch", "custom", 4096, 4096, "contain", "#000000")
