const TOKEN_KEY = "my-agent-token";
const MAX_PROFILES = 20;

const $ = (id) => document.getElementById(id);

const dom = {
	login: $("login"),
	loginForm: $("login-form"),
	tokenInput: $("token-input"),
	loginError: $("login-error"),
	app: $("app"),
	modelBadge: $("model-badge"),
	settingsBtn: $("settings-btn"),
	logoutBtn: $("logout-btn"),
	messages: $("messages"),
	empty: $("empty"),
	composer: $("composer"),
	prompt: $("prompt"),
	send: $("send"),
	settings: $("settings"),
	settingsClose: $("settings-close"),
	encryptionWarning: $("encryption-warning"),
	profileCount: $("profile-count"),
	profileList: $("profile-list"),
	formTitle: $("form-title"),
	formCancel: $("form-cancel"),
	profileForm: $("profile-form"),
	name: $("profile-name"),
	baseUrl: $("profile-baseurl"),
	model: $("profile-model"),
	key: $("profile-key"),
	keyHint: $("key-hint"),
	context: $("profile-context"),
	maxTokens: $("profile-maxtokens"),
	reasoning: $("profile-reasoning"),
	formStatus: $("form-status"),
	resetBtn: $("reset-btn"),
	toast: $("toast"),
};

class ApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

const state = {
	token: readToken(),
	config: null,
	history: [],
	streaming: false,
	editingId: null,
};

let toastTimer;

function readToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) || "";
	} catch {
		return "";
	}
}

function saveToken(token) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// Storage may be unavailable in private windows; the session still works.
	}
}

function authHeaders(extra) {
	const headers = new Headers(extra || {});
	headers.set("Authorization", `Bearer ${state.token}`);
	return headers;
}

async function request(path, options = {}) {
	const headers = authHeaders(options.headers);
	if (options.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(path, { ...options, headers });
	if (response.status === 401) {
		handleUnauthorized();
		throw new ApiError("登录已失效，请重新输入 Token", 401);
	}
	if (!response.ok) {
		throw new ApiError(await readError(response), response.status);
	}
	return response;
}

async function readError(response) {
	try {
		const data = await response.json();
		if (typeof data?.error === "string") return data.error;
		if (data?.error?.message) return data.error.message;
	} catch {
		// Fall through to the generic message.
	}
	return `请求失败（HTTP ${response.status}）`;
}

function showLogin(message = "") {
	dom.app.classList.add("hidden");
	dom.settings.classList.add("hidden");
	dom.login.classList.remove("hidden");
	dom.loginError.textContent = message;
	dom.tokenInput.focus();
}

function handleUnauthorized() {
	state.token = "";
	state.config = null;
	state.history = [];
	saveToken("");
	showLogin("登录已失效，请重新输入 Token");
}

function toast(message) {
	dom.toast.textContent = message;
	dom.toast.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 2600);
}

async function bootstrap() {
	dom.login.classList.add("hidden");
	dom.app.classList.remove("hidden");
	try {
		await Promise.all([loadConfig(), loadHistory()]);
	} catch (error) {
		if (error.status === 401) return;
		toast(error.message || "加载失败");
	}
}

async function loadConfig() {
	const response = await request("/api/config");
	state.config = await response.json();
	renderConfig();
}

async function loadHistory() {
	const response = await request("/api/chat/history");
	const data = await response.json();
	state.history = Array.isArray(data.messages) ? data.messages : [];
	renderHistory();
}

function renderConfig() {
	const profiles = state.config?.profiles ?? [];
	const active = profiles.find((profile) => profile.active);

	dom.modelBadge.textContent = active
		? `${active.name} · ${active.modelId}`
		: "未配置模型";
	dom.modelBadge.title = active
		? `${active.baseUrl}\n点击打开设置`
		: "点击打开设置";

	dom.profileCount.textContent = `${profiles.length} / ${MAX_PROFILES}`;
	dom.encryptionWarning.classList.toggle(
		"hidden",
		Boolean(state.config?.encryptionReady),
	);

	renderProfiles();

	if (state.editingId && !profiles.some((profile) => profile.id === state.editingId)) {
		resetForm();
	}
}

function renderProfiles() {
	const profiles = state.config?.profiles ?? [];
	dom.profileList.replaceChildren();

	if (profiles.length === 0) {
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = "还没有配置。在下方新增一个 OpenAI 兼容模型。";
		dom.profileList.append(empty);
		return;
	}

	for (const profile of profiles) {
		dom.profileList.append(profileCard(profile));
	}
}

