import fs from "fs";
import os from "os";
import path from "path";

import { ProjectEditor } from "project-editor/project-editor-interface";
import { sourceRootDir } from "eez-studio-shared/util";

import { CommandDef } from "cli/registry";
import { CommandContext } from "cli/context";
import { CliError, UsageError } from "cli/errors";
import { describeObject, setProperties } from "cli/reflect";
import { table } from "cli/format";
import { fixNaming } from "cli/commands/naming";

////////////////////////////////////////////////////////////////////////////////

const LVGL_VERSIONS = ["8.4.0", "9.2.2", "9.3.0", "9.4.0", "9.5.0"];

// Project types of "project new". The templates in cli/templates are the
// templates of the GUI's "New Project" wizard (eez-project-templates repo).
const PROJECT_TYPES: {
    [type: string]: {
        projectType: string;
        flowSupport: boolean;
        description: string;
        template: (lvgl8: boolean) => string;
        officialTemplate: (lvgl8: boolean) => string;
        files?: string[];
    };
} = {
    lvgl: {
        projectType: "lvgl",
        flowSupport: false,
        description: "LVGL (generated C code, no EEZ Flow)",
        template: lvgl8 => `lvgl-${lvgl8 ? 8 : 9}.eez-project`,
        officialTemplate: lvgl8 => `templates/v0.23.0/LVGL-${lvgl8 ? "8.3" : "9.0"}.eez-project`
    },
    "lvgl-flow": {
        projectType: "lvgl",
        flowSupport: true,
        description: "LVGL with EEZ Flow",
        template: lvgl8 => `lvgl-flow-${lvgl8 ? 8 : 9}.eez-project`,
        officialTemplate: lvgl8 =>
            `templates/v0.23.0/LVGL with EEZ Flow-${lvgl8 ? "8.3" : "9.0"}.eez-project`
    },
    firmware: {
        projectType: "firmware",
        flowSupport: true,
        description: "EEZ-GUI firmware (with EEZ Flow)",
        template: () => "firmware.eez-project",
        officialTemplate: () => "templates/firmware.eez-project",
        files: ["Oswald-Medium.ttf"]
    },
    dashboard: {
        projectType: "dashboard",
        flowSupport: true,
        description: "Dashboard (runs in EEZ Studio)",
        template: () => "dashboard.eez-project",
        officialTemplate: () => "templates/dashboard.eez-project"
    },
    "eez-gui-lite": {
        projectType: "eez-gui-lite",
        flowSupport: true,
        description: "EEZ-GUI Lite",
        template: () => "eez-gui-lite.eez-project",
        officialTemplate: () => "templates/eez-gui-lite.eez-project",
        files: ["Oswald-Medium.ttf"]
    }
};

const OFFICIAL_TEMPLATES_URL =
    "https://raw.githubusercontent.com/eez-open/eez-project-templates/master/";

function bundledTemplatesDir() {
    return path.join(sourceRootDir(), "cli", "templates");
}

// feature keys needed besides the mandatory ones (for --empty projects)
const EXTRA_FEATURES: { [projectType: string]: string[] } = {
    lvgl: ["fonts", "bitmaps"],
    firmware: ["fonts", "bitmaps"],
    "eez-gui-lite": ["fonts", "bitmaps"],
    dashboard: ["fonts", "bitmaps"]
};

// features whose create() doesn't return a usable default
const FEATURE_DEFAULTS: { [key: string]: any } = {
    lvglStyles: { styles: [], defaultStyles: {} }
};

export function ensureFeature(ctx: CommandContext, key: string) {
    const project = ctx.project as any;
    if (project[key] !== undefined) {
        return project[key];
    }
    const feature = ProjectEditor.extensions.find(f => f.key == key);
    if (!feature) {
        throw new CliError(`Unknown project feature "${key}"`);
    }
    ctx.store.updateObject(project, {
        [key]: FEATURE_DEFAULTS[key] ?? feature.create()
    });
    ctx.changed(`enabled project feature "${key}"`);
    return project[key];
}

