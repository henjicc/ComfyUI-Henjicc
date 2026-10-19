import { app } from "../../scripts/app.js";
import { translator } from "./picker/i18n.js";

const tasks = {
    auto: "自动识别", describe: "素材理解", qwen_auto: "千问图片生成／编辑", h3_swap: "MiniMax 角色替换",
    h3_reference: "MiniMax 参考生视频", general: "通用提示词优化", custom: "自定义",
};

app.registerExtension({
    name: "Henjicc.VisualPrompt",
    nodeCreated(node) {
        if (node.comfyClass !== "HenjiccVisualPrompt") return;
        const task = node.widgets.find(widget => widget.name === "task");
        const custom = node.widgets.find(widget => widget.name === "custom_instruction");
        const legacyDuration = node.widgets.find(widget => widget.name === "analysis_seconds");
        let collapsedHeight, expandedHeight;
        const refresh = (resize = false) => {
            if (legacyDuration) legacyDuration.hidden = true;
            if (["qwen_edit", "character_card"].includes(task.value)) task.value = "qwen_auto";
            const t = translator(app.ui.settings.getSettingValue("Comfy.Locale"));
            task.label = t("任务");
            // Both host renderers map displayed labels while retaining stable values.
            task.options.getOptionLabel = value => t(tasks[value] ?? value ?? "");
            const hidden = task.value !== "custom", changed = custom.hidden !== hidden;
            custom.hidden = hidden;
            custom.label = t("自定义要求");
            if (custom.element) {
                custom.element.setAttribute("aria-label", t("自定义要求"));
                custom.element.placeholder = t("自定义要求");
            }
            // Only revealing the text field needs extra space. Ordinary task or
            // locale changes must never reset a manually resized node.
            if (resize && changed) {
                if (!hidden) {
                    collapsedHeight = node.size[1];
                    node.setSize([node.size[0], Math.max(collapsedHeight, node.computeSize()[1])]);
                    expandedHeight = node.size[1];
                } else if (collapsedHeight != null && node.size[1] === expandedHeight) {
                    node.setSize([node.size[0], collapsedHeight]);
                }
            }
            node.graph?.setDirtyCanvas(true, true);
        };
        const callback = task.callback, configured = node.onConfigure, removed = node.onRemoved;
        task.callback = function (...args) { const result = callback?.apply(this, args); refresh(true); return result; };
        node.onConfigure = function (...args) { const result = configured?.apply(this, args); refresh(); return result; };
        const localeChanged = () => refresh();
        node.onRemoved = function (...args) {
            app.ui.settings.removeEventListener("Comfy.Locale.change", localeChanged);
            return removed?.apply(this, args);
        };
        app.ui.settings.addEventListener("Comfy.Locale.change", localeChanged);
        refresh();
    },
});
