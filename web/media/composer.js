import { uniqueId } from "../identity.js";
import { ImagePicker } from "../picker/panel.js";
import { translator } from "../picker/i18n.js";
import { kind, parseMedia, profiles, references, referenceMatches, referenceParts, moveMedia, replaceMedia, mediaError } from "./state.js";
import { bindNodeAppearance } from "../node-ui.js";
import { createAssetCard, icon, iconButton } from "../asset-card.js";
import { MediaViewer, mediaViewUrl } from "../media-viewer.js";
import { ReferenceMenu, referenceThumbnail } from "./reference-menu.js";
import { ModeMenu, UploadCard } from "./mode-menu.js";
import { profilesForNode } from "./connection.js";
import { InputPresets } from "./presets.js";
import { syncMediaOutputs } from "./outputs.js";

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

export class MediaComposer {
    constructor({ node, state, app, api }) {
        Object.assign(this, { node, state, app, api });
        this.element = el("section", undefined, "henjicc-media"); this.element.tabIndex = 0;
        this.unbindAppearance = bindNodeAppearance(app, this.element);
        for (const event of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) this.element.addEventListener(event, e => e.stopPropagation());
        this.element.addEventListener("keydown", e => { if (!(e.ctrlKey || e.metaKey)) e.stopPropagation(); });
        this.element.addEventListener("dragover", e => {
            e.preventDefault(); e.stopPropagation();
            if ([...(e.dataTransfer?.types ?? [])].includes("Files")) {
                e.dataTransfer.dropEffect = "copy";
                const target = e.target.closest?.(".media-card");
                this.element.querySelectorAll(".media-card").forEach(card => card.classList.toggle("asset-drop-target", card === target));
                this.element.classList.toggle("media-drop-add", !target);
            }
        });
        this.element.addEventListener("dragleave", e => {
            if (!this.element.contains(e.relatedTarget)) this.clearDropTarget();
        });
        this.element.addEventListener("drop", e => {
            this.dropFiles(e);
        });
        this.paste = e => {
            if (this.disposed || e.defaultPrevented) return;
            const inside = this.element.contains(e.target);
            const selection = this.app.canvas?.selected_nodes ?? {};
            const selected = Object.keys(selection).length === 1 && selection[this.node.id] === this.node;
            // A selected node must not steal clipboard data from another text field.
            if (!inside && (!selected || e.target.closest?.("input, textarea, [contenteditable=true]"))) return;
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length) { e.preventDefault(); e.stopImmediatePropagation(); this.upload(files); }
            else if (this.editor?.contains(e.target)) {
                e.preventDefault(); e.stopImmediatePropagation();
                this.insertText(e.clipboardData.getData("text/plain"));
            }
        };
        document.addEventListener("paste", this.paste, true);
        this.selectionChanged = () => { if (!this.disposed && document.activeElement === this.editor && !this.composing) this.mention(); };
        document.addEventListener("selectionchange", this.selectionChanged);
        this.localeChanged = () => { this.render(); this.syncOutputs(); };
        app.ui.settings.addEventListener("Comfy.Locale.change", this.localeChanged);
        this.render();
    }
    async updateConnection(exported) {
        const revision = this.connectionRevision = (this.connectionRevision ?? 0) + 1;
        if (this.disposed || !this.node.graph) return;
        let profile, detectedProfiles = [], error = "";
        const adapters = new Set();
        try {
            const graph = this.node.graph.rootGraph ?? this.node.graph;
            const { output } = await (exported ?? this.app.graphToPrompt(graph));
            detectedProfiles = profilesForNode(parseMedia(this.state.value).profile, output, graph, this.node, type => adapters.add(type));
            profile = detectedProfiles.find(value => value.startsWith("minimax")) ?? detectedProfiles.find(value => value === "qwen") ?? "general";
        } catch (e) { error = e.message; }
        if (this.disposed || revision !== this.connectionRevision) return;
        const roleOnly = adapters.has("HenjiccH3RoleInputs") && !adapters.has("HenjiccMiniMaxMedia");
        if (profile === this.connectedProfile && roleOnly === this.roleOnly && error === this.connectionError && JSON.stringify(detectedProfiles) === JSON.stringify(this.detectedProfiles)) { this.syncOutputs(); return; }
        this.roleOnly = roleOnly;
        this.detectedProfiles = detectedProfiles;
        this.connectedProfile = profile; this.connectionError = error;
        this.syncOutputs();
        this.render();
    }
    syncOutputs() {
        syncMediaOutputs(this.node, parseMedia(this.state.value), this.detectedProfiles ?? [], translator(this.locale()));
    }
    effectiveData(data) {
        return { ...data, profile: this.connectedProfile ?? "general" };
    }
    locale() { return this.app.ui.settings.getSettingValue("Comfy.Locale") ?? "en"; }
    button(label, action, symbol) {
        const button = el("button", this.t(label)); button.type = "button"; button.disabled = !!this.busy;
        if (symbol) button.prepend(icon(symbol));
        button.addEventListener("click", action); return button;
    }
    change(action, render = true, properties, editGraph) {
        if (this.disposed || !this.node.graph) return;
        try {
            const data = parseMedia(this.state.value);
            action(data);
            const old = this.state.value;
            this.app.canvas?.emitBeforeChange?.();
            this.node.graph.beforeChange?.();
            try {
                this.state.value = JSON.stringify(data); this.state.callback?.(this.state.value);
                this.node.onWidgetChanged?.(this.state.name, this.state.value, old, this.state);
                if (properties) Object.assign(this.node.properties, properties);
                editGraph?.();
                this.syncOutputs();
            } finally {
                this.node.graph.afterChange?.();
                this.app.canvas?.emitAfterChange?.();
            }
            this.node.graph.setDirtyCanvas(true, true);
            if (render) this.render(); else this.updateStatus(data);
        } catch (error) { this.status.textContent = this.t(error.message); }
    }
    add(paths) {
        this.change(state => {
            if (state.items.length + paths.length > 24) throw new Error("最多添加 24 个素材");
            for (const path of paths) { kind(path); state.items.push({ id: uniqueId(), path, soundtrack: false }); }
        });
    }
    clearDropTarget() {
        this.element.classList.remove("media-drop-add");
        this.element.querySelectorAll(".asset-drop-target").forEach(card => card.classList.remove("asset-drop-target"));
    }
    dropFiles(event) {
        event.preventDefault(); event.stopPropagation();
        const replace = event.target.closest?.(".media-card")?.dataset.id;
        this.clearDropTarget();
        if (event.dataTransfer.files.length) return this.upload([...event.dataTransfer.files], replace);
    }
    async upload(files, replace) {
        if (this.busy || this.disposed || !files.length) return;
        const target = replace ? parseMedia(this.state.value).items.find(item => item.id === replace) : null;
        if (replace && !target) return;
        this.busy = true; this.render();
        const paths = []; let error;
        try {
            if (!replace && parseMedia(this.state.value).items.length + files.length > 24) throw new Error("最多添加 24 个素材");
            if (replace && files.length !== 1) throw new Error("每次只能替换一个素材");
            for (const file of files) {
                if (this.disposed) break;
                kind(file.name);
                if (replace && kind(file.name) !== kind(target.path)) throw new Error("请选择相同类型的素材");
                if (file.size > 512 * 1024 * 1024) throw new Error("单个素材不能超过 512 MB");
                const body = new FormData(); body.append("image", file); body.append("type", "input");
                body.append("subfolder", "henjicc"); body.append("overwrite", "false");
                const response = await this.api.fetchApi("/upload/image", { method: "POST", body });
                if (!response.ok) throw new Error(this.t("上传失败 ({status})", { status: response.status }));
                const data = await response.json(); paths.push([data.subfolder, data.name].filter(Boolean).join("/"));
            }
        } catch (e) { error = e instanceof TypeError ? this.t("网络连接失败，请重试") : this.t(e.message); }
        finally { this.busy = false; }
        if (this.disposed) return;
        this.render();
        if (paths.length) {
            if (replace) this.change(s => replaceMedia(s, replace, paths[0], target.path));
            else this.add(paths);
        }
        if (error) this.status.textContent = replace ? error : this.t("已添加 {n} 个素材；{error}", { n: paths.length, error });
    }
    openLibrary(replace) {
        if (this.busy || this.disposed) return;
        const target = replace ? parseMedia(this.state.value).items.find(item => item.id === replace) : null;
        if (replace && !target) return;
        this.picker?.close();
        this.picker = new ImagePicker({ api: this.api, settings: this.app.ui.settings, locale: this.locale(), multiple: !replace,
            mediaKind: target ? kind(target.path) : "all", value: target?.path,
            onSelect: paths => target ? this.change(s => replaceMedia(s, replace, paths, target.path)) : this.add(paths) });
        this.picker.show();
    }
    selectLocal(replace) {
        if (this.busy || this.disposed) return;
        const target = replace ? parseMedia(this.state.value).items.find(item => item.id === replace) : null;
        if (replace && !target) return;
        const input = el("input"); input.type = "file"; input.hidden = true; input.multiple = !replace;
        input.accept = target ? { image: "image/*", video: "video/*", audio: "audio/*" }[kind(target.path)] : "image/*,video/*,audio/*";
        input.addEventListener("change", () => { const files = [...input.files]; input.remove(); this.upload(files, replace); }, { once: true });
        input.addEventListener("cancel", () => input.remove(), { once: true });
        this.element.append(input); input.click();
    }
    async pasteClipboard(replace) {
        if (this.busy || this.readingClipboard || this.disposed) return;
        const target = replace ? parseMedia(this.state.value).items.find(item => item.id === replace) : null;
        if (replace && (!target || kind(target.path) !== "image")) return;
        this.readingClipboard = true;
        this.status.dataset.error = "false";
        this.status.textContent = this.t("正在读取剪贴板…");
        let timeout;
        try {
            if (!navigator.clipboard?.read) throw new Error("浏览器不支持读取剪贴板，请使用 Ctrl+V 粘贴");
            const items = await Promise.race([navigator.clipboard.read(), new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("读取剪贴板超时，请使用 Ctrl+V 粘贴")), 10000);
            })]);
            if (this.disposed || this.busy) return;
            let image;
            for (const item of items) {
                const type = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].find(type => item.types.includes(type));
                if (type) { image = new File([await item.getType(type)], `clipboard-${uniqueId()}.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}`, { type }); break; }
            }
            if (this.disposed || this.busy) return;
            if (!image) throw new Error("剪贴板中没有图片");
            if (replace && parseMedia(this.state.value).items.find(item => item.id === replace)?.path !== target.path)
                throw new Error("素材已变化，请重新选择");
            await this.upload([image], replace);
        } catch (error) {
            if (!this.disposed) {
                this.status.dataset.error = "true";
                this.status.textContent = this.t(error.name === "NotAllowedError" ? "无法读取剪贴板，请允许访问或使用 Ctrl+V 粘贴" : error.message);
            }
        } finally { clearTimeout(timeout); this.readingClipboard = false; }
    }
    openPreview(id) {
        const data = this.effectiveData(parseMedia(this.state.value)), refs = references(data, this.t);
        this.viewer?.close(); this.viewer = new MediaViewer({ api: this.api, t: this.t });
        this.viewer.open(data.items.map(item => ({ ...item, label: refs.find(ref => ref.ref === item.id && ref.track === "main").label })), id);
    }
    updateStatus(data) {
        data = this.effectiveData(data);
        const error = this.connectionError || (this.detectedProfiles ?? []).map(profile => mediaError({ ...data, profile })).find(Boolean) || mediaError(data);
        this.status.dataset.error = !!error;
        this.status.textContent = this.busy ? this.t("正在上传…") : error ? this.t(error) : "";
    }
    render() {
        if (this.disposed) return;
        this.composing = false;
        this.viewer?.close();
        this.referenceMenu?.dispose();
        this.modeMenu?.dispose();
        this.uploadCard?.dispose();
        this.cancelReorder();
        this.presets?.dispose();
        this.t = translator(this.locale()); this.element.setAttribute("aria-label", this.t("超级输入"));
        this.element.querySelectorAll("video, audio").forEach(media => { media.pause(); media.removeAttribute("src"); media.load(); });
        this.status = el("div", "", "media-status"); this.status.setAttribute("role", "status");
        this.element.replaceChildren(this.status);
        let data;
        try { data = parseMedia(this.state.value); }
        catch { this.status.textContent = this.t("素材数据格式无效"); return; }
        data = this.effectiveData(data);
        const toolbar = el("div", undefined, "media-toolbar");
        const detection = el("div", undefined, "media-detection");
        detection.append(el("span", this.t(this.detectedProfiles?.length > 1 ? "按实例识别" : "自动识别"), "media-detection-label"));
        if (data.profile === "minimax_reference" && this.roleOnly) {
            detection.append(el("span", this.t("MiniMax 角色替换"), "media-detection-value"));
        } else if (data.profile.startsWith("minimax")) {
            this.modeMenu = new ModeMenu({ themeFrom: this.element, label: this.t("MiniMax 任务"),
                options: Object.entries(profiles).filter(([value]) => value.startsWith("minimax")).map(([value, name]) => ({ value, label: this.t(name) })),
                value: data.profile, disabled: !!this.busy,
                onSelect: value => { this.connectedProfile = value; this.change(s => { s.profile = value; }); this.modeMenu.button.focus(); },
            });
            detection.append(this.modeMenu.button);
        } else {
            const label = this.connectionError ? this.t("无法自动识别") : data.profile === "qwen"
                ? `${this.t("千问图片")} · ${this.t(data.items.some(item => kind(item.path) === "image") ? "图片编辑" : "文生图")}`
                : this.t("通用素材");
            detection.append(el("span", label, "media-detection-value"));
        }
        detection.dataset.error = !!this.connectionError;
        toolbar.append(detection);
        const strip = el("div", undefined, "media-strip"); strip.setAttribute("aria-label", this.t("素材列表"));
        this.refs = references(data, this.t);
        data.items.forEach((item, index) => {
            const type = kind(item.path), ref = this.refs.find(r => r.ref === item.id && r.track === "main");
            const { card, visual } = createAssetCard({ type, label: ref.label, t: this.t, busy: this.busy, previewOnClick: true,
                url: type === "image" ? this.api.apiURL(`/henjicc/image-library/thumbnail?${new URLSearchParams({ path: item.path })}`) : mediaViewUrl(this.api, item.path),
                onReference: () => this.insertReference(ref), onPreview: () => this.openPreview(item.id),
                onReplace: () => this.openLibrary(item.id), onRemove: () => this.change(s => { s.items = s.items.filter(i => i.id !== item.id); }),
                onUpload: () => this.selectLocal(item.id),
                onPaste: type === "image" ? () => this.pasteClipboard(item.id) : undefined,
            });
            card.classList.add("media-card"); card.draggable = false; card.dataset.id = item.id;
            this.bindReorder(card, item.id);
            card.addEventListener("keydown", e => {
                if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
                    e.preventDefault(); this.change(s => moveMedia(s, item.id, index + (e.key === "ArrowLeft" ? -1 : 1)));
                    this.element.querySelector(`[data-id="${CSS.escape(item.id)}"]`)?.focus();
                }
            }); card.tabIndex = 0; card.setAttribute("aria-label", ref.label);
            visual.addEventListener("error", () => { if (visual.isConnected) this.status.textContent = this.t("素材缺失或浏览器无法预览"); });
            if (type === "video") {
                const sound = iconButton(item.soundtrack ? "soundOn" : "soundOff", this.t("使用原声"),
                    () => this.change(s => { const entry = s.items.find(i => i.id === item.id); entry.soundtrack = !entry.soundtrack; }), this.busy);
                sound.setAttribute("aria-pressed", String(!!item.soundtrack));
                card.querySelector(".asset-actions:not(.asset-top-actions)").prepend(sound);
            }
            strip.append(card);
        });
        this.uploadCard = new UploadCard({ label: this.t("添加素材"),
            disabled: !!this.busy || data.items.length >= 24,
            options: [{ value: "upload", label: this.t("从本地上传"), icon: "upload" },
                { value: "paste", label: this.t("从剪贴板粘贴"), icon: "clipboard" },
                { value: "library", label: this.t("从资源库选择"), icon: "library" }],
            onSelect: value => { if (value === "upload") this.selectLocal(); else if (value === "paste") this.pasteClipboard(); else this.openLibrary(); },
        });
        strip.append(this.uploadCard.element);
        const actions = el("div", undefined, "media-actions");
        actions.append(this.button("从本地上传", () => this.selectLocal(), "upload"),
            this.button("粘贴剪贴板", () => this.pasteClipboard(), "clipboard"),
            this.button("从资源库选择", () => this.openLibrary(), "library"));
        toolbar.append(actions);
        const promptLabel = el("label", this.t("提示词"));
        const promptHeader = el("div", undefined, "media-prompt-header");
        const presetActions = el("div", undefined, "media-actions");
        this.presets = new InputPresets(this);
        presetActions.append(this.button("加载预设", () => this.presets.load()), this.button("保存预设", () => this.presets.save()));
        if (data.preset) presetActions.append(this.button("清除预设", () => this.presets.clear()));
        if (data.preset?.width != null) presetActions.prepend(el("span", `${data.preset.width} × ${data.preset.height}`, "media-preset-size"));
        promptHeader.append(promptLabel, presetActions);
        this.editor = el("div", undefined, "media-prompt"); this.editor.contentEditable = String(!this.busy); this.editor.setAttribute("role", "textbox");
        this.editor.setAttribute("aria-label", this.t("提示词")); this.editor.setAttribute("aria-multiline", "true"); this.editor.spellcheck = false;
        for (const part of data.prompt.flatMap(part => typeof part === "string" ? referenceParts(part, this.refs) : [part]))
            this.editor.append(typeof part === "string" ? document.createTextNode(part) : this.chip(part));
        this.bindPromptEditor();
        this.referenceMenu = new ReferenceMenu({ editor: this.editor, themeFrom: this.element, api: this.api, label: this.t("引用素材"), onSelect: ref => this.insertReference(ref), onHide: () => { this.mentionRange = null; } });
        this.mentionRange = null;
        this.element.replaceChildren(toolbar, strip, promptHeader, this.editor, this.status); this.updateStatus(data);
    }
    bindPromptEditor() {
        const editor = this.editor;
        const current = () => !this.disposed && this.editor === editor;
        const commit = () => {
            if (!current() || this.composing) return;
            this.normalizeReferences(); this.savePrompt();
            if (document.activeElement === editor) this.mention();
        };
        this.composing = false;
        editor.addEventListener("compositionstart", () => {
            if (!current()) return;
            this.composing = true; this.referenceMenu.hide();
        });
        editor.addEventListener("input", e => { if (!e.isComposing) commit(); });
        editor.addEventListener("compositionend", () => {
            if (!current()) return;
            this.composing = false;
            // Chromium may emit its final input after compositionend. Do not
            // rewrite the editable DOM while that commit is still in progress.
            queueMicrotask(commit);
        });
        editor.addEventListener("keydown", e => { if (current()) this.editorKey(e); });
        editor.addEventListener("blur", () => {
            if (!current()) return;
            this.referenceMenu.hide();
            if (!this.composing) { this.normalizeReferences(true); this.savePrompt(); }
        });
    }
    bindReorder(card, id) {
        card.addEventListener("click", event => {
            if (performance.now() < (this.suppressClickUntil ?? 0)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        card.addEventListener("pointerdown", event => {
            if (this.busy || !event.isPrimary || event.button !== 0 || event.target.closest("button, input, textarea")) return;
            const capture = card.querySelector(".asset-frame");
            this.reorder = { card, capture, id, pointer: event.pointerId, x: event.clientX, y: event.clientY, target: id, moved: false };
            capture.setPointerCapture(event.pointerId);
        });
        card.addEventListener("pointermove", event => {
            const drag = this.reorder;
            if (!drag || drag.card !== card || event.pointerId !== drag.pointer) return;
            if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
            drag.moved = true; event.preventDefault(); card.dataset.dragging = "true";
            const target = document.elementsFromPoint(event.clientX, event.clientY).map(node => node.closest?.(".media-card[data-id]")).find(node => node && this.element.contains(node));
            if (target) drag.target = target.dataset.id;
            this.element.querySelectorAll(".media-card[data-id]").forEach(node => { node.dataset.sortTarget = String(node.dataset.id === drag.target); });
            const strip = card.parentElement, bounds = strip.getBoundingClientRect();
            if (event.clientX < bounds.left + 24) strip.scrollLeft -= 12;
            else if (event.clientX > bounds.right - 24) strip.scrollLeft += 12;
        });
        card.addEventListener("pointerup", event => {
            const drag = this.reorder;
            if (!drag || drag.card !== card || event.pointerId !== drag.pointer) return;
            const bounds = card.parentElement.getBoundingClientRect();
            this.cancelReorder();
            if (!drag.moved) return;
            this.suppressClickUntil = performance.now() + 400;
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
            if (drag.target !== id) this.change(state => moveMedia(state, id, state.items.findIndex(item => item.id === drag.target)));
        });
        card.addEventListener("pointercancel", () => this.cancelReorder());
        card.addEventListener("lostpointercapture", () => { if (this.reorder?.card === card) this.cancelReorder(); });
    }
    cancelReorder() {
        const drag = this.reorder; this.reorder = null;
        if (drag?.capture.hasPointerCapture(drag.pointer)) drag.capture.releasePointerCapture(drag.pointer);
        this.element.querySelectorAll(".media-card").forEach(card => { delete card.dataset.dragging; delete card.dataset.sortTarget; });
    }
    normalizeReferences(force = false) {
        const selection = window.getSelection(), range = selection.rangeCount ? selection.getRangeAt(0) : null;
        if (range && !range.collapsed && this.editor.contains(range.commonAncestorContainer)) return;
        const walker = document.createTreeWalker(this.editor, NodeFilter.SHOW_TEXT), nodes = [];
        while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(".media-chip")) nodes.push(walker.currentNode);
        let nextCaret;
        for (const node of nodes) {
            const caret = range?.startContainer === node ? range.startOffset : null;
            const matches = referenceMatches(node.textContent, this.refs).filter(match => force || match.bracketed || match.end !== caret);
            if (!matches.length) continue;
            const fragment = document.createDocumentFragment(); let offset = 0;
            for (const match of matches) {
                const text = document.createTextNode(node.textContent.slice(offset, match.start)); fragment.append(text);
                if (caret !== null && caret >= offset && caret <= match.start) nextCaret = [text, caret - offset];
                const chip = this.chip(match.ref); fragment.append(chip);
                if (caret !== null && caret > match.start && caret <= match.end) nextCaret = [chip, null];
                offset = match.end;
            }
            const tail = document.createTextNode(node.textContent.slice(offset)); fragment.append(tail);
            if (caret !== null && caret >= offset) nextCaret = [tail, caret - offset];
            node.replaceWith(fragment);
        }
        if (nextCaret && document.activeElement === this.editor) {
            const caret = document.createRange();
            if (nextCaret[1] === null) caret.setStartAfter(nextCaret[0]); else caret.setStart(...nextCaret);
            caret.collapse(true); selection.removeAllRanges(); selection.addRange(caret);
        }
    }
    chip(part) {
        const ref = this.refs.find(r => r.ref === part.ref && r.track === (part.track ?? "main"));
        const chip = el("span", undefined, "media-chip"); chip.contentEditable = "false";
        chip.append(referenceThumbnail(ref, this.api), el("span", ref?.label ?? this.t("失效引用")));
        chip.dataset.ref = part.ref; chip.dataset.track = part.track ?? "main"; chip.dataset.missing = !ref;
        return chip;
    }
    readPrompt() {
        const parts = [];
        const append = text => { if (typeof parts.at(-1) === "string") parts[parts.length - 1] += text; else parts.push(text); };
        const walk = parent => { for (const node of parent.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) append(node.textContent);
            else if (node.dataset?.ref) parts.push({ ref: node.dataset.ref, track: node.dataset.track });
            else if (node.nodeName === "BR") append("\n");
            else { if (["DIV", "P"].includes(node.nodeName) && parts.length) append("\n"); walk(node); }
        } }; walk(this.editor); return parts;
    }
    savePrompt() {
        if (this.composing) return;
        const parts = this.readPrompt();
        if (JSON.stringify(parts) === JSON.stringify(JSON.parse(this.state.value).prompt)) return;
        this.change(s => { s.prompt = parts; }, false);
    }
    caretRange() {
        const selection = window.getSelection();
        if (selection.rangeCount && this.editor.contains(selection.getRangeAt(0).commonAncestorContainer)) return selection.getRangeAt(0);
        const range = document.createRange(); range.selectNodeContents(this.editor); range.collapse(false); return range;
    }
    insertText(text) {
        const range = this.caretRange(); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStart(node, node.textContent.length); range.collapse(true);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); this.normalizeReferences(true); this.savePrompt();
    }
    insertReference(ref) {
        if (this.busy) return;
        const range = this.mentionRange ?? this.caretRange(); range.deleteContents();
        const chip = this.chip(ref), space = document.createTextNode(" "); range.insertNode(space); range.insertNode(chip);
        // Keep the caret inside editable text, not at the parent boundary next
        // to contenteditable=false. Chromium IMEs can commit the first Latin
        // key literally when composition starts at that boundary.
        range.setStart(space, space.textContent.length); range.collapse(true);
        this.mentionRange = null; this.referenceMenu.hide(); this.editor.focus({ preventScroll: true });
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        this.savePrompt();
    }
    mention() {
        const range = this.caretRange(), node = range.startContainer;
        this.mentionRange = null;
        const hide = () => this.referenceMenu.hide();
        if (node.nodeType !== Node.TEXT_NODE || !range.collapsed) return hide();
        const text = node.textContent.slice(0, range.startOffset), match = text.match(/@([^\s@]*)$/);
        if (!match) return hide();
        const choices = this.refs.filter(r => r.label.replace(/\s/g, "").toLowerCase().includes(match[1].toLowerCase()));
        if (!choices.length) return hide();
        this.mentionRange = range.cloneRange(); this.mentionRange.setStart(node, range.startOffset - match[0].length);
        this.referenceMenu.show(choices, range);
    }
    editorKey(e) {
        if (e.isComposing || this.composing) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === "z" || (!e.shiftKey && e.key.toLowerCase() === "y"))) {
            // The host's capture listener owns graph history. Native editable
            // history would emit another input and undo that transaction first.
            e.preventDefault(); this.referenceMenu.hide(); return;
        }
        if (this.referenceMenu.open) {
            if (["ArrowDown", "ArrowUp"].includes(e.key)) {
                e.preventDefault(); this.referenceMenu.move(e.key === "ArrowDown" ? 1 : -1);
            } else if (["Enter", "Tab"].includes(e.key)) { e.preventDefault(); this.referenceMenu.choose(); }
            else if (e.key === "Escape") { e.preventDefault(); this.referenceMenu.hide(); this.mentionRange = null; }
        }
    }
    dispose() {
        this.presets?.dispose();
        this.viewer?.close();
        this.referenceMenu?.dispose();
        this.modeMenu?.dispose();
        this.uploadCard?.dispose();
        this.cancelReorder();
        this.unbindAppearance();
        this.disposed = true; document.removeEventListener("paste", this.paste, true);
        document.removeEventListener("selectionchange", this.selectionChanged);
        this.app.ui.settings.removeEventListener("Comfy.Locale.change", this.localeChanged); this.picker?.close();
        this.element.querySelectorAll("video, audio").forEach(media => { media.pause(); media.removeAttribute("src"); media.load(); });
    }
}
