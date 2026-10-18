// Pure helpers with no Obsidian imports, so they can be unit-tested in Node.

export type ActionKind = 'format' | 'review' | 'enrich';

/** Study status vocabulary. `mastered` is only ever set by the user. */
export const STATUS_VALUES = ['attempted', 'reviewed', 'recalled', 'mastered'] as const;

// ---------- paths ----------

/** Make one path segment safe: no separators, traversal, reserved or link-breaking characters. */
export function sanitizeFileName(name: string, maxLength = 100): string {
	const cleaned = name
		// eslint-disable-next-line no-control-regex -- control characters are deliberately stripped from file names
		.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+/, '')
		.slice(0, maxLength)
		.replace(/[. ]+$/, '');
	return cleaned || 'Untitled';
}

/** Normalize a user-configured vault-relative folder. Throws on anything that could escape the vault. */
export function safeFolder(folder: string): string {
	const parts = folder.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p && p !== '.');
	if (parts.some((p) => p === '..' || p.includes(':'))) {
		throw new Error(`Folder "${folder}" must be a path inside the vault.`);
	}
	return parts.join('/');
}

export function isUnder(path: string, folder: string): boolean {
	return !!folder && path.startsWith(folder + '/');
}

export function notePath(folder: string, name: string): string {
	const dir = safeFolder(folder);
	return `${dir ? dir + '/' : ''}${sanitizeFileName(name)}.md`;
}

export function draftPath(folder: string, sourceName: string, label: string, date: string, version = 1): string {
	const base = sanitizeFileName(`${sourceName} - ${label} ${date}`);
	const dir = safeFolder(folder);
	return `${dir ? dir + '/' : ''}${version > 1 ? `${base} (${version})` : base}.md`;
}

// ---------- dates ----------

