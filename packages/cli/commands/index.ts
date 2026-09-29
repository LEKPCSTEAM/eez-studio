import { registerCommands } from "cli/registry";

import { coreCommands } from "cli/commands/core";
import { objCommands } from "cli/commands/obj";
import { schemaCommands } from "cli/commands/schema";
import { renderCommands } from "cli/commands/render";
import { pageCommands } from "cli/commands/page";
import { widgetCommands } from "cli/commands/widget";
import { lvglStyleCommands } from "cli/commands/lvgl-style";
import { projectCommands } from "cli/commands/project";
import { themeCommands } from "cli/commands/theme";
import { namingCommands } from "cli/commands/naming";
import { assetCommands } from "cli/commands/assets";
import { flowCommands } from "cli/commands/flow";
import { applyCommands } from "cli/commands/apply";

let registered = false;

export function registerAllCommands() {
    if (registered) {
        return;
    }
    registered = true;

    registerCommands(coreCommands);
    registerCommands(applyCommands);
    registerCommands(projectCommands);
    registerCommands(objCommands);
    registerCommands(schemaCommands);
    registerCommands(pageCommands);
    registerCommands(widgetCommands);
    registerCommands(lvglStyleCommands);
    registerCommands(themeCommands);
    registerCommands(namingCommands);
    registerCommands(assetCommands);
    registerCommands(flowCommands);
    registerCommands(renderCommands);
}
