import { isArray } from "eez-studio-shared/util";

import {
    EezObject,
    IEezObject,
    getParent,
    getClassesDerivedFrom,
    isSubclassOf
} from "project-editor/core/object";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Page } from "project-editor/features/page/page";

import { CommandDef } from "cli/registry";
import { CommandContext } from "cli/context";
import { CliError, UsageError } from "cli/errors";
import {
    selectorOf,
    getWidgetChildrenCollection
} from "cli/selectors";
import {
    addNewObject,
    classNameOf,
    describeObject,
    getEnumItems,
    requireClass,
    setProperties
} from "cli/reflect";
import { table } from "cli/format";
import {
    deleteWithCheck,
    moveObject,
    objectSummary,
    requireObject,
    renameObject
} from "cli/commands/obj";
import { requirePage } from "cli/commands/page";
import { conventionalName, findNameConflict } from "cli/naming";

////////////////////////////////////////////////////////////////////////////////

export function isWidget(object: IEezObject) {
    return object instanceof ProjectEditor.WidgetClass;
}

export function requireWidget(ctx: CommandContext, selector: string) {
    const object = requireObject(ctx, selector);
    if (!isWidget(object)) {
        throw new CliError(`"${selector}" is not a widget (${classNameOf(object)})`);
    }
    return object as any;
}

function paletteWidgetClasses(ctx: CommandContext) {
    const store = ctx.store;
    const projectType = ctx.project.settings.general.projectType;
    const baseClass = store.projectTypeTraits.isLVGL
        ? ProjectEditor.LVGLWidgetClass
        : ProjectEditor.WidgetClass;
    return getClassesDerivedFrom(store, baseClass).filter(c => {
        const classInfo = c.objectClass.classInfo;
        if (c.name == "LVGLScreenWidget") {
            return false;
        }
        if (
            !store.projectTypeTraits.isLVGL &&
            isSubclassOf(classInfo, ProjectEditor.LVGLWidgetClass.classInfo)
        ) {
            return false;
        }
        if (classInfo.enabledInComponentPalette) {
            try {
                return classInfo.enabledInComponentPalette(projectType as any, store);
            } catch (err) {
                return false;
            }
        }
        return true;
    });
}

export function shortWidgetName(className: string) {
    return className.replace(/^LVGL/, "").replace(/Widget$/, "");
}

// "120" | "50%" | "content" | "120px"
function parseSize(value: string, isLVGL: boolean): { value?: number; unit?: string } {
    const v = value.trim().toLowerCase();
    if (v == "content" || v == "auto") {
        if (!isLVGL) {
            throw new UsageError(`"content" size is only supported in LVGL projects`);
        }
        return { unit: "content" };
    }
    const match = v.match(/^(-?\d+(?:\.\d+)?)(px|%)?$/);
    if (!match) {
        throw new UsageError(`invalid size "${value}" (use e.g. 120, 50%, content)`);
    }
    const n = Number(match[1]);
    if (match[2] == "%") {
        if (!isLVGL) {
            throw new UsageError(`"%" size is only supported in LVGL projects`);
        }
        return { value: n, unit: "%" };
    }
    return { value: n, unit: isLVGL ? "px" : undefined };
}

function splitPair(text: string, option: string): [string, string] {
    const parts = text.split(/[,x×]/i);
    if (parts.length != 2) {
        throw new UsageError(`--${option} expects two values, e.g. 10,20 or 100x50`);
    }
    return [parts[0], parts[1]];
}

