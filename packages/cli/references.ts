// References by name that the project model's reference search doesn't find:
// theme colors (ThemedColor values) and colors/fonts/images used inside LVGL
// style definitions. Used by rm (refuse) and rename (update).

import { toJS } from "mobx";

import { isArray } from "eez-studio-shared/util";

import { IEezObject, PropertyType, getClassInfo } from "project-editor/core/object";
import { visitObjects } from "project-editor/core/search";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { lvglPropertiesMap } from "project-editor/lvgl/style-catalog";
import { LVGLStylesDefinition } from "project-editor/lvgl/style-definition";
import type { ProjectStore } from "project-editor/store";
import type { Project } from "project-editor/project/project";

import { selectorOf } from "cli/selectors";

type Kind = "color" | "font" | "bitmap";

export interface ExtraReference {
    where: string;
    update(store: ProjectStore, newName: string): void;
}

function kindOf(object: IEezObject): Kind | undefined {
    if (object instanceof ProjectEditor.ColorClass) return "color";
    if (object instanceof ProjectEditor.FontClass) return "font";
    if (object instanceof ProjectEditor.BitmapClass) return "bitmap";
    return undefined;
}

function styleValueMatches(kind: Kind, propertyName: string) {
    const propertyInfo = lvglPropertiesMap.get(propertyName);
    if (!propertyInfo) return false;
    if (kind == "color") return propertyInfo.type == PropertyType.ThemedColor;
    if (kind == "font") return propertyInfo.referencedObjectCollectionPath == "fonts";
    return propertyInfo.referencedObjectCollectionPath == "bitmaps";
}

export function findExtraReferences(project: Project, object: IEezObject): ExtraReference[] {
    const kind = kindOf(object);
    const name = (object as any).name;
    if (!kind || !name) {
        return [];
    }

    const references: ExtraReference[] = [];

    for (const candidate of visitObjects(project)) {
        if (isArray(candidate)) continue;

        // LVGL style definitions (shared styles and widget local styles)
        if (candidate instanceof LVGLStylesDefinition) {
            const definition = (candidate as any).definition;
            if (!definition) continue;
            for (const part of Object.keys(definition)) {
                for (const state of Object.keys(definition[part])) {
                    for (const propertyName of Object.keys(definition[part][state])) {
                        if (
                            definition[part][state][propertyName] === name &&
                            styleValueMatches(kind, propertyName)
                        ) {
                            const stylesDefinition = candidate;
                            references.push({
                                where: `${selectorOf(stylesDefinition)} ${part}/${state}/${propertyName}`,
                                update(store, newName) {
                                    const updated = toJS((stylesDefinition as any).definition);
                                    updated[part][state][propertyName] = newName;
                                    store.updateObject(stylesDefinition, { definition: updated });
                                }
                            });
                        }
                    }
                }
            }
            continue;
        }

        // ThemedColor properties hold a color name (or a literal color)
        if (kind == "color") {
            for (const propertyInfo of getClassInfo(candidate).properties) {
                if (propertyInfo.type != PropertyType.ThemedColor || propertyInfo.computed) continue;
                let value: any;
                try {
                    value = (candidate as any)[propertyInfo.name];
                } catch (err) {
                    continue;
                }
                if (value === name) {
                    const owner = candidate;
                    references.push({
                        where: `${selectorOf(owner)}#${propertyInfo.name}`,
                        update(store, newName) {
                            store.updateObject(owner, { [propertyInfo.name]: newName });
                        }
                    });
                }
            }
        }
    }

    return references;
}
