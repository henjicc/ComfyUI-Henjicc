import importlib
import asyncio
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

import av
import numpy as np
import torch
from PIL import Image

package = types.ModuleType("henjicc_media_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
media = importlib.import_module("henjicc_media_test.media.media")


class MediaTests(unittest.TestCase):
    def test_generic_references_preserve_order_alpha_and_support_more_than_ten(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        Image.new("RGBA", (71, 45), (255, 0, 0, 128)).save(self.root / "a.png")
        Image.new("RGB", (45, 71), "blue").save(self.root / "b.png")
        state = {"version": 1, "profile": "general", "items": [
            {"id": str(i), "path": "a.png" if i % 2 == 0 else "b.png"} for i in range(24)],
            "prompt": [{"ref": "1"}]}
        with patch.object(nodes.folder_paths, "get_input_directory", return_value=str(self.root)):
            result = nodes.HenjiccQwenReferenceList.execute(state, 0, "1").result
            self.assertEqual(len(result[0]), 24)
            self.assertEqual(result[0][0].shape, (1, 45, 71, 4))
            self.assertEqual(result[0][1].shape, (1, 71, 45, 4))
            self.assertAlmostEqual(result[0][0][0, 0, 0, 3].item(), 128 / 255)
            self.assertEqual(result[0][1][0, 0, 0].tolist(), [0, 0, 1, 1])
            self.assertIs(result[0][0], result[2])
            self.assertEqual(result[3], "<image2>")
            aligned = nodes.HenjiccQwenReferenceList.execute(state, 0).result
            self.assertEqual(aligned[0][0].shape, (1, 32, 64, 4))
            self.assertEqual(aligned[2].shape, (1, 45, 71, 4))

    def test_generic_reference_chain_only_selects_qwen_at_native_model_consumer(self):
        graph = {"2": {"class_type": "HenjiccQwenReferenceList", "inputs": {"media": ["1", 0]}},
                 "3": {"class_type": "HenjiccImageListToSlots", "inputs": {"images": ["2", 0]}}}
        self.assertEqual(media.connected_profile("general", graph, "1"), "general")
        graph["4"] = {"class_type": "TextEncodeQwenImage21", "inputs": {"image1": ["3", 0]}}
        self.assertEqual(media.connected_profile("general", graph, "1"), "qwen")
        graph["5"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"start_image": ["4", 0]}}
        self.assertEqual(media.connected_profile("general", graph, "1"), "qwen")
        state = {"version": 1, "profile": "general", "items": [
            {"id": str(i), "path": "a.png"} for i in range(11)], "prompt": []}
        with self.assertRaisesRegex(ValueError, "10"):
            media.parse_media(json.dumps(state), prompt=graph, node_id="1")

    def test_host_cache_uses_connection_stamp_without_disabling_downstream_cache(self):
        from comfy_execution.graph import DynamicPrompt
        import execution
        import nodes as host_nodes
        plugin_nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        value = json.dumps({"version": 1, "profile": "minimax_frames", "items": [], "prompt": []})
        graph = {"1": {"class_type": "HenjiccSuperLoader", "inputs": {"media": value}},
                 "2": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["1", 0]}}}
        saved_workflow = {"media": value}
        def fingerprint(graph):
            request = {"prompt": copy.deepcopy(graph), "extra_data": {"extra_pnginfo": {"workflow": saved_workflow}}}
            media.prepare_media_prompt(request)
            self.assertEqual(saved_workflow, {"media": value})
            cache = execution.IsChangedCache("henjicc-test", DynamicPrompt(request["prompt"]), None)
            return asyncio.run(cache.get("1"))
        with patch.dict(host_nodes.NODE_CLASS_MAPPINGS, {"HenjiccSuperLoader": plugin_nodes.HenjiccSuperLoader}):
            qwen_hash = fingerprint(graph)
            self.assertIsInstance(qwen_hash[0], str)
            self.assertEqual(qwen_hash, fingerprint(graph))
            graph["2"]["class_type"] = "HenjiccMiniMaxMedia"
            self.assertNotEqual(qwen_hash, fingerprint(graph))
            graph["3"] = {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["1", 0]}}
            conflict_hash = fingerprint(graph)
            self.assertNotEqual(qwen_hash, conflict_hash)
            graph["1"]["inputs"]["media"] = json.dumps({**json.loads(value), "_connection_profile": "qwen"})
            self.assertEqual(conflict_hash, fingerprint(graph))

    def test_connection_detection_revalidates_and_invalidates_cache(self):
        state = {"version": 1, "profile": "minimax_frames", "items": [], "prompt": ["test"]}
        graph = {"2": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["1", 0]}}}
        value = json.dumps(state)
        self.assertEqual(media.parse_media(value, prompt=graph, node_id="1")["profile"], "qwen")
        graph["2"]["class_type"] = "TextEncodeQwenImageEdit"
        self.assertEqual(media.parse_media(value, prompt=graph, node_id="1")["profile"], "qwen")
        graph["2"]["class_type"] = "TextEncodeQwenImage21"
        self.assertEqual(media.parse_media(value, prompt=graph, node_id="1")["profile"], "qwen")
        qwen_hash = media.media_fingerprint(self.root, value, prompt=graph, node_id="1")
        graph["2"]["class_type"] = "HenjiccMiniMaxMedia"
        self.assertEqual(media.parse_media(value, prompt=graph, node_id="1")["profile"], "minimax_frames")
        self.assertNotEqual(qwen_hash, media.media_fingerprint(self.root, value, prompt=graph, node_id="1"))
        state["profile"] = "general"
        self.assertEqual(media.parse_media(json.dumps(state), prompt=graph, node_id="1")["profile"], "minimax_reference")
        state["items"] = [{"id": "v", "path": "v.mp4"}]
        graph["2"]["class_type"] = "TextEncodeQwenImageEditPlus"
        with self.assertRaisesRegex(ValueError, "images only"):
            media.parse_media(json.dumps(state), prompt=graph, node_id="1")
        graph["3"] = {"class_type": "HenjiccMiniMaxMedia", "inputs": {"media": ["1", 0]}}
        with self.assertRaisesRegex(ValueError, "both connected"):
            media.parse_media(value, prompt=graph, node_id="1")
        self.assertEqual(media.parse_media(value, prompt={}, node_id="1")["profile"], "general")
        self.assertEqual(json.loads(value)["profile"], "minimax_frames")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = {"version": 1, "profile": "minimax_reference", "items": [
            {"id": "a", "path": "角色.png"}, {"id": "sound", "path": "voice.wav"},
            {"id": "b", "path": "video.mp4", "soundtrack": True}, {"id": "c", "path": "scene.png"}],
            "prompt": [{"ref": "a"}, " replaces ", {"ref": "c"}, " in ", {"ref": "b"},
                       " with ", {"ref": "sound"}, " and ", {"ref": "b", "track": "audio"}]}

    def test_super_input_uses_hidden_graph_for_all_outputs_and_fingerprint(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        Image.new("RGB", (32, 32), "red").save(self.root / "image.png")
        value = json.dumps({"version": 1, "profile": "minimax_frames", "items": [{"id": "i", "path": "image.png"}], "prompt": [{"ref": "i"}]})
        graph = {"adapter": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["group:1", 0]}}}
        hidden = types.SimpleNamespace(prompt=graph, unique_id="group:1")
        with patch.object(nodes.HenjiccSuperLoader, "hidden", hidden), patch.object(nodes.folder_paths, "get_input_directory", return_value=str(self.root)):
            result = nodes.HenjiccSuperLoader.execute(value).result
            self.assertEqual((result[0]["profile"], *result[1:4]), ("qwen", "<image1>", True, False))
            self.assertEqual(result[4], {"width": None, "height": None})
            before = nodes.HenjiccSuperLoader.fingerprint_inputs(value)
            graph["adapter"]["class_type"] = "HenjiccMiniMaxMedia"
            result = nodes.HenjiccSuperLoader.execute(value).result
            self.assertEqual((result[0]["profile"], *result[1:4]), ("minimax_frames", "<Picture 1>", True, True))
            self.assertNotEqual(before, nodes.HenjiccSuperLoader.fingerprint_inputs(value))
            hidden.prompt = {}
            self.assertTrue(math.isnan(nodes.HenjiccSuperLoader.fingerprint_inputs(value)))

    def test_preset_survives_submission_without_rewriting_user_prompt(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        preset = {"name": "角色卡", "width": 2752, "height": 1536}
        state = {"version": 1, "profile": "general", "items": [],
                 "prompt": ["用户已经编辑过的提示词"], "preset": preset}
        request = {"prompt": {"1": {"class_type": "HenjiccSuperLoader", "inputs": {"media": json.dumps(state)}}}}
        media.prepare_media_prompt(request)
        value = request["prompt"]["1"]["inputs"]["media"]
        with patch.object(nodes.HenjiccSuperLoader, "hidden", types.SimpleNamespace(prompt={}, unique_id="1")):
            result = nodes.HenjiccSuperLoader.execute(value).result
        self.assertEqual(result[1], state["prompt"][0])
        self.assertEqual(result[4], preset)
        before = media.media_fingerprint(self.root, value)
        state["preset"]["width"] = 2048
        self.assertNotEqual(before, media.media_fingerprint(self.root, json.dumps(state)))

    def test_invalid_preset_dimensions_rejected(self):
        for preset in ([], {"width": 1024}, {"width": True, "height": 1024},
                       {"width": 1024, "height": 0}, {"width": 1024, "height": 8193},
                       {"name": 1, "width": 1024, "height": 1024}):
            with self.subTest(preset=preset), self.assertRaises(ValueError):
                media.parse_media(json.dumps({**self.state, "preset": preset}))

    def test_prompt_only_preset_executes_without_dimensions(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        for preset in ({"name": "提示词"}, {"name": "提示词", "width": None, "height": None}):
            value = json.dumps({"version": 1, "profile": "general", "items": [], "prompt": ["test"], "preset": preset})
            with self.subTest(preset=preset), patch.object(nodes.HenjiccSuperLoader, "hidden", types.SimpleNamespace(prompt={}, unique_id="1")):
                result = nodes.HenjiccSuperLoader.execute(value).result
                self.assertEqual(result[1], "test")
                self.assertIsNone(result[4].get("width"))
                self.assertIsNone(result[4].get("height"))

    def test_compact_outputs_translate_all_consumers_once_and_preserve_saved_workflow(self):
        for names in (["media", "prompt", "preset"],
                      ["media", "prompt", "first_last", "preset"],
                      list(media.SUPER_OUTPUT_NAMES)):
            with self.subTest(names=names):
                state = {"version": 1, "profile": "general", "items": [], "prompt": [], "_output_names": names}
                value = json.dumps(state)
                saved = {"nodes": [{"widgets_values": [value]}]}
                graph = {"group:1": {"class_type": "HenjiccSuperLoader", "inputs": {"media": value}},
                         "board": {"class_type": "HenjiccResolutionBoard", "inputs": {"preset": ["group:1", names.index("preset")]}},
                         "other": {"class_type": "Other", "inputs": {"value": ["group:1", names.index("preset")]}},
                         "adapter": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["group:1", 0]}}}
                if "first_last" in names:
                    graph["switch"] = {"inputs": {"value": ["group:1", names.index("first_last")]}}
                request = {"prompt": graph, "extra_data": {"extra_pnginfo": {"workflow": saved}}}
                media.prepare_media_prompt(request)
                self.assertEqual(graph["board"]["inputs"]["preset"], ["group:1", 4])
                self.assertEqual(graph["other"]["inputs"]["value"], ["group:1", 4])
                if "first_last" in names:
                    self.assertEqual(graph["switch"]["inputs"]["value"], ["group:1", 3])
                prepared = json.loads(graph["group:1"]["inputs"]["media"])
                self.assertNotIn("_output_names", prepared)
                self.assertEqual(prepared["_connection_profile"], "qwen")
                before = copy.deepcopy(request)
                media.prepare_media_prompt(request)
                self.assertEqual(request, before)
                self.assertEqual(saved["nodes"][0]["widgets_values"], [value])

    def test_invalid_output_mapping_or_index_fails_without_partial_translation(self):
        cases = [(names, 2) for names in (None, ["media"], ["prompt", "media"],
                 ["media", "prompt", "preset", "preset"], ["media", "prompt", "unknown"],
                 ["media", "prompt", {}])]
        cases += [(["media", "prompt", "preset"], index) for index in (-1, 3, True, "2")]
        for names, index in cases:
            with self.subTest(names=names, index=index):
                value = json.dumps({"version": 1, "profile": "general", "items": [], "prompt": [], "_output_names": names})
                graph = {"1": {"class_type": "HenjiccSuperLoader", "inputs": {"media": value}},
                         "2": {"inputs": {"first": ["1", 2], "invalid": ["1", index]}}}
                before = copy.deepcopy(graph)
                with self.assertRaisesRegex(ValueError, "Super Input output"):
                    media.prepare_media_prompt({"prompt": graph})
                self.assertEqual(graph, before)
                # The host catches prompt-handler exceptions; execution must
                # still reject unresolved mappings instead of using wrong slots.
                with self.assertRaisesRegex(ValueError, "Unresolved"):
                    media.parse_media(value)

    def test_direct_api_retains_canonical_output_indices(self):
        graph = {"1": {"class_type": "HenjiccSuperLoader", "inputs": {"media": media.EMPTY_MEDIA}},
                 "board": {"inputs": {"preset": ["1", 4]}}}
        media.prepare_media_prompt({"prompt": graph})
        self.assertEqual(graph["board"]["inputs"]["preset"], ["1", 4])

    def test_reorder_keeps_identity_and_soundtrack_audio_numbering(self):
        parsed = media.parse_media(json.dumps(self.state))
        self.assertEqual(media.compile_prompt(parsed), "<Picture 1> replaces <Picture 2> in <Video 1> with <Audio 2> and <Audio 1>")
        self.state["items"].reverse()
        self.assertEqual(media.compile_prompt(self.state), "<Picture 2> replaces <Picture 1> in <Video 1> with <Audio 2> and <Audio 1>")
        self.state["items"] = [i for i in self.state["items"] if i["id"] != "a"]
        with self.assertRaisesRegex(ValueError, "referenced asset was removed"):
            media.parse_media(json.dumps(self.state))

    def test_model_constraints_and_optional_empty_qwen(self):
        self.state.update(profile="qwen", items=[], prompt=["A painting"])
        self.assertEqual(media.compile_prompt(media.parse_media(json.dumps(self.state))), "A painting")
        self.state["items"] = [{"id": str(i), "path": "a.png"} for i in range(11)]
        with self.assertRaisesRegex(ValueError, "10 reference"):
            media.parse_media(json.dumps(self.state))
        self.state.update(profile="minimax_frames", items=[{"id": "a", "path": "v.mp4"}])
        with self.assertRaisesRegex(ValueError, "images only"):
            media.parse_media(json.dumps(self.state))
        self.state["items"] = [{"id": str(i), "path": "a.png"} for i in range(3)]
        with self.assertRaisesRegex(ValueError, "2 images"):
            media.parse_media(json.dumps(self.state))

    def test_input_path_and_content_fingerprint(self):
        Image.new("RGB", (8, 8), "red").save(self.root / "角色.png")
        self.state.update(profile="qwen", items=[{"id": "a", "path": "角色.png"}], prompt=[{"ref": "a"}])
        value = json.dumps(self.state)
        before = media.media_fingerprint(self.root, value)
        Image.new("RGB", (8, 8), "blue").save(self.root / "角色.png")
        self.assertNotEqual(before, media.media_fingerprint(self.root, value))
        for path in ["../outside.mp4", "C:/test.mp4", ".secret.wav", "bad.exe"]:
            with self.assertRaises((ValueError, FileNotFoundError)):
                media.resolve_media(self.root, path)
        self.assertEqual(media.load_images(self.root, self.state)[0].image.shape, (1, 8, 8, 3))

    def test_audio_decode_and_duration_limit(self):
        path = self.root / "voice.wav"
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(8000)
            out.writeframes(np.zeros(8000, dtype=np.int16).tobytes())
        audio = media.load_audio(path)
        self.assertEqual(audio["sample_rate"], 32000)
        self.assertEqual(audio["waveform"].shape, (1, 2, 32000))
        with self.assertRaisesRegex(ValueError, "trim it first"):
            media.load_audio(path, duration=0.5)





    def test_native_image_list_keeps_empty_and_all_references_together(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        images = importlib.import_module("henjicc_media_test.image.image_nodes")
        state = {"version": 1, "profile": "qwen", "items": [], "prompt": []}
        with patch.object(nodes.folder_paths, "get_input_directory", return_value=str(self.root)):
            result = nodes.HenjiccQwenReferenceList.execute(state, 0).result
            self.assertEqual(result, ([], True, None, ""))
            self.assertEqual(images.HenjiccImageListToSlots.execute(result[0]).result, (None,) * 10)
            for i in range(10):
                Image.new("RGBA", (32 * (i + 1), 32), (i * 20, 0, 0, 128)).save(self.root / f"{i}.png")
            state["items"] = [{"id": str(i), "path": f"{i}.png"} for i in range(10)]
            result = nodes.HenjiccQwenReferenceList.execute(state, 0).result
            slots = images.HenjiccImageListToSlots.execute(result[0]).result
            self.assertFalse(result[1])
            for i, image in enumerate(slots):
                self.assertEqual(image.shape, (1, 32, 32 * (i + 1), 4))
                self.assertAlmostEqual(image[0, 0, 0, 0].item(), i * 20 / 255)
                self.assertAlmostEqual(image[0, 0, 0, 3].item(), 128 / 255)

    def test_native_image_list_accepts_batches_and_rejects_overflow_without_truncation(self):
        nodes = importlib.import_module("henjicc_media_test.image.image_nodes")
        batch = torch.stack([torch.zeros(32, 64, 3), torch.ones(32, 64, 3)])
        slots = nodes.HenjiccImageListToSlots.execute([batch, torch.ones(1, 64, 32, 4)]).result
        torch.testing.assert_close(slots[0], batch[:1])
        torch.testing.assert_close(slots[1], batch[1:])
        self.assertEqual(slots[2].shape, (1, 64, 32, 4))
        for invalid in ([batch] * 6, [None], [torch.zeros(1, 32, 32, 1)]):
            with self.assertRaises(ValueError):
                nodes.HenjiccImageListToSlots.execute(invalid)

    def test_host_executor_consumes_the_image_list_once_including_empty(self):
        import execution
        nodes = importlib.import_module("henjicc_media_test.image.image_nodes")
        for images in ([], [torch.zeros(1, 32, 64, 3), torch.ones(1, 64, 32, 4)]):
            results = asyncio.run(execution._async_map_node_over_list(
                "list-contract-test", "slots", nodes.HenjiccImageListToSlots,
                {"images": images}, "execute"))
            self.assertEqual(len(results), 1)
            slots = results[0].result
            for i, image in enumerate(images):
                torch.testing.assert_close(slots[i], image)
            self.assertTrue(all(image is None for image in slots[len(images):]))

    def test_video_timestamp_resampling_and_pixel_budget(self):
        path = self.root / "video.mp4"
        with av.open(str(path), "w") as container:
            stream = container.add_stream("mpeg4", rate=12)
            stream.width = 64
            stream.height = 32
            stream.pix_fmt = "yuv420p"
            for i in range(12):
                frame = av.VideoFrame.from_ndarray(np.full((32, 64, 3), i * 15, dtype=np.uint8), format="rgb24")
                for packet in stream.encode(frame): container.mux(packet)
            for packet in stream.encode(): container.mux(packet)
        frames = media.load_video(path, 0.4, [0])
        self.assertEqual(frames.shape, (24, 32, 64, 3))
        self.assertTrue((frames[0] == frames[1]).all())
        with self.assertRaisesRegex(ValueError, "pixel budget"):
            media.load_video(path, 0.4, [media.MAX_VIDEO_PIXELS])
        with self.assertRaisesRegex(ValueError, "no audio track"):
            media.load_audio(path)

    def test_h3_first_and_last_frames_keep_proportions_on_the_same_canvas(self):
        nodes = importlib.import_module("henjicc_media_test.media.media_nodes")
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo
        Image.new("RGB", (32, 64), "red").save(self.root / "first.png")
        Image.new("RGB", (64, 32), "blue").save(self.root / "last.png")
        state = {"version": 1, "profile": "minimax_frames", "items": [
            {"id": "first", "path": "first.png"}, {"id": "last", "path": "last.png"}], "prompt": []}
        with patch.object(nodes.folder_paths, "get_input_directory", return_value=str(self.root)), \
                patch.object(MiniMaxH3ImageToVideo, "execute") as condition:
            nodes.HenjiccMiniMaxMedia.execute(state, None, None, None, 64, 32, 124, .4)
            first, last = condition.call_args.args[-2:]
        self.assertEqual(first.shape, (1, 32, 64, 3))
        self.assertEqual(last.shape, (1, 32, 64, 3))
        self.assertTrue(torch.equal(first[..., :24, :], torch.zeros(1, 32, 24, 3)))
        self.assertTrue(torch.equal(first[..., 40:, :], torch.zeros(1, 32, 24, 3)))
        self.assertTrue(torch.allclose(first[:, :, 24:40], torch.tensor([1., 0., 0.]).expand(1, 32, 16, 3)))
        self.assertTrue(torch.equal(last, torch.tensor([0., 0., 1.]).expand(1, 32, 64, 3)))
        # A pure text-to-video graph still calls the native empty-frame path.
        state["items"] = []
        with patch.object(nodes.folder_paths, "get_input_directory", return_value=str(self.root)), \
                patch.object(MiniMaxH3ImageToVideo, "execute") as condition:
            nodes.HenjiccMiniMaxMedia.execute(state, None, None, None, 64, 32, 124, .4)
        self.assertEqual(condition.call_args.args[-2:], (None, None))


if __name__ == "__main__":
    unittest.main()
