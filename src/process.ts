// Runs a local program for the Claude Code provider. Desktop only: Node's child_process
// doesn't exist on mobile, so it is loaded lazily behind a Platform check.
import { Platform } from 'obsidian';
import type { ProcessResult, Runner } from './claude-code';
import { AiError } from './provider';

const TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 5_000_000;

/** The real Runner, using Node's child_process. Desktop only. */
export const runProcess: Runner = async (bin, args, stdin, signal) => {
	if (!Platform.isDesktop) throw new AiError('Claude Code is only available on desktop.');
	const { spawn } = await import('child_process');
	const { tmpdir } = await import('os');
	const { env: parentEnv } = await import('process');
	const env = { ...parentEnv };
	delete env.CLAUDECODE; // in case Obsidian was started from inside a Claude Code session
	return new Promise<ProcessResult>((resolve, reject) => {
		// A neutral working directory, so no project files or settings are picked up.
		const child = spawn(bin, args, { cwd: tmpdir(), env, shell: false, windowsHide: true });
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn();
		};
		const stop = (message: string) => finish(() => {
			child.kill();
			reject(new AiError(message));
		});
		const onAbort = () => stop('Cancelled.');
		const timer = window.setTimeout(() => stop('Claude Code timed out.'), TIMEOUT_MS);
		signal?.addEventListener('abort', onAbort, { once: true });

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (d: string) => {
			stdout += d;
			if (stdout.length > MAX_OUTPUT) stop('Claude Code produced too much output.');
		});
		child.stderr.on('data', (d: string) => {
			stderr = (stderr + d).slice(-20_000);
		});
		child.on('error', (e: Error & { code?: string }) =>
			finish(() =>
				reject(
					new AiError(
						e.code === 'ENOENT'
							? `Claude Code wasn't found at "${bin}". Install it, or set its full path in settings (run "which claude" or "where claude" in a terminal to find it).`
							: `Couldn't start Claude Code: ${e.message}`,
					),
				),
			),
		);
		child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
		child.stdin.on('error', () => {}); // the process may exit before reading all input
		child.stdin.end(stdin);
	});
};
