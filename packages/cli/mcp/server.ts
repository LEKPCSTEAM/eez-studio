// MCP (Model Context Protocol) server over stdio: JSON-RPC 2.0, one message
// per line. Started with "eez-cli mcp [-p project]". Every tool maps to CLI
// commands executed by the same Runner, so the project stays loaded between
// calls and every change is checked and saved like on the command line.

import * as host from "cli/host";
import { EXIT_OK } from "cli/errors";
import { Runner, RunResult, resultToJSON, resultToText } from "cli/runner";

const PROTOCOL_VERSION = "2025-06-18";

interface Tool {
    name: string;
    description: string;
    inputSchema: any;
    toArgv(args: any): string[] | string[][];
}

const projectProperty = {
    project: {
        type: "string",
        description:
            "Path of the .eez-project file. Optional after the first call (the last project stays open)."
    }
};

function obj(properties: any, required: string[] = []) {
    return {
        type: "object",
        properties: { ...properties, ...projectProperty },
        required
    };
}

function withValues(argv: string[], values: any) {
    if (values && typeof values == "object" && Object.keys(values).length > 0) {
        argv.push("--values", JSON.stringify(values));
    }
    return argv;
}

// x/y/width/height -> --at x,y / --size w,h; a missing value is left empty (kept)
function pushGeometry(argv: string[], a: any) {
    const pair = (p: any, q: any) => `${p ?? ""},${q ?? ""}`;
    if (a.x !== undefined || a.y !== undefined)
        argv.push("--at", pair(a.x, a.y));
    if (a.width !== undefined || a.height !== undefined)
        argv.push("--size", pair(a.width, a.height));
}

function styleArgs(values: any) {
    // style values are simple key=value pairs
    return Object.entries(values ?? {}).map(
        ([key, value]) =>
            `${key}=${typeof value == "string" ? value : JSON.stringify(value)}`
    );
}

