import fs from "fs";
import path from "path";
import React from "react";
import {
    observable,
    action,
    computed,
    makeObservable,
    runInAction
} from "mobx";
import { observer } from "mobx-react";

import { Dialog, showDialog } from "eez-studio-ui/dialog";
import { IconAction } from "eez-studio-ui/action";

import {
    AI_MODEL_DOWNLOAD_SIZE_MB,
    isAIModelDownloaded,
    removeBackgroundWithAI
} from "./ai-background-removal";
import { getUpscaleModelInfo, upscaleWithAI } from "./ai-upscale";
import {
    isSvgDataURL,
    isSvgFilePath,
    loadSvgFile,
    parseSvg,
    renderSvg,
    SvgSource,
    svgTextFromDataURL
} from "./svg";

////////////////////////////////////////////////////////////////////////////////

export interface ImageEditorOptions {
    title?: string;
    // data URL or absolute file path
    imageSrc: string;
    // when set, "Fit to display" preset is available
    displayWidth?: number;
    displayHeight?: number;
}

export interface ImageEditorResult {
    // true if any transformation was applied
    modified: boolean;
    // PNG data URL (only valid if modified)
    dataURL: string;
    width: number;
    height: number;
}

// Returns undefined if user canceled the dialog
export async function showImageEditor(
    opts: ImageEditorOptions
): Promise<ImageEditorResult | undefined> {
    const { image, vector } = await loadImage(opts.imageSrc);

    return new Promise<ImageEditorResult | undefined>(resolve => {
        let disposed = false;

        const onDispose = () => {
            if (!disposed) {
                disposed = true;
                if (modalDialog) {
                    root.unmount();
                    modalDialog.close();
                }
                resolve(undefined);
            }
        };

        const onOk = (result: ImageEditorResult) => {
            resolve(result);
            onDispose();
        };

        const state = new ImageEditorState(image, opts, vector);

        const [modalDialog, _, root] = showDialog(
            <ImageEditorDialog
                state={state}
                onOk={onOk}
                onCancel={onDispose}
            />,
            {
                jsPanel: {
                    id: "bitmap-image-editor",
                    title: opts.title ?? "Edit Image",
                    width: 1200,
                    height: 800,
                    onclosed: onDispose
                }
            }
        );
    });
}

async function loadImage(
    imageSrc: string
): Promise<{ image: CanvasImageSource & { width: number; height: number }; vector?: SvgSource }> {
    if (isSvgFilePath(imageSrc) || isSvgDataURL(imageSrc)) {
        const vector = isSvgDataURL(imageSrc)
            ? parseSvg(svgTextFromDataURL(imageSrc))
            : await loadSvgFile(imageSrc);
        return { image: await renderSvg(vector), vector };
    }

    let src = imageSrc;
    if (!src.startsWith("data:image/")) {
        // read the file ourselves so the canvas is never tainted
        const ext = path.extname(src).toLowerCase();
        const fileType =
            ext == ".jpg" || ext == ".jpeg" ? "image/jpeg" : "image/png";
        const base64 = await fs.promises.readFile(src, "base64");
        src = `data:${fileType};base64,` + base64;
    }

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to load image"));
        image.src = src;
    });
    return { image };
}

////////////////////////////////////////////////////////////////////////////////

type Tool = "select" | "crop" | "pen" | "eraser" | "wand";

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const MAX_UNDO = 30;
const MAX_SIZE = 8192;

function createCanvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function cloneCanvas(source: HTMLCanvasElement) {
    const canvas = createCanvas(source.width, source.height);
    canvas.getContext("2d")!.drawImage(source, 0, 0);
    return canvas;
}

class ImageEditorState {
    canvas: HTMLCanvasElement;
    // incremented on every canvas change, used to trigger re-render
    version = 0;

    undoStack: HTMLCanvasElement[] = [];
    redoStack: HTMLCanvasElement[] = [];

    tool: Tool = "select";
    penColor = "#000000";
    penSize = 2;
    backgroundColor = "#ffffff";

    resizeWidth: number;
    resizeHeight: number;
    keepAspectRatio = true;
    smoothResize = true;

    crop: Rect | undefined = undefined;

    // undefined means "fit to view"
    zoom: number | undefined = undefined;

    // remove background by color, 0..100
    bgTolerance = 15;
    bgSoftness = 10;
    bgContiguous = true;

    // AI background removal is running
    busy = false;
    busyMessage: string | undefined = undefined;
    aiError: string | undefined = undefined;
    aiModelDownloaded = isAIModelDownloaded();
    aiAbortController: AbortController | undefined;

    // use AI model when enlarging the image
    aiUpscale = true;
    upscaleModelInfo:
        | { downloaded: boolean; downloadSizeMB: number }
        | undefined = undefined;

    // canvases that are exact renders of the SVG source,
    // while current canvas is one of them resize re-renders the SVG (no quality loss)
    vectorRenders = new WeakSet<HTMLCanvasElement>();

