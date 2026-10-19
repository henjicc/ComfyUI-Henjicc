"""Timestamped contact sheets for the host's image-only Qwen3-VL path."""

import math
import av
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont, ImageOps

from ..media.media import compile_prompt, media_kind, reference_labels, resolve_media

VISION_TOKEN = "<|vision_start|><|image_pad|><|vision_end|>"
# Adapt the author guidance to a concise raw Ref2VA prompt, not the official
# six-section rewrite report. Sources are linked in README.
H3_SWAP_INSTRUCTIONS = """你是 MiniMax H3 Ref2VA 角色替换提示词编辑器，不是素材描述助手。
把用户简短要求改写为可直接送入 H3 和 Character Swap LoRA 的提示词。输出必须与用户输入的要求使用同一种语言；用户输入中文就输出中文，输入英文就输出英文，不翻译成其他语言。语言以最后的“用户要求”为准，不受素材说明、参考标签或本系统指令语言影响。
先在内部确认：谁被替换、参考图片提供什么、源视频提供什么，以及什么必须保持；不要输出思考过程。
规则：
1. 保持用户原意与范围。首句明确只替换指定人物，用用户语言表达“只替换”；视频只有一位主体时指明该主体，多人但未指定时不擅自选择或替换全部。
2. 输入 <imageN> 在输出写作 <Picture N>；<videoN> 写作 <Video N>，编号严格对应实际素材，不能虚构引用。多张图片时，按用户要求分别说明每张图提供的身份、服装、配饰或其他依据，保留每个被用户引用的图片编号和用途。例如第一张提供角色身份、第二张提供墨镜外观时，两者都要写入，不得只保留第一张，也不能将第二张的其他外观覆盖角色身份。
3. 图片是替换人物身份的首要依据，不是仅供风格参考。身份描述优先面部和整个头部，其次才是身体服饰。输出必须明确要求脸型、五官相对布局与比例、发型与 <Picture N> 中同一角色一致，并在全身、近景、侧面及转场前后保持同一身份，不能逐镜头换脸或融合源人物的面容。角色卡的多视图属于同一个角色，不生成多个角色，也不展示白底、角色卡拼图、文字或参考图布局。
4. 视频提供源场景、人物位置与尺度、姿势、动作先后与节奏、构图、镜头变化和已有转场。保留背景、照明、其他人物及动作所需的手持道具和交互对象；除非用户明确要求，不添加动作或镜头、不反转动作方向、不删改道具。默认替换角色服装来自图片，不能要求保留源视频主体的服装，也不能用“所有元素不变”抵消人物替换。
5. 从参考图片选择2–4个清楚可见、能区分人物的面部或头部特征写入提示词，优先脸部轮廓与下颌、明显的眼眉/鼻唇特征及其相对布局、发色与发型结构、刘海或发际线；仅描述有把握的可见特征，不机械填满五官清单。身体、服装仅用一句大致概括主要轮廓或款式，不逐项展开身材、饰品、装饰及鞋子。拿不准的颜色、脸部形状或细节不写，只要求与参考图一致；不猜年龄、国籍或身份名称，不把双发髻写成猫耳，不把刺绣猜成蝴蝶结。图片依据优先于文字概括，文字不得重新设计角色，不能把某一静止表情锁定为整段视频的固定表情。用户明确提供的外观修改优先。单张角色图没有时间轴，不能编时间戳。源视频只提供动作、姿势与构图，不把源人物的身份、发型或服装迁给替换角色，也不猜精确切点。
6. 本节点不理解声音，因此不描述或承诺复制音乐、对白、环境声和音色。不添加原视频里无法确认的情绪或动机。不添加 LoRA 触发词、步数、强度、分辨率等执行参数。
7. 输出只有一段简洁、完整的提示词，依次写：只替换谁及参考图片；图片中实际可见的2–4个面部/头部特征（不能只用“面部特征与图片一致”代替具体描述）；身体服装一句概括；身份跨镜头一致性；源视频动作与场景保留要求；禁止显示参考布局。没有把握的细节省略。正文与用户要求同语言，<Picture N>、<Video N> 等机器引用标签保持原样。无需标题、分析、JSON、Markdown、六段报告或中英双份；无需复述全部逐帧内容。用户明确指定的修改优先于默认保留要求。
输出前在内部校对外观词：头顶的两个发髻是头发造型，不是猫耳；无法确认动物耳朵或头饰时不要写“猫耳”。“清晰的眉眼间距”等泛泛说法不是人物特征，改写为确实可见的具体形态，无法确认则省略。宁可少写一个特征，也不要猜测。不要输出这段校对过程。"""
VISUAL_INSTRUCTIONS = (
    "仅分析提供的视觉素材，音频及视频原声全部忽略。保留图片/视频编号。"
    "视频以抽帧拼图提供，每格时间是相对视频开头的实际秒数；按从左到右、从上到下阅读。"
    "不同拼图可以属于同一视频的连续分段，拼图不是原视频中的同时画面。"
    "只能根据采样帧判断运动，不推断采样间遗漏的动作；画面不变时明确说静止。"
    "用户文字是要求而不是已经观察到的事实；不编造声音、对白或未显示的细节。"
    "正文与最后的用户要求使用同一种语言；中文输入输出中文，英文输入输出英文。"
    "素材引用标签保持原样，不输出双语版本。只输出结果。"
)

