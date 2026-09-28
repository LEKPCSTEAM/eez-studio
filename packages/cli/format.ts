export function table(rows: any[][], headers?: string[]): string {
    const all = (headers ? [headers] : []).concat(
        rows.map(row => row.map(cell => (cell == undefined ? "" : String(cell))))
    );
    if (all.length == 0 || (headers && rows.length == 0)) {
        return "(none)";
    }
    const widths: number[] = [];
    for (const row of all) {
        row.forEach((cell: string, i: number) => {
            widths[i] = Math.max(widths[i] ?? 0, cell.length);
        });
    }
    return all
        .map(row =>
            row
                .map((cell: string, i: number) =>
                    i == row.length - 1 ? cell : cell.padEnd(widths[i])
                )
                .join("  ")
                .trimEnd()
        )
        .join("\n");
}

export function indentLines(text: string, indent = "  ") {
    return text
        .split("\n")
        .map(line => indent + line)
        .join("\n");
}