    constructor(
        image: CanvasImageSource & { width: number; height: number },
        public opts: ImageEditorOptions,
        public vector?: SvgSource
    ) {
        this.canvas = createCanvas(image.width, image.height);
        this.canvas.getContext("2d")!.drawImage(image, 0, 0);
        if (vector) {
            this.vectorRenders.add(this.canvas);
        }

        this.resizeWidth = image.width;
        this.resizeHeight = image.height;

        makeObservable(this, {
            version: observable,
            undoStack: observable.shallow,
            redoStack: observable.shallow,
            tool: observable,
            penColor: observable,
            penSize: observable,
            backgroundColor: observable,
            resizeWidth: observable,
            resizeHeight: observable,
            keepAspectRatio: observable,
            smoothResize: observable,
            crop: observable,
            zoom: observable,
            bgTolerance: observable,
            bgSoftness: observable,
            bgContiguous: observable,
            busy: observable,
            busyMessage: observable,
            aiError: observable,
            aiModelDownloaded: observable,
            aiUpscale: observable,
            upscaleModelInfo: observable,
            isEnlarging: computed,
            willUseAIUpscale: computed,
            autoRemoveBackground: action,
            magicWand: action,
            width: computed,
            height: computed,
            modified: computed,
            isResizePending: computed,
            isVector: computed,
            setResizeWidth: action,
            setResizeHeight: action,
            setResizePercent: action,
            fitToDisplay: action,
            rotate: action,
            flip: action,
            applyCrop: action,
            trimTransparent: action,
            grayscale: action,
            invert: action,
            fillBackground: action,
            undo: action,
            redo: action,
            reset: action,
            pushUndo: action,
            commit: action,
            replaceCanvas: action
        });

        this.updateUpscaleModelInfo();
    }

    get width() {
        this.version;
        return this.canvas.width;
    }

    get height() {
        this.version;
        return this.canvas.height;
    }

    get modified() {
        // SVG is always converted to PNG
        return (
            this.undoStack.length > 0 || this.isResizePending || !!this.vector
        );
    }

    get isVector() {
        this.version;
        return this.vectorRenders.has(this.canvas);
    }

    get isResizePending() {
        return (
            this.resizeWidth != this.width || this.resizeHeight != this.height
        );
    }

    // history

    pushUndo() {
        const canvas = cloneCanvas(this.canvas);
        if (this.vectorRenders.has(this.canvas)) {
            this.vectorRenders.add(canvas);
        }
        this.undoStack.push(canvas);
        if (this.undoStack.length > MAX_UNDO) {
            this.undoStack.splice(0, 1);
        }
        this.redoStack.splice(0, this.redoStack.length);
    }

    // call after canvas pixels changed in place
    commit() {
        this.version++;
    }

    replaceCanvas(canvas: HTMLCanvasElement) {
        this.pushUndo();
        this.canvas = canvas;
        this.crop = undefined;
        this.syncResizeFields();
        this.version++;
    }

    syncResizeFields() {
        this.resizeWidth = this.canvas.width;
        this.resizeHeight = this.canvas.height;
    }

    undo() {
        const canvas = this.undoStack.pop();
        if (canvas) {
            this.redoStack.push(this.canvas);
            this.canvas = canvas;
            this.crop = undefined;
            this.syncResizeFields();
            this.version++;
        }
    }

    redo() {
        const canvas = this.redoStack.pop();
        if (canvas) {
            this.undoStack.push(this.canvas);
            this.canvas = canvas;
            this.crop = undefined;
            this.syncResizeFields();
            this.version++;
        }
    }

    reset() {
        if (this.undoStack.length > 0) {
            this.redoStack.splice(0, this.redoStack.length);
            this.canvas = this.undoStack[0];
            this.undoStack.splice(0, this.undoStack.length);
        }
        this.crop = undefined;
        this.syncResizeFields();
        this.version++;
    }

    // resize

    setResizeWidth(value: number) {
        this.resizeWidth = clampSize(value);
        if (this.keepAspectRatio) {
            this.resizeHeight = clampSize(
                (this.resizeWidth * this.height) / this.width
            );
        }
    }

    setResizeHeight(value: number) {
        this.resizeHeight = clampSize(value);
        if (this.keepAspectRatio) {
            this.resizeWidth = clampSize(
                (this.resizeHeight * this.width) / this.height
            );
        }
    }

    setResizePercent(percent: number) {
        this.resizeWidth = clampSize((this.width * percent) / 100);
        this.resizeHeight = clampSize((this.height * percent) / 100);
    }

    fitToDisplay() {
        const { displayWidth, displayHeight } = this.opts;
        if (!displayWidth || !displayHeight) {
            return;
        }
        const scale = Math.min(
            displayWidth / this.width,
            displayHeight / this.height
        );
        this.resizeWidth = clampSize(this.width * scale);
        this.resizeHeight = clampSize(this.height * scale);
    }

    get isEnlarging() {
        return this.resizeWidth > this.width || this.resizeHeight > this.height;
    }

    get willUseAIUpscale() {
        return (
            this.aiUpscale &&
            this.smoothResize &&
            this.isEnlarging &&
            !(this.vector && this.isVector)
        );
    }

    // Returns false if resize failed or was canceled
    async applyResize() {
        if (!this.isResizePending) {
            return true;
        }

        const width = this.resizeWidth;
        const height = this.resizeHeight;

        if (this.vector && this.isVector) {
            const canvas = await renderSvg(this.vector, width, height);
            runInAction(() => {
                this.vectorRenders.add(canvas);
                this.replaceCanvas(canvas);
            });
            return true;
        }

        if (this.willUseAIUpscale) {
            return this.runAITask((onProgress, signal) =>
                upscaleWithAI(this.canvas, width, height, onProgress, signal)
            );
        }

        let source = this.canvas;

        if (this.smoothResize) {
            // downscale in steps of 1/2 for better quality on large reductions
            while (source.width / 2 > width && source.height / 2 > height) {
                const half = createCanvas(
                    Math.max(width, Math.round(source.width / 2)),
                    Math.max(height, Math.round(source.height / 2))
                );
                const ctx = half.getContext("2d")!;
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(source, 0, 0, half.width, half.height);
                source = half;
            }
        }

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = this.smoothResize;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, width, height);

