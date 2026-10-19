import { translator, responseError } from "./i18n.js";
import { kind } from "../media/state.js";
import { MediaViewer } from "../media-viewer.js";
import { icon } from "../asset-card.js";
import { relativePath, ancestors } from "./navigation.js";
import { pickerPreferences } from "./settings.js";
import { ModeMenu } from "../media/mode-menu.js";
import { appendCardDetails, HoverPlayer } from "./card-details.js";

const ROOT = "/henjicc/image-library";

function el(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}
function button(text, action) {
    const control = el("button", text);
    control.type = "button";
    control.addEventListener("click", action);
    return control;
}
function input(label, type = "text") {
    const control = el("input");
    control.type = type;
    control.setAttribute("aria-label", label);
    return control;
}
export class ImagePicker {
    constructor({ api, value, onSelect, locale, settings, multiple = false, mediaKind = "image" }) {
        this.multiple = multiple;
        this.mediaKind = mediaKind;
        this.t = translator(locale);
        this.api = api;
        this.source = "input";
        this.onSelect = onSelect;
        this.preferences = pickerPreferences(settings);
        this.mode = this.preferences.SingleClickUse ? "use" : "select";
        this.currentValue = "";
        try { this.currentValue = relativePath(typeof value === "string" ? value : ""); }
        catch (error) { this.initialPathError = this.t(error.message); }
        this.directory = this.currentValue.includes("/") ? this.currentValue.slice(0, this.currentValue.lastIndexOf("/")) : "";
        this.selected = new Set();
        this.offset = 0;
        this.generation = 0;
        this.urls = [];
        this.menus = [];
        this.folderCache = new Map(); this.expanded = new Set([""]); this.folderRequests = new Map();
        this.sourceTrees = new Map([["input", { cache: this.folderCache, expanded: this.expanded, requests: this.folderRequests }],
            ...["output", "temp"].map(source => [source, { cache: new Map(), expanded: new Set(), requests: new Map() }])]);
        this.treeController = new AbortController();
        this.dialog = el("dialog", undefined, "henjicc-picker");
        this.dialog.setAttribute("aria-label", this.t("资源库"));
        for (const [key,value] of Object.entries({ crop: this.preferences.CropThumbnails }))
            this.dialog.dataset[key] = String(value);
        this.dialog.addEventListener("keydown", event => event.stopPropagation());
        this.dialog.addEventListener("close", () => this.dispose());
        this.dialog.addEventListener("cancel", event => { event.preventDefault(); if (!this.busy) this.close(); });
        this.hoverPlayer = new HoverPlayer({api:this.api,t:this.t,onError:message=>{this.status.textContent=message;}});
        this.stopPlayback = () => this.hoverPlayer.stop();
        window.addEventListener("blur",this.stopPlayback);
        document.addEventListener("visibilitychange",this.stopPlayback);
        this.build();
    }

