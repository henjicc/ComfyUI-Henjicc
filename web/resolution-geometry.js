// Contain the selected ratio inside the current size; preserve the limiting
// side and round only the other side to the nearest valid grid point.
export function fitAspectRatio({ width, height, grid }, ratioWidth, ratioHeight) {
    const fit = (value, limit) => Math.max(Math.max(8, grid), Math.min(
        Math.floor(limit / grid) * grid, Math.round(value / grid) * grid));
    return width * ratioHeight > height * ratioWidth
        ? { width: fit(height * ratioWidth / ratioHeight, width), height }
        : { width, height: fit(width * ratioHeight / ratioWidth, height) };
}

export function snapDimensions(width, height, { grid, max_side, budget_pixels }) {
    const minimum = Math.max(8, grid);
    const snap = value => Math.max(minimum, Math.round(value / grid) * grid);
    width = snap(width); height = snap(height);
    const factor = Math.min(1, max_side / width, max_side / height, Math.sqrt(budget_pixels / (width * height)));
    if (factor < 1) {
        width = Math.max(minimum, Math.floor(width * factor / grid) * grid);
        height = Math.max(minimum, Math.floor(height * factor / grid) * grid);
        if (width * height > budget_pixels) {
            if (width >= height) width = Math.max(minimum, Math.floor(budget_pixels / height / grid) * grid);
            else height = Math.max(minimum, Math.floor(budget_pixels / width / grid) * grid);
        }
    }
    return { width, height };
}

// At the budget ceiling, the current aspect touches the usable stage boundary.
// Smaller sizes retain this scale, rather than being magnified to fill the stage.
export function stageScale(result, width, height) {
    const ceiling = Math.min(result.max_side / result.width, result.max_side / result.height,
        Math.sqrt(result.budget_pixels / (result.width * result.height)));
    return Math.min(width / (result.width * ceiling), height / (result.height * ceiling));
}
