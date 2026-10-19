import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { uniqueId } from "../web/identity.js";
import { serializeMediaOutputs, restoreMediaOutputShape } from "../web/media/outputs.js";

// A small DOM boundary for exercising the actual resolution controls.
class Control {
    children = []; attributes = {}; listeners = {}; style = {};
    constructor(tag) { this.tagName = tag; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelectorAll(selector) {
        return this.children.flatMap(child => child instanceof Control
            ? [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)] : []);
    }
    click() { this.listeners.click?.(); }
}

async function resolutionControls() {
    const source = (await readFile(new URL("../web/presets.js", import.meta.url), "utf8"))
        .replace(/^import .*;\r?\n/gm, "")
        .replaceAll("import.meta.url", '"http://localhost/extensions/Henjicc/presets.js"');
    const events = [];
    const app = { registerExtension() {}, ui: { settings: {
        getSettingValue: () => "zh", addEventListener() {},
    } }, canvas: { emitBeforeChange() { events.push("before"); }, emitAfterChange() { events.push("after"); } } };
    const document = { createElement: tag => new Control(tag), head: { append() {} } };
    class ResizeObserver { observe() {} disconnect() {} }
    class ModeMenu { constructor() { this.button = new Control("button"); } dispose() {} }
    const ResolutionPanel = new Function("app", "api", "document", "bindNodeAppearance", "createImageSizeReader", "ResizeObserver", "ModeMenu", "icon",
        `${source}\nreturn ResolutionPanel;`)(app, {}, document, () => () => {}, () => ({}), ResizeObserver, ModeMenu, () => new Control("svg"));
    const mount = node => {
        const panel = new ResolutionPanel(node);
        panel.refresh = () => {}; // No network or image decoding in this control test.
        panel.render();
        return panel;
    };
    return { mount, events };
}

test("resolution lock/free control survives saving, reopening, and history restoration", async () => {
    const { mount, events } = await resolutionControls();
    const node = { properties: { otherSetting: "kept" }, widgets: [], setDirtyCanvas() {} };
    const panel = mount(node);
    const lock = () => panel.element.querySelectorAll("button").find(button => ["锁定比例", "自由比例"].includes(button.textContent));
    assert.equal(lock().textContent, "锁定比例", "old workflows retain their locked default");
    lock().click();
    assert.equal(lock().textContent, "自由比例");
    assert.deepEqual(events, ["before", "after"]);
    const saved = JSON.parse(JSON.stringify(node));
    assert.equal(saved.properties.henjiccRatioLocked, false);
    const reopened = mount({ ...structuredClone(saved), setDirtyCanvas() {} });
    const reopenedLock = () => reopened.element.querySelectorAll("button").find(button => ["锁定比例", "自由比例"].includes(button.textContent));
    assert.equal(reopenedLock().textContent, "自由比例");
    reopenedLock().click();
    assert.equal(reopened.node.properties.henjiccRatioLocked, true);
    reopened.node.properties = structuredClone(saved.properties);
    reopened.render();
    assert.equal(reopenedLock().textContent, "自由比例", "undo reads restored properties instead of stale panel state");
    assert.equal(reopened.node.properties.otherSetting, "kept");
});

test("all resolution inputs and the ratio state share workflow persistence", async () => {
    const { mount } = await resolutionControls();
    const values = { profile: "general", mode: "custom", width: 768, height: 512, megapixels: 1.25, fit: false, alignment: "16" };
    const node = { properties: {}, widgets: Object.keys(values).map(name => ({ name, options: {}, value: null })), setDirtyCanvas() {} };
    const panel = mount(node);
    panel.change(values, { henjiccRatioLocked: false });
    const reopened = mount({ ...JSON.parse(JSON.stringify(node)), setDirtyCanvas() {} });
    assert.deepEqual(Object.fromEntries(reopened.node.widgets.map(({ name, value }) => [name, value])), values);
    assert.equal(reopened.locked, false);
});

for (const [file, type, stateName, component] of [
    ["super-loader.js", "HenjiccSuperLoader", "media", "MediaComposer"],
]) {
    test(`${type}: graph restoration remounts its view without serializing view identity`, async () => {
        let extension;
        const source = (await readFile(new URL(`../web/${file}`, import.meta.url), "utf8"))
            .replace(/^import .*;\r?\n/gm, "")
            .replaceAll("import.meta.url", JSON.stringify(`http://localhost/extensions/Henjicc/${file}`));
        class Panel {
            element = {};
            constructor({ node }) { this.node = node; }
            render() {}
            dispose() { this.disposed = true; }
        }
        const app = { registerExtension: value => { extension = value; } };
        const document = { createElement: () => ({}), head: { append() {} } };
        new Function("app", "api", component, "document", "uniqueId", "serializeMediaOutputs", "restoreMediaOutputShape", source)(app, {}, Panel, document, uniqueId, serializeMediaOutputs, restoreMediaOutputShape);
        const makeNode = () => ({
            id: 1, comfyClass: type, title: type === "HenjiccSuperLoader" ? "超级加载 · 图片与提示词" : "多图输入", widgets: [{ name: stateName, value: "saved input" }],
            addDOMWidget(name, type, element, options) {
                const widget = { name, type, element, options, value: "" };
                this.widgets.push(widget); return widget;
            },
            setSize(size) { this.size = size; },
            outputs: [{ name: "media" }, { name: "prompt" }, { name: "has_images" }, { name: "first_last" }],
            addOutput(name, type) { this.outputs.push({ name, type }); },
        });
        const original = makeNode();
        extension.nodeCreated(original);
        original.onRemoved();
        const restored = makeNode();
        extension.nodeCreated(restored);
        // Nodes 2.0 caches a mount by node/widget name. Undo recreates the same
        // node ID; reusing its old name leaves a disposed panel on screen.
        assert.notEqual(original.widgets[1].name, restored.widgets[1].name);
        assert.notEqual(original.widgets[1].element, restored.widgets[1].element);
        assert.equal(restored.widgets[1].serialize, false);
        assert.deepEqual(restored.widgets.filter(w => w.serialize !== false).map(w => w.value), ["saved input"]);
        restored.size = [420, 600];
        restored.onConfigure();
        assert.deepEqual(restored.size, [420, 600]);
        if (type === "HenjiccSuperLoader") {
            assert.equal(restored.title, "超级输入 · 图片与提示词");
            restored.onConfigure();
            assert.equal(restored.outputs.length, 4); // Port updates wait for restored graph connections.
        }
    });
}
