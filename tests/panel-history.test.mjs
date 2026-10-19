import test from "node:test";
import assert from "node:assert/strict";
import { parseMedia } from "../web/media/state.js";
import { InputPresets } from "../web/media/presets.js";
import { serializeMediaOutputs } from "../web/media/outputs.js";

// Importing node-ui installs a stylesheet. The change methods need no DOM.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({}), head: { append() {} } };
let MediaComposer;
try {
    ({ MediaComposer } = await import("../web/media/composer.js"));
} finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
}

const panels = [
    {
        name: "super input", Panel: MediaComposer, parse: parseMedia,
        initial: { version: 1, profile: "qwen", items: [{ id: "a", path: "a.png" }], prompt: [] },
        edit: state => { state.prompt.push({ ref: "a", track: "main" }); },
    },
];

function clipboardPanel(t, read) {
    const old = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });
    t.after(() => { if (old) Object.defineProperty(navigator, "clipboard", old); else delete navigator.clipboard; });
    const calls = [];
    const panel = Object.assign(Object.create(MediaComposer.prototype), {
        state: { value: JSON.stringify({version:1,profile:"qwen",items:[{id:"a",path:"old.png"}],prompt:[{ref:"a"}]}) },
        status: { dataset: {}, textContent: "" }, t: value => value,
        async upload(files, replace) { calls.push({files,replace}); },
    });
    return { panel, calls };
}

const clipboardImage = () => [{types:["text/html","image/png"],getType:async () => new Blob(["image"],{type:"image/png"})}];
test("clipboard buttons upload one image to the captured slot or append", async t => {
    const {panel,calls} = clipboardPanel(t,async () => clipboardImage());
    await panel.pasteClipboard("a"); await panel.pasteClipboard();
    assert.deepEqual(calls.map(call => call.replace),["a",undefined]);
    assert.equal(calls[0].files.length,1);
    assert.equal(calls[0].files[0].type,"image/png");
    assert.match(calls[0].files[0].name,/\.png$/);
    assert.equal(panel.readingClipboard,false);
});

test("clipboard failures report an error without uploading", async t => {
    const {panel,calls} = clipboardPanel(t,async () => []);
    await panel.pasteClipboard("a");
    assert.equal(panel.status.textContent,"剪贴板中没有图片");
    navigator.clipboard.read = async () => { throw new DOMException("denied","NotAllowedError"); };
    await panel.pasteClipboard("a");
    assert.match(panel.status.textContent,/无法读取剪贴板/);
    assert.equal(calls.length,0); assert.equal(panel.readingClipboard,false);
});

test("a late clipboard read cannot replace changed media or an unmounted node", async t => {
    let finish;
    const {panel,calls} = clipboardPanel(t,() => new Promise(resolve => { finish=resolve; }));
    const pending = panel.pasteClipboard("a");
    panel.state.value = panel.state.value.replace("old.png","new.png");
    finish(clipboardImage()); await pending;
    assert.equal(panel.status.textContent,"素材已变化，请重新选择");
    const removed = panel.pasteClipboard("a"); panel.disposed=true;
    finish(clipboardImage()); await removed;
    assert.equal(calls.length,0);
});

test("clipboard timeout ignores a later response and releases the button", async t => {
    let finish;
    const {panel,calls} = clipboardPanel(t,() => new Promise(resolve => { finish=resolve; }));
    t.mock.method(globalThis,"setTimeout",callback => { queueMicrotask(callback); return 0; });
    await panel.pasteClipboard("a");
    assert.match(panel.status.textContent,/读取剪贴板超时/);
    assert.equal(panel.readingClipboard,false);
    finish(clipboardImage()); await Promise.resolve();
    assert.equal(calls.length,0);
});

test("external file drops replace the targeted card and append on empty space", () => {
    const calls = [];
    const panel = Object.assign(Object.create(MediaComposer.prototype), {
        clearDropTarget() {}, upload(files, replace) { calls.push({ files, replace }); },
    });
    const file = { name: "clip.mp4" };
    const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file] },
        target: { closest: () => ({ dataset: { id: "video-slot" } }) } };
    panel.dropFiles(event);
    assert.deepEqual(calls[0], { files: [file], replace: "video-slot" });
    event.target.closest = () => null;
    panel.dropFiles(event);
    assert.deepEqual(calls[1], { files: [file], replace: undefined });
    event.dataTransfer.files = [];
    panel.dropFiles(event);
    assert.equal(calls.length, 2, "internal sorting must not upload files");
});

