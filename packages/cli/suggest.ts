// "did you mean ...?" suggestions for mistyped names

// common spelled-out forms of abbreviations used in LVGL / EEZ names
const TOKEN_ALIASES: { [token: string]: string } = {
    offset: "ofs",
    opacity: "opa",
    background: "bg",
    image: "img",
    colour: "color",
    padding: "pad",
    horizontal: "hor",
    vertical: "ver",
    gradient: "grad",
    direction: "dir",
    transparent: "transp",
    position: "pos",
    button: "btn"
};

function normalize(name: string) {
    return name
        .toLowerCase()
        .replace(/[-\s]/g, "_")
        .split("_")
        .filter(Boolean)
        .map(token => TOKEN_ALIASES[token] ?? token)
        .join("_");
}

function levenshtein(a: string, b: string) {
    if (a == b) return 0;
    if (a.length == 0) return b.length;
    if (b.length == 0) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}

// best matching candidates, closest first
export function suggest(name: string, candidates: string[], max = 3): string[] {
    if (!name) return [];
    const target = normalize(name);
    const lower = name.toLowerCase();
    const scored: { candidate: string; score: number }[] = [];
    for (const candidate of new Set(candidates)) {
        if (!candidate) continue;
        const normalized = normalize(candidate);
        const candidateLower = candidate.toLowerCase();
        let score: number;
        if (normalized == target || candidateLower == lower) {
            score = 0;
        } else if (candidateLower.startsWith(lower) || lower.startsWith(candidateLower)) {
            score = 1;
        } else if (candidateLower.includes(lower) || normalized.includes(target)) {
            score = 2;
        } else {
            const distance = Math.min(
                levenshtein(target, normalized),
                levenshtein(lower, candidateLower)
            );
            const limit = Math.max(2, Math.floor(Math.max(target.length, normalized.length) / 3));
            if (distance > limit) continue;
            score = 2 + distance;
        }
        scored.push({ candidate, score });
    }
    return scored
        .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
        .slice(0, max)
        .map(s => s.candidate);
}

// hint text: "did you mean X?" or the list of available names
export function suggestHint(
    name: string,
    candidates: string[],
    what = "available",
    listMax = 30
): string | undefined {
    const suggestions = suggest(name, candidates);
    if (suggestions.length > 0) {
        return `did you mean ${suggestions.map(s => `"${s}"`).join(" or ")}?`;
    }
    const unique = [...new Set(candidates)].filter(Boolean);
    if (unique.length == 0) {
        return undefined;
    }
    return `${what}: ${unique.slice(0, listMax).join(", ")}${unique.length > listMax ? ", ..." : ""}`;
}
