"""Stable media references and bounded local decoding for the super loader."""

import hashlib
import json
import math
from pathlib import Path

import av
import numpy as np
import torch

from ..image.image_collection import fail, load_collection
from ..library.image_library import EXTENSIONS, ImageLibrary
from ..image.generation_presets import number

VIDEO = {".mp4", ".mov", ".webm", ".mkv"}
AUDIO = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
MEDIA_EXTENSIONS = EXTENSIONS | VIDEO | AUDIO
PROFILES = {"general", "qwen", "minimax_reference", "minimax_frames"}
EMPTY_MEDIA = '{"version":1,"profile":"general","items":[],"prompt":[]}'
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_VIDEO_PIXELS = 192 * 1024 * 1024
SUPER_OUTPUT_NAMES = ("media", "prompt", "has_images", "first_last", "preset")


def media_kind(path):
    suffix = Path(path).suffix.lower()
    if suffix in EXTENSIONS:
        return "image"
    if suffix in VIDEO:
        return "video"
    if suffix in AUDIO:
        return "audio"
    fail("不支持的素材格式", "Unsupported media format")


def connected_profile(profile, prompt, node_id):
    if prompt is None or node_id is None:
        return profile
    families = set()
    pending, visited = [(str(node_id), 0)], set()
    qwen = {"TextEncodeQwenImage21", "TextEncodeQwenImageEdit", "TextEncodeQwenImageEditPlus"}
    minimax = {"HenjiccMiniMaxMedia", "HenjiccH3RoleInputs", "MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"}
    while pending:
        source, slot = pending.pop()
        if (source, slot) in visited:
            continue
        visited.add((source, slot))
        for consumer_id, node in prompt.items():
            if not isinstance(node, dict):
                continue
            if not any(isinstance(link, list) and len(link) == 2 and str(link[0]) == source
                       and (slot is None or link[1] == slot) for link in node.get("inputs", {}).values()):
                continue
            kind = node.get("class_type")
            if kind in qwen:
                families.add("qwen")
            elif kind in minimax:
                families.add("minimax")
            else:
                pending.append((str(consumer_id), None))
    if len(families) > 1:
        fail("同时连接了千问和 MiniMax，请分别使用超级输入节点", "Qwen and MiniMax are both connected; use separate Super Input nodes")
    if "qwen" in families:
        return "qwen"
    if "minimax" in families:
        return "minimax_frames" if profile == "minimax_frames" else "minimax_reference"
    return "general"


def normalize_media_outputs(prompt):
    """Translate compact UI slots to the stable execution schema, once.

    Validate the complete rewrite before mutating it: a bad mapping must not
    leave a partially translated graph when the host catches handler errors.
    """
    sources = {}
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != "HenjiccSuperLoader":
            continue
        inputs = node.get("inputs", {})
        value = inputs.get("media") if isinstance(inputs, dict) else None
        if not isinstance(value, str) or len(value) > 1024 * 1024:
            continue
        try:
            state = json.loads(value)
        except ValueError:
            continue
        if not isinstance(state, dict) or "_output_names" not in state:
            continue
        names = state["_output_names"]
        if (not isinstance(names, list) or not 2 <= len(names) <= len(SUPER_OUTPUT_NAMES)
                or names[:2] != ["media", "prompt"]
                or any(not isinstance(name, str) or name not in SUPER_OUTPUT_NAMES for name in names)
                or len(set(names)) != len(names)):
            fail("超级输入输出映射无效，请刷新页面后重新提交", "Invalid Super Input output mapping; refresh and resubmit")
        sources[str(node_id)] = (inputs, state, [SUPER_OUTPUT_NAMES.index(name) for name in names])
    rewrites = []
    for node in prompt.values():
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        if not isinstance(inputs, dict):
            continue
        for key, value in inputs.items():
            if not isinstance(value, list) or len(value) != 2 or str(value[0]) not in sources:
                continue
            mapping = sources[str(value[0])][2]
            if type(value[1]) is not int or not 0 <= value[1] < len(mapping):
                fail("超级输入连线编号无效，请重新连接", "Invalid Super Input output index; reconnect the input")
            rewrites.append((inputs, key, [value[0], mapping[value[1]]]))
    for inputs, key, value in rewrites:
        inputs[key] = value
    for inputs, state, _ in sources.values():
        del state["_output_names"]
        inputs["media"] = json.dumps(state, ensure_ascii=False)


