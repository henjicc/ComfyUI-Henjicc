"""Prompt presets and the single sizing authority shared by execution and preview."""

import math

PRESETS = {
    "character_card": {
        "template": "制作同一角色的专业角色卡，浅灰白无缝背景。左侧约30%为面部与肩部身份特写，右侧依次排列正面、严格90度侧面、背面三个等大全身视图。完整显示头顶和鞋底并对齐，脸型、发型、体型、服装和配饰保持一致。背面不露出脸，侧面不转向镜头。均匀光线，无文字、边框、额外人物。\n人物描述与额外要求：{prompt}",
        "width": 2752, "height": 1536,
    },
    "three_views": {
        "template": "制作同一角色的三视图，浅灰白无缝背景。从左到右依次为正面、严格90度侧面、背面，三个等大全身视图，完整显示头顶与鞋底并分别对齐。人物身份、发型、服装和配饰一致。背面不露出脸，侧面不转向镜头。无文字、边框、额外人物。\n人物描述与额外要求：{prompt}",
        "width": 2752, "height": 1536,
    },
    "anime_to_realistic": {
        "name": "动漫转写实",
        "mode": "reference",
        "template": (
            "将输入图片整体转换为高度写实、真实可信的现实风格，使画面中的人物、服装、道具、环境与光影都像真实世界中实际存在并被拍摄下来的一样。"
            "以原图为基础，保留主体的核心辨识特征、整体构图、姿态、神态、氛围以及主要视觉元素，但不要求机械式原样复制，允许在保持原图神韵和识别度的前提下进行合理变化与重建。"
            "对于人物，需要将原图中二次元、古画或其他非写实风格里的夸张、概括、符号化表现转化为符合现实规律的真实形象，根据真实的人体解剖、面部结构、五官比例、骨骼肌肉关系和空间透视，对脸型、五官、头身比例、肢体结构等内容进行自然、适度、合理的调整，使其更符合现实中的真人状态，同时尽量保留人物原有的气质、神情、年龄感、身份感和独特特征，避免改得面目全非，也避免变成千篇一律的网红脸或过度美化的效果。"
            "对于服装、配饰、发型、道具以及周围环境，同样要全部进行写实化处理，将原图中的概念化、装饰化、平面化表达转化为真实世界中具有可信材质、结构和细节的形态，让布料拥有真实的褶皱、厚度、纹理和穿着逻辑，让金属、木材、石材、皮革、植物、建筑等元素具有符合物理特性的真实质感，让环境中的空间关系、远近层次、透视逻辑、光照方向、阴影变化和空气感都自然成立。"
            "若原图来自古画、插画、漫画或其他特定艺术风格，应保留其原本的文化背景、时代特征、服饰形制、场景特征和整体意境，只对不符合现实的结构与材质表现进行写实化重建，不要随意改变题材设定、时代属性或文化气质。"
            "最终效果应当是，在尽可能延续原图核心特征与视觉印象的基础上，把整张图片完整地重建成一幅真实感很强的画面，不仅人物变得写实，人物周围的服装、道具和环境也都同步写实化，整体细节丰富、结构合理、材质可信、光影统一、空间自然，没有明显的动漫感、绘画感、古画笔触感、塑料感、廉价美颜感或不自然的人工生成痕迹。"
        ),
    },
}
PROFILES = {"qwen21": (32, 4096, 4_300_000), "general": (8, 8192, 16_777_216)}


def number(value, name, low, high, integer=False):
    if (type(value) not in ((int,) if integer else (int, float))
            or not math.isfinite(value) or not low <= value <= high):
        raise ValueError(f"{name} 超出范围 / out of range ({low}–{high})")
    return value


def resolution(mode="preset", profile="qwen21", width=2048, height=2048,
               megapixels=4.2, fit=True, preset=None, image_size=None, alignment="auto"):
    if mode not in ("preset", "custom", "reference") or profile not in PROFILES or type(fit) is not bool:
        raise ValueError("尺寸模式无效 / Invalid sizing mode")
    number(width, "width", 8, 65536, True)
    number(height, "height", 8, 65536, True)
    number(megapixels, "megapixels", .001, 64)
    grid, max_side, max_pixels = PROFILES[profile]
    if alignment not in ("auto", "2", "8", "16", "32"):
        raise ValueError("尺寸对齐倍数无效 / Invalid dimension alignment")
    if alignment != "auto":
        grid = math.lcm(grid, int(alignment)) if profile == "qwen21" else int(alignment)
    budget_pixels = min(max_pixels, megapixels * 1_000_000)
    minimum = max(8, grid)
    if budget_pixels < minimum * minimum:
        raise ValueError("像素预算不足以容纳最小尺寸 / Pixel budget is below the minimum aligned size")
    source = "custom"
    # A connected, populated preset owns dimensions. Disconnect it to return
    # to the board's manual/reference settings; old "preset" mode falls back.
    if preset is not None:
        if not isinstance(preset, dict):
            raise ValueError("预设数据无效 / Invalid preset data")
        pw, ph = preset.get("width"), preset.get("height")
        if pw is not None or ph is not None:
            width = number(pw, "preset.width", 8, 65536, True)
            height = number(ph, "preset.height", 8, 65536, True)
            source = "preset"
    if mode == "reference" and source != "preset":
        if not isinstance(image_size, (list, tuple)) or len(image_size) != 2:
            raise ValueError("请连接参考图片 / Connect a reference image")
        iw = number(image_size[0], "image.width", 1, 65536, True)
        ih = number(image_size[1], "image.height", 1, 65536, True)
        factor = math.sqrt(megapixels * 1_000_000 / (iw * ih))
        width, height = iw * factor, ih * factor
        source = "reference"
    requested = (width, height)
    width, height = (max(minimum, int(v / grid + .5) * grid) for v in requested)
    if width > max_side or height > max_side or width * height > budget_pixels:
        if not fit:
            raise ValueError(f"超出尺寸或像素预算 / Sizing limit: {max_side}px, {budget_pixels / 1e6:g} MP")
        factor = min(max_side / width, max_side / height, math.sqrt(budget_pixels / (width * height)))
        width, height = (max(minimum, int(v * factor / grid) * grid) for v in (width, height))
        # A very narrow aspect may hit the minimum grid on its short side.
        if width * height > budget_pixels:
            if width >= height:
                width = max(minimum, int(budget_pixels / height / grid) * grid)
            else:
                height = max(minimum, int(budget_pixels / width / grid) * grid)
    return {"width": width, "height": height, "megapixels": width * height / 1_000_000,
            "adjusted": (width, height) != requested, "source": source, "grid": grid,
            "max_side": max_side, "max_pixels": max_pixels, "budget_pixels": budget_pixels}