// geometry, flags, states, style options shared by "widget add" and "widget set"
export function widgetOptionValues(ctx: CommandContext, widget: any): any {
    const isLVGL = widget instanceof ProjectEditor.LVGLWidgetClass;
    const values: any = {};

    // an empty half of --at / --size (",20", "100,") keeps that value
    const at = ctx.str("at");
    if (at) {
        const pair = splitPair(at, "at");
        ["left", "top"].forEach((prop, i) => {
            if (!pair[i].trim()) return;
            const p = parseSize(pair[i], isLVGL);
            if (p.value === undefined) {
                throw new UsageError(`--at expects numbers (px or %)`);
            }
            values[prop] = p.value;
            if (isLVGL) values[prop + "Unit"] = p.unit;
        });
    }

    const size = ctx.str("size");
    if (size) {
        const pair = splitPair(size, "size");
        ["width", "height"].forEach((prop, i) => {
            if (!pair[i].trim()) return;
            const p = parseSize(pair[i], isLVGL);
            if (p.value !== undefined) values[prop] = p.value;
            if (isLVGL) values[prop + "Unit"] = p.unit;
        });
    }

    const style = ctx.str("style");
    if (style !== undefined) {
        if (isLVGL) {
            values.useStyle = style == "none" ? "" : style;
        } else {
            values.style = { useStyle: style };
        }
    }

    if (isLVGL) {
        applyFlagChanges(ctx, widget, values);
    }

    return values;
}

function parseFlagChanges(text: string) {
    const add: string[] = [];
    const remove: string[] = [];
    for (let token of text.split(/[,|\s]+/)) {
        token = token.trim();
        if (!token) continue;
        if (token.startsWith("-")) {
            remove.push(token.substring(1).toUpperCase());
        } else {
            add.push(token.replace(/^\+/, "").toUpperCase());
        }
    }
    return { add, remove };
}

const REACTIVE_FLAGS: { [flag: string]: string } = {
    HIDDEN: "hiddenFlag",
    CLICKABLE: "clickableFlag"
};

const REACTIVE_STATES: { [state: string]: string } = {
    CHECKED: "checkedState",
    DISABLED: "disabledState"
};

function applyFlagChanges(ctx: CommandContext, widget: any, values: any) {
    const flagsText = ([] as string[])
        .concat((ctx.opts.flag ?? []) as any)
        .filter(v => typeof v == "string")
        .join(",");
    if (flagsText) {
        const { add, remove } = parseFlagChanges(flagsText);
        const allowed = allowedFlags(widget);
        let flags = new Set<string>(
            (values.widgetFlags ?? widget.widgetFlags ?? "")
                .split("|")
                .filter(Boolean)
        );
        for (const flag of [...add, ...remove]) {
            if (!REACTIVE_FLAGS[flag] && allowed && !allowed.includes(flag)) {
                throw new CliError(
                    `Unknown flag "${flag}"`,
                    `flags: ${[...Object.keys(REACTIVE_FLAGS), ...allowed].join(", ")}`
                );
            }
        }
        for (const flag of add) {
            if (REACTIVE_FLAGS[flag]) {
                values[REACTIVE_FLAGS[flag]] = true;
                values[REACTIVE_FLAGS[flag] + "Type"] = "literal";
            } else {
                flags.add(flag);
            }
        }
        for (const flag of remove) {
            if (REACTIVE_FLAGS[flag]) {
                values[REACTIVE_FLAGS[flag]] = false;
                values[REACTIVE_FLAGS[flag] + "Type"] = "literal";
            } else {
                flags.delete(flag);
            }
        }
        values.widgetFlags = [...flags].join("|");
    }

    const statesText = ([] as string[])
        .concat((ctx.opts.state ?? []) as any)
        .filter(v => typeof v == "string")
        .join(",");
    if (statesText) {
        const { add, remove } = parseFlagChanges(statesText);
        let states = new Set<string>(
            (values.states ?? widget.states ?? "").split("|").filter(Boolean)
        );
        for (const state of add) {
            if (REACTIVE_STATES[state]) {
                values[REACTIVE_STATES[state]] = true;
                values[REACTIVE_STATES[state] + "Type"] = "literal";
            } else {
                states.add(state);
            }
        }
        for (const state of remove) {
            if (REACTIVE_STATES[state]) {
                values[REACTIVE_STATES[state]] = false;
                values[REACTIVE_STATES[state] + "Type"] = "literal";
            } else {
                states.delete(state);
            }
        }
        values.states = [...states].join("|");
    }
}

function allowedFlags(widget: any): string[] | undefined {
    try {
        const {
            LVGL_FLAG_CODES
        } = require("project-editor/lvgl/lvgl-constants");
        return Object.keys(LVGL_FLAG_CODES);
    } catch (err) {
        return undefined;
    }
}

