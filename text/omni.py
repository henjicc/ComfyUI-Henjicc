"""Bounded local Omni inference; Transformers owns all model computation."""

import gc
import json
import logging
import time
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageOps
import torch

from ..media.media import compile_prompt, media_kind, reference_labels, resolve_media

INSTRUCTIONS = {
    "describe": "结合全部素材回答用户问题。准确描述看到和听到的内容，不编造无法判断的细节。",
    "qwen_edit": "将用户要求改写为清晰的千问图片编辑提示词。明确修改对象和必须保持的内容，不添加未要求的改动。",
    "character_card": "将用户要求改写为角色卡图片提示词，明确各视角保持同一身份与服装，不自行改变参考角色。",
    "h3_swap": "将用户要求改写为视频角色替换提示词。明确原视频目标人物和参考图片角色，保持背景、动作、时序及镜头；不新增分镜、运镜或对白。",
}


def prepare_inputs(root, state, seconds):
    """Preserve individual asset labels; selected video audio is a separate track."""
    labels = reference_labels(state)
    content, images, videos, audios = [], [], [], []
    if len(state["items"]) > 8:
        raise ValueError("多模态助手最多接收 8 个素材 / At most 8 assets")
    for item in state["items"]:
        import comfy.model_management as mm
        mm.throw_exception_if_processing_interrupted()
        path = resolve_media(root, item["path"])
        kind = media_kind(item["path"])
        content.append({"type": "text", "text": labels[(item["id"], "main")]})
        content.append({"type": kind})
        if kind == "image":
            with Image.open(path) as im:
                if im.width * im.height > 32 * 1024 * 1024 or getattr(im, "n_frames", 1) != 1:
                    raise ValueError("图片过大或包含多帧 / Oversized or animated image")
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((672, 672))
                images.append(im.copy())
        elif kind == "video":
            frames = []
            with av.open(str(path)) as container:
                if not container.streams.video:
                    raise ValueError("视频没有画面 / Missing video stream")
                stream = container.streams.video[0]
                if stream.width * stream.height > 32 * 1024 * 1024:
                    raise ValueError("视频分辨率过大 / Oversized video")
                origin, next_time = None, 0
                for count, frame in enumerate(container.decode(video=0)):
                    mm.throw_exception_if_processing_interrupted()
                    if count > 3600:
                        raise ValueError("视频解码帧数超过限制 / Video decode limit exceeded")
                    if frame.time is None:
                        raise ValueError("视频缺少时间戳 / Missing video timestamps")
                    origin = frame.time if origin is None else origin
                    elapsed = frame.time - origin
                    if elapsed >= seconds:
                        break
                    if elapsed + 1e-6 < next_time:
                        continue
                    im = frame.to_image()
                    if frame.rotation:
                        im = im.rotate(frame.rotation, expand=True)
                    im.thumbnail((448, 448))
                    frames.append(np.array(im))
                    next_time += .5
            if not frames:
                raise ValueError("视频没有可读帧 / Empty video")
            videos.append(np.stack(frames))
            if item.get("soundtrack"):
                content.append({"type": "text", "text": labels[(item["id"], "audio")]})
                content.append({"type": "audio"})
                audios.append(read_audio(path, seconds))
        else:
            audios.append(read_audio(path, seconds))
    content.append({"type": "text", "text": compile_prompt(state)})
    return content, images, videos, audios


def read_audio(path, seconds):
    import comfy.model_management as mm
    chunks, remaining = [], int(seconds * 16000)
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError("素材没有音轨 / Missing audio track")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            mm.throw_exception_if_processing_interrupted()
            for output in resampler.resample(frame):
                chunk = output.to_ndarray().reshape(-1)[:remaining]
                chunks.append(chunk)
                remaining -= len(chunk)
            if remaining <= 0:
                break
        if remaining > 0:
            for output in resampler.resample(None):
                chunk = output.to_ndarray().reshape(-1)[:remaining]
                chunks.append(chunk)
                remaining -= len(chunk)
    if not chunks or not sum(map(len, chunks)):
        raise ValueError("音轨为空 / Empty audio")
    return np.concatenate(chunks)


