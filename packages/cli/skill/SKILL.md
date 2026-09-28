---
name: eez-studio
description: Design and edit EEZ Studio projects (.eez-project: LVGL, EEZ-GUI firmware, Dashboard) through the built-in EEZ Studio CLI / MCP server - create projects, pages, widgets, styles, colors, fonts, images, variables, actions and flows, render pages to PNG to see the result, check and build. Use whenever a task touches a .eez-project file or EEZ Studio UI design.
---

# EEZ Studio CLI

EEZ Studio has a built-in command line interface that runs the real project
model of the app (same classes, same checks, same LVGL renderer as the GUI) in a
hidden window. Use it for every change to a `.eez-project` file.

**Never edit `.eez-project` JSON by hand.** The file's invariants (objIDs,
references by name, LVGL version specific properties, flow wiring) are only
enforced by the app's model. The CLI keeps them valid.

```bash
EEZ="node <eez-studio>/packages/cli/launcher/eez-cli.js"   # source checkout
# installed app: EEZ="node <install folder>/resources/cli/eez-cli.js"
#   Windows: %LOCALAPPDATA%/Programs/eezstudio/resources/cli/eez-cli.js
$EEZ help                    # all commands
$EEZ help widget add         # one command
$EEZ help selectors          # how to address objects
```

**Speed**: every single command starts the app (1-2 s or more). Run
`$EEZ daemon start` first when you will issue many single commands (they then
take milliseconds), and group related changes into one `apply`. `repl` and the
MCP server keep the project loaded too.

If the MCP server is configured (`eez-cli mcp`), the same operations are
available as `eez_*` tools; `eez_render` returns the page image directly and
`eez_run` accepts any CLI command line.

## Design loop

