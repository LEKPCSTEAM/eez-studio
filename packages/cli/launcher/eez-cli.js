#!/usr/bin/env node
// eez-cli: command line interface of EEZ Studio.
//
// Starts EEZ Studio in CLI mode (hidden window, no GUI), relays stdin/stdout
// and returns the command's exit code. Works from a source checkout
// (electron from node_modules) or with an installed EEZ Studio:
//
//   node eez-cli.js [--studio <path to EEZ Studio executable>] <command> [args]
//   EEZ_STUDIO=<path to executable> node eez-cli.js <command> [args]
//
// Run "node eez-cli.js help" for the list of commands.

"use strict";

const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

function findRepoRoot() {
    // packages/cli/launcher or build/cli/launcher -> repo root
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const packageJson = path.join(dir, "package.json");
        if (fs.existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
                if (pkg.name == "eezstudio" || pkg.name == "eez-studio") {
                    return dir;
                }
            } catch (err) {}
        }
        dir = path.dirname(dir);
    }
    return undefined;
}

function installedExecutableCandidates() {
    const candidates = [];
    if (process.platform == "win32") {
        const local = process.env.LOCALAPPDATA;
        if (local) {
            candidates.push(
                path.join(local, "Programs", "eezstudio", "EEZ Studio.exe"),
                path.join(local, "Programs", "eez-studio", "EEZ Studio.exe")
            );
        }
        for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
            if (pf) {
                candidates.push(path.join(pf, "EEZ Studio", "EEZ Studio.exe"));
            }
        }
    } else if (process.platform == "darwin") {
        candidates.push(
            "/Applications/EEZ Studio.app/Contents/MacOS/EEZ Studio"
        );
        candidates.push(
            path.join(
                os.homedir(),
                "Applications/EEZ Studio.app/Contents/MacOS/EEZ Studio"
            )
        );
    } else {
        candidates.push("/opt/EEZ Studio/eez-studio");
        candidates.push("/usr/bin/eez-studio");
    }
    return candidates;
}

function resolveStudio(explicit) {
    if (explicit) {
        return { command: explicit, args: [] };
    }

    if (process.env.EEZ_STUDIO) {
        return { command: process.env.EEZ_STUDIO, args: [] };
    }

    // installed app: this file is <resources>/cli/eez-cli.js
    const resourcesDir = path.dirname(__dirname);
    for (const candidate of [
        path.join(resourcesDir, "..", "EEZ Studio.exe"), // Windows
        path.join(resourcesDir, "..", "MacOS", "EEZ Studio"), // macOS
        path.join(resourcesDir, "..", "eez-studio") // Linux
    ]) {
        if (path.basename(resourcesDir).toLowerCase() == "resources" && fs.existsSync(candidate)) {
            return { command: candidate, args: [] };
        }
    }

    const repoRoot = findRepoRoot();
    if (repoRoot) {
        const built = path.join(repoRoot, "build", "main", "main.js");
        if (fs.existsSync(built)) {
            let electron;
            try {
                electron = require(require.resolve("electron", {
                    paths: [repoRoot]
                }));
            } catch (err) {}
            if (typeof electron == "string" && fs.existsSync(electron)) {
                return { command: electron, args: [repoRoot] };
            }
        }
    }

    for (const candidate of installedExecutableCandidates()) {
        if (fs.existsSync(candidate)) {
            return { command: candidate, args: [] };
        }
    }

    return undefined;
}

////////////////////////////////////////////////////////////////////////////////
// daemon: "eez-cli daemon start" keeps EEZ Studio (and the last project)
// loaded, following commands are sent to it instead of starting the app

const DAEMON_STATE_FILE = path.join(os.tmpdir(), "eez-cli-daemon.json");

function readDaemonState() {
    try {
        return JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, "utf8"));
    } catch (err) {
        return undefined;
    }
}

