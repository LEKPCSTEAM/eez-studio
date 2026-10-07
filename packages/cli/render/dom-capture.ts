// Renders EEZ-GUI / Dashboard pages (React/DOM based editor rendering) inside
// the hidden CLI window and captures the pixels with webContents.capturePage.

import React from "react";
import { createRoot } from "react-dom/client";
import { makeObservable, computed } from "mobx";

import { guid } from "eez-studio-shared/guid";

import type { Page } from "project-editor/features/page/page";
import type { Flow } from "project-editor/flow/flow";
import type { Component } from "project-editor/flow/component";
import type {
    IDataContext,
    IDocument,
    IEditorOptions,
    IFlowContext,
    IResizeHandler,
    IViewState
} from "project-editor/flow/flow-interfaces";
import { Transform } from "project-editor/flow/editor/transform";
import { TreeObjectAdapter } from "project-editor/core/objectAdapter";
import { ProjectContext } from "project-editor/project/context";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { getProjectStore } from "project-editor/store";

import * as host from "cli/host";
import type { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import { encodePng, OverlayBox } from "cli/render/image";
import { selectorOf, nameOf } from "cli/selectors";
import { classNameOf } from "cli/reflect";

import fs from "fs";
import path from "path";

////////////////////////////////////////////////////////////////////////////////
// minimal read-only flow context (like the one of the changes viewer)

class RenderFlowContext implements IFlowContext {
    containerId = guid();
    document: IDocument;
    viewState: IViewState;
    editorOptions: IEditorOptions = {
        disableUpdateComponentGeometry: true
    } as any;
    _dataContext: IDataContext | undefined;

    constructor(
        public flow: Flow,
        public transform: Transform
    ) {
        this.document = new RenderDocument(new TreeObjectAdapter(flow), this);
        this.viewState = new RenderViewState(this) as any;
        makeObservable(this, { flowState: computed });
    }

    get projectStore() {
        return getProjectStore(this.flow);
    }

    get flowState() {
        return undefined;
    }

    get dataContext() {
        return this._dataContext || this.projectStore.dataContext;
    }

    get frontFace() {
        return true;
    }

    overrideDataContext(dataContextOverridesObject: any): IFlowContext {
        if (!dataContextOverridesObject) {
            return this;
        }
        return Object.assign(
            new RenderFlowContext(this.flow, this.transform),
            this,
            {
                _dataContext: this.dataContext.createWithDefaultValueOverrides(
                    dataContextOverridesObject
                )
            }
        );
    }

    overrideFlowState(component: Component): IFlowContext {
        return this;
    }
}

class RenderDocument {
    constructor(
        public flow: TreeObjectAdapter,
        public flowContext: RenderFlowContext
    ) {}
    get connectionLines() {
        return [];
    }
    get selectedConnectionLines() {
        return [];
    }
    get nonSelectedConnectionLines() {
        return [];
    }
    findObjectById(id: string) {
        return this.flow.getObjectAdapter(id);
    }
    findObjectParent(object: TreeObjectAdapter) {
        return this.flow.getParent(object);
    }
    objectFromPoint() {
        return undefined;
    }
    getObjectsInsideRect() {
        return [];
    }
    createContextMenu() {
        return undefined;
    }
    duplicateSelection() {}
    pasteSelection() {}
    get projectStore() {
        return getProjectStore(this.flow.object);
    }
    onDragStart() {}
    onDragEnd() {}
    connectionExists() {
        return false;
    }
    connect() {}
    connectToNewTarget() {}
    connectToNewSource() {}
}

class RenderViewState {
    dxMouseDrag: number | undefined;
    dyMouseDrag: number | undefined;
    constructor(public flowContext: RenderFlowContext) {}
    get transform() {
        return this.flowContext.transform;
    }
    set transform(transform: Transform) {
        this.flowContext.transform = transform;
    }
    get projectStore() {
        return this.flowContext.projectStore;
    }
    get document() {
        return this.flowContext.document;
    }
    get containerId() {
        return this.flowContext.containerId;
    }
    resetTransform() {}
    getResizeHandlers(): IResizeHandler[] | undefined {
        return undefined;
    }
    get selectedObjects() {
        return [];
    }
    get connectionLine() {
        return undefined;
    }
    get sourceComponent() {
        return undefined;
    }
    get targetComponent() {
        return undefined;
    }
    isObjectSelected() {
        return false;
    }
    isObjectIdSelected() {
        return false;
    }
    selectObject() {}
    selectObjects() {}
    deselectAllObjects() {}
    moveSelection() {}
}

////////////////////////////////////////////////////////////////////////////////

function nextFrame() {
    return new Promise(resolve =>
        requestAnimationFrame(() => resolve(undefined))
    );
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pngToFrame(png: Uint8Array) {
    const bitmap = await createImageBitmap(
        new Blob([png as any], { type: "image/png" })
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: imageData.data };
}

export async function renderDomPage(
    ctx: CommandContext,
    page: Page,
    options: { output?: string; scale?: number; bounds?: boolean }
) {
    const store = ctx.store;
    const width =
        page.width || store.project.settings.general.displayWidth || 480;
    const height =
        page.height || store.project.settings.general.displayHeight || 272;

    await host.setWindowSize(
        Math.max(width + 20, 800),
        Math.max(height + 20, 600)
    );

    const container = document.createElement("div");
    container.style.cssText = `position: fixed; left: 0; top: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${
        store.projectTypeTraits.isDashboard ? "#ffffff" : "#000000"
    }; z-index: 100000`;
    document.body.style.margin = "0";
    document.body.appendChild(container);

    const transform = new Transform({ translate: { x: 0, y: 0 }, scale: 1 });
    transform.clientRect = { left: 0, top: 0, width, height };
    const flowContext = new RenderFlowContext(page, transform);

    const root = createRoot(container);

    try {
        root.render(
            React.createElement(
                ProjectContext.Provider,
                { value: store },
                React.createElement(
                    "div",
                    {
                        className:
                            "EezStudio_FlowCanvasContainer EezStudio_PageEditor",
                        style: { position: "relative", width, height }
                    },
                    page.render(flowContext, width, height)
                )
            )
        );

        // let React commit, canvases draw and images load
        for (let i = 0; i < 5; i++) {
            await nextFrame();
        }
        await sleep(300);
        await document.fonts.ready;
        await nextFrame();

        const png = await host.capturePage({ x: 0, y: 0, width, height });
        if (!png || png.length == 0) {
            throw new CliError("Failed to capture the page image");
        }

        // widget boxes from the DOM
        const containerRect = container.getBoundingClientRect();
        const layout: any[] = [];
        const boxes: OverlayBox[] = [];
        const elements = container.querySelectorAll(
            "[data-eez-flow-object-id]"
        );
        elements.forEach(el => {
            const id = el.getAttribute("data-eez-flow-object-id")!;
            const object = store.getObjectFromObjectId(id) as any;
            if (!object || !(object instanceof ProjectEditor.WidgetClass)) {
                return;
            }
            const rect = el.getBoundingClientRect();
            const x = Math.round(rect.left - containerRect.left);
            const y = Math.round(rect.top - containerRect.top);
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            let depth = 0;
            for (
                let p = el.parentElement;
                p && p != container;
                p = p.parentElement
            ) {
                if (p.hasAttribute("data-eez-flow-object-id")) depth++;
            }
            const issues: string[] = [];
            if (x < 0 || y < 0 || x + w > width || y + h > height)
                issues.push("outside-screen");
            if (w <= 0 || h <= 0) issues.push("zero-size");
            layout.push({
                selector: selectorOf(object),
                type: classNameOf(object).replace(/Widget$/, ""),
                name: nameOf(object),
                x,
                y,
                width: w,
                height: h,
                issues: issues.length ? issues : undefined
            });
            boxes.push({
                x,
                y,
                width: w,
                height: h,
                depth,
                label:
                    nameOf(object) ??
                    classNameOf(object).replace(/Widget$/, ""),
                issue: issues.length > 0
            });
        });

        let output = png as Buffer;
        const scale = options.scale ?? 1;
        if (scale != 1 || options.bounds) {
            const frame = await pngToFrame(png);
            output = encodePng(frame, {
                scale,
                boxes: options.bounds ? boxes : undefined
            });
        }

        const file = options.output
            ? path.resolve(ctx.cwd, options.output)
            : path.join(
                  path.dirname(ctx.session.filePath!),
                  ".eez-render",
                  `${(page.name || "page").replace(/[^\w.-]+/g, "_")}${options.bounds ? ".bounds" : ""}.png`
              );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, output);

        return { output: file, png: output, width, height, layout };
    } finally {
        root.unmount();
        container.remove();
    }
}
