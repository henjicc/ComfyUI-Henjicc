// Use the host's exported graph: it resolves reroutes, virtual links and subgraphs.
export function connectedProfile(profile, prompt, nodeId, onAdapter) {
    const families = new Set(), pending = [[String(nodeId), 0]], visited = new Set();
    const qwen = new Set(["TextEncodeQwenImage21", "TextEncodeQwenImageEdit", "TextEncodeQwenImageEditPlus"]);
    const minimax = new Set(["HenjiccMiniMaxMedia", "HenjiccH3RoleInputs", "MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"]);
    while (pending.length) {
        const [sourceId, slot] = pending.pop(), key = `${sourceId}/${slot}`;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const [id, node] of Object.entries(prompt)) {
            if (!Object.values(node.inputs ?? {}).some(link => Array.isArray(link) && link.length === 2
                && String(link[0]) === sourceId && (slot === null || link[1] === slot))) continue;
            if (["HenjiccMiniMaxMedia", "HenjiccH3RoleInputs"].includes(node.class_type)) onAdapter?.(node.class_type);
            if (qwen.has(node.class_type)) families.add("qwen");
            else if (minimax.has(node.class_type)) families.add("minimax");
            else pending.push([id, null]);
        }
    }
    if (families.size > 1) throw new Error("同时连接了千问和 MiniMax，请分别使用超级输入节点");
    if (families.has("qwen")) return "qwen";
    if (families.has("minimax")) return profile === "minimax_frames" ? profile : "minimax_reference";
    return "general";
}

export function profilesForNode(profile, prompt, rootGraph, node, onAdapter) {
    const profiles = new Set();
    for (const [id, entry] of Object.entries(prompt)) {
        if (entry.class_type !== "HenjiccSuperLoader") continue;
        // Host execution IDs qualify nested nodes with their instance path.
        const path = id.split(":"), localId = path.pop();
        let graph = rootGraph;
        for (const parentId of path) graph = graph?.getNodeById(parentId)?.subgraph;
        if (graph?.getNodeById(localId) === node) profiles.add(connectedProfile(profile, prompt, id, onAdapter));
    }
    return [...profiles].sort();
}
