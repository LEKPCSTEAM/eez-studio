// Variables, actions and flows (EEZ Flow components and connection lines)

import { isArray } from "eez-studio-shared/util";

import { getClassesDerivedFrom, IEezObject } from "project-editor/core/object";
import { createObject } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Flow } from "project-editor/flow/flow";
import type { Component } from "project-editor/flow/component";

import { CommandDef } from "cli/registry";
import { fixName, conventionalName } from "cli/naming";
import { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import { selectorOf, nameOf } from "cli/selectors";
import { addNewObject, classNameOf, requireClass, setProperties, describeObject } from "cli/reflect";
import { table } from "cli/format";
import { deleteWithCheck, renameObject, objectSummary } from "cli/commands/obj";
import { suggestHint } from "cli/suggest";

////////////////////////////////////////////////////////////////////////////////
// variables

function variablesCollection(ctx: CommandContext) {
    const flowSelector = ctx.str("local");
    if (flowSelector) {
        const flow = requireFlow(ctx, flowSelector);
        return { collection: flow.localVariables, where: selectorOf(flow) };
    }
    const variables = ctx.project.variables;
    if (!variables) {
        throw new CliError("Project has no variables feature");
    }
    return { collection: variables.globalVariables, where: "global" };
}

function requireVariable(ctx: CommandContext, name: string) {
    const { collection } = variablesCollection(ctx);
    const variable = collection.find((v: any) => v.name == name);
    if (!variable) {
        throw new CliError(
            `Variable "${name}" not found`,
            suggestHint(name, collection.map((v: any) => v.name), "variables") ?? "there are no variables"
        );
    }
    return variable;
}

const varList: CommandDef = {
    name: "var list",
    aliases: ["vars"],
    summary: "List global (or --local page/action) variables",
    usage: "var list [--local <page|action>]",
    group: "variables & flow",
    run(ctx) {
        const { collection } = variablesCollection(ctx);
        const rows = collection.map((v: any) => ({
            selector: selectorOf(v),
            name: v.name,
            type: v.type,
            defaultValue: v.defaultValue,
            native: v.native || undefined,
            persistent: v.persistent || undefined
        }));
        ctx.emit(
            rows,
            table(
                rows.map((r: any) => [r.name, r.type, r.defaultValue ?? "", r.native ? "native" : ""]),
                ["variable", "type", "default", ""]
            )
        );
    }
};

const varAdd: CommandDef = {
    name: "var add",
    summary: "Add a variable (global, or local to a page/action flow)",
    usage: `var add <name> --type integer|float|double|boolean|string|array:<T>|struct:<S>|enum:<E>|...
        [--default <expression>] [--local <page|action>] [--native] [key=value ...]
  --default   default value expression, e.g. 0, "text", true, []
  --native    variable implemented in native (C/C++) code (LVGL without flow)`,
    booleans: ["native"],
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const name = fixName("plain", "Variable", ctx.arg(0, "name"));
        const { collection, where } = variablesCollection(ctx);
        if (collection.find((v: any) => v.name == name)) {
            throw new CliError(`Variable "${name}" already exists (${where})`);
        }
        const values: any = { name, type: ctx.str("type", "integer"), ...ctx.values(1) };
        const defaultValue = ctx.str("default");
        if (defaultValue !== undefined) {
            values.defaultValue = defaultValue;
        } else if (values.defaultValue === undefined) {
            values.defaultValue = defaultForType(values.type);
        }
        if (ctx.flag("native")) {
            values.native = true;
        }
        const variable = addNewObject(
            ctx.store,
            collection,
            "Variable",
            ProjectEditor.VariableClass,
            values,
            { force: ctx.force }
        );
        ctx.changed(`added variable ${name}: ${values.type} (${where})`);
        ctx.emit(objectSummary(variable));
    }
};

