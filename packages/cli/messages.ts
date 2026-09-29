import { IMessage, MessageType } from "project-editor/core/object";
import { getHumanReadableObjectPath } from "project-editor/store/helper";

import { selectorOf, objectPath } from "cli/selectors";

export interface Problem {
    type: "error" | "warning" | "info";
    text: string;
    where?: string;
    selector?: string;
    path?: string;
}

function typeName(type: MessageType): Problem["type"] {
    if (type == MessageType.ERROR) return "error";
    if (type == MessageType.WARNING) return "warning";
    return "info";
}

export function flattenMessages(messages: IMessage[]): Problem[] {
    const result: Problem[] = [];

    function visit(list: IMessage[]) {
        for (const message of list) {
            if (message.type == MessageType.GROUP) {
                if (message.messages) {
                    visit(message.messages);
                }
                continue;
            }

            const problem: Problem = {
                type: typeName(message.type),
                text: message.text
            };

            if (message.object) {
                try {
                    problem.where = getHumanReadableObjectPath(message.object);
                } catch (err) {}
                try {
                    problem.selector = selectorOf(message.object);
                    problem.path = objectPath(message.object);
                } catch (err) {}
            }

            result.push(problem);

            if (message.messages) {
                visit(message.messages);
            }
        }
    }

    visit(messages);

    return result;
}

export function problemKey(problem: Problem) {
    return `${problem.type}|${problem.path ?? ""}|${problem.text}`;
}

export function newProblems(before: Problem[], after: Problem[]) {
    const seen = new Set(before.map(problemKey));
    return after.filter(problem => !seen.has(problemKey(problem)));
}

export function formatProblem(problem: Problem) {
    const where = problem.selector ?? problem.where;
    return `${problem.type.toUpperCase()}: ${problem.text}${
        where ? `  [${where}]` : ""
    }`;
}
