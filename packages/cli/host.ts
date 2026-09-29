// Renderer side of the stdio bridge implemented in main/cli-main.ts

import { ipcRenderer } from "electron";

export interface CliInit {
    args: string[];
    cwd: string;
    debug: boolean;
}

export function getCliInit(): Promise<CliInit> {
    return ipcRenderer.invoke("cli:init");
}

export function writeStdout(text: string) {
    ipcRenderer.send("cli:write", "stdout", text);
}

export function writeStderr(text: string) {
    ipcRenderer.send("cli:write", "stderr", text);
}

export function exit(code: number) {
    ipcRenderer.send("cli:exit", code);
}

export function reloadGui(filePath: string) {
    ipcRenderer.send("cli:reload-gui", filePath);
}

export async function capturePage(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
}): Promise<Uint8Array> {
    return ipcRenderer.invoke("cli:capture-page", rect);
}

export async function setWindowSize(width: number, height: number) {
    await ipcRenderer.invoke("cli:set-window-size", width, height);
}

////////////////////////////////////////////////////////////////////////////////

let stdinListeners: {
    onData: (chunk: string) => void;
    onEnd: () => void;
}[] = [];
let stdinEnded = false;
let stdinStarted = false;

function startStdin() {
    if (stdinStarted) {
        return;
    }
    stdinStarted = true;
    ipcRenderer.on("cli:stdin-data", (event, chunk: string) => {
        stdinListeners.forEach(listener => listener.onData(chunk));
    });
    ipcRenderer.on("cli:stdin-end", () => {
        stdinEnded = true;
        stdinListeners.forEach(listener => listener.onEnd());
    });
    ipcRenderer.send("cli:stdin-start");
}

function addStdinListener(listener: {
    onData: (chunk: string) => void;
    onEnd: () => void;
}) {
    stdinListeners.push(listener);
    startStdin();
    if (stdinEnded) {
        listener.onEnd();
    }
}

export function readStdinAll(): Promise<string> {
    return new Promise(resolve => {
        let text = "";
        addStdinListener({
            onData: chunk => (text += chunk),
            onEnd: () => resolve(text)
        });
    });
}

export function onStdinLine(
    onLine: (line: string) => void,
    onEnd: () => void
) {
    let buffer = "";
    addStdinListener({
        onData: chunk => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf("\n")) != -1) {
                const line = buffer.substring(0, i).replace(/\r$/, "");
                buffer = buffer.substring(i + 1);
                onLine(line);
            }
        },
        onEnd: () => {
            if (buffer.length > 0) {
                onLine(buffer.replace(/\r$/, ""));
                buffer = "";
            }
            onEnd();
        }
    });
}
