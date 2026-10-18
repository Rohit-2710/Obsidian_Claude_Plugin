// Provider that runs the user's own installed Claude Code CLI (`claude -p`), signed in with
// their own Claude subscription. The plugin never reads or handles credentials.
// The process runner itself (desktop only) lives in process.ts.
import { redact } from './core';
import { AiError, AiProvider, AiRequest, AiResponse } from './provider';

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs a program with an argument array (never a shell) and writes `stdin` to it. */
export type Runner = (bin: string, args: string[], stdin: string, signal?: AbortSignal) => Promise<ProcessResult>;

/**
 * Fixed, documented flags only. Note content never goes into arguments: it is sent on stdin.
 * --safe-mode turns off the user's CLAUDE.md, plugins, hooks, MCP servers and output styles
 * (so they can't alter the prompt) while keeping their subscription login. --tools "" means the
 * model can't read or edit files or run commands: it only returns text.
 */
export function claudeArgs(req: AiRequest, model: string): string[] {
	const args = ['-p', '--safe-mode', '--tools', '', '--system-prompt', req.systemPrompt, '--output-format', 'json', '--no-session-persistence'];
	if (model.trim()) args.push('--model', model.trim());
	if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
	return args;
}

const get = (o: unknown, key: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const firstLine = (s: string) => redact(s.trim().split('\n')[0] ?? '').slice(0, 300);

function lastJson(stdout: string): unknown {
	for (const candidate of [stdout.trim(), stdout.trim().split('\n').pop() ?? '']) {
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

/** Claude Code can use a small model for side tasks; report the one that wrote the most output. */
function mainModel(models: unknown): string | undefined {
	if (!models || typeof models !== 'object') return undefined;
	let best: string | undefined;
	let most = -1;
	for (const [name, u] of Object.entries(models)) {
		const out = num(get(u, 'outputTokens')) ?? 0;
		if (out > most) [best, most] = [name, out];
	}
	return best;
}

/** Turn `claude -p --output-format json` output into an AiResponse, or a user-readable AiError. */
export function parseClaudeResult({ code, stdout, stderr }: ProcessResult): AiResponse {
	const json = lastJson(stdout);
	if (get(json, 'type') !== 'result') {
		const why = firstLine(stderr) || firstLine(stdout) || 'no output';
		throw new AiError(`Claude Code failed${code != null ? ` (exit code ${code})` : ''}: ${why}. Update Claude Code if this persists.`);
	}
	const message = typeof get(json, 'result') === 'string' ? (get(json, 'result') as string) : '';
	if (get(json, 'is_error') === true || get(json, 'subtype') !== 'success') {
		const status = get(json, 'api_error_status');
		if (status === 401 || /log ?in|sign ?in|authenticat/i.test(message)) {
			throw new AiError('Claude Code is not signed in. Run "claude" in a terminal and sign in with your Claude account.');
		}
		if (status === 429 || /usage limit|rate limit/i.test(message)) {
			throw new AiError(`You've reached your Claude usage limit for now: ${firstLine(message)}`);
		}
		throw new AiError(`Claude Code: ${firstLine(message) || String(get(json, 'subtype'))}`);
	}
	const stop = get(json, 'stop_reason');
	if (stop === 'refusal') throw new AiError('The model declined this request. Try rephrasing the note.');
	const structured = get(json, 'structured_output');
	const usage = get(json, 'usage');
	const models = get(json, 'modelUsage');
	return {
		text: structured !== undefined && structured !== null ? JSON.stringify(structured) : message,
		model: mainModel(models),
		stopReason: typeof stop === 'string' ? stop : undefined,
		usage: { inputTokens: num(get(usage, 'input_tokens')), outputTokens: num(get(usage, 'output_tokens')) },
	};
}

/** Summarize `claude auth status --json` without exposing the account email or org. */
export function parseAuthStatus(res: ProcessResult): { ok: boolean; message: string } {
	const json = lastJson(res.stdout);
	if (get(json, 'loggedIn') === true) {
		const plan = get(json, 'subscriptionType');
		const via = get(json, 'authMethod') === 'claude.ai' && typeof plan === 'string' ? `your Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : 'your Claude Code login';
		return { ok: true, message: `Connected. Claude Code is signed in with ${via}.` };
	}
	if (json !== undefined) return { ok: false, message: 'Claude Code is installed but not signed in. Run "claude" in a terminal and sign in.' };
	return { ok: false, message: `Claude Code didn't respond as expected: ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}` };
}

export class ClaudeCodeProvider implements AiProvider {
	readonly label = 'Claude Code';

	constructor(
		private bin: string,
		private model: string,
		private run: Runner,
	) {}

	async generate(req: AiRequest): Promise<AiResponse> {
		if (req.signal?.aborted) throw new AiError('Cancelled.');
		return parseClaudeResult(await this.run(this.bin, claudeArgs(req, this.model), req.userPrompt, req.signal));
	}

	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			return parseAuthStatus(await this.run(this.bin, ['auth', 'status', '--json'], ''));
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}
}