        this.replaceCanvas(canvas);
        return true;
    }

    // transform

    rotate(clockwise: boolean) {
        const canvas = createCanvas(this.height, this.width);
        const ctx = canvas.getContext("2d")!;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(((clockwise ? 1 : -1) * Math.PI) / 2);
        ctx.drawImage(this.canvas, -this.width / 2, -this.height / 2);
        this.replaceCanvas(canvas);
    }

    flip(horizontal: boolean) {
        const canvas = createCanvas(this.width, this.height);
        const ctx = canvas.getContext("2d")!;
        if (horizontal) {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        } else {
            ctx.translate(0, canvas.height);
            ctx.scale(1, -1);
        }
        ctx.drawImage(this.canvas, 0, 0);
        this.replaceCanvas(canvas);
    }

    applyCrop() {
        const crop = this.crop;
        if (!crop || crop.width < 1 || crop.height < 1) {
            return;
        }
        const canvas = createCanvas(crop.width, crop.height);
        canvas
            .getContext("2d")!
            .drawImage(
                this.canvas,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                0,
                0,
                crop.width,
                crop.height
            );
        this.replaceCanvas(canvas);
    }

    trimTransparent() {
        const { width, height } = this;
        const data = this.canvas
            .getContext("2d")!
            .getImageData(0, 0, width, height).data;

        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] != 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (maxX < 0) {
            // fully transparent image, nothing to trim to
            return;
        }

        if (
            minX == 0 &&
            minY == 0 &&
            maxX == width - 1 &&
            maxY == height - 1
        ) {
            return;
        }

        this.crop = {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
        };
        this.applyCrop();
    }

    // adjust

    private mapPixels(fn: (data: Uint8ClampedArray, i: number) => void) {
        const canvas = cloneCanvas(this.canvas);
        const ctx = canvas.getContext("2d")!;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            fn(data, i);
        }
        ctx.putImageData(imageData, 0, 0);
        this.replaceCanvas(canvas);
    }

    grayscale() {
        this.mapPixels((data, i) => {
            const l = Math.round(
                0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            );
            data[i] = data[i + 1] = data[i + 2] = l;
        });
    }

    invert() {
        this.mapPixels((data, i) => {
            data[i] = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
        });
    }

    fillBackground() {
        const canvas = createCanvas(this.width, this.height);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this.canvas, 0, 0);
        this.replaceCanvas(canvas);
    }

    // remove background

    // Makes transparent the pixels similar to refColor.
    // If contiguous, only the region connected to the seed pixels is removed.
    // Pixels in the softness band get partial alpha and the background color
    // is subtracted from them, so there is no colored halo around the object.
    private removeColor(
        seeds: number[],
        refColor: number[],
        contiguous: boolean
    ) {
        const canvas = cloneCanvas(this.canvas);
        const ctx = canvas.getContext("2d")!;
        const { width, height } = canvas;
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        const n = width * height;

        const tolerance = this.bgTolerance / 100;
        const softness = this.bgSoftness / 100;
        const MAX_DISTANCE = Math.sqrt(3) * 255;

        const [refR, refG, refB] = refColor;

        const distance = (i: number) => {
            if (data[i * 4 + 3] == 0) {
                return 0;
            }
            const dr = data[i * 4] - refR;
            const dg = data[i * 4 + 1] - refG;
            const db = data[i * 4 + 2] - refB;
            return Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DISTANCE;
        };

        // alpha multiplier: 0 = remove, 1 = keep
        const alphaFactor = (d: number) => {
            if (d <= tolerance) {
                return 0;
            }
            if (softness == 0 || d >= tolerance + softness) {
                return 1;
            }
            return (d - tolerance) / softness;
        };

        const factors = new Float32Array(n).fill(1);

        if (contiguous) {
            const visited = new Uint8Array(n);
            const queue = new Int32Array(n);
            let head = 0;
            let tail = 0;

            for (const seed of seeds) {
                if (!visited[seed]) {
                    visited[seed] = 1;
                    queue[tail++] = seed;
                }
            }

            while (head < tail) {
                const i = queue[head++];
                const d = distance(i);
                const f = alphaFactor(d);
                if (f >= 1) {
                    continue;
                }
                factors[i] = f;

                // spread only through the pixels that are fully removed,
                // softness band is just the edge of the region
                if (d > tolerance) {
                    continue;
                }

                const x = i % width;
                const y = (i - x) / width;
                if (x > 0 && !visited[i - 1]) {
                    visited[i - 1] = 1;
                    queue[tail++] = i - 1;
                }
                if (x < width - 1 && !visited[i + 1]) {
                    visited[i + 1] = 1;
                    queue[tail++] = i + 1;
                }
                if (y > 0 && !visited[i - width]) {
                    visited[i - width] = 1;
                    queue[tail++] = i - width;
                }
                if (y < height - 1 && !visited[i + width]) {
                    visited[i + width] = 1;
                    queue[tail++] = i + width;
                }
            }
        } else {
            for (let i = 0; i < n; i++) {
                factors[i] = alphaFactor(distance(i));
            }
        }

        // Anti-aliased edge: pixel next to a (partially) removed pixel is a mix of
        // the object color and the background color. Estimate its alpha from
        // the distance to background compared to the nearby object pixels.
        const edgeFactors = new Float32Array(n).fill(1);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (factors[i] == 0 || data[i * 4 + 3] == 0) {
                    continue;
                }

                let isEdge = false;
                for (let dy = -1; dy <= 1 && !isEdge; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (
                            nx >= 0 &&
                            ny >= 0 &&
                            nx < width &&
                            ny < height &&
                            factors[ny * width + nx] < 1
                        ) {
                            isEdge = true;
                            break;
                        }
                    }
                }
                if (!isEdge) {
                    continue;
                }

                let objectDistance = 0;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                            const j = ny * width + nx;
                            if (factors[j] == 1) {
                                objectDistance = Math.max(
                                    objectDistance,
                                    distance(j)
                                );
                            }
                        }
                    }
                }

                if (objectDistance > 0) {
                    const f = distance(i) / objectDistance;
                    if (f < 0.98) {
                        edgeFactors[i] = Math.max(f, 0.02);
                    }
                }
            }
        }
        for (let i = 0; i < n; i++) {
            if (edgeFactors[i] < 1) {
                factors[i] = Math.min(factors[i], edgeFactors[i]);
            }
        }

        let changed = false;
        for (let i = 0; i < n; i++) {
            const f = factors[i];
            if (f >= 1 || data[i * 4 + 3] == 0) {
                continue;
            }
            changed = true;
            if (f == 0) {
                data[i * 4 + 3] = 0;
            } else {
                // observed = f * foreground + (1 - f) * background
                for (let c = 0; c < 3; c++) {
                    data[i * 4 + c] =
                        (data[i * 4 + c] - (1 - f) * refColor[c]) / f;
                }
                data[i * 4 + 3] = Math.round(data[i * 4 + 3] * f);
            }
        }

        if (!changed) {
            return;
        }

        ctx.putImageData(imageData, 0, 0);
        this.replaceCanvas(canvas);
    }

    // Removes the background connected to the image edges,
    // background color is the most common color on the edges.
    autoRemoveBackground() {
        const { width, height } = this;
        const data = this.canvas
            .getContext("2d")!
            .getImageData(0, 0, width, height).data;

        const border: number[] = [];
        for (let x = 0; x < width; x++) {
            border.push(x, (height - 1) * width + x);
        }
        for (let y = 1; y < height - 1; y++) {
            border.push(y * width, y * width + width - 1);
        }

        // histogram of quantized colors
        const buckets = new Map<
            number,
            { count: number; r: number; g: number; b: number }
        >();
        for (const i of border) {
            if (data[i * 4 + 3] < 128) {
                continue;
            }
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = { count: 0, r: 0, g: 0, b: 0 };
                buckets.set(key, bucket);
            }
            bucket.count++;
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
        }

        let best: { count: number; r: number; g: number; b: number } | undefined;
        for (const bucket of buckets.values()) {
            if (!best || bucket.count > best.count) {
                best = bucket;
            }
        }

        if (!best) {
            // edges are already transparent
            return;
        }

        this.removeColor(
            border,
            [best.r / best.count, best.g / best.count, best.b / best.count],
            true
        );
    }

    magicWand(x: number, y: number) {
        x = Math.floor(x);
        y = Math.floor(y);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
            return;
        }
        const pixel = this.canvas
            .getContext("2d")!
            .getImageData(x, y, 1, 1).data;
        if (pixel[3] == 0) {
            return;
        }
        this.removeColor(
            [y * this.width + x],
            [pixel[0], pixel[1], pixel[2]],
            this.bgContiguous
        );
    }

    // Runs AI task and replaces the canvas with its result.
    // Returns false if the task failed or was canceled.
    async runAITask(
        task: (
            onProgress: (message: string) => void,
            signal: AbortSignal
        ) => Promise<HTMLCanvasElement>
    ) {
        if (this.busy) {
            return false;
        }

        const abortController = new AbortController();

        runInAction(() => {
            this.busy = true;
            this.busyMessage = "Starting...";
            this.aiError = undefined;
            this.aiAbortController = abortController;
        });

        try {
            const result = await task(
                action((message: string) => (this.busyMessage = message)),
                abortController.signal
            );
            if (abortController.signal.aborted) {
                return false;
            }
            this.replaceCanvas(result);
            return true;
        } catch (err: any) {
            if (!abortController.signal.aborted) {
                console.error(err);
                runInAction(() => {
                    this.aiError = err?.message ?? String(err);
                });
            }
            return false;
        } finally {
            runInAction(() => {
                this.busy = false;
                this.busyMessage = undefined;
                this.aiAbortController = undefined;
                this.aiModelDownloaded = isAIModelDownloaded();
            });
            this.updateUpscaleModelInfo();
        }
    }

    removeBackgroundAI() {
        return this.runAITask((onProgress, signal) =>
            removeBackgroundWithAI(this.canvas, onProgress, signal)
        );
    }

    async updateUpscaleModelInfo() {
        const info = await getUpscaleModelInfo();
        runInAction(() => {
            this.upscaleModelInfo = info;
        });
    }

    cancelAI() {
        this.aiAbortController?.abort();
    }

    // draw

    drawLine(x0: number, y0: number, x1: number, y1: number) {
        const ctx = this.canvas.getContext("2d")!;
        ctx.save();
        ctx.globalCompositeOperation =
            this.tool == "eraser" ? "destination-out" : "source-over";
        ctx.strokeStyle = this.penColor;
        ctx.fillStyle = this.penColor;
        ctx.lineWidth = this.penSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (x0 == x1 && y0 == y1) {
            ctx.beginPath();
            ctx.arc(x0, y0, this.penSize / 2, 0, 2 * Math.PI);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
        ctx.restore();
        this.commit();
    }

    // returns undefined if pending resize failed or was canceled
    async getResult(): Promise<ImageEditorResult | undefined> {
        if (!(await this.applyResize())) {
            return undefined;
        }
        return {
            modified: this.undoStack.length > 0 || !!this.vector,
            dataURL: this.canvas.toDataURL("image/png"),
            width: this.width,
            height: this.height
        };
    }
}

