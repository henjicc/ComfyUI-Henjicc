import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { translator, responseError } from "../web/picker/i18n.js";
import { relativePath, ancestors } from "../web/picker/navigation.js";
import { ImagePicker } from "../web/picker/panel.js";
import { pickerSettings, pickerPreferences } from "../web/picker/settings.js";
import { cardDetails, HoverPlayer } from "../web/picker/card-details.js";

function interaction(t, overrides = {}) {
    const pending = new Map(), used = [];
    let id = 0;
    t.mock.method(globalThis,"setTimeout",(fn,delay) => { pending.set(++id,{fn,delay}); return id; });
    t.mock.method(globalThis,"clearTimeout",key => pending.delete(key));
    const picker = Object.assign(Object.create(ImagePicker.prototype), {
        mode:"use", preferences:pickerPreferences(), selected:new Set(["previous.png"]),
        t:translator("en"),dialog:{open:true,dataset:{}}, modeSelect:{}, footer:{},metadataControls:{},useButton:{},tags:{focus(){}},rating:{},
        choose() { used.push([...this.selected]); }, renderSelection() {}, ...overrides,
    });
    return {picker,pending,used};
}

test("single click waits for the preview interval and uses only the clicked asset", t => {
    const {picker,pending,used} = interaction(t);
    picker.activate({path:"folder/a.png"},{detail:1});
    assert.equal(used.length,0);
    assert.equal([...pending.values()][0].delay,500);
    [...pending.values()][0].fn();
    assert.deepEqual(used,[["folder/a.png"]]);
});

test("changing to rating mode cancels pending use; rating never applies an asset", t => {
    const {picker,pending,used} = interaction(t);
    picker.activate({path:"a.png"},{detail:1});
    picker.setMode("rate");
    assert.equal(pending.size,0);
    picker.activate({path:"a.png",rating:3,tags:[]},{detail:1});
    assert.equal(used.length,0); assert.equal(picker.mode,"rate");
});

test("editing a card cancels pending use and can exit without applying assets", t => {
    const {picker,pending,used}=interaction(t);
    picker.activate({path:"a.png"},{detail:1});
    picker.editItem({path:"edit.png"});
    assert.equal(pending.size,0);assert.equal(picker.mode,"rate");
    assert.deepEqual([...picker.selected],["edit.png"]);
    assert.equal(picker.useButton.textContent,"Exit edit mode");
    picker.setMode(picker.returnMode);
    assert.equal(picker.mode,"use");assert.equal(used.length,0);
});

test("edit mode allows multi-selection and Shift ranges for a single-input picker", t => {
    const {picker,used}=interaction(t,{mode:"rate",multiple:false,selected:new Set(),items:[{path:"a"},{path:"b"},{path:"c"}]});
    picker.activate({path:"a"},{detail:1});
    picker.activate({path:"c"},{detail:1,shiftKey:true});
    assert.deepEqual([...picker.selected],["a","b","c"]);assert.equal(picker.mode,"rate");assert.equal(used.length,0);
});

test("editor drafts survive reload status changes and controls disable while loading", () => {
    const field={disabled:false};
    const picker=Object.assign(Object.create(ImagePicker.prototype),{
        t:translator("en"),source:"input",mode:"rate",selected:new Set(["a.png"]),items:[{path:"a.png",rating:4,tags:["old"]}],
        selectionText:{},useButton:{},rating:{},tags:{},grid:{children:[]},deleteButton:{},
        dialog:{dataset:{}},modeSelect:{},footer:{},metadataControls:{querySelectorAll:()=>[field]},
    });
    picker.renderSelection();picker.tags.value="draft";picker.loading=true;picker.renderSelection();
    assert.equal(picker.tags.value,"draft");assert.equal(field.disabled,true);
    picker.loading=false;picker.renderSelection();assert.equal(field.disabled,false);
    assert.equal(picker.useButton.disabled,false);
    picker.setMode("use");picker.items[0].tags=["updated"];picker.setMode("rate");
    assert.equal(picker.tags.value,"updated");
});

