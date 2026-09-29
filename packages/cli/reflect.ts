// Generic, reflection based access to the project model:
// class lookup, schema description, value coercion and object creation.

import { toJS } from "mobx";

import { isArray, objectClone } from "eez-studio-shared/util";

import {
    EezClass,
    EezObject,
    IEezObject,
    PropertyInfo,
    PropertyType,
    TYPE_NAMES,
    ClassInfo,
    EnumItem,
    getClass,
    getClassInfo,
    getClassByName,
    getDefaultValue,
    eezClassToClassNameMap,
    isPropertyHidden,
    isPropertyDisabled,
    isSubclassOf,
    getAllClasses
} from "project-editor/core/object";
import { createObject } from "project-editor/store/serialization";
import { insertObject } from "project-editor/store/commands";
import type { ProjectStore } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Project } from "project-editor/project/project";

import { CliError } from "cli/errors";
import { nameOf, selectorOf, objectPath } from "cli/selectors";
import { suggest, suggestHint } from "cli/suggest";
import {
    applyNaming,
    applyNamingToValues,
    namingViolation,
    pageName,
    toSnakeCase
} from "cli/naming";

////////////////////////////////////////////////////////////////////////////////

export function classNameOf(objectOrClass: IEezObject | EezClass): string {
    const aClass =
        typeof objectOrClass == "function"
            ? objectOrClass
            : getClass(objectOrClass as IEezObject);
    return eezClassToClassNameMap.get(aClass) ?? aClass?.name ?? "?";
}

export function allClassNames() {
    return [...eezClassToClassNameMap.values()].sort();
}

// Finds a class by name, accepting short forms:
//   "LVGLButtonWidget", "Button" (LVGL project), "button", "lvgl-button", "Log" ...
export function findClassByName(
    store: ProjectStore,
    name: string,
    baseClass?: EezClass
): { name: string; aClass: EezClass } | undefined {
    const candidates: string[] = [];

    const normalized = name.replace(/[-_\s]/g, "");

    const isLVGL = store.projectTypeTraits.isLVGL;

    candidates.push(name);
    if (isLVGL) {
        candidates.push("LVGL" + normalized + "Widget");
        candidates.push("LVGL" + normalized);
    }
    candidates.push(normalized + "Widget");
    candidates.push(normalized + "ActionComponent");
    if (!isLVGL) {
        candidates.push("LVGL" + normalized + "Widget");
    }
    candidates.push(normalized);

    const allNames = allClassNames();
    const importedNames = [...store.importedActionComponentClasses.keys()];

    const check = (className: string) => {
        const aClass = getClassByName(store, className);
        if (!aClass) {
            return undefined;
        }
        if (baseClass && !isSubclassOf(aClass.classInfo, baseClass.classInfo)) {
            return undefined;
        }
        return { name: className, aClass };
    };

    for (const candidate of candidates) {
        const result = check(candidate);
        if (result) {
            return result;
        }
    }

    // case insensitive
    for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        const className = [...allNames, ...importedNames].find(
            n => n.toLowerCase() == lower
        );
        if (className) {
            const result = check(className);
            if (result) {
                return result;
            }
        }
    }

    return undefined;
}

export function requireClass(
    store: ProjectStore,
    name: string,
    baseClass?: EezClass,
    what = "class"
) {
    const result = findClassByName(store, name, baseClass);
    if (!result) {
        const candidates = allClassNames()
            .filter(className => {
                if (!baseClass) return true;
                const aClass = getClassByName(store, className);
                return !!aClass && isSubclassOf(aClass.classInfo, baseClass.classInfo);
            })
            .flatMap(className => [
                className,
                className.replace(/^LVGL/, "").replace(/(Widget|ActionComponent)$/, "")
            ]);
        throw new CliError(
            `Unknown ${what} "${name}"`,
            suggestHint(name, candidates, "", 0) ??
                (what == "widget type"
                    ? `run "widget types" to list available widget types`
                    : `run "schema classes" to list classes`)
        );
    }
    return result;
}

////////////////////////////////////////////////////////////////////////////////

export function propertyTypeName(propertyInfo: PropertyInfo) {
    return TYPE_NAMES[propertyInfo.type] ?? String(propertyInfo.type);
}

