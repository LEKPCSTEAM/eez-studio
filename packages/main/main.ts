import "./fix-path";

import {
    app,
    session,
    ipcMain,
    powerSaveBlocker,
    BrowserWindow
} from "electron";
import { configure } from "mobx";

require("@electron/remote/main").initialize();

import type * as HomeWindowModule from "main/home-window";
import { unloadVisa } from "instrument/connection/interfaces/visa-dll";
import { setup } from "main/setup";
import { HOME_WINDOW_URL } from "main/home-window";
import {
    isCliMode,
    redirectConsoleToStderr,
    runCliMain,
    useTemporarySessionData
} from "main/cli-main";

const cliMode = isCliMode();
// Hidden BrowserWindows still give each Electron process a macOS Dock icon.
// CLI/MCP workers and the short-lived reload helper are background apps;
// set their activation policy before ready to avoid adding duplicate icons.
if (
    process.platform == "darwin" &&
    (cliMode || process.argv.includes("--reload-project"))
) {
    app.setActivationPolicy("accessory");
}

if (cliMode) {
    redirectConsoleToStderr();
    useTemporarySessionData();
}

// disable security warnings inside dev console
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = true as any;

configure({ enforceActions: "observed" });

const contextMenu = require("electron-context-menu");

contextMenu({
    showSaveImageAs: true
});

////////////////////////////////////////////////////////////////////////////////

app.commandLine.appendSwitch("disable-renderer-backgrounding");

// app.allowRendererProcessReuse = false;

let homeWindow: BrowserWindow;

app.on("ready", async function () {
    if (cliMode) {
        await runCliMain(HOME_WINDOW_URL);
        return;
    }

    let buildProjectFilePath;
    const buildProjectArgIndex = process.argv.indexOf("--build-project");
    if (buildProjectArgIndex != -1) {
        if (buildProjectArgIndex + 1 < process.argv.length) {
            buildProjectFilePath = process.argv[buildProjectArgIndex + 1];
        }
    }

    if (!buildProjectFilePath) {
        var gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            app.quit();
            return;
        }

        if (process.argv.includes("--reload-project")) {
            // no running instance to reload
            app.quit();
            return;
        }
    }

    app.on("second-instance", function (event, commandLine, workingDirectory) {
        const reloadProjectArgIndex = commandLine.indexOf("--reload-project");
        if (reloadProjectArgIndex != -1) {
            console.log("[reload-project] second-instance triggered, commandLine:", commandLine);
            const { reloadProject } =
                require("main/home-window") as typeof HomeWindowModule;
            console.log("[reload-project] calling reloadProject()");
            reloadProject(commandLine[reloadProjectArgIndex + 1]);
            return;
        }
        console.log("[second-instance] commandLine:", commandLine);
        const { bringHomeWindowToFocus } =
            require("main/home-window") as typeof HomeWindowModule;
        bringHomeWindowToFocus();
        const { openFile } = require("main/menu");
        openFile(commandLine[commandLine.length - 1]);
    });

    // start with:
    // react devtools: npm start devToolsExtension="C:\Users\mvladic\AppData\Local\Google\Chrome\User Data\Default\Extensions\fmkadmapgofadopljbjfkapdkoienihi\4.10.1_0"
    // mobx devtools: npm start devToolsExtension="C:\Users\mvladic\AppData\Local\Google\Chrome\User Data\Default\Extensions\pfgnfdagidkfgccljigdamigbcnndkod\0.9.26_0"
    if (
        process.argv.length > 2 &&
        process.argv[2].startsWith("devToolsExtension=")
    ) {
        await app.whenReady();
        await session.defaultSession.loadExtension(
            process.argv[2].substr("devToolsExtension=".length),
            { allowFileAccess: true }
        );
    }

    const { loadSettings } = await import("main/settings");
    await loadSettings();

    await setup();

    await import("instrument/connection/interfaces/serial-ports-main");

    require("eez-studio-shared/service");

    const { openHomeWindow } = await import("main/home-window");
    if (buildProjectFilePath) {
        homeWindow = openHomeWindow({
            url: HOME_WINDOW_URL + "?build-project=1",
            showHidden: true
        });
    } else {
        homeWindow = openHomeWindow();
    }

    await import("main/menu");
});

// Quit when all windows are closed.
app.on("window-all-closed", function () {
    app.quit();
});

app.on("quit", function () {
    const { closeConnections } =
        require("instrument/connection/connection-main") as typeof import("instrument/connection/connection-main");

    closeConnections();

    unloadVisa();
});

app.on("will-finish-launching", async function () {
    app.on("open-file", async function (event, path) {
        event.preventDefault();
        const { openFile } = require("main/menu");
        openFile(path);
    });
});

ipcMain.once("open-command-line-project", async function () {
    if (cliMode) {
        return;
    }
    const buildProjectArgIndex = process.argv.indexOf("--build-project");
    if (buildProjectArgIndex == -1) {
        const filePath = process.argv[process.argv.length - 1];
        const { openFile } = require("main/menu");
        openFile(filePath);
    } else {
        if (buildProjectArgIndex + 1 < process.argv.length) {
            const buildProjectFilePath = process.argv[buildProjectArgIndex + 1];
            homeWindow.webContents.send("build-project", buildProjectFilePath);
        }
    }
});

ipcMain.on("on-build-project-message", function (event, message) {
    if (message) {
        console.log(message);
    } else {
        app.quit();
    }
});

ipcMain.on("on-build-project-exit", function (event, exitCode: number) {
    process.stdout.write("", () => app.exit(exitCode));
});

let powerSaveBlockerId: number | undefined = undefined;
ipcMain.on("preventAppSuspension", (event: any, on: boolean) => {
    if (on) {
        if (powerSaveBlockerId == undefined) {
            powerSaveBlockerId = powerSaveBlocker.start(
                "prevent-app-suspension"
            );
        }
    } else {
        if (powerSaveBlockerId != undefined) {
            powerSaveBlocker.stop(powerSaveBlockerId);
            powerSaveBlockerId = undefined;
        }
    }
});

process.on("warning", e => console.warn(e.stack));
