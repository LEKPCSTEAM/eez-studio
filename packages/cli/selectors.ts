// Object selectors used by every command:
//
//   /userPages/0/components/1     object path (keys from the project root)
//   @<objID>                      object by its GUID
//   page:Main                     named object in a project collection
//   page:Main/btnOk               widget (by identifier / name, depth first)
//   page:Main/[0]/[2]             widget by child index
//   page:Main/$screen             LVGL screen (root) widget of the page
//   Main/btnOk                    same as page:Main/btnOk (pages and user widgets)
//   <any selector>#key/0/key      walk properties/array indexes from the object
//   project | settings | settings/general ...

import { isArray } from "eez-studio-shared/util";

import {
    EezObject,
    IEezObject,
    getParent,
    getKey,
    getClassInfo,
    PropertyType
} from "project-editor/core/object";
import { getObjectPath } from "project-editor/store/helper";
import { visitObjects } from "project-editor/core/search";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Project } from "project-editor/project/project";
import type { Page } from "project-editor/features/page/page";

import { CliError } from "cli/errors";
import { suggest, suggestHint } from "cli/suggest";
import { conventionalName, pageName, toSnakeCase } from "cli/naming";
import { classNameOf } from "cli/reflect";

////////////////////////////////////////////////////////////////////////////////

interface CollectionKind {
    kinds: string[];
    get: (project: Project) => EezObject[] | undefined;
    // label used by "list" style output
    title: string;
}

export const COLLECTIONS: CollectionKind[] = [
    { kinds: ["page"], title: "pages", get: p => p.userPages },
    {
        kinds: ["userWidget", "user-widget", "uw"],
        title: "user widgets",
        get: p => p.userWidgets
    },
    { kinds: ["action"], title: "actions", get: p => p.actions },
    {
        kinds: ["var", "variable"],
        title: "global variables",
        get: p => p.variables?.globalVariables
    },
    {
        kinds: ["struct", "structure"],
        title: "structures",
        get: p => p.variables?.structures
    },
    { kinds: ["enum"], title: "enums", get: p => p.variables?.enums },
    { kinds: ["style"], title: "styles", get: p => p.styles },
    {
        kinds: ["lvglStyle", "lvgl-style"],
        title: "LVGL styles",
        get: p => p.lvglStyles?.styles
    },
    { kinds: ["font"], title: "fonts", get: p => p.fonts },
    { kinds: ["bitmap", "image"], title: "bitmaps", get: p => p.bitmaps },
    { kinds: ["color"], title: "colors", get: p => p.colors },
    { kinds: ["theme"], title: "themes", get: p => p.themes },
    {
        kinds: ["group", "lvglGroup"],
        title: "LVGL groups",
        get: p => p.lvglGroups?.groups
    },
    {
        kinds: ["config", "configuration"],
        title: "build configurations",
        get: p => p.settings?.build?.configurations
    },
    {
        kinds: ["buildFile"],
        title: "build files",
        get: p => p.settings?.build?.files
    },
    {
        kinds: ["extension", "extensionDefinition"],
        title: "extension definitions",
        get: p => p.extensionDefinitions
    },
    {
        kinds: ["language"],
        title: "languages",
        get: p => p.texts?.languages
    },
    {
        kinds: ["text", "textResource"],
        title: "text resources",
        get: p => p.texts?.resources
    },
    {
        kinds: ["scpiSubsystem", "subsystem"],
        title: "SCPI subsystems",
        get: p => p.scpi?.subsystems
    },
    {
        kinds: ["shortcut"],
        title: "shortcuts",
        get: p => p.shortcuts?.shortcuts
    }
];

function findCollection(kind: string) {
    const lower = kind.toLowerCase();
    return COLLECTIONS.find(collection =>
        collection.kinds.some(k => k.toLowerCase() == lower)
    );
}

export function nameOf(object: IEezObject): string | undefined {
    const o = object as any;
    for (const key of [
        "identifier",
        "name",
        "resourceID",
        "languageID",
        "textResourceID"
    ]) {
        if (typeof o[key] == "string" && o[key]) {
            return o[key];
        }
    }
    return undefined;
}

