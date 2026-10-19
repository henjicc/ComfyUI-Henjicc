import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { translator } from "../web/picker/i18n.js";

test("native task labels switch language without resetting node dimensions", () => {
    let extension, locale = "zh", changed;
    const app = { registerExtension: value => { extension = value; }, ui: { settings: {
        getSettingValue: () => locale, addEventListener: (_, fn) => { changed = fn; }, removeEventListener() {},
    } } };
    const source = fs.readFileSync(new URL("../web/visual-prompt.js", import.meta.url), "utf8");
    vm.runInNewContext(source.replace(/^import .*;$/gm, ""), { app, translator });
    const task = { name: "task", value: "auto", options: {} }, custom = { name: "custom_instruction" },
        duration = { name: "analysis_seconds", value: 10 };
    let resizes = 0;
    const node = { comfyClass: "HenjiccVisualPrompt", widgets: [task, custom, duration], size: [380, 220],
        graph: { setDirtyCanvas() {} }, computeSize: () => [380, custom.hidden ? 220 : 380],
        setSize(size) { this.size = size; resizes++; } };
    extension.nodeCreated(node);
    assert.equal(task.options.getOptionLabel("auto"), "自动识别");
    assert.equal(task.options.getOptionLabel("h3_swap"), "MiniMax 角色替换");
    assert.equal(duration.hidden, true);
    assert.equal(duration.value, 10); // Old serialized slots remain in place.
    const select = value => { task.value = value; task.callback(value); };
    for (const value of ["general", "h3_swap", "auto"]) select(value);
    assert.equal(resizes, 0);
    locale = "en"; changed();
    assert.equal(task.options.getOptionLabel("auto"), "Auto-detect");
    assert.equal(task.value, "auto");
    assert.equal(resizes, 0);
    select("custom"); assert.equal(custom.hidden, false); assert.equal(node.size[1], 380);
    select("auto"); assert.equal(custom.hidden, true); assert.equal(node.size[1], 220);
    node.size[1] = 245;
    select("general"); assert.equal(node.size[1], 245);
    select("custom"); node.size[1] = 420;
    select("auto"); assert.equal(node.size[1], 420);
});
