// Main process side of the built-in command line interface.
//
// `EEZ Studio --cli <command> [args]` (or the `eez-cli` launcher) runs the
// command inside a hidden renderer window, because the project model needs a
// DOM. This module relays stdio between the terminal and that renderer.

import { app, ipcMain, BrowserWindow } from "electron";
import { spawn } from "child_process";
import net from "net";
import util from "util";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

export const CLI_FLAG = "--cli";

export function isCliMode() {
    return process.argv.includes(CLI_FLAG);
}

function getCliArgs(): string[] {
    // the launcher passes args through the environment to avoid any
    // command line quoting issues (JSON values, spaces, unicode ...)
    const envArgs = process.env.EEZ_STUDIO_CLI_ARGS;
    if (envArgs) {
        try {
            const args = JSON.parse(envArgs);
            if (Array.isArray(args)) {
                return args.map(arg => String(arg));
            }
        } catch (err) {}
    }

    const i = process.argv.indexOf(CLI_FLAG);
    return i == -1 ? [] : process.argv.slice(i + 1);
}

// Chromium's storage (localStorage, cache ...) of the user profile is locked
// by a running EEZ Studio GUI; opening it from the CLI waits ~5 seconds for
// the lock. The CLI doesn't need that data: each CLI process gets its own
// temporary session folder (settings and the database are not affected).
// Must be called before the app is ready.
export function useTemporarySessionData() {
    const prefix = "eez-cli-session-";
    const tmp = os.tmpdir();

    // remove folders left over by earlier CLI processes
    try {
        const hourAgo = Date.now() - 60 * 60 * 1000;
        for (const name of fs.readdirSync(tmp)) {
            if (!name.startsWith(prefix)) continue;
            const dir = path.join(tmp, name);
            try {
                if (fs.statSync(dir).mtimeMs < hourAgo) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            } catch (err) {}
        }
    } catch (err) {}

    // the launcher creates the folder and removes it after the process exits
    const fromLauncher = process.env.EEZ_STUDIO_CLI_SESSION_DIR;
    if (fromLauncher) {
        app.setPath("sessionData", fromLauncher);
        return;
    }

    try {
        const dir = fs.mkdtempSync(path.join(tmp, prefix));
        app.setPath("sessionData", dir);
        sessionDataDir = dir;
    } catch (err) {}
}

let sessionDataDir: string | undefined;

function removeSessionData() {
    if (sessionDataDir) {
        try {
            fs.rmSync(sessionDataDir, { recursive: true, force: true });
        } catch (err) {}
    }
}

// stdout is reserved for command output (and JSON-RPC in MCP mode)
export function redirectConsoleToStderr() {
    const toStderr = (...args: any[]) => {
        process.stderr.write(util.format(...args) + "\n");
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    console.warn = toStderr;
}

function flushAndExit(code: number) {
    let pending = 2;
    const done = () => {
        if (--pending == 0) {
            removeSessionData();
            app.exit(code);
        }
    };
    process.stdout.write("", done);
    process.stderr.write("", done);
}

function spawnGui(args: string[]) {
    const env = Object.assign({}, process.env);
    // A GUI started from an MCP worker must not inherit its stdio bridge,
    // temporary session or Electron-as-Node launcher mode.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.EEZ_STUDIO_CLI_ARGS;
    delete env.EEZ_STUDIO_CLI_STDIN;
    delete env.EEZ_STUDIO_CLI_SESSION_DIR;
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env
    });
    child.on("error", err => console.error("Failed to launch EEZ Studio GUI", err));
    child.unref();
}

export function launchGui(filePath?: string) {
    const args = process.defaultApp ? [app.getAppPath()] : [];
    if (filePath) {
        args.push(filePath);
    }
    spawnGui(args);
}

// Ask a running GUI to reload from disk through the single instance lock.
// If no GUI is running, this short-lived helper just quits.
function reloadGui(filePath: string) {
    const args = process.defaultApp ? [app.getAppPath()] : [];
    args.push("--reload-project", filePath);
    spawnGui(args);
}

