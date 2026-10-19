import { uniqueId } from "../identity.js";
import { icon, iconButton } from "../asset-card.js";
// A node-local select with a top-layer list, independent of canvas zoom.
export class ModeMenu {
    constructor({ themeFrom, label, options, value, disabled, onSelect, mountTo = document.body }) {
        Object.assign(this, { themeFrom, options, value, onSelect });
        this.button = document.createElement("button");
        this.button.type = "button"; this.button.className = "media-mode-trigger";
        this.button.disabled = disabled;
        this.button.textContent = options.find(option => option.value === value)?.label ?? value;
        const arrow = icon("next"); arrow.classList.add("media-menu-arrow"); this.button.append(arrow);
        this.button.setAttribute("role", "combobox"); this.button.setAttribute("aria-label", label);
        this.button.setAttribute("aria-haspopup", "listbox"); this.button.setAttribute("aria-expanded", "false");
        this.element = document.createElement("div");
        this.element.className = "henjicc-mode-menu"; this.element.popover = "auto";
        this.element.id = `henjicc-mode-${uniqueId()}`;
        this.element.setAttribute("role", "listbox"); this.element.setAttribute("aria-label", label);
        this.button.setAttribute("aria-controls", this.element.id);
        options.forEach((option, index) => {
            const row = document.createElement("div"); row.textContent = option.label;
            const check = icon("check"); check.classList.add("menu-check"); row.append(check);
            row.id = `${this.element.id}-${index}`; row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(option.value === value));
            row.addEventListener("pointermove", () => this.highlight(index));
            row.addEventListener("click", () => this.choose(index)); this.element.append(row);
        });
        this.element.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
        this.element.addEventListener("click", e => e.stopPropagation());
        this.element.addEventListener("toggle", e => { if (e.newState === "closed") this.closed(); });
        this.button.addEventListener("click", () => this.open ? this.hide() : this.show());
        this.button.addEventListener("keydown", e => {
            if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                if (!this.open) this.show();
                else this.highlight(e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 :
                    (this.choice + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            } else if (this.open && ["Enter", " "].includes(e.key)) { e.preventDefault(); this.choose(this.choice); }
            else if (e.key === "Escape" && this.open) { e.preventDefault(); e.stopPropagation(); this.hide(); }
            else if (e.key === "Tab") this.hide();
        });
        this.schedule = () => {
            if (!this.open || this.frame) return;
            this.frame = requestAnimationFrame(() => { this.frame = null; this.position(); });
        };
        for (const event of ["scroll", "wheel", "pointermove"]) document.addEventListener(event, this.schedule, { capture: true, passive: true });
        window.addEventListener("resize", this.schedule);
        this.resize = new ResizeObserver(this.schedule); this.resize.observe(this.button);
        mountTo.append(this.element);
    }
    show() {
        if (this.button.disabled) return;
        const theme = getComputedStyle(this.themeFrom);
        for (const token of ["--henjicc-field", "--henjicc-text", "--henjicc-border", "--henjicc-hover", "--henjicc-focus", "--henjicc-font"]) this.element.style.setProperty(token, theme.getPropertyValue(token));
        this.element.showPopover(); this.open = true; this.button.setAttribute("aria-expanded", "true");
        this.highlight(Math.max(0, this.options.findIndex(option => option.value === this.value))); this.position();
    }
    highlight(index) {
        this.choice = index;
        [...this.element.children].forEach((row, i) => { row.dataset.active = String(i === index); });
        this.button.setAttribute("aria-activedescendant", this.element.children[index].id);
        this.element.children[index].scrollIntoView({ block: "nearest" });
    }
    position() {
        const rect = this.button.getBoundingClientRect(), margin = 8;
        if (!this.button.isConnected || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) { this.hide(); return; }
        this.element.style.width = "max-content";
        this.element.style.maxWidth = `${Math.max(0, innerWidth - margin * 2)}px`;
        const height = this.element.offsetHeight, width = this.element.offsetWidth;
        this.element.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - width - margin))}px`;
        this.element.style.top = `${Math.max(margin, Math.min(rect.bottom + height + 4 > innerHeight - margin ? rect.top - height - 4 : rect.bottom + 4, innerHeight - height - margin))}px`;
    }
    choose(index) {
        const value = this.options[index].value;
        this.hide(); this.button.focus();
        if (value !== this.value) this.onSelect(value);
    }
    closed() {
        this.open = false; cancelAnimationFrame(this.frame); this.frame = null;
        this.button.setAttribute("aria-expanded", "false"); this.button.removeAttribute("aria-activedescendant");
    }
    hide() { if (this.open) this.element.hidePopover(); this.closed(); }
    dispose() {
        this.hide(); this.resize.disconnect();
        for (const event of ["scroll", "wheel", "pointermove"]) document.removeEventListener(event, this.schedule, true);
        window.removeEventListener("resize", this.schedule); this.element.remove();
    }
}

export class UploadCard {
    constructor({ label, options, disabled, onSelect }) {
        this.element = document.createElement("article"); this.element.className = "media-card media-add";
        this.element.setAttribute("role", "group"); this.element.setAttribute("aria-label", label);
        const trigger = document.createElement("button"); trigger.type = "button";
        trigger.className = "media-add-trigger"; trigger.disabled = disabled;
        trigger.setAttribute("aria-label", label); trigger.append(icon("plus"));
        const actions = document.createElement("div"); actions.className = "asset-actions media-add-actions";
        for (const option of options) {
            actions.append(iconButton(option.icon, option.label, () => onSelect(option.value), disabled));
        }
        trigger.addEventListener("click", () => actions.querySelector("button:not(:disabled)")?.focus());
        this.element.append(trigger, actions);
    }
    dispose() { this.element.remove(); }
}
