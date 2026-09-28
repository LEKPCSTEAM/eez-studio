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

// ISNet (DIS) general use model, Apache-2.0 license.
const MODEL = {
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
    fileName: "isnet-general-use.onnx",
    size: 178648008,
    inputName: "input_image",
    outputName: "output_image",
    inputSize: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [1, 1, 1]
};

export const AI_MODEL_DOWNLOAD_SIZE_MB = Math.round(MODEL.size / 1024 / 1024);

function getModelFilePath() {
    return path.join(getModelsDir(), MODEL.fileName);
}

export function isAIModelDownloaded() {
    return fileHasSize(getModelFilePath(), MODEL.size);
}

////////////////////////////////////////////////////////////////////////////////

let sessionPromise:
    | Promise<{ session: OrtModule.InferenceSession; backend: Backend }>
    | undefined;

async function createBackgroundRemovalSession() {
    if (await isGPUAvailable()) {
        try {
            return {
                session: await createSession(getModelFilePath(), "GPU"),
                backend: "GPU" as Backend
            };
        } catch (err) {
            console.warn(
                "WebGPU not available for background removal, using CPU",
                err
            );
        }
    }

    return {
        session: await createSession(getModelFilePath(), "CPU"),
        backend: "CPU" as Backend
    };
}

function getSession() {
    if (!sessionPromise) {
        sessionPromise = createBackgroundRemovalSession();
        sessionPromise.catch(() => {
            sessionPromise = undefined;
        });
    }
    return sessionPromise;
}

////////////////////////////////////////////////////////////////////////////////

// Returns a new canvas, same size as source, with the background made transparent.
export async function removeBackgroundWithAI(
    source: HTMLCanvasElement,
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    if (!isAIModelDownloaded()) {
        await downloadFile(
            MODEL.url,
            getModelFilePath(),
            MODEL.size,
            "AI model",
            onProgress,
            signal
        );
    }

    onProgress("Loading AI model...");
    let session: OrtModule.InferenceSession;
    let backend: Backend;
    try {
        ({ session, backend } = await getSession());
    } catch (err) {
        // model file is probably corrupted, it will be downloaded again next time
        await fs.promises.rm(getModelFilePath(), { force: true });
        throw err;
    }

    throwIfAborted(signal);

    onProgress(`Removing background (${backend})...`);

    const S = MODEL.inputSize;

    // model input: RGB, NCHW, S x S
    const inputCanvas = document.createElement("canvas");
    inputCanvas.width = S;
    inputCanvas.height = S;
    const inputCtx = inputCanvas.getContext("2d")!;
    inputCtx.imageSmoothingEnabled = true;
    inputCtx.imageSmoothingQuality = "high";
    // transparent pixels are treated as white
    inputCtx.fillStyle = "#ffffff";
    inputCtx.fillRect(0, 0, S, S);
    inputCtx.drawImage(source, 0, 0, S, S);
    const pixels = inputCtx.getImageData(0, 0, S, S).data;

    const input = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) {
        for (let c = 0; c < 3; c++) {
            input[c * S * S + i] =
                (pixels[i * 4 + c] / 255 - MODEL.mean[c]) / MODEL.std[c];
        }
    }

    const ort = getOrt();
    const results = await session.run({
        [MODEL.inputName]: new ort.Tensor("float32", input, [1, 3, S, S])
    });
    const output = results[MODEL.outputName].data as Float32Array;

    // normalize mask to 0..1
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < output.length; i++) {
        const v = output[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min || 1;

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = S;
    maskCanvas.height = S;
    const maskCtx = maskCanvas.getContext("2d")!;
    const maskData = maskCtx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
        maskData.data[i * 4 + 3] = Math.round(
            ((output[i] - min) / range) * 255
        );
    }
    maskCtx.putImageData(maskData, 0, 0);

    // scale mask to the source size and apply it
    const result = document.createElement("canvas");
    result.width = source.width;
    result.height = source.height;
    const resultCtx = result.getContext("2d")!;
    resultCtx.imageSmoothingEnabled = true;
    resultCtx.imageSmoothingQuality = "high";
    resultCtx.drawImage(maskCanvas, 0, 0, result.width, result.height);
    resultCtx.globalCompositeOperation = "source-in";
    resultCtx.drawImage(source, 0, 0);

    return result;
}
