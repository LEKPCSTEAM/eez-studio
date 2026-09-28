export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export class CliError extends Error {
    constructor(
        message: string,
        public hint?: string,
        public exitCode: number = EXIT_ERROR,
        public details?: any
    ) {
        super(message);
    }
}

export class UsageError extends CliError {
    constructor(message: string, hint?: string) {
        super(message, hint, EXIT_USAGE);
    }
}

export function errorToString(err: any) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
