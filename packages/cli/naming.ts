// Naming convention enforced by the CLI (all names are snake_case):
//
//   widgets     <type>_<name>     label_title, img_person, btn_save, img_icon_home
//   pages       <name>_page       home_page, settings_page
//   other named objects (user widgets, bitmaps, fonts, styles, colors, themes,
//   variables, actions, structs, enums, groups): <name>   icon_home, roboto_20
//
// Names that don't follow the convention are corrected automatically (with a
// note in the command output). "check" reports existing violations and
// "naming fix" renames them (references are updated).

import { IEezObject, getParent } from "project-editor/core/object";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { visitObjects } from "project-editor/core/search";

import { classNameOf } from "cli/reflect";

// widget type (class name without LVGL/Widget/Dashboard) -> name prefix
export const WIDGET_PREFIXES: { [type: string]: string } = {
    AnimationImage: "animimg",
    Arc: "arc",
    Bar: "bar",
    Bitmap: "img",
    Button: "btn",
    ButtonMatrix: "btnmatrix",
    Calendar: "calendar",
    Canvas: "canvas",
    Chart: "chart",
    Checkbox: "checkbox",
    Colorwheel: "colorwheel",
    Container: "cont",
    Dropdown: "dropdown",
    DropDownList: "dropdown",
    Image: "img",
    Imgbutton: "imgbtn",
    Keyboard: "keyboard",
    Label: "label",
    Led: "led",
    Line: "line",
    List: "list",
    Menu: "menu",
    MessageBox: "msgbox",
    MessageBoxButton: "msgbox_btn",
    Meter: "meter",
    Panel: "panel",
    QRCode: "qrcode",
    Rectangle: "rect",
    Roller: "roller",
    Scale: "scale",
    Slider: "slider",
    Span: "span",
    Spinbox: "spinbox",
    Spinner: "spinner",
    Switch: "switch",
    Tab: "tab",
    Table: "table",
    Tabview: "tabview",
    Text: "text",
    TextInput: "input",
    Textarea: "textarea",
    TileView: "tileview",
    UserWidget: "uw",
    Window: "win"
};

// other spellings of a prefix that are replaced by the canonical one
const PREFIX_ALIASES: { [prefix: string]: string[] } = {
    label: ["lbl"],
    img: ["image", "pic"],
    btn: ["button", "bt"],
    cont: ["container"],
    win: ["window"],
    msgbox: ["messagebox", "message_box", "mbox"],
    imgbtn: ["imagebutton", "image_button", "img_btn"],
    switch: ["sw"],
    checkbox: ["cb", "chk", "check"],
    dropdown: ["dd", "drop"],
    textarea: ["ta", "text_area"],
    keyboard: ["kb"],
    slider: ["sld", "sl"],
    tabview: ["tab_view"],
    tileview: ["tile_view"],
    btnmatrix: ["button_matrix", "btn_matrix", "btnm"],
    colorwheel: ["color_wheel", "cw"],
    animimg: ["anim_img", "animation_image"]
};

export function toSnakeCase(text: string) {
    let result = String(text)
        // camelCase / PascalCase boundaries
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
        // anything that is not a letter or digit separates words
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
    if (/^[0-9]/.test(result)) {
        result = "n_" + result;
    }
    return result;
}

export function widgetTypeName(className: string) {
    return className.replace(/^LVGL/, "").replace(/Widget$/, "").replace(/Dashboard$/, "");
}

export function widgetPrefix(className: string) {
    const type = widgetTypeName(className);
    return WIDGET_PREFIXES[type] ?? toSnakeCase(type);
}

function stripPrefix(snake: string, prefixes: string[]) {
    for (const prefix of prefixes.sort((a, b) => b.length - a.length)) {
        if (snake == prefix) {
            return "";
        }
        if (snake.startsWith(prefix + "_")) {
            return snake.substring(prefix.length + 1);
        }
    }
    return undefined;
}

// "title" -> "label_title", "lblTitle" -> "label_title", "label_title" -> same
export function widgetName(className: string, name: string) {
    const prefix = widgetPrefix(className);
    let snake = toSnakeCase(name);
    const rest = stripPrefix(snake, [prefix, ...(PREFIX_ALIASES[prefix] ?? [])]);
    if (rest !== undefined) {
        snake = rest;
    }
    return snake ? `${prefix}_${snake}` : prefix;
}

// "Settings" -> "settings_page", "page_settings" -> "settings_page"
export function pageName(name: string) {
    let snake = toSnakeCase(name);
    if (snake.endsWith("_page")) {
        snake = snake.substring(0, snake.length - "_page".length);
    } else if (snake.startsWith("page_")) {
        snake = snake.substring("page_".length);
    } else if (snake == "page") {
        snake = "";
    }
    return snake ? `${snake}_page` : "page";
}

////////////////////////////////////////////////////////////////////////////////

export type NamingKind = "widget" | "page" | "plain";

