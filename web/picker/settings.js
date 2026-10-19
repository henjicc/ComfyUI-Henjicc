const prefix = "Henjicc.ImageLibrary.";
const definitions = [
    ["SingleClickUse", "Use an asset with a single click", true],
    ["DoubleClickPreview", "Preview an asset with a double click", true],
    ["CropThumbnails", "Crop thumbnails to fill", false],
    ["ShowImageNames", "Always show image filenames", false],
    ["ShowVideoNames", "Always show video filenames", false],
    ["ShowAudioNames", "Always show audio filenames", true],
    ["ShowExtensions", "Show filename extensions", false],
    ["ShowRatings", "Show asset star ratings", true],
    ["ShowTags", "Show asset tags", true],
    ["HoverPlayback", "Play audio and video on hover", true],
];
export const pickerSettings = definitions.map(([key, name, value]) => ({
    id: prefix + key, name, category: ["Henjicc", "HenjiccImageLibrary", key], type: "boolean", defaultValue: value,
}));
const positions = ["Top left", "Top right", "Bottom left", "Bottom right", "Below thumbnail"];
const combos = [
    ["FilenamePosition", "Filename position", positions, "Below thumbnail"],
    ["RatingPosition", "Star rating position", positions, "Bottom left"],
    ["TagsPosition", "Tags position", positions, "Bottom right"],
    ["DoubleClickDelay", "Double-click detection interval (ms)", ["300", "500", "700"], "500"],
];
for (const [key,name,options,defaultValue] of combos) pickerSettings.push({id:prefix+key,name,
    category:["Henjicc","HenjiccImageLibrary",key],type:"combo",options,defaultValue});

export function pickerPreferences(settings) {
    const get = (key,fallback) => settings?.getSettingValue(prefix+key,fallback) ?? fallback;
    const values = Object.fromEntries(definitions.map(([key,,fallback]) => {
        const value=get(key,fallback); return [key, typeof value === "boolean" ? value : fallback];
    }));
    for (const [key,,options,fallback] of combos) {
        const value=String(get(key,fallback)); values[key]=options.includes(value) ? value : fallback;
    }
    values.DoubleClickDelay=Number(values.DoubleClickDelay);
    return values;
}
