"""V3 nodes connecting the media composer to native model conditioning."""

import av
import folder_paths
import torch
from comfy_api.latest import io

from ..image.image_collection import fail, convert_collection, resize_references
from .media import (EMPTY_MEDIA, compile_prompt, load_audio, load_images, load_video,
                    media_fingerprint, media_kind, parse_media, resolve_media)

Media = io.Custom("HENJICC_MEDIA")


class HenjiccSuperLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccSuperLoader", display_name="Super Input", category="Henjicc/Media",
                         hidden=[io.Hidden.prompt, io.Hidden.unique_id],
                         inputs=[io.String.Input("media", default=EMPTY_MEDIA, multiline=True, dynamic_prompts=False, socketless=True)],
                         outputs=[Media.Output("media"), io.String.Output("prompt"),
                                  io.Boolean.Output("has_images"), io.Boolean.Output("first_last"),
                                  io.Custom("HENJICC_PRESET").Output("preset", display_name="Preset size")])

    @classmethod
    def fingerprint_inputs(cls, media):
        # HTTP requests carry a freshly derived connection stamp. Embedded
        # executors without the request hook or graph cannot safely cache this.
        if cls.hidden is not None and not cls.hidden.prompt and "_connection_profile" not in parse_media(media, prompt={}):
            return float("nan")
        return media_fingerprint(folder_paths.get_input_directory(), media,
                                 prompt=getattr(cls.hidden, "prompt", None), node_id=getattr(cls.hidden, "unique_id", None))

    @classmethod
    def execute(cls, media):
        state = parse_media(media, prompt=getattr(cls.hidden, "prompt", None), node_id=getattr(cls.hidden, "unique_id", None))
        for item in state["items"]:
            path = resolve_media(folder_paths.get_input_directory(), item["path"])
            if media_kind(item["path"]) == "video" and item.get("soundtrack"):
                with av.open(str(path)) as container:
                    if not container.streams.audio:
                        fail("该视频没有原声音轨，请关闭使用原声", "Video has no soundtrack; turn off Use soundtrack")
        return io.NodeOutput(state, compile_prompt(state), any(media_kind(i["path"]) == "image" for i in state["items"]),
                             state["profile"] == "minimax_frames",
                             state.get("preset") or {"width": None, "height": None})


class HenjiccQwenReferenceList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        # Retain the shipped node ID and output order for existing core workflows.
        return io.Schema(node_id="HenjiccQwenReferenceList", display_name="Reference Image Processing", category="Henjicc/Image",
                         inputs=[Media.Input("media"),
                                 io.Float.Input("reference_megapixels", default=1, min=0, max=32, step=.1),
                                 io.Combo.Input("alignment", options=["1", "2", "8", "16", "32", "64"], default="32", optional=True)],
                         outputs=[io.Image.Output("images", is_output_list=True),
                                  io.Boolean.Output("text_mode"), io.Image.Output("first_image"), io.String.Output("prompt")])

    @classmethod
    def execute(cls, media, reference_megapixels, alignment="32"):
        originals = [torch.cat((item.image, (1 - item.mask).unsqueeze(-1)), dim=-1)
                     for item in load_images(folder_paths.get_input_directory(), media)]
        processed = resize_references(originals, reference_megapixels, alignment)
        return io.NodeOutput(processed, not originals, originals[0] if originals else None, compile_prompt(media))


class HenjiccMiniMaxMedia(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccMiniMaxMedia", display_name="MiniMax H3 Media Conditioning", category="Henjicc/Media",
                         inputs=[Media.Input("media"), io.Clip.Input("clip"), io.Vae.Input("vae"), io.Vae.Input("audio_vae"),
                                 io.Int.Input("width", default=832, min=32, max=2048, step=32),
                                 io.Int.Input("height", default=480, min=32, max=2048, step=32),
                                 io.Int.Input("length", default=124, min=5, max=362, step=17),
                                 io.Float.Input("video_megapixels", default=0.4, min=0.05, max=1.0, step=0.05)],
                         outputs=[io.Conditioning.Output("positive"), io.Latent.Output("latent")])

    @classmethod
    def execute(cls, media, clip, vae, audio_vae, width, height, length, video_megapixels):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo, align_frame_count

        if media["profile"] not in {"minimax_reference", "minimax_frames"}:
            fail("请选择 MiniMax 模式", "Select MiniMax mode")
        root = folder_paths.get_input_directory()
        images = load_images(root, media)
        prompt = compile_prompt(media)
        if media["profile"] == "minimax_frames":
            # Native H3 stretches the first frame and center-crops the last.
            # Fit both to the requested canvas first so their geometry agrees.
            frames = convert_collection(images, "batch", "custom", width, height, "contain", "#000000")[0][0] if images else None
            return MiniMaxH3ImageToVideo.execute(clip, vae, prompt, width, height, length,
                                               frames[:1] if frames is not None else None,
                                               frames[1:2] if len(images) > 1 else None)
        videos, soundtracks, audios, budget = {}, {}, {}, [0]
        for item in media["items"]:
            kind = media_kind(item["path"])
            if kind == "image":
                continue
            path = resolve_media(root, item["path"])
            try:
                if kind == "video":
                    index = len(videos)
                    videos[f"ref_video_{index}"] = load_video(path, video_megapixels, budget)
                    if item.get("soundtrack"):
                        audio = load_audio(path)
                        frames = min(videos[f"ref_video_{index}"].shape[0], align_frame_count(length))
                        frames -= (frames - 5) % 17
                        audio = {**audio, "waveform": audio["waveform"][..., :round(frames / 24 * audio["sample_rate"])]}
                        soundtracks[f"ref_video_audio_{index}"] = audio
                else:
                    audios[f"ref_audio_{len(audios)}"] = load_audio(path)
            except av.FFmpegError as error:
                fail(f"无法解码素材：{item['path']}", f"Cannot decode media: {item['path']} ({type(error).__name__})")
        if sum(v.shape[0] / 24 for v in videos.values()) > 15.05:
            fail("参考视频总时长不能超过 15 秒", "Combined reference video duration exceeds 15 seconds")
        if sum(a["waveform"].shape[-1] / a["sample_rate"] for a in audios.values()) > 15.05:
            fail("参考音频总时长不能超过 15 秒", "Combined reference audio duration exceeds 15 seconds")
        return MiniMaxH3ReferenceToVideo.execute(clip, prompt, width, height, length, "match", vae, audio_vae,
                                               {f"ref_image_{i}": image.image for i, image in enumerate(images)}, videos, soundtracks, audios)
