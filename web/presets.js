import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { uniqueId } from "./identity.js";
import { bindNodeAppearance } from "./node-ui.js";
import { ModeMenu } from "./media/mode-menu.js";
import { icon } from "./asset-card.js";
import { fitAspectRatio, snapDimensions, stageScale } from "./resolution-geometry.js";
import { referenceImagePath, createImageSizeReader, watchReferenceSource } from "./reference-size.js";

for (const path of ["./media/composer.css", "./presets.css"]) {
    const link = document.createElement("link"); link.rel = "stylesheet";
    link.href = new URL(path, import.meta.url).href; document.head.append(link);
}
const words = {
    "预设": "Preset", "普通生成／编辑": "Generate / edit", "角色卡": "Character card", "纯三视图": "Three views", "自定义": "Custom",
    "宽度": "Width", "高度": "Height", "步数": "Steps", "引导强度": "CFG", "模板": "Template", "预设名称": "Preset name",
    "保存预设": "Save preset", "已保存": "Saved", "请输入名称": "Enter a name", "模型规则": "Model rules", "通用": "General",
    "尺寸来源": "Size source", "跟随预设": "Follow preset", "跟随参考图": "Follow reference", "自定义尺寸": "Custom size",
    "像素预算": "Megapixels", "超限等比缩小": "Fit within limits", "锁定比例": "Lock ratio", "自由比例": "Free ratio", "横竖交换": "Swap dimensions",
    "对齐倍数": "Alignment", "模型默认": "Model default",
    "已调整": "Adjusted", "运行后确定参考尺寸": "Reference size available after execution", "预设连接未解析": "Preset connection unavailable",
    "正在计算…": "Calculating…", "计算失败": "Calculation failed", "读取预设失败": "Could not load presets",
    "无法读取参考图尺寸": "Could not read reference image size",
};
const panels = new Set();
const imageSize = createImageSizeReader(async path => {
    const response = await api.fetchApi(`/henjicc/image-library/selection?${new URLSearchParams({ path, info: "1" })}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("无法读取参考图尺寸");
    return response.json();
});
const promptReads = new WeakMap();
function previewPrompt(root) {
    if (!promptReads.has(root)) {
        const pending = app.graphToPrompt(root);
        promptReads.set(root, pending);
        const clear = () => { if (promptReads.get(root) === pending) promptReads.delete(root); };
        pending.then(clear, clear);
    }
    return promptReads.get(root);
}
function element(tag, className, text) {
    const value = document.createElement(tag); if (className) value.className = className;
    if (text !== undefined) value.textContent = text; return value;
}
class Panel {
    constructor(node) {
        this.node = node; this.menus = [];
        this.element = element("section", "henjicc-preset-panel henjicc-media");
        this.unbind = bindNodeAppearance(app, this.element);
        for (const name of ["pointerdown", "pointerup", "click", "dblclick", "mousedown", "mouseup"]) this.element.addEventListener(name, e => e.stopPropagation());
        this.element.addEventListener("keydown", e => { if (!(e.ctrlKey || e.metaKey)) e.stopPropagation(); });
        this.localeChanged = () => this.render(); app.ui.settings.addEventListener("Comfy.Locale.change", this.localeChanged);
    }
    t(value) { return /^zh/.test(app.ui.settings.getSettingValue("Comfy.Locale") ?? "en") ? value : words[value] ?? value; }
    widget(name) { return this.node.widgets?.find(widget => widget.name === name); }
    value(name) { return this.widget(name)?.value; }
    change(values, properties) {
        app.canvas?.emitBeforeChange?.(); this.node.graph?.beforeChange?.();
        try {
            for (const [name, value] of Object.entries(values)) {
                const widget = this.widget(name); if (!widget) continue;
                widget.value = value; widget.callback?.(value);
            }
            if (properties) Object.assign(this.node.properties, properties);
        } finally { this.node.graph?.afterChange?.(); app.canvas?.emitAfterChange?.(); }
        this.render(); this.node.setDirtyCanvas(true, true);
    }
    clear() { this.menus.forEach(menu => menu.dispose()); this.menus = []; this.element.replaceChildren(); }
    row(label, control) {
        const row = element("label", "preset-row"); row.append(element("span", "", this.t(label)), control); return row;
    }
    menu(label, options, value, onSelect) {
        const menu = new ModeMenu({ themeFrom: this.element, label: this.t(label), options: options.map(([value, label, literal]) => ({ value, label: literal ? label : this.t(label) })), value, disabled: false, onSelect });
        this.menus.push(menu); return menu.button;
    }
    number(name, label, onChange, unit) {
        const field = element("input"); field.type = "number";
        field.value = unit === "MP" ? Number(Number(this.value(name)).toFixed(2)) : this.value(name);
        const options = this.widget(name)?.options ?? {}; for (const key of ["min", "max"]) if (options[key] !== undefined) field[key] = options[key];
        if (unit === "MP") field.min = Math.max(.01, Math.ceil((options.min ?? .01) * 100) / 100);
        field.step = unit === "MP" ? ".01" : ["cfg", "megapixels"].includes(name) ? ".1" : "1";
        field.setAttribute("aria-label", this.t(label));
        field.addEventListener("change", () => {
            if (field.value === "") { field.reportValidity(); return; }
            const value = unit === "MP" ? Number(Number(field.value).toFixed(2)) : Number(field.value);
            if (unit === "MP") field.value = value;
            if (!Number.isFinite(value) || !field.checkValidity()) { field.reportValidity(); return; }
            (onChange ?? (value => this.change({ [name]: value })))(value);
        });
        if (!unit) return this.row(label, field);
        const control = element("div", "resolution-number");
        const suffix = element("span", "resolution-unit", unit); suffix.setAttribute("aria-hidden", "true");
        control.append(field, suffix);
        return this.row(label, control);
    }
    button(label, action) { const b = element("button", "", this.t(label)); b.type = "button"; b.addEventListener("click", action); return b; }
    dispose() { this.disposed = true; this.revision = (this.revision ?? 0) + 1; this.abort?.abort(); this.clear(); this.unbind(); app.ui.settings.removeEventListener("Comfy.Locale.change", this.localeChanged); }
}
class ResolutionPanel extends Panel {
    get locked() { return this.node.properties.henjiccRatioLocked !== false; }
    render() {
        this.cancelDrag?.();
        const budget = this.widget("megapixels");
        if (budget) {
            // Keep the native float callback aligned with the visible input.
            Object.assign(budget.options, { precision: 2, round: .01, step: .1, step2: .01, min: .01 });
            if (Number.isFinite(budget.value)) budget.value = Math.max(.01, Number(budget.value.toFixed(2)));
        }
        this.resize?.disconnect();
        this.clear();
        this.element.append(this.row("模型规则", this.menu("模型规则", [["qwen21", "Qwen-Image 2.1"], ["general", "通用"]], this.value("profile"), value => this.change({ profile: value }))));
        this.sourceControl = this.menu("尺寸来源", [["custom", "自定义尺寸"], ["reference", "跟随参考图"]], this.value("mode") === "reference" ? "reference" : "custom", value => this.change({ mode: value }));
        this.element.append(this.row("尺寸来源", this.sourceControl));
        this.element.append(this.row("对齐倍数", this.menu("对齐倍数", [["auto", "模型默认"], ...[2,8,16,32].map(value => [String(value), String(value), true])], this.value("alignment") ?? "auto", value => this.change({ alignment: value }))));
        const stage = element("div", "resolution-stage");
        this.rect = element("div", "resolution-rectangle"); this.rect.tabIndex = 0; this.rect.setAttribute("aria-label", this.t("自定义尺寸"));
        const handle = element("span", "resolution-handle"); this.rect.append(handle); stage.append(this.rect); this.element.append(stage);
        this.stage = stage;
        this.resize = new ResizeObserver(() => { if (this.result) this.draw(this.result); }); this.resize.observe(stage);
        const beginDrag = e => {
            if (e.button !== 0 || !this.result || this.following) return;
            e.preventDefault(); e.stopPropagation(); stage.setPointerCapture(e.pointerId);
            const initial = { x: e.clientX, y: e.clientY, ...this.result }, bounds = this.rect.getBoundingClientRect();
            let next = initial;
            const move = event => {
                let width = initial.width * (1 + 2 * (event.clientX - initial.x) / bounds.width);
                let height = initial.height * (1 + 2 * (event.clientY - initial.y) / bounds.height);
                if (this.locked !== false) {
                    const horizontal = Math.abs((width - initial.width) / initial.width) >= Math.abs((height - initial.height) / initial.height);
                    if (horizontal) height = width * initial.height / initial.width;
                    else width = height * initial.width / initial.height;
                }
                next = { ...initial, ...snapDimensions(width, height, initial) };
                this.show(next);
            };
            const cleanup = () => { stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", finish); stage.removeEventListener("pointercancel", cancel); if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId); this.cancelDrag = null; };
            const finish = () => { cleanup(); this.change({ mode: "custom", width: next.width, height: next.height }); };
            const cancel = () => { cleanup(); this.refresh(); };
            this.cancelDrag = cleanup;
            stage.addEventListener("pointermove", move); stage.addEventListener("pointerup", finish); stage.addEventListener("pointercancel", cancel);
        };
        stage.addEventListener("pointerdown", beginDrag);
        const dimensions = element("div", "preset-grid");
        for (const [key, label] of [["width", "宽度"], ["height", "高度"]]) dimensions.append(this.number(key, label, value => {
            const values = { mode: "custom", [key]: value };
            if (this.locked !== false && this.result) {
                const other = key === "width" ? "height" : "width";
                values[other] = Math.max(8, Math.round(value * this.result[other] / this.result[key]));
                const limit = this.widget(other)?.options?.max ?? 8192;
                if (values[other] > limit) { values[key] = Math.max(8, Math.round(values[key] * limit / values[other])); values[other] = limit; }
            }
            this.change(values);
        }, "PX")); this.element.append(dimensions);
        const actions = element("div", "resolution-actions");
        const locked = this.locked !== false;
        const lock = this.button(locked ? "锁定比例" : "自由比例", () => this.change({}, { henjiccRatioLocked: !locked })); lock.setAttribute("aria-pressed", String(locked));
        lock.prepend(icon(locked ? "lock" : "unlock"));
        const swap = this.button("横竖交换", () => this.change({ mode: "custom", width: this.result?.height ?? this.value("height"), height: this.result?.width ?? this.value("width") }));
        swap.prepend(icon("replace"));
        actions.append(lock, swap);
        this.element.append(actions);
        const ratios = element("div", "resolution-ratios");
        for (const [label, width, height] of [["1:1",2048,2048],["4:3",2400,1792],["3:4",1792,2400],["3:2",2528,1696],["2:3",1696,2528],["16:9",2752,1536],["9:16",1536,2752]]) ratios.append(this.button(label, () => {
            const [rw, rh] = label.split(":").map(Number);
            const size = this.locked === false && this.result ? fitAspectRatio(this.result, rw, rh) : { width, height };
            this.change({ mode: "custom", ...size });
        }));
        this.element.append(ratios);
        this.manualControls = [...dimensions.querySelectorAll("input"), ...actions.querySelectorAll("button"), ...ratios.querySelectorAll("button")];
        this.handle = handle;
        const limits = element("div", "resolution-limits");
        limits.append(this.number("megapixels", "像素预算", undefined, "MP"));
        const fit = element("input"); fit.type = "checkbox"; fit.checked = this.value("fit"); fit.addEventListener("change", () => this.change({ fit: fit.checked })); limits.append(this.row("超限等比缩小", fit));
        this.element.append(limits);
        this.status = element("div", "preset-status", this.t("正在计算…")); this.status.setAttribute("role", "status"); this.element.append(this.status);
        this.refresh();
    }
    draw(result) {
        const factor = stageScale(result, this.stage.clientWidth - 16, this.stage.clientHeight - 16);
        this.rect.style.width = `${result.width * factor}px`;
        this.rect.style.height = `${result.height * factor}px`;
    }
    async refresh() {
        const revision = this.revision = (this.revision ?? 0) + 1; this.abort?.abort(); this.abort = new AbortController();
        this.status.textContent = this.t("正在计算…");
        this.status.dataset.error = "false";
        try {
            const payload = Object.fromEntries(["mode", "profile", "width", "height", "megapixels", "fit"].map(key => [key, this.value(key)]));
            payload.alignment = this.value("alignment") ?? "auto";
            let output, entry;
            const hasPreset = this.node.inputs?.find(input => input.name === "preset")?.link != null;
            if (hasPreset || payload.mode === "reference") {
                const root = this.node.graph.rootGraph ?? this.node.graph;
                ({ output } = await previewPrompt(root));
                entry = Object.entries(output).find(([id]) => {
                    const path = id.split(":"), local = path.pop(); let graph = root;
                    for (const parent of path) graph = graph?.getNodeById(parent)?.subgraph;
                    return graph?.getNodeById(local) === this.node;
                })?.[1];
            }
            if (hasPreset) {
                const link = entry?.inputs?.preset, source = Array.isArray(link) ? output[link[0]] : null;
                if (source?.class_type === "HenjiccSuperLoader" && typeof source.inputs.media === "string") {
                    payload.preset = JSON.parse(source.inputs.media).preset ?? null;
                } else throw new Error("预设连接未解析");
            }
            if (this.disposed || revision !== this.revision) return;
            this.setFollowing(payload.preset?.width != null);
            if (!this.following && payload.mode === "reference") {
                const path = referenceImagePath(output, entry?.inputs?.image);
                this.result = null; this.rect.hidden = true;
                if (!path) { this.status.textContent = this.t("运行后确定参考尺寸"); return; }
                payload.image_size = await imageSize(path);
                if (this.disposed || revision !== this.revision) return;
            }
            const response = await api.fetchApi("/henjicc/resolution/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: this.abort.signal });
            const result = await response.json(); if (this.disposed || revision !== this.revision) return;
            if (!response.ok) throw new Error(result.error ?? this.t("计算失败"));
            this.show(result);
        } catch (error) {
            if (this.disposed || revision !== this.revision || error.name === "AbortError") return;
            this.result = null; this.rect.hidden = true; this.status.textContent = this.t(error.message); this.status.dataset.error = "true";
        }
    }
    setFollowing(value) {
        this.following = value;
        this.sourceControl.disabled = value;
        this.sourceControl.textContent = this.t(value ? "跟随预设" : this.value("mode") === "reference" ? "跟随参考图" : "自定义尺寸");
        for (const control of this.manualControls) control.disabled = value;
        this.handle.hidden = value;
    }
    show(result) {
        this.setFollowing(result.source === "preset");
        this.result = result; this.rect.hidden = false; this.draw(result);
        for (const key of ["width", "height"]) { const input = this.element.querySelector(`input[aria-label="${this.t(key === "width" ? "宽度" : "高度")}"]`); if (input) { input.step = result.grid; input.min = Math.max(8, result.grid); if (document.activeElement !== input) input.value = result[key]; } }
        this.status.dataset.error = "false";
        this.status.textContent = `${result.width} × ${result.height} · ${(result.width * result.height / 1e6).toFixed(2)} MP${result.adjusted ? ` · ${this.t("已调整")}` : ""}`;
    }
    dispose() { this.cancelDrag?.(); this.resize?.disconnect(); super.dispose(); }
}
let pending = false;
function refreshBoards() {
    imageSize.clear();
    // Invalidate in-flight results immediately, even while edits are coalesced.
    for (const panel of panels) if (panel instanceof ResolutionPanel) { panel.revision = (panel.revision ?? 0) + 1; panel.abort?.abort(); }
    if (pending) return; pending = true;
    setTimeout(() => { pending = false; for (const panel of panels) if (panel instanceof ResolutionPanel && panel.node.graph) panel.refresh(); }, 100);
}
app.registerExtension({
    name: "Henjicc.GenerationPresets",
    setup() { app.canvas.canvas.addEventListener("litegraph:canvas", event => { if (event.detail?.subType === "after-change") refreshBoards(); }); },
    afterConfigureGraph: refreshBoards,
    nodeCreated(node) {
        watchReferenceSource(node, refreshBoards);
        if (node.comfyClass !== "HenjiccResolutionBoard") return;
        const names = ["mode","profile","width","height","megapixels","fit","alignment"];
        for (const widget of node.widgets ?? []) if (names.includes(widget.name)) widget.hidden = true;
        const panel = new ResolutionPanel(node); panels.add(panel);
        const view = node.addDOMWidget(`henjicc_preset_${uniqueId()}`, "henjicc_preset", panel.element, { serialize: false, hideOnZoom: false, getMinHeight: () => 430 }); view.serialize = false;
        node.setSize([400,520]);
        const configure = node.onConfigure, removed = node.onRemoved, connected = node.onConnectionsChange, executed = node.onExecuted;
        node.onConfigure = function (...args) { const result = configure?.apply(this,args); panel.render(); return result; };
        node.onConnectionsChange = function (...args) { const result = connected?.apply(this,args); refreshBoards(); return result; };
        node.onExecuted = function (message) { executed?.apply(this,arguments); if (message.resolution?.[0]) panel.show(message.resolution[0]); };
        node.onRemoved = function (...args) { panels.delete(panel); panel.dispose(); return removed?.apply(this,args); };
        panel.render();
    },
});
