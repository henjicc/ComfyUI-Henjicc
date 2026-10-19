import test from "node:test";
import assert from "node:assert/strict";
import { MediaViewer, mediaViewUrl } from "../web/media-viewer.js";

test("preview URLs keep filenames and subfolders inside the host view contract", () => {
    const url = new URL(mediaViewUrl({ apiURL: path => `http://localhost${path}` }, "henjicc/中文 & 图片.png"));
    assert.equal(url.pathname, "/view");
    assert.equal(url.searchParams.get("filename"), "中文 & 图片.png");
    assert.equal(url.searchParams.get("subfolder"), "henjicc");
    assert.equal(url.searchParams.get("type"), "input");
});

test("switching preview media stops the previous player and ignores its late error", t => {
    const originalDocument = globalThis.document;
    t.after(() => { globalThis.document = originalDocument; });
    const players = [];
    globalThis.document = { createElement: type => {
        const media = { type, events: {}, stops: [], addEventListener(name, fn) { this.events[name] = fn; },
            pause() { this.stops.push("pause"); }, removeAttribute(name) { this.stops.push(name); }, load() { this.stops.push("load"); } };
        players.push(media); return media;
    } };
    const viewer = new MediaViewer({ api: { apiURL: path => path }, t: value => value });
    viewer.items = [{ id: "v", path: "v.mp4", label: "视频 1" }, { id: "a", path: "a.wav", label: "音频 1" }, { id: "i", path: "i.png", label: "图片 1" }];
    viewer.index = 0; viewer.label = {}; viewer.counter = {}; viewer.status = {};
    viewer.content = { firstChild: null, querySelectorAll() { return [this.firstChild].filter(media => media && ["video", "audio"].includes(media.type)); }, replaceChildren(media) { this.firstChild = media; } };
    let removed = false;
    viewer.dialog = { open: true, remove() { removed = true; } };
    viewer.show(); assert.equal(players[0].controls, true);
    viewer.move(1); assert.equal(viewer.label.textContent, "音频 1"); assert.equal(viewer.counter.textContent, "2 / 3");
    assert.deepEqual(players[0].stops, ["pause", "src", "load"]);
    players[0].events.error(); assert.equal(viewer.status.textContent, "");
    players[1].events.error(); assert.equal(viewer.status.textContent, "素材缺失或浏览器无法预览");
    viewer.move(1); assert.equal(players[2].alt, "图片 1"); assert.equal(viewer.status.textContent, "");
    viewer.move(1); assert.equal(viewer.index, 0);
    viewer.dispose(); assert.equal(removed, true); assert.deepEqual(players[3].stops, ["pause", "src", "load"]);
});
