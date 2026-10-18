import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeProvider, ProcessResult, claudeArgs, parseAuthStatus, parseClaudeResult } from '../src/claude-code';
import { LINK_SCHEMA } from '../src/prompts';

const ok = (extra: Record<string, unknown>): ProcessResult => ({
	code: 0,
	stderr: '',
	stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 }, modelUsage: { 'claude-sonnet-4-6': {} }, ...extra }),
});

test('claudeArgs uses fixed flags and never carries note content', () => {
	const args = claudeArgs({ systemPrompt: 'SYS', userPrompt: 'SECRET NOTE; rm -rf ~', maxOutputTokens: 100 }, '');
	assert.deepEqual(args, ['-p', '--safe-mode', '--tools', '', '--system-prompt', 'SYS', '--output-format', 'json', '--no-session-persistence']);
	assert.ok(!args.join(' ').includes('SECRET NOTE'));
	const withSchema = claudeArgs({ systemPrompt: 'S', userPrompt: 'u', maxOutputTokens: 1, jsonSchema: LINK_SCHEMA }, ' sonnet ');
	assert.deepEqual(withSchema.slice(-4), ['--model', 'sonnet', '--json-schema', JSON.stringify(LINK_SCHEMA)]);
});

test('parseClaudeResult reads text, structured output and usage', () => {
	const text = parseClaudeResult(ok({ result: '## Summary\nfine' }));
	assert.deepEqual(text, { text: '## Summary\nfine', model: 'claude-sonnet-4-6', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } });
	const structured = parseClaudeResult(ok({ result: 'prose the user never sees', structured_output: { patterns: [], new_patterns: [] } }));
	assert.equal(structured.text, '{"patterns":[],"new_patterns":[]}');
	const two = parseClaudeResult(ok({ result: 'x', modelUsage: { 'claude-haiku-4-5': { outputTokens: 20 }, 'claude-sonnet-4-6': { outputTokens: 900 } } }));
	assert.equal(two.model, 'claude-sonnet-4-6');
	// warnings printed before the JSON line are tolerated
	assert.equal(parseClaudeResult({ ...ok({ result: 'x' }), stdout: 'warning: something\n' + ok({ result: 'x' }).stdout }).text, 'x');
});

test('parseClaudeResult maps failures to actionable messages', () => {
	const err = (extra: Record<string, unknown>) => ok({ is_error: true, ...extra });
	assert.throws(() => parseClaudeResult(err({ api_error_status: 401, result: 'Invalid API key · Please run /login' })), /not signed in/);
	assert.throws(() => parseClaudeResult(err({ api_error_status: 429, result: 'Claude AI usage limit reached|1760000000' })), /usage limit/);
	assert.throws(() => parseClaudeResult(err({ api_error_status: 404, result: "There's an issue with the selected model (x)." })), /Claude Code: There's an issue with the selected model/);
	assert.throws(() => parseClaudeResult(ok({ stop_reason: 'refusal', result: '' })), /declined/);
	assert.throws(() => parseClaudeResult({ code: 1, stdout: '', stderr: 'error: unknown option --safe-mode\nmore' }), /exit code 1\): error: unknown option --safe-mode\. Update Claude Code/);
	assert.throws(() => parseClaudeResult({ code: 1, stdout: '', stderr: 'boom sk-ant-api03-LEAKEDKEY' }), (e: Error) => !e.message.includes('LEAKEDKEY'));
});

test('parseAuthStatus reports the plan without exposing account details', () => {
	const r = parseAuthStatus({ code: 0, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'me@example.com', orgName: 'Org' }) });
	assert.deepEqual(r, { ok: true, message: 'Connected. Claude Code is signed in with your Claude Pro plan.' });
	assert.equal(parseAuthStatus({ code: 1, stderr: '', stdout: '{"loggedIn":false}' }).ok, false);
	assert.match(parseAuthStatus({ code: 1, stderr: 'nope', stdout: '' }).message, /didn't respond as expected: nope/);
});

test('ClaudeCodeProvider sends the prompt on stdin and passes cancellation through', async () => {
	const calls: { bin: string; args: string[]; stdin: string; signal?: AbortSignal }[] = [];
	const provider = new ClaudeCodeProvider('/opt/claude', '', async (bin, args, stdin, signal) => {
		calls.push({ bin, args, stdin, signal });
		return ok({ result: 'done' });
	});
	const ctl = new AbortController();
	const res = await provider.generate({ systemPrompt: 'S', userPrompt: '<note>my note</note>', maxOutputTokens: 1, signal: ctl.signal });
	assert.equal(res.text, 'done');
	assert.equal(calls[0]!.bin, '/opt/claude');
	assert.equal(calls[0]!.stdin, '<note>my note</note>');
	assert.equal(calls[0]!.signal, ctl.signal);
	ctl.abort();
	await assert.rejects(provider.generate({ systemPrompt: 'S', userPrompt: 'u', maxOutputTokens: 1, signal: ctl.signal }), /Cancelled/);
	assert.equal(calls.length, 1);

	const failing = new ClaudeCodeProvider('claude', '', async () => {
		throw new Error('Claude Code wasn\'t found at "claude".');
	});
	assert.deepEqual(await failing.testConnection(), { ok: false, message: 'Claude Code wasn\'t found at "claude".' });
});