test("keyboard use and disabling double-click preview have no artificial delay", t => {
    const {picker,pending,used} = interaction(t);
    picker.activate({path:"a.png"},{detail:0});
    picker.preferences.DoubleClickPreview=false;
    picker.activate({path:"b.png"},{detail:1});
    assert.equal(pending.size,0); assert.deepEqual(used,[["a.png"],["b.png"]]);
});

test("picker preferences come from host settings and reject invalid timing", () => {
    const prefs = pickerPreferences({getSettingValue:(id,fallback) => id.endsWith("SingleClickUse") ? false : id.endsWith("DoubleClickDelay") ? "bad" : fallback});
    assert.equal(prefs.SingleClickUse,false); assert.equal(prefs.DoubleClickDelay,500);
    assert.equal("ShowFilenames" in prefs,false); assert.equal(prefs.CropThumbnails,false);
    assert.equal(new Set(pickerSettings.map(item=>item.id)).size,pickerSettings.length);
});

test("card details show only existing metadata and respect per-media names and positions", () => {
    const prefs=pickerPreferences();
    const image={kind:"image",name:"portrait.png",rating:0,tags:[]};
    assert.deepEqual(cardDetails(image,prefs),[]);
    assert.deepEqual(cardDetails({...image,kind:"audio",name:"song.wav"},prefs),[{type:"filename",text:"song",position:"Below thumbnail"}]);
    assert.equal(cardDetails({...image,rating:4,tags:["art"]},prefs).length,2);
    const custom={...prefs,ShowImageNames:true,ShowExtensions:true,FilenamePosition:"Top left",ShowRatings:false,ShowTags:false};
    assert.deepEqual(cardDetails({...image,rating:4,tags:["art"]},custom),[{type:"filename",text:"portrait.png",position:"Top left"}]);
});

test("hover playback releases media and ignores a late playback rejection", async t => {
    const previous=globalThis.document;
    t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
    let reject,paused=0,released=0;
    const media={setAttribute(){},addEventListener(){},play:()=>new Promise((resolve,fail)=>{reject=fail;}),
        pause(){paused++;},removeAttribute(){released++;},load(){},remove(){}};
    globalThis.document={createElement:()=>media};
    const errors=[];
    const player=new HoverPlayer({api:{apiURL:url=>url},t:translator("en"),onError:message=>errors.push(message)});
    const pending=player.play({kind:"audio",path:"tone.wav"},{isConnected:true,dataset:{},append(){}},"temp");
    player.stop();reject({name:"NotAllowedError"});await pending;
    assert.equal(paused,1);assert.equal(released,1);assert.deepEqual(errors,[]);
    assert.equal(player.media,null);
});

test("folder expansion loads on demand and a late reveal cannot switch the visible directory", async () => {
    let finish, requests = 0, renders = 0;
    const picker = Object.assign(Object.create(ImagePicker.prototype), {
        folderCache: new Map(), folderRequests: new Map(), expanded: new Set(),
        treeController: new AbortController(), mediaKind:"image", generation:1, dialog:{open:true},
        request: async () => { requests++; return {json:() => new Promise(resolve => { finish=resolve; })}; },
        renderTree() { renders++; }, status:{},
    });
    const first = picker.treeFolders("");
    const second = picker.treeFolders("");
    const reveal = picker.revealDirectory("",1);
    await Promise.resolve(); await Promise.resolve();
    picker.generation = 2;
    finish({folders:[{name:"人物",path:"人物"}]});
    await Promise.all([first,second,reveal]);
    assert.equal(requests,1); assert.equal(renders,0);
    assert.equal(picker.expanded.size,0);
    await picker.revealDirectory("",2);
    assert.equal(requests,1); assert.equal(renders,1);
});