function defaultForType(type: string) {
    if (type == "integer" || type == "float" || type == "double") return "0";
    if (type == "boolean") return "false";
    if (type == "string") return '""';
    if (type?.startsWith("array")) return "[]";
    if (type?.startsWith("struct")) return "{}";
    return "";
}

const varSet: CommandDef = {
    name: "var set",
    summary: "Change a variable (type, default value, ...)",
    usage: "var set <name> [--local <page|action>] [--type T] [--default V] [key=value ...]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const variable = requireVariable(ctx, ctx.arg(0, "name"));
        const values: any = ctx.values(1);
        const type = ctx.str("type");
        if (type) values.type = type;
        const defaultValue = ctx.str("default");
        if (defaultValue !== undefined) values.defaultValue = defaultValue;
        setProperties(ctx.store, variable, values, { force: ctx.force });
        ctx.changed(`set variable ${variable.name}: ${Object.keys(values).join(", ")}`);
    }
};

const varRm: CommandDef = {
    name: "var rm",
    summary: "Remove a variable",
    usage: "var rm <name> [--local <page|action>] [--force]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const variable = requireVariable(ctx, ctx.arg(0, "name"));
        deleteWithCheck(ctx, variable, `variable ${variable.name}`);
    }
};

const varRename: CommandDef = {
    name: "var rename",
    summary: "Rename a variable and update references",
    usage: "var rename <name> <new-name> [--local <page|action>]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        renameObject(ctx, requireVariable(ctx, ctx.arg(0, "name")), ctx.arg(1, "new-name"));
    }
};

////////////////////////////////////////////////////////////////////////////////
// actions

function requireAction(ctx: CommandContext, name: string) {
    const action = (ctx.project.actions ?? []).find(a => a.name == name);
    if (!action) {
        throw new CliError(
            `Action "${name}" not found`,
            suggestHint(name, (ctx.project.actions ?? []).map(a => a.name), "actions") ?? "there are no actions"
        );
    }
    return action;
}

const actionList: CommandDef = {
    name: "action list",
    aliases: ["actions"],
    summary: "List user actions",
    usage: "action list",
    group: "variables & flow",
    run(ctx) {
        const actions = ctx.project.actions ?? [];
        const rows = actions.map((a: any) => ({
            selector: selectorOf(a),
            name: a.name,
            implementationType: a.implementationType,
            components: a.components?.length
        }));
        ctx.emit(
            rows,
            table(
                rows.map(r => [r.selector, r.implementationType ?? "", r.components ?? ""]),
                ["action", "implementation", "components"]
            )
        );
    }
};

const actionAdd: CommandDef = {
    name: "action add",
    summary: "Add a user action (flow action, or --native for C code)",
    usage: "action add <name> [--native] [--description text]",
    booleans: ["native"],
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const name = fixName("plain", "Action", ctx.arg(0, "name"));
        if ((ctx.project.actions ?? []).find(a => a.name == name)) {
            throw new CliError(`Action "${name}" already exists`);
        }
        const values: any = { name };
        const hasFlow = ctx.store.projectTypeTraits.hasFlowSupport;
        values.implementationType = ctx.flag("native") || !hasFlow ? "native" : "flow";
        const description = ctx.str("description");
        if (description) values.description = description;
        const action = createObject<any>(
            ctx.store,
            { ...values, components: [], connectionLines: [], localVariables: [] },
            ProjectEditor.ActionClass
        );
        const added = ctx.store.addObject(ctx.project.actions, action);
        ctx.changed(`added action ${name} (${values.implementationType})`);
        ctx.emit(objectSummary(added));
    }
};

const actionRm: CommandDef = {
    name: "action rm",
    summary: "Remove an action",
    usage: "action rm <name> [--force]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const action = requireAction(ctx, ctx.arg(0, "name"));
        deleteWithCheck(ctx, action, `action ${action.name}`);
    }
};

const actionRename: CommandDef = {
    name: "action rename",
    summary: "Rename an action and update references",
    usage: "action rename <name> <new-name>",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        renameObject(ctx, requireAction(ctx, ctx.arg(0, "name")), ctx.arg(1, "new-name"));
    }
};

