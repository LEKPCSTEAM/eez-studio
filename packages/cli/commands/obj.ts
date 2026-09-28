// Generic object layer: works on any object of any project type.

import { isArray } from "eez-studio-shared/util";

import {
    EezObject,
    IEezObject,
    PropertyType,
    getClassInfo,
    getParent,
    getKey,
    getPropertyInfo
} from "project-editor/core/object";
import { visitObjects, isReferenced, replaceObjectReference } from "project-editor/core/search";
import {
    deleteObject as deleteObjectCommand,
    insertObject,
    createObject,
    objectToJS
} from "project-editor/store";

import { CommandDef } from "cli/registry";
import { CliError, UsageError } from "cli/errors";
import { CommandContext } from "cli/context";
import { selectorOf, objectPath, nameOf } from "cli/selectors";
import {
    classNameOf,
    describeObject,
    describeClass,
    requireClass,
    setProperties,
    addNewObject
} from "cli/reflect";
import { table } from "cli/format";
import { classTable } from "cli/commands/schema";
import { findExtraReferences } from "cli/references";
import { applyNaming, findNameConflict, namePropertyOf } from "cli/naming";

////////////////////////////////////////////////////////////////////////////////

export function requireArray(ctx: CommandContext, selector: string) {
    const object = ctx.resolve(selector);
    if (!isArray(object)) {
        throw new CliError(
            `"${selector}" is not a collection`,
            `use a collection selector, e.g. "${selector}#<arrayProperty>" or "/userPages"`
        );
    }
    return object as EezObject[];
}

export function requireObject(ctx: CommandContext, selector: string) {
    const object = ctx.resolve(selector);
    if (isArray(object)) {
        throw new CliError(`"${selector}" is a collection, not an object`);
    }
    return object as EezObject;
}

export function summaryRow(object: IEezObject) {
    return [selectorOf(object), classNameOf(object), nameOf(object) ?? ""];
}

export function objectSummary(object: IEezObject) {
    return {
        selector: selectorOf(object),
        path: objectPath(object),
        class: classNameOf(object),
        name: nameOf(object),
        objID: (object as any).objID
    };
}

export function deleteWithCheck(
    ctx: CommandContext,
    object: EezObject,
    what?: string
) {
    const label = what ?? selectorOf(object);
    if (!ctx.force) {
        let referenced = false;
        try {
            referenced = isReferenced(object);
        } catch (err) {}
        const extra = findExtraReferences(ctx.project, object);
        if (referenced || extra.length > 0) {
            throw new CliError(
                `${label} is still referenced${
                    extra.length > 0
                        ? ": " + extra.slice(0, 5).map(r => r.where).join(", ")
                        : ""
                }`,
                "remove the references first, or pass --force"
            );
        }
    }
    ctx.store.deleteObject(object);
    ctx.changed(`removed ${label}`);
}

export function renameObject(
    ctx: CommandContext,
    object: EezObject,
    newName: string
) {
    const propertyName =
        namePropertyOf(classNameOf(object), (object as any).constructor) ??
        (getClassInfo(object).properties.find(p => p.name == "identifier")
            ? "identifier"
            : "name");
    const oldName = (object as any)[propertyName];
    const oldSelector = selectorOf(object);

    newName = applyNaming(object, classNameOf(object), propertyName, newName);
    if (newName == oldName) {
        return;
    }
    const conflict = findNameConflict(ctx.project, object, propertyName, newName);
    if (conflict) {
        throw new CliError(
            `The name "${newName}" is already used by ${selectorOf(conflict)}`
        );
    }

    // rewrite references first (they are found by the old name)
    const extra = findExtraReferences(ctx.project, object);
    try {
        replaceObjectReference(object, newName);
    } catch (err) {}
    for (const reference of extra) {
        reference.update(ctx.store, newName);
    }
    ctx.store.updateObject(object, { [propertyName]: newName });
    ctx.changed(`renamed ${oldSelector} ("${oldName}" -> "${newName}")`);
}

export function moveObject(
    ctx: CommandContext,
    object: EezObject,
    target: EezObject[],
    index?: number
) {
    const source = getParent(object);
    if (!isArray(source)) {
        throw new CliError(`${selectorOf(object)} is not in a collection`);
    }

    const sourceIndex = (source as EezObject[]).indexOf(object);

    deleteObjectCommand(object);

    let insertIndex = index ?? target.length;
    if (source === target && index !== undefined && index > sourceIndex) {
        insertIndex--;
    }
    insertIndex = Math.max(0, Math.min(insertIndex, target.length));

    insertObject(target, insertIndex, object);
}

////////////////////////////////////////////////////////////////////////////////

