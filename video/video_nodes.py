"""Video input processing, kept separate from model loading and sampling."""

import math
import torch
import folder_paths
from comfy_api.latest import io

from ..image.image_collection import fail
from ..media.media import compile_prompt, load_images, media_kind, resolve_media
from .video_preprocessing import normalize_source


class HenjiccH3RoleInputs(io.ComfyNode):
    """Bridge the composer to the native 24-fps role-replacement path."""

    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccH3RoleInputs", display_name="MiniMax H3 Role Replacement Inputs", category="Henjicc/Video",
                         inputs=[io.Custom("HENJICC_MEDIA").Input("media"),
                                 io.Float.Input("megapixels", default=.4, min=.05, max=1, step=.01),
                                 io.Int.Input("duration", default=5, min=4, max=15, optional=True),
                                 io.Boolean.Input("match_source_duration", default=False, optional=True)],
                         outputs=[io.Image.Output("reference_frames"), io.Int.Output("width"), io.Int.Output("height"),
                                  io.Int.Output("length"), io.Image.Output("video_frames"), io.Image.Output("character"),
                                  io.String.Output("prompt"), io.Float.Output("duration"),
                                  io.Image.Output("images", is_output_list=True)])

    @classmethod
    def execute(cls, media, megapixels, duration=5, match_source_duration=False):
        items = media["items"]
        videos = [item for item in items if media_kind(item["path"]) == "video"]
        images = [item for item in items if media_kind(item["path"]) == "image"]
        if media["profile"] != "minimax_reference":
            fail("角色替换需使用 MiniMax 参考模式", "Role replacement requires MiniMax reference mode")
        if len(videos) != 1:
            fail("角色替换需要一个源视频", "Role replacement requires exactly one source video")
        if len(images) > 9:
            fail("MiniMax H3 原生参考输入最多支持九张图片", "MiniMax H3 native reference inputs support at most nine images")
        if len(items) != len(videos) + len(images) or any(item.get("soundtrack") for item in videos):
            fail("此角色替换流程不支持音频参考或视频原声，请关闭原声",
                 "This role replacement workflow does not support audio references or video soundtracks; turn off Use soundtrack")
        root = folder_paths.get_input_directory()
        path = str(resolve_media(root, videos[0]["path"]))
        character = load_images(root, media)
        images, width, height = normalize_source(path, megapixels,
                                                duration=None if match_source_duration else duration,
                                                max_short_edge=768)
        # Match the host's 17k+5 frame grid; the finalizer removes padding.
        count = images.shape[0]
        length = count + (5 - count) % 17
        refs = torch.cat((images, images[-1:].expand(length - count, -1, -1, -1)), dim=0)
        return io.NodeOutput(refs, width, height, length, images, character[0].image if character else None,
                             compile_prompt(media), count / 24, [item.image for item in character])


class HenjiccH3VideoOutput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccH3VideoOutput", display_name="MiniMax H3 Video Timing", category="Henjicc/Video",
                         inputs=[io.Image.Input("images"), io.Audio.Input("audio"),
                                 io.Float.Input("duration", default=5, min=1 / 24, max=15, step=1 / 24)],
                         outputs=[io.Video.Output("video")])

    @classmethod
    def execute(cls, images, audio, duration):
        from fractions import Fraction
        from comfy_api.latest import InputImpl, Types

        if type(duration) not in (int, float) or not math.isfinite(duration) or not 1 / 24 <= duration <= 15:
            fail("时长需为 1/24–15 秒", "Duration must be from 1/24 to 15 seconds")
        count = round(duration * 24)
        if images.ndim != 4 or images.shape[0] < count:
            fail("生成的视频帧不足，请核对时长连线", "Not enough generated frames; check duration connections")
        samples = round(count / 24 * audio["sample_rate"])
        if audio["waveform"].shape[-1] < samples:
            fail("生成的音频不足，请核对时长连线", "Not enough generated audio; check duration connections")
        frames = images[:count]
        trimmed_audio = {**audio, "waveform": audio["waveform"][..., :samples]}
        video = InputImpl.VideoFromComponents(Types.VideoComponents(images=frames, audio=trimmed_audio, frame_rate=Fraction(24)))
        return io.NodeOutput(video)
