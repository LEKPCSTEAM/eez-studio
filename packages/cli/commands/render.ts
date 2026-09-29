import fs from "fs";
import path from "path";

import type { Page } from "project-editor/features/page/page";
import type { Theme } from "project-editor/features/style/theme";

import { CommandDef } from "cli/registry";
import { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import { selectorOf, nameOf, isPage } from "cli/selectors";
import { classNameOf } from "cli/reflect";
import { table } from "cli/format";
import { LVGLOffscreenPageRuntime, WidgetBox } from "cli/render/lvgl-offscreen";
import { encodePng, OverlayBox } from "cli/render/image";

export interface LayoutEntry {
    selector: string;
    type: string;
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hidden?: boolean;
    issues?: string[];
    // completely inside a sibling (not reported as an issue)
    stackedOn?: string[];
}

function intersects(a: WidgetBox, b: WidgetBox) {
    return (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
    );
}

function contains(outer: WidgetBox, inner: WidgetBox) {
    return (
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height
    );
}

function analyzeLayout(
    boxes: WidgetBox[],
    displayWidth: number,
    displayHeight: number,
    allowOverlap: Set<string> = new Set()
): LayoutEntry[] {
    const entries = new Map<WidgetBox, LayoutEntry>();

    for (const box of boxes) {
        const widget = box.widget as any;
        const hidden = widget.hiddenFlagType != "expression" && widget.hiddenFlag === true;
        const entry: LayoutEntry = {
            selector: selectorOf(box.widget),
            type: classNameOf(box.widget).replace(/^LVGL/, "").replace(/Widget$/, ""),
            name: nameOf(box.widget),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height
        };
        if (hidden) {
            entry.hidden = true;
        }
        const issues: string[] = [];
        if (!hidden) {
            if (box.width <= 0 || box.height <= 0) {
                issues.push("zero-size");
            }
            if (
                box.x < 0 ||
                box.y < 0 ||
                box.x + box.width > displayWidth ||
                box.y + box.height > displayHeight
            ) {
                issues.push("outside-screen");
            }
            if (box.parent) {
                const parentBox = boxes.find(b => b.widget === box.parent);
                if (
                    parentBox &&
                    (box.x < parentBox.x ||
                        box.y < parentBox.y ||
                        box.x + box.width > parentBox.x + parentBox.width ||
                        box.y + box.height > parentBox.y + parentBox.height)
                ) {
                    issues.push("overflows-parent");
                }
            }
        }
        if (issues.length > 0) {
            entry.issues = issues;
        }
        entries.set(box, entry);
    }

    // overlapping siblings
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.parent !== b.parent) continue;
            const ea = entries.get(a)!;
            const eb = entries.get(b)!;
            if (ea.hidden || eb.hidden) continue;
            if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) continue;
            if (!intersects(a, b)) continue;
            if (allowOverlap.has(ea.name ?? "") || allowOverlap.has(eb.name ?? "")) continue;
            if (contains(a, b) || contains(b, a)) {
                // one widget completely on top of another (label in the
                // middle of an arc, icon on a panel ...): usually intended
                const [outer, inner] = contains(a, b) ? [ea, eb] : [eb, ea];
                (inner.stackedOn ??= []).push(outer.selector);
                continue;
            }
            (ea.issues ??= []).push(`overlaps ${eb.selector}`);
            (eb.issues ??= []).push(`overlaps ${ea.selector}`);
        }
    }

    return boxes.map(box => entries.get(box)!);
}

function defaultOutputPath(ctx: CommandContext, page: Page, suffix = "") {
    const dir = path.join(
        path.dirname(ctx.session.filePath!),
        ".eez-render"
    );
    const name = (page.name || "page").replace(/[^\w.-]+/g, "_");
    return path.join(dir, `${name}${suffix}.png`);
}

function selectTheme(ctx: CommandContext) {
    const themeName = ctx.str("theme");
    if (!themeName) {
        return undefined;
    }
    const theme = ctx.project.themes.find(t => t.name == themeName);
    if (!theme) {
        throw new CliError(
            `Theme "${themeName}" not found`,
            `themes: ${ctx.project.themes.map(t => t.name).join(", ")}`
        );
    }
    return theme;
}

export async function renderLvglPage(
    ctx: CommandContext,
    page: Page,
    options: {
        output?: string;
        scale?: number;
        bounds?: boolean;
        dark?: boolean;
        theme?: Theme;
        allowOverlap?: Set<string>;
    }
) {
    const project = ctx.project;

    const width = page.width || project.settings.general.displayWidth;
    const height = page.height || project.settings.general.displayHeight;

    // themed colors in editor mode come from the selected theme
    const navigationStore = ctx.store.navigationStore;
    const previousTheme = navigationStore?.selectedThemeObject.get();
    if (navigationStore) {
        navigationStore.selectedThemeObject.set(
            options.theme ?? previousTheme ?? project.themes[0]
        );
    }

    const runtime = new LVGLOffscreenPageRuntime(
        page,
        width,
        height,
        options.dark ?? project.settings.general.darkTheme
    );

    try {
        await runtime.mountAsync();
        const frame = await runtime.renderFrame();
        const boxes = runtime.getWidgetBoxes();
        const layout = analyzeLayout(boxes, width, height, options.allowOverlap);

        const overlay: OverlayBox[] | undefined = options.bounds
            ? boxes.map((box, i) => ({
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                  depth: box.depth,
                  label: layout[i].name ?? `[${layout[i].type}]`,
                  issue: !!layout[i].issues?.some(
                      issue => issue != "overflows-parent"
                  )
              }))
            : undefined;

        const png = encodePng(frame, {
            scale: options.scale,
            boxes: overlay
        });

        const output = options.output
            ? path.resolve(ctx.cwd, options.output)
            : defaultOutputPath(ctx, page, options.bounds ? ".bounds" : "");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, png);

        return { output, png, width, height, layout };
    } finally {
        runtime.unmount();
        if (navigationStore) {
            navigationStore.selectedThemeObject.set(previousTheme as any);
        }
    }
}

