import { toJS } from "mobx";

import { ProjectEditor } from "project-editor/project-editor-interface";
import { createObject } from "project-editor/store";
import { getClassInfoLvglParts } from "project-editor/core/object";
import type { LVGLStyle } from "project-editor/lvgl/style";
import type { LVGLStylesDefinition } from "project-editor/lvgl/style-definition";
import {
    lvglProperties,
    lvglPropertiesMap,
    unusedProperties,
    LVGLPropertyInfo,
    PropertyValueHolder,
    isLvglStylePropertySupported
} from "project-editor/lvgl/style-catalog";
import {
    LVGL_STATE_CODES,
    LVGL_STATE_CODES_MORE
} from "project-editor/lvgl/lvgl-constants";

import { CommandDef } from "cli/registry";
import { fixName } from "cli/naming";
import { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import { selectorOf } from "cli/selectors";
import { coerceValue, propertyTypeName, getEnumItems, requireClass } from "cli/reflect";
import { table } from "cli/format";
import { deleteWithCheck, renameObject } from "cli/commands/obj";
import { requireWidget, shortWidgetName } from "cli/commands/widget";
import { suggest, suggestHint } from "cli/suggest";

////////////////////////////////////////////////////////////////////////////////

function requireLVGL(ctx: CommandContext) {
    if (!ctx.store.projectTypeTraits.isLVGL) {
        throw new CliError(
            "LVGL styles are only available in LVGL projects",
            'for EEZ-GUI/dashboard projects use "style ..." commands'
        );
    }
}

function allStates() {
    return [
        ...Object.keys(LVGL_STATE_CODES_MORE).filter(s => s == "DEFAULT"),
        ...Object.keys(LVGL_STATE_CODES),
        ...Object.keys(LVGL_STATE_CODES_MORE).filter(s => s != "DEFAULT")
    ];
}

function normalizePart(ctx: CommandContext, parts: string[] | undefined) {
    const part = (ctx.str("part") ?? "MAIN").toUpperCase();
    if (parts && parts.length > 0 && !parts.includes(part)) {
        throw new CliError(`Invalid part "${part}"`, `parts: ${parts.join(", ")}`);
    }
    return part;
}

function normalizeState(ctx: CommandContext) {
    const state = (ctx.str("state") ?? "DEFAULT").toUpperCase();
    const states = allStates();
    if (!states.includes(state)) {
        throw new CliError(`Invalid state "${state}"`, `states: ${states.join(", ")}`);
    }
    return state;
}

export function requireStyleProperty(ctx: CommandContext, name: string): LVGLPropertyInfo {
    const normalized = name.toLowerCase().replace(/-/g, "_");
    const propertyInfo = lvglPropertiesMap.get(normalized);
    if (!propertyInfo) {
        const names = [...lvglPropertiesMap.keys()].filter(key =>
            isLvglStylePropertySupported(ctx.project, lvglPropertiesMap.get(key)!)
        );
        throw new CliError(
            `Unknown LVGL style property "${name}"`,
            (suggest(name, names).length > 0 ? suggestHint(name, names) : undefined) ??
                'run "lvgl-style props --search <text>" to list style properties'
        );
    }
    if (!isLvglStylePropertySupported(ctx.project, propertyInfo)) {
        throw new CliError(
            `Style property "${name}" is not supported in LVGL ${ctx.project.settings.general.lvglVersion}`
        );
    }
    return propertyInfo;
}

export function coerceStyleValue(
    ctx: CommandContext,
    propertyInfo: LVGLPropertyInfo,
    raw: any
) {
    const holder = new PropertyValueHolder(ctx.store, propertyInfo.name, undefined);
    (holder as any)._eez_parent = ctx.project;
    return coerceValue(holder, propertyInfo, raw, { force: ctx.force });
}

// apply "prop=value" pairs to a styles definition (part/state from options)
export function updateDefinition(
    ctx: CommandContext,
    stylesDefinition: LVGLStylesDefinition,
    parts: string[] | undefined,
    set: { [name: string]: any },
    unset: string[]
) {
    const part = normalizePart(ctx, parts);
    const state = normalizeState(ctx);

    let definition = toJS(stylesDefinition.definition);
    const holder = Object.assign(Object.create(Object.getPrototypeOf(stylesDefinition)), {
        definition
    });

    for (const name of Object.keys(set)) {
        const propertyInfo = requireStyleProperty(ctx, name);
        const value = coerceStyleValue(ctx, propertyInfo, set[name]);
        holder.definition = stylesDefinition.addPropertyToDefinition.call(
            holder,
            propertyInfo,
            part,
            state,
            value
        );
    }

    for (const name of unset) {
        const propertyInfo = requireStyleProperty(ctx, name);
        holder.definition = stylesDefinition.removePropertyFromDefinition.call(
            holder,
            propertyInfo,
            part,
            state
        );
    }

    ctx.store.updateObject(stylesDefinition, { definition: holder.definition });

    return { part, state };
}

function definitionText(definition: any) {
    if (!definition || Object.keys(definition).length == 0) {
        return "(no properties)";
    }
    const rows: any[] = [];
    for (const part of Object.keys(definition)) {
        for (const state of Object.keys(definition[part])) {
            for (const name of Object.keys(definition[part][state])) {
                rows.push([part, state, name, JSON.stringify(definition[part][state][name])]);
            }
        }
    }
    return table(rows, ["part", "state", "property", "value"]);
}

function requireStyle(ctx: CommandContext, name: string): LVGLStyle {
    requireLVGL(ctx);
    const object = ctx.resolve(name.includes(":") ? name : `lvglStyle:${name}`);
    if (!(object instanceof ProjectEditor.LVGLStyleClass)) {
        throw new CliError(`"${name}" is not an LVGL style`);
    }
    return object as LVGLStyle;
}

function widgetTypeClassName(ctx: CommandContext, type: string) {
    return requireClass(ctx.store, type, ProjectEditor.LVGLWidgetClass, "widget type").name;
}

function stylePartsFor(ctx: CommandContext, style: LVGLStyle): string[] | undefined {
    try {
        const { aClass } = requireClass(ctx.store, style.forWidgetType);
        const proto = new aClass();
        (proto as any)._eez_parent = ctx.project.userPages;
        return getClassInfoLvglParts(proto as any);
    } catch (err) {
        return undefined;
    }
}

////////////////////////////////////////////////////////////////////////////////

const listCommand: CommandDef = {
    name: "lvgl-style list",
    summary: "List LVGL styles",
    usage: "lvgl-style list",
    group: "lvgl styles",
    run(ctx) {
        requireLVGL(ctx);
        const styles = ctx.project.allLvglStyles;
        const defaults = ctx.project.lvglStyles.defaultStyles as any;
        const rows = styles.map(style => ({
            selector: selectorOf(style),
            name: style.name,
            forWidgetType: style.forWidgetType,
            default: defaults[style.forWidgetType] == style.name || undefined
        }));
        ctx.emit(
            rows,
            table(
                rows.map(r => [
                    r.selector,
                    shortWidgetName(r.forWidgetType ?? ""),
                    r.default ? "default" : ""
                ]),
                ["style", "for", ""]
            )
        );
    }
};

const showCommand: CommandDef = {
    name: "lvgl-style show",
    summary: "Show the properties of an LVGL style",
    usage: "lvgl-style show <style>",
    group: "lvgl styles",
    run(ctx) {
        const style = requireStyle(ctx, ctx.arg(0, "style"));
        const definition = toJS(style.definition?.definition) ?? {};
        ctx.emit(
            {
                selector: selectorOf(style),
                name: style.name,
                forWidgetType: style.forWidgetType,
                definition
            },
            `${selectorOf(style)} (for ${shortWidgetName(style.forWidgetType)})\n\n${definitionText(definition)}`
        );
    }
};

const addCommand: CommandDef = {
    name: "lvgl-style add",
    summary: "Create an LVGL style for a widget type",
    usage: `lvgl-style add <name> --for <widget-type> [--parent <style>] [--default]
           [--part MAIN] [--state DEFAULT] [prop=value ...]
  e.g.  lvgl-style add PrimaryButton --for Button bg_color=#2196F3 radius=8
  --default  make it the default style for that widget type`,
    booleans: ["default"],
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        requireLVGL(ctx);
        const name = fixName("plain", "LVGLStyle", ctx.arg(0, "name"));
        if (ctx.project.allLvglStyles.find(s => s.name == name)) {
            throw new CliError(`LVGL style "${name}" already exists`);
        }
        const forWidgetType = widgetTypeClassName(ctx, ctx.requireStr("for"));

        const parentName = ctx.str("parent");
        const collection = parentName
            ? requireStyle(ctx, parentName).childStyles
            : ctx.project.lvglStyles.styles;

        const style = createObject<LVGLStyle>(
            ctx.store,
            { name, forWidgetType, definition: {} } as any,
            ProjectEditor.LVGLStyleClass
        );
        const added = ctx.store.addObject(collection, style) as LVGLStyle;

        const set = ctx.pairs("set", 1);
        if (Object.keys(set).length > 0) {
            updateDefinition(
                ctx,
                added.definition,
                stylePartsFor(ctx, added),
                expandShorthands(set),
                []
            );
        }

        if (ctx.flag("default")) {
            ctx.store.updateObject(ctx.project.lvglStyles, {
                defaultStyles: {
                    ...toJS(ctx.project.lvglStyles.defaultStyles),
                    [forWidgetType]: name
                }
            });
        }

        ctx.changed(`added ${selectorOf(added)} for ${shortWidgetName(forWidgetType)}`);
        ctx.emit({ selector: selectorOf(added) }, selectorOf(added));
    }
};

