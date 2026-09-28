import { ipcRenderer } from "electron";
import { autorun } from "mobx";

import { Message, ProjectStore, Section } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";

import { initProjectEditor } from "project-editor/project-editor-bootstrap";

export async function buildProject(filePath: string) {
    ipcRenderer.send("on-build-project-message", "Build project: " + filePath);

    let exitCode = 0;

    try {
        initProjectEditor(undefined, undefined as any);

        const projectStore = ProjectStore.create({
            type: "read-only"
        });

        await projectStore.openFile(filePath);

        // dump build messages
        const messages =
            projectStore.outputSectionsStore.sections[Section.OUTPUT].messages;
        let lastMessageIndexDumped = -1;
        autorun(() => {
            let messageIndex = 0;
            function dumpMessages(messages: Message[], indent: string) {
                for (let i = 0; i < messages.length; i++, messageIndex++) {
                    const message = messages[i];
                    if (messageIndex > lastMessageIndexDumped) {
                        lastMessageIndexDumped = messageIndex;

                        ipcRenderer.send(
                            "on-build-project-message",
                            indent + message.text
                        );
                    }
                    if (message.messages) {
                        dumpMessages(message.messages, indent + "\t");
                    }
                }
            }
            dumpMessages(messages.messages, "");
        });

        // call the build directly: ProjectStore.build() needs the editor UI
        if (projectStore.projectTypeTraits.isIEXT) {
            await ProjectEditor.build.buildExtensions(projectStore);
        } else {
            await ProjectEditor.build.buildProject(projectStore, "buildFiles");
        }

        if (
            projectStore.outputSectionsStore.getSection(Section.OUTPUT)
                .numErrors > 0
        ) {
            exitCode = 1;
        }
    } catch (err: any) {
        ipcRenderer.send(
            "on-build-project-message",
            "Unhandled error: " + err.toString()
        );
        exitCode = 1;
    }

    ipcRenderer.send("on-build-project-exit", exitCode);
}
