import { uniqueId } from "./identity.js";
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { MediaComposer } from "./media/composer.js";
import { serializeMediaOutputs, restoreMediaOutputShape } from "./media/outputs.js";

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./media/composer.css", import.meta.url).href;
document.head.append(style);
const composers = new Set();
let scheduled = false;
function refreshConnections() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        const graphs = new Map();
        for (const composer of composers) {
            const graph = composer.node.graph?.rootGraph ?? composer.node.graph;
            if (!graph) continue;
            if (!graphs.has(graph)) graphs.set(graph, app.graphToPrompt(graph));
            composer.updateConnection(graphs.get(graph));
        }
    });
}

app.registerExtension({
    name: "Henjicc.SuperLoader",
    setup() {
        app.canvas.canvas.addEventListener("litegraph:canvas", event => {
            if (event.detail?.subType === "after-change") refreshConnections();
        });
        app.canvas.canvas.addEventListener("subgraph-opened", refreshConnections);
    },
    afterConfigureGraph: refreshConnections,
    nodeCreated(node) {
        if (node.comfyClass !== "HenjiccSuperLoader") return;
        const state = node.widgets?.find(widget => widget.name === "media");
        if (!state) return;
        state.hidden = true;
        state.serializeValue = () => serializeMediaOutputs(state.value, node);
        const configureNode = node.configure;
        node.configure = function (data, ...args) {
            restoreMediaOutputShape(this, data?.outputs);
            return configureNode.call(this, data, ...args);
        };
        const composer = new MediaComposer({ node, state, app, api });
        const dragOver = node.onDragOver, dragDrop = node.onDragDrop;
        node.onDragOver = function (event) {
            return [...(event.dataTransfer?.types ?? [])].includes("Files") || dragOver?.call(this, event) || false;
        };
        node.onDragDrop = async function (event) {
            const files = [...(event.dataTransfer?.files ?? [])];
            if (!files.length) return dragDrop?.call(this, event) ?? false;
            await composer.dropFiles(event);
            return true;
        };
        composers.add(composer);
        const added = node.onAdded;
        node.onAdded = function (...args) {
            const result = added?.apply(this, args);
            refreshConnections(); return result;
        };
        const connectionsChanged = node.onConnectionsChange;
        node.onConnectionsChange = function (...args) {
            const result = connectionsChanged?.apply(this, args);
            refreshConnections(); return result;
        };
        // Nodes 2.0 keys DOM mounts by widget identity. A new node instance after
        // undo must not reuse the previous instance's disposed editor element.
        const view = node.addDOMWidget(`henjicc_media_${uniqueId()}`, "henjicc_media", composer.element, {
            serialize: false, hideOnZoom: false, getMinHeight: () => 300,
        });
        view.serialize = false;
        node.setSize([610, 530]);
        const configure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = configure?.apply(this, args);
            this.title = this.title.replace(/^超级加载(?=$|[\s·:：])/u, "超级输入").replace(/^Super Loader(?=$|[\s·:])/u, "Super Input");
            composer.render(); refreshConnections(); return result;
        };
        const removed = node.onRemoved;
        node.onRemoved = function (...args) { composers.delete(composer); composer.dispose(); return removed?.apply(this, args); };
    },
});