function clampSize(value: number) {
    if (isNaN(value)) {
        return 1;
    }
    return Math.max(1, Math.min(MAX_SIZE, Math.round(value)));
}

////////////////////////////////////////////////////////////////////////////////

const ImageEditorDialog = observer(
    class ImageEditorDialog extends React.Component<{
        state: ImageEditorState;
        onOk: (result: ImageEditorResult) => void;
        onCancel: () => void;
    }> {
        onOk = async () => {
            const result = await this.props.state.getResult();
            if (!result) {
                // keep the dialog open, error is displayed in the sidebar
                return false;
            }
            this.props.onOk(result);
            return true;
        };

        componentWillUnmount() {
            this.props.state.cancelAI();
        }

        onKeyDown = (event: React.KeyboardEvent) => {
            const state = this.props.state;
            if (event.target instanceof HTMLInputElement) {
                return;
            }
            if (event.ctrlKey && event.key == "z") {
                event.preventDefault();
                state.undo();
            } else if (
                event.ctrlKey &&
                (event.key == "y" || (event.shiftKey && event.key == "Z"))
            ) {
                event.preventDefault();
                state.redo();
            } else if (event.key == "Enter" && state.tool == "crop") {
                event.preventDefault();
                state.applyCrop();
            } else if (event.key == "Escape" && state.crop) {
                event.preventDefault();
                action(() => (state.crop = undefined))();
            }
        };

        render() {
            const state = this.props.state;
            return (
                <Dialog
                    modal={false}
                    okButtonText="OK"
                    okEnabled={() => !state.busy}
                    onOk={this.onOk}
                    onCancel={this.props.onCancel}
                    additionalFooterControl={
                        <div className="EezStudio_ImageEditor_Status">
                            {state.width} x {state.height} px
                            {state.modified && " (modified)"}
                        </div>
                    }
                >
                    <div
                        className="EezStudio_ImageEditor"
                        tabIndex={0}
                        onKeyDown={this.onKeyDown}
                    >
                        <ImageEditorSidebar state={state} />
                        <ImageEditorCanvas state={state} />
                    </div>
                </Dialog>
            );
        }
    }
);

