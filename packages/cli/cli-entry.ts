// Renderer entry point of the built-in command line interface.
// Loaded by home/main.tsx when the hidden window is opened with ?cli=1.

import { ipcRenderer } from "electron";

import { initProjectEditor } from "project-editor/project-editor-bootstrap";

import * as host from "cli/host";
import { EXIT_ERROR, EXIT_USAGE, errorToString } from "cli/errors";
import { CliSession } from "cli/session";
import { Runner, resultToJSON, resultToText, RunResult } from "cli/runner";
import { registerAllCommands } from "cli/commands";

export function formatResult(result: RunResult) {
    if (result.json) {
        return {
            stdout: JSON.stringify(resultToJSON(result), null, 2) + "\n",
            // human readable diagnostics still go to stderr
            stderr: result.error ? resultToText(result).err : ""
        };
    }
    const { out, err } = resultToText(result);
    return { stdout: out, stderr: err };
}

export function printResult(result: RunResult) {
    const { stdout, stderr } = formatResult(result);
    if (stdout) {
        host.writeStdout(stdout);
    }
    if (stderr) {
        host.writeStderr(stderr);
    }
}

// daemon: execute command lines sent by the launcher, one at a time
function runServe(session: CliSession, runner: Runner) {
    runner.stateless = true;

    let queue = Promise.resolve();

    ipcRenderer.on(
        "cli:serve-request",
        (event, id: number, request: { args: string[]; cwd: string }) => {
            queue = queue.then(async () => {
                let response;
                if (["mcp", "repl", "serve"].includes(request.args[0])) {
                    response = {
                        stdout: "",
                        stderr: `eez-cli: "${request.args[0]}" can't run in the daemon\n`,
                        exitCode: EXIT_USAGE
                    };
                } else {
                    try {
                        session.cwd = request.cwd;
                        runner.defaults = {};
                        const args = request.args.length > 0 ? request.args : ["help"];
                        const result = await runner.execute(args);
                        response = { ...formatResult(result), exitCode: result.exitCode };
                    } catch (err) {
                        response = {
                            stdout: "",
                            stderr: "eez-cli: internal error: " + errorToString(err) + "\n",
                            exitCode: EXIT_ERROR
                        };
                    }
                }
                ipcRenderer.send("cli:serve-response", id, response);
            });
        }
    );

    ipcRenderer.send("cli:serve-ready");
}

export async function runCli() {
    let init: host.CliInit;
    try {
        init = await host.getCliInit();
    } catch (err) {
        host.writeStderr("eez-cli: failed to initialize: " + errorToString(err) + "\n");
        host.exit(EXIT_ERROR);
        return;
    }

    try {
        initProjectEditor(undefined, undefined as any);
        registerAllCommands();

        const session = new CliSession(init.cwd);
        const runner = new Runner(session);

        const args = init.args.filter(
            arg => arg != "--cli-debug" && arg != "--cli-devtools"
        );

        // long running modes take over stdin/stdout
        if (args[0] == "mcp") {
            const { runMcpServer } = await import("cli/mcp/server");
            await runMcpServer(runner, args.slice(1));
            return;
        }

        if (args[0] == "repl") {
            const { runRepl } = await import("cli/repl");
            await runRepl(runner, args.slice(1));
            return;
        }

        if (args[0] == "serve") {
            runServe(session, runner);
            return;
        }

        if (args.length == 0) {
            args.push("help");
        }

        const result = await runner.execute(args);
        printResult(result);
        host.exit(result.exitCode);
    } catch (err) {
        host.writeStderr(
            "eez-cli: internal error: " +
                errorToString(err) +
                "\n" +
                ((err as any)?.stack ?? "") +
                "\n"
        );
        host.exit(EXIT_ERROR);
    }
}
