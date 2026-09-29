// Renders an LVGL page with the real LVGL WASM runtime into an image,
// without any editor UI. Same rendering as the page editor canvas.

import { runInAction } from "mobx";

import type { Page } from "project-editor/features/page/page";
import type { LVGLWidget } from "project-editor/lvgl/widgets";
import { LVGLPageRuntime } from "project-editor/lvgl/page-runtime";
import { getLvglWasmFlowRuntimeConstructor } from "project-editor/lvgl/lvgl-versions";

export interface RenderedFrame {
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
}

export interface WidgetBox {
    widget: LVGLWidget;
    parent: LVGLWidget | undefined;
    x: number;
    y: number;
    width: number;
    height: number;
    depth: number;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class LVGLOffscreenPageRuntime extends LVGLPageRuntime {
    pageObj: number = 0;

    constructor(
        page: Page,
        public displayWidth: number,
        public displayHeight: number,
        public darkTheme: boolean
    ) {
        super(page);
    }

    get isEditor() {
        return true;
    }

    mount() {}

    async mountAsync() {
        await new Promise<void>((resolve, reject) => {
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    reject(new Error("LVGL runtime failed to start"));
                }
            }, 30000);
            this.wasm = getLvglWasmFlowRuntimeConstructor(this.lvglVersion)(
                () => {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
            );
        });

        this.isMounted = true;

        await this.preloadImages();

        runInAction(() => {
            this.page._lvglRuntime = this;
            this.page._lvglObj = undefined;
        });

        this.wasm._init(
            0,
            0,
            0,
            0,
            this.displayWidth,
            this.displayHeight,
            this.darkTheme,
            -(new Date().getTimezoneOffset() / 60) * 100,
            false
        );

        this.createStyles();

        const pageObj = this.page.lvglCreate(this, 0);

        for (const callback of this.postCreateCallbacks) {
            callback();
        }
        this.postCreateCallbacks = [];

        this.wasm._lvglScreenLoad(-1, pageObj);

        runInAction(() => {
            this.page._lvglObj = pageObj;
        });

        this.pageObj = pageObj;
    }

    // run the LVGL main loop until the frame is stable
    async renderFrame(): Promise<RenderedFrame> {
        const size = this.displayWidth * this.displayHeight * 4;
        let frame: Uint8ClampedArray | undefined;
        let framesSinceChange = 0;

        for (let i = 0; i < 200; i++) {
            this.wasm._mainLoop();

            const bufAddr = this.wasm._getSyncedBuffer();
            if (bufAddr != 0) {
                frame = new Uint8ClampedArray(
                    this.wasm.HEAPU8.subarray(bufAddr, bufAddr + size)
                );
                framesSinceChange = 0;
            } else if (frame) {
                framesSinceChange++;
                // no new frame for a while: rendering has settled
                if (framesSinceChange >= 5) {
                    break;
                }
            }

            await sleep(frame ? 5 : 10);
        }

        if (!frame) {
            throw new Error("LVGL runtime did not produce a frame");
        }

        return {
            width: this.displayWidth,
            height: this.displayHeight,
            rgba: frame
        };
    }

    // widget geometry as computed by LVGL (absolute, in display pixels)
    getWidgetBoxes(): WidgetBox[] {
        const boxes: WidgetBox[] = [];

        const visit = (
            widgets: LVGLWidget[],
            parent: LVGLWidget | undefined,
            parentX: number,
            parentY: number,
            depth: number
        ) => {
            for (const widget of widgets) {
                if (!widget._lvglObj) {
                    continue;
                }
                let x = parentX;
                let y = parentY;
                let width = 0;
                let height = 0;
                try {
                    x += this.wasm._lvglGetObjRelX(widget._lvglObj);
                    y += this.wasm._lvglGetObjRelY(widget._lvglObj);
                    width = this.wasm._lvglGetObjWidth(widget._lvglObj);
                    height = this.wasm._lvglGetObjHeight(widget._lvglObj);
                } catch (err) {
                    continue;
                }
                boxes.push({ widget, parent, x, y, width, height, depth });
                if (widget.children) {
                    visit(widget.children, widget, x, y, depth + 1);
                }
            }
        };

        const screen = this.page.lvglScreenWidget;
        if (screen) {
            visit(screen.children, undefined, 0, 0, 0);
        } else {
            visit(this.page.components as any, undefined, 0, 0, 0);
        }

        return boxes;
    }

    unmount() {
        if (!this.isMounted) {
            return;
        }
        LVGLPageRuntime.detachRuntimeFromPage(this.page);
        this.isMounted = false;
    }
}