export async function renderPage(
    ctx: CommandContext,
    page: Page,
    options: {
        output?: string;
        scale?: number;
        bounds?: boolean;
        dark?: boolean;
        theme?: Theme;
        allowOverlap?: Set<string>;
    }
) {
    if (ctx.store.projectTypeTraits.isLVGL) {
        return renderLvglPage(ctx, page, options);
    }
    const { renderDomPage } = await import("cli/render/dom-capture");
    return renderDomPage(ctx, page, options);
}

function layoutText(layout: LayoutEntry[]) {
    return table(
        layout.map(entry => [
            entry.selector,
            entry.type,
            `${entry.x},${entry.y}`,
            `${entry.width}x${entry.height}`,
            (entry.hidden ? "hidden " : "") +
                (entry.issues?.join("; ") ?? "") +
                (entry.stackedOn ? ` (on ${entry.stackedOn.join(", ")})` : "")
        ]),
        ["widget", "type", "pos", "size", "issues / notes"]
    );
}

const renderPageCommand: CommandDef = {
    name: "render page",
    aliases: ["render"],
    summary: "Render a page to PNG (and report widget layout)",
    usage: `render page <page|user-widget> [-o out.png] [--scale N] [--bounds] [--layout]
                [--dark] [--theme name]
  --bounds   draw widget boxes and names on top of the image (for layout review)
  --layout   print computed widget positions/sizes and layout issues
             (overlaps, outside screen, overflows parent, zero size)
  --allow-overlap a,b   widgets that may overlap their siblings
             (a widget completely inside a sibling is never reported as an overlap)
  default output: <project folder>/.eez-render/<page>.png`,
    booleans: ["bounds", "layout", "dark"],
    group: "render",
    async run(ctx) {
        const selector = ctx.argOpt(0);
        let page: Page;
        if (selector) {
            const object = ctx.resolve(selector);
            if (!isPage(object)) {
                throw new CliError(`"${selector}" is not a page or user widget`);
            }
            page = object;
        } else {
            page = ctx.project.userPages[0];
            if (!page) {
                throw new CliError("Project has no pages");
            }
        }

        const result = await renderPage(ctx, page, {
            output: ctx.str("output"),
            scale: ctx.num("scale"),
            bounds: ctx.flag("bounds"),
            allowOverlap: new Set(ctx.list("allow-overlap")),
            dark: ctx.raw("dark") === undefined ? undefined : ctx.flag("dark"),
            theme: selectTheme(ctx)
        });

        ctx.files.push(result.output);
        ctx.images.push({ data: result.png, mimeType: "image/png" });

        const issues = result.layout.filter(entry => entry.issues);

        let text = `rendered ${selectorOf(page)} (${result.width}x${result.height}) -> ${result.output}`;
        if (ctx.flag("layout")) {
            text += "\n\n" + layoutText(result.layout);
        } else if (issues.length > 0) {
            text += `\n${issues.length} widget(s) with layout issues (use --layout to see all):\n`;
            text += layoutText(issues);
        }

        ctx.emit(
            {
                page: selectorOf(page),
                file: result.output,
                width: result.width,
                height: result.height,
                layout: ctx.flag("layout") ? result.layout : undefined,
                issues: issues.length > 0 ? issues : undefined
            },
            text
        );
    }
};

const renderAllCommand: CommandDef = {
    name: "render all",
    summary: "Render every page to PNG files",
    usage: "render all [-o dir] [--scale N] [--bounds] [--user-widgets] [--dark] [--theme name]",
    booleans: ["bounds", "dark", "user-widgets"],
    group: "render",
    async run(ctx) {
        const dir = ctx.str("output");
        const pages = [
            ...ctx.project.userPages,
            ...(ctx.flag("user-widgets") ? ctx.project.userWidgets ?? [] : [])
        ];
        const results: any[] = [];
        const lines: string[] = [];
        for (const page of pages) {
            const output = dir
                ? path.join(
                      path.resolve(ctx.cwd, dir),
                      (page.name || "page").replace(/[^\w.-]+/g, "_") + ".png"
                  )
                : undefined;
            const result = await renderPage(ctx, page, {
                output,
                scale: ctx.num("scale"),
                bounds: ctx.flag("bounds"),
                allowOverlap: new Set(ctx.list("allow-overlap")),
                dark: ctx.raw("dark") === undefined ? undefined : ctx.flag("dark"),
                theme: selectTheme(ctx)
            });
            ctx.files.push(result.output);
            ctx.images.push({ data: result.png, mimeType: "image/png" });
            const issues = result.layout.filter(entry => entry.issues).length;
            results.push({
                page: selectorOf(page),
                file: result.output,
                issues
            });
            lines.push(
                `${selectorOf(page)} -> ${result.output}${
                    issues ? `  (${issues} layout issue(s))` : ""
                }`
            );
        }
        ctx.emit(results, lines.join("\n"));
    }
};

export const renderCommands: CommandDef[] = [renderPageCommand, renderAllCommand];
