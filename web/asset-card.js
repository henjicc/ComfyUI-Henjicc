const paths = {
    upload: "M12 16V3M7 8l5-5 5 5M4 15v6h16v-6",
    refresh: "M3 12a9 9 0 0 1 15.5-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.4L3 16M3 21v-5h5",
    edit: "M16 3l5 5M4 20l4-1L21 6l-5-5L3 14l-1 7z",
    clipboard: "M9 4H5v17h14V4h-4M9 3h6v4H9zM8 12h8M8 16h6",
    folder: "M3 6h7l2 2h9v12H3zM3 6V4h7l2 2",
    image: "M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M15 8h.01",
    library: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    plus: "M12 5v14M5 12h14",
    video: "M3 5h13v14H3zM16 10l5-3v10l-5-3",
    close: "M6 6l12 12M6 18L18 6",
    check: "M5 12l4 4L19 6",
    star: "M12 3l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.6l-5.7 3 1.1-6.4L2.8 9.7l6.4-.9z",
    replace: "M4 7h13l-3-3M20 17H7l3 3M17 7l-3 3M7 17l3-3",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    eyeOff: "M3 3l18 18M9 5a12 12 0 0 1 3 0c6 0 10 7 10 7a20 20 0 0 1-4 5M6 6a20 20 0 0 0-4 6s4 7 10 7a12 12 0 0 0 4-1",
    audio: "M9 18V5l11-2v13M9 7l11-2M9 18a3 3 0 1 1-3-3c2 0 3 1 3 3M20 16a3 3 0 1 1-3-3c2 0 3 1 3 3",
    soundOn: "M3 9v6h4l5 4V5L7 9H3M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14",
    soundOff: "M3 9v6h4l5 4V5L7 9H3M16 9l6 6M16 15l6-6",
    previous: "M15 5l-7 7 7 7",
    next: "M9 5l7 7-7 7",
    lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
    unlock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0M12 14v3",
};

export function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[name]); svg.append(path);
    return svg;
}

export function iconButton(name, label, action, disabled = false) {
    const button = document.createElement("button"); button.type = "button";
    button.className = "asset-action"; button.setAttribute("aria-label", label); button.disabled = disabled;
    button.append(icon(name));
    button.addEventListener("click", e => { e.stopPropagation(); action(); });
    button.addEventListener("dblclick", e => e.stopPropagation());
    return button;
}

export function createAssetCard({ type, label, url, busy, enabled = true, current = false, previewOnClick = false, onActivate, onReference, onPreview, onReplace, onUpload, onPaste, onRemove, onToggle, t }) {
    const card = document.createElement("article"); card.className = "asset-card";
    card.dataset.enabled = String(enabled); card.dataset.current = String(current);
    const frame = document.createElement("div"); frame.className = "asset-frame"; frame.tabIndex = busy ? -1 : 0;
    frame.setAttribute("role", "button"); frame.setAttribute("aria-label", t("预览 {name}", { name: label }));
    frame.setAttribute("aria-disabled", String(!!busy));
    if (onActivate) { frame.setAttribute("aria-pressed", String(current)); frame.addEventListener("click", () => { if (!busy) onActivate(); }); }
    frame.addEventListener(previewOnClick ? "click" : "dblclick", () => { if (!busy) onPreview(); });
    frame.addEventListener("keydown", e => {
        if (["Enter", " "].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (!busy) onPreview(); }
    });
    const visual = type === "audio" ? icon("audio") : document.createElement(type === "image" ? "img" : "video");
    visual.classList.add("asset-visual");
    if (type === "image") { visual.alt = ""; visual.loading = "lazy"; }
    if (type === "video") { visual.muted = true; visual.preload = "metadata"; }
    if (type !== "audio" && url) visual.src = url;
    visual.draggable = false;
    const shade = document.createElement("span"); shade.className = "asset-shade";
    frame.append(visual, shade); card.append(frame);
    const number = document.createElement(onReference ? "button" : "span"); number.className = "asset-number"; number.textContent = label;
    if (onReference) {
        number.type = "button"; number.disabled = !!busy;
        number.setAttribute("aria-label", t("引用 {name}", { name: label }));
        number.addEventListener("click", e => { e.stopPropagation(); onReference(); });
        number.addEventListener("dblclick", e => e.stopPropagation());
    }
    const actions = document.createElement("div"); actions.className = "asset-actions";
    if (onToggle) {
        const toggle = iconButton(enabled ? "eye" : "eyeOff", t(enabled ? "停用 {name}" : "启用 {name}", { name: label }), onToggle, busy);
        toggle.setAttribute("aria-pressed", String(enabled)); toggle.classList.add("asset-toggle"); actions.append(toggle);
    }
    if (onUpload) {
        actions.append(iconButton("upload", t("上传替换 {name}", { name: label }), onUpload, busy));
        if (onPaste) actions.append(iconButton("clipboard", t("从剪贴板替换 {name}", { name: label }), onPaste, busy));
        actions.append(iconButton("library", t("从资源库替换 {name}", { name: label }), onReplace, busy));
        const topActions = document.createElement("div"); topActions.className = "asset-actions asset-top-actions";
        topActions.append(iconButton("close", t("移除 {name}", { name: label }), onRemove, busy));
        card.append(topActions);
    } else actions.append(iconButton("replace", t("替换 {name}", { name: label }), onReplace, busy), iconButton("close", t("移除 {name}", { name: label }), onRemove, busy));
    card.append(number, actions);
    return { card, frame, visual };
}