test("late tree results stay in their original source and switching preserves expansion", async () => {
    let finish;
    const input={cache:new Map(),expanded:new Set(["","people"]),requests:new Map()};
    const output={cache:new Map(),expanded:new Set([""]),requests:new Map()};
    const picker=Object.assign(Object.create(ImagePicker.prototype),{
        source:"input",sourceTrees:new Map([["input",input],["output",output]]),
        folderCache:input.cache,folderRequests:input.requests,expanded:input.expanded,
        selected:new Set(),deleteButton:{},treeController:new AbortController(),mediaKind:"image",
        request:()=>new Promise(resolve=>{finish=resolve;}),renderTree(){},load(){},
    });
    const old=picker.treeFolders("");
    picker.setSource("output");
    finish({json:async()=>({folders:[{path:"people"}]})});
    await old;
    assert.deepEqual(input.cache.get(""),[{path:"people"}]);
    assert.equal(output.cache.size,0);
    assert.ok(input.expanded.has("people"));
    picker.setSource("input","people");
    assert.ok(picker.expanded.has("people"));
    assert.ok(output.expanded.has(""));
    assert.equal(picker.directory,"people");
});

test("loading retains the current content until replacement data arrives", async () => {
    let finish,clears=0;
    const picker=Object.assign(Object.create(ImagePicker.prototype),{
        t:translator("en"),dialog:{open:true},generation:0,urls:[],selected:new Set(),multiple:false,source:"input",directory:"next",
        grid:{setAttribute(){},removeAttribute(){},replaceChildren(){clears++;}},
        status:{},previous:{},next:{},uploadButton:{},search:{value:""},sort:{value:"date"},
        order:{value:"desc"},filterRating:{value:0},offset:0,mediaKind:"image",folderCache:new Map(),
        pageText:{},paging:{},renderSelection(){},revealDirectory(){},renderImages(){},
        request:()=>new Promise(resolve=>{finish=resolve;}),
    });
    const loading=picker.load();
    assert.equal(clears,0); assert.equal(picker.grid.inert,true);
    finish({json:async()=>({images:[],folders:[],total:0})});
    await loading;
    assert.equal(clears,1); assert.equal(picker.grid.inert,false); assert.equal(picker.loading,false);
});

test("output selections are imported before returning an input-relative path", async () => {
    let used, request;
    const picker = {source:"output",selected:new Set(["generated.png"]),multiple:false,busy:false,
        status:{},close(){},onSelect:path=>{used=path;},
        async mutate(path,data){request={path,data};return {paths:["henjicc/imports/copied.png"]};}};
    await ImagePicker.prototype.choose.call(picker);
    assert.equal(used,"henjicc/imports/copied.png");
    assert.deepEqual(request,{path:"/import",data:{paths:["generated.png"]}});
});

test("picker paths accept Windows separators and preserve native input-relative values", () => {
    assert.equal(relativePath("人物\\参考图.png [input]"),"人物/参考图.png");
    assert.equal(relativePath("人物\\子目录\\",true),"人物/子目录");
    assert.equal(relativePath("folder/my image.png"),"folder/my image.png");
    assert.deepEqual(ancestors("人物/子目录"),["","人物","人物/子目录"]);
    assert.deepEqual(ancestors(""),[""]);
    for (const path of ["/","/input","C:\\input","../secret","a/../b","a//b",".hidden","a\0b"]) {
        assert.throws(() => relativePath(path,true));
    }
});

