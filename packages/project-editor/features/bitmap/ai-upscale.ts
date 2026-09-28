import fs from "fs";
import path from "path";

import type * as OrtModule from "onnxruntime-web";

import {
    Backend,
    createSession,
    downloadFile,
    fileHasSize,
    getModelsDir,
    getOrt,
    isGPUAvailable,
    ProgressCallback,
    throwIfAborted
} from "./ai-models";

////////////////////////////////////////////////////////////////////////////////

// Real-ESRGAN (BSD-3-Clause license), ONNX export from Qualcomm AI Hub.
// x4plus gives the best details but it is too slow without GPU,
// so on CPU the much smaller general-x4v3 model is used.
interface UpscaleModel {
    id: string;
    zipSize: number;
    onnxSize: number;
    dataSize: number;
}

const MODELS: { [backend in Backend]: UpscaleModel } = {
    GPU: {
        id: "real_esrgan_x4plus",
        zipSize: 62174027,
        onnxSize: 3158313,
        dataSize: 66737664
    },
    CPU: {
        id: "real_esrgan_general_x4v3",
        zipSize: 4540895,
        onnxSize: 161087,
        dataSize: 4836096
    }
};

const MODELS_VERSION = "v0.63.0";

// model has fixed input size
const TILE_SIZE = 128;
// tiles overlap to avoid visible seams
const TILE_PAD = 16;
const SCALE = 4;

// limit for the intermediate (x4) image
const MAX_OUTPUT_PIXELS = 64 * 1024 * 1024;

function getModelUrl(model: UpscaleModel) {
    return `https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/${model.id}/releases/${MODELS_VERSION}/${model.id}-onnx-float.zip`;
}

function getModelFiles(model: UpscaleModel) {
    const dir = path.join(getModelsDir(), model.id);
    return {
        dir,
        onnx: path.join(dir, `${model.id}.onnx`),
        data: path.join(dir, `${model.id}.data`)
    };
}

function isModelDownloaded(model: UpscaleModel) {
    const files = getModelFiles(model);
    return (
        fileHasSize(files.onnx, model.onnxSize) &&
        fileHasSize(files.data, model.dataSize)
    );
}

async function downloadModel(
    model: UpscaleModel,
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    const files = getModelFiles(model);
    const zipFilePath = files.dir + ".zip";

    await downloadFile(
        getModelUrl(model),
        zipFilePath,
        model.zipSize,
        "AI upscale model",
        onProgress,
        signal
    );

    try {
        onProgress("Extracting AI upscale model...");
        const { default: AdmZip } = await import("adm-zip");
        const zip = new AdmZip(zipFilePath);
        await fs.promises.mkdir(files.dir, { recursive: true });
        for (const filePath of [files.onnx, files.data]) {
            const entry = zip.getEntry(
                `${model.id}-onnx-float/${path.basename(filePath)}`
            );
            if (!entry) {
                throw new Error("Invalid AI upscale model archive");
            }
            await fs.promises.writeFile(filePath, entry.getData());
        }
    } finally {
        await fs.promises.rm(zipFilePath, { force: true });
    }
}

// Info for the UI: which model will be used and whether it must be downloaded
export async function getUpscaleModelInfo() {
    const model = MODELS[(await isGPUAvailable()) ? "GPU" : "CPU"];
    return {
        downloaded: isModelDownloaded(model),
        downloadSizeMB: Math.max(1, Math.round(model.zipSize / 1024 / 1024))
    };
}

////////////////////////////////////////////////////////////////////////////////

const sessions: {
    [backend in Backend]?: Promise<OrtModule.InferenceSession>;
} = {};

async function getModelSession(
    backend: Backend,
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    const model = MODELS[backend];

    if (!isModelDownloaded(model)) {
        await downloadModel(model, onProgress, signal);
    }

    onProgress("Loading AI upscale model...");

    let sessionPromise = sessions[backend];
    if (!sessionPromise) {
        const files = getModelFiles(model);
        sessionPromise = createSession(files.onnx, backend, files.data);
        sessions[backend] = sessionPromise;
        sessionPromise.catch(() => {
            sessions[backend] = undefined;
        });
    }

    return sessionPromise;
}