def prepare_media_prompt(request):
    """Normalize compact output links and stamp connection-aware cache inputs.

    Only the submitted execution graph changes, never the saved UI workflow.
    The connection stamp is derived metadata, not execution authority; invalid
    media and unresolved output mappings still fail when the node runs.
    """
    prompt = request.get("prompt", {})
    if not isinstance(prompt, dict):
        return request
    normalize_media_outputs(prompt)
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != "HenjiccSuperLoader":
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        try:
            # Old saved profiles must not impose constraints before detection.
            state = parse_media(inputs.get("media"), prompt={})
            original = json.loads(inputs["media"])
            state["profile"] = original["profile"]
        except ValueError:
            continue
        try:
            state["_connection_profile"] = connected_profile(state["profile"], prompt, node_id)
        except ValueError:
            state["_connection_profile"] = "conflict"
        inputs["media"] = json.dumps(state, ensure_ascii=False)
    # Resolve before cache keys are built. The host fingerprint stage does not
    # receive PROMPT, while execute does; leave the saved UI choice untouched.
    from ..text.visual_prompt import resolve_task
    for node_id, node in prompt.items():
        if isinstance(node, dict) and node.get("class_type") == "HenjiccVisualPrompt":
            inputs = node.get("inputs", {})
            if inputs.get("task") == "auto":
                inputs["task"] = resolve_task("auto", prompt, node_id)
    return request


def parse_media(value, *, prompt=None, node_id=None):
    if not isinstance(value, str) or len(value) > 1024 * 1024:
        fail("素材数据过大或无效", "Invalid or oversized media state")
    try:
        state = json.loads(value)
    except ValueError:
        fail("素材数据格式无效", "Invalid media JSON")
    if (not isinstance(state, dict) or type(state.get("version")) is not int or state.get("version") != 1
            or not isinstance(state.get("profile"), str) or state["profile"] not in PROFILES
            or not isinstance(state.get("items"), list) or len(state["items"]) > 24
            or not isinstance(state.get("prompt"), list)):
        fail("不支持的素材数据格式", "Unsupported media state")
    if "_output_names" in state:
        fail("超级输入输出映射尚未解析，请通过 ComfyUI 提交工作流", "Unresolved Super Input output mapping; submit through ComfyUI")
    ids = set()
    preset = state.get("preset")
    if preset is not None:
        if (not isinstance(preset, dict) or not isinstance(preset.get("name", ""), str)
                or len(preset.get("name", "")) > 200):
            fail("预设数据无效", "Invalid preset data")
        if preset.get("width") is not None or preset.get("height") is not None:
            number(preset.get("width"), "preset.width", 8, 8192, True)
            number(preset.get("height"), "preset.height", 8, 8192, True)
    counts = {"image": 0, "video": 0, "audio": 0}
    for item in state["items"]:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or not 1 <= len(item["id"]) <= 100
                or item["id"] in ids or not isinstance(item.get("path"), str)
                or type(item.get("soundtrack", False)) is not bool):
            fail("素材条目无效或重复", "Invalid or duplicate media entry")
        ids.add(item["id"])
        counts[media_kind(item["path"])] += 1
    for part in state["prompt"]:
        if isinstance(part, str):
            continue
        if (not isinstance(part, dict) or not isinstance(part.get("ref"), str)
                or part.get("track", "main") not in {"main", "audio"}):
            fail("提示词引用格式无效", "Invalid prompt reference")
        if part["ref"] not in ids:
            fail("提示词引用的素材已删除，请移除该引用", "A referenced asset was removed; remove its prompt reference")
    profile = state["profile"] = connected_profile(state["profile"], prompt, node_id)
    if profile in {"qwen", "minimax_frames"} and (counts["video"] or counts["audio"]):
        fail("当前模式只能使用图片", "This mode accepts images only")
    if profile == "qwen" and counts["image"] > 10:
        fail("千问最多使用 10 张参考图", "Qwen supports up to 10 reference images")
    if profile == "minimax_frames" and counts["image"] > 2:
        fail("首尾帧模式最多使用 2 张图片", "First/last frame mode supports up to 2 images")
    if profile == "minimax_reference" and (counts["image"] > 9 or counts["video"] > 3 or counts["audio"] > 3 or sum(counts.values()) > 12):
        fail("MiniMax 参考素材超过上限（图片 9、视频 3、音频 3、合计 12）", "MiniMax reference limit exceeded (9 images, 3 videos, 3 audio, 12 total)")
    return state


def resolve_media(root, path):
    try:
        resolved = ImageLibrary(root, Path(root) / ".unused.sqlite").resolve(path, extensions=MEDIA_EXTENSIONS)
        size = resolved.stat().st_size
    except (OSError, ValueError):
        fail(f"素材不存在或无法读取：{path}", f"Media missing or unreadable: {path}")
    if size > MAX_FILE_BYTES:
        fail("单个素材不能超过 512 MB", "Each asset must be at most 512 MB")
    return resolved


def reference_labels(state):
    labels = {}
    counts = {"image": 0, "video": 0, "audio": 0}
    minimax = state["profile"].startswith("minimax")
    # Native H3 presents video soundtracks before standalone audio, irrespective
    # of how different media kinds are interleaved in the user's strip.
    for kind in ("image", "video", "audio"):
        for item in state["items"]:
            if media_kind(item["path"]) != kind:
                continue
            counts[kind] += 1
            name = {"image": "Picture", "video": "Video", "audio": "Audio"}[kind]
            labels[(item["id"], "main")] = f"<{name} {counts[kind]}>" if minimax else f"<{kind}{counts[kind]}>"
            if kind == "video" and item.get("soundtrack"):
                counts["audio"] += 1
                labels[(item["id"], "audio")] = f"<Audio {counts['audio']}>" if minimax else f"<audio{counts['audio']}>"
    return labels


