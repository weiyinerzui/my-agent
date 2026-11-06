import type { EntryRecord } from "@earendil-works/pi-durable";
import type { LiveState } from "@earendil-works/pi-durable";
import type { ChatMessage } from "../config/types";

interface ContentPart {
	type?: string;
	text?: string;
}

interface TranscriptMessage {
	role?: string;
	content?: string | readonly ContentPart[];
	stopReason?: string;
	errorMessage?: string;
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const candidate = part as ContentPart;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function firstMessage(entry: EntryRecord): TranscriptMessage | undefined {
	const message = entry.model?.[0];
	return message && typeof message === "object"
		? (message as TranscriptMessage)
		: undefined;
}

export function toChatMessages(entries: readonly EntryRecord[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	// One assistant bubble per user turn: retries and tool rounds write several
	// assistant entries, and only the last one is the answer shown to the user.
	let lastAssistant = -1;

	for (const entry of entries) {
		if (entry.kind === "pi.user") {
			const text = flattenContent(firstMessage(entry)?.content);
			if (text) messages.push({ id: String(entry.id), role: "user", text });
			lastAssistant = -1;
			continue;
		}

		if (entry.kind === "pi.assistant") {
			const source = firstMessage(entry);
			const text = flattenContent(source?.content);
			let rendered = text;
			if (!rendered && source?.stopReason === "error") {
				rendered = source.errorMessage?.trim() || "模型返回错误，未产生内容。";
			}
			if (!rendered) continue;

			if (lastAssistant >= 0) {
				messages[lastAssistant] = {
					id: String(entry.id),
					role: "assistant",
					text: rendered,
				};
			} else {
				messages.push({
					id: String(entry.id),
					role: "assistant",
					text: rendered,
				});
				lastAssistant = messages.length - 1;
			}
		}
	}

	return messages;
}

/** The cumulative text of the in-flight answer, if any. */
export function liveText(live: LiveState | undefined): string {
	const content = live?.generation?.message?.content;
	return flattenContent(content);
}

/** Why the newest run ended without an answer, if it did. */
export function liveFailure(
	live: LiveState | undefined,
): { reason: string; detail?: string } | undefined {
	const failure = live?.runFailure;
	if (!failure) return undefined;
	return { reason: failure.reason, detail: failure.detail };
}