const setCommand: CommandDef = {
    name: "lvgl-style set",
    summary: "Set style properties (for a part/state) of an LVGL style",
    usage: `lvgl-style set <style> [--part MAIN] [--state DEFAULT] prop=value [prop=value ...]
  e.g.  lvgl-style set PrimaryButton --state PRESSED bg_color=#1565C0
        lvgl-style set Card pad_all=12 border_width=1 border_color=#DDDDDD`,
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const style = requireStyle(ctx, ctx.arg(0, "style"));
        const set = ctx.pairs("set", 1);
        if (Object.keys(set).length == 0) {
            ctx.usage("nothing to set");
        }
        const { part, state } = updateDefinition(
            ctx,
            style.definition,
            stylePartsFor(ctx, style),
            expandShorthands(set),
            []
        );
        ctx.changed(`set ${selectorOf(style)} ${part}/${state}: ${Object.keys(set).join(", ")}`);
    }
};

const unsetCommand: CommandDef = {
    name: "lvgl-style unset",
    summary: "Remove style properties from an LVGL style",
    usage: "lvgl-style unset <style> [--part MAIN] [--state DEFAULT] prop [prop ...]",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const style = requireStyle(ctx, ctx.arg(0, "style"));
        const names = ctx.args.slice(1);
        if (names.length == 0) {
            ctx.usage("nothing to unset");
        }
        const { part, state } = updateDefinition(ctx, style.definition, undefined, {}, names);
        ctx.changed(`unset ${selectorOf(style)} ${part}/${state}: ${names.join(", ")}`);
    }
};

