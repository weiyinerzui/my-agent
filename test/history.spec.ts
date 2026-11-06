import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { liveText, toChatMessages } from "../src/chat/history";

let nextId = 1;

function entry(
	kind: string,
	message: Record<string, unknown>,
): EntryRecord {
	return {
		id: `entry-${nextId++}`,
		conversationId: "conversation",
		kind,
		model: [message],
	} as unknown as EntryRecord;
}

function user(text: string): EntryRecord {
	return entry("pi.user", { role: "user", content: text });
}

function assistant(
	content: Array<{ type: string; text: string }>,
	stopReason = "stop",
): EntryRecord {
	return entry("pi.assistant", { role: "assistant", content, stopReason });
}

describe("history mapping", () => {
	it("keeps one assistant bubble per turn and uses the last entry", () => {
		const messages = toChatMessages([
			user("hello"),
			assistant([], "error"),
			assistant([], "error"),
			assistant([{ type: "text", text: "final answer" }]),
		]);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user", text: "hello" });
		expect(messages[1]).toMatchObject({
			role: "assistant",
			text: "final answer",
		});
	});

	it("collapses tool rounds into the final assistant text", () => {
		const messages = toChatMessages([
			user("compute"),
			assistant([{ type: "text", text: "let me check" }]),
			assistant([
				{ type: "text", text: "the answer is " },
				{ type: "text", text: "42" },
			]),
		]);

		expect(messages.map((message) => message.text)).toEqual([
			"compute",
			"the answer is \n42",
		]);
	});

	it("shows an error placeholder when a failed attempt has no text", () => {
		const failed = entry("pi.assistant", {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "connection refused",
		});
		const messages = toChatMessages([user("hi"), failed]);
		expect(messages[1].text).toBe("connection refused");
	});

	it("ignores non-visible entries", () => {
		const messages = toChatMessages([
			entry("pi.system", { role: "system", content: [] }),
			user("only this"),
		]);
		expect(messages).toHaveLength(1);
	});
});

describe("live text", () => {
	it("joins text parts of the in-flight message", () => {
		const live = {
			generation: {
				attempt: 1,
				message: {
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "partial" },
					],
				},
			},
		};
		expect(liveText(live)).toBe("partial");
	});

	it("returns an empty string without a generation", () => {
		expect(liveText(undefined)).toBe("");
		expect(liveText({})).toBe("");
	});
});
