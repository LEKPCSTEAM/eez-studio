// Minimal argv parser in the spirit of tmp/eezc:
//   --name value | --name=value | --flag | --no-flag | -p value | -- (rest)
// Repeated options collect into an array.

export type OptionValue = string | boolean | (string | boolean)[];

export interface ParsedArgs {
    args: string[];
    opts: { [name: string]: OptionValue };
}

const SHORT_OPTIONS: { [short: string]: string } = {
    p: "project",
    o: "output",
    n: "name",
    h: "help"
};

// options that never take a value (so `--json page list` does not eat "page")
export const GLOBAL_BOOLEAN_OPTIONS = new Set([
    "json",
    "dry-run",
    "force",
    "help",
    "no-backup",
    "no-reload-gui",
    "strict",
    "cli-debug",
    "cli-devtools",
    "quiet",
    "verbose"
]);

function isValueToken(token: string | undefined) {
    if (token === undefined) {
        return false;
    }
    if (token.startsWith("--")) {
        return false;
    }
    if (/^-[A-Za-z]$/.test(token)) {
        return false;
    }
    return true;
}

function push(opts: ParsedArgs["opts"], name: string, value: string | boolean) {
    const existing = opts[name];
    if (existing === undefined) {
        opts[name] = value;
    } else if (Array.isArray(existing)) {
        existing.push(value);
    } else {
        opts[name] = [existing, value];
    }
}

export function parseArgs(
    argv: string[],
    booleanOptions: Set<string> = GLOBAL_BOOLEAN_OPTIONS
): ParsedArgs {
    const args: string[] = [];
    const opts: ParsedArgs["opts"] = {};

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (token === "--") {
            args.push(...argv.slice(i + 1));
            break;
        }

        if (token.startsWith("--") && token.length > 2) {
            let name = token.substring(2);
            let inline: string | undefined;
            const eq = name.indexOf("=");
            if (eq != -1) {
                inline = name.substring(eq + 1);
                name = name.substring(0, eq);
            }

            if (inline !== undefined) {
                push(opts, name, inline);
            } else if (booleanOptions.has(name)) {
                push(opts, name, true);
            } else if (name.startsWith("no-") && !booleanOptions.has(name)) {
                push(opts, name.substring(3), false);
            } else if (isValueToken(argv[i + 1])) {
                push(opts, name, argv[++i]);
            } else {
                push(opts, name, true);
            }
            continue;
        }

        if (/^-[A-Za-z]$/.test(token)) {
            const name = SHORT_OPTIONS[token[1]] ?? token[1];
            if (!booleanOptions.has(name) && isValueToken(argv[i + 1])) {
                push(opts, name, argv[++i]);
            } else {
                push(opts, name, true);
            }
            continue;
        }

        args.push(token);
    }

    return { args, opts };
}

// Split a command line string into argv (handles "double" and 'single' quotes)
export function splitCommandLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let hasCurrent = false;
    let quote: string | undefined;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c == quote) {
                quote = undefined;
            } else if (c == "\\" && quote == '"' && i + 1 < line.length) {
                const next = line[i + 1];
                if (next == '"' || next == "\\") {
                    current += next;
                    i++;
                } else {
                    current += c;
                }
            } else {
                current += c;
            }
        } else if (c == '"' || c == "'") {
            quote = c;
            hasCurrent = true;
        } else if (/\s/.test(c)) {
            if (hasCurrent) {
                result.push(current);
                current = "";
                hasCurrent = false;
            }
        } else {
            current += c;
            hasCurrent = true;
        }
    }

    if (hasCurrent) {
        result.push(current);
    }

    return result;
}
