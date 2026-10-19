// Resolve only sources whose geometry is known without executing nodes.
export function watchReferenceSource(node, changed) {
    const field = { LoadImage: "image", HenjiccSuperLoader: "media", ComfySwitchNode: "switch" }[node.comfyClass];
    if (!field) return;
    const previous = node.onWidgetChanged;
    node.onWidgetChanged = function (...args) {
        const result = previous?.apply(this, args);
        if (args[0] === field) changed();
        return result;
    };
}

export function referenceImagePath(prompt, link, seen = new Set()) {
    if (!Array.isArray(link) || link.length !== 2) return null;
    const [id, slot] = link, key = `${id}:${slot}`;
    if (seen.has(key) || seen.size >= 64) return null;
    seen.add(key);
    const node = prompt[id], fields = node?.inputs ?? {};
    if (node?.class_type === "LoadImage" && slot === 0) {
        if (typeof fields.image !== "string" || /\[(?:temp|output)\]$/.test(fields.image)) return null;
        return fields.image.replace(/\s*\[input\]$/, "") || null;
    }
    if (node?.class_type === "HenjiccQwenReferenceList" && slot === 2)
        return mediaPath(prompt, fields.media, seen);
    if (node?.class_type === "ComfySwitchNode" && slot === 0 && typeof fields.switch === "boolean")
        return referenceImagePath(prompt, fields[fields.switch ? "on_true" : "on_false"], seen);
    return null;
}

function mediaPath(prompt, link, seen) {
    if (!Array.isArray(link)) return null;
    const [id, slot] = link, key = `media:${id}:${slot}`;
    if (seen.has(key) || seen.size >= 64) return null;
    seen.add(key);
    const node = prompt[id], fields = node?.inputs ?? {};
    if (node?.class_type === "HenjiccVisualPrompt" && slot === 2) return mediaPath(prompt, fields.media, seen);
    if (node?.class_type !== "HenjiccSuperLoader" || slot !== 0) return null;
    try {
        return JSON.parse(fields.media).items.find(item => /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i.test(item.path))?.path ?? null;
    } catch { return null; }
}

// A graph edit invalidates completed entries, including same-path replacements.
// Concurrent boards share one read; failures never poison the cache.
export function createImageSizeReader(fetchInfo) {
    const cache = new Map();
    const read = path => {
        if (cache.has(path)) return cache.get(path);
        const pending = Promise.resolve().then(() => fetchInfo(path)).then(info => {
            if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width <= 0 || info.height <= 0)
                throw new Error("无法读取参考图尺寸");
            return [info.width, info.height];
        }).catch(error => { if (cache.get(path) === pending) cache.delete(path); throw error; });
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(path, pending);
        return pending;
    };
    read.clear = () => cache.clear();
    return read;
}
