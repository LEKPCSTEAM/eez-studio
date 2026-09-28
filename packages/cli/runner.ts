// Executes one command line against a session. Used by the one-shot CLI,
// the repl, "apply" (nested) and the MCP server.

import { parseArgs, GLOBAL_BOOLEAN_OPTIONS, OptionValue } from "cli/args";
import { CliError, UsageError, EXIT_OK, EXIT_ERROR, errorToString } from "cli/errors";
import { CommandContext, Emitted } from "cli/context";
import { findCommand, CommandDef, getCommands } from "cli/registry";
import { CliSession, findProjectFile } from "cli/session";
import { Problem, formatProblem } from "cli/messages";
import { takeNamingNotes } from "cli/naming";

export interface RunResult {
    ok: boolean;
    exitCode: number;
    command?: string;
    project?: string;
    changes: string[];
    saved: boolean;
    dryRun: boolean;
    result?: any;
    files?: string[];
    error?: { message: string; hint?: string; problems?: Problem[] };
    // errors introduced by this change (saved anyway, unless --strict)
    problems?: Problem[];
    // names corrected by the naming convention
    notes?: string[];
    // not serialized
    emitted: Emitted[];
    images: { data: Uint8Array; mimeType: string }[];
    json: boolean;
}


// options a nested command ("apply", commands calling other commands)
// inherits from its parent; command specific options are not inherited
const INHERITED_OPTIONS = [
    "project",
    "force",
    "strict",
    "dry-run",
    "no-backup",
    "no-reload-gui"
];

function inheritedOptions(opts: { [name: string]: OptionValue }) {
    const result: { [name: string]: OptionValue } = {};
    for (const name of INHERITED_OPTIONS) {
        if (opts[name] !== undefined) {
            result[name] = opts[name];
        }
    }
    return result;
}

export class Runner {
    // global options applied to every command (e.g. --project from the MCP server)
    defaults: { [name: string]: OptionValue } = {};

    // daemon: every request finds its project from its own -p / cwd (the
    // loaded project is reused when it is the same file)
    stateless = false;

    constructor(public session: CliSession) {}

    // options are parsed twice: first to find the command, then with the
    // command's own boolean options (so "--flag value" is unambiguous)
    parse(argv: string[]) {
        const first = parseArgs(argv, GLOBAL_BOOLEAN_OPTIONS);
        const found = findCommand(first.args);
        const booleans = new Set(GLOBAL_BOOLEAN_OPTIONS);
        found?.command.booleans?.forEach(name => booleans.add(name));
        const { args, opts } = parseArgs(argv, booleans);
        return { args, opts: { ...this.defaults, ...opts } };
    }

    resolveCommand(args: string[]) {
        const found = findCommand(args);
        if (!found) {
            const name = args[0];
            if (!name) {
                throw new UsageError(
                    "missing command",
                    'run "help" to list commands'
                );
            }
            const similar = getCommands()
                .map(c => c.name)
                .filter(n => n.split(" ")[0] == name);
            throw new UsageError(
                `unknown command "${args.slice(0, 2).join(" ")}"`,
                similar.length > 0
                    ? `did you mean: ${similar.join(", ")}`
                    : 'run "help" to list commands'
            );
        }
        return found;
    }

    async openProjectFor(command: CommandDef, opts: { [name: string]: OptionValue }) {
        if (command.project == "none") {
            // still open the project if one was given explicitly
            if (typeof opts.project == "string") {
                await this.ensureProject(opts.project);
            }
            return;
        }

        const explicit =
            typeof opts.project == "string" ? opts.project : undefined;

        if (!explicit && this.session.store && !this.stateless) {
            await this.session.ensureFresh();
            return;
        }

        await this.ensureProject(explicit);
    }

    async ensureProject(explicit?: string) {
        const filePath = findProjectFile(this.session.cwd, explicit);
        if (
            this.session.store &&
            this.session.filePath &&
            this.session.filePath.toLowerCase() == filePath.toLowerCase()
        ) {
            await this.session.ensureFresh();
            return;
        }
        await this.session.open(filePath);
    }

    // run a command inside another command's transaction ("apply")
    async executeNested(argv: string[], parent: CommandContext) {
        const { args, opts } = this.parse(argv);
        const { command, consumed } = this.resolveCommand(args);
        if (command.project != "none" || command.mutating) {
            // nested commands always use the parent's project
        }
        if (command.name == "apply") {
            throw new UsageError("apply can't be nested");
        }
        const ctx = new CommandContext(
            command,
            this.session,
            this,
            args.slice(consumed),
            { ...inheritedOptions(parent.opts), ...opts }
        );
        await command.run(ctx);
        return ctx;
    }