////////////////////////////////////////////////////////////////////////////////
// flows

export function requireFlow(ctx: CommandContext, selector: string): Flow {
    let object: IEezObject;
    try {
        object = ctx.resolve(selector);
    } catch (err) {
        object = ctx.resolve(`action:${selector}`);
    }
    if (!(object instanceof ProjectEditor.FlowClass)) {
        throw new CliError(`"${selector}" is not a page or action (flow)`);
    }
    return object as Flow;
}

function componentLabel(component: any) {
    const name = nameOf(component);
    const type = classNameOf(component)
        .replace(/ActionComponent$/, "")
        .replace(/^LVGL/, "")
        .replace(/Widget$/, "");
    return name ? `${type} ${name}` : type;
}

function allFlowComponents(flow: Flow): Component[] {
    const result: Component[] = [];
    const visit = (components: any[]) => {
        for (const component of components) {
            result.push(component);
            if (isArray(component.children)) visit(component.children);
            if (isArray(component.widgets)) visit(component.widgets);
        }
    };
    visit(flow.components);
    return result;
}

// component inside a flow: [index] (top level flow components), @objID,
// widget name/identifier, or any selector
function resolveComponent(ctx: CommandContext, flow: Flow, ref: string): Component {
    const indexMatch = ref.match(/^\[(\d+)\]$/);
    if (indexMatch) {
        const component = flow.components[Number(indexMatch[1])];
        if (!component) {
            throw new CliError(`No flow component ${ref} in ${selectorOf(flow)}`);
        }
        return component as Component;
    }
    const components = allFlowComponents(flow);
    const byName =
        components.find(c => nameOf(c) == ref) ??
        // written without the naming convention: "inc" -> "btn_inc"
        components.find(
            c =>
                c instanceof ProjectEditor.WidgetClass &&
                nameOf(c) != undefined &&
                nameOf(c) == conventionalName("widget", classNameOf(c), ref)
        );
    if (byName) {
        return byName;
    }
    const object = ctx.resolve(ref);
    if (!(object instanceof ProjectEditor.ComponentClass)) {
        throw new CliError(`"${ref}" is not a flow component`);
    }
    return object as Component;
}

function portNames(ports: { name: string }[]) {
    return ports.map(p => p.name);
}

const flowComponents: CommandDef = {
    name: "flow components",
    summary: "List action component types that can be added to flows",
    usage: "flow components [--search text]",
    group: "variables & flow",
    run(ctx) {
        const search = ctx.str("search")?.toLowerCase();
        const store = ctx.store;
        const projectType = ctx.project.settings.general.projectType;
        const classes = getClassesDerivedFrom(store, ProjectEditor.ActionComponentClass)
            .filter(c => {
                const classInfo = c.objectClass.classInfo;
                if (classInfo.enabledInComponentPalette) {
                    try {
                        if (!classInfo.enabledInComponentPalette(projectType as any, store)) {
                            return false;
                        }
                    } catch (err) {
                        return false;
                    }
                }
                return !search || c.name.toLowerCase().includes(search);
            })
            .map(c => ({
                type: c.name.replace(/ActionComponent$/, ""),
                class: c.name,
                group: (c.objectClass.classInfo.componentPaletteGroupName ?? "").replace(/^!\d+/, "")
            }))
            .sort((a, b) => (a.group == b.group ? a.type.localeCompare(b.type) : a.group.localeCompare(b.group)));
        ctx.emit(
            classes,
            table(classes.map(c => [c.type, c.group]), ["component", "group"]) +
                '\n\nuse "schema class <component>" to see its properties'
        );
    }
};