    build() {
        const header = el("header");
        header.append(el("h2", this.t("资源库")));
        this.closeButton = button("", () => this.close());
        this.closeButton.append(icon("close")); this.closeButton.className = "picker-close";
        this.closeButton.setAttribute("aria-label", this.t("关闭"));
        header.append(this.closeButton);
        const toolbar = el("div", undefined, "toolbar");
        this.modeSelect = this.select(this.t("操作模式"), [["use",this.t("直接使用")],["select",this.t(this.multiple ? "多选管理" : "选择管理")],["rate",this.t("编辑模式")]]);
        this.modeSelect.value = this.mode;
        this.modeSelect.addEventListener("change", () => this.setMode(this.modeSelect.value));
        this.search = input(this.t("搜索文件名或标签"), "search");
        this.search.placeholder = this.t("搜索文件名或标签");
        this.search.addEventListener("input", () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => { this.offset = 0; this.load(); }, 200);
        });
        this.sort = this.select(this.t("排序"), [["date", this.t("修改时间")], ["name", this.t("文件名")], ["rating", this.t("评分")]]);
        this.order = this.select(this.t("排序方向"), [["desc", this.t("降序")], ["asc", this.t("升序")]]);
        this.filterRating = this.select(this.t("最低评分"), [["0", this.t("全部评分")], ...[1, 2, 3, 4, 5].map(n => [String(n), this.t("{n} 星及以上", { n })])]);
        this.size = input(this.t("缩略图大小"), "range");
        this.size.min = 110; this.size.max = 240; this.size.value = 160;
        this.size.className = "picker-slider";
        const updateSize = () => {
            this.size.style.setProperty("--slider-progress", `${(Number(this.size.value) - 110) / 130 * 100}%`);
            this.grid?.style.setProperty("--tile-size", `${this.size.value}px`);
        };
        this.size.addEventListener("input", updateSize); updateSize();
        for (const control of [this.sort, this.order, this.filterRating]) control.addEventListener("change", () => { this.offset = 0; this.load(); });
        this.uploadButton = button("", () => this.upload());
        this.uploadButton.className = "picker-icon-button"; this.uploadButton.append(icon("upload"));
        this.uploadButton.setAttribute("aria-label",this.t("从本地导入"));
        const refresh = button("", () => { this.folderCache.clear(); this.load(); });
        refresh.className = "picker-icon-button"; refresh.append(icon("refresh")); refresh.setAttribute("aria-label",this.t("刷新"));
        toolbar.append(this.modeSelect, this.search, this.sort, this.order, this.filterRating, this.size, refresh, this.uploadButton);

        this.status = el("p", this.t("正在加载…"), "status");
        this.status.setAttribute("role", "status");
        this.grid = el("div", undefined, "image-grid");
        this.grid.setAttribute("aria-label", this.t("素材列表"));
        this.scroller = el("main");
        this.scroller.append(this.grid);
        this.scroller.addEventListener("scroll",this.stopPlayback,{passive:true});
        const sidebar = el("aside", undefined, "folder-tree"); sidebar.setAttribute("aria-label", this.t("素材文件夹"));
        this.tree = el("div"); sidebar.append(this.tree);
        const content = el("div", undefined, "picker-content");
        const splitter = el("div", undefined, "sidebar-splitter");
        splitter.tabIndex = 0; splitter.setAttribute("role", "separator");
        splitter.setAttribute("aria-label", this.t("目录栏宽度")); splitter.setAttribute("aria-orientation", "vertical");
        splitter.setAttribute("aria-valuemin", "160"); splitter.setAttribute("aria-valuemax", "520"); splitter.setAttribute("aria-valuenow", "210");
        const resize = width => {
            const maximum = Math.max(160, Math.min(520, content.clientWidth - 240));
            width = Math.round(Math.max(160, Math.min(maximum, width)));
            sidebar.style.setProperty("--sidebar-width", `${width}px`);
            splitter.setAttribute("aria-valuenow", String(width)); splitter.setAttribute("aria-valuemax", String(maximum));
        };
        let drag;
        splitter.addEventListener("pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault(); drag = { x: event.clientX, width: sidebar.getBoundingClientRect().width };
            splitter.setPointerCapture(event.pointerId);
        });
        splitter.addEventListener("pointermove", event => { if (drag) resize(drag.width + event.clientX - drag.x); });
        splitter.addEventListener("lostpointercapture", () => { drag = null; });
        splitter.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            resize(event.key === "Home" ? 160 : event.key === "End" ? Infinity : sidebar.getBoundingClientRect().width + (event.key === "ArrowLeft" ? -16 : 16));
        });
        content.append(sidebar, splitter, this.scroller, this.status);
        const footer = this.footer = el("footer");
        this.selectionText = el("span", this.t("未选择素材"));
        this.tags = input(this.t("标签（逗号分隔）"));
        this.tags.placeholder = this.t("标签，逗号分隔");
        this.rating = this.select(this.t("设置评分"), [["", this.t("评分")], ["0", this.t("清除评分")], ...[1, 2, 3, 4, 5].map(n => [String(n), this.t("{n} 星", { n })])]);
        this.useButton = button(this.t("使用素材"), () => this.mode === "rate" ? this.setMode(this.returnMode ?? "use") : this.choose());
        this.useButton.className = "primary";
        const selectAll = button(this.t("本页全选"), () => {
            if (!this.multiple && this.mode !== "rate") this.selected.clear();
            (this.multiple || this.mode === "rate" ? this.items : this.items.slice(0, 1)).forEach(item => this.selected.add(item.path)); this.renderSelection();
        });
        const clearSelection=button(this.t("取消全选"),()=>{this.selected.clear();this.renderSelection();});
        const detailControls = this.metadataControls = el("div", undefined, "metadata-controls");
        this.tagAction=this.select(this.t("标签操作"),[["add",this.t("追加标签")],["remove",this.t("移除标签")],["replace",this.t("替换标签")]]);
        this.deleteButton = button(this.t("删除所选"), () => this.deleteSelected());
        detailControls.append(this.rating,
            button(this.t("保存评分"), () => { if (this.rating.value !== "") this.saveMetadata({ rating: Number(this.rating.value) }); }), this.tags, this.tagAction,
            button(this.t("保存标签"), () => this.saveMetadata({ tags: this.tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean), tag_action:this.tagAction.value })),
            this.deleteButton);
        footer.append(detailControls,selectAll,clearSelection,this.selectionText,this.useButton);
        const paging = this.paging = el("div", undefined, "paging");
        this.previous = button(this.t("上一页"), () => { this.offset = Math.max(0, this.offset - 120); this.load(); });
        this.next = button(this.t("下一页"), () => { this.offset += 120; this.load(); });
        this.pageText = el("span");
        paging.append(this.previous, this.pageText, this.next);
        this.dialog.append(header, toolbar, content, paging, footer);
        this.setMode(this.mode);
        this.renderTree();
    }

    show() {
        this.previousFocus = document.activeElement;
        document.body.append(this.dialog);
        this.dialog.showModal();
        this.search.focus();
        this.load();
    }

    select(label, options) {
        const menu = new ModeMenu({ themeFrom: this.dialog, mountTo: this.dialog, label,
            options: options.map(([value,label]) => ({value,label})), value: options[0][0],
            onSelect: value => { control.value = value; control.dispatchEvent(new Event("change")); },
        });
        this.menus.push(menu); menu.element.classList.add("picker-menu");
        const control = menu.button; control.classList.add("picker-select");
        Object.defineProperty(control,"value",{
            get: () => menu.value,
            set: value => {
                menu.value = String(value);
                control.replaceChildren(el("span",options.find(([key]) => key === menu.value)?.[1] ?? menu.value),icon("next"));
                [...menu.element.children].forEach((row,index) => row.setAttribute("aria-selected",String(options[index][0] === menu.value)));
            },
        });
        control.value = menu.value;
        return control;
    }

    close() { if (!this.busy) this.dialog.close(); }

    dispose() {
        this.hoverPlayer.stop();
        window.removeEventListener("blur",this.stopPlayback);
        document.removeEventListener("visibilitychange",this.stopPlayback);
        this.menus.forEach(menu => menu.dispose());
        this.viewer?.close();
        clearTimeout(this.searchTimer);
        clearTimeout(this.useTimer);
        this.controller?.abort();
        this.treeController.abort();
        this.observer?.disconnect();
        this.urls.forEach(url => URL.revokeObjectURL(url));
        this.urls = [];
        this.dialog.remove();
        this.previousFocus?.focus?.();
    }

    async request(path, options = {}, source = this.source) {
        let response;
        try { response = await this.api.fetchApi(ROOT + path + (path.includes("?") ? "&" : "?") + `source=${source}`, options); }
        catch (error) {
            if (error.name === "AbortError") throw error;
            throw new Error(this.t("网络连接失败，请重试"));
        }
        if (!response.ok) {
            const text = await response.text();
            let message;
            try { message = JSON.parse(text).error; } catch { message = text; }
            throw new Error(responseError(this.t, message, response.status));
        }
        return response;
    }

    navigate(directory, source = this.source) {
        if (this.busy) return;
        try { directory = relativePath(directory, true); }
        catch (error) { this.status.textContent = this.t(error.message); return; }
        if (source !== this.source) { this.setSource(source, directory); return; }
        clearTimeout(this.useTimer);
        this.directory = directory; this.offset = 0;
        this.load();
    }

    setSource(source, directory = "") {
        if (this.busy || source === this.source) return;
        clearTimeout(this.useTimer); this.viewer?.close();
        this.source = source; this.directory = directory; this.lastDirectory = ""; this.currentValue = ""; this.offset = 0;
        const state = this.sourceTrees.get(source);
        this.folderCache = state.cache; this.folderRequests = state.requests; this.expanded = state.expanded;
        this.selected.clear();
        this.deleteButton.disabled = source !== "input";
        this.renderTree();
        this.load();
    }

    setMode(mode) {
        clearTimeout(this.useTimer);
        this.hoverPlayer?.stop();
        if(mode === "rate" && this.mode !== "rate") this.returnMode=this.mode;
        if(mode !== "rate") this.editorSelectionKey=null;
        this.mode = mode; this.modeSelect.value = mode; this.dialog.dataset.mode = mode;
        this.footer.hidden = mode === "use";
        this.metadataControls.hidden = mode !== "rate";
        this.useButton.textContent=this.t(mode === "rate" ? "退出编辑模式" : "使用素材");
        if(mode !== "rate" && !this.multiple && this.selected.size>1) this.selected.clear();
        this.renderSelection();
    }

    activate(item, event) {
        clearTimeout(this.useTimer);
        if (this.busy || this.loading || !this.dialog.open) return;
        if (this.mode === "use" && (event.ctrlKey || event.metaKey || event.shiftKey)) this.setMode("select");
        if (this.mode === "use") {
            const use = () => {
                if (this.busy || !this.dialog.open) return;
                this.selected.clear(); this.selected.add(item.path); this.choose();
            };
            if (this.preferences.DoubleClickPreview && event.detail !== 0)
                this.useTimer = setTimeout(use, this.preferences.DoubleClickDelay);
            else use();
        } else {
            if (!this.multiple && this.mode !== "rate") this.selected.clear();
            const index=this.items?.findIndex(asset=>asset.path===item.path) ?? -1;
            if(event.shiftKey && (this.multiple || this.mode === "rate") && this.selectionAnchor>=0 && index>=0) {
                for(const asset of this.items.slice(Math.min(index,this.selectionAnchor),Math.max(index,this.selectionAnchor)+1)) this.selected.add(asset.path);
            } else {
                if(this.selected.has(item.path)) this.selected.delete(item.path); else this.selected.add(item.path);
                this.selectionAnchor=index;
            }
            this.renderSelection();
        }
    }

    preview(item) {
        clearTimeout(this.useTimer); this.hoverPlayer.stop();
        if (this.busy || this.loading || !this.preferences.DoubleClickPreview) return;
        this.viewer?.close(); this.viewer = new MediaViewer({ api: this.api, t: this.t, source: this.source });
        this.viewer.open(this.items.map(asset => ({ id: asset.path, path: asset.path, label: asset.name })), item.path);
    }

    editItem(item) {
        if (this.busy || this.loading) return;
        clearTimeout(this.useTimer);
        this.setMode("rate");
        this.selected.clear(); this.selected.add(item.path);
        this.selectionAnchor=this.items?.findIndex(asset=>asset.path===item.path) ?? -1;
        this.renderSelection();this.tags.focus();
    }

    async treeFolders(path, source = this.source) {
        const cache = source === this.source ? this.folderCache : this.sourceTrees.get(source).cache;
        const requests = source === this.source ? this.folderRequests : this.sourceTrees.get(source).requests;
        if (cache.has(path)) return cache.get(path);
        if (!requests.has(path)) {
            const controller = this.treeController;
            const request = this.request(`/files?${new URLSearchParams({ directory: path, kind: this.mediaKind })}`, { signal: controller.signal }, source)
                .then(response => response.json()).then(data => {
                    if (controller.signal.aborted) throw new DOMException("Aborted","AbortError");
                    cache.set(path, data.folders); return data.folders;
                }).finally(() => { if (requests.get(path) === request) requests.delete(path); });
            requests.set(path, request);
        }
        return requests.get(path);
    }

    async revealDirectory(directory, generation) {
        try {
            for (const path of ancestors(directory)) {
                await this.treeFolders(path);
                if (!this.dialog.open || generation !== this.generation) return;
                this.expanded.add(path);
            }
            this.renderTree();
        } catch (error) { if (error.name !== "AbortError" && generation === this.generation) this.status.textContent = error.message; }
    }

    renderTree() {
        this.tree.replaceChildren();
        const add = (source, path, name, depth) => {
            const row = el("div", undefined, "folder-tree-row"); row.style.paddingLeft = `${depth * 14}px`;
            const active = source === this.source;
            const state = this.sourceTrees.get(source);
            const folders = state.cache.get(path), expanded = state.expanded.has(path);
            const toggle = button("", async () => {
                if (this.busy) return;
                if (state.expanded.has(path)) state.expanded.delete(path);
                else {
                    toggle.disabled = true;
                    try { await this.treeFolders(path, source); if (!this.dialog.open) return; state.expanded.add(path); }
                    catch (error) { if (error.name !== "AbortError") this.status.textContent = error.message; }
                    finally { toggle.disabled = false; }
                }
                if (this.dialog.open) this.renderTree();
            });
            toggle.append(icon("next"));
            toggle.className = "folder-toggle"; toggle.setAttribute("aria-label", `${this.t(expanded ? "收起文件夹" : "展开文件夹")} ${name}`);
            toggle.setAttribute("aria-expanded", String(expanded)); toggle.disabled = folders?.length === 0;
            const link = button("", () => this.navigate(path, source)); link.append(icon("folder"), el("span", name));
            if (active && path === this.directory) link.setAttribute("aria-current", "location");
            row.append(toggle, link); this.tree.append(row);
            if (expanded) for (const folder of folders ?? []) add(source, folder.path, folder.name, depth + 1);
        };
        for (const [source, label] of [["input", "输入目录"], ["output", "输出目录"], ["temp", "临时目录"]]) add(source, "", this.t(label), 0);
    }

    async load() {
        if (this.busy || !this.dialog.open) return;
        clearTimeout(this.useTimer);
        const generation = ++this.generation;
        this.hoverPlayer?.stop();this.selectionAnchor=-1;
        this.controller?.abort();
        this.controller = new AbortController();
        this.observer?.disconnect();
        this.loading = true; this.grid.inert = true; this.grid.setAttribute("aria-busy", "true");
        if (!this.multiple && this.mode !== "rate") this.selected.clear();
        this.renderSelection();
        this.status.textContent = this.t("正在加载…");
        this.previous.disabled = true; this.next.disabled = true;
        this.uploadButton.disabled = true;
        const params = new URLSearchParams({ directory: this.directory, q: this.search.value, sort: this.sort.value,
            order: this.order.value, rating: this.filterRating.value, offset: this.offset, kind: this.mediaKind });
        try {
            const response = await this.request(`/files?${params}`, { signal: this.controller.signal });
            const data = await response.json();
            if (generation !== this.generation || !this.dialog.open) return;
            this.urls.forEach(url => URL.revokeObjectURL(url)); this.urls = [];
            this.grid.replaceChildren();
            this.items = data.images;
            this.lastDirectory = this.directory;
            this.folderCache.set(this.directory, data.folders);
            this.revealDirectory(this.directory, generation);
            this.uploadButton.disabled = this.source !== "input";
            this.status.textContent = data.total ? "" : this.t("此文件夹没有符合条件的素材");
            this.previous.disabled = this.offset === 0;
            this.next.disabled = this.offset + this.items.length >= data.total;
            this.pageText.textContent = `${Math.floor(this.offset / 120) + 1} / ${Math.max(1, Math.ceil(data.total / 120))}`;
            this.paging.hidden = data.total <= 120;
            if (this.initialPathError) { this.status.textContent = this.initialPathError; this.initialPathError = null; }
            this.loading = false;
            this.renderImages(generation);
            this.grid.inert = false;
            return true;
        } catch (error) {
            if (error.name !== "AbortError" && generation === this.generation) { this.status.textContent = error.message; this.directory = this.lastDirectory ?? ""; }
        } finally {
            if (generation === this.generation) { this.loading = false; this.grid.removeAttribute("aria-busy"); }
        }
    }

    renderImages(generation) {
        this.observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                this.observer.unobserve(entry.target);
                this.loadThumbnail(entry.target, generation);
            }
        }, { root: this.scroller, rootMargin: "100px" });
        for (const item of this.items) {
            const card = el("article");
            card.className = "image-card";
            card.dataset.path = item.path;
            const frame = button("", event => this.activate(item,event)); frame.className = "image-frame";
            frame.setAttribute("aria-label",item.name); frame.setAttribute("aria-pressed","false");
            frame.addEventListener("dblclick", event => { event.preventDefault(); this.preview(item); });
            const image=el("img");
            image.classList.add("resource-thumbnail");image.alt="";image.dataset.path=item.path;image.dataset.kind=item.kind;
            frame.append(image);card.append(frame);
            const edit=button("",()=>this.editItem(item));edit.className="card-edit";edit.append(icon("edit"));
            edit.setAttribute("aria-label",this.t("编辑 {name}",{name:item.name}));card.append(edit);
            appendCardDetails(card,frame,item,this.preferences);
            if(this.preferences.HoverPlayback && item.kind !== "image") {
                frame.addEventListener("pointerenter",event=>{if(event.pointerType !== "touch" && !this.busy && !this.loading && this.mode !== "rate") this.hoverPlayer.schedule(item,frame,this.source);});
                frame.addEventListener("pointerleave",this.stopPlayback);
            }
            this.grid.append(card);this.observer.observe(image);
            if (item.path === this.currentValue) this.selected.add(item.path);
        }
        this.renderSelection();
    }

    async loadThumbnail(image, generation) {
        try {
            const response = await this.request(`/thumbnail?${new URLSearchParams({ path: image.dataset.path })}`, { signal: this.controller.signal });
            const blob = await response.blob();
            if (generation !== this.generation || !this.dialog.open) return;
            const url = URL.createObjectURL(blob); this.urls.push(url); image.src = url;
        } catch (error) {
            if(error.name !== "AbortError" && generation === this.generation && image.isConnected) {
                image.alt=this.t("预览不可用");
                if(image.dataset.kind === "audio") {const fallback=icon("audio");fallback.classList.add("waveform-fallback");image.replaceWith(fallback);}
            }
        }
    }

    renderSelection() {
        this.selectionText.textContent = this.selected.size ? this.t("已选 {n} 个素材", { n: this.selected.size }) : this.t("未选择素材");
        this.useButton.disabled=this.mode === "rate" ? false : this.multiple ? !this.selected.size : this.selected.size !== 1;
        if(this.mode === "rate") {
            const key=`${this.source}:${this.mode}:${[...this.selected].join("\0")}`;
            if(this.editorSelectionKey !== key) {
                const item=this.selected.size === 1 ? this.items?.find(item=>this.selected.has(item.path)) : null;
                this.rating.value=item ? String(item.rating) : "";this.tags.value=item ? item.tags.join(", ") : "";
                this.editorSelectionKey=key;
            }
            const disabled=this.busy || this.loading || !this.selected.size;
            for(const control of this.metadataControls.querySelectorAll("button,input")) control.disabled=disabled;
            this.deleteButton.disabled=disabled || this.source !== "input";
        }
        for (const card of this.grid.children) { const pressed = String(this.selected.has(card.dataset.path)); card.dataset.selected = pressed; card.querySelector(".image-frame").setAttribute("aria-pressed",pressed); }
    }

    async choose() {
        if (this.busy || this.loading || this.grid?.inert || !this.selected.size || (!this.multiple && this.selected.size !== 1)) return;
        try {
            let paths = [...this.selected];
            if (this.source !== "input") paths = (await this.mutate("/import",{paths})).paths;
            this.onSelect(this.multiple ? paths : paths[0]); this.close();
        } catch (error) { this.status.textContent = error.message; }
    }

    async mutate(path, data) {
        if (this.busy || !this.selected.size) return;
        this.busy = true;
        this.renderSelection();
        this.dialog.setAttribute("aria-busy", "true");
        this.closeButton.disabled = true;
        try {
            const response = await this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
            return await response.json();
        } finally {
            this.busy = false; this.dialog.removeAttribute("aria-busy"); this.closeButton.disabled = false; this.renderSelection();
        }
    }

    async saveMetadata(data) {
        try {
            if (this.busy || !this.selected.size) return;
            await this.mutate("/metadata", { paths: [...this.selected], ...data });
            if (await this.load()) this.status.textContent = this.t("已保存");
        } catch (error) { this.status.textContent = error.message; }
    }

    async deleteSelected() {
        if (this.busy || !this.selected.size) return;
        if (!window.confirm(this.t("永久删除所选 {n} 个素材？此操作不可撤销。", { n: this.selected.size }))) return;
        try {
            const result = await this.mutate("/delete", { paths: [...this.selected] });
            for (const path of result.deleted) this.selected.delete(path);
            this.offset = 0;
            if (await this.load()) this.status.textContent = result.failed.length ? this.t("已删除 {n} 张，{failed} 张删除失败", { n: result.deleted.length, failed: result.failed.length }) : this.t("已删除 {n} 张", { n: result.deleted.length });
        } catch (error) { this.status.textContent = error.message; }
    }

    upload() {
        if (this.busy || this.uploadButton.disabled) return;
        const chooser = input(this.t("从本地导入"), "file");
        const accepted = { image: ".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff", video: ".mp4,.mov,.webm,.mkv", audio: ".wav,.mp3,.flac,.ogg,.m4a" };
        chooser.accept = accepted[this.mediaKind] ?? Object.values(accepted).join(",");
        chooser.multiple = this.multiple;
        chooser.addEventListener("change", async () => {
            if (!chooser.files.length || !this.dialog.open) return;
            this.busy = true; this.closeButton.disabled = true;
            this.dialog.setAttribute("aria-busy", "true");
            const paths = [];
            try {
                if (!this.multiple && chooser.files.length !== 1) throw new Error(this.t("每次只能替换一个素材"));
                for (const file of chooser.files) {
                    const type = kind(file.name);
                    if (this.mediaKind !== "all" && type !== this.mediaKind) throw new Error(this.t("请选择相同类型的素材"));
                    if (file.size > 512 * 1024 * 1024) throw new Error(this.t("单个素材不能超过 512 MB"));
                    const body = new FormData(); body.append("image", file); body.append("type", "input");
                    body.append("subfolder", this.directory); body.append("overwrite", "false");
                    const response = await this.api.fetchApi("/upload/image", { method: "POST", body });
                    if (!response.ok) throw new Error(this.t("上传失败 ({status})", { status: response.status }));
                    const data = await response.json(); paths.push([data.subfolder, data.name].filter(Boolean).join("/"));
                }
            } catch (error) { this.uploadError = error instanceof TypeError ? this.t("网络连接失败，请重试") : error.message; }
            finally { this.busy = false; this.closeButton.disabled = false; this.dialog.removeAttribute("aria-busy"); }
            if (await this.load()) {
                if ((!this.multiple || this.mode === "use") && paths.length) this.selected.clear();
                paths.forEach(path => this.selected.add(path)); this.renderSelection();
                this.status.textContent = this.uploadError ? this.t("已导入 {n} 个素材；{error}", { n: paths.length, error: this.uploadError }) : this.t("已导入 {n} 个素材", { n: paths.length });
                if (this.mode === "use" && paths.length) {
                    if (this.uploadError) this.setMode("select"); else this.choose();
                }
            }
            this.uploadError = null;
        }, { once: true });
        chooser.click();
    }
}
