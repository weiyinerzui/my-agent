import { SSE_HEADERS } from "./chat/sse";
import { parseApiError, fail } from "./config/errors";
import type { ApiErrorCode } from "./config/errors";
import type { ProfileInput } from "./config/types";

export { Assistant } from "./assistant";

const MAX_BODY_BYTES = 32 * 1024;

function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

function errorResponse(
	status: number,
	code: ApiErrorCode | "unauthorized",
	message: string,
): Response {
	return json({ error: { code, message } }, status);
}

function statusFor(code: ApiErrorCode): number {
	switch (code) {
		case "bad_request":
			return 400;
		case "unauthorized":
			return 401;
		case "not_found":
			return 404;
		case "conflict":
			return 409;
		case "internal":
			return 500;
	}
}

function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
	const expected = env.AUTH_TOKEN;
	if (!expected) return false;
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer ")) return false;
	return timingSafeEqual(header.slice("Bearer ".length), expected);
}

async function readJson(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > MAX_BODY_BYTES) {
		fail("bad_request", "Request body is too large");
	}
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) {
		fail("bad_request", "Request body is too large");
	}
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		fail("bad_request", "Request body is not valid JSON");
	}
}

function agentFor(env: Env) {
	return env.Assistant.getByName("demo");
}

async function routeApi(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const method = request.method.toUpperCase();
	const path = url.pathname;

	if (!env.AUTH_TOKEN) {
		return errorResponse(
			500,
			"internal",
			"AUTH_TOKEN is not configured on the server",
		);
	}
	if (!isAuthorized(request, env)) {
		return errorResponse(401, "unauthorized", "Invalid or missing token");
	}

	const assistant = agentFor(env);
	const session = url.searchParams.get("session") ?? undefined;

	if (path === "/api/config" && method === "GET") {
		return json(await assistant.getConfig());
	}

	if (path === "/api/config/profiles" && method === "POST") {
		const body = await readJson(request);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			fail("bad_request", "Request body must be an object");
		}
		const profile = await assistant.saveProfile(body as ProfileInput);
		return json({ profile });
	}

	const profileMatch = path.match(
		/^\/api\/config\/profiles\/([^/]+)(?:\/(activate|test))?$/,
	);
	if (profileMatch) {
		const id = decodeURIComponent(profileMatch[1]);
		const action = profileMatch[2];

		if (!action && method === "DELETE") {
			await assistant.deleteProfile(id);
			return json({ ok: true });
		}
		if (action === "activate" && method === "POST") {
			return json({ config: await assistant.activateProfile(id) });
		}
		if (action === "test" && method === "POST") {
			return json({ result: await assistant.testProfile(id) });
		}
	}

	if (path === "/api/chat/history" && method === "GET") {
		return json({ messages: await assistant.getHistory(session) });
	}

	if (path === "/api/chat/reset" && method === "POST") {
		await assistant.resetChat(session);
		return json({ ok: true });
	}

	if (path === "/api/chat" && method === "POST") {
		const body = (await readJson(request)) as {
			prompt?: unknown;
			sessionId?: unknown;
		};
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			fail("bad_request", "Request body must be an object");
		}
		if (typeof body.prompt !== "string") {
			fail("bad_request", "prompt is required");
		}
		const sessionId =
			typeof body.sessionId === "string" ? body.sessionId : session;

		const stream = await assistant.streamChat(sessionId, body.prompt);
		return new Response(stream, { headers: SSE_HEADERS });
	}

	if (path === "/api/ask" && method === "GET") {
		const prompt = url.searchParams.get("q")?.trim();
		if (!prompt) fail("bad_request", "Query parameter q is required");
		return json(await assistant.askOnce(prompt));
	}

	return errorResponse(404, "not_found", "Unknown API route");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) {
			return errorResponse(404, "not_found", "Not found");
		}
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					allow: "GET, POST, DELETE, OPTIONS",
					"cache-control": "no-store",
				},
			});
		}

		try {
			return await routeApi(request, env, url);
		} catch (error) {
			const parsed = parseApiError(error);
			if (parsed) {
				return errorResponse(
					statusFor(parsed.code),
					parsed.code,
					parsed.message,
				);
			}
			console.error("Unhandled API error", error);
			return errorResponse(500, "internal", "Internal server error");
		}
	},
};