const rmCommand: CommandDef = {
    name: "lvgl-style rm",
    summary: "Remove an LVGL style",
    usage: "lvgl-style rm <style> [--force]",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const style = requireStyle(ctx, ctx.arg(0, "style"));
        deleteWithCheck(ctx, style);
    }
};

const renameCommand: CommandDef = {
    name: "lvgl-style rename",
    summary: "Rename an LVGL style (updates widgets using it)",
    usage: "lvgl-style rename <style> <new-name>",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const style = requireStyle(ctx, ctx.arg(0, "style"));
        const oldName = style.name;
        const newName = ctx.arg(1, "new-name");
        renameObject(ctx, style, newName);
        const defaults = toJS(ctx.project.lvglStyles.defaultStyles) as any;
        if (defaults[style.forWidgetType] == oldName) {
            defaults[style.forWidgetType] = newName;
            ctx.store.updateObject(ctx.project.lvglStyles, { defaultStyles: defaults });
        }
    }
};

const applyCommand: CommandDef = {
    name: "lvgl-style apply",
    summary: "Use an LVGL style on a widget",
    usage: "lvgl-style apply <widget> <style>",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const style = requireStyle(ctx, ctx.arg(1, "style"));
        if (style.forWidgetType != widget.type && !ctx.force) {
            throw new CliError(
                `Style "${style.name}" is for ${shortWidgetName(style.forWidgetType)} widgets, not ${shortWidgetName(widget.type)}`,
                `create a style with --for ${shortWidgetName(widget.type)}, or pass --force`
            );
        }
        ctx.store.updateObject(widget, { useStyle: style.name });
        ctx.changed(`${selectorOf(widget)} uses style ${style.name}`);
    }
};