export function getEnumItems(
    object: IEezObject | undefined,
    propertyInfo: PropertyInfo
): EnumItem[] | undefined {
    if (!propertyInfo.enumItems) {
        return undefined;
    }
    if (typeof propertyInfo.enumItems == "function") {
        if (!object) {
            return undefined;
        }
        try {
            return propertyInfo.enumItems(object);
        } catch (err) {
            return undefined;
        }
    }
    return propertyInfo.enumItems;
}

function isComputed(propertyInfo: PropertyInfo) {
    return propertyInfo.computed === true && !propertyInfo.modifiable;
}

export interface PropertySchema {
    name: string;
    type: string;
    class?: string;
    enum?: (string | number)[];
    reference?: string;
    flowProperty?: string;
    optional?: boolean;
    computed?: boolean;
    hidden?: boolean;
    default?: any;
}

export function describeProperty(
    propertyInfo: PropertyInfo,
    object?: IEezObject
): PropertySchema {
    const schema: PropertySchema = {
        name: propertyInfo.name,
        type: propertyTypeName(propertyInfo)
    };

    if (propertyInfo.typeClass) {
        schema.class = classNameOf(propertyInfo.typeClass);
    }

    const enumItems = getEnumItems(object, propertyInfo);
    if (enumItems) {
        schema.enum = enumItems.map(item => item.id);
    }

    if (propertyInfo.referencedObjectCollectionPath) {
        schema.reference = propertyInfo.referencedObjectCollectionPath;
    }

    if (propertyInfo.flowProperty) {
        const flowProperty =
            typeof propertyInfo.flowProperty == "function"
                ? object
                    ? propertyInfo.flowProperty(object)
                    : undefined
                : propertyInfo.flowProperty;
        if (flowProperty) {
            schema.flowProperty = flowProperty;
        }
    }

    if (propertyInfo.isOptional === true) {
        schema.optional = true;
    }

    if (isComputed(propertyInfo)) {
        schema.computed = true;
    }

    if (object) {
        try {
            if (isPropertyHidden(object, propertyInfo)) {
                schema.hidden = true;
            }
        } catch (err) {}
    }

    if (propertyInfo.defaultValue !== undefined) {
        schema.default = propertyInfo.defaultValue;
    }

    return schema;
}

// properties worth showing: skip internal and (when an object is given) hidden
export function visibleProperties(
    classInfo: ClassInfo,
    object?: IEezObject,
    includeHidden = false
) {
    return classInfo.properties.filter(propertyInfo => {
        if (propertyInfo.name.startsWith("_")) {
            return false;
        }
        if (propertyInfo.type == PropertyType.Null) {
            return false;
        }
        if (includeHidden) {
            return true;
        }
        // computed values and property grid helpers (geometryProperties,
        // styleUI, timelineUI, ...) can't be set
        if (propertyInfo.computed === true && !propertyInfo.modifiable) {
            return false;
        }
        if (object) {
            // "disabled" properties don't apply to this object (e.g. other
            // project type); properties only hidden in the property grid
            // (geometry, flags ...) are still relevant
            try {
                if (isPropertyDisabled(object, propertyInfo)) {
                    return false;
                }
            } catch (err) {}
        }
        return true;
    });
}

export function describeClass(
    aClass: EezClass,
    object?: IEezObject,
    includeHidden = false
) {
    const classInfo = aClass.classInfo;
    const parents: string[] = [];
    for (
        let parent = classInfo.parentClassInfo;
        parent;
        parent = parent.parentClassInfo
    ) {
        const parentClass = getAllClasses().find(c => c.classInfo === parent);
        if (parentClass) {
            parents.push(classNameOf(parentClass));
        }
    }

    // own properties first (the interesting ones), then inherited ones
    const inheritedNames = new Set(
        (classInfo.parentClassInfo?.properties ?? []).map(p => p.name)
    );
    const properties = visibleProperties(classInfo, object, includeHidden);
    const own = properties.filter(p => !inheritedNames.has(p.name));
    const inherited = properties.filter(p => inheritedNames.has(p.name));

    const result: any = {
        class: classNameOf(aClass),
        extends: parents,
        ownProperties: own.map(p => p.name),
        properties: [...own, ...inherited].map(propertyInfo =>
            describeProperty(propertyInfo, object)
        )
    };

    if (classInfo.defaultValue) {
        result.defaultValue = toJS(classInfo.defaultValue);
    }

    if (classInfo.componentPaletteGroupName) {
        result.paletteGroup = classInfo.componentPaletteGroupName;
    }

    if (classInfo.lvgl && typeof classInfo.lvgl == "object") {
        result.lvgl = {
            parts: classInfo.lvgl.parts,
            defaultFlags: classInfo.lvgl.defaultFlags
        };
    }

    if (classInfo.widgetEvents && typeof classInfo.widgetEvents == "object") {
        result.events = Object.keys(classInfo.widgetEvents);
    }

    return result;
}

