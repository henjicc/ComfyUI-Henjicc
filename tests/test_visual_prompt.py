import importlib
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import av
import numpy as np
from PIL import Image

package = types.ModuleType("henjicc_visual_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
visual = importlib.import_module("henjicc_visual_test.text.visual_prompt")
media = importlib.import_module("henjicc_visual_test.media.media")
nodes = importlib.import_module("henjicc_visual_test.text.visual_prompt_nodes")


class VisualPromptTests(unittest.TestCase):
    def test_auto_task_uses_downstream_connections_and_unknown_falls_back(self):
        for target, expected in [("TextEncodeQwenImage21", "qwen_auto"),
                                 ("HenjiccH3RoleInputs", "h3_swap"),
                                 ("HenjiccMiniMaxMedia", "h3_reference"), ("PreviewAny", "general")]:
            graph = {"nested:7": {"class_type": target, "inputs": {"media": ["1", 2]}}}
            self.assertEqual(visual.resolve_task("auto", graph, "1"), expected)
            self.assertEqual(visual.resolve_task("custom", graph, "1"), "custom")
        self.assertEqual(visual.resolve_task("auto", None, "1"), "general")
        graph = {"2": {"class_type": "HenjiccVisualPrompt", "inputs": {"media": ["1", 2]}},
                 "3": {"class_type": "HenjiccH3RoleInputs", "inputs": {"media": ["2", 2]}}}
        self.assertEqual(visual.resolve_task("auto", graph, "1"), "h3_swap")
        graph["4"] = {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["1", 2]}}
        self.assertEqual(visual.resolve_task("auto", graph, "1"), "general")
        self.assertEqual(visual.resolve_task("auto", {"3": {"class_type": "MiniMaxH3ImageToVideo",
                         "inputs": {"prompt": ["1", 0]}}}, "1"), "h3_reference")

    def test_host_cache_invalidates_auto_task_on_target_rewiring(self):
        from comfy_execution.graph import DynamicPrompt
        import execution
        import nodes as host_nodes
        graph = {"1": {"class_type": "HenjiccVisualPrompt", "inputs": {"task": "auto"}},
                 "2": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["1", 2]}}}
        def fingerprint():
            request = {"prompt": copy.deepcopy(graph), "extra_data": {"workflow": {"task": "auto"}}}
            media.prepare_media_prompt(request)
            self.assertEqual(graph["1"]["inputs"]["task"], "auto")
            self.assertEqual(request["extra_data"]["workflow"]["task"], "auto")
            return asyncio.run(execution.IsChangedCache("visual-auto-test", DynamicPrompt(request["prompt"]), None).get("1"))
        with patch.dict(host_nodes.NODE_CLASS_MAPPINGS, {"HenjiccVisualPrompt": nodes.HenjiccVisualPrompt}):
            qwen = fingerprint()
            self.assertEqual(qwen, ["qwen_auto"])
            graph["2"]["class_type"] = "HenjiccH3RoleInputs"
            self.assertEqual(fingerprint(), ["h3_swap"])
            del graph["2"]
            self.assertEqual(fingerprint(), ["general"])

    def test_material_output_preserves_assets_and_preset_without_mutating_input(self):
        state = {"version": 1, "profile": "general", "items": [{"id": "a", "path": "missing.wav"}],
                 "preset": {"name": "portrait", "width": 1024, "height": 1536}, "prompt": ["写一段"]}
        original = json.dumps(state, ensure_ascii=False)
        with patch.object(nodes, "generate_visual", return_value="新的提示词") as generate:
            result = nodes.HenjiccVisualPrompt.execute(state, object(), "custom", "2", 10, 10, 512,
                                                      custom_instruction="只改写成简短句子").result
        self.assertEqual(result[2], {**state, "prompt": ["新的提示词"]})
        self.assertEqual(json.dumps(state, ensure_ascii=False), original)
        self.assertEqual(result[:2], ("新的提示词", []))
        self.assertEqual(generate.call_args.args[-1], "只改写成简短句子")
        with self.assertRaisesRegex(ValueError, "custom instructions"):
            nodes.HenjiccVisualPrompt.execute(state, object(), "custom", "2", 10, 10, 512)

    def test_text_only_qwen_and_profile_detection_through_optimizer(self):
        state = {"version": 1, "profile": "general", "items": [], "prompt": ["一只猫"]}
        images, prompt = visual.prepare_visual_inputs("unused", state, 2, 10, 10, allow_text_only=True)
        self.assertEqual(images, [])
        self.assertIn("实际独立参考图片数量：0", prompt)
        graph = {"2": {"class_type": "HenjiccVisualPrompt", "inputs": {"media": ["1", 0]}},
                 "3": {"class_type": "TextEncodeQwenImage21", "inputs": {"media": ["2", 2]}}}
        self.assertEqual(media.connected_profile("general", graph, "1"), "qwen")
        graph["4"] = {"class_type": "HenjiccVisualPrompt", "inputs": {"media": ["2", 2]}}
        graph["2"]["inputs"]["media"] = ["4", 2]
        del graph["3"]
        self.assertEqual(media.connected_profile("general", graph, "2"), "general")
        self.assertNotIn("character_card", visual.TASK_INSTRUCTIONS)

    def test_role_optimization_keeps_second_reference_or_restores_the_complete_request(self):
        state = {"version": 1, "profile": "minimax_reference", "items": [
            {"id": "character", "path": "character.png"}, {"id": "video", "path": "source.mp4"},
            {"id": "glasses", "path": "glasses.png"}],
            "prompt": ["将", {"ref": "video"}, "中的角色替换为", {"ref": "character"},
                       "，墨镜参考", {"ref": "glasses"}]}
        original = copy.deepcopy(state)
        complete = "将<Video 1>中角色替换为<Picture 1>，佩戴<Picture 2>中的墨镜。"
        for generated in (complete, "将<Video 1>中角色替换为<Picture 1>。"):
            with self.subTest(generated=generated), \
                 patch.object(nodes, "prepare_visual_inputs", return_value=([], "素材与用户要求")), \
                 patch.object(nodes, "generate_visual", return_value=generated):
                if generated == complete:
                    result = nodes.HenjiccVisualPrompt.execute(state, object(), "h3_swap", "2", 10, 10, 512).result
                    self.assertEqual(result[0], complete)
                else:
                    with self.assertLogs(level="WARNING") as log:
                        result = nodes.HenjiccVisualPrompt.execute(state, object(), "h3_swap", "2", 10, 10, 512).result
                    self.assertIn("<Picture 2>", log.output[0])
                    self.assertEqual(result[0], media.compile_prompt(state))
                self.assertEqual(result[2]["items"], state["items"])
                self.assertIn("<Picture 2>", result[0])
                self.assertEqual(state, original)

    def test_joint_budget_scales_every_image_without_dropping_or_cropping(self):
        sources = [Image.new("RGB", (3000, 2000), "red"), Image.new("RGB", (2400, 2000), "blue")]
        images = visual.constrain_visuals(sources, 4)
        self.assertEqual(len(images), 2)
        self.assertLessEqual(sum(im.width * im.height for im in images), 4_000_000)
        for image, source in zip(images, sources):
            self.assertEqual(image.width % 32, 0)
            self.assertEqual(image.height % 32, 0)
            self.assertEqual(image.getpixel((image.width // 2, image.height // 2)), source.getpixel((0, 0)))
        self.assertEqual(sources[0].size, (3000, 2000))
        single = visual.constrain_visuals([Image.new("RGB", (4096, 4096))], 24)[0]
        self.assertLessEqual(single.width * single.height, 12_000_000)

    def test_visual_assistant_accepts_all_nine_native_h3_reference_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            Image.new("RGB", (32, 32), "red").save(Path(tmp) / "image.png")
            state = {"profile": "minimax_reference", "items": [
                {"id": f"i{i}", "path": "image.png"} for i in range(9)], "prompt": [{"ref": "i8"}]}
            images, prompt = visual.prepare_visual_inputs(tmp, state, 2, 10, 10)
            self.assertEqual(len(images), 9)
            self.assertIn("<Picture 9>：独立参考图片", prompt)
            self.assertIn("<Picture 9>", prompt)

    def test_all_videos_are_sampled_to_their_end_even_with_a_legacy_one_second_setting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("RGB", (64, 64), "red").save(root / "image.png")
            for name, count in (("long.mp4", 308), ("other.mp4", 57)):
                with av.open(str(root / name), "w") as container:
                    stream = container.add_stream("mpeg4", rate=5)
                    stream.width, stream.height, stream.pix_fmt = 64, 32, "yuv420p"
                    for i in range(count):
                        frame = av.VideoFrame.from_ndarray(np.full((32, 64, 3), i % 200, np.uint8), format="rgb24")
                        for packet in stream.encode(frame): container.mux(packet)
                    for packet in stream.encode(): container.mux(packet)
            state = {"profile": "general", "items": [
                {"id": "v1", "path": "long.mp4"}, {"id": "i", "path": "image.png"},
                {"id": "v2", "path": "other.mp4"}], "prompt": ["比较全部素材"]}
            images, prompt = visual.prepare_visual_inputs(root, state, 2, 10, 1, 4)
            self.assertEqual(len(images), 10)  # Seven sheets + one image + two sheets.
            self.assertIn("<video1>：视频抽帧拼图，第 7 段，实际采样 60.00–61.40s", prompt)
            self.assertIn("<video2>：视频抽帧拼图，第 2 段，实际采样 10.00–11.20s", prompt)
            self.assertIn("<image1>：独立参考图片", prompt)
            self.assertNotIn("开头最多", prompt)
            self.assertLessEqual(sum(im.shape[1] * im.shape[2] for im in images), 4_000_000)

    def test_streaming_budget_keeps_equal_sources_equally_sized(self):
        originals = [Image.new("RGB", (2000, 2000), color) for color in ("red", "blue")]
        first = visual.constrain_visuals(originals[:1], 1)[0]
        streamed = visual.constrain_visuals([first, originals[1]], 1, [im.size for im in originals])
        expected = visual.constrain_visuals(originals, 1)
        self.assertEqual([im.size for im in streamed], [im.size for im in expected])
        self.assertEqual(streamed[0].size, streamed[1].size)
        self.assertEqual(streamed[0].getpixel((100, 100)), (255, 0, 0))
        self.assertEqual(streamed[1].getpixel((100, 100)), (0, 0, 255))
    def test_sampling_segments_timestamps_and_audio_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (100, 200), "red").save(root / "image.png")
            with av.open(str(root / "video.mp4"), "w") as container:
                stream = container.add_stream("mpeg4", rate=10)
                stream.width = 64; stream.height = 32; stream.pix_fmt = "yuv420p"
                for index in range(110):
                    frame = av.VideoFrame.from_ndarray(np.full((32, 64, 3), index, dtype=np.uint8), format="rgb24")
                    for packet in stream.encode(frame): container.mux(packet)
                for packet in stream.encode(): container.mux(packet)
            groups = list(visual.video_sheets(root / "video.mp4", 2, 10, 11))
            self.assertEqual([len(frames) for _, frames in groups], [20, 3])
            self.assertAlmostEqual(groups[1][1][0][0], 10)
            self.assertEqual(len(list(visual.video_sheets(root / "video.mp4", 4, 10, 10))[0][1]), 40)
            state = media.parse_media(json.dumps({"version": 1, "profile": "general", "items": [
                {"id": "a", "path": "nonexistent.wav"}, {"id": "i", "path": "image.png"},
                {"id": "v", "path": "video.mp4", "soundtrack": True}],
                "prompt": ["比较", {"ref": "i"}, "和", {"ref": "v"}]}))
            images, prompt = visual.prepare_visual_inputs(root, state, 2, 10, 11)
            self.assertEqual(len(images), 3)
            self.assertEqual(tuple(images[0].shape), (1, 192, 96, 3))
            self.assertIn("<image1>：独立参考图片", prompt)
            self.assertIn("<video1>：视频抽帧拼图，第 2 段", prompt)
            self.assertIn("10.00–10.90s", prompt)
            self.assertEqual(prompt.count(visual.VISION_TOKEN), 3)
            self.assertIn("比较<image1>和<video1>", prompt)
            # Timestamp text is actually present in the bottom band.
            sheet = visual.contact_sheet(groups[1][1])
            self.assertGreater(np.array(sheet)[-34:].max(), 200)
            state["items"] = state["items"][:1]; state["prompt"] = []
            with self.assertRaisesRegex(ValueError, "visual asset"):
                visual.prepare_visual_inputs(root, state, 2, 10, 10)

    def test_raw_template_keeps_images_interleaved_and_rejects_wrong_backend(self):
        clip = Mock()
        from comfy.text_encoders.qwen3vl import Qwen3VLTokenizer
        clip.tokenizer = object.__new__(Qwen3VLTokenizer)
        clip.generate.return_value = [42, 151645]
        clip.decode.return_value = "画面静止"
        images = [visual.image_tensor(Image.new("RGB", (32, 32)))]
        prompt = "<video1> 0.00s\n" + visual.VISION_TOKEN
        self.assertEqual(visual.generate_visual(clip, images, prompt, "describe", 64), "画面静止")
        self.assertIs(clip.tokenize.call_args.kwargs["images"], images)
        self.assertTrue(clip.tokenize.call_args.kwargs["skip_template"])
        self.assertIn("音频及视频原声全部忽略", clip.tokenize.call_args.args[0])
        visual.generate_visual(clip, images, prompt, "h3_swap", 512)
        instruction = clip.tokenize.call_args.args[0]
        self.assertIn("<Picture N>", instruction)
        self.assertIn("不反转动作方向", instruction)
        self.assertIn("输出必须与用户输入的要求使用同一种语言", instruction)
        self.assertNotIn("英文提示词", instruction)
        self.assertNotIn("用中文回答", instruction)
        clip.tokenizer = object()
        with self.assertRaises(ValueError): visual.generate_visual(clip, images, prompt, "describe", 64)

    def test_shared_qwen_image_tokenizer_and_h3_failure_before_inference(self):
        from comfy.text_encoders.qwen_image21 import QwenImage21Tokenizer
        from comfy.text_encoders.minimax import MiniMaxH3Tokenizer
        clip = Mock()
        clip.tokenizer = object.__new__(QwenImage21Tokenizer)
        clip.generate.return_value = [42, 151645]
        clip.decode.return_value = "一只猫"
        self.assertEqual(visual.generate_visual(clip, [], "猫", "general", 64), "一只猫")
        self.assertTrue(clip.tokenize.call_args.kwargs["skip_template"])
        clip.reset_mock()
        clip.tokenizer = object.__new__(MiniMaxH3Tokenizer)
        with self.assertRaisesRegex(ValueError, "generation tail"):
            visual.generate_visual(clip, [], "猫", "general", 64)
        clip.tokenize.assert_not_called()
        clip.generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