// search collection items and their nested childStyles
function findNamed(items: EezObject[], name: string): EezObject | undefined {
    for (const item of items) {
        if (nameOf(item) == name) {
            return item;
        }
    }
    for (const item of items) {
        const childStyles = (item as any).childStyles;
        if (isArray(childStyles)) {
            const found = findNamed(childStyles, name);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

////////////////////////////////////////////////////////////////////////////////
// widget tree helpers

export function isLVGLWidget(object: IEezObject) {
    return object instanceof ProjectEditor.LVGLWidgetClass;
}

export function isPage(object: IEezObject): object is Page {
    return object instanceof ProjectEditor.PageClass;
}

export function getScreenWidget(page: any) {
    return page.lvglScreenWidget as EezObject | undefined;
}

// top level widgets of a page (LVGL: children of the screen widget)
export function getPageRootWidgets(page: any): EezObject[] {
    const screen = getScreenWidget(page);
    if (screen) {
        return (screen as any).children;
    }
    return page.components.filter(
        (component: any) => component instanceof ProjectEditor.WidgetClass
    );
}

export function getWidgetChildren(widget: IEezObject): EezObject[] {
    if (isPage(widget)) {
        return getPageRootWidgets(widget);
    }
    const w = widget as any;
    if (isArray(w.children)) {
        return w.children;
    }
    if (isArray(w.widgets)) {
        return w.widgets;
    }
    // ListWidget, GridWidget, SelectWidget ... have "itemWidget" or "widgets"
    if (w.itemWidget) {
        return [w.itemWidget];
    }
    return [];
}

export function getWidgetChildrenCollection(
    widget: IEezObject
): EezObject[] | undefined {
    if (isPage(widget)) {
        const screen = getScreenWidget(widget);
        if (screen) {
            return (screen as any).children;
        }
        return (widget as any).components;
    }
    const w = widget as any;
    if (isArray(w.children)) {
        return w.children;
    }
    if (isArray(w.widgets)) {
        return w.widgets;
    }
    return undefined;
}

function* walkWidgets(parent: IEezObject): Generator<EezObject> {
    for (const child of getWidgetChildren(parent)) {
        yield child;
        yield* walkWidgets(child);
    }
}

export function allPageWidgets(page: IEezObject) {
    return [...walkWidgets(page)];
}

function findWidgetByName(root: IEezObject, name: string) {
    for (const widget of walkWidgets(root)) {
        if (nameOf(widget) == name) {
            return widget;
        }
    }
    // also search non-widget flow components (actions) on the page
    if (isPage(root)) {
        for (const component of (root as any).components) {
            if (nameOf(component) == name) {
                return component as EezObject;
            }
        }
    }
    return undefined;
}

// lenient lookups: a name written without the naming convention finds the
// conventional one ("Main" -> "main_page", "title" -> "label_title")
function findWidgetByConventionalName(root: IEezObject, name: string) {
    const matches = [...walkWidgets(root)].filter(widget => {
        const widgetName = nameOf(widget);
        return (
            widgetName != undefined &&
            conventionalName("widget", classNameOf(widget), name) == widgetName
        );
    });
    return matches.length == 1 ? matches[0] : undefined;
}

function findNamedConventional(items: EezObject[], name: string) {
    for (const candidate of [pageName(name), toSnakeCase(name)]) {
        if (candidate && candidate != name) {
            const found = findNamed(items, candidate);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

////////////////////////////////////////////////////////////////////////////////

function walkPropertyPath(
    object: IEezObject,
    path: string,
    selector: string
): IEezObject {
    const parts = path.split("/").filter(part => part.length > 0);
    let current: any = object;
    for (const part of parts) {
        if (current == undefined) {
            break;
        }
        if (isArray(current)) {
            const index = Number(part);
            if (Number.isInteger(index)) {
                current = current[index < 0 ? current.length + index : index];
            } else {
                current = findNamed(current, part);
            }
        } else {
            const propertyInfo = getClassInfo(current).properties.find(
                propertyInfo => propertyInfo.name == part
            );
            if (
                !propertyInfo ||
                (propertyInfo.type != PropertyType.Object &&
                    propertyInfo.type != PropertyType.Array)
            ) {
                throw new CliError(
                    `"${part}" is not an object or array property (in selector "${selector}")`,
                    `use "obj get <selector> --props ${part}" to read scalar values`
                );
            }
            current = current[part];
        }
    }
    if (current == undefined) {
        throw new CliError(`Object not found: "${selector}"`);
    }
    return current;
}

function findByObjID(project: Project, objID: string) {
    for (const object of visitObjects(project)) {
        if (!isArray(object) && (object as any).objID == objID) {
            return object;
        }
    }
    return undefined;
}

function resolveWidgetPath(
    root: IEezObject,
    segments: string[],
    selector: string
): IEezObject {
    let current: IEezObject = root;
    let first = true;
    for (const segment of segments) {
        if (segment == "$screen" || segment == "$root") {
            const screen = isPage(current) ? getScreenWidget(current) : undefined;
            if (!screen) {
                throw new CliError(
                    `"${selector}": page has no LVGL screen widget`
                );
            }
            current = screen;
        } else {
            const indexMatch = segment.match(/^\[(-?\d+)\]$/);
            if (indexMatch) {
                const children = getWidgetChildren(current);
                let index = Number(indexMatch[1]);
                if (index < 0) {
                    index += children.length;
                }
                if (index < 0 || index >= children.length) {
                    throw new CliError(
                        `"${selector}": child index ${indexMatch[1]} out of range (${children.length} children)`
                    );
                }
                current = children[index];
            } else {
                // first segment: search the whole page, later: search subtree
                const found =
                    findWidgetByName(current, segment) ??
                    findWidgetByConventionalName(current, segment);
                if (!found) {
                    const names = allPageWidgets(current)
                        .map(nameOf)
                        .filter(Boolean) as string[];
                    throw new CliError(
                        `Widget "${segment}" not found (selector "${selector}")`,
                        suggest(segment, names).length > 0
                            ? suggestHint(segment, names)
                            : first
                            ? `run "page tree ${getPageName(root)}" to see widget selectors`
                            : undefined
                    );
                }
                current = found;
            }
        }
        first = false;
    }
    return current;
}

function getPageName(page: IEezObject) {
    return nameOf(page) ?? "?";
}

export function resolveSelector(
    project: Project,
    selector: string
): IEezObject {
    selector = selector.trim();
    if (!selector) {
        throw new CliError("Empty selector");
    }

    // property path suffix
    const hashIndex = selector.indexOf("#");
    if (hashIndex > 0) {
        const base = resolveSelector(project, selector.substring(0, hashIndex));
        return walkPropertyPath(
            base,
            selector.substring(hashIndex + 1),
            selector
        );
    }

    if (selector == "project" || selector == "/") {
        return project;
    }

    if (selector.startsWith("/")) {
        return walkPropertyPath(project, selector, selector);
    }

    if (selector.startsWith("@")) {
        const object = findByObjID(project, selector.substring(1));
        if (!object) {
            throw new CliError(`No object with objID "${selector.substring(1)}"`);
        }
        return object;
    }

    if (selector == "settings" || selector.startsWith("settings/")) {
        return walkPropertyPath(project, "/" + selector, selector);
    }

    let kind: string | undefined;
    let rest = selector;
    const colon = selector.indexOf(":");
    if (colon > 0) {
        kind = selector.substring(0, colon);
        rest = selector.substring(colon + 1);
    }

    const segments = rest.split("/");
    const name = segments.shift()!;

    if (kind) {
        const collection = findCollection(kind);
        if (!collection) {
            throw new CliError(
                `Unknown selector kind "${kind}"`,
                `known kinds: ${COLLECTIONS.map(c => c.kinds[0]).join(", ")}`
            );
        }
        const items = collection.get(project);
        if (!items) {
            throw new CliError(
                `This project has no ${collection.title} (selector "${selector}")`
            );
        }
        const item = /^\[\d+\]$/.test(name)
            ? items[Number(name.slice(1, -1))]
            : findNamed(items, name) ?? findNamedConventional(items, name);
        if (!item) {
            const names = items.map(nameOf).filter(Boolean);
            throw new CliError(
                `${collection.kinds[0]} "${name}" not found`,
                names.length
                    ? suggestHint(name, names as string[])
                    : `there are no ${collection.title}`
            );
        }
        if (segments.length == 0) {
            return item;
        }
        if (isPage(item)) {
            return resolveWidgetPath(item, segments, selector);
        }
        return walkPropertyPath(item, segments.join("/"), selector);
    }

    // bare "Main/btn" -> page or user widget
    const pages = [...(project.userPages ?? []), ...(project.userWidgets ?? [])];
    const page = findNamed(pages, name) ?? findNamedConventional(pages, name);
    if (page) {
        return segments.length == 0
            ? page
            : resolveWidgetPath(page, segments, selector);
    }

    // bare name: any named top level object
    const matches: EezObject[] = [];
    for (const collection of COLLECTIONS) {
        const items = collection.get(project);
        if (items) {
            const item = findNamed(items, name);
            if (item) {
                matches.push(item);
            }
        }
    }
    if (matches.length == 1 && segments.length == 0) {
        return matches[0];
    }
    if (matches.length > 1) {
        throw new CliError(
            `Selector "${selector}" is ambiguous`,
            `use a kind prefix: ${matches
                .map(match => selectorOf(match))
                .join(", ")}`
        );
    }

    throw new CliError(
        `Object not found: "${selector}"`,
        `selectors: page:Name, page:Name/widget, style:Name, font:Name, @objID, /object/path — see "eez-cli help selectors"`
    );
}

////////////////////////////////////////////////////////////////////////////////
// selector generation

export function objectPath(object: IEezObject) {
    return "/" + getObjectPath(object).join("/");
}

function collectionOf(object: IEezObject, project: Project) {
    const parent = getParent(object);
    if (!parent || !isArray(parent)) {
        return undefined;
    }
    for (const collection of COLLECTIONS) {
        if (collection.get(project) === parent) {
            return collection;
        }
    }
    return undefined;
}

function widgetSelector(page: EezObject, widget: EezObject): string {
    const pageSelector = selectorOf(page);
    if (widget === getScreenWidget(page)) {
        return pageSelector + "/$screen";
    }
    const name = nameOf(widget);
    if (name) {
        // must resolve back to the same widget
        if (findWidgetByName(page, name) === widget) {
            return pageSelector + "/" + name;
        }
    }
    // index path
    const indexes: number[] = [];
    let current: IEezObject = widget;
    while (current && current !== page) {
        let parent: IEezObject = getParent(current);
        while (parent && isArray(parent)) {
            parent = getParent(parent);
        }
        if (!parent) {
            break;
        }
        const container: IEezObject =
            parent === getScreenWidget(page) ? page : parent;
        const index = getWidgetChildren(container).indexOf(current as EezObject);
        if (index == -1) {
            return objectPath(widget);
        }
        indexes.unshift(index);
        current = container;
    }
    return pageSelector + indexes.map(i => `/[${i}]`).join("");
}

export function selectorOf(object: IEezObject): string {
    if (!object) {
        return "";
    }

    const project = ProjectEditor.getProject(object) as Project;

    if (object === project) {
        return "project";
    }

    if (!isArray(object)) {
        const name = nameOf(object);

        // item of a top level collection (styles also nest in childStyles)
        let owner: IEezObject = object;
        while (name) {
            const array = getParent(owner);
            if (!array || !isArray(array)) {
                break;
            }
            const collection = collectionOf(owner, project);
            if (collection) {
                if (findNamed(collection.get(project)!, name) === object) {
                    return `${collection.kinds[0]}:${name}`;
                }
                break;
            }
            if (getKey(array) != "childStyles") {
                break;
            }
            owner = getParent(array);
        }

        // widget inside page / user widget
        if (object instanceof ProjectEditor.ComponentClass) {
            const page = ProjectEditor.getFlow(object);
            if (page && isPage(page)) {
                if (
                    object instanceof ProjectEditor.WidgetClass &&
                    (allPageWidgets(page).includes(object) ||
                        object === getScreenWidget(page))
                ) {
                    return widgetSelector(page, object);
                }
            }
        }
    }

    // fall back to nearest named ancestor + property path
    const path = getObjectPath(object);
    for (let i = path.length - 1; i > 0; i--) {
        let ancestor: any = project;
        for (let j = 0; j < i; j++) {
            ancestor = ancestor?.[path[j]];
        }
        if (ancestor && !isArray(ancestor) && ancestor !== project) {
            const ancestorSelector = selectorOf(ancestor);
            if (!ancestorSelector.startsWith("/")) {
                return ancestorSelector + "#" + path.slice(i).join("/");
            }
        }
    }

    return objectPath(object);
}