// minimal project without build files, pages have no widgets
function emptyProject(options: {
    type: string;
    lvglVersion: string;
    flowSupport: boolean;
    width: number;
    height: number;
    pageName: string;
}) {
    const general: any = {
        projectVersion: "v3",
        projectType: options.type,
        flowSupport: options.flowSupport,
        extensions: [],
        imports: []
    };

    if (options.type != "dashboard") {
        general.displayWidth = options.width;
        general.displayHeight = options.height;
    }

    if (options.type == "lvgl") {
        general.lvglVersion = options.lvglVersion;
    }

    const json: any = {
        settings: {
            general,
            build: {
                configurations: [{ name: "Default" }],
                files: [],
                destinationFolder: "src/ui"
            }
        },
        colors: [],
        themes: [{ name: "Default", colors: [] }]
    };

    if (options.type == "lvgl") {
        json.settings.build.generateSourceCodeForEezFramework = options.flowSupport;
    }

    for (const feature of ProjectEditor.extensions) {
        if (feature.mandatory || (EXTRA_FEATURES[options.type] ?? []).includes(feature.key)) {
            json[feature.key] = FEATURE_DEFAULTS[feature.key] ?? feature.create();
        }
    }

    json.userPages = [
        {
            name: options.pageName,
            left: 0,
            top: 0,
            width: options.type == "dashboard" ? 800 : options.width,
            height: options.type == "dashboard" ? 450 : options.height,
            components: []
        }
    ];

    if (options.type == "firmware" || options.type == "eez-gui-lite") {
        json.styles = [
            {
                name: "default",
                color: "#ffffff",
                backgroundColor: "#000000",
                alignHorizontal: "center",
                alignVertical: "center"
            }
        ];
    }

    return json;
}