async function getUpscaleSession(
    onProgress: ProgressCallback,
    signal: AbortSignal
): Promise<{ session: OrtModule.InferenceSession; backend: Backend }> {
    if (await isGPUAvailable()) {
        try {
            return {
                session: await getModelSession("GPU", onProgress, signal),
                backend: "GPU"
            };
        } catch (err) {
            throwIfAborted(signal);
            console.warn("WebGPU upscaling not available, using CPU", err);
        }
    }

    return {
        session: await getModelSession("CPU", onProgress, signal),
        backend: "CPU"
    };
}

////////////////////////////////////////////////////////////////////////////////

// Transparent pixels usually have black color which would make dark fringe
// around the object after upscaling, so fill them with the neighbor colors.
function bleedColorsIntoTransparentPixels(
    data: Uint8ClampedArray,
    width: number,
    height: number
) {
    const n = width * height;
    const known = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        known[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    }

    const MAX_PASSES = 16;
    const newlyKnown: number[] = [];

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        newlyKnown.length = 0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (known[i]) {
                    continue;
                }

                let r = 0;
                let g = 0;
                let b = 0;
                let count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                            const j = ny * width + nx;
                            if (known[j]) {
                                r += data[j * 4];
                                g += data[j * 4 + 1];
                                b += data[j * 4 + 2];
                                count++;
                            }
                        }
                    }
                }

                if (count > 0) {
                    data[i * 4] = r / count;
                    data[i * 4 + 1] = g / count;
                    data[i * 4 + 2] = b / count;
                    newlyKnown.push(i);
                }
            }
        }

        if (newlyKnown.length == 0) {
            break;
        }
        for (const i of newlyKnown) {
            known[i] = 1;
        }
    }
}

