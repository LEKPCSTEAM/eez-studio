import { ProjectEditor } from "project-editor/project-editor-interface";
import { Section } from "project-editor/store";

import { CommandDef, getCommands, findCommandsWithPrefix } from "cli/registry";
import { flattenMessages, formatProblem, Problem } from "cli/messages";
import { CliError, EXIT_ERROR } from "cli/errors";
import { COLLECTIONS, allPageWidgets, selectorOf } from "cli/selectors";
import { table } from "cli/format";
import { CommandContext } from "cli/context";
import { namingProblems } from "cli/commands/naming";

////////////////////////////////////////////////////////////////////////////////

const HELP_TOPICS: { [topic: string]: string } = {
    selectors: `Selectors address any object in the project:

  project                      the project root
  settings/general             project settings (settings/build, ...)
  page:main_page               a page (also: userWidget:, action:, var:, struct:, enum:,
                               style:, lvglStyle:, font:, bitmap:, color:, theme:, group:,
                               config:, language:, text:, extension:, scpiSubsystem:)
  page:main_page/btn_ok        widget by identifier/name (depth first search in page)
  page:main_page/btn_ok/[0]    widget inside widget
  page:main_page/[0]/[1]       widget by child index
  page:main_page/$screen       LVGL screen (root) widget of a page
  main_page/btn_ok             pages and user widgets can omit "page:"
  @6f2b...                     object by objID
  /userPages/0/components/1    object path from the project root
  <selector>#eventHandlers/0   walk object/array properties from an object

Every command that returns objects reports their "$selector" and "$path".`,

    values: `Property values on the command line are strings, converted to the
property type: numbers, booleans (true/false), enums (checked against allowed
values), object references (checked to exist, e.g. a font or style name).
Object/Array properties take JSON. Use --values '{"k": ...}' to pass typed JSON.
Use "schema class <Class>" or "obj props <selector>" to see property types.`,

    workflow: `Typical AI design loop:

  eez-cli project new ui.eez-project --type lvgl --lvgl 9.2.2 --size 480x272
  eez-cli -p ui.eez-project widget types
  eez-cli -p ui.eez-project widget add Button --page main_page --name btn_ok --at 20,20 --size 120,50
  eez-cli -p ui.eez-project widget set page:main_page/btn_ok/[0] text=OK
  eez-cli -p ui.eez-project render page main_page -o main.png --bounds
  eez-cli -p ui.eez-project check
  eez-cli -p ui.eez-project build

Names: widgets <type>_<name> (label_title, img_icon_home), pages <name>_page,
everything snake_case ("eez-cli naming"). Batch many changes with
"apply <file.json>" (one transaction, one save).
Global options: -p <project>, --json, --dry-run, --force, --no-backup, --no-reload-gui`
};

function helpCommand(): CommandDef {
    return {
        name: "help",
        summary: "List commands, or show help for a command or topic",
        usage: "help [command...|selectors|values|workflow]",
        project: "none",
        group: "general",
        run(ctx) {
            const words = ctx.args;
            if (words.length == 0) {
                const groups = new Map<string, CommandDef[]>();
                for (const command of getCommands()) {
                    const group = command.group ?? command.name.split(" ")[0];
                    if (!groups.has(group)) {
                        groups.set(group, []);
                    }
                    groups.get(group)!.push(command);
                }
                let text =
                    "EEZ Studio command line\n\nusage: eez-cli [-p project] <command> [args] [--json] [--dry-run]\n";
                const data: any = {};
                for (const [group, commands] of groups) {
                    text += `\n${group}:\n`;
                    text += table(
                        commands.map(c => ["  " + c.name, c.summary])
                    );
                    text += "\n";
                    data[group] = commands.map(c => ({
                        name: c.name,
                        summary: c.summary,
                        usage: c.usage
                    }));
                }
                text += `\nhelp topics: ${Object.keys(HELP_TOPICS).join(
                    ", "
                )}   (eez-cli help <topic>)\n`;
                ctx.emit(data, text);
                return;
            }

            const topic = HELP_TOPICS[words[0]];
            if (topic && words.length == 1) {
                ctx.emit({ topic: words[0], text: topic }, topic);
                return;
            }

            const commands = findCommandsWithPrefix(words);
            if (commands.length == 0) {
                throw new CliError(`No help for "${words.join(" ")}"`);
            }
            ctx.emit(
                commands.map(c => ({
                    name: c.name,
                    summary: c.summary,
                    usage: c.usage
                })),
                commands
                    .map(c => `${c.name} — ${c.summary}\n\n${c.usage}`)
                    .join("\n\n----\n\n")
            );
        }
    };
}

////////////////////////////////////////////////////////////////////////////////

