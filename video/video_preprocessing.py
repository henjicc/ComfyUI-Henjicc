"""Bounded, timestamp-based normalization for H3 source videos."""

import math
from fractions import Fraction

import av
import numpy as np
import torch

from ..image.image_collection import MAX_PIXELS, fail


def canvas_size(width, height, megapixels, max_short_edge=None):
    budget = int(megapixels * 1_000_000)
    scale = min(1, math.sqrt(budget / (width * height)), 4096 / max(width, height))
    if max_short_edge is not None:
        scale = min(scale, max_short_edge / min(width, height))
    w, h = max(32, math.ceil(width * scale / 32) * 32), max(32, math.ceil(height * scale / 32) * 32)
    while w * h > budget:
        if w >= h and w > 32:
            w -= 32
        elif h > 32:
            h -= 32
        else:
            fail("视频像素预算太小", "Video pixel budget is too small")
    return w, h


def normalize_source(source, megapixels, start_time=0, end_time=None, *, duration=5, max_short_edge=None):
    if (type(megapixels) not in (int, float) or not math.isfinite(megapixels) or not .05 <= megapixels <= 1
            or not math.isfinite(start_time) or start_time < 0):
        fail("视频预算或裁剪起点无效", "Invalid video budget or trim start")
    if end_time is not None and (not math.isfinite(end_time) or end_time <= start_time):
        fail("视频裁剪终点无效", "Invalid video trim end")
    if duration is not None and (type(duration) is not int or not 4 <= duration <= 15):
        fail("视频时长需为 4–15 秒的整数", "Video duration must be an integer from 4 to 15 seconds")
    # Auto mode measures timestamps during the existing bounded decode, without
    # probing or decoding the source a second time. Allocation remains <= 15 s.
    frame_count = (15 if duration is None else duration) * 24
    targets = np.arange(frame_count, dtype=np.float64) / 24 + start_time
    try:
        with av.open(source) as container:
            if not container.streams.video:
                fail("素材没有视频画面", "Asset has no video stream")
            stream = container.streams.video[0]
            rate = float(stream.average_rate or stream.guessed_rate or 24)
            if not math.isfinite(rate) or rate <= 0:
                fail("视频帧率无效", "Invalid video frame rate")
            origin = previous = previous_time = packed = None
            index = 0
            source_end = 0

            def render(frame):
                scale = min(w / display_w, h / display_h)
                rw, rh = max(1, round(display_w * scale)), max(1, round(display_h * scale))
                pw, ph = (rh, rw) if rotation % 2 else (rw, rh)
                rgb = frame.reformat(width=pw, height=ph, format="rgb24").to_ndarray()
                if rotation:
                    rgb = np.rot90(rgb, rotation)
                image = np.zeros((h, w, 3), dtype=np.uint8)
                y, x = (h - rh) // 2, (w - rw) // 2
                image[y:y + rh, x:x + rw] = rgb
                return image

            for decoded_index, frame in enumerate(container.decode(stream)):
                import comfy.model_management
                comfy.model_management.throw_exception_if_processing_interrupted()
                if decoded_index >= 7200:
                    fail("裁剪起点过远或源帧率过高，请先裁剪", "Trim start or source frame rate exceeds the decode limit; trim first")
                if frame.width * frame.height > MAX_PIXELS:
                    fail("视频源帧过大，请先降低分辨率", "Source video frame is too large; downscale first")
                angle = float(frame.rotation or 0)
                if not math.isfinite(angle) or angle % 90:
                    fail("视频旋转角度不支持，请重新导出", "Unsupported video rotation; re-export the video")
                rotation = int(angle / 90) % 4
                sar = float(stream.sample_aspect_ratio or Fraction(1))
                if not math.isfinite(sar) or sar <= 0:
                    fail("视频像素比例无效", "Invalid video pixel aspect ratio")
                display_w, display_h = frame.width * sar, frame.height
                if rotation % 2:
                    display_w, display_h = display_h, display_w
                absolute = float(frame.time) if frame.time is not None else decoded_index / rate
                if origin is None:
                    origin = absolute
                    w, h = canvas_size(display_w, display_h, megapixels, max_short_edge)
                    packed = np.empty((frame_count, h, w, 3), dtype=np.uint8)
                timestamp = absolute - origin
                if not math.isfinite(timestamp) or previous_time is not None and timestamp < previous_time - .001:
                    fail("视频时间戳异常，请重新导出", "Invalid video timestamps; re-export the video")
                frame_seconds = float(frame.duration * frame.time_base) if frame.duration and frame.time_base else 1 / rate
                if not math.isfinite(frame_seconds) or frame_seconds <= 0:
                    frame_seconds = 1 / rate
                source_end = timestamp + frame_seconds
                if end_time is not None and timestamp >= end_time:
                    break
                rendered = None
                while index < frame_count and targets[index] <= timestamp:
                    if previous is not None and abs(targets[index] - previous_time) <= abs(timestamp - targets[index]):
                        packed[index] = previous
                    else:
                        if rendered is None:
                            rendered = render(frame)
                        packed[index] = rendered
                    index += 1
                if index == frame_count:
                    break
                if timestamp >= start_time - 1 / rate:
                    previous = render(frame) if rendered is None else rendered
                    previous_time = timestamp
            if packed is None or previous is None and index < frame_count:
                fail("视频没有可用画面或裁剪起点超出范围", "No usable frames or trim start is outside the video")
            if index < frame_count:
                packed[index:] = previous
            if duration is None:
                seconds = min(source_end, end_time) if end_time is not None else source_end
                count = max(1, round(min(15, seconds - start_time) * 24))
                packed = packed[:count]
    except av.FFmpegError as error:
        raise ValueError("视频无法解码 / Unable to decode video") from error
    return torch.from_numpy(packed).float().div_(255), w, h