async function upscaleX4(
    source: HTMLCanvasElement,
    session: OrtModule.InferenceSession,
    backend: Backend,
    progress: { done: number; total: number; pass: number; passes: number },
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    const ort = getOrt();

    const W = source.width;
    const H = source.height;
    const OW = W * SCALE;
    const OH = H * SCALE;

    const src = source.getContext("2d")!.getImageData(0, 0, W, H).data;

    let hasAlpha = false;
    for (let i = 3; i < src.length; i += 4) {
        if (src[i] < 255) {
            hasAlpha = true;
            break;
        }
    }
    if (hasAlpha) {
        bleedColorsIntoTransparentPixels(src, W, H);
    }

    const out = new Uint8ClampedArray(OW * OH * 4);
    if (!hasAlpha) {
        for (let i = 3; i < out.length; i += 4) {
            out[i] = 255;
        }
    }

    const T = TILE_SIZE;
    const STEP = T - 2 * TILE_PAD;
    const OT = T * SCALE;
    const input = new Float32Array(3 * T * T);

    const tilesX = Math.ceil(W / STEP);
    const tilesY = Math.ceil(H / STEP);
    progress.done = 0;
    progress.total = tilesX * tilesY * (hasAlpha ? 2 : 1);

    // alpha channel is upscaled with the same model as a grayscale image
    for (const channel of hasAlpha ? ["rgb", "alpha"] : ["rgb"]) {
        for (let ty = 0; ty < H; ty += STEP) {
            for (let tx = 0; tx < W; tx += STEP) {
                throwIfAborted(signal);

                // read tile, pixels outside of the image are clamped to the edge
                for (let y = 0; y < T; y++) {
                    const sy = Math.min(H - 1, Math.max(0, ty - TILE_PAD + y));
                    for (let x = 0; x < T; x++) {
                        const sx = Math.min(
                            W - 1,
                            Math.max(0, tx - TILE_PAD + x)
                        );
                        const i = (sy * W + sx) * 4;
                        const j = y * T + x;
                        if (channel == "rgb") {
                            input[j] = src[i] / 255;
                            input[T * T + j] = src[i + 1] / 255;
                            input[2 * T * T + j] = src[i + 2] / 255;
                        } else {
                            const a = src[i + 3] / 255;
                            input[j] = a;
                            input[T * T + j] = a;
                            input[2 * T * T + j] = a;
                        }
                    }
                }

                const results = await session.run({
                    [session.inputNames[0]]: new ort.Tensor(
                        "float32",
                        input,
                        [1, 3, T, T]
                    )
                });
                const output = results[session.outputNames[0]]
                    .data as Float32Array;

                // copy the center part of the tile (without padding)
                const cw = Math.min(STEP, W - tx) * SCALE;
                const ch = Math.min(STEP, H - ty) * SCALE;
                for (let y = 0; y < ch; y++) {
                    for (let x = 0; x < cw; x++) {
                        const oi =
                            (TILE_PAD * SCALE + y) * OT + (TILE_PAD * SCALE + x);
                        const di =
                            ((ty * SCALE + y) * OW + (tx * SCALE + x)) * 4;
                        if (channel == "rgb") {
                            out[di] = output[oi] * 255;
                            out[di + 1] = output[OT * OT + oi] * 255;
                            out[di + 2] = output[2 * OT * OT + oi] * 255;
                        } else {
                            out[di + 3] =
                                ((output[oi] +
                                    output[OT * OT + oi] +
                                    output[2 * OT * OT + oi]) /
                                    3) *
                                255;
                        }
                    }
                }

                // on CPU inference blocks the main thread, let the UI update
                // (progress, Cancel button) between the tiles
                await new Promise(resolve => setTimeout(resolve, 0));

                progress.done++;
                onProgress(
                    `Upscaling with AI (${backend})` +
                        (progress.passes > 1
                            ? ` pass ${progress.pass}/${progress.passes}`
                            : "") +
                        ` ${Math.floor(
                            (progress.done / progress.total) * 100
                        )}%`
                );
            }
        }
    }

    const canvas = document.createElement("canvas");
    canvas.width = OW;
    canvas.height = OH;
    canvas.getContext("2d")!.putImageData(new ImageData(out, OW, OH), 0, 0);
    return canvas;
}

function resizeCanvasHighQuality(
    source: HTMLCanvasElement,
    width: number,
    height: number
) {
    // downscale in steps of 1/2 for better quality on large reductions
    while (source.width / 2 > width && source.height / 2 > height) {
        const half = document.createElement("canvas");
        half.width = Math.max(width, Math.round(source.width / 2));
        half.height = Math.max(height, Math.round(source.height / 2));
        const ctx = half.getContext("2d")!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, half.width, half.height);
        source = half;
    }

    if (source.width == width && source.height == height) {
        return source;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
}

// Enlarges the image to the given size, AI model reconstructs the details.
export async function upscaleWithAI(
    source: HTMLCanvasElement,
    width: number,
    height: number,
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    // number of x4 passes needed
    let passes = 1;
    while (
        source.width * Math.pow(SCALE, passes) < width ||
        source.height * Math.pow(SCALE, passes) < height
    ) {
        passes++;
    }

    let outputPixels = source.width * source.height;
    for (let pass = 0; pass < passes; pass++) {
        outputPixels *= SCALE * SCALE;
        if (outputPixels > MAX_OUTPUT_PIXELS) {
            throw new Error(
                "Image is too large for AI upscaling, crop or resize it first"
            );
        }
    }

    const { session, backend } = await getUpscaleSession(onProgress, signal);

    const progress = { done: 0, total: 0, pass: 0, passes };

    let canvas = source;
    for (let pass = 1; pass <= passes; pass++) {
        progress.pass = pass;
        canvas = await upscaleX4(
            canvas,
            session,
            backend,
            progress,
            onProgress,
            signal
        );
    }

    return resizeCanvasHighQuality(canvas, width, height);
}
