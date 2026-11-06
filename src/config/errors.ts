export type ApiErrorCode =
	| "bad_request"
	| "not_found"
	| "conflict"
	| "unauthorized"
	| "internal";

const PREFIX = /^(?:Error:\s*)?(bad_request|not_found|conflict|unauthorized|internal):\s*([\s\S]*)$/;

/**
 * Throws an error whose code survives Durable Object RPC serialization.
 * The Worker parses the prefix to pick an HTTP status.
 */
export function fail(code: ApiErrorCode, message: string): never {
	throw new Error(`${code}: ${message}`);
}

export function parseApiError(
	error: unknown,
): { code: ApiErrorCode; message: string } | undefined {
	const raw = error instanceof Error ? error.message : String(error);
	const match = raw.match(PREFIX);
	if (!match) return undefined;
	return { code: match[1] as ApiErrorCode, message: match[2].trim() };
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const parsed = parseApiError(error);
		return parsed?.message ?? error.message;
	}
	return String(error);
}
