"""Audio validation and model-independent mixing."""

import math

import torch

from ..image.image_collection import fail


def audio_waveform(audio, max_seconds=300):
    if not isinstance(audio, dict):
        fail("音频数据无效", "Invalid audio data")
    waveform, rate = audio.get("waveform"), audio.get("sample_rate")
    if (type(rate) is not int or not 1000 <= rate <= 192000 or not isinstance(waveform, torch.Tensor)
            or waveform.ndim != 3 or waveform.shape[0] != 1 or waveform.shape[1] not in (1, 2)
            or not 0 < waveform.shape[-1] <= rate * max_seconds or not waveform.is_floating_point()
            or not torch.isfinite(waveform).all()):
        fail("音频必须为有限的单段单声道或双声道，最长五分钟", "Audio must be finite mono/stereo, one batch, at most five minutes")
    return waveform.detach().cpu().float(), rate


def mix_audio(vocals, backing, vocal_gain_db=0, backing_gain_db=0, vocal_offset=0):
    """Mix at the backing rate/length; offset is manual timing, not beat alignment."""
    import torchaudio

    voice, voice_rate = audio_waveform(vocals)
    music, music_rate = audio_waveform(backing)
    for value, limit, label in ((vocal_gain_db, (-24, 12), "vocal gain"),
                                (backing_gain_db, (-24, 12), "backing gain"),
                                (vocal_offset, (-30, 30), "vocal offset")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not limit[0] <= value <= limit[1]:
            fail("混音音量或时间偏移超出范围", f"Invalid {label}")
    if voice_rate != music_rate:
        voice = torchaudio.functional.resample(voice, voice_rate, music_rate)
    offset = round(vocal_offset * music_rate)
    if offset < 0:
        voice = voice[..., -offset:]
    elif offset:
        voice = torch.nn.functional.pad(voice, (offset, 0))
    length = music.shape[-1]
    voice = torch.nn.functional.pad(voice, (0, max(0, length - voice.shape[-1])))[..., :length]
    mixed = music * (10 ** (backing_gain_db / 20)) + voice * (10 ** (vocal_gain_db / 20))
    peak = mixed.abs().max().item()
    if peak > .98:
        mixed = mixed * (.98 / peak)
    return {"waveform": mixed, "sample_rate": music_rate}