// where to put a new widget: --parent <widget selector> or --page <page>
function resolveWidgetContainer(ctx: CommandContext): EezObject[] {
    const parentSelector = ctx.str("parent");
    const pageSelector = ctx.str("page");

    let container: IEezObject;
    if (parentSelector) {
        container = ctx.resolve(parentSelector);
        if (isArray(container)) {
            return container as EezObject[];
        }
    } else if (pageSelector) {
        container = requirePage(ctx, pageSelector);
    } else {
        const page = ctx.project.userPages[0];
        if (!page) {
            throw new CliError("Project has no pages", 'add one with "page add Main"');
        }
        container = page;
    }

    const collection = getWidgetChildrenCollection(container);
    if (!collection) {
        throw new CliError(
            `${selectorOf(container)} can't contain widgets`,
            "use a container widget (e.g. Container, Panel, Tab) or a page"
        );
    }
    return collection;
}

////////////////////////////////////////////////////////////////////////////////

const typesCommand: CommandDef = {
    name: "widget types",
    summary: "List the widget types available in this project",
    usage: "widget types",
    group: "widgets",
    run(ctx) {
        const classes = paletteWidgetClasses(ctx);
        const rows = classes
            .map(c => ({
                type: shortWidgetName(c.name),
                class: c.name,
                group: c.objectClass.classInfo.componentPaletteGroupName ?? ""
            }))
            .sort((a, b) =>
                a.group == b.group
                    ? a.type.localeCompare(b.type)
                    : a.group.localeCompare(b.group)
            );
        ctx.emit(
            rows,
            table(
                rows.map(r => [r.type, r.class, r.group.replace(/^!\d+/, "")]),
                ["type", "class", "group"]
            ) + '\n\nuse "schema class <type>" to see the properties of a widget type'
        );
    }
};

const addCommand: CommandDef = {
    name: "widget add",
    summary: "Add a widget to a page or container widget",
    usage: `widget add <type> [--page P | --parent <widget|collection>] [--name id]
           [--at x,y] [--size w,h] [--index i] [--style S] [--flag +A,-B] [--state +S]
           [key=value ...] [--values JSON]
  <type>     widget type, e.g. Button, Label, Panel, Slider (see "widget types")
  --at       position, px or % (LVGL), e.g. 10,20 or 50%,0
  --size     size: px, %, or content (LVGL), e.g. 120,40 or 100%,content
  --flag     LVGL flags to add/remove: +HIDDEN,-CLICKABLE,+SCROLLABLE ...
  --state    LVGL states: +CHECKED,+DISABLED,+FOCUSED ...
  --style    style name (LVGL: useStyle)
  --no-label remove the default Label child (e.g. of a Button)
  --icon IMG replace the default Label child with a centered Image of bitmap IMG
  prints the selector of the new widget`,
    booleans: ["no-label"],
    mutating: true,
    group: "widgets",
    async run(ctx) {
        const typeName = ctx.arg(0, "type");
        const store = ctx.store;
        const baseClass = store.projectTypeTraits.isLVGL
            ? ProjectEditor.LVGLWidgetClass
            : ProjectEditor.WidgetClass;
        const { name: className, aClass } = requireClass(
            store,
            typeName,
            baseClass,
            "widget type"
        );

        const collection = resolveWidgetContainer(ctx);

        const values: any = ctx.values(1);
        const name = ctx.str("name");
        let nameNote: string | undefined;
        if (name) {
            const properties = aClass.classInfo.properties;
            if (properties.find(p => p.name == "identifier")) {
                values.identifier = name;
                const fixed = conventionalName("widget", className, name);
                const conflict = findNameConflict(ctx.project, undefined, "identifier", fixed);
                if (conflict) {
                    throw new CliError(
                        `The name "${fixed}" is already used by ${selectorOf(conflict)}`,
                        "widget names must be unique in the project"
                    );
                }
            } else if (properties.find(p => p.name == "name")) {
                values.name = name;
            } else {
                nameNote = `note: ${shortWidgetName(className)} widgets have no name, --name ignored (use the selector printed above)`;
            }
        }

        const index = ctx.num("index");

        const widget = addNewObject(store, collection, className, aClass, {}, {
            index
        }) as any;

        const optionValues = widgetOptionValues(ctx, widget);
        setProperties(store, widget, { ...optionValues, ...values }, { force: ctx.force });

        // default child label (Button ...): remove, or replace with an icon
        const icon = ctx.str("icon");
        if ((ctx.flag("no-label") || icon) && Array.isArray(widget.children)) {
            const labels = widget.children.filter(
                (child: any) => classNameOf(child) == "LVGLLabelWidget"
            );
            if (labels.length > 0) {
                store.deleteObjects(labels);
            }
        }

        const selector = selectorOf(widget);
        ctx.changed(`added ${selector} (${shortWidgetName(className)})`);

        let iconSelector: string | undefined;
        if (icon) {
            if (!store.projectTypeTraits.isLVGL) {
                throw new UsageError("--icon is only supported in LVGL projects");
            }
            const image = await ctx.runner.executeNested(
                [
                    "widget",
                    "add",
                    "Image",
                    "--parent",
                    selector,
                    ...(name ? ["--name", `${name}_icon`] : []),
                    `image=${icon}`
                ],
                ctx
            );
            iconSelector = image.emitted[0]?.data?.selector;
            ctx.changes.push(...image.changes);
            if (iconSelector) {
                const style = await ctx.runner.executeNested(
                    ["widget", "style", "set", iconSelector, "align=CENTER"],
                    ctx
                );
                ctx.changes.push(...style.changes);
            }
        }

        ctx.emit(
            { selector, class: className, objID: widget.objID, icon: iconSelector, note: nameNote },
            selector + (nameNote ? "\n" + nameNote : "")
        );
    }
};

