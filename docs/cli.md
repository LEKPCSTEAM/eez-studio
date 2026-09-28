# EEZ Studio command line interface (CLI) and MCP server

EEZ Studio can be driven from the command line: create and edit every part of a
project, check it, build it and render pages to PNG images, without opening the
GUI. It is designed for scripting and for AI agents (Claude Code, other MCP
clients), which can design a UI, look at the rendered result and iterate.

The CLI is part of the application. It runs the same project model, checks,
build and LVGL renderer as the GUI, inside a hidden window. Projects edited with
the CLI are exactly what the GUI would produce.

## Running

From a source checkout (after `npm run build-src` or `npm run watch`):

```bash
node packages/cli/launcher/eez-cli.js help
npm run cli -- help
```

An installed EEZ Studio ships the launcher in its `resources/cli` folder
(Node.js is needed to run it). It finds the executable next to it:

| OS | launcher |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\eezstudio\resources\cli\eez-cli.js` |
| macOS | `/Applications/EEZ Studio.app/Contents/Resources/cli/eez-cli.js` |
| Linux | `<install folder>/resources/cli/eez-cli.js` |

```bash
node "%LOCALAPPDATA%/Programs/eezstudio/resources/cli/eez-cli.js" help
```

A copy of the launcher anywhere else finds a default installation too, or can be
pointed at the executable:

```bash
EEZ_STUDIO="C:/Users/me/AppData/Local/Programs/eezstudio/EEZ Studio.exe" node eez-cli.js help
node eez-cli.js --studio "/Applications/EEZ Studio.app/Contents/MacOS/EEZ Studio" help
```

The launcher starts `EEZ Studio --cli`, relays stdin/stdout, removes Chromium
log noise from stderr and returns the command's exit code. (Starting the
executable with `--cli` directly also works when stdout is piped.) A running
EEZ Studio GUI doesn't slow the CLI down: CLI processes use their own temporary
Chromium session folder.

### Daemon: fast repeated commands

Every command starts the application (about 1-2 seconds, more on slow disks).
For many single commands, start the daemon once; following commands are sent
to it and take milliseconds:

```bash
eez-cli daemon start [--idle 30]    # stops by itself after 30 idle minutes
eez-cli -p ui.eez-project page tree main_page    # -> handled by the daemon
eez-cli daemon status | stop
```

With `EEZ_CLI_DAEMON=auto` the launcher starts the daemon on first use;
`EEZ_CLI_DAEMON=off` bypasses a running daemon. `repl`, `mcp` and commands
reading stdin (`apply -`) always run in their own process. The daemon only
accepts connections from localhost that present the token stored in
`<tmp>/eez-cli-daemon.json`.

Every command takes these global options:

| option | |
|---|---|
| `-p <file>` | project file (optional when the current folder has exactly one `.eez-project`) |
| `--json` | print the result as JSON: `{ok, command, project, changes, saved, result, newProblems, error}` |
| `--dry-run` | run the command but don't save |
| `--force` | skip safety checks (remove referenced objects, unknown enum values ...) |
| `--strict` | refuse changes that introduce check errors |
| `--no-backup` | don't write `<file>.bak` |
| `--no-reload-gui` | don't ask a running EEZ Studio to reload the project |

Exit codes: `0` success, `1` error, `2` usage error.

Each changing command is saved immediately, after the previous file content is
copied to `<file>.bak`. When EEZ Studio is running with the same project open,
it reloads the project after each save.

## Commands

`eez-cli help` lists all commands; `eez-cli help <command>` shows the options;
`eez-cli help selectors|values|workflow` explains the concepts.

| group | commands |
|---|---|
| project | `project new`, `project types`, `info`, `project settings`, `project set`, `project features`, `project feature add`, `check`, `build`, `reload-gui` |
| pages | `page list/tree/add/rm/rename/set`, `user-widget list/add` |
| widgets | `widget types/add/set/get/rm/move`, `widget event add/rm/list`, `widget style show/set/unset/clear` |
| LVGL styles | `lvgl-style list/show/add/set/unset/rm/rename/apply/unapply/default/props/parts` |
| colors | `color list/add/set/rm/rename`, `theme list/add/rm` |
| assets | `font list/add/rm/rename`, `image list/add/add-dir/rm/rename` |
| flow | `var list/add/set/rm/rename`, `action list/add/rm/rename`, `flow components/list/add/connect/disconnect/rm/set` |
| render | `render page`, `render all` |
| generic | `obj get/list/find/props/set/add/rm/rename/move/dup`, `schema classes/class/project/enum` |
| batch | `apply <file|->`, `repl`, `mcp` |

The generic `obj` and `schema` commands work with any object of any project
type through the model's reflection (class and property metadata). They cover
everything that has no dedicated command (LVGL groups, texts/languages, SCPI,
build configurations, extension definitions ...).

### Naming convention

The CLI enforces one naming convention (all snake_case):

| object | name | examples |
|---|---|---|
| widget | `<type>_<name>` | `label_title`, `img_person`, `img_icon_home`, `btn_save` |
| page | `<name>_page` | `main_page`, `settings_page` |
| user widgets, images, fonts, styles, colors, themes, variables, actions, structs, enums, groups | `<name>` | `icon_home`, `roboto_20`, `card` |

`eez-cli naming` prints the widget type prefixes. Names given to commands
that don't follow the convention are corrected automatically, and the command
prints `note: name "title" -> "label_title"` (JSON: `notes`). Widget names must
be unique in the project. New projects follow the convention (the template page
becomes `main_page`). `check` warns about existing violations, `naming fix`
renames them and updates all references, and `naming check --strict` fails
while any are left. Selectors and references still find objects written
without the convention (`page:Main/title` resolves to `page:main_page/label_title`).

### Selectors

```
project                         settings/general, settings/build
page:main_page                  page (also userWidget:, action:, var:, struct:, enum:, style:,
                                lvglStyle:, font:, bitmap:, color:, theme:, group:, config:, ...)