const getCommand: CommandDef = {
    name: "obj get",
    aliases: ["get"],
    summary: "Show an object (or collection) and its property values",
    usage: `obj get <selector> [--depth N] [--props a,b] [--all]
  --depth N   expand child objects N levels (default 1)
  --props     only these properties
  --all       include properties hidden in the property grid`,
    booleans: ["all"],
    group: "objects",
    run(ctx) {
        const object = ctx.resolve(ctx.arg(0, "selector"));
        const props = ctx.list("props");
        const data = describeObject(object, {
            depth: ctx.num("depth", 1),
            props: props.length > 0 ? props : undefined,
            includeHidden: ctx.flag("all")
        });
        ctx.emit(data);
    }
};

const listCommand: CommandDef = {
    name: "obj list",
    aliases: ["ls"],
    summary: "List a collection, or the child collections of an object",
    usage: "obj list <selector>",
    group: "objects",
    run(ctx) {
        const object = ctx.resolve(ctx.argOpt(0) ?? "project");
        if (isArray(object)) {
            const items = object as EezObject[];
            ctx.emit(
                items.map(objectSummary),
                table(items.map(summaryRow), ["selector", "class", "name"])
            );
            return;
        }
        const rows: any[] = [];
        const data: any[] = [];
        for (const propertyInfo of getClassInfo(object).properties) {
            if (
                propertyInfo.type != PropertyType.Array &&
                propertyInfo.type != PropertyType.Object
            ) {
                continue;
            }
            let value: any;
            try {
                value = (object as any)[propertyInfo.name];
            } catch (err) {
                continue;
            }
            if (value == undefined) {
                continue;
            }
            const selector = selectorOf(object) + "#" + propertyInfo.name;
            const entry = {
                property: propertyInfo.name,
                selector,
                class: propertyInfo.typeClass
                    ? classNameOf(propertyInfo.typeClass)
                    : undefined,
                count: isArray(value) ? value.length : undefined
            };
            data.push(entry);
            rows.push([
                selector,
                entry.class ?? "",
                isArray(value) ? `[${value.length}]` : "object"
            ]);
        }
        ctx.emit(data, table(rows, ["selector", "class", "items"]));
    }
};

const findCommand: CommandDef = {
    name: "obj find",
    aliases: ["find"],
    summary: "Find objects by class and/or name",
    usage: `obj find [--class C] [--name regex] [--in selector] [--limit N]
  --class   class name (short names accepted, e.g. Button, Label, Style)`,
    group: "objects",
    run(ctx) {
        const root = ctx.resolve(ctx.str("in") ?? "project");
        const className = ctx.str("class");
        const nameRe = ctx.str("name");
        const limit = ctx.num("limit", 200)!;

        let aClassInfo: any;
        if (className) {
            aClassInfo = requireClass(ctx.store, className).aClass.classInfo;
        }
        const re = nameRe ? new RegExp(nameRe, "i") : undefined;

        const found: IEezObject[] = [];
        for (const object of visitObjects(root)) {
            if (isArray(object)) {
                continue;
            }
            if (aClassInfo) {
                let classInfo: any = getClassInfo(object);
                let match = false;
                while (classInfo) {
                    if (classInfo === aClassInfo) {
                        match = true;
                        break;
                    }
                    classInfo = classInfo.parentClassInfo;
                }
                if (!match) {
                    continue;
                }
            }
            if (re) {
                const name = nameOf(object);
                if (!name || !re.test(name)) {
                    continue;
                }
            }
            found.push(object);
            if (found.length >= limit) {
                break;
            }
        }

        ctx.emit(
            found.map(objectSummary),
            table(found.map(summaryRow), ["selector", "class", "name"])
        );
    }
};

const propsCommand: CommandDef = {
    name: "obj props",
    aliases: ["props"],
    summary: "Show property types/enums for an existing object",
    usage: "obj props <selector> [--all]",
    booleans: ["all"],
    group: "objects",
    run(ctx) {
        const object = requireObject(ctx, ctx.arg(0, "selector"));
        const data = describeClass(
            (object as any).constructor,
            object,
            ctx.flag("all")
        );
        ctx.emit(data, classTable(data));
    }
};

const setCommand: CommandDef = {
    name: "obj set",
    aliases: ["set"],
    summary: "Set property values of an object",
    usage: `obj set <selector> key=value [key=value ...] [--values JSON] [--force]
  nested:  obj set page:Main/btn "resizing.pinToLeft=true"
  typed:   obj set settings/general --values '{"displayWidth": 800}'`,
    mutating: true,
    group: "objects",
    run(ctx) {
        const selector = ctx.arg(0, "selector");
        const object = requireObject(ctx, selector);
        const values = ctx.values(1);
        if (Object.keys(values).length == 0) {
            ctx.usage("nothing to set");
        }
        setProperties(ctx.store, object, values, { force: ctx.force });
        ctx.changed(
            `set ${selectorOf(object)}: ${Object.keys(values).join(", ")}`
        );
        ctx.emit(describeObject(object, { depth: 0, props: Object.keys(values).map(k => k.split(".")[0]) }));
    }
};

