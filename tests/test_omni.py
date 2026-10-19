import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

import av
import numpy as np
from PIL import Image

package = types.ModuleType("henjicc_omni_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
omni = importlib.import_module("henjicc_omni_test.text.omni")
media = importlib.import_module("henjicc_omni_test.media.media")


class OmniInputsTests(unittest.TestCase):
    def test_model_selection_stays_in_configured_roots(self):
        import folder_paths
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("Qwen2.5-Omni-3B", "Qwen2.5-Omni-7B"):
                directory = root / "LLM" / name
                directory.mkdir(parents=True)
                (directory / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"weight": "weights.safetensors"}}))
                (directory / "weights.safetensors").touch()
                (directory / "spk_dict.pt").touch()
            with patch.object(folder_paths, "models_dir", str(root)), patch.object(folder_paths, "get_folder_paths", return_value=[]):
                self.assertEqual(omni.find_model().name, "Qwen2.5-Omni-3B")
                self.assertEqual(omni.find_model("Qwen2.5-Omni-7B").name, "Qwen2.5-Omni-7B")
                with self.assertRaises(ValueError): omni.find_model("../outside")
                (root / "LLM/Qwen2.5-Omni-7B/weights.safetensors").unlink()
                with self.assertRaises(ValueError): omni.find_model("Qwen2.5-Omni-7B")

    def test_joint_media_preserves_labels_and_bounds_decoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("RGB", (100, 200), "red").save(root / "image.png")
            with wave.open(str(root / "tone.wav"), "wb") as f:
                f.setnchannels(1)
                f.setsampwidth(2)
                f.setframerate(16000)
                f.writeframes(np.zeros(64000, dtype=np.int16).tobytes())
            with av.open(str(root / "video.mp4"), "w") as container:
                stream = container.add_stream("mpeg4", rate=30)
                stream.width = 64
                stream.height = 32
                stream.pix_fmt = "yuv420p"
                for i in range(90):
                    frame = av.VideoFrame.from_ndarray(np.full((32, 64, 3), i, dtype=np.uint8), format="rgb24")
                    for packet in stream.encode(frame): container.mux(packet)
                for packet in stream.encode(): container.mux(packet)
            state = media.parse_media(json.dumps({"version": 1, "profile": "general", "items": [
                {"id": "v", "path": "video.mp4"}, {"id": "i", "path": "image.png"},
                {"id": "a", "path": "tone.wav"}], "prompt": ["参考", {"ref": "i"}, "和", {"ref": "v"}]}))
            content, images, videos, audio = omni.prepare_inputs(root, state, 2)
            self.assertEqual([x["type"] for x in content], ["text", "video", "text", "image", "text", "audio", "text"])
            self.assertEqual(content[-1]["text"], "参考<image1>和<video1>")
            self.assertEqual(images[0].size, (100, 200))
            self.assertEqual(videos[0].shape, (4, 32, 64, 3))
            self.assertEqual(audio[0].shape, (32000,))

    def test_invalid_media_is_not_silently_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("RGB", (32, 32)).save(root / "image.png")
            state = {"profile": "general", "items": [{"id": "i", "path": "image.png", "soundtrack": True}], "prompt": []}
            self.assertEqual(len(omni.prepare_inputs(root, state, 2)[1]), 1)
            state["items"][0]["path"] = "../outside.png"
            with self.assertRaises(ValueError): omni.prepare_inputs(root, state, 2)
            state["items"] *= 9
            with self.assertRaises(ValueError): omni.prepare_inputs(root, state, 2)


if __name__ == "__main__":
    unittest.main()
