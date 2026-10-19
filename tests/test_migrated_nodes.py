import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import av
import numpy as np
import torch

package = types.ModuleType("henjicc_migration_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
video = importlib.import_module(package.__name__ + ".video.video_preprocessing")
music = importlib.import_module(package.__name__ + ".audio.music")


class MigrationTests(unittest.TestCase):


    def test_video_resampling_short_padding_trim_and_pixel_budget(self):
        # Frames carry timestamps and distinct grey values: nearest-frame choice is observable.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "短视频.mp4"
            with av.open(str(path), "w") as container:
                stream = container.add_stream("libx264", rate=12)
                stream.width, stream.height, stream.pix_fmt = 96, 64, "yuv420p"
                for i in range(12):
                    frame = av.VideoFrame.from_ndarray(np.full((64, 96, 3), i * 20, np.uint8), format="rgb24")
                    for packet in stream.encode(frame): container.mux(packet)
                for packet in stream.encode(): container.mux(packet)
            with patch.dict(sys.modules, {"comfy.model_management": types.SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None)}):
                # Import uses the real host package; only cancellation is isolated.
                import comfy
                with patch.object(comfy, "model_management", sys.modules["comfy.model_management"], create=True):
                    frames, w, h = video.normalize_source(str(path), .05)
                    self.assertEqual(frames.shape, (120, h, w, 3))
                    self.assertLessEqual(w * h, 50000)
                    self.assertAlmostEqual(frames[2].mean().item(), 20 / 255, delta=.02)
                    torch.testing.assert_close(frames[-1], frames[22])
                    adapter = importlib.import_module(package.__name__ + ".video.video_nodes")
                    from PIL import Image
                    Image.new("RGB", (32, 64), (255, 0, 0)).save(Path(tmp) / "character.png")
                    media = {"profile": "minimax_reference", "prompt": ["替换人物"], "items": [
                        {"id": "v", "path": path.name}, {"id": "i", "path": "character.png"}]}
                    with patch.object(adapter.folder_paths, "get_input_directory", return_value=tmp):
                        prepared = adapter.HenjiccH3RoleInputs.execute(media, .05).result
                        self.assertEqual(prepared[1:4], (w, h, 124))
                        torch.testing.assert_close(prepared[0][:120], frames)
                        torch.testing.assert_close(prepared[0][120:], frames[-1:].expand(4, -1, -1, -1))
                        torch.testing.assert_close(prepared[4], frames)
                        self.assertEqual(prepared[5].shape, (1, 64, 32, 3))
                        self.assertEqual(prepared[6], "替换人物")
                        for seconds in (4, 8, 15):
                            timed = adapter.HenjiccH3RoleInputs.execute(media, .05, seconds).result
                            self.assertEqual(timed[4].shape[0], seconds * 24)
                            self.assertEqual(timed[0].shape[0], timed[3])
                            self.assertEqual(timed[3] % 17, 5)
                            self.assertGreaterEqual(timed[3], seconds * 24)
                            self.assertLess(timed[3] - seconds * 24, 17)
                            torch.testing.assert_close(timed[0][-1], frames[-1])
                        for invalid in [[], media["items"] * 2, media["items"] + [{"path": "song.wav"}],
                                        [{"path": path.name, "soundtrack": True}]]:
                            with self.assertRaises(ValueError):
                                adapter.HenjiccH3RoleInputs.execute({"profile": "minimax_reference", "items": invalid}, .05)
                    trimmed, _, _ = video.normalize_source(str(path), .05, .5, .75)
                    self.assertGreater(trimmed[0].mean(), frames[0].mean())
                    self.assertLess(trimmed[-1].mean(), frames[-1].mean())
                    with self.assertRaisesRegex(ValueError, "outside the video"):
                        video.normalize_source(str(path), .05, 10)

    def test_h3_output_fps_preserves_duration_audio_and_native_timing(self):
        adapter = importlib.import_module(package.__name__ + ".video.video_nodes")
        for seconds in (1 / 24, 1, 2.5, 3, 4, 5, 6.375, 8, 15):
            count = round(seconds * 24)
            samples = round(count / 24 * 1000)
            frames = torch.arange(count + 17).float().view(-1, 1, 1, 1).expand(-1, 2, 2, 3)
            waveform = torch.linspace(-.1, .1, samples + 1000).reshape(1, 1, -1)
            audio = {"waveform": waveform, "sample_rate": 1000}
            clip = adapter.HenjiccH3VideoOutput.execute(frames, audio, seconds).result[0].get_components()
            self.assertEqual(clip.images.shape[0], count)
            self.assertEqual(clip.frame_rate, 24)
            torch.testing.assert_close(clip.audio["waveform"], waveform[..., :samples])
            torch.testing.assert_close(clip.images, frames[:count])
            self.assertEqual(waveform.shape[-1], samples + 1000)
        for seconds in (0, -1, 1 / 48, 16, float("nan"), float("inf"), True):
            with self.assertRaises(ValueError): adapter.HenjiccH3VideoOutput.execute(frames, audio, seconds)
        with self.assertRaisesRegex(ValueError, "Not enough generated frames"):
            adapter.HenjiccH3VideoOutput.execute(frames[:10], audio, 5)
        with self.assertRaisesRegex(ValueError, "Not enough generated audio"):
            adapter.HenjiccH3VideoOutput.execute(frames, {**audio, "waveform": waveform[..., :10]}, 5)
        self.assertEqual(video.canvas_size(1920, 1080, 1, 768), (1280, 768))
        self.assertEqual(video.canvas_size(1080, 1920, 1, 768), (768, 1280))
        self.assertEqual(video.canvas_size(2048, 2048, 1, 768), (768, 768))

    def test_h3_matches_source_duration_with_bounds_and_fractional_seconds(self):
        adapter = importlib.import_module(package.__name__ + ".video.video_nodes")
        with tempfile.TemporaryDirectory() as tmp:
            # One frame, short clips, fractional seconds, non-24-fps, and >15 s.
            for rate, count in ((24, 1), (24, 24), (24, 60), (24, 72), (24, 153), (30, 193), (24, 400)):
                with self.subTest(rate=rate, count=count):
                    path = Path(tmp) / f"参考-{rate}-{count}.mp4"
                    with av.open(str(path), "w") as container:
                        stream = container.add_stream("libx264", rate=rate)
                        stream.width, stream.height, stream.pix_fmt = 32, 32, "yuv420p"
                        for i in range(count):
                            frame = av.VideoFrame.from_ndarray(np.full((32, 32, 3), i % 220, np.uint8), format="rgb24")
                            for packet in stream.encode(frame): container.mux(packet)
                        for packet in stream.encode(): container.mux(packet)
                    media = {"profile": "minimax_reference", "prompt": ["替换角色"],
                             "items": [{"id": "v", "path": path.name}]}
                    with patch.object(adapter.folder_paths, "get_input_directory", return_value=tmp):
                        prepared = adapter.HenjiccH3RoleInputs.execute(media, .05, match_source_duration=True).result
                    expected = max(1, round(min(15, count / rate) * 24))
                    self.assertEqual(prepared[4].shape[0], expected)
                    self.assertEqual(prepared[7], expected / 24)
                    self.assertEqual(prepared[3] % 17, 5)
                    self.assertGreaterEqual(prepared[3], expected)
                    self.assertLess(prepared[3] - expected, 17)
                    torch.testing.assert_close(prepared[0][:expected], prepared[4])
                    if prepared[3] > expected:
                        torch.testing.assert_close(prepared[0][expected:], prepared[4][-1:].expand(prepared[3] - expected, -1, -1, -1))
                    audio = {"waveform": torch.zeros(1, 1, 16000), "sample_rate": 1000}
                    clip = adapter.HenjiccH3VideoOutput.execute(prepared[0], audio, prepared[7]).result[0].get_components()
                    self.assertEqual(clip.images.shape[0], expected)
                    self.assertEqual(clip.audio["waveform"].shape[-1], round(expected / 24 * 1000))

    def test_h3_multiple_images_keep_independent_shapes_order_and_reference_numbers(self):
        adapter = importlib.import_module(package.__name__ + ".video.video_nodes")
        distributor = importlib.import_module(package.__name__ + ".image.image_nodes")
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "source.mp4").touch()
            for i in range(10):
                Image.new("RGB", (32 + i * 8, 64), (i * 20, 0, 0)).save(root / f"image-{i}.png")
            for count in (0, 1, 2, 9):
                with self.subTest(count=count):
                    items = [{"id": f"i{i}", "path": f"image-{i}.png"} for i in range(count)]
                    items.insert(0 if count == 0 else 1, {"id": "v", "path": "source.mp4"})
                    prompt = [{"ref": f"i{i}"} for i in range(count)] + [{"ref": "v"}]
                    media = {"profile": "minimax_reference", "items": items, "prompt": prompt}
                    source = torch.zeros(120, 32, 32, 3)
                    with patch.object(adapter.folder_paths, "get_input_directory", return_value=tmp), \
                         patch.object(adapter, "normalize_source", return_value=(source, 32, 32)):
                        result = adapter.HenjiccH3RoleInputs.execute(media, .05).result
                    self.assertEqual(len(result[8]), count)
                    self.assertEqual(result[6], "".join(f"<Picture {i + 1}>" for i in range(count)) + "<Video 1>")
                    slots = distributor.HenjiccImageListToSlots.execute(result[8]).result
                    for i, image in enumerate(result[8]):
                        self.assertEqual(image.shape, (1, 64, 32 + i * 8, 3))
                        self.assertAlmostEqual(image[0, 0, 0, 0].item(), i * 20 / 255)
                        torch.testing.assert_close(slots[i], image)
                    self.assertTrue(all(x is None for x in slots[count:]))
                    if count:
                        torch.testing.assert_close(result[5], result[8][0])
                    else:
                        self.assertIsNone(result[5])
                    if count == 2:
                        # Exercise the real native conditioning implementation;
                        # only the heavyweight learned encoders are isolated.
                        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
                        class Clip:
                            def tokenize(self, prompt, **kwargs):
                                self.prompt, self.items = prompt, kwargs["minimax_ref_items"]
                                return {}
                            def encode_from_tokens_scheduled(self, tokens):
                                return [[torch.zeros(1, 1, 1), {}]]
                        class Vae:
                            def encode(self, image):
                                return torch.zeros(1, 24, 2, image.shape[1] // 16, image.shape[2] // 16)
                        clip = Clip()
                        conditioned = MiniMaxH3ReferenceToVideo.execute(
                            clip, result[6], 32, 32, result[3], vae=Vae(),
                            ref_images={f"ref_image_{i}": slots[i] for i in range(9)},
                            ref_videos={"ref_video_0": result[0]}).result
                        self.assertEqual([x["type"] for x in clip.items], ["image", "image", "video"])
                        self.assertIn("<Picture 2>", clip.prompt)
                        blocks = conditioned[0][0][1]["minimax_refs"]
                        self.assertEqual([x["kind"] for x in blocks], ["image", "image", "video"])
            media["items"].append({"id": "i9", "path": "image-9.png"})
            with self.assertRaisesRegex(ValueError, "at most nine images"):
                adapter.HenjiccH3RoleInputs.execute(media, .05)


    def test_audio_limits(self):
        for waveform in [torch.zeros(2, 1, 1000), torch.full((1, 1, 1000), float("nan")), torch.zeros(1, 1, 300001)]:
            with self.assertRaises(ValueError): music.audio_waveform({"waveform": waveform, "sample_rate": 1000})

    def test_mix_preserves_backing_length_offsets_and_input(self):
        vocals = {"waveform": torch.tensor([[[.2, .4, .6]]]), "sample_rate": 1000}
        backing = {"waveform": torch.zeros(1, 2, 5), "sample_rate": 1000}
        before = vocals["waveform"].clone()
        delayed = music.mix_audio(vocals, backing, vocal_offset=.002)
        torch.testing.assert_close(delayed["waveform"][0, 0], torch.tensor([0., 0., .2, .4, .6]))
        self.assertEqual(delayed["waveform"].shape, (1, 2, 5))
        advanced = music.mix_audio(vocals, backing, vocal_offset=-.002)
        torch.testing.assert_close(advanced["waveform"][0, 0], torch.tensor([.6, 0., 0., 0., 0.]))
        torch.testing.assert_close(vocals["waveform"], before)
        self.assertEqual(backing["waveform"].count_nonzero(), 0)
        limited = music.mix_audio(vocals, backing, vocal_gain_db=12)
        self.assertAlmostEqual(limited["waveform"].abs().max().item(), .98, places=6)
        self.assertEqual(limited["sample_rate"], 1000)
        for settings in ({"vocal_offset": float("nan")}, {"vocal_gain_db": 13}, {"backing_gain_db": True}):
            with self.assertRaises(ValueError): music.mix_audio(vocals, backing, **settings)

    def test_mix_resamples(self):
        vocals = {"waveform": torch.full((1, 1, 2000), .1), "sample_rate": 2000}
        backing = {"waveform": torch.zeros(1, 1, 1000), "sample_rate": 1000}
        mixed = music.mix_audio(vocals, backing)
        self.assertEqual(mixed["waveform"].shape, (1, 1, 1000))
        torch.testing.assert_close(mixed["waveform"][..., 10:-10], torch.full((1, 1, 980), .1), rtol=.005, atol=.001)

if __name__ == "__main__":
    unittest.main()