const unapplyCommand: CommandDef = {
    name: "lvgl-style unapply",
    summary: "Stop using a style on a widget",
    usage: "lvgl-style unapply <widget>",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        ctx.store.updateObject(widget, { useStyle: "" });
        ctx.changed(`${selectorOf(widget)} uses no style`);
    }
};

const defaultCommand: CommandDef = {
    name: "lvgl-style default",
    summary: "Set (or clear with 'none') the default style of a widget type",
    usage: "lvgl-style default <widget-type> <style|none>",
    mutating: true,
    group: "lvgl styles",
    run(ctx) {
        requireLVGL(ctx);
        const type = widgetTypeClassName(ctx, ctx.arg(0, "widget-type"));
        const name = ctx.arg(1, "style");
        const defaults = toJS(ctx.project.lvglStyles.defaultStyles) as any;
        if (name == "none") {
            delete defaults[type];
        } else {
            const style = requireStyle(ctx, name);
            if (style.forWidgetType != type) {
                throw new CliError(`Style "${name}" is for ${shortWidgetName(style.forWidgetType)} widgets`);
            }
            defaults[type] = name;
        }
        ctx.store.updateObject(ctx.project.lvglStyles, { defaultStyles: defaults });
        ctx.changed(`default style for ${shortWidgetName(type)}: ${name}`);
    }
};

// convenience shorthands: pad_all, pad_hor, pad_ver, margin? (not LVGL)
function expandShorthands(set: { [name: string]: any }) {
    const result: { [name: string]: any } = {};
    for (const key of Object.keys(set)) {
        const k = key.toLowerCase();
        if (k == "pad_all" || k == "padding") {
            for (const side of ["top", "bottom", "left", "right"]) {
                result[`pad_${side}`] = set[key];
            }
        } else if (k == "pad_hor") {
            result.pad_left = result.pad_right = set[key];
        } else if (k == "pad_ver") {
            result.pad_top = result.pad_bottom = set[key];
        } else {
            result[key] = set[key];
        }
    }
    return result;
}

const propsCommand: CommandDef = {
    name: "lvgl-style props",
    summary: "List LVGL style properties (types, enums) for this LVGL version",
    usage: "lvgl-style props [--group name] [--search text]\n  shorthands: pad_all, pad_hor, pad_ver",
    group: "lvgl styles",
    run(ctx) {
        requireLVGL(ctx);
        const groupFilter = ctx.str("group")?.toLowerCase();
        const search = ctx.str("search")?.toLowerCase();
        const holder = new PropertyValueHolder(ctx.store, "x", undefined);
        (holder as any)._eez_parent = ctx.project;

        const data: any[] = [];
        const rows: any[] = [];
        for (const group of lvglProperties) {
            if (groupFilter && !group.groupName.toLowerCase().includes(groupFilter)) {
                continue;
            }
            for (const propertyInfo of group.properties) {
                if (unusedProperties.includes(propertyInfo)) continue;
                if (!isLvglStylePropertySupported(ctx.project, propertyInfo)) continue;
                if (
                    search &&
                    !propertyInfo.name.includes(search) &&
                    !propertyInfo.lvglStyleProp.description.toLowerCase().includes(search)
                ) {
                    continue;
                }
                const enumItems = getEnumItems(holder, propertyInfo);
                const entry = {
                    group: group.groupName,
                    name: propertyInfo.name,
                    type: propertyTypeName(propertyInfo),
                    enum: enumItems?.map(item => item.id),
                    inherited: propertyInfo.lvglStyleProp.inherited,
                    default: propertyInfo.lvglStyleProp.defaultValue,
                    description: propertyInfo.lvglStyleProp.description
                };
                data.push(entry);
                rows.push([
                    entry.name,
                    entry.type == "ThemedColor" ? "color" : entry.type,
                    entry.enum ? entry.enum.slice(0, 12).join("|") + (entry.enum.length > 12 ? "|..." : "") : "",
                    group.groupName
                ]);
            }
        }
        ctx.emit(data, table(rows, ["property", "type", "values", "group"]));
    }
};