export function isoDate(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Returns a valid YYYY-MM-DD string or null. Never throws on junk input. */
export function parseIsoDate(v: unknown): string | null {
	if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
	if (typeof v !== 'string') return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
	if (!m) return null;
	const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
	return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? m[0] : null;
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
	return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------- revision attempts ----------

export type Outcome = (typeof STATUS_VALUES)[number];

export const MISTAKE_TYPES = [
	'pattern not recognized',
	'wrong invariant',
	'incorrect state transition',
	'boundary error',
	'complexity miscalculated',
	'edge case missed',
];

const OUTCOME_TEXT: Record<Outcome, string> = {
	attempted: "couldn't solve yet",
	reviewed: 'solved with hints',
	recalled: 'solved from memory',
	mastered: 'marked mastered',
};

// ponytail: fixed intervals with no per-problem history; move to SM-2-style ease factors if reviews bunch up.
export function reviewIntervalDays(outcome: Outcome, confidence: number): number {
	if (outcome === 'attempted') return 1;
	if (outcome === 'reviewed') return 3;
	if (outcome === 'mastered') return 60;
	return [3, 5, 7, 14, 30][Math.min(5, Math.max(1, Math.round(confidence))) - 1]!;
}

export interface Attempt {
	outcome: Outcome;
	confidence: number;
	mistakes: string[];
	note: string;
}

export function formatAttempt(date: string, a: Attempt): string {
	const mistakes = a.mistakes.length ? ` · mistakes: ${a.mistakes.join(', ')}` : '';
	const note = a.note.trim() ? ` — ${a.note.trim()}` : '';
	return `(${date}): ${OUTCOME_TEXT[a.outcome]} · confidence ${a.confidence}/5${mistakes}${note}`;
}

/**
 * Add "- Attempt N <entry>" to the note's "Revision log" section, filling the template's
 * empty "- Attempt 1:" placeholder first. Creates the section at the end if missing.
 */
export function addRevisionLogEntry(md: string, entry: string): string {
	const lines = md.split('\n');
	const sec = findSection(lines, /^#{1,6}\s+(\d+\.\s*)?revision log\b/i);
	if (!sec) return `${md.trimEnd()}\n\n## Revision log\n- Attempt 1 ${entry}\n`;
	const section = lines.slice(sec.h + 1, sec.end);
	const placeholder = section.findIndex((l) => /^\s*- Attempt \d+:?\s*$/.test(l));
	if (placeholder >= 0) {
		lines[sec.h + 1 + placeholder] = `- Attempt ${/\d+/.exec(section[placeholder]!)![0]} ${entry}`;
		return lines.join('\n');
	}
	const n = section.filter((l) => /^\s*- Attempt \d+/.test(l)).length + 1;
	let at = sec.end;
	while (at > sec.h + 1 && !lines[at - 1]!.trim()) at--;
	lines.splice(at, 0, `- Attempt ${n} ${entry}`);
	return lines.join('\n');
}

/** Heading level of each line (0 if not a heading). Lines inside fenced code never count. */
export function headingLevels(lines: string[]): number[] {
	let fence = '';
	return lines.map((l) => {
		const f = /^(`{3,}|~{3,})/.exec(l)?.[1];
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length && !l.slice(f.length).trim()) fence = '';
			return 0;
		}
		if (f) {
			fence = f;
			return 0;
		}
		return /^(#{1,6})\s/.exec(l)?.[1]!.length ?? 0;
	});
}

/** First section whose heading line matches `re`: heading index and exclusive end (next heading of same or higher level). */
export function findSection(lines: string[], re: RegExp): { h: number; end: number } | null {
	const levels = headingLevels(lines);
	const h = lines.findIndex((l, i) => levels[i]! > 0 && re.test(l));
	if (h < 0) return null;
	const end = levels.findIndex((lv, i) => i > h && lv > 0 && lv <= levels[h]!);
	return { h, end: end < 0 ? lines.length : end };
}

/** Insert `block` at the end of the first section matching `re`, or append it under a new "## fallback" heading. */
export function appendToSection(md: string, re: RegExp, block: string, fallbackHeading: string): string {
	const lines = md.split('\n');
	const sec = findSection(lines, re);
	if (!sec) return `${md.trimEnd()}\n\n## ${fallbackHeading}\n\n${block}\n`;
	let at = sec.end;
	while (at > sec.h + 1 && !lines[at - 1]!.trim()) at--;
	const insert = ['', block];
	if (at < lines.length && lines[at]!.trim()) insert.push('');
	lines.splice(at, 0, ...insert);
	return lines.join('\n');
}

// ---------- markdown ----------

export interface CodeBlock {
	lang: string;
	code: string;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w+#-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

export function extractCodeBlocks(md: string): CodeBlock[] {
	return [...md.replace(/\r\n/g, '\n').matchAll(FENCE)].map((m) => ({
		lang: (m[2] ?? '').toLowerCase(),
		code: m[3] ?? '',
	}));
}

const normCode = (s: string) => s.split('\n').map((l) => l.trimEnd()).join('\n').trim();

/** Whether `code` already appears as a fenced block in `md` (ignoring trailing whitespace). */
export function containsCode(md: string, code: string): boolean {
	const want = normCode(code);
	return !!want && extractCodeBlocks(md).some((b) => normCode(b.code) === want);
}

/** Code blocks from `original` that do not appear verbatim (modulo trailing whitespace) in `output`. */
export function missingCodeBlocks(original: string, output: string): CodeBlock[] {
	const kept = new Set(extractCodeBlocks(output).map((b) => normCode(b.code)));
	return extractCodeBlocks(original).filter((b) => normCode(b.code) && !kept.has(normCode(b.code)));
}

export function looksLikeLeetCode(content: string, fm: Record<string, unknown>): boolean {
	return fm.type === 'leetcode' || /leetcode|```java/i.test(content);
}

export function isTopicNote(fm: Record<string, unknown>): boolean {
	return typeof fm.type === 'string' && /pattern|topic/i.test(fm.type);
}

/**
 * Turn [[links]] whose target doesn't exist into plain text. Code spans and fenced
 * blocks are left alone (LeetCode inputs like [[1,2]] live there).
 */
export function verifyWikiLinks(md: string, exists: (target: string) => boolean): { text: string; unresolved: string[] } {
	const unresolved = new Set<string>();
	const re = /(^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\2[ \t]*$)|(`[^`\n]*`)|!?\[\[([^\]\n]+?)\]\]/gm;
	const text = md.replace(re, (whole, fenced, _f, inline, inner: string | undefined) => {
		if (fenced || inline || !inner) return whole;
		const [targetPart = '', alias] = inner.split('|');
		const target = targetPart.split('#')[0]!.trim();
		if (!target || exists(target)) return whole;
		unresolved.add(target);
		return `${alias?.trim() || target} (unverified link)`;
	});
	return { text, unresolved: [...unresolved] };
}

/** Content that some community plugins would execute when the note is rendered. */
export function executableContentWarnings(md: string): string[] {
	const checks: [RegExp, string][] = [
		[/^[`~]{3,}\s*dataviewjs/im, 'a dataviewjs block'],
		[/<script\b/i, 'a <script> tag'],
		[/<%[\s\S]*?%>/, 'a Templater command'],
	];
	return checks.filter(([re]) => re.test(md)).map(([, what]) => `Output contains ${what}. Review it before opening the draft.`);
}

export interface Validated {
	text: string;
	errors: string[];
	warnings: string[];
}

export function validateOutput(raw: string, requiredHeadings: string[] = [], maxChars = 200_000): Validated {
	let text = raw.replace(/\r\n/g, '\n').trim();
	// Models sometimes wrap the whole answer in ```markdown … ```.
	// A bare ``` wrapper is only stripped when nothing inside it is fenced.
	const wrapped = /^```(markdown|md)?[ \t]*\n([\s\S]*)\n```$/.exec(text);
	if (wrapped && (wrapped[1] || !wrapped[2]!.includes('```'))) text = wrapped[2]!.trim();
	const errors: string[] = [];
	if (!text) errors.push('The AI returned an empty response.');
	if (text.length > maxChars) errors.push(`The AI response is too large (${text.length} characters).`);
	const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).join('\n').toLowerCase();
	const missing = requiredHeadings.filter((h) => !headings.includes(h.toLowerCase()));
	const warnings = missing.length ? [`Missing expected sections: ${missing.join(', ')}.`] : [];
	return { text, errors, warnings };
}

// ---------- secrets ----------

export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
	let out = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
	for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('***');
	return out;
}

// ---------- frontmatter ----------

export function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').map(String);
	return typeof v === 'string' && v.trim() ? [v] : [];
}

/** Comparable form of a tag, pattern name or [[link]]: "[[03 Patterns/Sliding Window|sw]]" → "sliding-window". */
export function tagKey(x: string): string {
	const inner = x.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0]!.split('#')[0]!;
	const name = inner.split('/').pop()!.replace(/\.md$/i, '');
	return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

/** Existing list values plus any `add` values not already present (compared by tagKey). */
export function mergeUnique(existing: unknown, add: string[]): string[] {
	const out = asStringArray(existing);
	const seen = new Set(out.map(tagKey));
	for (const a of add) {
		if (!seen.has(tagKey(a))) out.push(a);
		seen.add(tagKey(a));
	}
	return out;
}

export interface PatternChoice {
	name: string;
	reason: string;
}

/**
 * Validate the model's JSON pattern suggestions. Names that match `known` (pattern notes in
 * the vault) come back canonicalized in `matched`; anything else goes to `proposed`.
 * Patterns the note already has are dropped. Throws if the text is not the expected JSON.
 */
export function parsePatternSuggestions(text: string, known: string[], existing: string[]): { matched: PatternChoice[]; proposed: PatternChoice[] } {
	const json: unknown = JSON.parse(text);
	if (!json || typeof json !== 'object') throw new Error('Expected a JSON object.');
	const byKey = new Map(known.map((k) => [tagKey(k), k]));
	const seen = new Set(existing.map(tagKey));
	const matched: PatternChoice[] = [];
	const proposed: PatternChoice[] = [];
	const obj = json as Record<string, unknown>;
	for (const item of [...asArray(obj.patterns), ...asArray(obj.new_patterns)]) {
		if (!item || typeof item !== 'object') continue;
		const { name, reason } = item as Record<string, unknown>;
		if (typeof name !== 'string') continue;
		const key = tagKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const r = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
		const canonical = byKey.get(key);
		if (canonical) matched.push({ name: canonical, reason: r });
		else proposed.push({ name: sanitizeFileName(name, 60), reason: r });
	}
	return { matched, proposed };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Copy keys from `source` that `target` lacks. Never overwrites, and never lets AI claim progress. */
export function mergeMissingKeys(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(source)) {
		if (k in target) continue;
		if (k === 'status' && (v === 'recalled' || v === 'mastered')) continue;
		if (k === 'ai_reviewed') continue;
		target[k] = v;
	}
}

// ---------- revision queue ----------

export interface ProblemNote {
	path: string;
	name: string;
	fm: Record<string, unknown>;
}

export interface QueueItem {
	path: string;
	name: string;
	score: number;
	reasons: string[];
}

export interface RevisionPlan {
	items: QueueItem[];
	dueCount: number;
	weakPatterns: { pattern: string; count: number; avgConfidence: number }[];
	repeatedMistakes: [string, number][];
	dataIssues: string[];
}

// ponytail: fixed weights, make them settings if users want to tune the queue.
export function planRevision(notes: ProblemNote[], today: string, limit = 10): RevisionPlan {
	const dataIssues: string[] = [];
	const mistakeCounts = new Map<string, number>();
	const patternStats = new Map<string, { count: number; total: number }>();

	const parsed = notes.map((n) => {
		const rawStatus = n.fm.status;
		let status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : 'attempted';
		if (!(STATUS_VALUES as readonly string[]).includes(status)) {
			dataIssues.push(`${n.path}: unknown status ${JSON.stringify(rawStatus)} (treated as attempted)`);
			status = 'attempted';
		}
		let confidence = 1;
		if (n.fm.confidence != null && n.fm.confidence !== '') {
			const c = Number(n.fm.confidence);
			if (Number.isInteger(c) && c >= 1 && c <= 5) confidence = c;
			else dataIssues.push(`${n.path}: confidence ${JSON.stringify(n.fm.confidence)} is not 1–5 (treated as 1)`);
		}
		const next = parseIsoDate(n.fm.next_review);
		if (n.fm.next_review != null && n.fm.next_review !== '' && !next) {
			dataIssues.push(`${n.path}: next_review ${JSON.stringify(n.fm.next_review)} is not a YYYY-MM-DD date`);
		}
		const mistakes = asStringArray(n.fm.mistake_types).map((m) => m.trim().toLowerCase());
		const patterns = asStringArray(n.fm.patterns).map((p) => p.trim().toLowerCase());
		for (const m of new Set(mistakes)) mistakeCounts.set(m, (mistakeCounts.get(m) ?? 0) + 1);
		for (const p of new Set(patterns)) {
			const s = patternStats.get(p) ?? { count: 0, total: 0 };
			s.count++;
			s.total += confidence;
			patternStats.set(p, s);
		}
		return { ...n, status, confidence, next, mistakes, patterns };
	});

	const weakPatterns = [...patternStats]
		.map(([pattern, s]) => ({ pattern, count: s.count, avgConfidence: Math.round((s.total / s.count) * 10) / 10 }))
		.filter((p) => p.count < 3 || p.avgConfidence < 3)
		.sort((a, b) => a.avgConfidence - b.avgConfidence || a.count - b.count);
	const weak = new Set(weakPatterns.map((p) => p.pattern));

	let dueCount = 0;
	const items: QueueItem[] = [];
	for (const n of parsed) {
		const overdue = n.next ? daysBetween(n.next, today) : null;
		const due = overdue != null && overdue >= 0;
		if (due) dueCount++;
		if (n.status === 'mastered' && !due) continue;

		let score = 0;
		const reasons: string[] = [];
		if (due) {
			score += 50 + Math.min(overdue, 30) * 2;
			reasons.push(overdue === 0 ? 'due today' : `overdue by ${overdue} day${overdue === 1 ? '' : 's'}`);
		} else if (overdue != null) {
			score -= 20; // scheduled for later
		} else if (n.status !== 'mastered') {
			score += 5;
			reasons.push('no review date');
		}
		score += (5 - n.confidence) * 8;
		if (n.confidence <= 2) reasons.push(`confidence ${n.confidence}/5`);
		if (n.status === 'attempted' || n.status === 'reviewed') {
			score += 10;
			reasons.push(`status: ${n.status} (not yet recalled independently)`);
		}
		for (const m of n.mistakes) {
			if ((mistakeCounts.get(m) ?? 0) >= 2) {
				score += 5;
				reasons.push(`repeated mistake: ${m}`);
			}
		}
		const weakHere = n.patterns.filter((p) => weak.has(p));
		if (weakHere.length) {
			score += 5;
			reasons.push(`weak pattern: ${weakHere.join(', ')}`);
		}
		if (score > 0) items.push({ path: n.path, name: n.name, score, reasons });
	}
	items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

	const repeatedMistakes = [...mistakeCounts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
	return { items: items.slice(0, limit), dueCount, weakPatterns, repeatedMistakes, dataIssues };
}

export function renderRevisionReport(plan: RevisionPlan, today: string): string {
	const link = (path: string, name: string) => `[[${path.replace(/\.md$/, '')}|${name}]]`;
	const lines = [
		'---',
		'type: dsa-revision-queue',
		`generated: ${today}`,
		'---',
		'',
		`# Revision queue — ${today}`,
		'',
		`> Built from your notes' frontmatter (no AI). Due or overdue: ${plan.dueCount}.`,
		'',
		"## Today's queue",
		'',
		...plan.items.map((it, i) => `${i + 1}. ${link(it.path, it.name)} — ${it.reasons.join('; ') || 'low priority'}`),
	];
	if (plan.weakPatterns.length) {
		lines.push('', '## Patterns needing practice', '');
		for (const p of plan.weakPatterns) {
			lines.push(`- ${p.pattern} — ${p.count} problem${p.count === 1 ? '' : 's'}, avg confidence ${p.avgConfidence}`);
		}
	}
	if (plan.repeatedMistakes.length) {
		lines.push('', '## Repeated mistakes', '');
		for (const [m, c] of plan.repeatedMistakes) lines.push(`- ${m} ×${c}`);
	}
	if (plan.dataIssues.length) {
		lines.push('', '## Metadata issues', '');
		for (const d of plan.dataIssues) lines.push(`- ${d}`);
	}
	return lines.join('\n') + '\n';
}
