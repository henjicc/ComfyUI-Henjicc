// The same DOM widget is mounted by both the canvas overlay and Nodes 2.0.
// Use the host setting instead of inspecting either renderer's private DOM.
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./node-ui.css", import.meta.url).href;
document.head.append(style);

export function bindNodeAppearance(app, element) {
    element.classList.add("henjicc-node-panel");
    const update = () => {
        element.dataset.modern = String(!!app.ui.settings.getSettingValue("Comfy.VueNodes.Enabled"));
        element.style.setProperty("--henjicc-font", getComputedStyle(document.body).fontFamily);
    };
    update();
    app.ui.settings.addEventListener("Comfy.VueNodes.Enabled.change", update);
    return () => app.ui.settings.removeEventListener("Comfy.VueNodes.Enabled.change", update);
}
