import type { CommandContext } from "cli/context";

export interface CommandDef {
    // one or more words, e.g. "info", "widget add", "lvgl-style local set"
    name: string;
    summary: string;
    // usage text, first line is the synopsis
    usage: string;
    // options that never take a value
    booleans?: string[];
    // "required" (default): needs an open project, "none": works without one
    project?: "required" | "none";
    // true if the command can change the project (saved after success)
    mutating?: boolean;
    // group used by "help"
    group?: string;
    // other names for the same command
    aliases?: string[];
    run(ctx: CommandContext): Promise<void> | void;
}

const commands: CommandDef[] = [];

export function registerCommands(defs: CommandDef[]) {
    commands.push(...defs);
}

export function getCommands() {
    return commands;
}

export function findCommand(
    words: string[]
): { command: CommandDef; consumed: number } | undefined {
    for (let n = Math.min(4, words.length); n > 0; n--) {
        const name = words.slice(0, n).join(" ");
        const command = commands.find(
            command =>
                command.name == name ||
                (command.aliases && command.aliases.includes(name))
        );
        if (command) {
            return { command, consumed: n };
        }
    }
    return undefined;
}

// commands starting with the given words (used for "help <group>")
export function findCommandsWithPrefix(words: string[]) {
    const prefix = words.join(" ");
    return commands.filter(
        command =>
            command.name == prefix || command.name.startsWith(prefix + " ")
    );
}

export function allBooleanOptions(): Set<string> {
    const result = new Set<string>();
    for (const command of commands) {
        command.booleans?.forEach(name => result.add(name));
    }
    return result;
}
