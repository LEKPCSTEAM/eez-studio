import type { ProjectStore } from "project-editor/store";
import type { Project } from "project-editor/project/project";
import type { IEezObject } from "project-editor/core/object";

import { OptionValue } from "cli/args";
import { CliError, UsageError } from "cli/errors";
import type { CliSession } from "cli/session";
import type { Runner } from "cli/runner";
import type { CommandDef } from "cli/registry";
import { resolveSelector } from "cli/selectors";

export interface Emitted {
    data: any;
    text?: string;
}

export class CommandContext {
    emitted: Emitted[] = [];
    changes: string[] = [];
    // files written by the command (render output, exported assets ...)
    files: string[] = [];
    // extra MCP content (images)
    images: { data: Uint8Array; mimeType: string }[] = [];
    // set when the project was changed outside of the undo manager
    modified = false;
    // set by commands that write the project file themselves (project new)
    saved = false;

    constructor(
        public command: CommandDef,
        public session: CliSession,
        public runner: Runner,
        public args: string[],
        public opts: { [name: string]: OptionValue }
    ) {}

    get store(): ProjectStore {
        return this.session.requireStore();
    }

    get project(): Project {
        return this.session.project;
    }

    get cwd() {
        return this.session.cwd;
    }

    get json() {
        return this.opts.json === true;
    }

    get force() {
        return this.flag("force");
    }

    usage(message: string): never {
        throw new UsageError(message, `usage: ${this.command.usage.split("\n")[0]}`);
    }

    // positional argument
    arg(index: number, label: string): string {
        const value = this.args[index];
        if (value === undefined) {
            this.usage(`missing <${label}>`);
        }
        return value;
    }

    argOpt(index: number): string | undefined {
        return this.args[index];
    }

    // last value of an option; true if given without a value
    raw(name: string): string | boolean | undefined {
        const value = this.opts[name];
        if (value === undefined) {
            return undefined;
        }
        return Array.isArray(value) ? value[value.length - 1] : value;
    }

    str(name: string, fallback?: string): string | undefined {
        const value = this.raw(name);
        if (value === undefined || value === false) {
            return fallback;
        }
        if (value === true) {
            this.usage(`--${name} expects a value`);
        }
        return value as string;
    }

    requireStr(name: string): string {
        const value = this.str(name);
        if (value === undefined) {
            this.usage(`missing --${name}`);
        }
        return value!;
    }

    flag(name: string, fallback = false): boolean {
        const value = this.raw(name);
        if (value === undefined) {
            return fallback;
        }
        return value !== false && value !== "false" && value !== "0";
    }

    num(name: string, fallback?: number): number | undefined {
        const value = this.str(name);
        if (value === undefined) {
            return fallback;
        }
        const n = Number(value);
        if (!Number.isFinite(n)) {
            throw new UsageError(`--${name} expects a number, got "${value}"`);
        }
        return n;
    }

    // comma separated and/or repeated values
    list(name: string): string[] {
        const value = this.opts[name];
        if (value === undefined) {
            return [];
        }
        return ([] as (string | boolean)[])
            .concat(value)
            .filter(v => typeof v == "string")
            .flatMap(v => (v as string).split(","))
            .map(v => v.trim())
            .filter(v => v.length > 0);
    }

    // "x,y" or "WxH"
    pair(name: string): [number, number] | undefined {
        const value = this.str(name);
        if (value === undefined) {
            return undefined;
        }
        const parts = value.split(/[,x×]/i).map(s => Number(s.trim()));
        if (parts.length != 2 || parts.some(n => !Number.isFinite(n))) {
            throw new UsageError(
                `--${name} expects two numbers like 10,20 (or 100x50), got "${value}"`
            );
        }
        return [parts[0], parts[1]];
    }

    // repeated --set key=value (and positional key=value from index)
    pairs(name = "set", positionalFrom?: number): { [key: string]: string } {
        const result: { [key: string]: string } = {};
        const entries: string[] = [];
        const value = this.opts[name];
        if (value !== undefined) {
            for (const v of ([] as (string | boolean)[]).concat(value)) {
                if (typeof v == "string") {
                    entries.push(v);
                }
            }
        }
        if (positionalFrom !== undefined) {
            entries.push(...this.args.slice(positionalFrom));
        }
        for (const entry of entries) {
            const eq = entry.indexOf("=");
            if (eq <= 0) {
                throw new UsageError(`expected key=value, got "${entry}"`);
            }
            result[entry.substring(0, eq).trim()] = entry.substring(eq + 1);
        }
        return result;
    }

    // --json-values '{"k": v}' merged with pairs
    values(positionalFrom?: number): { [key: string]: any } {
        const result: { [key: string]: any } = this.pairs("set", positionalFrom);
        const jsonText = this.str("values");
        if (jsonText) {
            let parsed: any;
            try {
                parsed = JSON.parse(jsonText);
            } catch (err) {
                throw new UsageError(`--values expects a JSON object`);
            }
            if (!parsed || typeof parsed != "object" || Array.isArray(parsed)) {
                throw new UsageError(`--values expects a JSON object`);
            }
            Object.assign(result, parsed);
        }
        return result;
    }

    resolve(selector: string): IEezObject {
        return resolveSelector(this.project, selector);
    }

    emit(data: any, text?: string) {
        this.emitted.push({ data, text });
    }

    changed(summary: string) {
        this.changes.push(summary);
    }

    markModified() {
        this.modified = true;
    }

    fail(message: string, hint?: string): never {
        throw new CliError(message, hint);
    }
}