const addCommand: CommandDef = {
    name: "obj add",
    aliases: ["add"],
    summary: "Add a new object to a collection",
    usage: `obj add <collection-selector> [--class C] [--at index] [key=value ...] [--values JSON]
  e.g.  obj add /variables/globalVariables name=counter type=integer defaultValue=0
        obj add page:Main#components --class LogActionComponent
  --class defaults to the collection element class`,
    mutating: true,
    group: "objects",
    run(ctx) {
        const selector = ctx.arg(0, "collection-selector");
        const collection = requireArray(ctx, selector);
        const propertyInfo = getPropertyInfo(collection);
        const className = ctx.str("class");

        let resolved;
        if (className) {
            resolved = requireClass(
                ctx.store,
                className,
                propertyInfo?.typeClass
            );
        } else {
            if (!propertyInfo?.typeClass) {
                ctx.usage("--class is required for this collection");
            }
            resolved = {
                name: classNameOf(propertyInfo.typeClass!),
                aClass: propertyInfo.typeClass!
            };
        }

        const object = addNewObject(
            ctx.store,
            collection,
            resolved.name,
            resolved.aClass,
            ctx.values(1),
            { index: ctx.num("at"), force: ctx.force }
        );

        ctx.changed(`added ${selectorOf(object)} (${resolved.name})`);
        ctx.emit(describeObject(object, { depth: 0 }));
    }
};

const rmCommand: CommandDef = {
    name: "obj rm",
    aliases: ["rm"],
    summary: "Remove an object (refused if referenced, unless --force)",
    usage: "obj rm <selector> [--force]",
    mutating: true,
    group: "objects",
    run(ctx) {
        const object = requireObject(ctx, ctx.arg(0, "selector"));
        const parent = getParent(object);
        if (!parent) {
            throw new CliError("Can't remove the project");
        }
        if (!isArray(parent)) {
            const propertyInfo = getClassInfo(parent).properties.find(
                p => p.name == getKey(object)
            );
            if (propertyInfo && !propertyInfo.isOptional) {
                throw new CliError(
                    `${selectorOf(object)} is a required property and can't be removed`
                );
            }
        }
        deleteWithCheck(ctx, object);
    }
};

const renameCommand: CommandDef = {
    name: "obj rename",
    aliases: ["rename"],
    summary: "Rename an object and update all references to it",
    usage: "obj rename <selector> <new-name>",
    mutating: true,
    group: "objects",
    run(ctx) {
        const object = requireObject(ctx, ctx.arg(0, "selector"));
        renameObject(ctx, object, ctx.arg(1, "new-name"));
        ctx.emit(objectSummary(object));
    }
};

const moveCommand: CommandDef = {
    name: "obj move",
    aliases: ["mv"],
    summary: "Move an object to another collection or position",
    usage: `obj move <selector> [--to <collection-selector>] [--at index]
  e.g.  obj move page:Main/btn --to page:Main/panel1#children
        obj move page:Main/btn --at 0          (reorder inside its collection)`,
    mutating: true,
    group: "objects",
    run(ctx) {
        const object = requireObject(ctx, ctx.arg(0, "selector"));
        const to = ctx.str("to");
        const target = to
            ? requireArray(ctx, to)
            : (getParent(object) as EezObject[]);
        if (!isArray(target)) {
            throw new UsageError("--to is required");
        }
        moveObject(ctx, object, target, ctx.num("at"));
        ctx.changed(`moved ${selectorOf(object)}`);
        ctx.emit(objectSummary(object));
    }
};

const dupCommand: CommandDef = {
    name: "obj dup",
    aliases: ["dup"],
    summary: "Duplicate an object (new objIDs, unique names)",
    usage: "obj dup <selector> [--name new-name] [--to <collection-selector>]",
    mutating: true,
    group: "objects",
    run(ctx) {
        const object = requireObject(ctx, ctx.arg(0, "selector"));
        const to = ctx.str("to");
        const target = to
            ? requireArray(ctx, to)
            : (getParent(object) as EezObject[]);
        if (!isArray(target)) {
            throw new CliError(`${selectorOf(object)} is not in a collection`);
        }
        const js = objectToJS(object);
        const newName = ctx.str("name");
        if (newName) {
            if (js.identifier !== undefined) js.identifier = newName;
            else js.name = newName;
        }
        const copy = createObject<EezObject>(
            ctx.store,
            js,
            (object as any).constructor
        );
        const index = target.indexOf(object);
        const added =
            index != -1
                ? insertObject(target, index + 1, copy)
                : ctx.store.addObject(target, copy);
        ctx.changed(`duplicated ${selectorOf(object)} -> ${selectorOf(added)}`);
        ctx.emit(objectSummary(added));
    }
};

export const objCommands: CommandDef[] = [
    getCommand,
    listCommand,
    findCommand,
    propsCommand,
    setCommand,
    addCommand,
    rmCommand,
    renameCommand,
    moveCommand,
    dupCommand
];
