import { uniqueId } from "../identity.js";
import { icon } from "../asset-card.js";
import { kind } from "./state.js";
import { mediaViewUrl } from "../media-viewer.js";

export function referenceThumbnail(ref, api) {
    const preview = document.createElement("span"); preview.className = "reference-thumbnail"; preview.setAttribute("aria-hidden", "true");
    if (!ref) { preview.append(icon("image")); return preview; }
    const type = ref.track === "audio" ? "audio" : kind(ref.path);
    if (type === "audio") preview.append(icon("audio"));
    else {
        const media = document.createElement(type === "image" ? "img" : "video");
        if (type === "image") { media.alt = ""; media.loading = "lazy"; }
        else { media.muted = true; media.preload = "metadata"; }
        media.draggable = false;
        media.src = type === "image" ? api.apiURL(`/henjicc/image-library/thumbnail?${new URLSearchParams({ path: ref.path })}`) : mediaViewUrl(api, ref.path);
        media.addEventListener("error", () => { if (media.isConnected) preview.replaceChildren(icon(type === "video" ? "video" : "image")); }, { once: true });
        preview.append(media);
    }
    return preview;
}

export class ReferenceMenu {
    constructor({ editor, themeFrom, api, label, onSelect, onHide }) {
        Object.assign(this, { editor, themeFrom, api, onSelect, onHide });
        this.element = document.createElement("div"); this.element.className = "henjicc-reference-menu";
        this.element.popover = "manual"; this.element.id = `henjicc-references-${uniqueId()}`;
        this.element.setAttribute("role", "listbox"); this.element.setAttribute("aria-label", label);
        this.editor.setAttribute("aria-controls", this.element.id); this.editor.setAttribute("aria-autocomplete", "list");
        this.editor.setAttribute("aria-expanded", "false");
        this.element.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
        this.element.addEventListener("click", e => e.stopPropagation());
        document.body.append(this.element);
        this.schedulePosition = () => {
            if (!this.open || this.frame) return;
            this.frame = requestAnimationFrame(() => { this.frame = null; this.position(); });
        };
        this.outside = e => { if (!this.editor.contains(e.target) && !this.element.contains(e.target)) this.hide(); };
        document.addEventListener("pointerdown", this.outside, true);
        for (const event of ["scroll", "wheel", "pointermove"]) document.addEventListener(event, this.schedulePosition, { capture: true, passive: true });
        window.addEventListener("resize", this.schedulePosition);
        this.resize = new ResizeObserver(this.schedulePosition); this.resize.observe(this.editor);
    }
    show(items, caret) {
        this.items = items; this.caret = caret.cloneRange();
        this.stopMedia(); this.element.replaceChildren(); this.choice = 0;
        items.forEach((ref, index) => {
            const option = document.createElement("button"); option.type = "button"; option.tabIndex = -1;
            option.id = `${this.element.id}-${index}`; option.setAttribute("role", "option");
            const name = document.createElement("span"); name.textContent = ref.label;
            option.append(referenceThumbnail(ref, this.api), name);
            option.addEventListener("click", () => this.onSelect(ref));
            option.addEventListener("pointermove", () => this.select(index)); this.element.append(option);
        });
        const theme = getComputedStyle(this.themeFrom);
        for (const token of ["--henjicc-field", "--henjicc-text", "--henjicc-border", "--henjicc-hover", "--henjicc-focus", "--henjicc-font"]) this.element.style.setProperty(token, theme.getPropertyValue(token));
        if (!this.open) this.element.showPopover();
        this.open = true; this.editor.setAttribute("aria-expanded", "true"); this.select(0); this.position();
    }
    position() {
        if (!this.open || !this.editor.isConnected) { this.hide(); return; }
        const caret = this.caret.getBoundingClientRect(), editor = this.editor.getBoundingClientRect();
        // Range coordinates already include canvas zoom. The top-layer menu must
        // use viewport pixels rather than inherit the DOM widget's transform.
        if (caret.bottom < editor.top || caret.top > editor.bottom || caret.left < editor.left || caret.left > editor.right
            || caret.bottom < 0 || caret.top > window.innerHeight || caret.left < 0 || caret.left > window.innerWidth) { this.hide(); return; }
        const width = this.element.offsetWidth, height = this.element.offsetHeight, margin = 8;
        this.element.style.left = `${Math.max(margin, Math.min(caret.left, window.innerWidth - width - margin))}px`;
        const below = caret.bottom;
        this.element.style.top = `${Math.max(margin, Math.min(below + height > window.innerHeight - margin ? caret.top - height : below, window.innerHeight - height - margin))}px`;
    }
    select(index) {
        this.choice = index;
        [...this.element.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
        const option = this.element.children[index];
        this.editor.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" });
    }
    move(offset) { this.select((this.choice + offset + this.items.length) % this.items.length); }
    choose() { this.onSelect(this.items[this.choice]); }
    stopMedia() { this.element.querySelectorAll("video").forEach(media => { media.pause(); media.removeAttribute("src"); media.load(); }); }
    hide() {
        if (this.open) this.element.hidePopover();
        this.open = false; this.caret = null;
        this.onHide?.();
        cancelAnimationFrame(this.frame); this.frame = null;
        this.editor.setAttribute("aria-expanded", "false"); this.editor.removeAttribute("aria-activedescendant");
        this.stopMedia(); this.element.replaceChildren();
    }
    dispose() {
        this.hide(); this.resize.disconnect(); document.removeEventListener("pointerdown", this.outside, true);
        for (const event of ["scroll", "wheel", "pointermove"]) document.removeEventListener(event, this.schedulePosition, true);
        window.removeEventListener("resize", this.schedulePosition); this.element.remove();
    }
}