////////////////////////////////////////////////////////////////////////////////
// reading values

function valueToJS(value: any): any {
    if (value == undefined) {
        return value;
    }
    if (typeof value != "object") {
        return value;
    }
    return toJS(value);
}

function summarizeChild(child: any) {
    if (isArray(child)) {
        return { $array: child.length };
    }
    const summary: any = { $class: classNameOf(child) };
    const name = nameOf(child);
    if (name) {
        summary.$name = name;
    }
    return summary;
}

export function describeObject(
    object: IEezObject,
    options: {
        depth?: number;
        props?: string[];
        includeHidden?: boolean;
        includeUndefined?: boolean;
    } = {}
): any {
    const depth = options.depth ?? 1;

    if (isArray(object)) {
        return {
            $selector: selectorOf(object),
            $path: objectPath(object),
            $array: object.length,
            items: object.map((item: EezObject) =>
                depth > 0
                    ? describeObject(item, { ...options, depth: depth - 1 })
                    : Object.assign(
                          { $selector: selectorOf(item) },
                          summarizeChild(item)
                      )
            )
        };
    }

    const classInfo = getClassInfo(object);

    const result: any = {
        $selector: selectorOf(object),
        $path: objectPath(object),
        $class: classNameOf(object)
    };

    if ((object as any).objID) {
        result.$objID = (object as any).objID;
    }

    let properties = visibleProperties(
        classInfo,
        object,
        options.includeHidden || !!options.props
    );
    if (options.props) {
        const wanted = options.props;
        const unknown = wanted.filter(
            name => !classInfo.properties.find(p => p.name == name)
        );
        if (unknown.length > 0) {
            throw unknownPropertyError(object, unknown[0]);
        }
        properties = properties.filter(p => wanted.includes(p.name));
    }

    for (const propertyInfo of properties) {
        let value: any;
        try {
            value = (object as any)[propertyInfo.name];
        } catch (err) {
            continue;
        }

        if (
            propertyInfo.type == PropertyType.Object ||
            propertyInfo.type == PropertyType.Array
        ) {
            if (value == undefined) {
                if (options.includeUndefined) {
                    result[propertyInfo.name] = null;
                }
                continue;
            }
            if (depth > 0) {
                result[propertyInfo.name] = isArray(value)
                    ? value.map((item: any) =>
                          describeObject(item, {
                              ...options,
                              props: undefined,
                              depth: depth - 1
                          })
                      )
                    : describeObject(value, {
                          ...options,
                          props: undefined,
                          depth: depth - 1
                      });
            } else {
                result[propertyInfo.name] = summarizeChild(value);
            }
        } else {
            if (value === undefined && !options.includeUndefined) {
                continue;
            }
            result[propertyInfo.name] = valueToJS(value);
        }
    }

    return result;
}

////////////////////////////////////////////////////////////////////////////////
// writing values

export function unknownPropertyError(object: IEezObject, name: string) {
    const names = visibleProperties(getClassInfo(object), object).map(
        p => p.name
    );
    return new CliError(
        `${classNameOf(object)} has no property "${name}"`,
        suggestHint(name, names, "properties", 100)
    );
}

function enumHint(raw: string, ids: string[]) {
    const close = suggest(raw, ids);
    return (
        `allowed: ${ids.join(", ")}` +
        (close.length > 0 ? ` — did you mean ${close.map(c => `"${c}"`).join(" or ")}?` : "")
    );
}