1. `project new ui.eez-project --type lvgl --lvgl 9.2.2 --size 480x272`
   (types: `lvgl`, `lvgl-flow`, `firmware`, `dashboard`, `eez-gui-lite`) or open an
   existing one with `-p existing.eez-project info`. New projects come from the GUI's
   New Project wizard templates (build files included); read the page names from the
   output (the firmware template's page is `main`).
2. Discover before guessing: `widget types`, `schema class Button`,
   `lvgl-style props --search color`, `lvgl-style parts Slider`, `flow components`.
3. Build the UI: `widget add`, `widget style set`, `lvgl-style add/apply`, `color add`, `font add`.
4. **Look at it**: `render page main_page --bounds` then open the PNG
   (default `<project folder>/.eez-render/<page>.png`). Read the reported layout
   issues (`overlaps`, `outside-screen`, `overflows-parent`, `zero-size`);
   `--layout` prints every widget's computed position and size. A widget
   completely inside a sibling (label centered on an arc) is not an overlap
   issue; use `--allow-overlap a,b` for intended partial overlaps.
5. Fix, render again. Finish with `check` (0 errors) and `build`.

Batch many changes with `apply` (one transaction, one save):

```bash
$EEZ -p ui.eez-project apply - <<'OPS'
page add settings_page
widget add Label --page settings_page --name label_title --at 16,12 text="Settings"
widget style set page:settings_page/label_title text_font=MONTSERRAT_24 text_color=#1A237E
OPS
```

Global options: `-p <project>` (optional if the folder has exactly one project),
`--json` (machine readable result), `--dry-run`, `--force`, `--strict`,
`--no-backup`, `--no-reload-gui`. Exit code 0 = ok, 1 = error, 2 = usage error.

Every change is saved immediately (a `.bak` is kept) and a running EEZ Studio GUI
is asked to reload the project. If a change introduces check errors it is still
saved (intermediate states are normal) and the errors are reported as
`note: this change introduced N problem(s)` / `newProblems` in JSON — fix them.
Use `--strict` to refuse such changes instead.

## Naming convention (enforced)

All names are snake_case:

| object | name | examples |
|---|---|---|
| widget | `<type>_<name>` | `label_title`, `img_person`, `img_icon_home`, `btn_save`, `panel_card` |
| page | `<name>_page` | `main_page`, `settings_page` |
| everything else (user widgets, images, fonts, styles, colors, themes, variables, actions, groups) | `<name>` | `icon_home`, `roboto_20`, `card`, `primary`, `counter`, `on_save` |

Widget prefixes: `label`, `img`, `btn`, `panel`, `cont`, `slider`, `switch`, `arc`,
`bar`, `checkbox`, `dropdown`, `roller`, `textarea`, `keyboard`, `chart`, `table`,
`tabview`, `tab`, `list`, `spinner`, `led`, `line`, `meter`, `scale`, `msgbox`,
`imgbtn`, `win`, `uw` ... (full table: `$EEZ naming`).

- Give names in the convention. Names that don't follow it are corrected
  automatically and reported as `note: name "title" -> "label_title"` (JSON:
  `notes`) — use the corrected name (or the selector printed) afterwards.
- Widget names are unique in the whole project; a duplicate is refused.
- New projects already follow it (the template page is `main_page`).
- `check` warns about names that don't follow it; `naming fix` renames them all
  and updates the references; `naming check --strict` fails if any remain.
- Unconventional names still resolve in selectors and references
  (`page:Main/title` finds `page:main_page/label_title`), but write the real names.

## Selectors

| selector | object |
|---|---|
| `page:main_page`, `main_page` | page (also `userWidget:`, `action:`) |
| `page:main_page/btn_ok` | widget by identifier (depth first) |
| `page:main_page/panel_card/[0]` | child by index |
| `page:main_page/$screen` | LVGL screen widget of a page |
| `lvglStyle:card`, `style:X`, `font:X`, `bitmap:X`, `color:X`, `theme:X`, `var:X`, `group:X` | named objects |
| `settings/general`, `settings/build` | project settings |
| `@<objID>`, `/userPages/0/components/0` | exact object |
| `<selector>#eventHandlers/0` | walk into properties |

`page tree main_page` prints every widget with its selector. Commands print the
selector of objects they create — use it for the next command.

## Values

`key=value` pairs are converted to the property type and validated: numbers,
booleans, enums (the error lists the allowed values), references (font, style,
image, variable names must exist). Use `--values '{"k": ...}'` for typed JSON
(arrays/objects, e.g. SetVariable entries). Quote values with spaces:
`text="Hello world"`.

## LVGL specifics

- Geometry: `--at x,y` and `--size w,h`; each value is px, `50%` or `content`.
- Flags/states: `--flag +HIDDEN,-SCROLLABLE`, `--state +CHECKED,+DISABLED`.
- Styles: shared styles are per widget type — `lvgl-style add card --for Panel bg_color=#FFFFFF radius=12`,
  then `lvgl-style apply page:main_page/panel_card card`. Local overrides:
  `widget style set <widget> [--part INDICATOR] [--state PRESSED] prop=value`.
  Shorthands: `pad_all`, `pad_hor`, `pad_ver`.
- Built-in fonts: `MONTSERRAT_8 ... MONTSERRAT_48` (depending on LVGL build);
  own fonts: `font add file.ttf --size 16,24 --ranges 32-127,0x0E00-0x0E7F` (Thai example), then
  `text_font=<font name>`.
- Colors: `color add primary #3949AB` and use the name (`text_color=primary`) so
  themes (`theme add dark --from default`, `color set primary #... --theme dark`) work.
- A Button created by `widget add Button` already contains a Label child
  (`page:main_page/btn_ok/[0]`) — set its `text`, don't add a second label.
  Icon buttons: `widget add Button --icon <bitmap>` (Label replaced by a centered
  Image); `--no-label` for a button without children.
- Errors for mistyped names suggest the right one (`did you mean "shadow_ofs_y"?`)
  — use the suggestion instead of searching.
- `widget set <w> --at ,58` / `--size 100,` changes one coordinate and keeps the other.
- Label text / slider value etc. are literals by default; to bind to a variable
  set `textType=expression text=myVar` (flow projects).
- `rm`/`rename` of colors, fonts, images, styles, variables and pages check and
  update the references (also inside LVGL style definitions).

## Variables, actions, flow

```bash
$EEZ var add counter --type integer --default 0
$EEZ action add on_save                  # flow action (or --native)
$EEZ widget event add page:main_page/btn_inc --event CLICKED --flow
$EEZ flow add main_page SetVariable --values '{"entries":[{"variable":"counter","value":"counter + 1"}]}'
$EEZ flow list main_page                      # components with [index], inputs, outputs
$EEZ flow connect main_page btn_inc [1] --output CLICKED
$EEZ widget event add page:main_page/btn_save --event CLICKED --action on_save
```

## Anything else

Every object of every project type is reachable with the generic commands:
`obj get|list|find|props|set|add|rm|rename|move|dup`, `schema class|classes|project|enum`.
Examples: `obj add /lvglGroups/groups name=keys`, `obj set settings/build destinationFolder=src/ui`,
`project feature add texts` (multi-language), `obj add /texts/languages languageID=de`.

## Pitfalls

- Keep the GUI from overwriting your changes: the CLI asks a running EEZ Studio
  to reload the file after each save; unsaved GUI edits prompt the user.
- Renders show the editor view (like the page editor canvas), not a running app:
  expressions are not evaluated.
- EEZ-GUI (firmware) widgets have no names; address them by `page:main_page/[i]`.
- Check `check` output before `build`; build errors mean invalid generated code.