test("super input: late connection exports cannot restore an old model or rewrite saved intent", async () => {
    const panel = Object.create(MediaComposer.prototype);
    const saved = JSON.stringify({ version: 1, profile: "minimax_frames", items: [], prompt: [] });
    const node = { id: 1 };
    node.graph = { getNodeById: id => String(id) === "1" ? node : null };
    Object.assign(panel, { node, state: { value: saved }, render() {}, syncOutputs() {} });
    let finishOld;
    const oldExport = new Promise(resolve => { finishOld = resolve; });
    const pending = panel.updateConnection(oldExport);
    await panel.updateConnection(Promise.resolve({ output: {
        "1": { class_type: "HenjiccSuperLoader" },
        adapter: { class_type: "TextEncodeQwenImage21", inputs: { media: ["1", 0] } },
    } }));
    finishOld({ output: { "1": { class_type: "HenjiccSuperLoader" }, adapter: { class_type: "HenjiccMiniMaxMedia", inputs: { media: ["1", 0] } } } });
    await pending;
    assert.equal(panel.connectedProfile, "qwen");
    assert.equal(panel.state.value, saved);
    panel.disposed = true;
    await panel.updateConnection(Promise.resolve({ output: {} }));
    assert.equal(panel.connectedProfile, "qwen");
});

function classicHost({ Panel, initial }, failCallback = false) {
    const events = [], undo = [];
    let depth = 0, active = JSON.stringify(initial);
    const state = {
        name: "input", value: active,
        callback() {
            events.push("callback");
            if (failCallback) throw new Error("callback failed");
        },
    };
    const panel = Object.assign(Object.create(Panel.prototype), {
        state, status: { textContent: "" }, t: value => value,
        render() {}, updateStatus() {}, syncOutputs() {},
        node: { graph: {
            // Classic graph callbacks do not emit the tracking event.
            beforeChange() { events.push("graph-before"); },
            afterChange() { events.push("graph-after"); },
            setDirtyCanvas() {},
        } },
        app: { canvas: {
            emitBeforeChange() { events.push("canvas-before"); depth++; },
            emitAfterChange() {
                events.push("canvas-after");
                assert.ok(depth > 0, "tracking transactions must be paired");
                if (--depth === 0 && state.value !== active) {
                    undo.push(active);
                    active = state.value;
                }
            },
        } },
    });
    return { panel, state, events, undo, depth: () => depth };
}

test("super input workflow round trip retains every editable state and custom preset", () => {
    const initial = { version: 1, profile: "minimax_frames", items: [
        { id: "portrait", path: "folder/portrait.png" },
        { id: "clip", path: "folder/clip.mp4", soundtrack: false },
        { id: "sound", path: "folder/sound.wav" },
    ], prompt: [] };
    const host = classicHost({ Panel: MediaComposer, initial });
    host.panel.node.properties = { unrelated: true };
    host.panel.node.outputs = ["media", "prompt", "first_last", "preset"].map(name => ({ name }));
    const preset = { name: "自定义预设", prompt: ["保持身份", { ref: "portrait", track: "main" }], width: 768, height: 512 };
    host.panel.change(state => {
        state.profile = "minimax_reference";
        state.items.reverse();
        state.items.find(item => item.id === "clip").soundtrack = true;
        state.prompt = [...preset.prompt, { ref: "clip", track: "audio" }];
        state.preset = { name: preset.name, width: preset.width, height: preset.height };
    }, false, { henjiccInputPresets: [preset] });
    const saved = JSON.parse(JSON.stringify({
        properties: host.panel.node.properties,
        widgets_values: [serializeMediaOutputs(host.state.value, host.panel.node)],
    }));
    const reopened = parseMedia(saved.widgets_values[0]);
    assert.equal(reopened.profile, "minimax_reference");
    assert.deepEqual(reopened.items.map(item => item.id), ["sound", "clip", "portrait"]);
    assert.equal(reopened.items[1].soundtrack, true);
    assert.equal(reopened.items[2].path, "folder/portrait.png");
    assert.deepEqual(reopened.prompt, [...preset.prompt, { ref: "clip", track: "audio" }]);
    assert.deepEqual(reopened.preset, { name: preset.name, width: 768, height: 512 });
    assert.deepEqual(saved.properties, { unrelated: true, henjiccInputPresets: [preset] });
});

test("clearing a preset releases dimensions, preserves edited content, and is undoable", () => {
    const initial = { ...panels[0].initial, prompt: ["edited text", { ref: "a" }],
        preset: { name: "Card", width: 2752, height: 1536 } };
    const host = classicHost({ ...panels[0], initial });
    new InputPresets(host.panel).clear();
    const cleared = parseMedia(host.state.value);
    assert.equal(cleared.preset, undefined);
    assert.deepEqual(cleared.prompt, initial.prompt);
    assert.deepEqual(cleared.items, initial.items);
    assert.equal(host.undo.length, 1);
    host.state.value = host.undo.pop();
    assert.deepEqual(parseMedia(host.state.value), initial);
});

