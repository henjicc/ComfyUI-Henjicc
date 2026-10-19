// Keep workflow values relative to input; only presentation accepts Windows separators.
export function relativePath(value, directory = false) {
    let path = value.trim().replaceAll("\\", "/");
    if (path.startsWith("/") || /[:\0]/.test(path)) throw new Error("请使用输入目录内的相对路径");
    if (directory) path = path.replace(/\/+$/, "");
    else path = path.replace(/ \[input\]$/, "");
    if (path && path.split("/").some(part => !part || part.startsWith("."))) throw new Error("不能访问隐藏路径或上级目录");
    return path;
}

export function ancestors(path) {
    const parts = path ? path.split("/") : [];
    return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}
