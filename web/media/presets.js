import { parseMedia } from "./state.js";
import { icon } from "../asset-card.js";

function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function hasSize(preset) {
    return Number.isInteger(preset?.width) && preset.width >= 8 && preset.width <= 8192
        && Number.isInteger(preset?.height) && preset.height >= 8 && preset.height <= 8192;
}

function graphNode(root, id) {
    const path = String(id).split(":"), local = path.pop();
    for (const parent of path) root = root?.getNodeById(parent)?.subgraph;
    return root?.getNodeById(local);
}

// Presets are edits to the input, not a second prompt transformation at execution.
export class InputPresets {
    constructor(composer) { this.composer = composer; }
    clear() {
        this.composer.change(state => { delete state.preset; });
    }
    async apply(entry) {
        const c = this.composer, graph = c.node.graph;
        if (c.disposed || !graph) return;
        const root = graph.rootGraph ?? graph, original = c.state.value;
        let modes = [];
        if (entry.mode === "reference") {
            const { output } = await c.app.graphToPrompt(root);
            if (c.disposed || c.node.graph !== graph || c.state.value !== original
                || (c.app.graph.rootGraph ?? c.app.graph) !== root) return;
            const boards = new Set(Object.entries(output).flatMap(([id, node]) => {
                const link = node.inputs?.preset;
                if (node.class_type !== "HenjiccResolutionBoard" || !Array.isArray(link)
                    || graphNode(root, link[0]) !== c.node) return [];
                const board = graphNode(root, id);
                return board ? [board] : [];
            }));
            modes = [...boards].map(board => {
                const widget = board.widgets?.find(widget => widget.name === "mode");
                if (!widget) throw new Error(c.t("无法切换尺寸来源"));
                return { board, widget };
            });
        }
        const sized = hasSize(entry);
        c.change(state => {
            state.prompt = structuredClone(entry.prompt);
            state.preset = { name: entry.name, width: sized ? entry.width : null, height: sized ? entry.height : null };
        }, true, undefined, () => {
            for (const { board, widget } of modes) {
                const old = widget.value;
                widget.value = "reference"; widget.callback?.(widget.value);
                board.onWidgetChanged?.("mode", widget.value, old, widget);
                board.setDirtyCanvas?.(true, true);
            }
        });
    }
    dialog(title) {
        this.close(true);
        const c = this.composer, dialog = element("dialog");
        dialog.className = "henjicc-input-presets";
        dialog.setAttribute("aria-label", c.t(title));
        const theme = getComputedStyle(c.element);
        for (const token of ["--henjicc-field", "--henjicc-text", "--henjicc-border", "--henjicc-hover", "--henjicc-focus", "--henjicc-font"])
            dialog.style.setProperty(token, theme.getPropertyValue(token));
        const heading = element("header"), close = element("button"); close.type = "button"; close.append(icon("close"));
        close.setAttribute("aria-label", c.t("关闭")); close.addEventListener("click", () => this.close());
        heading.append(element("strong", c.t(title)), close); dialog.append(heading);
        this.status = element("div"); this.status.setAttribute("role", "status");
        dialog.addEventListener("close", () => { dialog.remove(); if (this.current === dialog) this.current = null; });
        dialog.addEventListener("cancel", e => { e.preventDefault(); this.close(); });
        for (const event of ["pointerdown", "pointerup", "click", "keydown"]) dialog.addEventListener(event, e => e.stopPropagation());
        document.body.append(dialog); this.current = dialog; dialog.showModal(); return dialog;
    }
    saved() {
        const entries = this.composer.node.properties.henjiccInputPresets;
        return Array.isArray(entries) ? entries.filter(item => item && typeof item.name === "string" && Array.isArray(item.prompt)) : [];
    }
    async load() {
        const c = this.composer, dialog = this.dialog("加载预设");
        this.status.textContent = c.t("正在加载…"); dialog.append(this.status);
        try {
            this.abort = new AbortController();
            const response = await c.api.fetchApi("/henjicc/presets", { signal: this.abort.signal });
            if (!response.ok) throw new Error("读取预设失败");
            const catalog = await response.json();
            if (this.current !== dialog || c.disposed) return;
            this.status.textContent = "";
            const entries = Object.entries(catalog).map(([id, preset]) => ({
                name: c.t(preset.name ?? (id === "character_card" ? "角色卡" : "纯三视图")),
                prompt: [preset.template.replace("{prompt}", "")], width: preset.width, height: preset.height,
                mode: preset.mode,
            }));
            const add = entry => {
                const button = element("button"); button.type = "button"; button.className = "input-preset-option";
                const sized = hasSize(entry);
                button.append(element("span", entry.name), element("span", entry.mode === "reference" ? c.t("跟随参考图") : sized ? `${entry.width} × ${entry.height}` : c.t("仅提示词")));
                button.addEventListener("click", async () => {
                    if (dialog.dataset.closing) return;
                    await this.close();
                    if (c.disposed) return;
                    try { await this.apply(entry); }
                    catch (error) { if (!c.disposed) c.status.textContent = c.t(error.message); }
                }); dialog.append(button);
            };
            entries.forEach(add); this.saved().forEach(add);
        } catch (error) {
            if (this.current === dialog && error.name !== "AbortError") this.status.textContent = c.t("读取预设失败");
        }
    }
    save() {
        const c = this.composer, state = parseMedia(c.state.value), dialog = this.dialog("保存预设");
        const form = element("form"), fields = {}, labels = {};
        for (const [key, title, value] of [["name", "预设名称", state.preset?.name ?? ""], ["width", "宽度", state.preset?.width ?? 2048], ["height", "高度", state.preset?.height ?? 2048]]) {
            const label = element("label", c.t(title)), input = element("input"); input.name = key; input.value = value;
            input.setAttribute("aria-label", c.t(title)); input.required = true;
            if (key === "name") { input.type = "text"; input.maxLength = 80; }
            else { input.type = "number"; input.min = 8; input.max = 8192; input.step = 1; }
            fields[key] = input; labels[key] = label; label.append(input); form.append(label);
        }
        const sizeLabel = element("label", c.t("包含尺寸")), includeSize = element("input");
        sizeLabel.className = "input-preset-size-toggle";
        includeSize.type = "checkbox"; includeSize.checked = hasSize(state.preset);
        includeSize.setAttribute("aria-label", c.t("包含尺寸")); sizeLabel.append(includeSize);
        form.insertBefore(sizeLabel, labels.width);
        const updateSize = () => {
            for (const key of ["width", "height"]) {
                labels[key].hidden = !includeSize.checked;
                fields[key].disabled = !includeSize.checked;
                fields[key].required = includeSize.checked;
            }
        };
        includeSize.addEventListener("change", updateSize); updateSize();
        const submit = element("button", c.t("保存预设")); submit.type = "submit"; form.append(submit, this.status); dialog.append(form);
        form.addEventListener("submit", event => {
            event.preventDefault();
            if (!fields.name.value.trim()) { fields.name.focus(); return; }
            const entry = { name: fields.name.value.trim(), prompt: structuredClone(state.prompt) };
            if (includeSize.checked) { entry.width = Number(fields.width.value); entry.height = Number(fields.height.value); }
            const entries = [...this.saved()], index = entries.findIndex(item => item.name === entry.name);
            if (index < 0) entries.push(entry); else entries[index] = entry;
            c.change(data => { data.preset = { name: entry.name, width: entry.width ?? null, height: entry.height ?? null }; }, true, { henjiccInputPresets: entries });
        });
    }
    close(immediate = false) {
        this.abort?.abort();
        const dialog = this.current;
        if (!dialog) return;
        const remove = () => { dialog.close(); dialog.remove(); if (this.current === dialog) this.current = null; };
        if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return remove();
        if (dialog.dataset.closing) return;
        dialog.dataset.closing = "true";
        return dialog.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(6px)" }],
            { duration: 140, easing: "ease-in", fill: "forwards" }).finished.then(remove, remove);
    }
    dispose() { this.close(true); }
}