const setCommand: CommandDef = {
    name: "widget set",
    summary: "Change widget properties, geometry, flags, states or style",
    usage: `widget set <widget> [--at x,y] [--size w,h] [--flag +A,-B] [--state +S]
           [--style S|none] [--name new-id] [key=value ...] [--values JSON]
  --at ,20 / --size 100,   leave out one value to keep it`,
    mutating: true,
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const values = { ...widgetOptionValues(ctx, widget), ...ctx.values(1) };
        const newName = ctx.str("name");
        if (Object.keys(values).length == 0 && !newName) {
            ctx.usage("nothing to set");
        }
        setProperties(ctx.store, widget, values, { force: ctx.force });
        if (newName) {
            renameObject(ctx, widget, newName);
        }
        ctx.changed(
            `set ${selectorOf(widget)}: ${[
                ...Object.keys(values),
                ...(newName ? ["name"] : [])
            ].join(", ")}`
        );
        ctx.emit(
            describeObject(widget, {
                depth: 0,
                props: Object.keys(values).map(k => k.split(".")[0])
            })
        );
    }
};

const getCommand: CommandDef = {
    name: "widget get",
    summary: "Show widget properties",
    usage: "widget get <widget> [--props a,b] [--depth N] [--all]",
    booleans: ["all"],
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const props = ctx.list("props");
        ctx.emit(
            describeObject(widget, {
                depth: ctx.num("depth", 0),
                props: props.length ? props : undefined,
                includeHidden: ctx.flag("all")
            })
        );
    }
};

const rmCommand: CommandDef = {
    name: "widget rm",
    summary: "Remove a widget (and its children)",
    usage: "widget rm <widget> [--force]",
    mutating: true,
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        if (widget instanceof ProjectEditor.LVGLScreenWidgetClass) {
            throw new CliError("The screen widget of a page can't be removed");
        }
        deleteWithCheck(ctx, widget);
    }
};

const moveCommand: CommandDef = {
    name: "widget move",
    summary: "Move a widget to another parent and/or position in the child list",
    usage: `widget move <widget> [--parent <widget|page>] [--index i]
  --index 0 brings to back, no --index appends (drawn on top)`,
    mutating: true,
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const parentSelector = ctx.str("parent");
        let target: EezObject[];
        if (parentSelector) {
            const container = ctx.resolve(parentSelector);
            const collection = isArray(container)
                ? (container as EezObject[])
                : getWidgetChildrenCollection(container);
            if (!collection) {
                throw new CliError(`${parentSelector} can't contain widgets`);
            }
            target = collection;
        } else {
            target = getParent(widget) as EezObject[];
        }
        moveObject(ctx, widget, target, ctx.num("index"));
        ctx.changed(`moved ${selectorOf(widget)}`);
        ctx.emit(objectSummary(widget), selectorOf(widget));
    }
};