////////////////////////////////////////////////////////////////////////////////

const ImageEditorSidebar = observer(
    class ImageEditorSidebar extends React.Component<{
        state: ImageEditorState;
    }> {
        render() {
            const state = this.props.state;
            const hasDisplay =
                !!state.opts.displayWidth && !!state.opts.displayHeight;

            return (
                <fieldset
                    className="EezStudio_ImageEditor_Sidebar"
                    disabled={state.busy}
                >
                    <section>
                        <h6>History</h6>
                        <div className="EezStudio_ImageEditor_Buttons">
                            <IconAction
                                icon="material:undo"
                                title="Undo (Ctrl+Z)"
                                enabled={state.undoStack.length > 0}
                                onClick={() => state.undo()}
                            />
                            <IconAction
                                icon="material:redo"
                                title="Redo (Ctrl+Y)"
                                enabled={state.redoStack.length > 0}
                                onClick={() => state.redo()}
                            />
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                disabled={!state.modified}
                                onClick={() => state.reset()}
                            >
                                Reset
                            </button>
                        </div>
                    </section>

                    <section>
                        <h6>Resize</h6>
                        <div className="EezStudio_ImageEditor_Row">
                            <label>W</label>
                            <input
                                type="number"
                                className="form-control form-control-sm"
                                min={1}
                                max={MAX_SIZE}
                                value={state.resizeWidth}
                                onChange={event =>
                                    state.setResizeWidth(
                                        parseInt(event.target.value)
                                    )
                                }
                            />
                            <label>H</label>
                            <input
                                type="number"
                                className="form-control form-control-sm"
                                min={1}
                                max={MAX_SIZE}
                                value={state.resizeHeight}
                                onChange={event =>
                                    state.setResizeHeight(
                                        parseInt(event.target.value)
                                    )
                                }
                            />
                        </div>
                        <Checkbox
                            label="Keep aspect ratio"
                            checked={state.keepAspectRatio}
                            onChange={action(
                                value => (state.keepAspectRatio = value)
                            )}
                        />
                        <Checkbox
                            label="Smooth (off = pixel art)"
                            checked={state.smoothResize}
                            onChange={action(
                                value => (state.smoothResize = value)
                            )}
                        />
                        {!state.isVector && (
                            <Checkbox
                                label="AI enhance when enlarging"
                                checked={state.aiUpscale}
                                onChange={action(
                                    value => (state.aiUpscale = value)
                                )}
                            />
                        )}
                        {state.willUseAIUpscale && (
                            <div className="EezStudio_ImageEditor_Hint">
                                AI reconstructs the details (up to 4x per
                                pass)
                                {state.upscaleModelInfo &&
                                    !state.upscaleModelInfo.downloaded &&
                                    `, first use downloads AI model (${state.upscaleModelInfo.downloadSizeMB} MB)`}
                            </div>
                        )}
                        <div className="EezStudio_ImageEditor_Buttons">
                            {[25, 50, 75, 200].map(percent => (
                                <button
                                    key={percent}
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary"
                                    onClick={() =>
                                        state.setResizePercent(percent)
                                    }
                                >
                                    {percent}%
                                </button>
                            ))}
                            {hasDisplay && (
                                <button
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary"
                                    title={`Fit into ${state.opts.displayWidth} x ${state.opts.displayHeight}`}
                                    onClick={() => state.fitToDisplay()}
                                >
                                    Fit display
                                </button>
                            )}
                        </div>
                        <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={!state.isResizePending}
                            onClick={() => state.applyResize()}
                        >
                            Apply resize
                        </button>
                        {state.vector && (
                            <div className="EezStudio_ImageEditor_Hint">
                                {state.isVector
                                    ? "SVG: resize re-renders the vector image, no quality loss"
                                    : "SVG was edited, resize now scales pixels"}
                            </div>
                        )}
                    </section>

                    <section>
                        <h6>Transform</h6>
                        <div className="EezStudio_ImageEditor_Buttons">
                            <IconAction
                                icon="material:rotate_left"
                                title="Rotate 90° left"
                                onClick={() => state.rotate(false)}
                            />
                            <IconAction
                                icon="material:rotate_right"
                                title="Rotate 90° right"
                                onClick={() => state.rotate(true)}
                            />
                            <IconAction
                                icon="material:flip"
                                title="Flip horizontal"
                                onClick={() => state.flip(true)}
                            />
                            <IconAction
                                icon="material:flip"
                                title="Flip vertical"
                                style={{ transform: "rotate(90deg)" }}
                                onClick={() => state.flip(false)}
                            />
                        </div>
                    </section>

                    <section>
                        <h6>Tools</h6>
                        <div className="EezStudio_ImageEditor_Buttons">
                            <IconAction
                                icon="material:open_with"
                                title="No tool (scroll to pan)"
                                selected={state.tool == "select"}
                                onClick={action(() => (state.tool = "select"))}
                            />
                            <IconAction
                                icon="material:crop"
                                title="Crop (drag a rectangle, then Enter)"
                                selected={state.tool == "crop"}
                                onClick={action(() => (state.tool = "crop"))}
                            />
                            <IconAction
                                icon="material:brush"
                                title="Pen"
                                selected={state.tool == "pen"}
                                onClick={action(() => (state.tool = "pen"))}
                            />
                            <IconAction
                                icon={ERASER_ICON}
                                title="Eraser"
                                selected={state.tool == "eraser"}
                                onClick={action(() => (state.tool = "eraser"))}
                            />
                        </div>

                        {state.tool == "crop" && (
                            <>
                                <div className="EezStudio_ImageEditor_Hint">
                                    {state.crop
                                        ? `${state.crop.width} x ${state.crop.height} at (${state.crop.x}, ${state.crop.y})`
                                        : "Drag on the image to select an area"}
                                </div>
                                <div className="EezStudio_ImageEditor_Buttons">
                                    <button
                                        type="button"
                                        className="btn btn-sm btn-primary"
                                        disabled={!state.crop}
                                        onClick={() => state.applyCrop()}
                                    >
                                        Apply crop
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-sm btn-outline-secondary"
                                        disabled={!state.crop}
                                        onClick={action(
                                            () => (state.crop = undefined)
                                        )}
                                    >
                                        Clear
                                    </button>
                                </div>
                            </>
                        )}

                        {(state.tool == "pen" || state.tool == "eraser") && (
                            <div className="EezStudio_ImageEditor_Row">
                                {state.tool == "pen" && (
                                    <input
                                        type="color"
                                        className="form-control form-control-sm form-control-color"
                                        value={state.penColor}
                                        onChange={action(
                                            event =>
                                                (state.penColor =
                                                    event.target.value)
                                        )}
                                    />
                                )}
                                <label>Size</label>
                                <input
                                    type="number"
                                    className="form-control form-control-sm"
                                    min={1}
                                    max={200}
                                    value={state.penSize}
                                    onChange={action(event => {
                                        const value = parseInt(
                                            event.target.value
                                        );
                                        state.penSize = isNaN(value)
                                            ? 1
                                            : Math.max(
                                                  1,
                                                  Math.min(200, value)
                                              );
                                    })}
                                />
                            </div>
                        )}

                        <button
                            type="button"
                            className="btn btn-sm btn-outline-secondary"
                            title="Crop away fully transparent borders"
                            onClick={() => state.trimTransparent()}
                        >
                            Trim transparent edges
                        </button>
                    </section>

                    <section>
                        <h6>Remove Background</h6>
                        <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            title={
                                state.aiModelDownloaded
                                    ? "Detect the main object with AI and remove everything else"
                                    : `On first use AI model (${AI_MODEL_DOWNLOAD_SIZE_MB} MB) is downloaded from the internet`
                            }
                            onClick={() => state.removeBackgroundAI()}
                        >
                            AI remove background
                        </button>
                        {!state.aiModelDownloaded && (
                            <div className="EezStudio_ImageEditor_Hint">
                                First use downloads AI model (
                                {AI_MODEL_DOWNLOAD_SIZE_MB} MB)
                            </div>
                        )}
                        {state.aiError && (
                            <div className="EezStudio_ImageEditor_Error">
                                {state.aiError}
                            </div>
                        )}

                        <div className="EezStudio_ImageEditor_Buttons">
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                title="Remove solid color background connected to the image edges"
                                onClick={() => state.autoRemoveBackground()}
                            >
                                Remove by edge color
                            </button>
                            <IconAction
                                icon="material:colorize"
                                title="Magic wand: click on a color to remove it"
                                selected={state.tool == "wand"}
                                onClick={action(() => (state.tool = "wand"))}
                            />
                        </div>
                        <div className="EezStudio_ImageEditor_Row">
                            <label title="How different a color can be from the background color and still be removed">
                                Tolerance
                            </label>
                            <input
                                type="range"
                                className="form-range"
                                min={0}
                                max={100}
                                value={state.bgTolerance}
                                onChange={action(
                                    event =>
                                        (state.bgTolerance = parseInt(
                                            event.target.value
                                        ))
                                )}
                            />
                            <span>{state.bgTolerance}</span>
                        </div>
                        <div className="EezStudio_ImageEditor_Row">
                            <label title="Width of the semi-transparent edge">
                                Softness
                            </label>
                            <input
                                type="range"
                                className="form-range"
                                min={0}
                                max={50}
                                value={state.bgSoftness}
                                onChange={action(
                                    event =>
                                        (state.bgSoftness = parseInt(
                                            event.target.value
                                        ))
                                )}
                            />
                            <span>{state.bgSoftness}</span>
                        </div>
                        <Checkbox
                            label="Magic wand: connected area only"
                            checked={state.bgContiguous}
                            onChange={action(
                                value => (state.bgContiguous = value)
                            )}
                        />
                    </section>

                    <section>
                        <h6>Adjust</h6>
                        <div className="EezStudio_ImageEditor_Buttons">
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                onClick={() => state.grayscale()}
                            >
                                Grayscale
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                onClick={() => state.invert()}
                            >
                                Invert
                            </button>
                        </div>
                        <div className="EezStudio_ImageEditor_Row">
                            <input
                                type="color"
                                className="form-control form-control-sm form-control-color"
                                value={state.backgroundColor}
                                onChange={action(
                                    event =>
                                        (state.backgroundColor =
                                            event.target.value)
                                )}
                            />
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                title="Replace transparency with a solid color"
                                onClick={() => state.fillBackground()}
                            >
                                Fill background
                            </button>
                        </div>
                    </section>

                    <section>
                        <h6>View</h6>
                        <div className="EezStudio_ImageEditor_Buttons">
                            <IconAction
                                icon="material:zoom_out"
                                title="Zoom out"
                                onClick={action(
                                    () =>
                                        (state.zoom = Math.max(
                                            0.05,
                                            (state.zoom ?? 1) / 1.5
                                        ))
                                )}
                            />
                            <IconAction
                                icon="material:zoom_in"
                                title="Zoom in"
                                onClick={action(
                                    () =>
                                        (state.zoom = Math.min(
                                            32,
                                            (state.zoom ?? 1) * 1.5
                                        ))
                                )}
                            />
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                onClick={action(() => (state.zoom = 1))}
                            >
                                100%
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                onClick={action(
                                    () => (state.zoom = undefined)
                                )}
                            >
                                Fit
                            </button>
                        </div>
                    </section>
                </fieldset>
            );
        }
    }
);

