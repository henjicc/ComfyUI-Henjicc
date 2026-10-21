"""V3 image collection nodes; file I/O remains executable without the frontend."""

import torch
from comfy_api.latest import io

from .image_collection import fail


class HenjiccImageListToSlots(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccImageListToSlots", display_name="Image List to Slots", category="Henjicc/Image",
                         is_input_list=True, inputs=[io.Image.Input("images")],
                         outputs=[io.Image.Output(f"image_{i}") for i in range(1, 17)])

    @classmethod
    def execute(cls, images):
        slots = []
        for image in images:
            if (not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[0] < 1
                    or min(image.shape[1:3]) < 1 or image.shape[-1] not in (3, 4)
                    or not image.is_floating_point()):
                fail("图片列表包含无效图片", "Image list contains an invalid image")
            if len(slots) + image.shape[0] > 16:
                fail("当前分配器最多支持 16 张图片", "This slot allocator supports at most 16 images")
            slots.extend(image[i:i+1] for i in range(image.shape[0]))
        return io.NodeOutput(*slots, *([None] * (16 - len(slots))))