const TOOLS: Tool[] = [
    {
        name: "eez_help",
        description:
            'Help for the EEZ Studio CLI: list of all commands, or help for one command / topic (guide, selectors, values, workflow). Start with topic "guide": the full agent workflow.',
        inputSchema: obj({
            topic: {
                type: "string",
                description: 'e.g. "widget add", "selectors", "lvgl-style"'
            }
        }),
        toArgv: a => ["help", ...(a.topic ? String(a.topic).split(/\s+/) : [])]
    },
    {
        name: "eez_run",
        description:
            "Run any EEZ Studio CLI command (same syntax as the eez-cli command line, without the program name), e.g. 'page tree Main', 'widget add Button --page Main --name btnOk --at 20,20 --size 120,50', 'lvgl-style props --search color'. Covers every part of the project.",
        inputSchema: obj({
            command: { type: "string", description: "command line" },
            argv: {
                type: "array",
                items: { type: "string" },
                description: "alternative to command: pre-split arguments"
            }
        }),
        toArgv: a => {
            if (Array.isArray(a.argv)) return a.argv.map(String);
            const { splitCommandLine } = require("cli/args");
            return splitCommandLine(String(a.command ?? ""));
        }
    },
    {
        name: "eez_new_project",
        description: "Create a new EEZ Studio project and open it.",
        inputSchema: obj(
            {
                file: {
                    type: "string",
                    description: "path of the new .eez-project file"
                },
                type: {
                    type: "string",
                    enum: [
                        "lvgl",
                        "lvgl-flow",
                        "firmware",
                        "dashboard",
                        "eez-gui-lite"
                    ],
                    description: "default lvgl"
                },
                lvglVersion: {
                    type: "string",
                    enum: ["8.4.0", "9.2.2", "9.3.0", "9.4.0", "9.5.0"]
                },
                width: { type: "number" },
                height: { type: "number" },
                overwrite: { type: "boolean" }
            },
            ["file"]
        ),
        toArgv: a => {
            const argv = ["project", "new", a.file];
            if (a.type) argv.push("--type", a.type);
            if (a.lvglVersion) argv.push("--lvgl", a.lvglVersion);
            if (a.width && a.height)
                argv.push("--size", `${a.width}x${a.height}`);
            if (a.overwrite) argv.push("--force");
            return argv;
        }
    },
    {
        name: "eez_open",
        description:
            "Open an existing .eez-project file (following calls use it).",
        inputSchema: obj({ file: { type: "string" } }, ["file"]),
        toArgv: a => ["open", a.file]
    },
    {
        name: "eez_info",
        description:
            "Project overview: type, LVGL version, display size, collections and pages.",
        inputSchema: obj({}),
        toArgv: () => ["info"]
    },
    {
        name: "eez_tree",
        description:
            "Widget tree of a page with the selector of every widget (use selectors in other tools).",
        inputSchema: obj({
            page: {
                type: "string",
                description: "page name, default first page"
            }
        }),
        toArgv: a => ["page", "tree", ...(a.page ? [a.page] : [])]
    },
    {
        name: "eez_get",
        description:
            "Read any object by selector (page:Main, page:Main/btnOk, lvglStyle:X, font:X, var:X, settings/general, @objID, /object/path ...).",
        inputSchema: obj(
            {
                selector: { type: "string" },
                depth: {
                    type: "number",
                    description: "expand child objects, default 1"
                },
                props: { type: "array", items: { type: "string" } }
            },
            ["selector"]
        ),
        toArgv: a => {
            const argv = ["obj", "get", a.selector];
            if (a.depth !== undefined) argv.push("--depth", String(a.depth));
            if (Array.isArray(a.props) && a.props.length)
                argv.push("--props", a.props.join(","));
            return argv;
        }
    },
    {
        name: "eez_schema",
        description:
            "Properties (types, enum values, references) of a class, e.g. Button, Label, Page, Variable, SetVariable. Without class: list widget types.",
        inputSchema: obj({ class: { type: "string" } }),
        toArgv: a =>
            a.class ? ["schema", "class", a.class] : ["widget", "types"]
    },
    {
        name: "eez_add_widget",
        description:
            "Add a widget to a page or container. Returns its selector. Position/size: numbers (px), '50%' or 'content' (LVGL).",
        inputSchema: obj(
            {
                type: {
                    type: "string",
                    description:
                        "e.g. Button, Label, Panel, Slider, Switch, Image"
                },
                page: { type: "string" },
                parent: {
                    type: "string",
                    description: "selector of a container widget"
                },
                name: {
                    type: "string",
                    description:
                        "unique name, convention <type>_<name> snake_case, e.g. label_title, img_icon_home, btn_save (corrected automatically)"
                },
                x: { type: ["number", "string"] },
                y: { type: ["number", "string"] },
                width: { type: ["number", "string"] },
                height: { type: ["number", "string"] },
                style: {
                    type: "string",
                    description: "LVGL style name to use"
                },
                flags: {
                    type: "string",
                    description: "e.g. +HIDDEN,-SCROLLABLE"
                },
                states: { type: "string", description: "e.g. +CHECKED" },
                index: {
                    type: "number",
                    description: "position in the child list"
                },
                noLabel: {
                    type: "boolean",
                    description: "remove the default Label child (Button)"
                },
                icon: {
                    type: "string",
                    description:
                        "bitmap name: replace the default Label child with a centered Image"
                },
                values: {
                    type: "object",
                    description: 'other properties, e.g. {"text": "OK"}'
                }
            },
            ["type"]
        ),
        toArgv: a => {
            const argv = ["widget", "add", a.type];
            if (a.page) argv.push("--page", a.page);
            if (a.parent) argv.push("--parent", a.parent);
            if (a.name) argv.push("--name", a.name);
            pushGeometry(argv, a);
            if (a.style) argv.push("--style", a.style);
            if (a.flags) argv.push("--flag", a.flags);
            if (a.states) argv.push("--state", a.states);
            if (a.index !== undefined) argv.push("--index", String(a.index));
            if (a.noLabel) argv.push("--no-label");
            if (a.icon) argv.push("--icon", a.icon);
            return withValues(argv, a.values);
        }
    },
    {
        name: "eez_set",
        description:
            "Set properties of any object (widget, page, style object, variable, settings ...) by selector. For widgets you can also pass any of x/y/width/height (the others are kept).",
        inputSchema: obj(
            {
                selector: { type: "string" },
                values: { type: "object" },
                x: { type: ["number", "string"] },
                y: { type: ["number", "string"] },
                width: { type: ["number", "string"] },
                height: { type: ["number", "string"] }
            },
            ["selector"]
        ),
        toArgv: a => {
            const geometry = ["x", "y", "width", "height"].some(
                k => a[k] !== undefined
            );
            const argv = geometry
                ? ["widget", "set", a.selector]
                : ["obj", "set", a.selector];
            pushGeometry(argv, a);
            return withValues(argv, a.values);
        }
    },
    {
        name: "eez_style",
        description:
            'LVGL styling. target = widget selector (local style) or style name (shared LVGL style; created if \'forWidgetType\' is given). values = style properties, e.g. {"bg_color": "#3949AB", "radius": 8, "text_font": "MONTSERRAT_20"}. Use eez_run \'lvgl-style props\' to list properties.',
        inputSchema: obj(
            {
                target: { type: "string" },
                values: { type: "object" },
                part: { type: "string", description: "default MAIN" },
                state: {
                    type: "string",
                    description: "default DEFAULT, e.g. PRESSED, CHECKED"
                },
                forWidgetType: {
                    type: "string",
                    description:
                        "create a new shared style for this widget type"
                },
                apply: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "widget selectors that should use the shared style"
                }
            },
            ["target", "values"]
        ),
        toArgv: a => {
            const commands: string[][] = [];
            const isWidget =
                String(a.target).includes("/") ||
                String(a.target).startsWith("@");
            const common: string[] = [];
            if (a.part) common.push("--part", a.part);
            if (a.state) common.push("--state", a.state);
            if (isWidget) {
                commands.push([
                    "widget",
                    "style",
                    "set",
                    a.target,
                    ...common,
                    ...styleArgs(a.values)
                ]);
            } else if (a.forWidgetType) {
                commands.push([
                    "lvgl-style",
                    "add",
                    a.target,
                    "--for",
                    a.forWidgetType,
                    ...common,
                    ...styleArgs(a.values)
                ]);
            } else {
                commands.push([
                    "lvgl-style",
                    "set",
                    a.target,
                    ...common,
                    ...styleArgs(a.values)
                ]);
            }
            for (const widget of a.apply ?? []) {
                commands.push(["lvgl-style", "apply", widget, a.target]);
            }
            return commands;
        }
    },
    {
        name: "eez_remove",
        description:
            "Remove an object by selector (refused if referenced unless force).",
        inputSchema: obj(
            { selector: { type: "string" }, force: { type: "boolean" } },
            ["selector"]
        ),
        toArgv: a => ["obj", "rm", a.selector, ...(a.force ? ["--force"] : [])]
    },
    {
        name: "eez_apply",
        description:
            'Run many CLI commands as one transaction (one save). operations: array of command lines, e.g. ["page add Settings", "widget add Label --page Settings --name title text=Settings"].',
        inputSchema: obj(
            {
                operations: {
                    type: "array",
                    items: {
                        anyOf: [
                            { type: "string" },
                            { type: "array", items: { type: "string" } },
                            { type: "object" }
                        ]
                    }
                }
            },
            ["operations"]
        ),
        toArgv: a => ["apply", "--ops", JSON.stringify(a.operations ?? [])]
    },
    {
        name: "eez_check",
        description:
            "Check the project for errors and warnings (same checks as the GUI).",
        inputSchema: obj({ quick: { type: "boolean" } }),
        toArgv: a => ["check", ...(a.quick ? ["--quick"] : [])]
    },
    {
        name: "eez_build",
        description:
            "Build the project (generates the UI source code / assets).",
        inputSchema: obj({}),
        toArgv: () => ["build"]
    },
    {
        name: "eez_render",
        description:
            "Render a page to a PNG image and return it, so you can see the design. Also reports layout issues (overlaps, outside screen, overflow). Use bounds=true to draw widget boxes and names.",
        inputSchema: obj({
            page: {
                type: "string",
                description: "page or user widget name, default first page"
            },
            scale: { type: "number", description: "1-8, default 1" },
            bounds: { type: "boolean" },
            layout: {
                type: "boolean",
                description:
                    "include the computed position/size of every widget"
            },
            theme: { type: "string" },
            output: {
                type: "string",
                description:
                    "PNG file path (default <project>/.eez-render/<page>.png)"
            }
        }),
        toArgv: a => {
            const argv = ["render", "page", ...(a.page ? [a.page] : [])];
            if (a.scale) argv.push("--scale", String(a.scale));
            if (a.bounds) argv.push("--bounds");
            if (a.layout) argv.push("--layout");
            if (a.theme) argv.push("--theme", a.theme);
            if (a.output) argv.push("-o", a.output);
            return argv;
        }
    }
];

