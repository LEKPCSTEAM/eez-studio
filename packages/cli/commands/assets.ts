// Fonts and bitmaps (images)

import fs from "fs";
import path from "path";

import { createObject } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { Font } from "project-editor/features/font/font";
import { getLvglEncodingsAndSymbols, getEncodings } from "project-editor/features/font/font";
import { extractFont } from "project-editor/features/font/font-extract";
import { createBitmap } from "project-editor/features/bitmap/bitmap";
import type { Bitmap } from "project-editor/features/bitmap/bitmap";
import { getLvglDefaultFontBpp } from "project-editor/lvgl/lvgl-versions";

import { CommandDef } from "cli/registry";
import { fixName } from "cli/naming";
import { CommandContext } from "cli/context";
import { CliError, UsageError } from "cli/errors";
import { selectorOf } from "cli/selectors";
import { setProperties } from "cli/reflect";
import { table } from "cli/format";
import { deleteWithCheck, renameObject } from "cli/commands/obj";
import { ensureFeature } from "cli/commands/project";
import { suggestHint } from "cli/suggest";

// copy an asset file into the project folder (unless it is already inside)
function assetFilePath(ctx: CommandContext, file: string, folder: string) {
    const absolute = path.resolve(ctx.cwd, file);
    if (!fs.existsSync(absolute)) {
        throw new CliError(`File not found: ${absolute}`);
    }
    const projectDir = path.dirname(ctx.session.filePath!);
    if (ctx.flag("no-copy") || !path.relative(projectDir, absolute).startsWith("..")) {
        return absolute;
    }
    const destination = path.join(projectDir, folder, path.basename(absolute));
    if (!ctx.flag("dry-run")) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!fs.existsSync(destination)) {
            fs.copyFileSync(absolute, destination);
            ctx.files.push(destination);
        }
    }
    return fs.existsSync(destination) ? destination : absolute;
}

function assetName(file: string, prefix = "") {
    return (
        prefix +
        path
            .parse(file)
            .name.replace(/[^\w]+/g, "_")
            .replace(/^(\d)/, "_$1")
    );
}

////////////////////////////////////////////////////////////////////////////////

function requireFont(ctx: CommandContext, name: string): Font {
    const font = (ctx.project.fonts ?? []).find(f => f.name == name);
    if (!font) {
        throw new CliError(
            `Font "${name}" not found`,
            suggestHint(name, (ctx.project.fonts ?? []).map(f => f.name), "fonts") ?? "there are no fonts"
        );
    }
    return font;
}

const fontList: CommandDef = {
    name: "font list",
    aliases: ["fonts"],
    summary: "List fonts",
    usage: "font list",
    group: "assets",
    run(ctx) {
        const fonts = ctx.project.fonts ?? [];
        const rows = fonts.map((f: any) => ({
            selector: selectorOf(f),
            name: f.name,
            file: f.source?.filePath,
            size: f.source?.size,
            bpp: f.bpp,
            ranges: f.lvglRanges,
            symbols: f.lvglSymbols,
            glyphs: f.glyphs?.length
        }));
        ctx.emit(
            rows,
            table(
                rows.map(r => [r.name, r.file ?? "", r.size ?? "", r.bpp ?? "", r.ranges ?? "", r.glyphs ?? ""]),
                ["font", "file", "size", "bpp", "ranges", "glyphs"]
            ) +
                (ctx.store.projectTypeTraits.isLVGL
                    ? "\n\nbuilt-in LVGL fonts can be used directly in styles: MONTSERRAT_8 ... MONTSERRAT_48"
                    : "")
        );
    }
};

