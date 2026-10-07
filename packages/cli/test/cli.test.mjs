// End-to-end tests of the EEZ Studio CLI (runs the real app in CLI mode).
// Requires a build: npm run build-src (or npm run watch), then: npm run test:cli

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "..", "launcher", "eez-cli.js");
const fixture = path.join(here, "fixtures", "minimal-lvgl.eez-project");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eez-cli-test-"));

function cli(args, options = {}) {
    const result = spawnSync(process.execPath, [launcher, ...args, "--no-reload-gui"], {
        cwd: options.cwd ?? tmp,
        input: options.input,
        encoding: "utf8",
        timeout: 120000,
        // each test starts its own app unless it asks for the daemon
        env: { ...process.env, EEZ_CLI_DAEMON: options.daemon ? "on" : "off" }
    });
    return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        json() {
            return JSON.parse(result.stdout);
        }
    };
}

function copyFixture(name) {
    const file = path.join(tmp, name);
    fs.copyFileSync(fixture, file);
    return file;
}

function pngSize(file) {
    const buffer = fs.readFileSync(file);
    assert.equal(buffer.subarray(1, 4).toString("latin1"), "PNG", "not a PNG file");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("help lists commands", () => {
    const r = cli(["help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /widget add/);
    assert.match(r.stdout, /render page/);
});

test("unknown command is a usage error", () => {
    const r = cli(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command/);
});

test("info on an existing project", () => {
    const file = copyFixture("info.eez-project");
    const r = cli(["-p", file, "info", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const json = r.json();
    assert.equal(json.ok, true);
    assert.equal(json.result.projectType, "lvgl");
    assert.equal(json.result.pages[0].selector, "page:Main");
});

test("design an LVGL page, check, render", () => {
    const file = path.join(tmp, "design.eez-project");
    let r = cli(["project", "new", file, "--type", "lvgl", "--lvgl", "9.2.2", "--size", "320x240"]);
    assert.equal(r.code, 0, r.stderr);

    r = cli(["-p", file, "apply", "-"], {
        input: [
            "lvgl-style add Card --for Panel bg_color=#FFFFFF radius=12",
            "widget add Panel --page Main --name card --at 10,10 --size 300,100 --style Card",
            'widget add Label --parent Main/card --name title --at 0,0 text="Hello"',
            "widget style set page:Main/title text_font=MONTSERRAT_20 text_color=#E53935",
            "widget add Button --page Main --name btn --at 10,150 --size 120,50",
            'widget set page:Main/btn/[0] text="OK"'
        ].join("\n")
    });
    assert.equal(r.code, 0, r.stderr);

    r = cli(["-p", file, "check", "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json().result.errors, 0);

    r = cli(["-p", file, "page", "tree", "Main", "--json"]);
    const selectors = r.json().result.map(node => node.selector);
    assert.ok(selectors.includes("page:main_page/panel_card"));
    assert.ok(selectors.includes("page:main_page/label_title"));

    const png = path.join(tmp, "design.png");
    r = cli(["-p", file, "render", "page", "Main", "-o", png, "--layout", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pngSize(png), { width: 320, height: 240 });
    const layout = r.json().result.layout;
    const card = layout.find(entry => entry.selector == "page:main_page/panel_card");
    assert.deepEqual([card.x, card.y, card.width, card.height], [10, 10, 300, 100]);

    r = cli(["-p", file, "render", "Main", "-o", png, "--scale", "2", "--bounds"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pngSize(png), { width: 640, height: 480 });
});

test("invalid values are rejected with a hint and nothing is saved", () => {
    const file = copyFixture("invalid.eez-project");
    const before = fs.readFileSync(file, "utf8");

    let r = cli(["-p", file, "widget", "add", "Slider", "--page", "Main", "--name", "s", "mode=NOPE"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /allowed:/);
    assert.equal(fs.readFileSync(file, "utf8"), before);

    r = cli(["-p", file, "widget", "set", "page:Main/missing", "text=x"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/);
});

test("--dry-run does not write the project", () => {
    const file = copyFixture("dry.eez-project");
    const before = fs.readFileSync(file, "utf8");
    const r = cli(["-p", file, "page", "add", "Other", "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /dry run/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("apply is a transaction", () => {
    const file = copyFixture("tx.eez-project");
    const before = fs.readFileSync(file, "utf8");
    const r = cli([
        "-p",
        file,
        "apply",
        "--ops",
        JSON.stringify(["page add A", "widget add NoSuchWidget --page A"])
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /operation 2 failed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("project new --dry-run writes nothing, also with --force", () => {
    const dir = path.join(tmp, "dry-new");
    let r = cli(["project", "new", path.join(dir, "new.eez-project"), "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const json = r.json();
    assert.equal(json.dryRun, true);
    assert.equal(json.saved, false);
    assert.equal(fs.existsSync(dir), false);

    const file = copyFixture("dry-force.eez-project");
    const before = fs.readFileSync(file, "utf8");
    r = cli(["project", "new", file, "--force", "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("failed apply removes copied assets, project new is not allowed", () => {
    const dir = path.join(tmp, "tx-assets");
    fs.mkdirSync(dir);
    const file = path.join(dir, "tx-assets.eez-project");
    fs.copyFileSync(fixture, file);
    const before = fs.readFileSync(file, "utf8");
    const png = path.join(tmp, "icon.png");
    fs.writeFileSync(
        png,
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64"
        )
    );

    let r = cli([
        "-p",
        file,
        "apply",
        "--ops",
        JSON.stringify([
            ["image", "add", png, "--name", "icon"],
            "widget add NoSuchWidget --page Main"
        ])
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /operation 2 failed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(dir), ["tx-assets.eez-project"]);

    const other = path.join(dir, "other.eez-project");
    r = cli(["-p", file, "apply", "--ops", JSON.stringify([["project", "new", other]])]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /can't be part of a transaction/);
    assert.equal(fs.existsSync(other), false);
});

test("references are updated on rename and protected on remove", () => {
    const file = copyFixture("refs.eez-project");
    let r = cli(["-p", file, "apply", "-"], {
        input: [
            "color add brand #FF0000",
            "widget add Label --page Main --name l1 text=Hi",
            "widget style set page:Main/l1 text_color=brand"
        ].join("\n")
    });
    assert.equal(r.code, 0, r.stderr);

    r = cli(["-p", file, "color", "rm", "brand"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /referenced/);

    r = cli(["-p", file, "color", "rename", "brand", "accent"]);
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", file, "widget", "style", "show", "page:Main/l1", "--json"]);
    assert.equal(r.json().result.definition.MAIN.DEFAULT.text_color, "accent");
});

test("flow: variable, event handler, component, connection", () => {
    const file = path.join(tmp, "flow.eez-project");
    let r = cli(["project", "new", file, "--type", "lvgl-flow"]);
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", file, "apply", "-"], {
        input: [
            "var add counter --type integer --default 0",
            "widget add Button --page Main --name inc --at 10,10",
            "widget event add page:Main/inc --event CLICKED --flow",
            `flow add Main SetVariable --values '{"entries":[{"variable":"counter","value":"counter + 1"}]}'`,
            "flow connect Main inc [1] --output CLICKED",
            "widget add Label --page Main --name value --at 10,80 textType=expression text=counter"
        ].join("\n")
    });
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", file, "check", "--json"]);
    assert.equal(r.json().result.errors, 0, r.stdout);
    r = cli(["-p", file, "build"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, "src", "ui", "screens.c")), "screens.c generated");
});

test("repl --json prints one JSON result per line", () => {
    const file = copyFixture("repl.eez-project");
    const r = cli(["repl", "-p", file, "--json"], { input: "info\npage list\nnope\n" });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].ok, true);
    assert.equal(lines[1].result[0].name, "Main");
    assert.equal(lines[2].ok, false);
});

test("EEZ-GUI firmware project renders", () => {
    const file = path.join(tmp, "fw.eez-project");
    let r = cli(["project", "new", file, "--type", "firmware"]);
    assert.equal(r.code, 0, r.stderr);
    // the firmware template (same as the GUI wizard) has a page named "main"
    r = cli(["-p", file, "widget", "add", "Text", "--page", "main", "--at", "10,10", "--size", "200,40", "text=Hello"]);
    assert.equal(r.code, 0, r.stderr);
    const png = path.join(tmp, "fw.png");
    r = cli(["-p", file, "render", "main", "-o", png]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pngSize(png), { width: 480, height: 272 });
    r = cli(["-p", file, "check", "--json"]);
    assert.equal(r.json().result.errors, 0, r.stdout);
});

test("mistyped names get suggestions", () => {
    const file = copyFixture("suggest.eez-project");
    let r = cli(["-p", file, "lvgl-style", "add", "S", "--for", "Panel", "shadow_offset_y=4"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did you mean "shadow_ofs_y"/);
    r = cli(["-p", file, "widget", "add", "Buton", "--page", "Main"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did you mean "Button"/);
    r = cli(["-p", file, "widget", "add", "Slider", "--page", "Main", "mode=RANGEE"]);
    assert.match(r.stderr, /did you mean "RANGE"/);
});

test("icon button, --no-label, stacked widgets are not overlaps", () => {
    const file = copyFixture("icons.eez-project");
    const icon = path.join(here, "..", "..", "..", "icon.png");
    let r = cli(["-p", file, "apply", "--ops", JSON.stringify([
        `image add "${icon}" --name home --no-copy`,
        "widget add Button --page Main --name nav --at 10,10 --size 64,64 --icon home",
        "widget add Button --page Main --name plain --at 100,10 --size 64,64 --no-label",
        "widget add Arc --page Main --name arc --at 10,100 --size 200,200",
        "widget add Label --page Main --name val --at 90,190 text=24",
        "widget add Label --page Main --name edge --at 190,100 text=Overlapping"
    ])]);
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", file, "page", "tree", "Main", "--json"]);
    const nodes = r.json().result;
    const types = Object.fromEntries(nodes.map(n => [n.selector, n.type]));
    assert.equal(types["page:Main/img_nav_icon"], "Image");
    assert.equal(nodes.filter(n => n.selector.startsWith("page:Main/btn_plain/")).length, 0);

    r = cli(["-p", file, "render", "Main", "--layout", "--json", "-o", path.join(tmp, "icons.png")]);
    const layout = Object.fromEntries(r.json().result.layout.map(e => [e.selector, e]));
    assert.equal(layout["page:Main/label_val"].issues, undefined);
    assert.deepEqual(layout["page:Main/label_val"].stackedOn, ["page:Main/arc"]);
    assert.ok(layout["page:Main/label_edge"].issues.some(i => i.startsWith("overlaps")));
});

test("project new --size keeps template widgets on the screen", () => {
    const file = path.join(tmp, "resized.eez-project");
    let r = cli(["project", "new", file, "--size", "360x480", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().saved, true);
    r = cli(["-p", file, "render", "Main", "--layout", "--json", "-o", path.join(tmp, "resized.png")]);
    for (const entry of r.json().result.layout) {
        assert.equal(entry.issues, undefined, JSON.stringify(entry));
    }
});

test("naming convention: names are corrected, legacy names fixed", () => {
    const file = path.join(tmp, "naming.eez-project");
    let r = cli(["project", "new", file, "--json"]);
    assert.deepEqual(r.json().result.pages, ["page:main_page"]);

    r = cli(["-p", file, "page", "add", "Settings", "--json"]);
    assert.equal(r.json().result.selector, "page:settings_page");
    assert.ok(r.json().notes[0].includes("settings_page"));

    r = cli(["-p", file, "apply", "--ops", JSON.stringify([
        "widget add Label --page Main --name title text=Hi",
        "widget add Image --page Main --name iconHome",
        "widget add Button --page settings_page --name btnSave",
        "widget add Slider --page Main --name img_volume"
    ]), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.created, [
        "page:main_page/label_title",
        "page:main_page/img_icon_home",
        "page:settings_page/btn_save",
        "page:main_page/slider_img_volume"
    ]);

    // names must stay unique
    r = cli(["-p", file, "widget", "add", "Label", "--page", "Main", "--name", "label_title"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already used/);

    // renames follow the convention too
    r = cli(["-p", file, "widget", "set", "page:main_page/label_title", "--name", "Heading", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", file, "naming", "check", "--strict"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);

    // legacy project: check warns, naming fix renames and updates references
    const legacy = copyFixture("legacy.eez-project");
    r = cli(["-p", legacy, "obj", "add", "/lvglStyles/styles", "name=Card", "forWidgetType=LVGLPanelWidget"]);
    const json = JSON.parse(fs.readFileSync(legacy, "utf8"));
    json.userPages[0].components[0].children.push({
        type: "LVGLPanelWidget", identifier: "myCard", useStyle: "card", left: 0, top: 0, width: 10, height: 10,
        leftUnit: "px", topUnit: "px", widthUnit: "px", heightUnit: "px", children: []
    });
    fs.writeFileSync(legacy, JSON.stringify(json, null, 2));
    r = cli(["-p", legacy, "check", "--json"]);
    assert.ok(r.json().result.problems.some(p => p.text.includes('"myCard"')), r.stdout);
    r = cli(["-p", legacy, "naming", "fix"]);
    assert.equal(r.code, 0, r.stderr);
    r = cli(["-p", legacy, "naming", "check", "--strict"]);
    assert.equal(r.code, 0, r.stdout);
    r = cli(["-p", legacy, "widget", "get", "page:main_page/panel_my_card", "--props", "useStyle", "--json"]);
    assert.equal(r.json().result.useStyle, "card");
});

test("daemon: start, run commands, stop", () => {
    let r = cli(["daemon", "start", "--idle", "2"]);
    assert.equal(r.code, 0, r.stderr);
    try {
        const file = copyFixture("daemon.eez-project");
        const t = Date.now();
        r = cli(["-p", file, "page", "add", "Second"], { daemon: true });
        assert.equal(r.code, 0, r.stderr);
        r = cli(["-p", file, "page", "list", "--json"], { daemon: true });
        assert.deepEqual(r.json().result.map(p => p.name), ["Main", "second_page"]);
        assert.ok(Date.now() - t < 5000, "daemon requests should be fast");
        r = cli(["-p", file, "widget", "add", "Nope", "--page", "Main"], { daemon: true });
        assert.equal(r.code, 1);
    } finally {
        r = cli(["daemon", "stop"]);
        assert.equal(r.code, 0);
    }
    r = cli(["daemon", "status"]);
    assert.equal(r.code, 1);
});

test("MCP server: initialize, list tools, render returns an image", async () => {
    const file = copyFixture("mcp.eez-project");
    const child = spawn(process.execPath, [launcher, "mcp", "-p", file, "--no-reload-gui"], {
        stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    const waiting = new Map();
    child.stdout.on("data", chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) != -1) {
            const message = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            waiting.get(message.id)?.(message);
        }
    });
    let id = 0;
    const rpc = (method, params) =>
        new Promise(resolve => {
            const requestId = ++id;
            waiting.set(requestId, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
        });

    try {
        const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
        assert.equal(init.result.serverInfo.name, "eez-studio");

        const tools = await rpc("tools/list", {});
        const names = tools.result.tools.map(tool => tool.name);
        for (const name of ["eez_run", "eez_add_widget", "eez_style", "eez_render", "eez_check", "eez_refresh_gui"]) {
            assert.ok(names.includes(name), name);
        }

        const add = await rpc("tools/call", {
            name: "eez_add_widget",
            arguments: { type: "Label", page: "Main", name: "hello", x: 10, y: 10, values: { text: "Hi" } }
        });
        assert.equal(add.result.isError, false, add.result.content[0].text);

        // a single coordinate changes only that value
        const set = await rpc("tools/call", {
            name: "eez_set",
            arguments: { selector: "page:Main/hello", y: 42 }
        });
        assert.equal(set.result.isError, false, set.result.content[0].text);
        const get = await rpc("tools/call", {
            name: "eez_get",
            arguments: { selector: "page:Main/hello", props: ["left", "top"] }
        });
        const values = JSON.parse(get.result.content[0].text).result;
        assert.match(JSON.stringify(values), /"left":10\b/);
        assert.match(JSON.stringify(values), /"top":42\b/);

        const render = await rpc("tools/call", { name: "eez_render", arguments: { page: "Main" } });
        assert.equal(render.result.isError, false);
        const image = render.result.content.find(c => c.type == "image");
        assert.equal(image.mimeType, "image/png");
        assert.ok(image.data.length > 100);
    } finally {
        child.stdin.end();
        await new Promise(resolve => child.on("exit", resolve));
    }
});

test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});
