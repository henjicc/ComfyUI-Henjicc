"""Bounded, on-demand audio thumbnails cached in the ComfyUI user directory."""

from hashlib import sha256
from pathlib import Path
import threading
import time
import uuid

from PIL import Image, ImageDraw

_lock = threading.Lock()


def waveform(path, cache):
    import av
    import numpy as np

    path, cache = Path(path), Path(cache)
    stat = path.stat()
    if stat.st_size > 512 * 1024**2:
        raise ValueError("单个素材不能超过 512 MB")
    key = sha256(f"wave-v1:{path}:{stat.st_mtime_ns}:{stat.st_size}".encode()).hexdigest()
    target = cache / f"{key}.webp"
    with _lock:
        if target.is_file():
            return target.read_bytes()
        peaks, samples = [], 0
        deadline = time.monotonic() + 30
        try:
            with av.open(str(path)) as container:
                if not container.streams.audio:
                    raise ValueError("音频没有可读音轨")
                resampler = av.AudioResampler(format="fltp", layout="mono", rate=8000)
                for frame in container.decode(audio=0):
                    if time.monotonic() > deadline:
                        raise ValueError("音频波形生成超时")
                    if frame.samples > 2_000_000 or len(frame.layout.channels) > 32:
                        raise ValueError("音频解码数据过大")
                    for mono in resampler.resample(frame):
                        values = np.nan_to_num(np.abs(mono.to_ndarray().reshape(-1)), nan=0, posinf=1, neginf=0)
                        values = values[: max(0, 8000 * 1200 - samples)]
                        samples += len(values)
                        for start in range(0, len(values), 400):
                            peaks.append(float(values[start:start + 400].max()))
                    if samples >= 8000 * 1200:
                        break
        except av.FFmpegError as error:
            raise ValueError("音频无法生成波形") from error
        if not peaks:
            raise ValueError("音频没有可读音轨")
        image = Image.new("RGBA", (640, 160))
        draw = ImageDraw.Draw(image)
        bins = np.array_split(np.array(peaks), min(320, len(peaks)))
        maximum = max(max(peaks), .01)
        for index, values in enumerate(bins):
            height = max(1, min(70, int(float(values.max()) / maximum * 70)))
            x = int((index + .5) * 640 / len(bins))
            draw.line((x, 80 - height, x, 80 + height), fill=(110, 175, 240, 255), width=2)
        cache.mkdir(parents=True, exist_ok=True)
        temporary = cache / f"{key}-{uuid.uuid4().hex}.tmp"
        try:
            image.save(temporary, format="WEBP", lossless=True)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        # Keep only generated waveforms, bounded to 256 small thumbnails.
        entries = sorted(cache.glob("*.webp"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        for entry in entries[256:]:
            if len(entry.stem) == 64 and all(c in "0123456789abcdef" for c in entry.stem):
                entry.unlink(missing_ok=True)
        return target.read_bytes()
