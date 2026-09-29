import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { app } from "@electron/remote";

import type * as OrtModule from "onnxruntime-web";

////////////////////////////////////////////////////////////////////////////////

// AI models are not shipped with the application,
// they are downloaded on the first use and stored in the user data folder.

export type ProgressCallback = (message: string) => void;

export type Backend = "GPU" | "CPU";

export function getModelsDir() {
    return path.join(app.getPath("userData"), "models");
}

export function fileHasSize(filePath: string, size: number) {
    try {
        return fs.statSync(filePath).size == size;
    } catch (err) {
        return false;
    }
}

export function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }
}

export async function downloadFile(
    url: string,
    filePath: string,
    expectedSize: number,
    label: string,
    onProgress: ProgressCallback,
    signal: AbortSignal
) {
    const tempFilePath = filePath + ".download";

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) {
        throw new Error(
            `Download failed: ${response.status} ${response.statusText}`
        );
    }

    const total =
        parseInt(response.headers.get("content-length") ?? "") ||
        expectedSize;

    const file = await fs.promises.open(tempFilePath, "w");
    let received = 0;
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            await file.write(value);
            received += value.length;
            onProgress(
                `Downloading ${label} ${Math.floor(
                    (received / total) * 100
                )}% (${Math.round(received / 1024 / 1024)} / ${Math.round(
                    total / 1024 / 1024
                )} MB)`
            );
        }
    } catch (err) {
        await file.close();
        await fs.promises.rm(tempFilePath, { force: true });
        throw err;
    }
    await file.close();

    if (received != expectedSize) {
        await fs.promises.rm(tempFilePath, { force: true });
        throw new Error(
            `Downloaded file has unexpected size (${received} bytes)`
        );
    }

    await fs.promises.rename(tempFilePath, filePath);
}

////////////////////////////////////////////////////////////////////////////////

let ort: typeof OrtModule | undefined;

export function getOrt() {
    if (!ort) {
        // WebGPU build, it also contains WASM (CPU) backend used as a fallback
        const ortFilePath = require.resolve("onnxruntime-web/webgpu");
        ort = require(ortFilePath) as typeof OrtModule;

        // .wasm/.mjs files are unpacked from asar in the installed application
        const distDir = path
            .dirname(ortFilePath)
            .replace(
                `app.asar${path.sep}`,
                `app.asar.unpacked${path.sep}`
            );
        ort.env.wasm.wasmPaths = pathToFileURL(distDir).href + "/";
    }
    return ort;
}

let gpuAvailablePromise: Promise<boolean> | undefined;

export function isGPUAvailable() {
    if (!gpuAvailablePromise) {
        gpuAvailablePromise = (async () => {
            try {
                const gpu = (navigator as any).gpu;
                return gpu ? !!(await gpu.requestAdapter()) : false;
            } catch (err) {
                return false;
            }
        })();
    }
    return gpuAvailablePromise;
}

export async function createSession(
    modelFilePath: string,
    backend: Backend,
    externalDataFilePath?: string
) {
    const ort = getOrt();

    const options: OrtModule.InferenceSession.SessionOptions = {
        executionProviders: [backend == "GPU" ? "webgpu" : "wasm"]
    };

    if (externalDataFilePath) {
        options.externalData = [
            {
                path: path.basename(externalDataFilePath),
                data: await fs.promises.readFile(externalDataFilePath)
            }
        ];
    }

    return ort.InferenceSession.create(
        await fs.promises.readFile(modelFilePath),
        options
    );
}
