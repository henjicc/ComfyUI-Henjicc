import { kind } from "./media/state.js";
import { iconButton } from "./asset-card.js";

export function mediaViewUrl(api, path, source = "input") {
    const parts = path.split("/"); const filename = parts.pop();
    return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: parts.join("/"), type: source })}`);
}

export class MediaViewer {
    constructor({ api, t, source = "input" }) { Object.assign(this, { api, t, source }); }
    open(items, id) {
        this.close();
        this.items = items; this.index = items.findIndex(item => item.id === id);
        if (this.index < 0) return;
        this.returnFocus = document.activeElement;
        this.dialog = document.createElement("dialog"); this.dialog.className = "henjicc-media-viewer";
        this.dialog.setAttribute("aria-label", this.t("素材预览"));
        const header = document.createElement("header");
        this.label = document.createElement("span"); this.label.className = "viewer-label"; this.label.setAttribute("aria-live", "polite");
        this.counter = document.createElement("span");
        header.append(this.label, this.counter, iconButton("previous", this.t("上一项"), () => this.move(-1), items.length < 2), iconButton("next", this.t("下一项"), () => this.move(1), items.length < 2), iconButton("close", this.t("关闭"), () => this.close()));
        this.content = document.createElement("div"); this.content.className = "viewer-content";
        this.status = document.createElement("div"); this.status.className = "viewer-status"; this.status.setAttribute("role", "status");
        this.dialog.append(header, this.content, this.status);
        this.dialog.addEventListener("click", e => { if (e.target === this.dialog) this.close(); });
        const dialog = this.dialog;
        this.dialog.addEventListener("close", () => { if (this.dialog === dialog) this.dispose(); }, { once: true });
        this.dialog.addEventListener("keydown", e => {
            e.stopPropagation();
            if (["ArrowLeft", "ArrowRight"].includes(e.key) && (!e.target.closest("video, audio") || e.altKey)) {
                e.preventDefault(); this.move(e.key === "ArrowLeft" ? -1 : 1);
            }
        });
        document.body.append(this.dialog); this.dialog.showModal(); this.show();
    }
    releaseMedia() {
        this.content?.querySelectorAll("video, audio").forEach(media => { media.pause(); media.removeAttribute("src"); media.load(); });
    }
    show() {
        this.releaseMedia();
        const item = this.items[this.index], type = kind(item.path);
        const media = document.createElement(type === "image" ? "img" : type);
        if (type === "image") media.alt = item.label;
        else { media.controls = true; media.preload = "metadata"; }
        media.addEventListener("error", () => {
            if (this.dialog?.open && this.content.firstChild === media) this.status.textContent = this.t("素材缺失或浏览器无法预览");
        }, { once: true });
        media.src = mediaViewUrl(this.api, item.path, this.source);
        this.label.textContent = item.label; this.counter.textContent = `${this.index + 1} / ${this.items.length}`;
        this.status.textContent = ""; this.content.replaceChildren(media);
    }
    move(offset) {
        if (this.items.length < 2) return;
        this.index = (this.index + offset + this.items.length) % this.items.length; this.show();
    }
    close() { if (this.dialog?.open) this.dialog.close(); this.dispose(); }
    dispose() {
        this.releaseMedia(); this.dialog?.remove(); this.dialog = null;
        if (this.returnFocus?.isConnected) this.returnFocus.focus();
        this.returnFocus = null;
    }
}