def compile_prompt(state):
    labels = reference_labels(state)
    result = []
    for part in state["prompt"]:
        if isinstance(part, str):
            result.append(part)
        else:
            key = (part["ref"], part.get("track", "main"))
            if key not in labels:
                fail("引用的素材或原声不可用", "Referenced media or soundtrack is unavailable")
            result.append(labels[key])
    return "".join(result)


def media_fingerprint(root, value, *, prompt=None, node_id=None):
    state = parse_media(value, prompt=prompt, node_id=node_id)
    digest = hashlib.sha256(json.dumps(state, sort_keys=True).encode())
    try:
        for item in state["items"]:
            with resolve_media(root, item["path"]).open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
    except (ValueError, OSError):
        return float("nan")
    return digest.hexdigest()


def load_images(root, state):
    items = [{"id": i["id"], "path": i["path"], "enabled": True} for i in state["items"] if media_kind(i["path"]) == "image"]
    if not items:
        return []
    return list(load_collection(root, json.dumps({"version": 1, "items": items, "current": items[0]["id"]}))[0])


def load_audio(path, duration=15):
    """Decode at a bounded rate/channel count, including a selected video's track."""
    chunks, samples = [], 0
    with av.open(str(path)) as container:
        if not container.streams.audio:
            fail("素材不包含音轨", "Asset has no audio track")
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=32000)
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                samples += output.samples
                if samples > duration * 32000:
                    fail("音频超过 15 秒，请先裁剪", "Audio exceeds 15 seconds; trim it first")
                chunks.append(output.to_ndarray())
        for output in resampler.resample(None):
            samples += output.samples
            if samples > duration * 32000:
                fail("音频超过 15 秒，请先裁剪", "Audio exceeds 15 seconds; trim it first")
            chunks.append(output.to_ndarray())
    if not chunks:
        fail("音轨为空", "Empty audio track")
    return {"waveform": torch.from_numpy(np.concatenate(chunks, axis=1)).unsqueeze(0), "sample_rate": 32000}


def load_video(path, megapixels, budget):
    """Timestamp-based resampling to H3's 24 fps, bounded before tensor allocation."""
    frames = []
    with av.open(str(path)) as container:
        if not container.streams.video:
            fail("素材不包含视频画面", "Asset has no video stream")
        stream = container.streams.video[0]
        if stream.width * stream.height > 32 * 1024 * 1024:
            fail("视频单帧像素过多，请降低分辨率", "Video frame resolution is too large; downscale it first")
        if stream.duration is not None and float(stream.duration * stream.time_base) > 15.05:
            fail("视频超过 15 秒，请先裁剪", "Video exceeds 15 seconds; trim it first")
        scale = min(1, math.sqrt(megapixels * 1e6 / max(1, stream.width * stream.height)))
        width, height = max(32, round(stream.width * scale / 32) * 32), max(32, round(stream.height * scale / 32) * 32)
        origin, previous, next_time, decoded = None, None, 0, 0
        def append(frame):
            budget[0] += width * height
            if budget[0] > MAX_VIDEO_PIXELS:
                fail("视频总像素过多，请降低参考视频尺寸或时长", "Video pixel budget exceeded; reduce reference size or duration")
            frames.append(frame)
        for frame in container.decode(video=0):
            decoded += 1
            if decoded > 3600:
                fail("视频帧数过多，请降低帧率", "Too many decoded frames; lower the source frame rate")
            if frame.time is None:
                fail("视频缺少时间戳，请重新导出", "Video timestamps are missing; re-export the video")
            if origin is None:
                origin = frame.time
            time = frame.time - origin
            if time > 15.05:
                fail("视频超过 15 秒，请先裁剪", "Video exceeds 15 seconds; trim it first")
            if previous is not None:
                while next_time < time and len(frames) < 360:
                    append(previous)
                    next_time += 1 / 24
            previous = frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
            if frame.rotation:
                if frame.rotation % 90:
                    fail("视频旋转角度不支持，请重新导出", "Unsupported video rotation; re-export the video")
                previous = np.rot90(previous, frame.rotation // 90).copy()
        if previous is not None:
            # Include the final source-frame interval; do not shorten 24 fps input.
            end = min(15, time + 1 / float(stream.average_rate or 24))
            while next_time < end - 1e-6 and len(frames) < 360:
                append(previous)
                next_time += 1 / 24
    if len(frames) < 5:
        fail("参考视频至少需要 5 帧", "Reference video needs at least 5 frames")
    return torch.from_numpy(np.stack(frames)).float().div_(255)
