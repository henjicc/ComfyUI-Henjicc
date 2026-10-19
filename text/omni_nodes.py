"""Minimal V3 interface for joint media understanding and prompt rewriting."""

import json
import folder_paths
from comfy_api.latest import io
from ..media.media import parse_media
from .omni import find_model, infer, INSTRUCTIONS


class HenjiccOmniPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccOmniPrompt", display_name="Qwen2.5-Omni Multimodal Prompt Assistant", category="Henjicc/Text",
                         inputs=[io.Custom("HENJICC_MEDIA").Input("media"),
                                 io.Combo.Input("task", options=list(INSTRUCTIONS), default="describe"),
                                 io.Int.Input("analysis_seconds", default=5, min=1, max=15),
                                 io.Int.Input("max_tokens", default=512, min=64, max=2048),
                                 io.Int.Input("timeout_seconds", default=300, min=30, max=900),
                                 io.Combo.Input("model_name", options=["Qwen2.5-Omni-3B", "Qwen2.5-Omni-7B"],
                                                default="Qwen2.5-Omni-3B", optional=True)],
                         outputs=[io.String.Output("text")])

    @classmethod
    def fingerprint_inputs(cls, model_name="Qwen2.5-Omni-3B", **kwargs):
        try:
            path = find_model(model_name)
        except ValueError:
            return float("nan")
        return tuple((p.name, p.stat().st_size, p.stat().st_mtime_ns)
                     for p in sorted(path.iterdir()) if p.suffix in {".json", ".safetensors"})

    @classmethod
    def execute(cls, media, task, analysis_seconds, max_tokens, timeout_seconds, model_name="Qwen2.5-Omni-3B"):
        if task not in INSTRUCTIONS:
            raise ValueError("不支持的任务 / Unsupported task")
        if (type(analysis_seconds) is not int or not 1 <= analysis_seconds <= 15 or
                type(max_tokens) is not int or not 64 <= max_tokens <= 2048 or
                type(timeout_seconds) is not int or not 30 <= timeout_seconds <= 900):
            raise ValueError("推理参数超出范围 / Inference parameter out of range")
        state = parse_media(media) if isinstance(media, str) else parse_media(json.dumps(media))
        return io.NodeOutput(infer(find_model(model_name), folder_paths.get_input_directory(), state, task,
                                   analysis_seconds, max_tokens, timeout_seconds))
