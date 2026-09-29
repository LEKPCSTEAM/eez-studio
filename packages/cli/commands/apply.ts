// Batch: many commands, one transaction, one save.

import fs from "fs";
import path from "path";

import { CommandDef } from "cli/registry";
import { CliError, UsageError, errorToString } from "cli/errors";
import { splitCommandLine } from "cli/args";
import { readStdinAll } from "cli/host";
import type { CommandContext } from "cli/context";

type Operation = string | string[] | { cmd: string; args?: string[]; opts?: { [name: string]: any } };

function toArgv(op: Operation): string[] {
    if (typeof op == "string") {
        return splitCommandLine(op);
    }
    if (Array.isArray(op)) {
        return op.map(String);
    }
    if (op && typeof op == "object" && typeof op.cmd == "string") {
        const argv = [...splitCommandLine(op.cmd), ...(op.args ?? []).map(String)];
        for (const [name, value] of Object.entries(op.opts ?? {})) {
            const values = Array.isArray(value) ? value : [value];
            for (const v of values) {
                if (v === true) {
                    argv.push(`--${name}`);
                } else if (v === false) {
                    argv.push(`--no-${name}`);
                } else if (typeof v == "object") {
                    argv.push(`--${name}=${JSON.stringify(v)}`);
                } else {
                    argv.push(`--${name}=${v}`);
                }
            }
        }
        return argv;
    }
    throw new UsageError(`invalid operation: ${JSON.stringify(op)}`);
}

export function parseOperations(text: string): Operation[] {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        let parsed: any;
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            throw new UsageError(`invalid JSON: ${errorToString(err)}`);
        }
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (Array.isArray(parsed.ops)) {
            return parsed.ops;
        }
        throw new UsageError('expected a JSON array of operations (or {"ops": [...]})');
    }
    // plain text: one command per line, # comments
    return trimmed
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith("#"));
}

export async function runOperations(ctx: CommandContext, operations: Operation[]) {
    const results: any[] = [];
    for (let i = 0; i < operations.length; i++) {
        const argv = toArgv(operations[i]);
        if (argv.length == 0) {
            continue;
        }
        let nested;
        try {
            nested = await ctx.runner.executeNested(argv, ctx);
        } catch (err: any) {
            const error = err instanceof CliError ? err : new CliError(errorToString(err));
            throw new CliError(
                `operation ${i + 1} failed (${argv.join(" ")}): ${error.message}`,
                error.hint ?? "nothing was saved",
                error.exitCode,
                error.details
            );
        }
        ctx.changes.push(...nested.changes);
        ctx.files.push(...nested.files);
        ctx.images.push(...nested.images);
        if (nested.modified) {
            ctx.markModified();
        }
        results.push({
            op: argv.join(" "),
            result:
                nested.emitted.length == 1
                    ? nested.emitted[0].data
                    : nested.emitted.map(e => e.data)
        });
    }
    return results;
}

const applyCommand: CommandDef = {
    name: "apply",
    summary: "Run many commands as one transaction (one check, one save)",
    usage: `apply <file.json|file.txt|->
  JSON: ["page add Settings", ["widget", "add", "Label", "--page", "Settings"],
         {"cmd": "widget add", "args": ["Button"], "opts": {"page": "Main", "name": "btnOk"}}]
  text: one command per line, # starts a comment
  "-" reads the operations from stdin. If any operation fails nothing is saved.
  --verbose  include the result of every operation`,
    mutating: true,
    group: "general",
    async run(ctx) {
        const inline = ctx.str("ops");
        const source = inline !== undefined ? undefined : ctx.arg(0, "file|-");
        let text: string;
        if (inline !== undefined) {
            text = inline;
        } else if (source == "-") {
            text = await readStdinAll();
        } else {
            const file = path.resolve(ctx.cwd, source!);
            if (!fs.existsSync(file)) {
                throw new CliError(`File not found: ${file}`);
            }
            text = fs.readFileSync(file, "utf8");
        }
        const operations = parseOperations(text);
        const results = await runOperations(ctx, operations);
        // selectors of created objects are what the caller needs next;
        // every operation's full result only with --verbose
        const created = results
            .map(r => r.result?.selector)
            .filter((selector: any) => typeof selector == "string");
        ctx.emit(
            ctx.flag("verbose")
                ? { operations: results.length, created, results }
                : { operations: results.length, created },
            `${results.length} operation(s) applied` +
                (created.length > 0 ? `\ncreated: ${created.join(", ")}` : "")
        );
    }
};

export const applyCommands: CommandDef[] = [applyCommand];
