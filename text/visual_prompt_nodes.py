"""Visual assistant; the host CLIP loader retains model lifecycle ownership."""

import json
import logging
import re
import folder_paths
from comfy_api.latest import io
from ..media.media import compile_prompt, parse_media
from .visual_prompt import TASK_INSTRUCTIONS, prepare_visual_inputs, generate_visual, resolve_task


class HenjiccVisualPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccVisualPrompt", display_name="Qwen3-VL Prompt Optimization Assistant",
                         category="Henjicc/Text", hidden=[io.Hidden.prompt, io.Hidden.unique_id], inputs=[
                             io.Custom("HENJICC_MEDIA").Input("media"), io.Clip.Input("clip", tooltip="通过原生 CLIP 加载器选择完整 Qwen3-VL；可共享千问 2.1 编码器。H3 专用 50 层编码器不能直接生成文本。 / Select a full Qwen3-VL with Load CLIP; Qwen-Image 2.1 can share it."),
                             io.Combo.Input("task", options=list(TASK_INSTRUCTIONS), default="auto"),
                             io.Combo.Input("frames_per_second", options=["2", "4"], default="2"),
                             io.Int.Input("segment_seconds", default=10, min=5, max=10),
                             io.Int.Input("analysis_seconds", default=0, min=0, max=60, advanced=True),
                             io.Int.Input("max_tokens", default=512, min=64, max=2048),
                             io.Float.Input("pixel_budget_mp", default=16, min=4, max=24, step=1, optional=True),
                             io.String.Input("custom_instruction", multiline=True, default="", optional=True)],
                         outputs=[io.String.Output("text"), io.Image.Output("visuals", is_output_list=True),
                                  io.Custom("HENJICC_MEDIA").Output("media")])

    @classmethod
    def fingerprint_inputs(cls, task, **kwargs):
        # HTTP submission resolves auto before caching. Embedded executors that
        # skip that hook cannot cache auto safely: fingerprint has no graph.
        return float("nan") if task == "auto" else task

    @classmethod
    def execute(cls, media, clip, task, frames_per_second, segment_seconds, analysis_seconds, max_tokens, pixel_budget_mp=16, custom_instruction=""):
        if (task not in TASK_INSTRUCTIONS or frames_per_second not in {"2", "4"} or
                type(segment_seconds) is not int or not 5 <= segment_seconds <= 10 or
                type(analysis_seconds) is not int or not 0 <= analysis_seconds <= 60 or
                type(max_tokens) is not int or not 64 <= max_tokens <= 2048 or
                type(pixel_budget_mp) not in {int, float} or not 4 <= pixel_budget_mp <= 24):
            raise ValueError("视觉助手参数超出范围 / Invalid visual assistant parameters")
        if not isinstance(custom_instruction, str) or len(custom_instruction) > 12000:
            raise ValueError("自定义要求过长或无效 / Invalid or oversized custom instruction")
        if task == "custom" and not custom_instruction.strip():
            raise ValueError("请填写自定义要求 / Enter custom instructions")
        state = parse_media(media) if isinstance(media, str) else parse_media(json.dumps(media))
        task = resolve_task(task, getattr(cls.hidden, "prompt", None), getattr(cls.hidden, "unique_id", None))
        # Retain the serialized legacy slot, but it no longer truncates videos.
        images, prompt = prepare_visual_inputs(folder_paths.get_input_directory(), state,
                                               int(frames_per_second), segment_seconds, pixel_budget_mp=pixel_budget_mp,
                                               allow_text_only=task in {"qwen_auto", "general", "custom"})
        text = generate_visual(clip, images, prompt, task, max_tokens, custom_instruction)
        if task == "h3_swap":
            original = compile_prompt(state)
            requested = set(re.findall(r"<(?:Picture|Video) \d+>", original))
            missing = requested - set(re.findall(r"<(?:Picture|Video) \d+>", text))
            if missing:
                logging.warning("[Henjicc] 角色替换提示词优化遗漏引用 %s，已保留用户原始要求 / "
                                "Role prompt optimization omitted references; keeping the original request", ", ".join(sorted(missing)))
                text = original
        # parse_media returns a fresh object; preserve all assets, IDs and presets.
        state["prompt"] = [text]
        return io.NodeOutput(text, images, state)