const fontAdd: CommandDef = {
    name: "font add",
    summary: "Add a font from a TTF/OTF file (one font per size)",
    usage: `font add <file.ttf> [--name N] [--size 16[,20,24]] [--bpp 1|2|4|8]
         [--ranges 32-127,0x0E00-0x0E7F] [--symbols "°±"] [--no-copy]
  LVGL: --ranges/--symbols select the glyphs (default 32-127)
  names default to <file>_<size> when more than one size is given
  the file is copied to <project>/fonts/ unless --no-copy or already in the project folder`,
    booleans: ["no-copy"],
    mutating: true,
    group: "assets",
    async run(ctx) {
        const file = ctx.arg(0, "file.ttf");
        const store = ctx.store;
        const project = ctx.project;
        const isLVGL = store.projectTypeTraits.isLVGL;
        ensureFeature(ctx, "fonts");

        const absoluteFilePath = assetFilePath(ctx, file, "fonts");
        const relativeFilePath = store.getFilePathRelativeToProjectPath(absoluteFilePath);

        const sizes = ctx.list("size").map(s => Number(s));
        if (sizes.length == 0) sizes.push(14);
        if (sizes.some(s => !Number.isFinite(s) || s <= 0)) {
            throw new UsageError("--size expects positive numbers");
        }

        const baseName = ctx.str("name");
        const bpp = ctx.num("bpp") ?? (isLVGL ? getLvglDefaultFontBpp(project) : 8);
        const ranges = ctx.str("ranges", "32-127")!;
        const symbols = ctx.str("symbols", "")!;
        if (!getEncodings(ranges)) {
            throw new UsageError(
                `invalid --ranges "${ranges}"`,
                "use comma separated ranges, e.g. 32-127,0x0E00-0x0E7F"
            );
        }

        const added: string[] = [];
        for (const size of sizes) {
            const name = fixName(
                "plain",
                "Font",
                baseName && sizes.length == 1
                    ? baseName
                    : `${baseName ?? assetName(file)}_${size}`
            );
            if ((project.fonts ?? []).find(f => f.name == name)) {
                throw new CliError(`Font "${name}" already exists`);
            }

            let fontProperties: any;
            try {
                if (isLVGL) {
                    const { encodings, symbols: lvglSymbols } =
                        getLvglEncodingsAndSymbols(ranges, symbols);
                    fontProperties = await extractFont({
                        name,
                        absoluteFilePath,
                        relativeFilePath,
                        renderingEngine: "LVGL",
                        bpp,
                        size,
                        threshold: 128,
                        createGlyphs: true,
                        encodings,
                        symbols: lvglSymbols,
                        createBlankGlyphs: false,
                        doNotAddGlyphIfNotFound: false,
                        lvglVersion: project.settings.general.lvglVersion,
                        lvglInclude: project.settings.build.lvglInclude,
                        getAllGlyphs: true
                    });
                    fontProperties.lvglRanges = ranges;
                    fontProperties.lvglSymbols = symbols;
                } else {
                    const [from, to] = ranges.split("-").map(s => Number(s.trim()));
                    fontProperties = await extractFont({
                        name,
                        absoluteFilePath,
                        relativeFilePath,
                        renderingEngine: "opentype",
                        bpp,
                        size,
                        threshold: 128,
                        createGlyphs: true,
                        encodings: [{ from: from || 32, to: to || 127 }],
                        createBlankGlyphs: false,
                        doNotAddGlyphIfNotFound: false
                    });
                }
            } catch (err: any) {
                throw new CliError(`Failed to import font: ${err?.message ?? err}`);
            }

            const font = createObject<Font>(store, fontProperties, ProjectEditor.FontClass);
            store.addObject(project.fonts, font);
            added.push(name);
            ctx.changed(`added font ${name} (${path.basename(absoluteFilePath)} ${size}px)`);
        }

        ctx.emit({ fonts: added }, added.join("\n"));
    }
};

const fontRm: CommandDef = {
    name: "font rm",
    summary: "Remove a font (refused if used, unless --force)",
    usage: "font rm <name> [--force]",
    mutating: true,
    group: "assets",
    run(ctx) {
        const font = requireFont(ctx, ctx.arg(0, "name"));
        deleteWithCheck(ctx, font, `font ${font.name}`);
    }
};

const fontRename: CommandDef = {
    name: "font rename",
    summary: "Rename a font and update references",
    usage: "font rename <name> <new-name>",
    mutating: true,
    group: "assets",
    run(ctx) {
        renameObject(ctx, requireFont(ctx, ctx.arg(0, "name")), ctx.arg(1, "new-name"));
    }
};

////////////////////////////////////////////////////////////////////////////////

function requireBitmap(ctx: CommandContext, name: string): Bitmap {
    const bitmap = (ctx.project.bitmaps ?? []).find(b => b.name == name);
    if (!bitmap) {
        throw new CliError(
            `Image "${name}" not found`,
            suggestHint(name, (ctx.project.bitmaps ?? []).map(b => b.name), "images") ?? "there are no images"
        );
    }
    return bitmap;
}

