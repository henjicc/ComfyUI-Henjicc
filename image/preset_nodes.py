"""V3 presets, sizing, and their bounded same-origin live preview."""

from comfy_api.latest import io

from .generation_presets import PRESETS, resolution

GenerationPreset = io.Custom("HENJICC_PRESET")


class HenjiccResolutionBoard(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccResolutionBoard", display_name="Resolution Board", category="Henjicc/Image",
                         inputs=[io.Combo.Input("mode", options=["preset", "custom", "reference"], default="preset"),
                                 io.Combo.Input("profile", options=["qwen21", "general"], default="qwen21"),
                                 io.Int.Input("width", default=2048, min=8, max=8192, step=8),
                                 io.Int.Input("height", default=2048, min=8, max=8192, step=8),
                                 io.Float.Input("megapixels", default=4.2, min=.001, max=64, step=.1),
                                 io.Boolean.Input("fit", default=True),
                                 GenerationPreset.Input("preset", optional=True, display_name="Preset size"), io.Image.Input("image", optional=True),
                                 io.Combo.Input("alignment", options=["auto", "2", "8", "16", "32"], default="auto", optional=True)],
                         outputs=[io.Int.Output("width"), io.Int.Output("height")])

    @classmethod
    def execute(cls, image=None, **settings):
        if image is not None:
            if len(image.shape) != 4 or min(image.shape[:3]) < 1 or image.shape[-1] not in (3, 4):
                raise ValueError("参考图片尺寸无效 / Invalid reference image shape")
            settings["image_size"] = [int(image.shape[2]), int(image.shape[1])]
        result = resolution(**settings)
        return io.NodeOutput(result["width"], result["height"], ui={"resolution": [result]})


def register_preset_routes():
    from aiohttp import web
    from server import PromptServer
    from ..library.image_library import check_request

    @PromptServer.instance.routes.get("/henjicc/presets")
    async def presets(request):
        check_request(request)
        return web.json_response(PRESETS)

    @PromptServer.instance.routes.post("/henjicc/resolution/preview")
    async def preview(request):
        check_request(request)
        try:
            data = await request.clone(client_max_size=16384).json()
            if not isinstance(data, dict):
                raise ValueError("请求必须是对象 / Request must be an object")
            return web.json_response(resolution(**data))
        except (ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