const flowList: CommandDef = {
    name: "flow list",
    aliases: ["flow show"],
    summary: "Show the components and connections of a page/action flow",
    usage: "flow list <page|action>",
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const components = flow.components
            .map((component: any, index: number) => ({
                ref: `[${index}]`,
                selector: selectorOf(component),
                type: classNameOf(component),
                label: componentLabel(component),
                at: `${component.left},${component.top}`,
                inputs: portNames(component.inputs ?? []),
                outputs: portNames(component.outputs ?? [])
            }))
            .filter((c: any) => !c.type.endsWith("ScreenWidget") || true);

        const byObjID = new Map<string, any>();
        for (const component of allFlowComponents(flow)) {
            byObjID.set((component as any).objID, component);
        }

        const connections = flow.connectionLines.map((line: any, index: number) => {
            const source = byObjID.get(line.source);
            const target = byObjID.get(line.target);
            return {
                index,
                from: source ? selectorOf(source) : line.source,
                output: line.output,
                to: target ? selectorOf(target) : line.target,
                input: line.input
            };
        });

        ctx.emit(
            { flow: selectorOf(flow), components, connections },
            `${selectorOf(flow)}\n\ncomponents:\n` +
                table(
                    components.map((c: any) => [
                        c.ref,
                        c.label,
                        c.at,
                        "in: " + c.inputs.join(","),
                        "out: " + c.outputs.join(",")
                    ])
                ) +
                "\n\nconnections:\n" +
                (connections.length
                    ? table(connections.map((c: any) => [`${c.from}.${c.output}`, "->", `${c.to}.${c.input}`]))
                    : "(none)")
        );
    }
};

const flowAdd: CommandDef = {
    name: "flow add",
    summary: "Add an action component to a page/action flow",
    usage: `flow add <page|action> <ComponentType> [--at x,y] [key=value ...] [--values JSON]
  e.g.  flow add Main SetVariable --at 100,50 --values '{"entries": [{"variable": "counter", "value": "counter + 1"}]}'
        flow add Main Log value='"clicked"'
  component types: see "flow components"; properties: "schema class <ComponentType>"`,
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const { name: className, aClass } = requireClass(
            ctx.store,
            ctx.arg(1, "ComponentType"),
            ProjectEditor.ActionComponentClass,
            "flow component"
        );
        const values: any = ctx.values(2);
        const at = ctx.pair("at");
        if (at) {
            values.left = at[0];
            values.top = at[1];
        } else if (values.left === undefined) {
            // place new components in a column right of the existing ones
            const actions = flow.components.filter((c: any) => !(c instanceof ProjectEditor.WidgetClass));
            values.left = 50 + 250 * (actions.length % 4);
            values.top = 50 + 150 * Math.floor(actions.length / 4);
        }
        const component = addNewObject(ctx.store, flow.components, className, aClass, values, {
            force: ctx.force
        });
        const index = flow.components.indexOf(component as any);
        ctx.changed(`added ${componentLabel(component)} [${index}] to ${selectorOf(flow)}`);
        ctx.emit(
            {
                ref: `[${index}]`,
                selector: selectorOf(component),
                inputs: portNames((component as any).inputs ?? []),
                outputs: portNames((component as any).outputs ?? [])
            },
            `[${index}] ${selectorOf(component)}`
        );
    }
};

function connectionArgs(ctx: CommandContext, flow: Flow) {
    const source = resolveComponent(ctx, flow, ctx.arg(1, "from"));
    const target = resolveComponent(ctx, flow, ctx.arg(2, "to"));
    const output = ctx.str("output", "@seqout")!;
    const input = ctx.str("input", "@seqin")!;
    return { source, target, output, input };
}