TASK_INSTRUCTIONS = {
    "auto": "",
    "describe": "结合视觉素材回答用户问题。准确描述可见内容，不编造无法判断的细节。",
    "qwen_auto": "将用户要求优化为千问图片生成或编辑提示词。根据后面的实际参考图片数量判断：没有参考图片时写文生图提示词，明确主体、构图、环境、光线和用户指定风格，不虚构参考图片；有参考图片时写图片编辑提示词，明确修改对象、修改内容和需要保留的部分，保留实际素材引用编号。参考图身份和外观优先，不重新设计角色，不无故改变背景、动作或服装。不要添加用户未要求的元素、相机型号、质量口号或执行参数。只输出可直接使用的提示词。",
    "h3_swap": H3_SWAP_INSTRUCTIONS,
    "h3_reference": "将用户要求优化为 MiniMax H3 参考生视频提示词。明确参考素材分别提供人物外观、场景或动作，以主体、动作先后、环境和镜头为重点，保持用户原意；不新增未要求的分镜、对白或人物。输出引用 <imageN> 转为 <Picture N>，<videoN> 转为 <Video N>，编号不变。只输出可直接使用的提示词。",
    "general": "优化用户的生成提示词，使主体、目标、动作、场景及保留要求清楚且连贯。结合可见素材消除歧义，保持用户原意和引用编号；不猜测无法确认的细节，不增加未要求的元素、执行参数或风格。只输出优化后的提示词，不输出分析、标题或说明。",
    "custom": "",
}


def resolve_task(task, prompt, node_id):
    """Inspect the host's flattened graph; never infer a target from filenames."""
    if task != "auto":
        return task
    detected = set()
    pending, visited = [(str(node_id), slot) for slot in (0, 2)], set()
    targets = {
        "TextEncodeQwenImage21": "qwen_auto", "TextEncodeQwenImageEdit": "qwen_auto",
        "TextEncodeQwenImageEditPlus": "qwen_auto",
        "HenjiccH3RoleInputs": "h3_swap", "HenjiccMiniMaxMedia": "h3_reference",
        "MiniMaxH3ReferenceToVideo": "h3_reference", "MiniMaxH3ImageToVideo": "h3_reference",
    }
    while pending:
        source = pending.pop()
        if source in visited:
            continue
        visited.add(source)
        for consumer_id, node in (prompt or {}).items():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs", {})
            if not any(isinstance(link, list) and len(link) == 2 and
                       str(link[0]) == source[0] and (source[1] is None or link[1] == source[1]) for link in inputs.values()):
                continue
            kind = node.get("class_type")
            if kind in targets:
                detected.add(targets[kind])
            else:
                pending.append((str(consumer_id), None))
    return next(iter(detected)) if len(detected) == 1 else "general"


def image_tensor(image):
    return torch.from_numpy(np.array(image, dtype=np.float32) / 255).unsqueeze(0)


