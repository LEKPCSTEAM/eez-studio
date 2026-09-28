// Project colors (named, themeable) and themes.
// A color has one value per theme; widgets/styles reference colors by name.

import { createObject } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import { findClass } from "project-editor/core/object";
import type { Theme, Color } from "project-editor/features/style/theme";

import { CommandDef } from "cli/registry";
import { fixName } from "cli/naming";
import { CommandContext } from "cli/context";
import { CliError, UsageError } from "cli/errors";
import { table } from "cli/format";
import { deleteWithCheck, renameObject } from "cli/commands/obj";
import { suggestHint } from "cli/suggest";

function normalizeColor(value: string) {
    let v = value.trim();
    if (/^0x[0-9a-f]{6}$/i.test(v)) {
        v = "#" + v.substring(2);
    }
    if (/^[0-9a-f]{6}$/i.test(v)) {
        v = "#" + v;
    }
    if (/^#[0-9a-f]{3}$/i.test(v)) {
        v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v) && !/^rgba?\(/i.test(v)) {
        throw new UsageError(`invalid color "${value}" (use #RRGGBB)`);
    }
    return v.toUpperCase().replace(/^#/, "#");
}

function requireTheme(ctx: CommandContext, name?: string): Theme {
    const themes = ctx.project.themes;
    if (!name) {
        const theme = themes[0];
        if (!theme) {
            throw new CliError("Project has no themes", 'add one with "theme add Default"');
        }
        return theme;
    }
    const theme = themes.find(t => t.name == name);
    if (!theme) {
        throw new CliError(
            `Theme "${name}" not found`,
            suggestHint(name, themes.map(t => t.name), "themes")
        );
    }
    return theme;
}

function requireColor(ctx: CommandContext, name: string): Color {
    const color = ctx.project.colors.find(c => c.name == name);
    if (!color) {
        throw new CliError(
            `Color "${name}" not found`,
            suggestHint(name, ctx.project.colors.map(c => c.name), "colors") ?? "there are no colors"
        );
    }
    return color;
}

function themeTargets(ctx: CommandContext): Theme[] {
    const names = ctx.list("theme");
    if (names.length == 0) {
        return ctx.project.themes;
    }
    return names.map(name => requireTheme(ctx, name));
}

const colorList: CommandDef = {
    name: "color list",
    aliases: ["colors"],
    summary: "List project colors with their value in every theme",
    usage: "color list",
    group: "colors",
    run(ctx) {
        const project = ctx.project;
        const themes = project.themes;
        const data = project.colors.map(color => {
            const values: { [theme: string]: string } = {};
            for (const theme of themes) {
                values[theme.name] = project.getThemeColor(theme.objID, color.objID);
            }
            return { name: color.name, values };
        });
        ctx.emit(
            data,
            table(
                data.map(d => [d.name, ...themes.map(t => d.values[t.name])]),
                ["color", ...themes.map(t => t.name)]
            )
        );
    }
};

const colorAdd: CommandDef = {
    name: "color add",
    summary: "Add a named color (value for all themes, or per theme)",
    usage: `color add <name> <#RRGGBB> [--theme T1,T2]
  other themes get the same value unless set later with "color set"`,
    mutating: true,
    group: "colors",
    run(ctx) {
        const name = fixName("plain", "Color", ctx.arg(0, "name"));
        const value = normalizeColor(ctx.arg(1, "#RRGGBB"));
        const project = ctx.project;
        if (project.colors.find(c => c.name == name)) {
            throw new CliError(`Color "${name}" already exists`, 'use "color set" to change it');
        }
        if (project.themes.length == 0) {
            ctx.store.addObject(
                project.themes,
                createObject<Theme>(ctx.store, { name: "Default" } as any, findClass("Theme")!)
            );
        }
        const colorClass = ProjectEditor.ColorClass;
        const color = ctx.store.addObject(
            project.colors,
            createObject<Color>(ctx.store, { name } as any, colorClass)
        ) as Color;
        for (const theme of project.themes) {
            project.setThemeColor(theme.objID, color.objID, value);
        }
        ctx.markModified();
        ctx.changed(`added color ${name} = ${value}`);
        ctx.emit({ name, value });
    }
};

const colorSet: CommandDef = {
    name: "color set",
    summary: "Change a color value (all themes, or --theme T)",
    usage: "color set <name> <#RRGGBB> [--theme T1,T2]",
    mutating: true,
    group: "colors",
    run(ctx) {
        const color = requireColor(ctx, ctx.arg(0, "name"));
        const value = normalizeColor(ctx.arg(1, "#RRGGBB"));
        const themes = themeTargets(ctx);
        for (const theme of themes) {
            ctx.project.setThemeColor(theme.objID, color.objID, value);
        }
        ctx.markModified();
        ctx.changed(
            `set color ${color.name} = ${value} (${themes.map(t => t.name).join(", ")})`
        );
    }
};

const colorRm: CommandDef = {
    name: "color rm",
    summary: "Remove a color (refused if used, unless --force)",
    usage: "color rm <name> [--force]",
    mutating: true,
    group: "colors",
    run(ctx) {
        const color = requireColor(ctx, ctx.arg(0, "name"));
        deleteWithCheck(ctx, color, `color ${color.name}`);
    }
};

const colorRename: CommandDef = {
    name: "color rename",
    summary: "Rename a color and update all references",
    usage: "color rename <name> <new-name>",
    mutating: true,
    group: "colors",
    run(ctx) {
        const color = requireColor(ctx, ctx.arg(0, "name"));
        renameObject(ctx, color, ctx.arg(1, "new-name"));
    }
};

const themeList: CommandDef = {
    name: "theme list",
    aliases: ["themes"],
    summary: "List themes",
    usage: "theme list",
    group: "colors",
    run(ctx) {
        const themes = ctx.project.themes.map(t => t.name);
        ctx.emit(themes, themes.join("\n") || "(none)");
    }
};

const themeAdd: CommandDef = {
    name: "theme add",
    summary: "Add a theme (colors copied from an existing theme)",
    usage: "theme add <name> [--from <theme>]",
    mutating: true,
    group: "colors",
    run(ctx) {
        const name = fixName("plain", "Theme", ctx.arg(0, "name"));
        const project = ctx.project;
        if (project.themes.find(t => t.name == name)) {
            throw new CliError(`Theme "${name}" already exists`);
        }
        const from = project.themes.length > 0 ? requireTheme(ctx, ctx.str("from")) : undefined;
        const themeClass = findClass("Theme")!;
        const theme = ctx.store.addObject(
            project.themes,
            createObject<Theme>(ctx.store, { name } as any, themeClass)
        ) as Theme;
        for (const color of project.colors) {
            project.setThemeColor(
                theme.objID,
                color.objID,
                from ? project.getThemeColor(from.objID, color.objID) : "#000000"
            );
        }
        ctx.markModified();
        ctx.changed(`added theme ${name}${from ? ` (from ${from.name})` : ""}`);
    }
};

const themeRm: CommandDef = {
    name: "theme rm",
    summary: "Remove a theme",
    usage: "theme rm <name>",
    mutating: true,
    group: "colors",
    run(ctx) {
        const theme = requireTheme(ctx, ctx.arg(0, "name"));
        if (ctx.project.themes.length == 1) {
            throw new CliError("Can't remove the last theme");
        }
        ctx.store.deleteObject(theme);
        ctx.changed(`removed theme ${theme.name}`);
    }
};

export const themeCommands: CommandDef[] = [
    colorList,
    colorAdd,
    colorSet,
    colorRm,
    colorRename,
    themeList,
    themeAdd,
    themeRm
];