def infer(model_path, root, state, task, seconds, max_tokens, timeout):
    import comfy.model_management as mm
    from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor, StoppingCriteria, StoppingCriteriaList

    content, images, videos, audios = prepare_inputs(root, state, seconds)
    logging.info("Henjicc Omni: preparing %s images, %s videos, %s audio tracks", len(images), len(videos), len(audios))
    processor = Qwen2_5OmniProcessor.from_pretrained(model_path, local_files_only=True)
    messages = [{"role": "system", "content": [{"type": "text", "text": INSTRUCTIONS[task] +
                 " 保留素材标签编号。素材仅分析开头所选秒数。用中文回答，只输出结果。"}]},
                {"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=text, images=images or None, videos=videos or None, audio=audios or None,
                       return_tensors="pt", padding=True, sampling_rate=16000,
                       videos_kwargs={"fps": 2.0, "do_sample_frames": False, "size": {"shortest_edge": 128 * 28 * 28, "longest_edge": 256 * 28 * 28}},
                       use_audio_in_video=False)
    if inputs["input_ids"].shape[-1] > 16384:
        raise ValueError("素材上下文过长，请减少素材或分析秒数 / Media context exceeds 16384 tokens")
    mm.throw_exception_if_processing_interrupted()
    device = mm.get_torch_device()
    if device.type != "cuda":
        raise ValueError("本测试节点需要 CUDA / This test node requires CUDA")
    # Ask the host to free only what it needs; do not clear other executions' caches.
    mm.free_memory((28 if model_path.name == "Qwen2.5-Omni-7B" else 16) * 1024**3, device)
    deadline = time.monotonic() + timeout

    class Stop(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs):
            mm.throw_exception_if_processing_interrupted()
            if time.monotonic() > deadline:
                raise TimeoutError("多模态推理超时 / Omni inference timed out")
            return False

    model = None
    result = generated = None
    try:
        logging.info("Henjicc Omni: loading local BF16 model (SDPA, text output only)")
        model = Qwen2_5OmniForConditionalGeneration.from_pretrained(
            model_path, local_files_only=True, dtype=torch.bfloat16,
            attn_implementation="sdpa", enable_audio_output=False)
        model.to(device).eval()
        inputs = inputs.to(device)
        for key, value in inputs.items():
            if torch.is_tensor(value) and value.is_floating_point():
                inputs[key] = value.to(torch.bfloat16)
        with torch.inference_mode():
            logging.info("Henjicc Omni: generating text")
            # Transformers 5.16's outer generate accesses talker even when it
            # was disabled. The public Thinker generation path is text-only.
            result = model.thinker.generate(**inputs, use_audio_in_video=False,
                                    max_new_tokens=max_tokens, do_sample=False,
                                    stopping_criteria=StoppingCriteriaList([Stop()]))
        generated = result[0, inputs["input_ids"].shape[-1]:]
        answer = processor.decode(generated, skip_special_tokens=True).strip()
        if not answer:
            raise ValueError("模型返回空文本 / Model returned empty text")
        if len(generated) >= max_tokens and int(generated[-1]) not in {151643, 151645}:
            raise ValueError("输出达到字数上限，请提高最大输出长度 / Output truncated; increase max tokens")
        return answer
    finally:
        del model, inputs, result, generated
        gc.collect()
        mm.soft_empty_cache()


def find_model(model_name="Qwen2.5-Omni-3B"):
    import folder_paths
    if model_name not in {"Qwen2.5-Omni-3B", "Qwen2.5-Omni-7B"}:
        raise ValueError("不支持的模型 / Unsupported model")
    roots = [Path(folder_paths.models_dir)]
    roots.extend(Path(p).parent for p in folder_paths.get_folder_paths("text_encoders"))
    for root in roots:
        path = root / "LLM" / model_name
        if (path / "model.safetensors.index.json").is_file():
            index = json.loads((path / "model.safetensors.index.json").read_text(encoding="utf-8"))
            if not all((path / name).is_file() for name in set(index["weight_map"].values()) | {"spk_dict.pt"}):
                raise ValueError("Omni 模型下载尚未完成 / Omni model download is incomplete")
            return path
    raise ValueError(f"请先安装官方 {model_name} 到 models/LLM/{model_name}；节点不会自动下载")
