"""Ordered, heterogeneous images. No model-specific sizing or browser dependency."""

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
import torch
import torch.nn.functional as F

from ..library.image_library import ImageLibrary

# RGB + mask float32 storage, with room for decode/resize copies in normal use.
MAX_PIXELS = 32 * 1024 * 1024
EMPTY_STATE = '{"version":1,"items":[],"current":null}'


def fail(zh, en):
    raise ValueError(f"{zh} / {en}")


def resize_references(images, megapixels, alignment="32"):
    """Resize independent RGB/RGBA references without a model or slot contract."""
    if (type(megapixels) not in (int, float) or not math.isfinite(megapixels)
            or not 0 <= megapixels <= 32 or alignment not in {"1", "2", "8", "16", "32", "64"}):
        fail("参考图预算或对齐倍数无效", "Invalid reference budget or alignment")
    grid = int(alignment)
    sizes = []
    for image in images:
        if (not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[0] != 1
                or min(image.shape[1:3]) < 1 or image.shape[-1] not in (3, 4)
                or not image.is_floating_point()):
            fail("参考图必须为单张 RGB 或 RGBA 图片", "References must be individual RGB or RGBA images")
        height, width = image.shape[1:3]
        factor = math.sqrt(megapixels * 1_000_000 / (width * height)) if megapixels else 1
        sizes.append((max(grid, round(width * factor / grid) * grid),
                      max(grid, round(height * factor / grid) * grid)))
    check_pixels(sum(width * height for width, height in sizes))
    processed = []
    for image, (width, height) in zip(images, sizes):
        if (width, height) == (image.shape[2], image.shape[1]):
            processed.append(image)
        else:
            import comfy.utils
            processed.append(comfy.utils.common_upscale(image.movedim(-1, 1), width, height,
                                                        "lanczos", "disabled").movedim(1, -1))
    return processed


def parse_state(value):
    if not isinstance(value, str) or len(value) > 1024 * 1024:
        fail("图片组数据过大或无效", "Invalid or oversized image collection")
    try:
        state = json.loads(value)
    except (ValueError, TypeError):
        fail("图片组数据格式无效", "Invalid image collection JSON")
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("items"), list):
        fail("不支持的图片组格式", "Unsupported image collection format")
    ids = set()
    for item in state["items"]:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not item["id"] or item["id"] in ids
                or not isinstance(item.get("path"), str) or type(item.get("enabled")) is not bool):
            fail("图片条目无效或重复", "Invalid or duplicate image entry")
        ids.add(item["id"])
    if state.get("current") is not None and (not isinstance(state["current"], str) or state["current"] not in ids):
        fail("当前图片不存在", "Current image is not in the collection")
    return state


def resolve(root, path):
    try:
        return ImageLibrary(root, Path(root) / ".unused.sqlite").resolve(path)
    except (ValueError, OSError):
        fail(f"图片路径无效或文件不存在：{path}", f"Invalid or missing image: {path}")


def check_pixels(pixels):
    if pixels > MAX_PIXELS:
        fail("图片总像素超过 33554432，请减少图片或尺寸", "Total pixels exceed 33554432; reduce image count or dimensions")


@dataclass(frozen=True)
class CollectionImage:
    id: str
    path: str
    image: torch.Tensor
    mask: torch.Tensor


def fingerprint(root, value):
    state = parse_state(value)
    digest = hashlib.sha256(value.encode())
    try:
        for item in state["items"]:
            if not item["enabled"]:
                continue
            with resolve(root, item["path"]).open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
    except (OSError, ValueError):
        # Force execution to surface a useful node error, never reuse stale images.
        return float("nan")
    return digest.hexdigest()


def load_collection(root, value):
    state = parse_state(value)
    enabled = [item for item in state["items"] if item["enabled"]]
    if not enabled:
        fail("请至少启用一张图片", "Enable at least one image")
    pixels = 0
    # Preflight before allocating tensors; decode checks again in case files changed.
    for item in enabled:
        path = resolve(root, item["path"])
        try:
            with Image.open(path) as source:
                if getattr(source, "n_frames", 1) != 1:
                    fail(f"不支持动画或多页图片：{item['path']}", f"Animated or multipage image is unsupported: {item['path']}")
                pixels += source.width * source.height
                check_pixels(pixels)
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
            fail(f"无法读取图片：{item['path']}", f"Cannot read image: {item['path']}")
    result = []
    pixels = 0
    for item in enabled:
        try:
            with Image.open(resolve(root, item["path"])) as source:
                if getattr(source, "n_frames", 1) != 1:
                    fail("文件已变为多帧图片，请重新选择", "File changed to a multiframe image; select it again")
                pixels += source.width * source.height
                check_pixels(pixels)
                oriented = ImageOps.exif_transpose(source)
                rgba = np.asarray(oriented.convert("RGBA"), dtype=np.float32) / 255.0
                image = torch.from_numpy(rgba[:, :, :3].copy()).unsqueeze(0)
                mask = torch.from_numpy(1.0 - rgba[:, :, 3].copy()).unsqueeze(0)
                result.append(CollectionImage(item["id"], item["path"], image, mask))
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
            fail(f"无法解码图片：{item['path']}", f"Cannot decode image: {item['path']}")
    current = next((item for item in result if item.id == state.get("current")), result[0])
    return tuple(result), current


def convert_collection(collection, mode, size, width, height, fit, background):
    if not collection:
        fail("图片组为空", "Image collection is empty")
    if mode == "list":
        return [item.image for item in collection], [item.mask for item in collection]
    if mode != "batch" or size not in {"first", "custom"} or fit not in {"contain", "crop"}:
        fail("转换选项无效", "Invalid conversion option")
    if size == "first":
        height, width = collection[0].image.shape[1:3]
    if type(width) is not int or type(height) is not int or min(width, height) < 1:
        fail("尺寸必须为正整数", "Dimensions must be positive integers")
    check_pixels(width * height * len(collection))
    if not isinstance(background, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", background):
        fail("填充颜色应为 #RRGGBB", "Padding color must be #RRGGBB")
    color = torch.tensor([int(background[i:i+2], 16) / 255 for i in (1, 3, 5)])
    images, masks = [], []
    for item in collection:
        ih, iw = item.image.shape[1:3]
        scale = (min if fit == "contain" else max)(width / iw, height / ih)
        rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
        check_pixels(rw * rh)
        image = F.interpolate(item.image.movedim(-1, 1), size=(rh, rw), mode="bicubic", align_corners=False).clamp(0, 1).movedim(1, -1)
        mask = F.interpolate(item.mask.unsqueeze(1), size=(rh, rw), mode="bilinear", align_corners=False)[:, 0].clamp(0, 1)
        if fit == "contain":
            canvas = color.expand(1, height, width, 3).clone()
            alpha = torch.ones((1, height, width))
            x, y = (width-rw)//2, (height-rh)//2
            canvas[:, y:y+rh, x:x+rw] = image
            alpha[:, y:y+rh, x:x+rw] = mask
            image, mask = canvas, alpha
        else:
            x, y = (rw-width)//2, (rh-height)//2
            image, mask = image[:, y:y+height, x:x+width], mask[:, y:y+height, x:x+width]
        images.append(image)
        masks.append(mask)
    return [torch.cat(images)], [torch.cat(masks)]