function profileCard(profile) {
	const card = document.createElement("div");
	card.className = `profile-card${profile.active ? " active" : ""}`;

	const main = document.createElement("div");
	main.className = "profile-main";

	const name = document.createElement("span");
	name.className = "profile-name";
	name.textContent = profile.name;
	main.append(name);

	if (profile.active) {
		const activePill = document.createElement("span");
		activePill.className = "pill";
		activePill.textContent = "使用中";
		main.append(activePill);
	}

	const keyPill = document.createElement("span");
	keyPill.className = `pill${profile.hasApiKey ? "" : " warn"}`;
	keyPill.textContent = profile.hasApiKey ? "密钥已保存" : "缺少密钥";
	main.append(keyPill);

	const meta = document.createElement("div");
	meta.className = "profile-meta";
	meta.textContent = `${profile.modelId} · ${profile.baseUrl}`;

	const limits = document.createElement("div");
	limits.className = "profile-meta";
	limits.textContent = `上下文 ${profile.contextWindow.toLocaleString()} · 最大输出 ${profile.maxTokens.toLocaleString()}${
		profile.reasoning ? " · reasoning" : ""
	}`;

	const actions = document.createElement("div");
	actions.className = "profile-actions";

	if (!profile.active) {
		actions.append(
			actionButton("启用", async () => {
				const response = await request(
					`/api/config/profiles/${encodeURIComponent(profile.id)}/activate`,
					{ method: "POST" },
				);
				const data = await response.json();
				state.config = data.config;
				renderConfig();
				toast(`已切换到 ${profile.name}`);
			}),
		);
	}

	actions.append(
		actionButton("编辑", () => editProfile(profile)),
	);

	const testButton = actionButton("测试", () => testProfile(profile, result));
	actions.append(testButton);

	actions.append(
		actionButton(
			"删除",
			async () => {
				if (!confirm(`删除配置「${profile.name}」？已加密保存的 API Key 也会一并删除。`)) {
					return;
				}
				await request(`/api/config/profiles/${encodeURIComponent(profile.id)}`, {
					method: "DELETE",
				});
				await loadConfig();
				toast("配置已删除");
			},
			"danger",
		),
	);

	const result = document.createElement("div");
	result.className = "test-result";

	card.append(main, meta, limits, actions, result);
	return card;
}

function actionButton(label, handler, variant) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `small-button${variant ? ` ${variant}` : ""}`;
	button.textContent = label;
	button.addEventListener("click", async () => {
		const original = button.textContent;
		button.disabled = true;
		button.textContent = "…";
		try {
			await handler();
		} catch (error) {
			if (error.status !== 401) toast(error.message || "操作失败");
		} finally {
			button.disabled = false;
			button.textContent = original;
		}
	});
	return button;
}

async function testProfile(profile, resultElement) {
	resultElement.className = "test-result";
	resultElement.textContent = "正在测试连接…";
	const response = await request(
		`/api/config/profiles/${encodeURIComponent(profile.id)}/test`,
		{ method: "POST" },
	);
	const { result } = await response.json();
	if (result.ok) {
		resultElement.classList.add("ok");
		resultElement.textContent = `连接成功 · ${result.latencyMs ?? "?"} ms`;
	} else {
		resultElement.classList.add("bad");
		resultElement.textContent = result.error || "连接失败";
	}
}