async function addImage(ctx: CommandContext, file: string, name: string | undefined) {
    const store = ctx.store;
    ensureFeature(ctx, "bitmaps");
    const absolute = assetFilePath(ctx, file, "images");
    const bitmapName = fixName(
        "plain",
        "Bitmap",
        name ?? assetName(file, ctx.str("prefix") ?? "")
    );
    if ((ctx.project.bitmaps ?? []).find(b => b.name == bitmapName)) {
        throw new CliError(`Image "${bitmapName}" already exists`);
    }
    const bitmap = await createBitmap(store, absolute, undefined, bitmapName);
    if (!bitmap) {
        throw new CliError(`Failed to load image ${absolute}`);
    }
    const added = store.addObject(ctx.project.bitmaps, bitmap) as Bitmap;
    const format = ctx.str("format");
    if (format) {
        setProperties(store, added, { bpp: format }, { force: ctx.force });
    }
    ctx.changed(`added image ${bitmapName} (${path.basename(absolute)})`);
    return bitmapName;
}

const imageList: CommandDef = {
    name: "image list",
    aliases: ["images", "bitmap list"],
    summary: "List images (bitmaps)",
    usage: "image list",
    group: "assets",
    run(ctx) {
        const bitmaps = ctx.project.bitmaps ?? [];
        const rows = bitmaps.map((b: any) => ({
            selector: selectorOf(b),
            name: b.name,
            format: b.bpp,
            embedded: typeof b.image == "string" && b.image.startsWith("data:"),
            file: typeof b.image == "string" && !b.image.startsWith("data:") ? b.image : undefined,
            size: b.imageElement ? `${b.imageElement.width}x${b.imageElement.height}` : undefined
        }));
        ctx.emit(
            rows,
            table(
                rows.map(r => [r.name, r.format, r.embedded ? "embedded" : r.file ?? "", r.size ?? ""]),
                ["image", "format", "source", "size"]
            )
        );
    }
};

const imageAdd: CommandDef = {
    name: "image add",
    aliases: ["bitmap add"],
    summary: "Add an image (PNG/JPG) to the project",
    usage: `image add <file.png> [--name N] [--format <color format>] [--no-copy]
  LVGL color formats: see "obj props bitmap:<name>" after adding`,
    booleans: ["no-copy"],
    mutating: true,
    group: "assets",
    async run(ctx) {
        const name = await addImage(ctx, ctx.arg(0, "file"), ctx.str("name"));
        ctx.emit({ name, selector: `bitmap:${name}` }, `bitmap:${name}`);
    }
};

const imageAddDir: CommandDef = {
    name: "image add-dir",
    summary: "Add all images of a folder",
    usage: "image add-dir <folder> [--prefix img_] [--format F] [--no-copy]",
    booleans: ["no-copy"],
    mutating: true,
    group: "assets",
    async run(ctx) {
        const dir = path.resolve(ctx.cwd, ctx.arg(0, "folder"));
        if (!fs.existsSync(dir)) {
            throw new CliError(`Folder not found: ${dir}`);
        }
        const files = fs
            .readdirSync(dir)
            .filter(f => /\.(png|jpe?g|bmp|gif)$/i.test(f))
            .sort();
        const names: string[] = [];
        for (const file of files) {
            names.push(await addImage(ctx, path.join(dir, file), undefined));
        }
        ctx.emit({ images: names }, names.join("\n") || "(no images found)");
    }
};

const imageRm: CommandDef = {
    name: "image rm",
    aliases: ["bitmap rm"],
    summary: "Remove an image (refused if used, unless --force)",
    usage: "image rm <name> [--force]",
    mutating: true,
    group: "assets",
    run(ctx) {
        const bitmap = requireBitmap(ctx, ctx.arg(0, "name"));
        deleteWithCheck(ctx, bitmap, `image ${bitmap.name}`);
    }
};

const imageRename: CommandDef = {
    name: "image rename",
    aliases: ["bitmap rename"],
    summary: "Rename an image and update references",
    usage: "image rename <name> <new-name>",
    mutating: true,
    group: "assets",
    run(ctx) {
        renameObject(ctx, requireBitmap(ctx, ctx.arg(0, "name")), ctx.arg(1, "new-name"));
    }
};

export const assetCommands: CommandDef[] = [
    fontList,
    fontAdd,
    fontRm,
    fontRename,
    imageList,
    imageAdd,
    imageAddDir,
    imageRm,
    imageRename
];