page:main_page/btn_ok           widget by identifier / name (depth first)
page:main_page/panel_card/[0]   child by index
page:main_page/$screen          the LVGL screen widget of a page
main_page/btn_ok                "page:" can be omitted for pages and user widgets
@<objID>                        any object by objID
/userPages/0/components/1       object path from the project root
<selector>#eventHandlers/0      walk into object and array properties
```

### Example

```bash
EEZ="node packages/cli/launcher/eez-cli.js"
$EEZ project new ui/demo.eez-project --type lvgl --lvgl 9.2.2 --size 480x272
cd ui
$EEZ lvgl-style add card --for Panel bg_color=#FFFFFF radius=12 shadow_width=20 shadow_opa=60
$EEZ widget add Panel --page main_page --name panel_card --at 20,20 --size 280,120 --style card
$EEZ widget add Label --parent main_page/panel_card --name label_title --at 0,0 text="Temperature"
$EEZ widget style set page:main_page/label_title text_font=MONTSERRAT_20
$EEZ render page main_page --bounds     # -> .eez-render/main_page.bounds.png + layout issues
$EEZ check && $EEZ build
```

Many operations can be applied as one transaction (checked and saved once;
nothing is saved if one fails):

```bash
$EEZ apply changes.txt        # one command per line
$EEZ apply changes.json       # ["cmd ...", ["argv", ...], {"cmd": "...", "args": [], "opts": {}}]
$EEZ apply --ops '["page add A", "page add B"]'
```

`repl` keeps the project loaded and executes one command per stdin line
(`--json` prints one JSON result per line), which is much faster for long scripts.

## Rendering

`render page <page>` renders a page to PNG:

- LVGL projects are rendered with the LVGL WebAssembly runtime of the selected
  LVGL version, exactly like the page editor.
- EEZ-GUI and Dashboard projects are rendered with the editor's page renderer
  and captured from the hidden window.

Options: `-o <file>` (default `<project folder>/.eez-render/<page>.png`),
`--scale 1..8`, `--bounds` (draw widget boxes and names), `--layout` (print the
computed position and size of every widget), `--theme <name>`, `--dark`.
The command always reports layout issues: partially overlapping siblings,
widgets outside the screen, children overflowing their parent, zero sized
widgets. A widget completely inside a sibling (a value label in the middle of
an arc, an icon on a panel) is not an issue; `--layout` notes it as
`(on <sibling>)`. `--allow-overlap a,b` silences overlaps of named widgets.

Rendering shows the editor view. Expressions are not evaluated, and there is no
runtime or simulator.

## MCP server

`eez-cli mcp [-p project]` runs a Model Context Protocol server over stdio.
Register it with Claude Code:

```bash
# source checkout
claude mcp add eez-studio -- node /path/to/eez-studio/packages/cli/launcher/eez-cli.js mcp
# installed EEZ Studio (Windows)
claude mcp add eez-studio -- node "C:/Users/<user>/AppData/Local/Programs/eezstudio/resources/cli/eez-cli.js" mcp
```

or with a `.mcp.json` in the project folder:

```json
{
    "mcpServers": {
        "eez-studio": {
            "command": "node",
            "args": ["/path/to/eez-studio/packages/cli/launcher/eez-cli.js", "mcp"]
        }
    }
}
```

The project is loaded once and stays in memory, so tool calls take
milliseconds. The tools are:

- **discovery**: `eez_help`, `eez_schema`, `eez_info`, `eez_tree`, `eez_get`
- **editing**: `eez_new_project`, `eez_open`, `eez_add_widget`, `eez_set`, `eez_style`, `eez_remove`, `eez_apply`
- **results**: `eez_check`, `eez_build`, `eez_render` (returns the PNG as image content)
- **anything else**: `eez_run`, which accepts any CLI command line

Tool results are kept short to save the model's context: read-only commands
(help, schema, tree, lists) return their text output, changing commands return
compact JSON (`ok`, `changes` — long lists are summarized, `saved`,
`newProblems`, `result`). `eez_apply` returns the number of operations and the
selectors of created objects.

## Agent skill

`packages/cli/skill/SKILL.md` describes the workflow for AI agents. For Claude
Code, copy it to `.claude/skills/eez-studio/SKILL.md` in the repository where
the `.eez-project` lives.

## Tests

```bash
npm run build-src      # or: npm run watch
npm run test:cli       # end-to-end tests in packages/cli/test
```

## Implementation notes

| file | |
|---|---|
| `packages/main/cli-main.ts` | main process: `--cli` mode, hidden window, stdio relay, exit code |
| `packages/home/main.tsx` | loads `cli/cli-entry` when the window is opened with `?cli=1` |
| `packages/cli/runner.ts` | parses a command line and runs it against the session: check before and after, save, reload the GUI |
| `packages/cli/session.ts` | `ProjectStore` in `project-editor` context (no UI mounted), atomic save |
| `packages/cli/selectors.ts`, `reflect.ts` | selectors; schema, value conversion and object creation from class metadata |
| `packages/cli/commands/*` | commands |
| `packages/cli/render/*` | offscreen LVGL renderer and DOM capture |
| `packages/cli/mcp/server.ts` | MCP server |
| `packages/cli/templates/*` | the New Project wizard templates (from [eez-project-templates](https://github.com/eez-open/eez-project-templates)) for offline `project new` |
