import { isArray } from "eez-studio-shared/util";

import { EezObject } from "project-editor/core/object";
import { visitObjects } from "project-editor/core/search";
import type { Project } from "project-editor/project/project";

import { CommandDef } from "cli/registry";
import { CommandContext } from "cli/context";
import { CliError } from "cli/errors";
import { selectorOf } from "cli/selectors";
import { table } from "cli/format";
import { Problem } from "cli/messages";
import { findNameConflict, namingViolation, WIDGET_PREFIXES } from "cli/naming";
import { renameObject } from "cli/commands/obj";

export function findNamingViolations(project: Project) {
    const violations: {
        object: EezObject;
        property: string;
        name: string;
        expected: string;
        kind: string;
    }[] = [];
    for (const object of visitObjects(project)) {
        if (isArray(object)) continue;
        const violation = namingViolation(object);
        if (violation) {
            violations.push({ object: object as EezObject, ...violation });
        }
    }
    return violations;
}

export function namingProblems(project: Project): Problem[] {
    return findNamingViolations(project).map(v => ({
        type: "warning",
        text: `Name "${v.name}" doesn't follow the naming convention, expected "${v.expected}" (run "naming fix")`,
        selector: selectorOf(v.object)
    }));
}

// rename every object that doesn't follow the convention (references updated)
export function fixNaming(ctx: CommandContext) {
    const renamed: { from: string; to: string; selector: string }[] = [];
    for (const violation of findNamingViolations(ctx.project)) {
        let name = violation.expected;
        for (let i = 2; findNameConflict(ctx.project, violation.object, violation.property, name); i++) {
            name = `${violation.expected}_${i}`;
        }
        renameObject(ctx, violation.object, name);
        renamed.push({ from: violation.name, to: name, selector: selectorOf(violation.object) });
    }
    return renamed;
}

const RULES = `naming convention (snake_case everywhere):
  widgets   <type>_<name>   label_title, img_person, btn_save, img_icon_home
  pages     <name>_page     home_page, settings_page
  others    <name>          user widgets, images, fonts, styles, colors, themes,
                            variables, actions, structs, enums, groups
names given to commands are corrected automatically (a note is printed);
widgets may stay unnamed.

widget prefixes:
`;

const rulesCommand: CommandDef = {
    name: "naming",
    aliases: ["naming rules"],
    summary: "Show the naming convention (widget prefixes, <name>_page ...)",
    usage: "naming | naming check | naming fix",
    project: "none",
    group: "project",
    run(ctx) {
        const prefixes = Object.entries(WIDGET_PREFIXES).sort((a, b) => a[0].localeCompare(b[0]));
        ctx.emit(
            { widgetPrefixes: Object.fromEntries(prefixes) },
            RULES + table(prefixes.map(([type, prefix]) => ["  " + type, prefix + "_<name>"]))
        );
    }
};

const checkCommand: CommandDef = {
    name: "naming check",
    summary: "List objects whose names don't follow the naming convention",
    usage: "naming check [--strict]\n  --strict  exit code 1 when there are violations",
    group: "project",
    run(ctx) {
        const violations = findNamingViolations(ctx.project);
        ctx.emit(
            violations.map(v => ({
                selector: selectorOf(v.object),
                name: v.name,
                expected: v.expected
            })),
            violations.length == 0
                ? "all names follow the naming convention"
                : table(
                      violations.map(v => [selectorOf(v.object), v.name, "->", v.expected]),
                      ["object", "name", "", "expected"]
                  ) + `\n\n${violations.length} name(s) to fix: run "naming fix"`
        );
        if (violations.length > 0 && ctx.flag("strict")) {
            throw new CliError(`${violations.length} name(s) don't follow the naming convention`);
        }
    }
};

const fixCommand: CommandDef = {
    name: "naming fix",
    summary: "Rename all objects to follow the naming convention (updates references)",
    usage: "naming fix [--dry-run]",
    mutating: true,
    group: "project",
    run(ctx) {
        const renamed = fixNaming(ctx);
        ctx.emit(
            renamed,
            renamed.length == 0
                ? "all names already follow the naming convention"
                : `${renamed.length} object(s) renamed`
        );
    }
};

export const namingCommands: CommandDef[] = [rulesCommand, checkCommand, fixCommand];