function parseBoolean(raw: string, name: string) {
    const lower = raw.toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) {
        return true;
    }
    if (["false", "0", "no", "off"].includes(lower)) {
        return false;
    }
    throw new CliError(`"${name}" expects true or false, got "${raw}"`);
}

function parseNumber(raw: string, name: string) {
    const n = Number(raw);
    if (raw.trim() == "" || !Number.isFinite(n)) {
        throw new CliError(`"${name}" expects a number, got "${raw}"`);
    }
    return n;
}

function parseJSON(raw: string, name: string) {
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new CliError(`"${name}" expects a JSON value, got "${raw}"`);
    }
}

export function findReferencedObject(
    project: Project,
    collectionPath: string,
    name: string
) {
    let collection: any = project;
    for (const key of collectionPath.split("/")) {
        collection = collection?.[key];
    }
    if (!isArray(collection)) {
        return { collection: undefined, object: undefined };
    }
    const find = (items: any[]): any => {
        for (const item of items) {
            if (nameOf(item) == name) {
                return item;
            }
            if (isArray(item.childStyles)) {
                const found = find(item.childStyles);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    };
    return { collection, object: find(collection) };
}

function getLvglExpressionType(
    object: IEezObject,
    propertyInfo: PropertyInfo,
    pending?: { [name: string]: any }
): string | undefined {
    if (!propertyInfo.expressionType) {
        return undefined;
    }
    const typePropertyName = propertyInfo.name + "Type";
    const typePropertyInfo = getClassInfo(object).properties.find(
        p => p.name == typePropertyName
    );
    if (!typePropertyInfo) {
        return undefined;
    }
    if (pending && pending[typePropertyName] !== undefined) {
        return String(pending[typePropertyName]);
    }
    return (object as any)[typePropertyName] ?? "literal";
}

function coerceLiteral(propertyInfo: PropertyInfo, raw: any) {
    if (typeof raw != "string") {
        return raw;
    }
    switch (propertyInfo.expressionType) {
        case "integer":
        case "float":
        case "double":
            return parseNumber(raw, propertyInfo.name);
        case "boolean":
            return parseBoolean(raw, propertyInfo.name);
        default:
            return raw;
    }
}

// Converts a command line value (always a string) or a JSON value to the
// property type. Values already typed (from JSON input) are validated only.
export function coerceValue(
    object: IEezObject,
    propertyInfo: PropertyInfo,
    raw: any,
    options: { force?: boolean; pending?: { [name: string]: any } } = {}
): any {
    const name = propertyInfo.name;

    if (raw === null) {
        return undefined;
    }

    if (isComputed(propertyInfo)) {
        throw new CliError(`Property "${name}" is computed (read only)`);
    }

    const isString = typeof raw == "string";

    let type = propertyInfo.type;
    if (propertyInfo.dynamicType) {
        try {
            type = propertyInfo.dynamicType(object);
        } catch (err) {}
    }

    switch (type) {
        case PropertyType.Boolean:
            return isString ? parseBoolean(raw, name) : Boolean(raw);

        case PropertyType.Number:
            return isString ? parseNumber(raw, name) : raw;

        case PropertyType.Enum: {
            const items = getEnumItems(object, propertyInfo);
            if (!items || items.length == 0) {
                return raw;
            }
            const match =
                items.find(item => item.id === raw) ??
                items.find(item => String(item.id) === String(raw)) ??
                items.find(
                    item =>
                        String(item.id).toLowerCase() ==
                        String(raw).toLowerCase()
                ) ??
                items.find(
                    item =>
                        typeof item.label == "string" &&
                        item.label.toLowerCase() == String(raw).toLowerCase()
                ) ??
                // e.g. a font name written without the naming convention
                items.find(item => String(item.id) === toSnakeCase(String(raw)));
            if (!match) {
                if (options.force) {
                    return raw;
                }
                throw new CliError(
                    `Invalid value "${raw}" for "${name}"`,
                    enumHint(String(raw), items.map(item => String(item.id)))
                );
            }
            return match.id;
        }

        case PropertyType.Object:
        case PropertyType.Array:
        case PropertyType.JSON:
            if (isString) {
                if (type == PropertyType.JSON) {
                    // JSON properties are stored as a JSON string
                    return raw;
                }
                return parseJSON(raw, name);
            }
            return type == PropertyType.JSON ? JSON.stringify(raw) : raw;

        case PropertyType.StringArray:
            if (isString) {
                return raw.trim().startsWith("[")
                    ? parseJSON(raw, name)
                    : raw
                          .split(",")
                          .map((s: string) => s.trim())
                          .filter(Boolean);
            }
            return raw;

        case PropertyType.ConfigurationReference:
            if (isString) {
                return raw.trim().startsWith("[")
                    ? parseJSON(raw, name)
                    : raw
                          .split(",")
                          .map((s: string) => s.trim())
                          .filter(Boolean);
            }
            return raw;

        case PropertyType.ObjectReference: {
            const value = String(raw);
            // LVGL expression property: "<name>Type" selects literal or expression
            const lvglType = getLvglExpressionType(
                object,
                propertyInfo,
                options.pending
            );
            if (lvglType !== undefined) {
                if (lvglType == "expression") {
                    if (
                        ProjectEditor.getProject(object).projectTypeTraits
                            .hasFlowSupport
                    ) {
                        // an expression, checked by "check"
                        return value;
                    }
                    // without flow support: must be a global variable name
                } else {
                    return coerceLiteral(propertyInfo, raw);
                }
            } else if (typeof propertyInfo.flowProperty == "string") {
                // flow expression, checked by "check"
                return value;
            }
            const collectionPath =
                propertyInfo.dynamicTypeReferencedObjectCollectionPath?.(
                    object
                ) ?? propertyInfo.referencedObjectCollectionPath;
            if (value && collectionPath && !options.force) {
                const project = ProjectEditor.getProject(object) as Project;
                const { collection, object: referenced } =
                    findReferencedObject(project, collectionPath, value);
                if (collection && !referenced) {
                    // written without the naming convention: "Card" -> "card"
                    for (const candidate of [toSnakeCase(value), pageName(value)]) {
                        if (
                            candidate != value &&
                            findReferencedObject(project, collectionPath, candidate).object
                        ) {
                            return candidate;
                        }
                    }
                    const names = collection
                        .map((item: any) => nameOf(item))
                        .filter(Boolean) as string[];
                    throw new CliError(
                        `"${name}" references "${value}" which does not exist in ${collectionPath}`,
                        names.length > 0
                            ? suggestHint(value, names)
                            : `${collectionPath} is empty — create it first (or pass --force)`
                    );
                }
            }
            return value;
        }

        case PropertyType.Any:
            if (isString) {
                try {
                    return JSON.parse(raw);
                } catch (err) {
                    return raw;
                }
            }
            return raw;

        default:
            // a theme color name written without the naming convention
            if (type == PropertyType.ThemedColor && isString && !/^(#|rgb)/i.test(raw)) {
                try {
                    const colors = (ProjectEditor.getProject(object) as Project).colors;
                    const snake = toSnakeCase(raw);
                    if (!colors.find(c => c.name == raw) && colors.find(c => c.name == snake)) {
                        return snake;
                    }
                } catch (err) {}
            }
            // String, MultilineText, Color, ThemedColor, Image, files, code ...
            return isString ? raw : typeof raw == "object" ? raw : String(raw);
    }
}

// Resolves "name" or "a.b" property names and coerces all values.
export function coerceValues(
    object: IEezObject,
    values: { [name: string]: any },
    options: { force?: boolean } = {}
) {
    const classInfo = getClassInfo(object);
    const result: { [name: string]: any } = {};
    for (const key of Object.keys(values)) {
        const [first, ...rest] = key.split(".");
        const propertyInfo = classInfo.properties.find(p => p.name == first);
        if (!propertyInfo) {
            throw unknownPropertyError(object, first);
        }
        if (rest.length > 0) {
            // nested value inside an Object property (e.g. "resizing.pinToLeft")
            const nested = (object as any)[first];
            if (!nested || isArray(nested)) {
                throw new CliError(
                    `"${first}" is not an object property, can't set "${key}"`
                );
            }
            const nestedPropertyInfo = getClassInfo(nested).properties.find(
                p => p.name == rest.join(".")
            );
            result[key] = nestedPropertyInfo
                ? coerceValue(nested, nestedPropertyInfo, values[key], options)
                : values[key];
        } else {
            result[key] = coerceValue(object, propertyInfo, values[key], {
                ...options,
                pending: values
            });
        }
    }
    return result;
}

export function setProperties(
    store: ProjectStore,
    object: IEezObject,
    values: { [name: string]: any },
    options: { force?: boolean } = {}
) {
    if (Object.keys(values).length == 0) {
        return;
    }
    values = applyNamingToValues(object, classNameOf(object), { ...values });
    const coerced = coerceValues(object, values, options);

    // nested keys ("a.b") are applied on the nested object directly
    const direct: any = {};
    for (const key of Object.keys(coerced)) {
        const [first, ...rest] = key.split(".");
        if (rest.length > 0) {
            const nested = (object as any)[first];
            if (getClassInfo(nested).properties.find(p => p.name == rest[0])) {
                store.updateObject(nested, { [rest.join(".")]: coerced[key] });
                continue;
            }
        }
        direct[key] = coerced[key];
    }

    if (Object.keys(direct).length > 0) {
        store.updateObject(object, direct);
    }
}

////////////////////////////////////////////////////////////////////////////////
// creating objects

const CREATE_TIME_PROPERTIES = ["name", "identifier", "type"];

// Create an object the same way the components palette does: class default
// value + component default value, then apply given values.
export function createObjectOfClass(
    store: ProjectStore,
    className: string,
    aClass: EezClass,
    values: { [name: string]: any } = {}
): { object: EezObject; remaining: { [name: string]: any } } {
    const classInfo = aClass.classInfo;

    const jsObject: any = {};

    const classDefaultValue = getDefaultValue(store, classInfo);
    if (classDefaultValue) {
        Object.assign(jsObject, objectClone(classDefaultValue));
    }

    if (classInfo.componentDefaultValue) {
        Object.assign(
            jsObject,
            objectClone(classInfo.componentDefaultValue(store))
        );
    }

    const isComponent = isSubclassOf(
        classInfo,
        ProjectEditor.ComponentClass.classInfo
    );

    if (isComponent) {
        jsObject.type = className;
    }

    const remaining: { [name: string]: any } = {};
    for (const key of Object.keys(values)) {
        const propertyInfo = classInfo.properties.find(p => p.name == key);
        if (
            CREATE_TIME_PROPERTIES.includes(key) &&
            propertyInfo &&
            (propertyInfo.type == PropertyType.String ||
                propertyInfo.type == PropertyType.Enum)
        ) {
            jsObject[key] = String(values[key]);
        } else {
            remaining[key] = values[key];
        }
    }

    const object = createObject<EezObject>(store, jsObject, aClass);

    if (isComponent) {
        const component = object as any;
        if (component.left == undefined) component.left = 0;
        if (component.top == undefined) component.top = 0;
        if (component.width == undefined) component.width = 0;
        if (component.height == undefined) component.height = 0;
    }

    return { object, remaining };
}

// Adds a new object to a collection (array) and applies the values.
export function addNewObject(
    store: ProjectStore,
    collection: IEezObject,
    className: string,
    aClass: EezClass,
    values: { [name: string]: any } = {},
    options: { index?: number; force?: boolean } = {}
) {
    const { object, remaining } = createObjectOfClass(
        store,
        className,
        aClass,
        values
    );

    let added: EezObject;
    if (
        options.index != undefined &&
        isArray(collection) &&
        options.index < collection.length
    ) {
        const index = options.index < 0 ? 0 : options.index;
        added = insertObject(collection, index, object) as EezObject;
    } else {
        added = store.addObject(collection, object);
    }

    // naming convention (needs the added object: page vs user widget)
    const violation = namingViolation(added);
    if (violation) {
        store.updateObject(added, {
            [violation.property]: applyNaming(
                added,
                className,
                violation.property,
                violation.name
            )
        });
    }

    setProperties(store, added, remaining, options);

    return added;
}
