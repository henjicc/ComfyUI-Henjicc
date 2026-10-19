import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ImagePicker } from "./picker/panel.js";
import { translator } from "./picker/i18n.js";
import { pickerSettings } from "./picker/settings.js";

const SETTING = "Henjicc.ImageLibrary.InjectLoadImage";
const attached = new WeakMap();
let active;
const translate = (message) => translator(app.ui.settings.getSettingValue("Comfy.Locale") ?? document.documentElement?.lang ?? "en")(message);

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./picker/panel.css", import.meta.url).href;
document.head.append(style);

function enabled() {
    return app.ui.settings.getSettingValue(SETTING, true);
}

function attach(node) {
    if (node.comfyClass !== "LoadImage" && node.type !== "LoadImage") return;
    if (attached.has(node)) return attached.get(node);
    const image = node.widgets?.find(w => w.name === "image");
    if (!image) return;
    const upload = node.widgets.find(w => w.name === "upload");
    const originals = [image, upload].filter(Boolean).map(widget => ({ widget, hidden: widget.hidden }));
    const button = node.addWidget("button", translate("资源库"), null, () => {
        if (!enabled() || !node.graph) return;
        if (active?.busy) return;
        active?.close();
        active = new ImagePicker({ api, settings: app.ui.settings, locale: app.ui.settings.getSettingValue("Comfy.Locale"), value: image.value, onSelect: path => {
            if (!node.graph || !enabled()) return;
            const old = image.value;
            node.graph.beforeChange?.();
            if (Array.isArray(image.options?.values) && !image.options.values.includes(path)) {
                image.options.values.push(path);
            }
            image.value = path;
            image.callback?.(path);
            node.onWidgetChanged?.(image.name, path, old, image);
            node.graph.afterChange?.();
            node.graph.setDirtyCanvas(true, true);
        }});
        active.show();
    }, { serialize: false });
    button.serializeValue = () => undefined;
    const update = () => {
        const usePicker = enabled();
        button.name = translate("资源库");
        button.label = button.name;
        originals.forEach(({ widget, hidden }) => { widget.hidden = usePicker ? true : hidden; });
        button.hidden = !usePicker;
        const minimum = node.computeSize();
        node.setSize([Math.max(node.size[0], minimum[0]), Math.max(node.size[1], minimum[1])]);
        node.graph?.setDirtyCanvas(true, true);
    };
    attached.set(node, update);
    update();
    return update;
}

function updateGraph() {
    if (!enabled()) active?.close();
    if (!app.graph) return;
    const graphs = [app.graph, ...(app.graph.subgraphs?.values() ?? [])];
    for (const graph of graphs) {
        for (const node of graph.computeExecutionOrder(false)) (attached.get(node) ?? attach(node))?.();
    }
}

async function restoreImageOptions() {
    if (!app.graph) return;
    const graphs = [app.graph, ...(app.graph.subgraphs?.values() ?? [])];
    const checks = new Map();
    for (const graph of graphs) for (const node of graph.computeExecutionOrder(false)) {
        if (node.comfyClass !== "LoadImage" && node.type !== "LoadImage") continue;
        const image = node.widgets?.find(widget => widget.name === "image");
        const value = image?.value;
        if (typeof value !== "string" || !Array.isArray(image.options?.values) || image.options.values.includes(value)) continue;
        if (!checks.has(value)) checks.set(value, api.fetchApi(`/henjicc/image-library/selection?${new URLSearchParams({ path: value })}`)
            .then(response => response.ok).catch(() => false));
        // Core's top-level-only choices otherwise flag valid subfolder files as missing.
        // Only restore a choice after checking the filesystem; never mask a missing file.
        if (await checks.get(value) && node.graph === graph && image.value === value && !image.options.values.includes(value)) {
            image.options.values.push(value);
        }
    }
}

app.registerExtension({
    name: "Henjicc.ImageLibrary",
    settings: [{
        id: SETTING,
        name: "Enhance image selection in Load Image",
        category: ["Henjicc", "HenjiccImageLibrary", "InjectLoadImage"],
        type: "boolean",
        defaultValue: true,
        onChange: updateGraph,
    }, ...pickerSettings],
    setup() { app.ui.settings.addEventListener("Comfy.Locale.change", updateGraph); },
    nodeCreated(node) { attach(node); },
    loadedGraphNode(node) { attach(node); },
    async afterConfigureGraph() { updateGraph(); await restoreImageOptions(); },
});