const flowConnect: CommandDef = {
    name: "flow connect",
    summary: "Connect a component output to a component input",
    usage: `flow connect <page|action> <from> <to> [--output @seqout] [--input @seqin]
  <from>/<to>: [index] from "flow list", a widget name, or a selector
  e.g.  flow connect Main btnOk [2] --output CLICKED
        flow connect Main [0] [1]`,
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const { source, target, output, input } = connectionArgs(ctx, flow);
        const outputs = portNames((source as any).outputs ?? []);
        if (!outputs.includes(output)) {
            throw new CliError(
                `${componentLabel(source)} has no output "${output}"`,
                outputs.length
                    ? `outputs: ${outputs.join(", ")}` +
                          (source instanceof ProjectEditor.WidgetClass
                              ? ' (widget events become outputs after "widget event add <widget> --event E --flow")'
                              : "")
                    : "this component has no outputs"
            );
        }
        const inputs = portNames((target as any).inputs ?? []);
        if (!inputs.includes(input)) {
            throw new CliError(
                `${componentLabel(target)} has no input "${input}"`,
                inputs.length ? `inputs: ${inputs.join(", ")}` : "this component has no inputs"
            );
        }
        const exists = flow.connectionLines.find(
            (line: any) =>
                line.source == (source as any).objID &&
                line.output == output &&
                line.target == (target as any).objID &&
                line.input == input
        );
        if (exists) {
            throw new CliError("These ports are already connected");
        }
        const line = createObject<any>(
            ctx.store,
            {
                source: (source as any).objID,
                output,
                target: (target as any).objID,
                input
            },
            ProjectEditor.ConnectionLineClass
        );
        ctx.store.addObject(flow.connectionLines, line);
        ctx.changed(`connected ${componentLabel(source)}.${output} -> ${componentLabel(target)}.${input}`);
    }
};

const flowDisconnect: CommandDef = {
    name: "flow disconnect",
    summary: "Remove a connection line",
    usage: "flow disconnect <page|action> <from> <to> [--output @seqout] [--input @seqin]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const { source, target, output, input } = connectionArgs(ctx, flow);
        const lines = flow.connectionLines.filter(
            (line: any) =>
                line.source == (source as any).objID &&
                line.target == (target as any).objID &&
                (ctx.raw("output") === undefined || line.output == output) &&
                (ctx.raw("input") === undefined || line.input == input)
        );
        if (lines.length == 0) {
            throw new CliError("No such connection");
        }
        ctx.store.deleteObjects(lines);
        ctx.changed(`removed ${lines.length} connection(s)`);
    }
};

const flowRm: CommandDef = {
    name: "flow rm",
    summary: "Remove a flow component (and its connections)",
    usage: "flow rm <page|action> <component>",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const component = resolveComponent(ctx, flow, ctx.arg(1, "component"));
        const objID = (component as any).objID;
        const lines = flow.connectionLines.filter(
            (line: any) => line.source == objID || line.target == objID
        );
        ctx.store.deleteObjects([...lines, component as any]);
        ctx.changed(`removed ${componentLabel(component)} and ${lines.length} connection(s)`);
    }
};

const flowSet: CommandDef = {
    name: "flow set",
    summary: "Set properties of a flow component",
    usage: "flow set <page|action> <component> [--at x,y] key=value ... [--values JSON]",
    mutating: true,
    group: "variables & flow",
    run(ctx) {
        const flow = requireFlow(ctx, ctx.arg(0, "page|action"));
        const component = resolveComponent(ctx, flow, ctx.arg(1, "component"));
        const values: any = ctx.values(2);
        const at = ctx.pair("at");
        if (at) {
            values.left = at[0];
            values.top = at[1];
        }
        setProperties(ctx.store, component, values, { force: ctx.force });
        ctx.changed(`set ${componentLabel(component)}: ${Object.keys(values).join(", ")}`);
        ctx.emit(describeObject(component, { depth: 0, props: Object.keys(values).map(k => k.split(".")[0]) }));
    }
};

export const flowCommands: CommandDef[] = [
    varList,
    varAdd,
    varSet,
    varRm,
    varRename,
    actionList,
    actionAdd,
    actionRm,
    actionRename,
    flowComponents,
    flowList,
    flowAdd,
    flowConnect,
    flowDisconnect,
    flowRm,
    flowSet
];