// classes whose "name" is an identifier (other names, e.g. SCPI commands,
// build configurations or text resources, are left alone)
const PLAIN_NAMED_CLASSES = new Set([
    "Style",
    "LVGLStyle",
    "Color",
    "Theme",
    "Font",
    "Bitmap",
    "Variable",
    "Action",
    "Structure",
    "StructureField",
    "Enum",
    "EnumMember",
    "LVGLGroup"
]);

function isUserWidgetPage(object: any) {
    if (object.isUsedAsUserWidget) {
        return true;
    }
    try {
        const project = ProjectEditor.getProject(object);
        return getParent(object) === project.userWidgets;
    } catch (err) {
        return false;
    }
}

export function namingKindOf(object: IEezObject | undefined, className: string): NamingKind | undefined {
    if (className == "LVGLScreenWidget") {
        return undefined;
    }
    if (object instanceof ProjectEditor.WidgetClass || /Widget$/.test(className)) {
        return "widget";
    }
    if (className == "Page") {
        return object && isUserWidgetPage(object) ? "plain" : "page";
    }
    if (PLAIN_NAMED_CLASSES.has(className)) {
        return "plain";
    }
    return undefined;
}

// the property holding the object's name
export function namePropertyOf(className: string, aClass?: any) {
    const properties = (aClass?.classInfo ?? {}).properties ?? [];
    if (properties.find((p: any) => p.name == "identifier")) {
        return "identifier";
    }
    if (properties.find((p: any) => p.name == "name")) {
        return "name";
    }
    return undefined;
}

export function conventionalName(kind: NamingKind, className: string, name: string) {
    if (kind == "widget") return widgetName(className, name);
    if (kind == "page") return pageName(name);
    return toSnakeCase(name) || name;
}

////////////////////////////////////////////////////////////////////////////////
// notes about corrected names, collected per command by the runner

let notes: string[] = [];

export function takeNamingNotes() {
    const result = notes;
    notes = [];
    return result;
}

// Returns the conventional name for a name given to an object (or to a new
// object of className). Records a note when the name was changed.
export function applyNaming(
    object: IEezObject | undefined,
    className: string,
    propertyName: string,
    name: any
): any {
    if (typeof name != "string" || name == "") {
        return name;
    }
    if (propertyName != "name" && propertyName != "identifier") {
        return name;
    }
    const kind = namingKindOf(object, className);
    if (!kind) {
        return name;
    }
    return fixName(kind, className, name);
}

// conventional name for the given kind; records a note when it differs
export function fixName(kind: NamingKind, className: string, name: string) {
    const fixed = conventionalName(kind, className, name);
    if (fixed != name) {
        notes.push(
            `name "${name}" -> "${fixed}" (naming convention: ${
                kind == "widget"
                    ? `${widgetPrefix(className)}_<name>`
                    : kind == "page"
                    ? "<name>_page"
                    : "snake_case"
            })`
        );
    }
    return fixed;
}

// apply to a values object (name/identifier keys) before it is set
export function applyNamingToValues(
    object: IEezObject | undefined,
    className: string,
    values: { [key: string]: any }
) {
    for (const key of ["name", "identifier"]) {
        if (values[key] !== undefined) {
            values[key] = applyNaming(object, className, key, values[key]);
        }
    }
    return values;
}

// current name of an object and the conventional one (for check / naming fix)
export function namingViolation(object: IEezObject) {
    const className = classNameOf(object);
    const kind = namingKindOf(object, className);
    if (!kind) {
        return undefined;
    }
    const property = namePropertyOf(className, (object as any).constructor);
    if (!property) {
        return undefined;
    }
    // widgets without a name are allowed (no name = no C identifier)
    const name = (object as any)[property];
    if (typeof name != "string" || name == "") {
        return undefined;
    }
    const expected = conventionalName(kind, className, name);
    if (expected == name) {
        return undefined;
    }
    return { property, name, expected, kind };
}


// another object that already uses the name: LVGL widget identifiers are
// unique in the whole project, other names within their collection
export function findNameConflict(
    project: any,
    object: IEezObject | undefined,
    property: string,
    name: string,
    collection?: IEezObject[]
): IEezObject | undefined {
    if (property == "identifier") {
        for (const candidate of visitObjects(project)) {
            if (
                candidate !== object &&
                candidate instanceof ProjectEditor.LVGLWidgetClass &&
                (candidate as any).identifier == name
            ) {
                return candidate;
            }
        }
        return undefined;
    }
    const siblings = collection ?? (object ? getParent(object) : undefined);
    if (Array.isArray(siblings) || (siblings && (siblings as any).length !== undefined)) {
        for (const candidate of siblings as IEezObject[]) {
            if (candidate !== object && (candidate as any)[property] == name) {
                return candidate;
            }
        }
    }
    // pages and user widgets share one namespace
    if (object instanceof ProjectEditor.PageClass || (collection && (collection === project.userPages || collection === project.userWidgets))) {
        for (const page of [...(project.userPages ?? []), ...(project.userWidgets ?? [])]) {
            if (page !== object && page.name == name) {
                return page;
            }
        }
    }
    return undefined;
}
