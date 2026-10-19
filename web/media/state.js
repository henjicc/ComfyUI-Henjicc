export const profiles = { general: "通用素材", qwen: "千问图片", minimax_reference: "MiniMax H3 参考生视频", minimax_frames: "MiniMax H3 首尾帧" };

// Resolve only existing per-kind ordinals; persisted references keep stable IDs.
export function referenceMatches(text, refs) {
    const pattern = /<\s*(image|picture|video|audio|图片|图像|视频|音频)\s*([1-9]\d*)\s*>|(图片|图像|视频|音频)\s*([1-9]\d*)/gi;
    const names = { image: "image", picture: "image", video: "video", audio: "audio", 图片: "image", 图像: "image", 视频: "video", 音频: "audio" };
    const groups = { image: [], video: [], audio: [] };
    for (const ref of refs) groups[ref.track === "audio" ? "audio" : kind(ref.path)].push(ref);
    return [...text.matchAll(pattern)].flatMap(match => {
        const ref = groups[names[(match[1] ?? match[3]).toLowerCase()]][Number(match[2] ?? match[4]) - 1];
        return ref ? [{ start: match.index, end: match.index + match[0].length, ref, bracketed: !!match[1] }] : [];
    });
}

export function referenceParts(text, refs) {
    const parts = []; let offset = 0;
    for (const match of referenceMatches(text, refs)) {
        if (match.start > offset) parts.push(text.slice(offset, match.start));
        parts.push({ ref: match.ref.ref, track: match.ref.track }); offset = match.end;
    }
    if (offset < text.length) parts.push(text.slice(offset));
    return parts;
}

export function normalizePromptReferences(state) {
    const refs = references(state, () => "");
    return state.prompt.flatMap(part => typeof part === "string" ? referenceParts(part, refs) : [part]);
}
export function kind(path) {
    const suffix = path.split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"].includes(suffix)) return "image";
    if (["mp4", "mov", "webm", "mkv"].includes(suffix)) return "video";
    if (["wav", "mp3", "flac", "ogg", "m4a"].includes(suffix)) return "audio";
    throw new Error("不支持的素材格式");
}
export function parseMedia(value) {
    const state = JSON.parse(value);
    if (state?.version !== 1 || !Object.hasOwn(profiles, state.profile) || !Array.isArray(state.items) || !Array.isArray(state.prompt)) throw new Error("素材数据格式无效");
    const ids = new Set();
    for (const item of state.items) {
        if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.path !== "string") throw new Error("素材数据格式无效");
        kind(item.path); ids.add(item.id);
    }
    for (const part of state.prompt) if (typeof part !== "string" && (!part || typeof part.ref !== "string" || !["main", "audio"].includes(part.track ?? "main"))) throw new Error("素材数据格式无效");
    state.prompt = normalizePromptReferences(state);
    return state;
}
export function references(state, t) {
    const entries = [], counts = { image: 0, video: 0, audio: 0 };
    for (const type of ["image", "video", "audio"]) for (const item of state.items.filter(i => kind(i.path) === type)) {
        const n = ++counts[type];
        let label = t({ image: "图片 {n}", video: "视频 {n}", audio: "音频 {n}" }[type], { n });
        if (state.profile === "minimax_frames" && type === "image" && n <= 2) label += ` · ${t(n === 1 ? "首帧" : "尾帧")}`;
        entries.push({ ref: item.id, track: "main", label, path: item.path });
        if (type === "video" && item.soundtrack) entries.push({ ref: item.id, track: "audio", label: t("音频 {n} · 视频原声", { n: ++counts.audio }), path: item.path });
    }
    return entries;
}
export function moveMedia(state, id, target) {
    const index = state.items.findIndex(item => item.id === id);
    if (index < 0 || target < 0 || target >= state.items.length) return;
    state.items.splice(target, 0, state.items.splice(index, 1)[0]);
}
export function replaceMedia(state, id, path, previousPath) {
    const item = state.items.find(item => item.id === id);
    if (!item || item.path !== previousPath) throw new Error("素材已变化，请重新选择");
    if (kind(path) !== kind(item.path)) throw new Error("请选择相同类型的素材");
    item.path = path;
}
export function mediaError(state) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const item of state.items) counts[kind(item.path)]++;
    if (state.items.length > 24) return "最多添加 24 个素材";
    if (["qwen", "minimax_frames"].includes(state.profile) && (counts.video || counts.audio)) return "当前模式只能使用图片";
    if (state.profile === "qwen" && counts.image > 10) return "千问最多使用 10 张参考图";
    if (state.profile === "minimax_frames" && counts.image > 2) return "首尾帧模式最多使用 2 张图片";
    if (state.profile === "minimax_reference" && (counts.image > 9 || counts.video > 3 || counts.audio > 3 || state.items.length > 12)) return "MiniMax 参考素材超过上限";
    for (const part of state.prompt) if (typeof part !== "string") {
        const item = state.items.find(i => i.id === part.ref);
        if (!item || (part.track === "audio" && !(kind(item.path) === "video" && item.soundtrack))) return "请移除失效的提示词引用";
    }
    return "";
}
