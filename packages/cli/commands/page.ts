import type { Page } from "project-editor/features/page/page";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { createObject } from "project-editor/store";
import type { IEezObject } from "project-editor/core/object";

import { CommandDef } from "cli/registry";
import { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import {
    selectorOf,
    nameOf,
    getWidgetChildren,
    getScreenWidget,
    isPage
} from "cli/selectors";
import { classNameOf, describeObject, setProperties } from "cli/reflect";
import { table } from "cli/format";
import { deleteWithCheck, renameObject } from "cli/commands/obj";
import { fixName } from "cli/naming";

export function requirePage(ctx: CommandContext, selector: string): Page {
    const object = ctx.resolve(selector);
    if (!isPage(object)) {
        throw new CliError(`"${selector}" is not a page or user widget`);
    }
    return object;
}

function shortType(object: IEezObject) {
    return classNameOf(object).replace(/^LVGL/, "").replace(/Widget$/, "");
}

function widgetLine(widget: any) {
    const name = nameOf(widget);
    const unit = (u: string | undefined) => (u && u != "px" ? u : "");
    let geometry = "";
    if (widget.left !== undefined) {
        const w =
            widget.widthUnit == "content" ? "auto" : widget.width + unit(widget.widthUnit);
        const h =
            widget.heightUnit == "content" ? "auto" : widget.height + unit(widget.heightUnit);
        geometry = ` @${widget.left}${unit(widget.leftUnit)},${widget.top}${unit(
            widget.topUnit
        )} size=${w},${h}`;
    }
    let extra = "";
    if (typeof widget.text == "string" && widget.text) {
        extra += ` text=${JSON.stringify(widget.text)}`;
    }
    if (widget.useStyle) {
        extra += ` style=${widget.useStyle}`;
    }
    if (widget.localStyles?.hasModifications) {
        extra += " +local-styles";
    }
    return `${shortType(widget)}${name ? " " + name : ""}${geometry}${extra}`;
}

export function pageTree(page: Page, maxDepth = 100) {
    const lines: string[] = [];
    const nodes: any[] = [];

    const visit = (parent: IEezObject, depth: number, prefix: string) => {
        if (depth > maxDepth) {
            return;
        }
        const children = getWidgetChildren(parent);
        children.forEach((child: any, i: number) => {
            const last = i == children.length - 1;
            const selector = selectorOf(child);
            lines.push(
                `${prefix}${last ? "└─ " : "├─ "}${widgetLine(child)}   [${selector}]`
            );
            nodes.push({
                selector,
                depth,
                type: shortType(child),
                name: nameOf(child)
            });
            visit(child, depth + 1, prefix + (last ? "   " : "│  "));
        });
    };

    const screen = getScreenWidget(page);
    lines.push(
        `${selectorOf(page)} ${page.width}x${page.height}${
            screen ? `   [${selectorOf(page)}/$screen]` : ""
        }`
    );
    visit(page, 0, "");

    const flowComponents = page.components.filter(
        c => !(c instanceof ProjectEditor.WidgetClass)
    );
    if (flowComponents.length > 0) {
        lines.push("");
        lines.push(`flow: ${flowComponents.length} component(s), ${page.connectionLines.length} connection(s) — see "flow list ${page.name}"`);
    }

    return { text: lines.join("\n"), nodes };
}

const pageList: CommandDef = {
    name: "page list",
    aliases: ["pages"],
    summary: "List pages (and user widgets)",
    usage: "page list [--user-widgets]",
    booleans: ["user-widgets"],
    group: "pages",
    run(ctx) {
        const pages = ctx.flag("user-widgets")
            ? ctx.project.userWidgets ?? []
            : ctx.project.userPages;
        ctx.emit(
            pages.map(page => ({
                selector: selectorOf(page),
                name: page.name,
                width: page.width,
                height: page.height
            })),
            table(
                pages.map(page => [
                    selectorOf(page),
                    `${page.width}x${page.height}`,
                    page.description ?? ""
                ]),
                ["page", "size", "description"]
            )
        );
    }
};

const pageTreeCommand: CommandDef = {
    name: "page tree",
    aliases: ["tree"],
    summary: "Show the widget tree of a page with selectors",
    usage: "page tree [page] [--depth N]",
    group: "pages",
    run(ctx) {
        const page = ctx.argOpt(0)
            ? requirePage(ctx, ctx.arg(0, "page"))
            : ctx.project.userPages[0];
        if (!page) {
            throw new CliError("Project has no pages");
        }
        const { text, nodes } = pageTree(page, ctx.num("depth", 100));
        ctx.emit(nodes, text);
    }
};

function addPage(ctx: CommandContext, userWidget: boolean) {
    // pages: <name>_page, user widgets: snake_case
    const name = fixName(userWidget ? "plain" : "page", "Page", ctx.arg(0, "name"));
    const project = ctx.project;
    if (project.pages.find(page => page.name == name)) {
        throw new CliError(`A page or user widget "${name}" already exists`);
    }
    const size = ctx.pair("size");
    const width =
        size?.[0] ??
        (project.projectTypeTraits.isDashboard
            ? 800
            : project.settings.general.displayWidth ?? 480);
    const height =
        size?.[1] ??
        (project.projectTypeTraits.isDashboard
            ? 450
            : project.settings.general.displayHeight ?? 272);

    const page = createObject<Page>(
        ctx.store,
        {
            name,
            left: 0,
            top: 0,
            width,
            height,
            components: [],
            isUsedAsUserWidget: userWidget
        } as any,
        ProjectEditor.PageClass
    );

    const collection = userWidget ? project.userWidgets : project.userPages;
    const added = ctx.store.addObject(collection, page) as Page;

    const values = ctx.values(1);
    setProperties(ctx.store, added, values, { force: ctx.force });

    ctx.changed(`added ${selectorOf(added)} (${width}x${height})`);
    ctx.emit({ selector: selectorOf(added), width, height });
}

const pageAdd: CommandDef = {
    name: "page add",
    summary: "Add a page",
    usage: "page add <name> [--size WxH] [key=value ...]",
    mutating: true,
    group: "pages",
    run(ctx) {
        addPage(ctx, false);
    }
};

const userWidgetAdd: CommandDef = {
    name: "user-widget add",
    summary: "Add a user widget (reusable widget group)",
    usage: "user-widget add <name> [--size WxH] [key=value ...]",
    mutating: true,
    group: "pages",
    run(ctx) {
        addPage(ctx, true);
    }
};

const userWidgetList: CommandDef = {
    name: "user-widget list",
    summary: "List user widgets",
    usage: "user-widget list",
    group: "pages",
    run(ctx) {
        const pages = ctx.project.userWidgets ?? [];
        ctx.emit(
            pages.map(page => ({ selector: selectorOf(page), width: page.width, height: page.height })),
            table(
                pages.map(page => [selectorOf(page), `${page.width}x${page.height}`]),
                ["user widget", "size"]
            )
        );
    }
};

const pageRm: CommandDef = {
    name: "page rm",
    aliases: ["user-widget rm"],
    summary: "Remove a page or user widget",
    usage: "page rm <page> [--force]",
    mutating: true,
    group: "pages",
    run(ctx) {
        const page = requirePage(ctx, ctx.arg(0, "page"));
        deleteWithCheck(ctx, page);
    }
};

const pageRename: CommandDef = {
    name: "page rename",
    aliases: ["user-widget rename"],
    summary: "Rename a page and update references",
    usage: "page rename <page> <new-name>",
    mutating: true,
    group: "pages",
    run(ctx) {
        const page = requirePage(ctx, ctx.arg(0, "page"));
        renameObject(ctx, page, ctx.arg(1, "new-name"));
        ctx.emit({ selector: selectorOf(page) });
    }
};

const pageSet: CommandDef = {
    name: "page set",
    aliases: ["user-widget set"],
    summary: "Set page properties (size, description, ...)",
    usage: "page set <page> [--size WxH] [key=value ...]",
    mutating: true,
    group: "pages",
    run(ctx) {
        const page = requirePage(ctx, ctx.arg(0, "page"));
        const values: any = ctx.values(1);
        const size = ctx.pair("size");
        if (size) {
            values.width = size[0];
            values.height = size[1];
        }
        if (Object.keys(values).length == 0) {
            ctx.usage("nothing to set");
        }
        setProperties(ctx.store, page, values, { force: ctx.force });
        // keep the LVGL screen widget in sync with the page size
        const screen = getScreenWidget(page);
        if (screen && size) {
            setProperties(ctx.store, screen, { width: size[0], height: size[1] });
        }
        ctx.changed(`set ${selectorOf(page)}: ${Object.keys(values).join(", ")}`);
        ctx.emit(describeObject(page, { depth: 0, props: Object.keys(values) }));
    }
};

export const pageCommands: CommandDef[] = [
    pageList,
    pageTreeCommand,
    pageAdd,
    pageRm,
    pageRename,
    pageSet,
    userWidgetList,
    userWidgetAdd
];
