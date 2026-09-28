import fs from "fs";
import path from "path";

////////////////////////////////////////////////////////////////////////////////

export interface SvgSource {
    svgText: string;
    // intrinsic size in pixels
    width: number;
    height: number;
    hasViewBox: boolean;
}

const DEFAULT_SVG_SIZE = 256;

export function isSvgFilePath(filePath: string) {
    return path.extname(filePath).toLowerCase() == ".svg";
}

export function isSvgDataURL(src: string) {
    return src.startsWith("data:image/svg+xml");
}

// returns length in pixels or undefined if it is not set or relative (e.g. "100%")
function parseLength(value: string | null) {
    if (!value) {
        return undefined;
    }
    const match = value
        .trim()
        .match(/^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i);
    if (!match) {
        return undefined;
    }
    const number = parseFloat(match[1]);
    const unit = (match[2] || "px").toLowerCase();
    const PX_PER_UNIT: { [unit: string]: number } = {
        px: 1,
        pt: 96 / 72,
        pc: 16,
        mm: 96 / 25.4,
        cm: 96 / 2.54,
        in: 96
    };
    const px = number * PX_PER_UNIT[unit];
    return px > 0 ? px : undefined;
}

function parseSvgDocument(svgText: string) {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (
        !root ||
        root.nodeName.toLowerCase() != "svg" ||
        doc.getElementsByTagName("parsererror").length > 0
    ) {
        throw new Error("Invalid SVG file");
    }
    return { doc, root };
}

export function parseSvg(svgText: string): SvgSource {
    const { root } = parseSvgDocument(svgText);

    let width = parseLength(root.getAttribute("width"));
    let height = parseLength(root.getAttribute("height"));

    let viewBox: number[] | undefined;
    const viewBoxAttr = root.getAttribute("viewBox");
    if (viewBoxAttr) {
        const values = viewBoxAttr
            .trim()
            .split(/[\s,]+/)
            .map(value => parseFloat(value));
        if (
            values.length == 4 &&
            values.every(value => !isNaN(value)) &&
            values[2] > 0 &&
            values[3] > 0
        ) {
            viewBox = values;
        }
    }

    if (width == undefined && height == undefined) {
        if (viewBox) {
            width = viewBox[2];
            height = viewBox[3];
        } else {
            width = DEFAULT_SVG_SIZE;
            height = DEFAULT_SVG_SIZE;
        }
    } else if (width == undefined) {
        width = viewBox ? (height! * viewBox[2]) / viewBox[3] : height!;
    } else if (height == undefined) {
        height = viewBox ? (width * viewBox[3]) / viewBox[2] : width;
    }

    return {
        svgText,
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height!)),
        hasViewBox: !!viewBox
    };
}

export async function loadSvgFile(filePath: string) {
    return parseSvg(await fs.promises.readFile(filePath, "utf8"));
}

export function svgTextFromDataURL(dataURL: string) {
    const i = dataURL.indexOf(",");
    const header = dataURL.substring(0, i);
    const data = dataURL.substring(i + 1);
    return header.endsWith(";base64")
        ? Buffer.from(data, "base64").toString("utf8")
        : decodeURIComponent(data);
}

// Renders SVG into a canvas of the given size.
// Parts of the SVG without content stay transparent.
export async function renderSvg(
    source: SvgSource,
    width: number = source.width,
    height: number = source.height
) {
    const { root } = parseSvgDocument(source.svgText);

    if (!source.hasViewBox) {
        // without viewBox SVG would be clipped instead of scaled
        root.setAttribute("viewBox", `0 0 ${source.width} ${source.height}`);
    }
    root.setAttribute("width", `${width}`);
    root.setAttribute("height", `${height}`);

    // stretch if aspect ratio is changed
    if (
        Math.abs(width / height - source.width / source.height) > 0.01 &&
        !root.getAttribute("preserveAspectRatio")
    ) {
        root.setAttribute("preserveAspectRatio", "none");
    }

    const svgText = new XMLSerializer().serializeToString(root);

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to render SVG"));
        image.src =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas;
}