export async function runCliMain(homeWindowUrl: string) {
    const args = getCliArgs();
    const debug = args.includes("--cli-debug");
    const devTools = args.includes("--cli-devtools");

    const { loadSettings } = await import("main/settings");
    await loadSettings();

    const { setup } = await import("main/setup");
    await setup();

    await import("instrument/connection/interfaces/serial-ports-main");

    require("eez-studio-shared/service");

    const { createWindow } = await import("main/window");

    let cliWindow: BrowserWindow;

    ipcMain.handle("cli:init", () => ({
        args,
        cwd: process.cwd(),
        debug
    }));

    ipcMain.on("cli:write", (event, stream: string, data: string) => {
        (stream == "stderr" ? process.stderr : process.stdout).write(data);
    });

    ipcMain.on("cli:exit", (event, code: number) => {
        flushAndExit(typeof code == "number" ? code : 1);
    });

    let stdinStarted = false;
    ipcMain.on("cli:stdin-start", event => {
        if (stdinStarted) {
            return;
        }
        stdinStarted = true;
        const sender = event.sender;

        let input: NodeJS.ReadableStream;
        const bridge = process.env.EEZ_STUDIO_CLI_STDIN;
        if (bridge) {
            // launcher bridges its stdin through a local socket
            const [host, port] = bridge.split(":");
            const socket = net.connect(Number(port), host);
            socket.on("error", err => {
                process.stderr.write(`eez-cli: stdin bridge error: ${err.message}\n`);
                if (!sender.isDestroyed()) {
                    sender.send("cli:stdin-end");
                }
            });
            input = socket;
        } else {
            input = process.stdin;
        }

        input.setEncoding("utf8");
        input.on("data", (chunk: string) => {
            if (!sender.isDestroyed()) {
                sender.send("cli:stdin-data", chunk);
            }
        });
        input.on("end", () => {
            if (!sender.isDestroyed()) {
                sender.send("cli:stdin-end");
            }
        });
        input.resume();
    });

    ipcMain.handle(
        "cli:capture-page",
        async (
            event,
            rect: { x: number; y: number; width: number; height: number }
        ) => {
            const image = await cliWindow.webContents.capturePage(rect);
            return image.toPNG();
        }
    );

    ipcMain.handle(
        "cli:set-window-size",
        (event, width: number, height: number) => {
            cliWindow.setContentSize(width, height);
        }
    );

    ipcMain.on("cli:reload-gui", (event, filePath: string) => {
        try {
            reloadGui(filePath);
        } catch (err) {
            console.error("reload-gui failed", err);
        }
    });

    cliWindow = createWindow({
        url: homeWindowUrl + "?cli=1",
        showHidden: true
    });

    cliWindow.webContents.on("render-process-gone", (event, details) => {
        process.stderr.write(
            `eez-cli: renderer process gone (${details.reason})\n`
        );
        flushAndExit(70);
    });

    cliWindow.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription) => {
            process.stderr.write(
                `eez-cli: failed to load renderer (${errorDescription})\n`
            );
            flushAndExit(70);
        }
    );

    if (debug) {
        cliWindow.webContents.on(
            "console-message",
            (event: any, level?: any, legacyMessage?: any) => {
                const message = event.message ?? legacyMessage;
                process.stderr.write(`[renderer] ${message}\n`);
            }
        );
    }

    if (devTools) {
        cliWindow.show();
        cliWindow.webContents.openDevTools();
    }

    if (args[0] == "serve") {
        const idleIndex = args.indexOf("--idle");
        const idleMinutes =
            idleIndex != -1 ? Number(args[idleIndex + 1]) || 30 : 30;
        startDaemon(cliWindow, idleMinutes);
    }
}

////////////////////////////////////////////////////////////////////////////////
// daemon ("eez-cli daemon start"): keeps the app and the project model
// loaded; the launcher sends command lines through a local socket, which
// avoids the start-up time of every command.

export const DAEMON_STATE_FILE = path.join(os.tmpdir(), "eez-cli-daemon.json");

function startDaemon(cliWindow: BrowserWindow, idleMinutes: number) {
    const token = crypto.randomBytes(24).toString("hex");
    const pending = new Map<number, net.Socket>();
    let nextId = 1;
    let port: number | undefined;
    let rendererReady = false;
    let idleTimer: any;

    const removeStateFile = () => {
        try {
            const state = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, "utf8"));
            if (state.pid == process.pid) {
                fs.unlinkSync(DAEMON_STATE_FILE);
            }
        } catch (err) {}
    };

    const stop = () => {
        removeStateFile();
        flushAndExit(0);
    };

    const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(stop, idleMinutes * 60 * 1000);
    };

    const writeStateFile = () => {
        if (port == undefined || !rendererReady) {
            return;
        }
        fs.writeFileSync(
            DAEMON_STATE_FILE,
            JSON.stringify({
                pid: process.pid,
                port,
                token,
                execPath: process.execPath,
                appPath: process.defaultApp ? app.getAppPath() : undefined,
                version: app.getVersion()
            }),
            { encoding: "utf8", mode: 0o600 }
        );
        resetIdleTimer();
    };

    app.on("will-quit", removeStateFile);

    ipcMain.on("cli:serve-ready", () => {
        rendererReady = true;
        writeStateFile();
    });

    ipcMain.on("cli:serve-response", (event, id: number, response: any) => {
        const socket = pending.get(id);
        pending.delete(id);
        if (socket && !socket.destroyed) {
            socket.end(JSON.stringify(response) + "\n");
        }
        if (pending.size == 0) {
            resetIdleTimer();
        }
    });

    const reply = (socket: net.Socket, response: any, callback?: () => void) =>
        socket.end(JSON.stringify(response) + "\n", callback);

    const server = net.createServer(socket => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("error", () => {});
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const i = buffer.indexOf("\n");
            if (i == -1) {
                return;
            }
            let request: any;
            try {
                request = JSON.parse(buffer.substring(0, i));
            } catch (err) {
                socket.destroy();
                return;
            }
            buffer = "";

            if (request.token !== token) {
                reply(socket, { stderr: "eez-cli: invalid daemon token\n", exitCode: 1 });
                return;
            }

            if (request.type == "ping") {
                reply(socket, {
                    stdout: JSON.stringify({ pid: process.pid, version: app.getVersion() }) + "\n",
                    exitCode: 0
                });
                return;
            }

            if (request.type == "stop") {
                reply(socket, { stdout: "daemon stopped\n", exitCode: 0 }, stop);
                return;
            }

            clearTimeout(idleTimer);
            const id = nextId++;
            pending.set(id, socket);
            cliWindow.webContents.send("cli:serve-request", id, {
                args: Array.isArray(request.args) ? request.args.map(String) : [],
                cwd: typeof request.cwd == "string" ? request.cwd : process.cwd()
            });
        });
    });

    server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        writeStateFile();
    });
}