const ERASER_ICON = (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor">
        <path d="M16.24 3.56l4.95 4.94c.78.79.78 2.05 0 2.84L12 20.53a4.008 4.008 0 0 1-5.66 0L2.81 17c-.78-.79-.78-2.05 0-2.84l10.6-10.6c.79-.78 2.05-.78 2.83 0M4.22 15.58l3.54 3.53c.78.79 2.04.79 2.83 0l3.53-3.53-4.95-4.95-4.95 4.95z" />
    </svg>
);

function Checkbox(props: {
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <label className="form-check EezStudio_ImageEditor_Checkbox">
            <input
                type="checkbox"
                className="form-check-input"
                checked={props.checked}
                onChange={event => props.onChange(event.target.checked)}
            />
            <span className="form-check-label">{props.label}</span>
        </label>
    );
}

////////////////////////////////////////////////////////////////////////////////

const ImageEditorCanvas = observer(
    class ImageEditorCanvas extends React.Component<{
        state: ImageEditorState;
    }> {
        containerRef = React.createRef<HTMLDivElement>();
        canvasRef = React.createRef<HTMLCanvasElement>();
        resizeObserver: ResizeObserver | undefined;

        containerWidth = 0;
        containerHeight = 0;

        dragStart: { x: number; y: number } | undefined;
        lastPoint: { x: number; y: number } | undefined;

        constructor(props: any) {
            super(props);
            makeObservable(this, {
                containerWidth: observable,
                containerHeight: observable,
                scale: computed
            });
        }

        get scale() {
            const state = this.props.state;
            if (state.zoom != undefined) {
                return state.zoom;
            }
            const PADDING = 40;
            if (this.containerWidth == 0 || this.containerHeight == 0) {
                return 1;
            }
            return Math.max(
                0.01,
                Math.min(
                    (this.containerWidth - PADDING) / state.width,
                    (this.containerHeight - PADDING) / state.height,
                    32
                )
            );
        }

        componentDidMount() {
            const container = this.containerRef.current!;
            this.resizeObserver = new ResizeObserver(
                action(() => {
                    this.containerWidth = container.clientWidth;
                    this.containerHeight = container.clientHeight;
                })
            );
            this.resizeObserver.observe(container);
            this.paint();
        }

        componentDidUpdate() {
            this.paint();
        }

        componentWillUnmount() {
            this.resizeObserver?.disconnect();
        }

        paint() {
            const canvas = this.canvasRef.current;
            if (!canvas) {
                return;
            }
            const source = this.props.state.canvas;
            if (
                canvas.width != source.width ||
                canvas.height != source.height
            ) {
                canvas.width = source.width;
                canvas.height = source.height;
            }
            const ctx = canvas.getContext("2d")!;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(source, 0, 0);
        }

        getImagePoint(event: React.PointerEvent, clamp: boolean) {
            const canvas = this.canvasRef.current!;
            const rect = canvas.getBoundingClientRect();
            const state = this.props.state;
            let x = ((event.clientX - rect.left) * state.width) / rect.width;
            let y = ((event.clientY - rect.top) * state.height) / rect.height;
            if (clamp) {
                x = Math.max(0, Math.min(state.width, x));
                y = Math.max(0, Math.min(state.height, y));
            }
            return { x, y };
        }

        onPointerDown = (event: React.PointerEvent) => {
            if (event.button != 0) {
                return;
            }
            const state = this.props.state;
            if (state.tool == "select" || state.busy) {
                return;
            }

            if (state.tool == "wand") {
                const p = this.getImagePoint(event, false);
                state.magicWand(p.x, p.y);
                return;
            }

            event.preventDefault();
            (event.target as HTMLElement).setPointerCapture(event.pointerId);

            if (state.tool == "crop") {
                const p = this.getImagePoint(event, true);
                this.dragStart = { x: Math.round(p.x), y: Math.round(p.y) };
                action(() => (state.crop = undefined))();
            } else {
                const p = this.getImagePoint(event, false);
                state.pushUndo();
                state.drawLine(p.x, p.y, p.x, p.y);
                this.lastPoint = p;
            }
        };

        onPointerMove = (event: React.PointerEvent) => {
            const state = this.props.state;
            if (state.tool == "crop" && this.dragStart) {
                const p = this.getImagePoint(event, true);
                const x0 = this.dragStart.x;
                const y0 = this.dragStart.y;
                const x1 = Math.round(p.x);
                const y1 = Math.round(p.y);
                action(() => {
                    state.crop = {
                        x: Math.min(x0, x1),
                        y: Math.min(y0, y1),
                        width: Math.abs(x1 - x0),
                        height: Math.abs(y1 - y0)
                    };
                })();
            } else if (
                (state.tool == "pen" || state.tool == "eraser") &&
                this.lastPoint
            ) {
                const p = this.getImagePoint(event, false);
                state.drawLine(this.lastPoint.x, this.lastPoint.y, p.x, p.y);
                this.lastPoint = p;
            }
        };

        onPointerUp = (event: React.PointerEvent) => {
            const state = this.props.state;
            if (this.dragStart && state.crop) {
                if (state.crop.width < 1 || state.crop.height < 1) {
                    action(() => (state.crop = undefined))();
                }
            }
            this.dragStart = undefined;
            this.lastPoint = undefined;
        };

        render() {
            const state = this.props.state;
            // make sure we re-render on every canvas change
            state.version;

            const scale = this.scale;
            const displayWidth = Math.max(1, Math.round(state.width * scale));
            const displayHeight = Math.max(
                1,
                Math.round(state.height * scale)
            );

            const crop = state.crop;

            return (
                <div
                    ref={this.containerRef}
                    className="EezStudio_ImageEditor_CanvasContainer"
                >
                    <div
                        className="EezStudio_ImageEditor_CanvasWrapper"
                        style={{
                            width: displayWidth,
                            height: displayHeight,
                            cursor:
                                state.tool == "select" ? "default" : "crosshair"
                        }}
                    >
                        <canvas
                            ref={this.canvasRef}
                            style={{
                                width: displayWidth,
                                height: displayHeight,
                                imageRendering:
                                    scale >= 2 ? "pixelated" : "auto"
                            }}
                            onPointerDown={this.onPointerDown}
                            onPointerMove={this.onPointerMove}
                            onPointerUp={this.onPointerUp}
                        />
                        {crop && state.tool == "crop" && (
                            <div
                                className="EezStudio_ImageEditor_CropRect"
                                style={{
                                    left: crop.x * scale,
                                    top: crop.y * scale,
                                    width: crop.width * scale,
                                    height: crop.height * scale
                                }}
                            />
                        )}
                    </div>
                    {state.busy && (
                        <div className="EezStudio_ImageEditor_Busy">
                            <div>
                                <div className="spinner-border spinner-border-sm" />
                                <span>{state.busyMessage}</span>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-secondary"
                                    onClick={() => state.cancelAI()}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            );
        }
    }
);
