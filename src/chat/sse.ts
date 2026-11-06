import type { LiveState } from "@earendil-works/pi-durable";
import type { PiSession } from "agents/harness/pi";
import { errorMessage } from "../config/errors";
import { liveFailure, liveText } from "./history";

type SessionWatch = Awaited<ReturnType<PiSession["watch"]>>;

const HEARTBEAT_MS = 15_000;

export const SSE_HEADERS: Record<string, string> = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	"x-accel-buffering": "no",
	"x-content-type-options": "nosniff",
};

const encoder = new TextEncoder();

export function encodeSseEvent(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function encodeSseComment(text: string): Uint8Array {
	return encoder.encode(`: ${text}\n\n`);
}

function readLive(view: { docs: Readonly<Record<string, unknown>> }): LiveState {
	return (view.docs["pi.live"] ?? {}) as LiveState;
}

/**
 * Bridges a Pi conversation watch and one submitted operation into SSE.
 *
 * `delta` carries the cumulative text of the current generation, so a client
 * can replace the bubble instead of appending. `done` always ends the stream.
 */
export function createSseStream(
	session: PiSession,
	watch: SessionWatch,
	operationId: string,
): ReadableStream<Uint8Array> {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	let lastText = "";
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const write = (chunk: Uint8Array): void => {
		if (closed || !controller) return;
		try {
			controller.enqueue(chunk);
		} catch {
			closed = true;
		}
	};

	const cleanup = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (heartbeat !== undefined) clearInterval(heartbeat);
		await watch.stop().catch(() => undefined);
		try {
			controller?.close();
		} catch {
			// Already closed or cancelled.
		}
	};

	return new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			write(encodeSseEvent("start", { operationId }));
			heartbeat = setInterval(() => write(encodeSseComment("ping")), HEARTBEAT_MS);

			watch.start(async (call) => {
				if (closed) return;
				try {
					if (call.kind === "failed") {
						write(
							encodeSseEvent("error", {
								message: errorMessage(call.error).slice(0, 500),
							}),
						);
						return;
					}
					const text = liveText(readLive(call.value));
					if (text !== lastText) {
						lastText = text;
						write(encodeSseEvent("delta", { text }));
					}
				} catch (error) {
					write(encodeSseEvent("error", { message: errorMessage(error) }));
				}
			});

			void (async () => {
				try {
					const result = await session.wait(operationId);
					const failure = liveFailure(readLive(watch.value));
					write(
						encodeSseEvent("done", {
							text: result.text ?? lastText,
							status: result.status,
							reason: result.reason ?? null,
							detail: failure?.detail?.slice(0, 500) ?? null,
						}),
					);
				} catch (error) {
					write(encodeSseEvent("error", { message: errorMessage(error) }));
				} finally {
					await cleanup();
				}
			})();
		},

		async cancel() {
			// Stop observing, but let the run persist; a refresh can read the result.
			closed = true;
			if (heartbeat !== undefined) clearInterval(heartbeat);
			await watch.stop().catch(() => undefined);
		},
	});
}
