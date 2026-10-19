"""Henjicc's ComfyUI extensions; the native LoadImage implementation is untouched."""

from comfy_api.latest import ComfyExtension

from .library.image_library import register_routes
from .image.image_nodes import HenjiccImageListToSlots
from .media.media_nodes import HenjiccSuperLoader, HenjiccQwenReferenceList, HenjiccMiniMaxMedia
from .media.media import prepare_media_prompt
from .video.video_nodes import HenjiccH3RoleInputs, HenjiccH3VideoOutput
from .image.preset_nodes import HenjiccResolutionBoard, register_preset_routes
from .audio.music_nodes import HenjiccAudioMix
from .text.omni_nodes import HenjiccOmniPrompt
from .text.visual_prompt_nodes import HenjiccVisualPrompt

WEB_DIRECTORY = "./web"


class HenjiccExtension(ComfyExtension):
    async def on_load(self):
        register_routes()
        register_preset_routes()
        from server import PromptServer
        PromptServer.instance.add_on_prompt_handler(prepare_media_prompt)

    async def get_node_list(self):
        return [HenjiccImageListToSlots, HenjiccSuperLoader, HenjiccQwenReferenceList,
                HenjiccMiniMaxMedia, HenjiccH3RoleInputs, HenjiccH3VideoOutput,
                HenjiccAudioMix, HenjiccResolutionBoard,
                HenjiccOmniPrompt, HenjiccVisualPrompt]


async def comfy_entrypoint():
    return HenjiccExtension()
