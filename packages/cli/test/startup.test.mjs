// Startup regression tests. Requires a build, like cli.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const main = fs.readFileSync(new URL("../../../build/main/main.js", import.meta.url), "utf8");

function startup(args, platform = "darwin") {
    let dockVisible = true;
    const app = {
        setActivationPolicy(policy) {
            assert.equal(policy, "accessory");
            dockVisible = false;
        },
        commandLine: { appendSwitch() {} },
        on() {}
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
            useTemporarySessionData() {}
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

test("macOS reload helper stays out of the Dock before ready", () => {
    assert.equal(startup(["--reload-project", "/tmp/project.eez-project"]), false);
});

test("normal macOS GUI keeps its Dock icon", () => {
    assert.equal(startup([]), true);
});

test("Windows and Linux do not call the macOS activation API", () => {
    for (const platform of ["win32", "linux"]) {
        assert.equal(startup(["--cli", "mcp"], platform), true);
        assert.equal(startup(["--reload-project", "/tmp/project.eez-project"], platform), true);
    }
});
