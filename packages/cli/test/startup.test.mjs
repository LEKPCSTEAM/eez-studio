// Startup regression tests. Requires a build, like cli.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const main = fs.readFileSync(new URL("../../../build/main/main.js", import.meta.url), "utf8");

function startup(args, platform = "darwin", events = new Map(), guiLaunches = []) {
    let dockVisible = true;
    const app = {
        setActivationPolicy(policy) {
            assert.equal(policy, "accessory");
            dockVisible = false;
        },
        commandLine: { appendSwitch() {} },
        isReady: () => true,
        whenReady: async () => {},
        on(name, listener) { events.set(name, listener); }
    };
    const modules = {
        "./fix-path": {},
        electron: { app, ipcMain: { on() {}, once() {} } },
        mobx: { configure() {} },
        "@electron/remote/main": { initialize() {} },
        "instrument/connection/interfaces/visa-dll": {},
        "main/setup": {},
        "main/home-window": {},
        "main/cli-main": {
            isCliMode: () => args.includes("--cli"),
            redirectConsoleToStderr() {},
            useTemporarySessionData() {},
            launchGui: file => guiLaunches.push(file)
        },
        "electron-context-menu": () => {}
    };
    vm.runInNewContext(main, {
        exports: {},
        require: name => {
            if (name == "tslib") return require(name);
            assert.ok(Object.hasOwn(modules, name), `unexpected module: ${name}`);
            return modules[name];
        },
        process: { argv: ["electron", ".", ...args], platform, env: {}, on() {} }
    });
    return dockVisible;
}

test("macOS background CLI instances stay out of the Dock before ready", () => {
    for (const command of ["mcp", "serve", "info"]) {
        for (let instance = 0; instance < 3; instance++) {
            assert.equal(startup(["--cli", command]), false, command);
        }
    }
});

test("reopening a macOS MCP worker launches the GUI", async () => {
    const events = new Map();
    const launches = [];
    startup(["--cli", "mcp"], "darwin", events, launches);
    await events.get("activate")?.({}, false);
    assert.deepEqual(launches, [undefined]);
});

test("opening a file through a macOS MCP worker forwards it to the GUI", async () => {
    const events = new Map();
    const launches = [];
    startup(["--cli", "mcp"], "darwin", events, launches);
    await events.get("will-finish-launching")();
    let prevented = false;
    await events.get("open-file")({ preventDefault() { prevented = true; } }, "/tmp/example.eez-project");
    assert.equal(prevented, true);
    assert.deepEqual(launches, ["/tmp/example.eez-project"]);
});

test("macOS reload helper stays out of the Dock before ready", () => {
    assert.equal(startup(["--reload-project", "/tmp/project.eez-project"]), false);
});

test("macOS refresh helper stays out of the Dock before ready", () => {
    assert.equal(startup(["--refresh-gui"]), false);
});

test("normal macOS GUI keeps its Dock icon", () => {
    assert.equal(startup([]), true);
});

test("Windows and Linux do not call the macOS activation API", () => {
    for (const platform of ["win32", "linux"]) {
        assert.equal(startup(["--cli", "mcp"], platform), true);
        assert.equal(startup(["--reload-project", "/tmp/project.eez-project"], platform), true);
        assert.equal(startup(["--refresh-gui"], platform), true);
    }
});

test("GUI launch drops MCP arguments and environment, including for source builds", () => {
    const cliMain = fs.readFileSync(
        new URL("../../../build/main/cli-main.js", import.meta.url), "utf8"
    );
    for (const defaultApp of [false, true]) {
        const launches = [];
        const exports = {};
        vm.runInNewContext(cliMain, {
            exports,
            require: name => {
                if (name == "electron") return { app: { getAppPath: () => "/source" } };
                if (name == "child_process") return {
                    spawn: (...args) => {
                        launches.push(args);
                        return { on() {}, unref() {} };
                    }
                };
                return require(name);
            },
            process: {
                defaultApp, execPath: "/studio",
                env: {
                    PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1",
                    EEZ_STUDIO_CLI_ARGS: '["mcp"]',
                    EEZ_STUDIO_CLI_STDIN: "127.0.0.1:1234",
                    EEZ_STUDIO_CLI_SESSION_DIR: "/tmp/worker"
                }
            }
        });
        exports.launchGui("/project with spaces.eez-project");
        const [command, args, options] = launches[0];
        assert.equal(command, "/studio");
        assert.deepEqual(Array.from(args), defaultApp
            ? ["/source", "/project with spaces.eez-project"]
            : ["/project with spaces.eez-project"]);
        assert.deepEqual({ ...options.env }, { PATH: "/usr/bin" });
    }
});
