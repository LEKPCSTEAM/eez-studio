export interface OverlayBox {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    depth: number;
    issue?: boolean;
}

const OVERLAY_COLORS = ["#ff2d55", "#007aff", "#34c759", "#ff9500", "#af52de"];

// RGBA frame -> PNG (optionally scaled, with widget bounds overlay)
export function encodePng(
    frame: { width: number; height: number; rgba: Uint8ClampedArray },
    options: { scale?: number; boxes?: OverlayBox[] } = {}
): Buffer {
    const scale = Math.max(1, Math.min(8, Math.round(options.scale ?? 1)));

    const source = document.createElement("canvas");
    source.width = frame.width;
    source.height = frame.height;
    const sourceCtx = source.getContext("2d")!;
    sourceCtx.putImageData(
        new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height),
        0,
        0
    );

    let canvas = source;

    if (scale != 1 || options.boxes) {
        canvas = document.createElement("canvas");
        canvas.width = frame.width * scale;
        canvas.height = frame.height * scale;
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

        if (options.boxes) {
            const fontSize = Math.max(9, 9 * Math.min(scale, 2));
            ctx.font = `${fontSize}px sans-serif`;
            ctx.textBaseline = "top";
            for (const box of options.boxes) {
                const color = box.issue
                    ? "#ff0000"
                    : OVERLAY_COLORS[box.depth % OVERLAY_COLORS.length];
                ctx.strokeStyle = color;
                ctx.lineWidth = box.issue ? 2 : 1;
                ctx.setLineDash(box.issue ? [4, 2] : []);
                ctx.strokeRect(
                    box.x * scale + 0.5,
                    box.y * scale + 0.5,
                    Math.max(0, box.width * scale - 1),
                    Math.max(0, box.height * scale - 1)
                );
                if (box.label) {
                    const textWidth = ctx.measureText(box.label).width;
                    const tx = Math.max(0, box.x * scale);
                    const ty = Math.max(0, box.y * scale - fontSize - 2);
                    ctx.fillStyle = color;
                    ctx.globalAlpha = 0.85;
                    ctx.fillRect(tx, ty, textWidth + 4, fontSize + 2);
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = "#ffffff";
                    ctx.fillText(box.label, tx + 2, ty + 1);
                }
            }
            ctx.setLineDash([]);
        }
    }

    const dataUrl = canvas.toDataURL("image/png");
    return Buffer.from(dataUrl.substring(dataUrl.indexOf(",") + 1), "base64");
}