////////////////////////////////////////////////////////////////////////////////

function send(message: any) {
    host.writeStdout(JSON.stringify(message) + "\n");
}

// Keep tool results small: AI context is precious.
//  - read-only commands with a text rendering (help, schema, tree, info,
//    lists ...) return that text
//  - everything else returns compact JSON without empty/default fields
function compactResult(result: RunResult): any {
    const json = resultToJSON(result);
    const out: any = { ok: json.ok };
    if (json.error) {
        out.error = json.error;
    }
    const changes: string[] = json.changes ?? [];
    if (changes.length > 8) {
        out.changes = [
            ...changes.slice(0, 5),
            `... and ${changes.length - 5} more`
        ];
    } else if (changes.length > 0) {
        out.changes = changes;
    }
    if (json.saved) {
        out.saved = true;
    }
    if (json.dryRun) {
        out.dryRun = true;
    }
    if (json.newProblems) {
        out.newProblems = json.newProblems.map((p: any) => ({
            type: p.type,
            text: p.text,
            at: p.selector ?? p.where
        }));
    }
    if (json.notes) {
        out.notes = json.notes;
    }
    if (json.result !== undefined) {
        out.result = json.result;
    }
    if (json.files) {
        out.files = json.files;
    }
    return out;
}

function textResult(result: RunResult): string | undefined {
    if (
        !result.ok ||
        result.changes.length > 0 ||
        result.problems ||
        result.notes ||
        result.emitted.length == 0 ||
        result.emitted.some(e => e.text === undefined)
    ) {
        return undefined;
    }
    return resultToText(result).out.trimEnd();
}