test("reference preset changes only prompt and the connected board mode in one history edit", async () => {
    const initial = { ...panels[0].initial, prompt: ["old prompt"],
        preset: { name: "Card", width: 2752, height: 1536 } };
    const host = classicHost({ ...panels[0], initial });
    const graph = host.panel.node.graph;
    const board = { widgets: Object.entries({ mode: "custom", profile: "general", width: 768, height: 512,
        megapixels: 1.23, fit: false, alignment: "16" }).map(([name, value]) => ({ name, value })),
        properties: { henjiccRatioLocked: false } };
    const unrelated = { widgets: [{ name: "mode", value: "custom" }] };
    const nodes = { 1: host.panel.node, 2: unrelated, 3: {},
        10: { subgraph: { getNodeById: id => String(id) === "2" ? board : null } } };
    graph.getNodeById = id => nodes[id];
    host.panel.app.graph = graph;
    host.panel.app.graphToPrompt = async () => ({ output: {
        1: { class_type: "HenjiccSuperLoader" }, 3: { class_type: "HenjiccSuperLoader" },
        2: { class_type: "HenjiccResolutionBoard", inputs: { preset: ["3", 2] } },
        "10:2": { class_type: "HenjiccResolutionBoard", inputs: { preset: ["1", 2] } },
    } });
    host.panel.node.properties = { henjiccInputPresets: [{ name: "User", prompt: ["keep"] }] };
    const before = structuredClone(board), properties = structuredClone(host.panel.node.properties);
    const emit = host.panel.app.canvas.emitBeforeChange;
    let captured;
    host.panel.app.canvas.emitBeforeChange = () => { captured = JSON.parse(JSON.stringify(board)); emit(); };
    board.widgets[0].callback = () => assert.equal(host.depth(), 1, "board changes belong to the same undo transaction");
    await new InputPresets(host.panel).apply({ name: "动漫转写实", mode: "reference", prompt: ["new prompt"] });
    const state = parseMedia(host.state.value);
    assert.deepEqual(state, { ...initial, prompt: ["new prompt"], preset: { name: "动漫转写实", width: null, height: null } });
    assert.deepEqual(captured, before, "history captures the board before its mode changes");
    const reopened = JSON.parse(JSON.stringify(board));
    assert.deepEqual(reopened, { ...before, widgets: before.widgets.map(w => w.name === "mode" ? { ...w, value: "reference" } : w) });
    assert.equal(unrelated.widgets[0].value, "custom");
    assert.deepEqual(host.panel.node.properties, properties);
    assert.equal(host.undo.length, 1);
    assert.deepEqual(host.events, ["canvas-before", "graph-before", "callback", "graph-after", "canvas-after"]);
});

test("a delayed preset connection export cannot overwrite a newer user edit", async () => {
    const host = classicHost(panels[0]);
    host.panel.app.graph = host.panel.node.graph;
    let finish;
    host.panel.app.graphToPrompt = () => new Promise(resolve => { finish = resolve; });
    const pending = new InputPresets(host.panel).apply({ name: "动漫转写实", mode: "reference", prompt: ["old preset"] });
    host.state.value = JSON.stringify({ ...panels[0].initial, prompt: ["new user text"] });
    finish({ output: {} }); await pending;
    assert.deepEqual(parseMedia(host.state.value).prompt, ["new user text"]);
    assert.equal(host.undo.length, 0);
});

for (const spec of panels) {
    test(`${spec.name}: a Classic panel edit records exactly one undo snapshot`, () => {
        const host = classicHost(spec);
        host.panel.change(spec.edit, false);
        assert.deepEqual(host.events, ["canvas-before", "graph-before", "callback", "graph-after", "canvas-after"]);
        assert.equal(host.depth(), 0);
        assert.deepEqual(host.undo, [JSON.stringify(spec.initial)]);
        assert.notDeepEqual(spec.parse(host.state.value), spec.parse(host.undo[0]));
        // The host restores the old serialized widget, retaining reference IDs.
        host.state.value = host.undo.pop();
        assert.deepEqual(spec.parse(host.state.value), spec.initial);
    });

    test(`${spec.name}: a throwing widget callback still closes the history transaction`, () => {
        const host = classicHost(spec, true);
        {
            host.panel.change(spec.edit, false);
            assert.equal(host.panel.status.textContent, "callback failed");
        }
        assert.deepEqual(host.events, ["canvas-before", "graph-before", "callback", "graph-after", "canvas-after"]);
        assert.equal(host.depth(), 0);
        assert.deepEqual(host.undo, [JSON.stringify(spec.initial)]);
        assert.notDeepEqual(spec.parse(host.state.value), spec.initial);
    });

    test(`${spec.name}: invalid saved data does not open a history transaction`, () => {
        const host = classicHost(spec);
        host.state.value = JSON.stringify({ version: 0 });
        let edited = false;
        host.panel.change(() => { edited = true; }, false);
        assert.equal(edited, false);
        assert.deepEqual(host.events, []);
        assert.deepEqual(host.undo, []);
        assert.equal(host.depth(), 0);
        assert.ok(host.panel.status.textContent);
    });
}
