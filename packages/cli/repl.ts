// Line oriented mode: one command per stdin line, the project stays loaded.
//   eez-cli repl [-p project] [--json]
// Each line is executed like a separate CLI invocation. With --json every
// result is printed as a single JSON line (JSON Lines).

import * as host from "cli/host";
import { splitCommandLine } from "cli/args";
import { EXIT_OK } from "cli/errors";
import { Runner, resultToJSON, resultToText } from "cli/runner";

export async function runRepl(runner: Runner, args: string[]) {
    const { opts } = runner.parse(args);
    const jsonLines = opts.json === true;
    if (typeof opts.project == "string") {
        runner.defaults.project = opts.project;
    }

    let queue = Promise.resolve();

    const prompt = () => {
        if (!jsonLines) {
            host.writeStderr("eez> ");
        }
    };

    prompt();

    await new Promise<void>(resolve => {
        host.onStdinLine(
            line => {
                queue = queue.then(async () => {
                    const trimmed = line.trim();
                    if (trimmed == "" || trimmed.startsWith("#")) {
                        prompt();
                        return;
                    }
                    if (trimmed == "exit" || trimmed == "quit") {
                        host.exit(EXIT_OK);
                        return;
                    }
                    const argv = splitCommandLine(trimmed);
                    if (jsonLines && !argv.includes("--json")) {
                        argv.push("--json");
                    }
                    const result = await runner.execute(argv);
                    if (jsonLines) {
                        host.writeStdout(
                            JSON.stringify(resultToJSON(result)) + "\n"
                        );
                    } else {
                        const { out, err } = resultToText(result);
                        if (out) host.writeStdout(out);
                        if (err) host.writeStderr(err);
                    }
                    prompt();
                });
            },
            () => {
                queue.then(() => resolve());
            }
        );
    });

    host.exit(EXIT_OK);
}