    async execute(argv: string[]): Promise<RunResult> {
        const result: RunResult = {
            ok: false,
            exitCode: EXIT_ERROR,
            changes: [],
            saved: false,
            dryRun: false,
            emitted: [],
            images: [],
            json: false
        };

        takeNamingNotes();

        let ctx: CommandContext | undefined;
        let revisionBefore: symbol | undefined;
        let mutating = false;

        try {
            const { args, opts } = this.parse(argv);
            result.json = opts.json === true;
            result.dryRun = opts["dry-run"] === true;

            const { command, consumed } = this.resolveCommand(args);
            result.command = command.name;

            ctx = new CommandContext(
                command,
                this.session,
                this,
                args.slice(consumed),
                opts
            );

            if (opts.help === true) {
                ctx.emit({ usage: command.usage }, command.usage);
                result.ok = true;
                result.exitCode = EXIT_OK;
                result.emitted = ctx.emitted;
                return result;
            }

            await this.openProjectFor(command, opts);

            mutating = !!command.mutating;

            let errorsBefore: Problem[] = [];
            if (mutating && this.session.store) {
                errorsBefore = this.session
                    .check()
                    .filter(problem => problem.type == "error");
                revisionBefore = this.session.revision;
            }

            await command.run(ctx);

            result.project = this.session.filePath;

            const changed =
                mutating &&
                this.session.store != undefined &&
                (this.session.revision !== revisionBefore || ctx.modified);

            if (changed) {
                const introduced = this.session.newErrors(errorsBefore);
                if (introduced.length > 0) {
                    if (opts.strict === true && !ctx.force) {
                        await this.session.reload();
                        throw new CliError(
                            "Refusing to save (--strict): the change introduces errors",
                            "fix the values, or pass --force to save anyway",
                            EXIT_ERROR,
                            introduced
                        );
                    }
                    // saved anyway (intermediate states are normal while
                    // building a design), but reported
                    result.problems = introduced;
                }

                if (result.dryRun) {
                    await this.session.reload();
                } else {
                    await this.session.save({
                        backup: opts["no-backup"] !== true
                    });
                    result.saved = true;
                    if (opts["no-reload-gui"] !== true) {
                        this.session.notifyGui();
                    }
                }
            }

            if (ctx.saved) {
                result.saved = true;
            }

            result.ok = true;
            result.exitCode = EXIT_OK;
        } catch (err) {
            // discard partial in-memory changes
            if (
                mutating &&
                this.session.store &&
                revisionBefore !== undefined &&
                (this.session.revision !== revisionBefore || ctx?.modified)
            ) {
                try {
                    await this.session.reload();
                } catch (reloadErr) {}
            }

            if (err instanceof CliError) {
                result.exitCode = err.exitCode;
                result.error = {
                    message: err.message,
                    hint: err.hint,
                    problems: Array.isArray(err.details) ? err.details : undefined
                };
            } else {
                result.exitCode = EXIT_ERROR;
                result.error = {
                    message: "Internal error: " + errorToString(err),
                    hint: (err as any)?.stack
                        ?.split("\n")
                        .slice(1, 4)
                        .join(" | ")
                };
            }
        }

        const notes = takeNamingNotes();
        if (result.ok && notes.length > 0) {
            result.notes = notes;
        }

        if (ctx) {
            // nothing is saved when a command fails
            result.changes = result.ok ? ctx.changes : [];
            result.emitted = ctx.emitted;
            result.images = ctx.images;
            if (ctx.files.length > 0) {
                result.files = ctx.files;
            }
            if (ctx.emitted.length == 1) {
                result.result = ctx.emitted[0].data;
            } else if (ctx.emitted.length > 1) {
                result.result = ctx.emitted.map(e => e.data);
            }
        }

        return result;
    }
}

////////////////////////////////////////////////////////////////////////////////

export function resultToJSON(result: RunResult) {
    const json: any = {
        ok: result.ok,
        command: result.command,
        project: result.project,
        changes: result.changes,
        saved: result.saved
    };
    if (result.dryRun) {
        json.dryRun = true;
    }
    if (result.result !== undefined) {
        json.result = result.result;
    }
    if (result.files) {
        json.files = result.files;
    }
    if (result.problems) {
        json.newProblems = result.problems;
    }
    if (result.notes) {
        json.notes = result.notes;
    }
    if (result.error) {
        json.error = result.error;
    }
    return json;
}

export function resultToText(result: RunResult): { out: string; err: string } {
    let out = "";
    let err = "";

    for (const emitted of result.emitted) {
        const text =
            emitted.text !== undefined
                ? emitted.text
                : typeof emitted.data == "string"
                ? emitted.data
                : JSON.stringify(emitted.data, null, 2);
        if (text.length > 0) {
            out += text + (text.endsWith("\n") ? "" : "\n");
        }
    }

    // a failed command saved nothing: its partial changes would only confuse
    if (result.ok) {
        for (const change of result.changes) {
            err += `${result.dryRun ? "(dry run) " : ""}${change}\n`;
        }
    }

    if (result.saved) {
        err += `saved ${result.project}\n`;
    }

    for (const note of result.notes ?? []) {
        err += `note: ${note}\n`;
    }

    if (result.problems) {
        err += `note: this change introduced ${result.problems.length} problem(s) (saved anyway; fix them now or later):\n`;
        for (const problem of result.problems) {
            err += `  ${formatProblem(problem)}\n`;
        }
    }

    if (result.error) {
        err += `eez-cli: ${result.error.message}\n`;
        if (result.error.problems) {
            for (const problem of result.error.problems) {
                err += `  ${formatProblem(problem)}\n`;
            }
        }
        if (result.error.hint) {
            err += `  hint: ${result.error.hint}\n`;
        }
    }

    return { out, err };
}
