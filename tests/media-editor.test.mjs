import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/media/composer.js", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "").replace("export class MediaComposer", "class MediaComposer");
function composer(document, window = {}) {
    const Class = vm.runInNewContext(`${source}\nMediaComposer;`, { document, window, queueMicrotask });
    return Object.create(Class.prototype);
}

test("inserting a reference places the caret inside its trailing editable text", () => {
    const document = { createTextNode: text => ({ textContent: text, nodeType: 3 }) };
    const range = { deleteContents() {}, insertNode() {}, collapse() {},
        setStart(container, offset) { this.container = container; this.offset = offset; },
        setStartAfter(container) { this.container = { parentOf: container }; this.offset = 1; } };
    const selection = { removeAllRanges() {}, addRange(value) { this.range = value; } };
    const c = composer(document, { getSelection: () => selection });
    let saves = 0;
    Object.assign(c, { editor: { focus() {} }, referenceMenu: { hide() {} },
        mentionRange: range, chip: () => ({}), savePrompt: () => saves++ });
    c.insertReference({ ref: "video", track: "main" });
    assert.equal(selection.range.container.textContent, " ");
    assert.equal(selection.range.offset, 1);
    assert.equal(saves, 1);
});

test("IME preedit is not persisted and the committed first character is saved once", async () => {
    const editor = new EventTarget(), document = { activeElement: editor };
    const c = composer(document);
    let text = [""], edits = 0, normalizations = 0;
    Object.assign(c, { editor, state: { value: JSON.stringify({ prompt: text }) },
        referenceMenu: { hide() {} }, normalizeReferences() { normalizations++; }, mention() {},
        readPrompt: () => text,
        change(action) { const state = JSON.parse(this.state.value); action(state); this.state.value = JSON.stringify(state); edits++; } });
    c.bindPromptEditor();
    editor.dispatchEvent(new Event("compositionstart"));
    text = ["z"];
    editor.dispatchEvent(Object.assign(new Event("input"), { isComposing: true }));
    text = ["zh"];
    editor.dispatchEvent(new Event("input"));
    assert.equal(edits, 0);
    assert.equal(normalizations, 0);
    editor.dispatchEvent(new Event("compositionend"));
    text = ["中"];
    editor.dispatchEvent(new Event("input"));
    await Promise.resolve();
    assert.equal(edits, 1);
    assert.deepEqual(JSON.parse(c.state.value).prompt, ["中"]);
    text = ["中A"];
    editor.dispatchEvent(new Event("input"));
    assert.equal(edits, 2);
    editor.dispatchEvent(new Event("input"));
    assert.equal(edits, 2);
});

test("a delayed composition commit cannot write after the editor is replaced", async () => {
    const editor = new EventTarget(), c = composer({ activeElement: editor });
    Object.assign(c, { editor, referenceMenu: { hide() {} }, normalizeReferences() { assert.fail("stale editor"); } });
    c.bindPromptEditor();
    editor.dispatchEvent(new Event("compositionstart"));
    editor.dispatchEvent(new Event("compositionend"));
    c.editor = new EventTarget();
    await Promise.resolve();
});
