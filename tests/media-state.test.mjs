import test from "node:test";
import assert from "node:assert/strict";
import { parseMedia, references, referenceParts, moveMedia, replaceMedia, mediaError } from "../web/media/state.js";

test("typed Chinese and spaced English aliases bind to stable media identities", () => {
    const data = { version: 1, profile: "minimax_reference", items: [
        { id: "face", path: "face.png" }, { id: "body", path: "body.png" },
        { id: "clip", path: "clip.mp4", soundtrack: true }, { id: "song", path: "song.wav" },
    ], prompt: ["head_swap: < image 1 >、<IMAGE2>、图片 1、视频1、< Audio 1 >、音频2，图片10"] };
    const parsed = parseMedia(JSON.stringify(data));
    assert.deepEqual(parsed.prompt.filter(p => typeof p !== "string"), [
        { ref: "face", track: "main" }, { ref: "body", track: "main" }, { ref: "face", track: "main" },
        { ref: "clip", track: "main" }, { ref: "clip", track: "audio" }, { ref: "song", track: "main" },
    ]);
    moveMedia(parsed, "face", 1);
    assert.equal(parsed.prompt[1].ref, "face");
    assert.equal(references(parsed, text => text).find(r => r.ref === "face").ref, "face");
    assert.match(parsed.prompt.at(-1), /图片10$/);
    assert.deepEqual(referenceParts("unknown <image3>", references(data, text => text)), ["unknown <image3>"]);
});
import { connectedProfile, profilesForNode } from "../web/media/connection.js";

test("generic references detect a model only through the downstream native encoder", () => {
    const graph = { refs: { class_type: "HenjiccQwenReferenceList", inputs: { media: ["source", 0] } },
        slots: { class_type: "HenjiccImageListToSlots", inputs: { images: ["refs", 0] } } };
    assert.equal(connectedProfile("general", graph, "source"), "general");
    graph.encoder = { class_type: "TextEncodeQwenImage21", inputs: { image1: ["slots", 0] } };
    assert.equal(connectedProfile("general", graph, "source"), "qwen");
    graph.later = { class_type: "MiniMaxH3ImageToVideo", inputs: { start_image: ["encoder", 0] } };
    assert.equal(connectedProfile("general", graph, "source"), "qwen");
});

test("auto detection follows optimized media and handles cycles", () => {
    const graph = { assistant: { class_type: "HenjiccVisualPrompt", inputs: { media: ["source", 0] } },
        target: { class_type: "TextEncodeQwenImage21", inputs: { media: ["assistant", 2] } } };
    assert.equal(connectedProfile("general", graph, "source"), "qwen");
    graph.loop = { class_type: "HenjiccVisualPrompt", inputs: { media: ["assistant", 2] } };
    graph.assistant.inputs.media = ["loop", 2];
    delete graph.target;
    assert.equal(connectedProfile("general", graph, "assistant"), "general");
});

test("MiniMax task detection follows the assistant and excludes unrelated sources", () => {
    const graph = { assistant: { class_type: "HenjiccVisualPrompt", inputs: { media: ["source", 0] } },
        role: { class_type: "HenjiccH3RoleInputs", inputs: { media: ["assistant", 2] } },
        unrelated: { class_type: "HenjiccMiniMaxMedia", inputs: { media: ["other", 0] } } };
    const adapters = new Set();
    assert.equal(connectedProfile("general", graph, "source", type => adapters.add(type)), "minimax_reference");
    assert.deepEqual([...adapters], ["HenjiccH3RoleInputs"]);
});

test("a super input inside a subgraph detects adapters outside each instance", () => {
    const source = { id: 1 }, other = { id: 1 };
    const subgraph = { getNodeById: id => id === "1" ? source : null };
    const root = { getNodeById: id => ["4", "5"].includes(id) ? { subgraph } : other };
    const prompt = {
        "1": { class_type: "HenjiccSuperLoader" },
        "4:1": { class_type: "HenjiccSuperLoader" },
        "5:1": { class_type: "HenjiccSuperLoader" },
        adapter: { class_type: "TextEncodeQwenImage21", inputs: { media: ["4:1", 0] } },
        second: { class_type: "HenjiccMiniMaxMedia", inputs: { media: ["5:1", 0] } },
    };
    assert.deepEqual(profilesForNode("minimax_frames", prompt, root, source), ["minimax_frames", "qwen"]);
    assert.deepEqual(profilesForNode("minimax_frames", prompt, root, other), ["general"]);
});