async function readText(ctx: CommandContext, source: string) {
    if (/^https?:\/\//.test(source)) {
        const response = await fetch(source);
        if (!response.ok) {
            throw new CliError(`Failed to download ${source}: ${response.status} ${response.statusText}`);
        }
        return response.text();
    }
    const filePath = path.resolve(ctx.cwd, source);
    if (!fs.existsSync(filePath)) {
        throw new CliError(`Template not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, "utf8");
}

async function copyResource(source: string, destination: string) {
    if (fs.existsSync(destination)) {
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (/^https?:\/\//.test(source)) {
        const response = await fetch(source);
        if (!response.ok) {
            throw new CliError(`Failed to download ${source}: ${response.status}`);
        }
        fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    } else {
        fs.copyFileSync(source, destination);
    }
}

// Copy the staged new project into its folder. Other files (template fonts
// ...) are never overwritten, the project file itself is copied by the caller.
function copyStagedFiles(ctx: CommandContext, stagingDir: string, projectDir: string, skip?: string) {
    for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
        const source = path.join(stagingDir, entry.name);
        if (source == skip) {
            continue;
        }
        const destination = path.join(projectDir, entry.name);
        if (entry.isDirectory()) {
            copyStagedFiles(ctx, source, destination);
        } else {
            ctx.copyFile(source, destination);
        }
    }
}

// template widgets are placed for the template's display size (e.g. a
// "Hello, world!" label in the center of 800x480): keep their centers at the
// same relative position on the new display
function repositionTemplateWidgets(ctx: CommandContext, sx: number, sy: number) {
    for (const page of ctx.project.userPages) {
        const widgets: any[] = page.lvglScreenWidget
            ? page.lvglScreenWidget.children
            : page.components.filter(c => c instanceof ProjectEditor.WidgetClass);
        for (const widget of widgets) {
            const values: any = {};
            const width = widget.width ?? 0;
            const height = widget.height ?? 0;
            if ((widget.leftUnit ?? "px") == "px" && typeof widget.left == "number") {
                values.left = Math.max(0, Math.round((widget.left + width / 2) * sx - width / 2));
            }
            if ((widget.topUnit ?? "px") == "px" && typeof widget.top == "number") {
                values.top = Math.max(0, Math.round((widget.top + height / 2) * sy - height / 2));
            }
            if (Object.keys(values).length > 0) {
                ctx.store.updateObject(widget, values);
            }
        }
    }
}

async function addDefaultFont(ctx: CommandContext) {
    const fontFile = path.join(sourceRootDir(), "eez-studio-ui/_stylesheets/Roboto-Regular.ttf");
    if (!fs.existsSync(fontFile)) {
        return;
    }
    const nested = await ctx.runner.executeNested(
        ["font", "add", fontFile, "--name", "Roboto_24", "--size", "24"],
        ctx
    );
    ctx.changes.push(...nested.changes);
    const style = ctx.project.styles.find(s => s.name == "default");
    if (style) {
        ctx.store.updateObject(style, { font: "Roboto_24" });
    }
}

const newCommand: CommandDef = {
    name: "project new",
    aliases: ["new"],
    summary: "Create a new project (same templates as the GUI's New Project wizard)",
    usage: `project new <file.eez-project> [--type lvgl|lvgl-flow|firmware|dashboard|eez-gui-lite]
            [--lvgl 8.4.0|9.2.2|9.3.0|9.4.0|9.5.0] [--size WxH]
            [--template official|<file|url>] [--empty [--page Main]] [--force]
  default: --type lvgl --lvgl 9.2.2, display size of the template (LVGL 800x480)
  --template official  download the newest template from github (eez-project-templates)
  --template <file>    start from any .eez-project file or URL
  --empty              minimal project without build files (build generates no UI source)
  --force              overwrite an existing file`,
    booleans: ["empty"],
    project: "none",
    // writes the project file, can't be rolled back by "apply"
    standalone: true,
    group: "project",
    async run(ctx) {
        let file = ctx.arg(0, "file");
        if (!file.endsWith(".eez-project")) {
            file += ".eez-project";
        }
        const filePath = path.resolve(ctx.cwd, file);
        if (fs.existsSync(filePath) && !ctx.force) {
            throw new CliError(`File already exists: ${filePath}`, "pass --force to overwrite");
        }
        const projectDir = path.dirname(filePath);

        const typeName = ctx.str("type", "lvgl")!;
        const type = PROJECT_TYPES[typeName];
        if (!type) {
            throw new UsageError(
                `unknown project type "${typeName}"`,
                `types: ${Object.keys(PROJECT_TYPES).join(", ")}`
            );
        }

        const lvglVersion = ctx.str("lvgl", "9.2.2")!;
        if (!LVGL_VERSIONS.includes(lvglVersion)) {
            throw new UsageError(
                `unsupported LVGL version "${lvglVersion}"`,
                `versions: ${LVGL_VERSIONS.join(", ")}`
            );
        }
        const lvgl8 = lvglVersion.startsWith("8.");

        const size = ctx.pair("size");

        let json: any;
        let resources: { source: string; name: string }[] = [];
        const template = ctx.str("template");
        if (ctx.flag("empty")) {
            json = emptyProject({
                type: type.projectType,
                flowSupport: type.flowSupport,
                lvglVersion,
                width: size?.[0] ?? 480,
                height: size?.[1] ?? 272,
                pageName: ctx.str("page", "Main")!
            });
        } else {
            let source: string;
            let resourceBase: string | undefined;
            if (template == "official") {
                source = OFFICIAL_TEMPLATES_URL + encodeURI(type.officialTemplate(lvgl8));
                resourceBase = OFFICIAL_TEMPLATES_URL + "templates/";
            } else if (template) {
                source = template;
            } else {
                source = path.join(bundledTemplatesDir(), type.template(lvgl8));
                resourceBase = bundledTemplatesDir() + path.sep;
            }

            try {
                json = JSON.parse(await readText(ctx, source));
            } catch (err) {
                if (err instanceof CliError) throw err;
                throw new CliError("Template is not a valid .eez-project file");
            }

            // like the wizard: set project version and LVGL version
            json.settings = json.settings ?? {};
            json.settings.general = json.settings.general ?? {};
            json.settings.general.projectVersion = "v3";
            if (json.settings.general.projectType == "lvgl" && (!template || template == "official" || ctx.str("lvgl"))) {
                json.settings.general.lvglVersion = lvglVersion;
            }

            // resource files used by the template (fonts ...)
            if (resourceBase && type.files) {
                resources = type.files.map(name => ({ source: resourceBase + name, name }));
            }
        }

        // The project is created in a staging folder and copied to its
        // destination only when every step succeeded, so nothing is written
        // with --dry-run or when a step fails.
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "eez-cli-new-"));
        const stagingFilePath = path.join(stagingDir, path.basename(filePath));
        let general, display, pages, errors;
        try {
            for (const resource of resources) {
                await copyResource(resource.source, path.join(stagingDir, resource.name));
            }
            fs.writeFileSync(stagingFilePath, JSON.stringify(json, undefined, 2), "utf8");

            // load it with the project model
            await ctx.session.open(stagingFilePath);

            // display size (pages and LVGL screens follow)
            if (size && type.projectType != "dashboard") {
                const oldWidth = ctx.project.settings.general.displayWidth;
                const oldHeight = ctx.project.settings.general.displayHeight;
                const nested = await ctx.runner.executeNested(
                    ["project", "set", `displayWidth=${size[0]}`, `displayHeight=${size[1]}`],
                    ctx
                );
                ctx.changes.push(...nested.changes);
                if (oldWidth && oldHeight) {
                    repositionTemplateWidgets(ctx, size[0] / oldWidth, size[1] / oldHeight);
                }
            }

            // EEZ-GUI styles need a font
            if (ctx.flag("empty") && (type.projectType == "firmware" || type.projectType == "eez-gui-lite")) {
                await addDefaultFont(ctx);
            }

            // template names follow the naming convention too (Main -> main_page)
            fixNaming(ctx);

            await ctx.session.save({ backup: false });

            general = ctx.project.settings.general;
            display =
                type.projectType == "dashboard"
                    ? `${ctx.project.userPages[0]?.width}x${ctx.project.userPages[0]?.height}`
                    : `${general.displayWidth}x${general.displayHeight}`;
            pages = ctx.project.userPages.map(page => page.name);
            errors = ctx.session.check().filter(p => p.type == "error").length;

            ctx.session.close();

            if (!ctx.flag("dry-run")) {
                ctx.createDirectory(projectDir);
                copyStagedFiles(ctx, stagingDir, projectDir, stagingFilePath);
                fs.copyFileSync(stagingFilePath, filePath);
                await ctx.session.open(filePath);
                ctx.runner.defaults.project = filePath;
                ctx.saved = true;
            }
        } finally {
            if (ctx.session.filePath == stagingFilePath) {
                ctx.session.close();
            }
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        ctx.changed(`created ${filePath}`);
        ctx.emit(
            {
                project: filePath,
                type: typeName,
                lvglVersion: type.projectType == "lvgl" ? general.lvglVersion : undefined,
                display,
                pages: pages.map(page => `page:${page}`),
                errors
            },
            `created ${filePath} (${type.description}${
                type.projectType == "lvgl" ? ", LVGL " + general.lvglVersion : ""
            }, ${display}, pages: ${pages.join(", ")})`
        );
    }
};

const typesCommand: CommandDef = {
    name: "project types",
    summary: "List project types for 'project new'",
    usage: "project types",
    project: "none",
    group: "project",
    run(ctx) {
        ctx.emit(
            Object.entries(PROJECT_TYPES).map(([name, t]) => ({
                name,
                projectType: t.projectType,
                flowSupport: t.flowSupport,
                description: t.description
            })),
            table(
                Object.entries(PROJECT_TYPES).map(([name, t]) => [name, t.description]),
                ["type", "description"]
            ) + `\n\nLVGL versions: ${LVGL_VERSIONS.join(", ")}`
        );
    }
};

const settingsCommand: CommandDef = {
    name: "project settings",
    aliases: ["settings"],
    summary: "Show project settings (general and build)",
    usage: "project settings [general|build]",
    group: "project",
    run(ctx) {
        const section = ctx.argOpt(0);
        const settings = ctx.project.settings;
        if (section == "general" || section == "build") {
            ctx.emit(describeObject(settings[section], { depth: 1 }));
        } else {
            ctx.emit({
                general: describeObject(settings.general, { depth: 0 }),
                build: describeObject(settings.build, { depth: 0 })
            });
        }
    }
};

const setCommand: CommandDef = {
    name: "project set",
    summary: "Change project settings",
    usage: `project set [general|build] key=value [key=value ...]
  e.g.  project set displayWidth=800 displayHeight=480   (pages and screens follow)
        project set build destinationFolder=src/ui
  (section defaults to general; build keys are detected automatically)`,
    mutating: true,
    group: "project",
    run(ctx) {
        const settings = ctx.project.settings;
        let from = 0;
        let section = ctx.argOpt(0);
        if (section == "general" || section == "build") {
            from = 1;
        } else {
            section = undefined;
        }
        const values = ctx.values(from);
        if (Object.keys(values).length == 0) {
            ctx.usage("nothing to set");
        }

        const general: any = {};
        const build: any = {};
        const has = (object: any, key: string) =>
            object.constructor.classInfo.properties.some((p: any) => p.name == key.split(".")[0]);
        for (const key of Object.keys(values)) {
            const target =
                section ??
                (has(settings.build, key) && !has(settings.general, key) ? "build" : "general");
            (target == "build" ? build : general)[key] = values[key];
        }
        if (Object.keys(general).length) {
            setProperties(ctx.store, settings.general, general, { force: ctx.force });
        }
        if (Object.keys(build).length) {
            setProperties(ctx.store, settings.build, build, { force: ctx.force });
        }

        // keep page/screen sizes in sync when the display size changes
        if (general.displayWidth !== undefined || general.displayHeight !== undefined) {
            const width = settings.general.displayWidth;
            const height = settings.general.displayHeight;
            for (const page of ctx.project.userPages) {
                setProperties(ctx.store, page, { width, height });
                if (page.lvglScreenWidget) {
                    setProperties(ctx.store, page.lvglScreenWidget, { width, height });
                }
            }
        }

        ctx.changed(`set settings: ${Object.keys(values).join(", ")}`);
    }
};

const featuresCommand: CommandDef = {
    name: "project features",
    summary: "List project features (fonts, bitmaps, texts, scpi ...) and whether enabled",
    usage: "project features",
    group: "project",
    run(ctx) {
        const project = ctx.project as any;
        const rows = ProjectEditor.extensions.map(f => ({
            key: f.key,
            name: f.displayName ?? f.name,
            enabled: project[f.key] !== undefined,
            mandatory: f.mandatory
        }));
        ctx.emit(
            rows,
            table(
                rows.map(r => [r.key, r.enabled ? "yes" : "no", r.mandatory ? "mandatory" : ""]),
                ["feature", "enabled", ""]
            )
        );
    }
};

const featureAddCommand: CommandDef = {
    name: "project feature add",
    summary: "Enable a project feature (e.g. texts for multi-language, scpi)",
    usage: "project feature add <key>",
    mutating: true,
    group: "project",
    run(ctx) {
        const key = ctx.arg(0, "key");
        if ((ctx.project as any)[key] !== undefined) {
            throw new CliError(`Feature "${key}" is already enabled`);
        }
        ensureFeature(ctx, key);
    }
};

export const projectCommands: CommandDef[] = [
    newCommand,
    typesCommand,
    settingsCommand,
    setCommand,
    featuresCommand,
    featureAddCommand
];