function infoCommand(): CommandDef {
    return {
        name: "info",
        aliases: ["project info"],
        summary: "Project overview: type, display, collections, pages",
        usage: "info",
        group: "project",
        run(ctx) {
            const project = ctx.project;
            const general = project.settings.general;
            const traits = project.projectTypeTraits;

            const collections: { [name: string]: number } = {};
            for (const collection of COLLECTIONS) {
                const items = collection.get(project);
                if (items && items.length > 0) {
                    collections[collection.kinds[0]] = items.length;
                }
            }

            const pages = [
                ...(project.userPages ?? []),
                ...(project.userWidgets ?? [])
            ].map(page => ({
                selector: selectorOf(page),
                size: `${page.width}x${page.height}`,
                widgets: allPageWidgets(page).length,
                flowComponents: page.components.filter(
                    (c: any) => !(c instanceof ProjectEditor.WidgetClass)
                ).length
            }));

            const data = {
                file: ctx.session.filePath,
                projectType: general.projectType,
                lvglVersion: traits.isLVGL ? general.lvglVersion : undefined,
                flowSupport: general.flowSupport,
                display: traits.hasDisplaySizeProperty
                    ? `${general.displayWidth}x${general.displayHeight}`
                    : undefined,
                darkTheme: general.darkTheme || undefined,
                colorBpp: (general as any).colorBpp,
                buildDestinationFolder:
                    project.settings.build.destinationFolder,
                collections,
                pages
            };

            let text = table(
                [
                    ["file", data.file],
                    ["type", data.projectType],
                    data.lvglVersion ? ["lvgl", data.lvglVersion] : undefined,
                    ["flow support", data.flowSupport ? "yes" : "no"],
                    data.display ? ["display", data.display] : undefined,
                    data.colorBpp ? ["color bpp", data.colorBpp] : undefined,
                    ["build folder", data.buildDestinationFolder ?? "."]
                ].filter(Boolean) as any[]
            );
            text +=
                "\n\ncollections: " +
                Object.entries(collections)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ");
            text +=
                "\n\n" +
                table(
                    pages.map(p => [
                        p.selector,
                        p.size,
                        `${p.widgets} widgets`,
                        p.flowComponents ? `${p.flowComponents} flow` : ""
                    ]),
                    ["page", "size", "widgets", ""]
                );

            ctx.emit(data, text);
        }
    };
}

////////////////////////////////////////////////////////////////////////////////

function reportProblems(ctx: CommandContext, problems: Problem[], title: string) {
    const errors = problems.filter(p => p.type == "error");
    const warnings = problems.filter(p => p.type == "warning");

    const text =
        problems.map(formatProblem).join("\n") +
        (problems.length > 0 ? "\n\n" : "") +
        `${title}: ${errors.length} error(s), ${warnings.length} warning(s)`;

    ctx.emit(
        {
            errors: errors.length,
            warnings: warnings.length,
            problems
        },
        text
    );

    const strict = ctx.flag("strict");
    if (errors.length > 0 || (strict && warnings.length > 0)) {
        throw new CliError(
            `${title} failed: ${errors.length} error(s), ${warnings.length} warning(s)`,
            undefined,
            EXIT_ERROR
        );
    }
}

function checkCommand(): CommandDef {
    return {
        name: "check",
        aliases: ["validate"],
        summary: "Check the project for errors (same checks as the GUI)",
        usage: "check [--quick] [--strict]\n  --quick   only object checks, skip the asset build check\n  --strict  fail on warnings too",
        booleans: ["quick"],
        group: "project",
        async run(ctx) {
            const problems = ctx.flag("quick")
                ? ctx.session.check()
                : await ctx.session.fullCheck();
            // naming convention violations are warnings
            problems.push(...namingProblems(ctx.project));
            reportProblems(ctx, problems, "check");
        }
    };
}

function buildCommand(): CommandDef {
    return {
        name: "build",
        summary: "Build the project (generate source files / assets)",
        usage: "build [--strict]",
        group: "project",
        async run(ctx) {
            const store = ctx.store;

            if (store.projectTypeTraits.isIEXT) {
                const files = await ProjectEditor.build.buildExtensions(store);
                ctx.files.push(...(files ?? []));
            } else {
                await ProjectEditor.build.buildProject(store, "buildFiles");
            }

            const section = store.outputSectionsStore.getSection(
                Section.OUTPUT
            );
            const all = flattenMessages(section.messages.messages);
            const infos = all.filter(p => p.type == "info");
            const problems = all.filter(p => p.type != "info");

            ctx.emit(
                { log: infos.map(p => p.text) },
                infos.map(p => p.text).join("\n")
            );

            reportProblems(ctx, problems, "build");
        }
    };
}

function reloadGuiCommand(): CommandDef {
    return {
        name: "reload-gui",
        summary: "Ask a running EEZ Studio to reload this project from disk",
        usage: "reload-gui",
        group: "project",
        run(ctx) {
            ctx.session.notifyGui();
            ctx.emit({ requested: ctx.session.filePath }, "reload requested");
        }
    };
}

function openCommand(): CommandDef {
    return {
        name: "open",
        summary: "Open a project (repl/MCP: following commands use it)",
        usage: "open <file.eez-project>",
        project: "none",
        group: "project",
        async run(ctx) {
            const file = ctx.arg(0, "file");
            await ctx.session.open(file);
            ctx.runner.defaults.project = ctx.session.filePath!;
            ctx.emit(
                { project: ctx.session.filePath },
                `opened ${ctx.session.filePath}`
            );
        }
    };
}

// handled by the launcher (eez-cli.js); listed here for "help"
function daemonCommand(): CommandDef {
    return {
        name: "daemon",
        summary: "Keep EEZ Studio loaded in the background: repeated commands take milliseconds",
        usage: `daemon start [--idle minutes] | daemon status | daemon stop
  handled by the eez-cli launcher; afterwards every "eez-cli <command>" is sent
  to the daemon (except repl, mcp and commands reading stdin).
  EEZ_CLI_DAEMON=auto starts it on first use, EEZ_CLI_DAEMON=off bypasses it.`,
        project: "none",
        group: "general",
        run(ctx) {
            ctx.usage("run this through the eez-cli launcher");
        }
    };
}

export const coreCommands: CommandDef[] = [
    daemonCommand(),
    helpCommand(),
    infoCommand(),
    checkCommand(),
    buildCommand(),
    openCommand(),
    reloadGuiCommand()
];
