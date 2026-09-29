import {
    EezClass,
    PropertyType,
    findClass,
    getClassesDerivedFrom
} from "project-editor/core/object";
import { ProjectEditor } from "project-editor/project-editor-interface";

import { CommandDef } from "cli/registry";
import { CliError } from "cli/errors";
import {
    allClassNames,
    classNameOf,
    describeClass,
    describeProperty,
    requireClass
} from "cli/reflect";
import { table } from "cli/format";

function propertyRows(properties: any[]) {
    return properties.map((p: any) => [
        p.name,
        p.type + (p.class ? `<${p.class}>` : ""),
        p.enum
            ? p.enum.join("|")
            : p.reference
            ? `-> ${p.reference}`
            : p.flowProperty
            ? `flow:${p.flowProperty}`
            : ""
    ]);
}

// own properties first, inherited ones after (base widget properties are
// the same for every widget type)
export function classTable(data: any) {
    const own = new Set<string>(data.ownProperties ?? []);
    const ownProperties = data.properties.filter((p: any) => own.has(p.name));
    const inherited = data.properties.filter((p: any) => !own.has(p.name));
    return (
        `${data.class}${
            data.extends.length ? " extends " + data.extends.join(" > ") : ""
        }\n\n` +
        (ownProperties.length > 0
            ? table(propertyRows(ownProperties), ["property", "type", "values"])
            : "(no own properties)") +
        (inherited.length > 0
            ? `\n\ninherited from ${data.extends[0] ?? "base class"}:\n` +
              table(propertyRows(inherited))
            : "") +
        (data.lvgl ? `\n\nLVGL parts: ${JSON.stringify(data.lvgl.parts)}` : "") +
        (data.events ? `\nevents: ${data.events.join(", ")}` : "")
    );
}

const classesCommand: CommandDef = {
    name: "schema classes",
    summary: "List model classes (optionally derived from a base class)",
    usage: `schema classes [--derived-from Widget|ActionComponent|LVGLWidget|...]`,
    project: "none",
    group: "schema",
    run(ctx) {
        const base = ctx.str("derived-from");
        let names: string[];
        if (base) {
            const store = ctx.session.store;
            const baseClass = store
                ? requireClass(store, base).aClass
                : findClass(base);
            if (!baseClass) {
                throw new CliError(`Unknown class "${base}"`);
            }
            names = getClassesDerivedFrom(store, baseClass as EezClass)
                .map(c => c.name)
                .sort();
        } else {
            names = allClassNames();
        }
        ctx.emit(names, names.join("\n"));
    }
};

const classCommand: CommandDef = {
    name: "schema class",
    summary: "Describe the properties of a class",
    usage: `schema class <ClassName> [--all]
  short names are accepted: Button, Label, Page, Style, Variable, Log ...`,
    booleans: ["all"],
    group: "schema",
    run(ctx) {
        const { aClass } = requireClass(ctx.store, ctx.arg(0, "class"));
        const data = describeClass(aClass, undefined, ctx.flag("all"));
        ctx.emit(data, classTable(data));
    }
};

const projectCommand: CommandDef = {
    name: "schema project",
    summary: "Show the project root structure (top level collections)",
    usage: "schema project",
    group: "schema",
    run(ctx) {
        const project = ctx.project;
        const rows: any[] = [];
        const data: any[] = [];
        for (const propertyInfo of ProjectEditor.ProjectClass.classInfo
            .properties) {
            if (
                propertyInfo.type != PropertyType.Array &&
                propertyInfo.type != PropertyType.Object
            ) {
                continue;
            }
            const value = (project as any)[propertyInfo.name];
            const entry = {
                property: propertyInfo.name,
                selector: "/" + propertyInfo.name,
                class: propertyInfo.typeClass
                    ? classNameOf(propertyInfo.typeClass)
                    : undefined,
                present: value != undefined,
                count: Array.isArray(value) ? value.length : undefined
            };
            data.push(entry);
            rows.push([
                entry.selector,
                entry.class ?? "",
                !entry.present
                    ? "(not in project)"
                    : entry.count !== undefined
                    ? `[${entry.count}]`
                    : "object"
            ]);
        }
        ctx.emit(data, table(rows, ["selector", "class", ""]));
    }
};

const enumCommand: CommandDef = {
    name: "schema enum",
    summary: "Allowed values of an enum property",
    usage: `schema enum <Class>.<property>
  (for values that depend on the object use "obj props <selector>")`,
    group: "schema",
    run(ctx) {
        const spec = ctx.arg(0, "Class.property");
        const dot = spec.lastIndexOf(".");
        if (dot <= 0) {
            ctx.usage("expected <Class>.<property>");
        }
        const { aClass } = requireClass(ctx.store, spec.substring(0, dot));
        const propertyName = spec.substring(dot + 1);
        const propertyInfo = aClass.classInfo.properties.find(
            p => p.name == propertyName
        );
        if (!propertyInfo) {
            throw new CliError(
                `${classNameOf(aClass)} has no property "${propertyName}"`
            );
        }
        const described = describeProperty(propertyInfo);
        if (!described.enum) {
            throw new CliError(
                `No static enum values for ${spec}`,
                typeof propertyInfo.enumItems == "function"
                    ? `values depend on the object: use "obj props <selector>"`
                    : `the property type is ${described.type}`
            );
        }
        ctx.emit(described.enum, described.enum.join("\n"));
    }
};

export const schemaCommands: CommandDef[] = [
    classesCommand,
    classCommand,
    projectCommand,
    enumCommand
];