////////////////////////////////////////////////////////////////////////////////

function getWidgetEventNames(widget: any): string[] {
    const handlerProperty = widget.eventHandlers;
    if (!handlerProperty) {
        return [];
    }
    const EventHandlerClass = require("project-editor/flow/component").EventHandler;
    const prototype = new EventHandlerClass();
    const propertyInfo = EventHandlerClass.classInfo.properties.find(
        (p: any) => p.name == "eventName"
    );
    try {
        (prototype as any)._eez_parent = handlerProperty;
        const items = getEnumItems(prototype, propertyInfo);
        return (items ?? []).map(item => String(item.id));
    } catch (err) {
        return [];
    }
}

const eventAdd: CommandDef = {
    name: "widget event add",
    summary: "Add an event handler to a widget",
    usage: `widget event add <widget> --event CLICKED (--action <action-name> | --flow)
           [--user-data N]
  --action  call a user action (native/flow action from "action list")
  --flow    handle the event in the page flow (connect the event output)`,
    booleans: ["flow"],
    mutating: true,
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const eventName = ctx.requireStr("event").toUpperCase();
        const action = ctx.str("action");
        const flow = ctx.flag("flow");
        if (!action && !flow) {
            ctx.usage("pass --action <name> or --flow");
        }
        const names = getWidgetEventNames(widget);
        if (names.length > 0 && !names.includes(eventName)) {
            throw new CliError(
                `Unknown event "${eventName}" for ${shortWidgetName(classNameOf(widget))}`,
                `events: ${names.join(", ")}`
            );
        }
        const EventHandlerClass = require("project-editor/flow/component").EventHandler;
        const values: any = {
            eventName,
            handlerType: action ? "action" : "flow"
        };
        if (action) values.action = action;
        const userData = ctx.num("user-data");
        if (userData !== undefined) values.userData = userData;
        const handler = addNewObject(
            ctx.store,
            widget.eventHandlers,
            "EventHandler",
            EventHandlerClass,
            values,
            { force: ctx.force }
        );
        ctx.changed(`added ${eventName} handler to ${selectorOf(widget)}`);
        ctx.emit(objectSummary(handler));
    }
};

const eventRm: CommandDef = {
    name: "widget event rm",
    summary: "Remove event handler(s) from a widget",
    usage: "widget event rm <widget> --event CLICKED",
    mutating: true,
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const eventName = ctx.requireStr("event").toUpperCase();
        const handlers = (widget.eventHandlers ?? []).filter(
            (h: any) => h.eventName == eventName
        );
        if (handlers.length == 0) {
            throw new CliError(`${selectorOf(widget)} has no ${eventName} handler`);
        }
        ctx.store.deleteObjects(handlers);
        ctx.changed(`removed ${handlers.length} ${eventName} handler(s) from ${selectorOf(widget)}`);
    }
};

const eventList: CommandDef = {
    name: "widget event list",
    summary: "List event handlers of a widget and the events it supports",
    usage: "widget event list <widget>",
    group: "widgets",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const handlers = (widget.eventHandlers ?? []).map((h: any) => ({
            event: h.eventName,
            handlerType: h.handlerType,
            action: h.action,
            userData: h.userData
        }));
        const events = getWidgetEventNames(widget);
        ctx.emit(
            { handlers, events },
            table(
                handlers.map((h: any) => [h.event, h.handlerType, h.action ?? "", h.userData ?? ""]),
                ["event", "type", "action", "user data"]
            ) + `\n\nsupported events: ${events.join(", ")}`
        );
    }
};

export const widgetCommands: CommandDef[] = [
    typesCommand,
    addCommand,
    setCommand,
    getCommand,
    rmCommand,
    moveCommand,
    eventAdd,
    eventRm,
    eventList
];

export type { Page };
