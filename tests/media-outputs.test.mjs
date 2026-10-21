import test from "node:test";
import assert from "node:assert/strict";
import { syncMediaOutputs, serializeMediaOutputs, restoreMediaOutputShape } from "../web/media/outputs.js";

function node() {
    return { graph: {}, properties: {}, size: [610, 530],
        outputs: ["media", "prompt", "has_images", "first_last", "preset"].map(name => ({ name, links: [] })),
        isOutputConnected(index) { return this.outputs[index].links.length > 0; },
        removeOutput(index) { assert.equal(this.outputs[index].links.length, 0); this.outputs.splice(index, 1); },
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
        setSize(size) { this.size = size; }, setDirtyCanvas() {},
    };
}
const names = node => node.outputs.map(output => output.name);

test("API serialization normalizes manual reference aliases without mutating the saved prompt", () => {
    const value = JSON.stringify({ version: 1, profile: "qwen", items: [{ id: "person", path: "a.png" }], prompt: ["将图片 1转成 < image 1 > 的风格"] });
    const exported = JSON.parse(serializeMediaOutputs(value, node()));
    assert.equal(exported.prompt.filter(part => typeof part === "object").length, 2);
    assert.ok(exported.prompt.filter(part => typeof part === "object").every(part => part.ref === "person"));
    assert.equal(JSON.parse(value).prompt.length, 1);
});
const t = text => text;

test("Fibo exposes the image-presence switch without unrelated MiniMax ports", () => {
    const n = node();
    syncMediaOutputs(n, {}, ["fibo2"], t);
    assert.deepEqual(names(n), ["media", "prompt", "has_images"]);
});

test("reopening compact slots keeps preset type before the host's index-based merge", () => {
    const n = node();
    const saved = [ {name:"media"}, {name:"prompt"}, {name:"preset",type:"HENJICC_PRESET",links:[10]} ];
    restoreMediaOutputShape(n, saved);
    const merged = saved.map((output, i) => ({ ...output, ...n.outputs[i] }));
    assert.deepEqual(merged[2], {name:"preset",type:"HENJICC_PRESET",links:[10]});
    assert.equal(n.outputs.length, 3);
});

test("V3 display name becomes the stable preset identity before compacting or exporting", () => {
    const n = node(); n.outputs[4].name = "Preset size"; n.outputs[4].links.push(10);
    assert.equal(JSON.parse(serializeMediaOutputs("{}", n))._output_names[4], "preset");
    syncMediaOutputs(n, { preset: { width: 2752, height: 1536 } }, ["qwen"], t);
    assert.deepEqual(names(n), ["media", "prompt", "preset"]);
    assert.deepEqual(n.outputs[2].links, [10]);
});

test("Qwen hides unused ports, preserves connected ports, and carries exact API mapping", () => {
    const n = node(); n.outputs[4].links.push(10);
    syncMediaOutputs(n, { preset: { name: "Text only" } }, ["qwen"], t);
    assert.deepEqual(names(n), ["media", "prompt", "preset"]);
    const input = JSON.stringify({ version: 1, prompt: ["unchanged"] });
    assert.deepEqual(JSON.parse(serializeMediaOutputs(input, n))._output_names, names(n));
    assert.equal(JSON.parse(input)._output_names, undefined);
    n.outputs[2].links = [];
    syncMediaOutputs(n, {}, ["qwen"], t);
    assert.deepEqual(names(n), ["media", "prompt"]);
});

test("model, size, show-all and reconnect changes retain connections and user dimensions", () => {
    const n = node(); syncMediaOutputs(n, {}, ["general"], t);
    syncMediaOutputs(n, { preset: { width: 2752, height: 1536 } }, ["qwen"], t);
    const sizePort = n.outputs[2]; sizePort.links.push(20);
    syncMediaOutputs(n, {}, ["minimax_reference"], t);
    assert.equal(n.outputs[2], sizePort);
    assert.deepEqual(names(n), ["media", "prompt", "preset", "first_last"]);
    n.outputs[3].links.push(21); n.properties.henjiccShowAllPorts = true;
    syncMediaOutputs(n, {}, ["qwen"], t);
    assert.equal(n.outputs.length, 5);
    n.properties.henjiccShowAllPorts = false; syncMediaOutputs(n, {}, ["qwen"], t);
    assert.deepEqual(names(n), ["media", "prompt", "preset", "first_last"]);
    assert.deepEqual(n.outputs[3].links, [21]);
    assert.deepEqual(n.size, [610, 530]);
});
