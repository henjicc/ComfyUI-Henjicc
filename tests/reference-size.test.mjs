import test from "node:test";
import assert from "node:assert/strict";
import { referenceImagePath, createImageSizeReader, watchReferenceSource } from "../web/reference-size.js";

test("image changes notify boards without replacing the native change behavior", () => {
    let updates = 0;
    const node = { comfyClass: "LoadImage", onWidgetChanged(name) { assert.equal(this, node); return name; } };
    watchReferenceSource(node, () => updates++);
    assert.equal(node.onWidgetChanged("image", "new.png", "old.png"), "image");
    assert.equal(updates, 1);
    node.onWidgetChanged("unrelated");
    assert.equal(updates, 1);
});

test("native LoadImage resolves its IMAGE output and input annotations only", () => {
    const graph = { 1: { class_type: "LoadImage", inputs: { image: "目录/a.png [input]" } } };
    assert.equal(referenceImagePath(graph, ["1", 0]), "目录/a.png");
    assert.equal(referenceImagePath(graph, ["1", 1]), null);
    graph[1].inputs.image = "a.png [temp]";
    assert.equal(referenceImagePath(graph, ["1", 0]), null);
});

test("core reference chain follows optimized media to the first original image", () => {
    const graph = {
        source: { class_type: "HenjiccSuperLoader", inputs: { media: JSON.stringify({ items: [{ path: "v.mp4" }, { path: "a.png" }, { path: "b.png" }] }) } },
        helper: { class_type: "HenjiccVisualPrompt", inputs: { media: ["source", 0] } },
        refs: { class_type: "HenjiccQwenReferenceList", inputs: { media: ["helper", 2] } },
    };
    assert.equal(referenceImagePath(graph, ["refs", 2]), "a.png");
    // A resized image list is deliberately not treated as the original image.
    assert.equal(referenceImagePath(graph, ["refs", 0]), null);
    graph.helper.inputs.media = ["helper", 2];
    assert.equal(referenceImagePath(graph, ["refs", 2]), null);
});



test("only definite switch branches resolve; transforms and cycles stay unknown", () => {
    const graph = {
        image: { class_type: "LoadImage", inputs: { image: "a.png" } },
        resized: { class_type: "ImageScale", inputs: { image: ["image", 0] } },
        switch: { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: ["image", 0], on_true: ["resized", 0] } },
    };
    assert.equal(referenceImagePath(graph, ["switch", 0]), "a.png");
    graph.switch.inputs.switch = true;
    assert.equal(referenceImagePath(graph, ["switch", 0]), null);
    graph.switch.inputs.on_true = ["switch", 0];
    assert.equal(referenceImagePath(graph, ["switch", 0]), null);
});

test("metadata reads deduplicate and invalidate same-path replacements", async () => {
    let count = 0, width = 960;
    const read = createImageSizeReader(async () => { count++; return { width, height: 1440 }; });
    assert.deepEqual(await Promise.all([read("a.png"), read("a.png")]), [[960, 1440], [960, 1440]]);
    assert.equal(count, 1);
    width = 1920; read.clear();
    assert.deepEqual(await read("a.png"), [1920, 1440]);
    assert.equal(count, 2);
});

test("invalid metadata and failures can be retried", async () => {
    let value = { width: 0, height: 10 };
    const read = createImageSizeReader(async () => value);
    await assert.rejects(read("a.png"));
    value = { width: 20, height: 10 };
    assert.deepEqual(await read("a.png"), [20, 10]);
});