function editProfile(profile) {
	state.editingId = profile.id;
	dom.formTitle.textContent = "编辑配置";
	dom.formCancel.classList.remove("hidden");
	dom.name.value = profile.name;
	dom.baseUrl.value = profile.baseUrl;
	dom.model.value = profile.modelId;
	dom.key.value = "";
	dom.keyHint.textContent = "留空表示保留现有密钥；填写则替换。";
	dom.context.value = String(profile.contextWindow);
	dom.maxTokens.value = String(profile.maxTokens);
	dom.reasoning.checked = profile.reasoning;
	dom.formStatus.textContent = "";
	dom.profileForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetForm() {
	state.editingId = null;
	dom.profileForm.reset();
	dom.formTitle.textContent = "新增配置";
	dom.formCancel.classList.add("hidden");
	dom.keyHint.textContent = "新建配置必须填写。保存后无法再读回明文。";
	dom.formStatus.textContent = "";
	dom.context.value = "128000";
	dom.maxTokens.value = "8192";
}

async function submitProfile(event) {
	event.preventDefault();

	const body = {
		name: dom.name.value.trim(),
		baseUrl: dom.baseUrl.value.trim(),
		modelId: dom.model.value.trim(),
		reasoning: dom.reasoning.checked,
		contextWindow: Number(dom.context.value),
		maxTokens: Number(dom.maxTokens.value),
	};
	const key = dom.key.value.trim();
	if (key) body.apiKey = key;
	if (state.editingId) body.id = state.editingId;

	if (!body.name || !body.baseUrl || !body.modelId) {
		dom.formStatus.textContent = "请填写名称、Base URL 和模型 ID。";
		return;
	}
	if (!Number.isInteger(body.contextWindow) || body.contextWindow < 1024) {
		dom.formStatus.textContent = "上下文窗口至少为 1024。";
		return;
	}
	if (!Number.isInteger(body.maxTokens) || body.maxTokens < 1) {
		dom.formStatus.textContent = "最大输出 Token 至少为 1。";
		return;
	}

	dom.formStatus.textContent = "保存中…";
	const submit = dom.profileForm.querySelector('button[type="submit"]');
	submit.disabled = true;
	try {
		await request("/api/config/profiles", {
			method: "POST",
			body: JSON.stringify(body),
		});
		await loadConfig();
		resetForm();
		toast("配置已保存");
	} catch (error) {
		if (error.status !== 401) dom.formStatus.textContent = error.message;
	} finally {
		submit.disabled = false;
	}
}

function atBottom() {
	const distance =
		dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight;
	return distance < 140;
}

function scrollToBottom() {
	dom.messages.scrollTop = dom.messages.scrollHeight;
}

function addBubble(role, text, scroll = true) {
	dom.empty.classList.add("hidden");
	const row = document.createElement("div");
	row.className = `row ${role}`;
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = text;
	row.append(bubble);
	dom.messages.append(row);
	if (scroll) scrollToBottom();
	return bubble;
}

function renderHistory() {
	dom.messages.replaceChildren();
	dom.empty.classList.toggle("hidden", state.history.length > 0);
	for (const message of state.history) {
		addBubble(message.role === "user" ? "user" : "assistant", message.text, false);
	}
	scrollToBottom();
}

function resizePrompt() {
	dom.prompt.style.height = "auto";
	dom.prompt.style.height = `${Math.min(dom.prompt.scrollHeight, 180)}px`;
}

function updateComposer() {
	dom.send.disabled = state.streaming;
	dom.send.textContent = state.streaming ? "回复中…" : "发送";
	dom.prompt.placeholder = state.streaming
		? "正在回复，请稍候…"
		: "给 Pi 发消息…";
}

async function sendPrompt() {
	if (state.streaming) return;
	const prompt = dom.prompt.value.trim();
	if (!prompt) return;

	if (!state.config?.activeProfileId) {
		toast("请先在设置中启用一个模型");
		openSettings();
		return;
	}

	dom.prompt.value = "";
	resizePrompt();
	addBubble("user", prompt);
	const bubble = addBubble("assistant", "…");
	bubble.classList.add("streaming");

	state.streaming = true;
	updateComposer();

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ prompt }),
		});

		if (response.status === 401) {
			handleUnauthorized();
			return;
		}
		if (!response.ok) {
			bubble.classList.remove("streaming");
			bubble.classList.add("error");
			bubble.textContent = await readError(response);
			return;
		}
		if (!response.body) {
			throw new Error("当前浏览器不支持流式响应");
		}

		let completed = false;
		await consumeSse(response.body, {
			delta(text) {
				if (!text) return;
				const stick = atBottom();
				bubble.textContent = text;
				if (stick) scrollToBottom();
			},
			done(payload) {
				completed = true;
				bubble.classList.remove("streaming");
				if (payload.status === "done") {
					if (payload.text) bubble.textContent = payload.text;
					void loadHistory();
					return;
				}
				bubble.classList.add("error");
				bubble.textContent = formatReason(
					payload.reason,
					payload.text,
					payload.detail,
				);
			},
			error(message) {
				completed = true;
				bubble.classList.remove("streaming");
				bubble.classList.add("error");
				bubble.textContent = message || "流式响应出错";
			},
		});

		if (!completed) {
			bubble.classList.remove("streaming");
			void loadHistory();
		}
	} catch (error) {
		bubble.classList.remove("streaming");
		bubble.classList.add("error");
		bubble.textContent = error.message || "请求失败";
	} finally {
		state.streaming = false;
		updateComposer();
	}
}

