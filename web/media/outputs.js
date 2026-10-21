import { normalizePromptReferences } from "./state.js";

const OUTPUTS = [
    ["media", "HENJICC_MEDIA", "素材"], ["prompt", "STRING", "提示词"],
    ["has_images", "BOOLEAN", "含有图片"], ["first_last", "BOOLEAN", "首尾帧模式"],
    ["preset", "HENJICC_PRESET", "预设尺寸"],
];

// V3 exposes output display_name as the initial LiteGraph slot name.
const outputName = output => output.name === "Preset size" ? "preset" : output.name;

export function restoreMediaOutputShape(node, saved) {
    if (!Array.isArray(saved) || !saved.length) return;
    const names = saved.map(outputName);
    if (names[0] !== "media" || names[1] !== "prompt" || new Set(names).size !== names.length
        || names.some(name => !OUTPUTS.some(output => output[0] === name))) return;
    // ComfyNode.configure merges definition names/types by index. Match the
    // saved compact shape first, or reopening would turn preset into BOOLEAN.
    // Links are restored by configure itself, never through deprecated setters.
    node.outputs = names.map(name => { const [, type] = OUTPUTS.find(output => output[0] === name); return { name, type }; });
}

export function serializeMediaOutputs(value, node) {
    const data = JSON.parse(value);
    if (Array.isArray(data.items) && Array.isArray(data.prompt)) data.prompt = normalizePromptReferences(data);
    return JSON.stringify({ ...data, _output_names: node.outputs.map(outputName) });
}

// Use the host's slot lifecycle so both renderers, hit testing and links agree.
// API exports carry names to map compact slots back to the fixed backend tuple.
export function syncMediaOutputs(node, data, profiles, t) {
    if (!node.graph) return;
    let changed = false;
    for (const output of node.outputs) {
        const name = outputName(output);
        if (output.name !== name) { output.name = name; changed = true; }
    }
    const all = node.properties.henjiccShowAllPorts === true;
    const visible = new Set(["media", "prompt"]);
    if (all || profiles.some(profile => profile.startsWith("minimax"))) visible.add("first_last");
    if (all || (data.preset?.width != null && data.preset?.height != null)) visible.add("preset");
    if (all || profiles.includes("fibo2")) visible.add("has_images");
    for (let index = node.outputs.length - 1; index >= 2; index--) {
        const output = node.outputs[index];
        if (!visible.has(output.name) && !node.isOutputConnected(index)) { node.removeOutput(index); changed = true; }
    }
    const size = [...node.size];
    for (const [name, type, label] of OUTPUTS) {
        if (visible.has(name) && !node.outputs.some(output => output.name === name)) { node.addOutput(name, type); changed = true; }
        const output = node.outputs.find(output => output.name === name);
        if (output && output.label !== t(label)) { output.label = t(label); changed = true; }
    }
    // Adding a port must not reset the user's panel dimensions.
    if (changed) { node.setSize(size); node.setDirtyCanvas(true, true); }
}