test("connections choose the model without guessing MiniMax image intent", () => {
    const graph = { adapter: { class_type: "TextEncodeQwenImage21", inputs: { media: ["4:1", 0] } } };
    assert.equal(connectedProfile("minimax_frames", graph, "4:1"), "qwen");
    graph.adapter.class_type = "TextEncodeQwenImageEdit";
    assert.equal(connectedProfile("minimax_frames", graph, "4:1"), "qwen");
    graph.adapter.class_type = "TextEncodeQwenImage21";
    assert.equal(connectedProfile("minimax_frames", graph, "4:1"), "qwen");
    graph.adapter.class_type = "HenjiccMiniMaxMedia";
    assert.equal(connectedProfile("minimax_frames", graph, "4:1"), "minimax_frames");
    assert.equal(connectedProfile("qwen", graph, "4:1"), "minimax_reference");
    graph.adapter.class_type = "HenjiccH3RoleInputs";
    assert.equal(connectedProfile("general", graph, "4:1"), "minimax_reference");
    assert.equal(connectedProfile("qwen", graph, "other"), "general");
    graph.other = { class_type: "TextEncodeQwenImageEditPlus", inputs: { media: ["4:1", 0] } };
    assert.throws(() => connectedProfile("general", graph, "4:1"), /同时连接/);
    graph.other.inputs.media[1] = 1;
    assert.equal(connectedProfile("general", graph, "4:1"), "minimax_reference");
});
const t = (value, vars = {}) => value.replaceAll("{n}", vars.n);

test("reordering media preserves prompt identity and uses per-kind ordinals", () => {
    const state = parseMedia(JSON.stringify({ version: 1, profile: "minimax_reference", items: [
        { id: "i", path: "a.png" }, { id: "v", path: "v.mp4", soundtrack: true },
        { id: "a", path: "a.wav" }, { id: "j", path: "b.png" }], prompt: [{ ref: "i" }] }));
    assert.equal(references(state, t).find(r => r.ref === "a").label, "音频 2");
    moveMedia(state, "j", 0);
    assert.equal(references(state, t).find(r => r.ref === "i").label, "图片 2");
    assert.deepEqual(state.prompt, [{ ref: "i" }]);
    state.items = state.items.filter(i => i.id !== "i");
    assert.equal(mediaError(state), "请移除失效的提示词引用");
});

test("replacement keeps slot identity, prompt references and soundtrack while rejecting stale or incompatible uploads", () => {
    const state = { version: 1, profile: "general", items: [{ id: "a", path: "a.png" }, { id: "v", path: "v.mp4", soundtrack: true }], prompt: [{ ref: "a" }, { ref: "v", track: "audio" }] };
    replaceMedia(state, "a", "new.webp", "a.png");
    replaceMedia(state, "v", "new.mov", "v.mp4");
    assert.deepEqual(state.items, [{ id: "a", path: "new.webp" }, { id: "v", path: "new.mov", soundtrack: true }]);
    assert.equal(mediaError(state), "");
    const unchanged = JSON.stringify(state);
    assert.throws(() => replaceMedia(state, "a", "b.png", "a.png"), /素材已变化/);
    assert.throws(() => replaceMedia(state, "a", "b.wav", "new.webp"), /相同类型/);
    assert.throws(() => replaceMedia(state, "missing", "b.png", "a.png"), /素材已变化/);
    assert.equal(JSON.stringify(state), unchanged);
});
test("switching modes retains unsupported media and reports it instead of dropping it", () => {
    const state = { version: 1, profile: "qwen", items: [{ id: "v", path: "v.mp4" }], prompt: [] };
    assert.equal(mediaError(state), "当前模式只能使用图片");
    assert.equal(state.items.length, 1);
    state.profile = "minimax_reference";
    assert.equal(mediaError(state), "");
    state.prompt = [{ ref: "v", track: "audio" }];
    assert.equal(mediaError(state), "请移除失效的提示词引用");
    state.items[0].soundtrack = true;
    assert.equal(mediaError(state), "");
});
