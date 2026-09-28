// A loaded project plus everything needed to change it safely:
// check before/after, atomic save with backup, reload when the file changes
// on disk and notification of a running EEZ Studio GUI.

import fs from "fs";
import path from "path";
import { runInAction } from "mobx";

import { ProjectStore, getJSON, Section } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Project } from "project-editor/project/project";

import { CliError } from "cli/errors";
import { flattenMessages, newProblems, Problem } from "cli/messages";
import * as host from "cli/host";

export function findProjectFile(cwd: string, explicit?: string) {
    if (explicit) {
        const filePath = path.resolve(cwd, explicit);
        if (!fs.existsSync(filePath)) {
            throw new CliError(`Project file not found: ${filePath}`);
        }
        return filePath;
    }

    const candidates: string[] = [];
    for (const dir of [cwd, path.join(cwd, "eez-studio")]) {
        if (!fs.existsSync(dir)) {
            continue;
        }
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith(".eez-project")) {
                candidates.push(path.join(dir, file));
            }
        }
    }

    if (candidates.length == 0) {
        throw new CliError(
            "No .eez-project file in the current folder",
            'pass one with -p <file>, or create one with "project new <file>"'
        );
    }

    if (candidates.length > 1) {
        throw new CliError(
            "More than one .eez-project file in the current folder",
            `pass one with -p: ${candidates
                .map(c => path.basename(c))
                .join(", ")}`
        );
    }

    return candidates[0];
}

export class CliSession {
    store: ProjectStore | undefined;
    filePath: string | undefined;
    mtimeMs: number | undefined;

    constructor(public cwd: string) {}

    get project(): Project {
        if (!this.store) {
            throw new CliError("No project is open");
        }
        return this.store.project;
    }

    requireStore(): ProjectStore {
        if (!this.store) {
            throw new CliError(
                "No project is open",
                'pass -p <file> or run "open <file>"'
            );
        }
        return this.store;
    }

    async open(filePath: string) {
        filePath = path.resolve(this.cwd, filePath);

        if (!fs.existsSync(filePath)) {
            throw new CliError(`Project file not found: ${filePath}`);
        }

        this.close();

        const store = ProjectStore.create({ type: "project-editor" });
        await store.openFile(filePath);

        this.store = store;
        this.filePath = filePath;
        this.mtimeMs = fs.statSync(filePath).mtimeMs;

        return store;
    }

    close() {
        if (this.store) {
            try {
                this.store.openProjectsManager.unmount();
            } catch (err) {}
            this.store = undefined;
        }
        this.filePath = undefined;
        this.mtimeMs = undefined;
    }

    async reload() {
        if (this.filePath) {
            await this.open(this.filePath);
        }
    }

    // reload the project if the file was changed by someone else
    async ensureFresh() {
        if (!this.filePath) {
            return;
        }
        try {
            const mtimeMs = fs.statSync(this.filePath).mtimeMs;
            if (mtimeMs != this.mtimeMs) {
                await this.reload();
            }
        } catch (err) {}
    }

    get revision() {
        return this.store?.lastRevision;
    }

    check(): Problem[] {
        const store = this.requireStore();
        const messages = ProjectEditor.build.backgroundCheck(store);
        return flattenMessages(messages);
    }

    // full check (includes asset build checks), like "Check" in the GUI
    async fullCheck(): Promise<Problem[]> {
        const store = this.requireStore();
        const problems = this.check();
        await ProjectEditor.build.buildProject(store, "check");
        const buildProblems = flattenMessages(
            store.outputSectionsStore.getSection(Section.OUTPUT).messages
                .messages
        ).filter(problem => problem.type != "info");
        return [...problems, ...buildProblems];
    }

    newErrors(before: Problem[]) {
        const after = this.check().filter(problem => problem.type == "error");
        return newProblems(before, after);
    }

    async save(options: { backup?: boolean } = {}) {
        const store = this.requireStore();
        const filePath = this.filePath!;

        const json = getJSON(store);

        if (options.backup !== false && fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, filePath + ".bak");
        }

        const tmpPath = `${filePath}.eez-cli-tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, json, "utf8");
        fs.renameSync(tmpPath, filePath);

        runInAction(() => {
            store.savedRevision = store.lastRevision;
        });

        this.mtimeMs = fs.statSync(filePath).mtimeMs;
    }

    notifyGui() {
        if (this.filePath) {
            host.reloadGui(this.filePath);
        }
    }
}