const partsCommand: CommandDef = {
    name: "lvgl-style parts",
    summary: "List style parts of a widget type and all states",
    usage: "lvgl-style parts <widget-type>",
    group: "lvgl styles",
    run(ctx) {
        requireLVGL(ctx);
        const { aClass } = requireClass(ctx.store, ctx.arg(0, "widget-type"), ProjectEditor.LVGLWidgetClass, "widget type");
        const proto = new aClass();
        (proto as any)._eez_parent = ctx.project.userPages;
        let parts: string[] = [];
        try {
            parts = getClassInfoLvglParts(proto as any);
        } catch (err) {}
        const states = allStates();
        ctx.emit({ parts, states }, `parts:  ${parts.join(", ")}\nstates: ${states.join(", ")}`);
    }
};

////////////////////////////////////////////////////////////////////////////////
// local (per widget) styles

const localShow: CommandDef = {
    name: "widget style show",
    summary: "Show the local style properties of a widget",
    usage: "widget style show <widget>",
    group: "widgets",
    run(ctx) {
        requireLVGL(ctx);
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const definition = toJS(widget.localStyles?.definition) ?? {};
        ctx.emit(
            { selector: selectorOf(widget), useStyle: widget.useStyle, definition },
            `${selectorOf(widget)}${widget.useStyle ? ` (style: ${widget.useStyle})` : ""}\n\n${definitionText(definition)}`
        );
    }
};

const localSet: CommandDef = {
    name: "widget style set",
    summary: "Set local style properties of a widget (part/state)",
    usage: `widget style set <widget> [--part MAIN] [--state DEFAULT] prop=value [prop=value ...]
  e.g.  widget style set page:Main/title text_font=MONTSERRAT_24 text_color=#333333
        widget style set page:Main/btnOk --state PRESSED bg_color=#0D47A1
  shorthands: pad_all, pad_hor, pad_ver (see "lvgl-style props")`,
    mutating: true,
    group: "widgets",
    run(ctx) {
        requireLVGL(ctx);
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const set = ctx.pairs("set", 1);
        if (Object.keys(set).length == 0) {
            ctx.usage("nothing to set");
        }
        let parts: string[] | undefined;
        try {
            parts = getClassInfoLvglParts(widget);
        } catch (err) {}
        const { part, state } = updateDefinition(ctx, widget.localStyles, parts, expandShorthands(set), []);
        ctx.changed(`set local style ${selectorOf(widget)} ${part}/${state}: ${Object.keys(set).join(", ")}`);
    }
};

const localUnset: CommandDef = {
    name: "widget style unset",
    summary: "Remove local style properties of a widget",
    usage: "widget style unset <widget> [--part MAIN] [--state DEFAULT] prop [prop ...]",
    mutating: true,
    group: "widgets",
    run(ctx) {
        requireLVGL(ctx);
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        const names = ctx.args.slice(1);
        if (names.length == 0) {
            ctx.usage("nothing to unset");
        }
        const { part, state } = updateDefinition(ctx, widget.localStyles, undefined, {}, names);
        ctx.changed(`unset local style ${selectorOf(widget)} ${part}/${state}: ${names.join(", ")}`);
    }
};

const localClear: CommandDef = {
    name: "widget style clear",
    summary: "Remove all local style properties of a widget",
    usage: "widget style clear <widget>",
    mutating: true,
    group: "widgets",
    run(ctx) {
        requireLVGL(ctx);
        const widget = requireWidget(ctx, ctx.arg(0, "widget"));
        ctx.store.updateObject(widget.localStyles, { definition: undefined });
        ctx.changed(`cleared local styles of ${selectorOf(widget)}`);
    }
};

export const lvglStyleCommands: CommandDef[] = [
    listCommand,
    showCommand,
    addCommand,
    setCommand,
    unsetCommand,
    rmCommand,
    renameCommand,
    applyCommand,
    unapplyCommand,
    defaultCommand,
    propsCommand,
    partsCommand,
    localShow,
    localSet,
    localUnset,
    localClear
];