def contact_sheet(frames):
    """Contain each frame; put timestamps outside the image, never over faces."""
    columns = math.ceil(math.sqrt(len(frames)))
    rows = math.ceil(len(frames) / columns)
    width = math.ceil((max(im.width for _, im in frames) + 16) / 32) * 32
    height = math.ceil((max(im.height for _, im in frames) + 48) / 32) * 32
    sheet = Image.new("RGB", (columns * width, rows * height), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=24)
    for index, (timestamp, image) in enumerate(frames):
        left, top = index % columns * width, index // columns * height
        sheet.paste(image, (left + (width - image.width) // 2, top + (height - 40 - image.height) // 2))
        draw.text((left + 8, top + height - 34), f"{timestamp:.2f}s", fill="white", font=font)
    return sheet


def video_sheets(path, fps, segment_seconds, analysis_seconds=None):
    import comfy.model_management as mm
    frames = []
    origin, previous, next_time, segment = None, -1.0, 0.0, 0
    last_frame = None

    def thumbnail(frame):
        if frame.width * frame.height > 32 * 1024**2:
            raise ValueError("视频帧分辨率过大 / Oversized frame")
        image = frame.to_image().convert("RGB")
        if frame.rotation:
            image = image.rotate(frame.rotation, expand=True)
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        return image

    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError("视频没有画面 / Missing video stream")
        stream = container.streams.video[0]
        if stream.width * stream.height > 32 * 1024**2:
            raise ValueError("视频分辨率过大 / Oversized video")
        for count, frame in enumerate(container.decode(video=0)):
            mm.throw_exception_if_processing_interrupted()
            if count >= 18000:
                raise ValueError("视频解码超过限制，请使用较短片段 / Video decode limit exceeded")
            if frame.time is None:
                raise ValueError("视频缺少时间戳 / Missing video timestamps")
            origin = frame.time if origin is None else origin
            elapsed = frame.time - origin
            if elapsed < previous - 1e-6:
                raise ValueError("视频时间戳倒退 / Non-monotonic video timestamps")
            previous = elapsed
            last_frame = frame
            if elapsed + 1e-6 < next_time:
                continue
            current_segment = int(elapsed // segment_seconds)
            if frames and current_segment != segment:
                yield segment, frames
                frames = []
            segment = current_segment
            frames.append((elapsed, thumbnail(frame)))
            # Sparse/VFR sources do not duplicate frames to fill missed slots.
            next_time = (math.floor((elapsed + 1e-6) * fps) + 1) / fps
        # Include the real final frame as well as the regular samples, including
        # tails shorter than one sampling interval.
        if last_frame is not None and frames and previous > frames[-1][0] + 1e-6:
            current_segment = int(previous // segment_seconds)
            if current_segment != segment:
                yield segment, frames
                frames = []
            segment = current_segment
            frames.append((previous, thumbnail(last_frame)))
    if frames:
        yield segment, frames
    else:
        raise ValueError("视频没有可读帧 / Empty video")


def constrain_visuals(images, budget_mp, source_sizes=None):
    """Account for the host's 32-pixel grid, per-image cap and joint budget."""
    budget = int(budget_mp * 1_000_000)
    sizes = []
    for width, height in source_sizes or [image.size for image in images]:
        scale = min(1.0, math.sqrt(12_000_000 / (width * height)))
        sizes.append((max(32, math.floor(width * scale / 32) * 32), max(32, math.floor(height * scale / 32) * 32)))
    total = sum(width * height for width, height in sizes)
    if total > budget:
        scale = math.sqrt(budget / total)
        sizes = [(max(32, math.floor(width * scale / 32) * 32), max(32, math.floor(height * scale / 32) * 32))
                 for width, height in sizes]
    if sum(width * height for width, height in sizes) > budget:
        raise ValueError("素材过多，无法满足像素预算 / Too many visuals for pixel budget")
    # Base sizes keep the allocation fair when earlier sheets have already
    # been reduced while reading a long video. No source is dropped.
    return [ImageOps.pad(image, size, method=Image.Resampling.LANCZOS, color=(24, 24, 24))
            for image, size in zip(images, sizes)]


def prepare_visual_inputs(root, state, fps, segment_seconds, analysis_seconds=0, pixel_budget_mp=16, *, allow_text_only=False):
    import comfy.model_management as mm
    labels = reference_labels(state)
    images, blocks, source_sizes = [], [], []
    if len(state["items"]) > 24:
        raise ValueError("视觉助手最多接收 24 个素材 / At most 24 assets")

    def append(image, description):
        # Cap intermediate sheets before holding multiple assets in memory.
        image = constrain_visuals([image], 12)[0]
        images.append(image)
        source_sizes.append(image.size)
        if sum(im.width * im.height for im in images) > pixel_budget_mp * 2_000_000:
            images[:] = constrain_visuals(images, pixel_budget_mp, source_sizes)
        blocks.append(description + "\n" + VISION_TOKEN)

    for item in state["items"]:
        mm.throw_exception_if_processing_interrupted()
        kind = media_kind(item["path"])
        if kind == "audio":
            continue  # Do not resolve/open audio files or the video's soundtrack.
        path = resolve_media(root, item["path"])
        label = labels[(item["id"], "main")]
        if kind == "image":
            with Image.open(path) as source:
                if source.width * source.height > 32 * 1024**2 or getattr(source, "n_frames", 1) != 1:
                    raise ValueError("图片过大或包含多帧 / Oversized or animated image")
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                append(image, label + "：独立参考图片")
        else:
            for segment, frames in video_sheets(path, fps, segment_seconds):
                append(contact_sheet(frames), f"{label}：视频抽帧拼图，第 {segment + 1} 段，"
                       f"实际采样 {frames[0][0]:.2f}–{frames[-1][0]:.2f}s，目标每秒 {fps} 帧。")
    if not images and not allow_text_only:
        raise ValueError("需要至少一张图片或一个视频，音频不参与 / At least one visual asset required")
    prompt = compile_prompt(state)
    if len(prompt) > 12000:
        raise ValueError("提示词过长 / Prompt too long")
    image_count = sum(media_kind(item["path"]) == "image" for item in state["items"])
    blocks.append(f"实际独立参考图片数量：{image_count}。全部图片和每个视频的完整时段均参与分析，视频按每秒 {fps} 帧抽样并包含最后一帧。用户要求：\n" + prompt)
    return [image_tensor(image) for image in constrain_visuals(images, pixel_budget_mp, source_sizes)], "\n\n".join(blocks)


def generate_visual(clip, images, prompt, task, max_tokens, custom_instruction=""):
    from comfy.text_encoders.qwen3vl import Qwen3VLTokenizer
    from comfy.text_encoders.minimax import MiniMaxH3Tokenizer
    if isinstance(clip.tokenizer, MiniMaxH3Tokenizer):
        raise ValueError("H3 专用 32B 编码器仅有前 50 层，缺少生成尾部（50–63 层、最终归一化和 lm_head），不能直接生成提示词；请为助手选择完整 Qwen3-VL / H3 encoder requires a generation tail")
    # Qwen-Image 2.1 inherits the same visual tokenizer and generate path.
    # A complete raw chat bypasses its conditioning template without changing
    # the shared CLIP or the downstream image-conditioning behavior.
    if not isinstance(clip.tokenizer, Qwen3VLTokenizer):
        raise ValueError("请连接完整 Qwen3-VL：原生 CLIP 加载器支持 stable_diffusion 或 qwen_image（千问 2.1） / Full Qwen3-VL CLIP required")
    system = (custom_instruction if task == "custom" else TASK_INSTRUCTIONS[task]) + " " + VISUAL_INSTRUCTIONS
    template = ("<|im_start|>system\n" + system + "<|im_end|>\n<|im_start|>user\n" +
                prompt + "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n")
    tokens = clip.tokenize(template, images=images, skip_template=True)
    generated = clip.generate(tokens, do_sample=False, max_length=max_tokens, repetition_penalty=1.05, mtp=False)
    text = clip.decode(generated).partition("</think>")
    answer = (text[2] if text[1] else text[0]).strip()
    if not answer:
        raise ValueError("模型返回空文本 / Model returned empty text")
    if len(generated) >= max_tokens and int(generated[-1]) not in {151643, 151645}:
        raise ValueError("输出达到长度上限，请提高最大输出长度 / Output truncated")
    return answer