// Run the shipped extension with only its host/browser boundaries substituted.
const source = (await readFile(new URL("../web/image-picker.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify("http://localhost/extensions/Henjicc/image-picker.js"));

function host() {
    let extension;
    let enabled = true;
    let locale = "zh";
    const listeners = new Map();
    const graph = { subgraphs: new Map(), computeExecutionOrder: () => nodes, setDirtyCanvas() {} };
    const nodes = [];
    const app = { graph, ui: { settings: {
        getSettingValue: id => id === "Comfy.Locale" ? locale : enabled,
        addEventListener: (event, callback) => listeners.set(event, callback),
    } }, registerExtension(value) { extension = value; } };
    const requests = [];
    const api = { async fetchApi(url) {
        requests.push(url);
        return { ok: new URL(url, "http://localhost").searchParams.get("path") === "folder/exists.png" };
    } };
    const document = { createElement: () => ({}), head: { append() {} } };
    new Function("app", "api", "ImagePicker", "document", "translator", "pickerSettings", source)(app, api, class {}, document, translator, pickerSettings);
    extension.setup();
    function node(type, value, owner = graph) {
        const image = { name: "image", value, hidden: false, options: { values: ["root.png"] } };
        const upload = { name: "upload", hidden: true };
        const result = { type, graph: owner, widgets: [image, upload], size: [600, 500],
            addWidget(type, name, value, callback, options) {
                const widget = { type, name, value, callback, options }; this.widgets.push(widget); return widget;
            }, computeSize: () => [200, 100], setSize(size) { this.size = size; } };
        nodes.push(result);
        return result;
    }
    return { node, graph, extension, requests, disable() { enabled = false; extension.settings[0].onChange(); },
        changeLocale(value) { locale = value; listeners.get("Comfy.Locale.change")(); } };
}

test("injection is idempotent, preserves values and size, and restores original visibility", () => {
    const h = host();
    const node = h.node("LoadImage", "root.png");
    const unrelated = h.node("OtherNode", "root.png");
    h.extension.nodeCreated(node);
    h.extension.loadedGraphNode(node);
    h.extension.nodeCreated(unrelated);
    assert.equal(node.widgets.length, 3);
    assert.equal(unrelated.widgets.length, 2);
    assert.equal(node.widgets[0].hidden, true);
    assert.deepEqual(node.size, [600, 500]);
    assert.equal(node.widgets[0].value, "root.png");
    assert.equal(node.widgets[2].options.serialize, false);
    h.disable();
    assert.equal(node.widgets[0].hidden, false);
    assert.equal(node.widgets[1].hidden, true);
    assert.equal(node.widgets[2].hidden, true);
});

test("changing the host language updates existing buttons without changing settings identity", () => {
    const h = host();
    const node = h.node("LoadImage", "root.png");
    h.extension.nodeCreated(node);
    assert.equal(node.widgets[2].label, "资源库");
    h.changeLocale("en");
    assert.equal(node.widgets[2].label, "Resource Library");
    h.changeLocale("zh-CN");
    assert.equal(node.widgets[2].label, "资源库");
    assert.equal(h.extension.settings[0].id, "Henjicc.ImageLibrary.InjectLoadImage");
    assert.equal(node.widgets[0].value, "root.png");
});

test("localized status and errors preserve user text and use English as fallback", () => {
    const zh = translator("zh-CN"), en = translator("en-US");
    assert.equal(zh("痕继痕迹"), "痕继痕迹");
    assert.equal(en("痕继痕迹"), "Henjicc");
    assert.equal(translator("fr")("图片库"), "Image Library");
    assert.equal(en("已选 {n} 张", { n: 2 }), "2 selected");
    assert.equal(responseError(en, "不能访问隐藏路径或上级目录", 400), "Hidden paths and parent directory traversal are not allowed");
    assert.equal(responseError(zh, "Raw Python error", 500), "请求失败 (500)");
});

test("all image library messages have an English translation", async () => {
    const panel = await readFile(new URL("../web/picker/panel.js", import.meta.url), "utf8");
    const en = translator("en");
    for (const [, message] of panel.matchAll(/this\.t\("([^"\n]+)"/g)) {
        assert.doesNotMatch(en(message), /[\u4e00-\u9fff]/, message);
    }
});

test("workflow restoration adds only existing subfolder images, including subgraphs", async () => {
    const h = host();
    const valid = h.node("LoadImage", "folder/exists.png");
    const missing = h.node("LoadImage", "folder/missing.png");
    const subgraph = { computeExecutionOrder: () => [nested], setDirtyCanvas() {} };
    const nested = h.node("LoadImage", "folder/exists.png", subgraph);
    h.graph.subgraphs.set("sub", subgraph);
    await h.extension.afterConfigureGraph();
    assert.ok(valid.widgets[0].options.values.includes("folder/exists.png"));
    assert.ok(nested.widgets[0].options.values.includes("folder/exists.png"));
    assert.ok(!missing.widgets[0].options.values.includes("folder/missing.png"));
    assert.equal(h.requests.length, 2);
    h.disable();
    assert.equal(nested.widgets[0].hidden, false);
});
