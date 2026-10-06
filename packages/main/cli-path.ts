import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { app, dialog } from "electron";

const MACOS_CLI_LINK = "/usr/local/bin/eez-cli";

function cliWrapperPath() {
    return path.join(process.resourcesPath, "cli", "eez-cli");
}

export function canInstallCliInPath() {
    return (
        process.platform == "darwin" &&
        app.isPackaged &&
        fs.existsSync(cliWrapperPath())
    );
}

// dmg/zip installs have no installer step, so macOS links eez-cli from the app menu
export function installCliInPath() {
    const target = cliWrapperPath().replace(/[\\"]/g, "\\$&");
    const script =
        `do shell script "mkdir -p /usr/local/bin && ln -sf " & quoted form of "${target}" & " ${MACOS_CLI_LINK}"` +
        " with administrator privileges";

    execFile("osascript", ["-e", script], err => {
        if (err) {
            // -128: the user canceled the password prompt
            if (!String(err.message).includes("-128")) {
                dialog.showErrorBox("Install 'eez-cli' command", err.message);
            }
            return;
        }
        dialog.showMessageBox({
            type: "info",
            message: `'eez-cli' command installed in ${MACOS_CLI_LINK}`,
            detail: "Register the MCP server with: claude mcp add eez-studio -- eez-cli mcp"
        });
    });
}