function formatReason(reason, text, detail) {
	const labels = {
		model_error: "模型调用失败",
		no_model: "没有可用模型",
		aborted: "本轮已中止",
		reset: "对话已重置",
		faulted: "运行出错",
		orphaned: "任务被中断",
		interrupted: "运行被中断",
		restart_limit: "重试次数过多",
		nothing_to_answer: "没有需要回答的内容",
		turn_limit: "达到工具轮数上限",
	};
	const label = labels[reason] || reason || "未知原因";
	const lines = [`未能回答：${label}`];
	if (detail && detail !== text) lines.push(detail);
	if (text) lines.push(text);
	return lines.join("\n\n");
}

async function consumeSse(stream, handlers) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const dispatch = (block) => {
		let event = "message";
		const dataLines = [];
		for (const rawLine of block.split("\n")) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line || line.startsWith(":")) continue;
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
			}
		}
		if (dataLines.length === 0) return;

		let payload;
		try {
			payload = JSON.parse(dataLines.join("\n"));
		} catch {
			return;
		}

		if (event === "start") handlers.start?.(payload);
		else if (event === "delta") handlers.delta?.(payload.text ?? "");
		else if (event === "done") handlers.done?.(payload);
		else if (event === "error") handlers.error?.(payload.message ?? "未知错误");
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer = (buffer + decoder.decode(value, { stream: true })).replace(
			/\r\n/g,
			"\n",
		);
		let index;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const block = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			dispatch(block);
		}
	}

	buffer += decoder.decode();
	if (buffer.trim()) dispatch(buffer);
}

async function resetChat() {
	if (!confirm("确定清空当前对话？历史记录会被删除。")) return;
	await request("/api/chat/reset", { method: "POST" });
	await loadHistory();
	toast("对话已清空");
}

function openSettings() {
	dom.settings.classList.remove("hidden");
	if (state.config) renderConfig();
}

function closeSettings() {
	dom.settings.classList.add("hidden");
}

function bindEvents() {
	dom.loginForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const token = dom.tokenInput.value.trim();
		if (!token) {
			dom.loginError.textContent = "请输入访问令牌。";
			return;
		}
		state.token = token;
		saveToken(token);
		dom.loginError.textContent = "";
		const button = dom.loginForm.querySelector("button[type=submit]");
		button.disabled = true;
		button.textContent = "连接中…";
		try {
			await bootstrap();
		} catch (error) {
			if (error.status === 401) {
				dom.loginError.textContent = "Token 无效，请检查后重试。";
			} else {
				dom.loginError.textContent = error.message || "连接失败";
			}
			showLogin(dom.loginError.textContent);
		} finally {
			button.disabled = false;
			button.textContent = "连接";
		}
	});

	dom.settingsBtn.addEventListener("click", openSettings);
	dom.modelBadge.addEventListener("click", openSettings);
	dom.settingsClose.addEventListener("click", closeSettings);
	dom.settings.addEventListener("click", (event) => {
		if (event.target === dom.settings) closeSettings();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !dom.settings.classList.contains("hidden")) {
			closeSettings();
		}
	});

	dom.logoutBtn.addEventListener("click", () => {
		state.token = "";
		saveToken("");
		location.reload();
	});

	dom.profileForm.addEventListener("submit", submitProfile);
	dom.formCancel.addEventListener("click", resetForm);
	dom.resetBtn.addEventListener("click", async () => {
		try {
			await resetChat();
		} catch (error) {
			if (error.status !== 401) toast(error.message);
		}
	});

	dom.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		void sendPrompt();
	});
	dom.prompt.addEventListener("input", resizePrompt);
	dom.prompt.addEventListener("keydown", (event) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.isComposing &&
			!state.streaming
		) {
			event.preventDefault();
			void sendPrompt();
		}
	});

	dom.messages.addEventListener("scroll", () => {
		// No-op hook for future jump-to-latest affordance.
	});
}

bindEvents();
updateComposer();
resizePrompt();

if (state.token) {
	dom.tokenInput.value = state.token;
	bootstrap();
} else {
	showLogin();
}