function sameStudio(state, resolved) {
    const norm = p => (p ? path.resolve(p).toLowerCase() : "");
    return (
        norm(state.execPath) == norm(resolved.command) &&
        norm(state.appPath) == norm(resolved.args[0])
    );
}

function daemonRequest(state, request, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(state.port, "127.0.0.1");
        let buffer = "";
        let timer;
        if (timeoutMs) {
            timer = setTimeout(() => {
                socket.destroy();
                reject(new Error("timeout"));
            }, timeoutMs);
        }
        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write(JSON.stringify(Object.assign({ token: state.token }, request)) + "\n");
        });
        socket.on("data", chunk => (buffer += chunk));
        socket.on("end", () => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(buffer));
            } catch (err) {
                reject(new Error("invalid daemon response"));
            }
        });
        socket.on("error", err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function runningDaemon(resolved) {
    const state = readDaemonState();
    if (!state || !sameStudio(state, resolved)) {
        return undefined;
    }
    try {
        await daemonRequest(state, { type: "ping" }, 5000);
        return state;
    } catch (err) {
        // stale state file (daemon crashed or was killed)
        try {
            fs.unlinkSync(DAEMON_STATE_FILE);
        } catch (err) {}
        return undefined;
    }
}

function studioEnv(argv) {
    const env = Object.assign({}, process.env, {
        EEZ_STUDIO_CLI_ARGS: JSON.stringify(argv),
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        ELECTRON_ENABLE_LOGGING: ""
    });
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}

async function startDaemon(resolved, idleMinutes) {
    const running = await runningDaemon(resolved);
    if (running) {
        return running;
    }
    const child = spawn(resolved.command, [...resolved.args, "--cli"], {
        env: studioEnv(["serve", "--idle", String(idleMinutes)]),
        stdio: "ignore",
        detached: true,
        windowsHide: true
    });
    child.unref();
    const startTime = Date.now();
    while (Date.now() - startTime < 90000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const state = await runningDaemon(resolved);
        if (state) {
            return state;
        }
    }
    throw new Error("daemon did not start");
}

async function daemonCommand(resolved, argv) {
    const action = argv[1] ?? "status";
    if (action == "start") {
        const idleIndex = argv.indexOf("--idle");
        const idle = idleIndex != -1 ? Number(argv[idleIndex + 1]) || 30 : 30;
        const state = await startDaemon(resolved, idle);
        process.stdout.write(
            `daemon running (pid ${state.pid}, stops after ${idle} min idle)\n`
        );
        return 0;
    }
    const state = await runningDaemon(resolved);
    if (action == "stop") {
        if (!state) {
            process.stdout.write("daemon is not running\n");
            return 0;
        }
        const response = await daemonRequest(state, { type: "stop" });
        process.stdout.write(response.stdout ?? "");
        return 0;
    }
    if (action == "status") {
        process.stdout.write(
            state
                ? `daemon running (pid ${state.pid}, EEZ Studio ${state.version})\n`
                : "daemon is not running\n"
        );
        return state ? 0 : 1;
    }
    process.stderr.write(
        `eez-cli: unknown daemon action "${action}"\n  usage: eez-cli daemon start [--idle minutes] | stop | status\n`
    );
    return 2;
}

// commands that need the process' own stdin/stdout
function needsOwnProcess(argv) {
    return (
        ["mcp", "repl", "serve"].includes(argv[0]) ||
        argv.includes("-") ||
        argv.includes("--cli-debug") ||
        argv.includes("--cli-devtools")
    );
}

async function main() {
    const argv = process.argv.slice(2);

    let studio;
    const studioIndex = argv.indexOf("--studio");
    if (studioIndex != -1) {
        studio = argv[studioIndex + 1];
        argv.splice(studioIndex, 2);
    }

    const resolved = resolveStudio(studio);
    if (!resolved) {
        process.stderr.write(
            "eez-cli: EEZ Studio not found.\n" +
                "  hint: pass --studio <path to EEZ Studio executable> or set EEZ_STUDIO\n"
        );
        process.exit(1);
    }

    if (argv[0] == "daemon") {
        try {
            process.exitCode = await daemonCommand(resolved, argv);
        } catch (err) {
            process.stderr.write(`eez-cli: ${err.message}\n`);
            process.exitCode = 1;
        }
        return;
    }

    if (!needsOwnProcess(argv) && process.env.EEZ_CLI_DAEMON != "off") {
        let state = await runningDaemon(resolved);
        if (!state && process.env.EEZ_CLI_DAEMON == "auto") {
            try {
                state = await startDaemon(resolved, 30);
            } catch (err) {}
        }
        if (state) {
            try {
                const response = await daemonRequest(state, {
                    args: argv,
                    cwd: process.cwd()
                });
                if (response.stdout) process.stdout.write(response.stdout);
                if (response.stderr) process.stderr.write(response.stderr);
                process.exitCode = typeof response.exitCode == "number" ? response.exitCode : 1;
                return;
            } catch (err) {
                // fall back to a new process
            }
        }
    }

    // stdin of the Electron main process is not reliable on all platforms,
    // so it is bridged through a local socket (connected only when needed)
    const stdinServer = net.createServer(socket => {
        socket.on("error", () => {});
        process.stdin.pipe(socket);
    });
    stdinServer.on("error", () => {});
    stdinServer.listen(0, "127.0.0.1", () => {
        start(resolved, argv, stdinServer);
    });
}

function start(resolved, argv, stdinServer) {
    const env = studioEnv(argv);
    env.EEZ_STUDIO_CLI_STDIN = `127.0.0.1:${stdinServer.address().port}`;

    // temporary Chromium session folder (see useTemporarySessionData)
    let sessionDir;
    try {
        sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eez-cli-session-"));
        env.EEZ_STUDIO_CLI_SESSION_DIR = sessionDir;
    } catch (err) {}

    const child = spawn(resolved.command, [...resolved.args, "--cli"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    // Electron may print an empty line on startup: drop leading blank
    // output so stdout is clean JSON / JSON-RPC
    let started = false;
    child.stdout.on("data", chunk => {
        if (!started) {
            let skip = 0;
            while (skip < chunk.length && (chunk[skip] == 10 || chunk[skip] == 13)) {
                skip++;
            }
            const text = chunk.subarray(skip);
            if (text.length == 0) {
                return;
            }
            started = true;
            chunk = text;
        }
        process.stdout.write(chunk);
    });

    // drop Chromium/Electron noise from stderr unless debugging
    const debug = argv.includes("--cli-debug");
    let stderrBuffer = "";
    child.stderr.on("data", chunk => {
        if (debug) {
            process.stderr.write(chunk);
            return;
        }
        stderrBuffer += chunk.toString("utf8");
        let i;
        while ((i = stderrBuffer.indexOf("\n")) != -1) {
            const line = stderrBuffer.substring(0, i + 1);
            stderrBuffer = stderrBuffer.substring(i + 1);
            if (!isNoise(line)) {
                process.stderr.write(line);
            }
        }
    });

    child.on("error", err => {
        process.stderr.write(`eez-cli: failed to start EEZ Studio: ${err.message}\n`);
        process.exit(1);
    });

    child.on("exit", (code, signal) => {
        if (stderrBuffer && !isNoise(stderrBuffer)) {
            process.stderr.write(stderrBuffer);
        }
        process.exitCode = code == null ? 1 : code;
        if (sessionDir) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 3 });
            } catch (err) {}
        }
        stdinServer.close();
        process.stdin.unpipe();
        process.stdin.destroy();
    });

    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            child.kill();
        });
    }
}

function isNoise(line) {
    return (
        /^\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING|INFO|VERBOSE\d*):/.test(line) ||
        /DevTools listening on/.test(line) ||
        /^\s*$/.test(line)
    );
}

main();