function toolResult(results: RunResult[]) {
    const content: any[] = [];
    const texts = results.map(textResult);
    if (texts.every(text => text !== undefined)) {
        content.push({ type: "text", text: texts.join("\n\n") });
    } else {
        const json = results.map(compactResult);
        content.push({
            type: "text",
            text: JSON.stringify(json.length == 1 ? json[0] : json)
        });
    }
    for (const result of results) {
        for (const image of result.images) {
            content.push({
                type: "image",
                data: Buffer.from(image.data).toString("base64"),
                mimeType: image.mimeType
            });
        }
    }
    return {
        content,
        isError: results.some(result => !result.ok)
    };
}

async function callTool(runner: Runner, name: string, args: any) {
    const tool = TOOLS.find(t => t.name == name);
    if (!tool) {
        throw { code: -32602, message: `Unknown tool: ${name}` };
    }
    args = args ?? {};
    if (typeof args.project == "string" && args.project) {
        runner.defaults.project = args.project;
    }

    const argvs = tool.toArgv(args);
    const list: string[][] = Array.isArray(argvs[0])
        ? (argvs as string[][])
        : [argvs as string[]];

    const results: RunResult[] = [];
    for (const argv of list) {
        const result = await runner.execute(argv);
        results.push(result);
        if (!result.ok) {
            break;
        }
    }

    // remember the project opened/created by this call
    if (runner.session.filePath) {
        runner.defaults.project = runner.session.filePath;
    }

    return toolResult(results);
}

async function handle(runner: Runner, message: any) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    try {
        let result: any;
        switch (method) {
            case "initialize":
                result = {
                    protocolVersion:
                        params?.protocolVersion ?? PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "eez-studio", version: getVersion() },
                    instructions:
                        'EEZ Studio project designer. Before the first change in a session call eez_help with topic "guide" and follow it (design loop, apply batches, render checks, naming). Typical loop: eez_new_project or eez_open -> eez_add_widget / eez_style / eez_set -> eez_render (look at the image) -> fix -> eez_check -> eez_build. Use eez_help and eez_schema to discover commands and properties; eez_run accepts any CLI command. Naming convention (enforced, snake_case): widgets <type>_<name> (label_title, img_icon_home, btn_save), pages <name>_page (main_page), everything else <name>; see eez_help naming.'
                };
                break;
            case "ping":
                result = {};
                break;
            case "tools/list":
                result = {
                    tools: TOOLS.map(t => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema
                    }))
                };
                break;
            case "tools/call":
                result = await callTool(
                    runner,
                    params?.name,
                    params?.arguments
                );
                break;
            case "resources/list":
                result = { resources: [] };
                break;
            case "prompts/list":
                result = { prompts: [] };
                break;
            default:
                if (!isRequest) {
                    return; // notification (e.g. notifications/initialized)
                }
                throw { code: -32601, message: `Method not found: ${method}` };
        }
        if (isRequest) {
            send({ jsonrpc: "2.0", id, result });
        }
    } catch (err: any) {
        if (isRequest) {
            send({
                jsonrpc: "2.0",
                id,
                error: {
                    code: typeof err?.code == "number" ? err.code : -32603,
                    message: err?.message ?? String(err)
                }
            });
        }
    }
}

function getVersion() {
    try {
        return require("@electron/remote").app.getVersion();
    } catch (err) {
        return "unknown";
    }
}

export async function runMcpServer(runner: Runner, args: string[]) {
    const { opts } = runner.parse(args);
    if (typeof opts.project == "string") {
        runner.defaults.project = opts.project;
    }

    // requests are handled one at a time (the project model is not reentrant)
    let queue = Promise.resolve();

    await new Promise<void>(resolve => {
        host.onStdinLine(
            line => {
                const text = line.trim();
                if (!text) return;
                let message: any;
                try {
                    message = JSON.parse(text);
                } catch (err) {
                    send({
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32700, message: "Parse error" }
                    });
                    return;
                }
                const messages = Array.isArray(message) ? message : [message];
                for (const m of messages) {
                    queue = queue.then(() => handle(runner, m));
                }
            },
            () => {
                queue.then(() => resolve());
            }
        );
    });

    host.exit(EXIT_OK);
}
