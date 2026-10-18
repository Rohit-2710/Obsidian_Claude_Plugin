import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { redact } from './core';

export interface AiRequest {
	systemPrompt: string;
	userPrompt: string;
	maxOutputTokens: number;
	/** Constrain the response to JSON matching this schema. Still validate the result. */
	jsonSchema?: object;
	signal?: AbortSignal;
}

export interface AiResponse {
	text: string;
	model?: string;
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
	generate(request: AiRequest): Promise<AiResponse>;
	testConnection(): Promise<{ ok: boolean; message: string }>;
}

/** Errors with messages that are safe to show the user (never contain the key). */
export class AiError extends Error {}

/** Obsidian's `requestUrl`, injected so this module has no runtime Obsidian dependency. */
export type Http = (req: RequestUrlParam) => Promise<RequestUrlResponse>;

const API = 'https://api.anthropic.com/v1';
const TIMEOUT_MS = 10 * 60_000;
// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class AnthropicProvider implements AiProvider {
	constructor(
		private apiKey: string,
		private model: string,
		private http: Http,
	) {}

	async generate(req: AiRequest): Promise<AiResponse> {
		const fallback = FALLBACK_MODELS.has(this.model);
		const body = {
			model: this.model,
			max_tokens: req.maxOutputTokens,
			system: req.systemPrompt,
			messages: [{ role: 'user', content: req.userPrompt }],
			...(fallback ? { fallbacks: 'default' } : {}),
			...(req.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: req.jsonSchema } } } : {}),
		};
		const res = await this.send(
			{ url: `${API}/messages`, method: 'POST', headers: this.headers(fallback), body: JSON.stringify(body) },
			req.signal,
		);
		return parseMessage(res);
	}

	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			// Free call: checks the key and that the model ID exists, without generating tokens.
			const res = await this.send({
				url: `${API}/models/${encodeURIComponent(this.model)}`,
				method: 'GET',
				headers: this.headers(false),
			});
			const name = get(safeJson(res), 'display_name');
			return { ok: true, message: `Connected. Model "${typeof name === 'string' ? name : this.model}" is available.` };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	private headers(fallback: boolean): Record<string, string> {
		return {
			'x-api-key': this.apiKey,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
			...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
		};
	}

	private async send(param: RequestUrlParam, signal?: AbortSignal): Promise<RequestUrlResponse> {
		if (!this.apiKey) throw new AiError('No API key configured. Choose one in DSA Vault Agent settings.');
		if (!this.model.trim()) throw new AiError('No model configured. Set a model ID in DSA Vault Agent settings.');
		if (signal?.aborted) throw new AiError('Cancelled.');
		// ponytail: requestUrl can't be aborted, so cancel/timeout just stops waiting and discards
		// the response; the request still completes server-side (and is billed).
		let timer: number | undefined;
		let onAbort = () => {};
		const stop = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(new AiError('The AI request timed out.')), TIMEOUT_MS);
			onAbort = () => reject(new AiError('Cancelled.'));
			signal?.addEventListener('abort', onAbort, { once: true });
		});
		try {
			const res = await Promise.race([this.http({ ...param, throw: false }), stop]);
			if (res.status >= 400) throw httpError(res, this.model, this.apiKey);
			return res;
		} catch (e) {
			if (e instanceof AiError) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			throw new AiError(`Network error contacting Anthropic: ${redact(msg, [this.apiKey])}`);
		} finally {
			window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}
	}
}

function safeJson(res: RequestUrlResponse): unknown {
	try {
		return JSON.parse(res.text) as unknown;
	} catch {
		return null;
	}
}

/** Read a property of an unknown JSON value; undefined if it isn't an object. */
const get = (o: unknown, key: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function httpError(res: RequestUrlResponse, model: string, apiKey = ''): AiError {
	const apiMsg = get(get(safeJson(res), 'error'), 'message');
	const detail = typeof apiMsg === 'string' ? ` (${redact(apiMsg, [apiKey]).slice(0, 300)})` : '';
	const retry = res.headers?.['retry-after'] ?? res.headers?.['Retry-After'];
	const s = res.status;
	const msg =
		s === 401 ? 'Authentication failed (401): check your Anthropic API key.'
		: s === 402 ? 'Billing problem (402): check your Anthropic account billing.'
		: s === 403 ? 'Permission denied (403): this API key cannot use this model or feature.'
		: s === 404 ? `Not found (404): check the model ID "${model}".`
		: s === 413 ? 'Request too large (413): shorten the note or lower the related-notes limit.'
		: s === 429 ? `Rate limited (429): ${retry ? `wait ${retry}s and` : 'wait a moment, then'} try again.`
		: s === 529 || s === 503 ? `Anthropic is overloaded (${s}): try again shortly.`
		: s >= 500 ? `Anthropic server error (${s}): try again later.`
		: `Request rejected (${s}).`;
	return new AiError(msg + detail);
}

export function parseMessage(res: RequestUrlResponse): AiResponse {
	const json = safeJson(res);
	const content = get(json, 'content');
	if (get(json, 'type') !== 'message' || !Array.isArray(content)) {
		throw new AiError('Malformed response from Anthropic.');
	}
	const stop = get(json, 'stop_reason');
	if (stop === 'refusal') {
		throw new AiError('The model declined this request. Try rephrasing the note or another model.');
	}
	const text = content
		.map((b) => (get(b, 'type') === 'text' ? get(b, 'text') : undefined))
		.filter((t): t is string => typeof t === 'string')
		.join('');
	const model = get(json, 'model');
	const usage = get(json, 'usage');
	return {
		text,
		model: typeof model === 'string' ? model : undefined,
		stopReason: typeof stop === 'string' ? stop : undefined,
		usage: { inputTokens: num(get(usage, 'input_tokens')), outputTokens: num(get(usage, 'output_tokens')) },
	};
}
