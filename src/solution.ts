// "New LeetCode solution": parse the AI's JSON and assemble the note. The user's code is
// inserted by this module, never by the model, so it is stored exactly as pasted.
import { asStringArray, extractCodeBlocks, headingLevels, tagKey } from './core';

export const LANGUAGES = ['java', 'python', 'cpp', 'c', 'csharp', 'javascript', 'typescript', 'go', 'kotlin', 'rust', 'swift'];

/** Matches "## Solutions", "## Solution", "## 5. Java solution" — not "### Solution 2: …". */
export const SOLUTIONS_HEADING = /^#{1,6}\s+(\d+\.\s*)?([\w+#]+\s+)?solutions?\s*$/i;

export interface SolutionInput {
	url: string;
	language: string;
	code: string;
	question: string;
}

export interface LeetCodeLink {
	slug: string;
	url: string;
}

/** "https://leetcode.com/problems/two-sum/description/?x=1" or "two-sum" → slug + canonical URL. */
export function parseLeetCodeLink(input: string): LeetCodeLink | null {
	const t = input.trim();
	const m = /^(?:https?:\/\/)?(?:www\.)?leetcode\.(com|cn)\/problems\/([a-z0-9-]+)/i.exec(t);
	if (m) return { slug: m[2]!.toLowerCase(), url: `https://leetcode.${m[1]!.toLowerCase()}/problems/${m[2]!.toLowerCase()}/` };
	if (/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(t)) return { slug: t.toLowerCase(), url: `https://leetcode.com/problems/${t.toLowerCase()}/` };
	return null;
}

const slugTitle = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// ---------- AI output ----------

export interface Choice {
	name: string;
	reason: string;
}

export interface Alternative {
	name: string;
	intuition: string;
	time: string;
	space: string;
}

export interface NewSolutionData {
	title: string;
	problemId: string;
	difficulty: string;
	question: string;
	topics: Choice[];
	patterns: string[];
	intuition: string;
	methodName: string;
	howItWorks: string;
	time: string;
	space: string;
	alternatives: Alternative[];
}

export interface AddedSolutionData {
	methodName: string;
	howItWorks: string;
	time: string;
	space: string;
	compared: string;
	sameApproach: boolean;
	topics: Choice[];
	patterns: string[];
}

const str = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const items = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const choices = (v: unknown): Choice[] =>
	items(v)
		.map((x) => ({ name: oneLine(str(x.name, 60)), reason: oneLine(str(x.reason, 300)) }))
		.filter((c) => c.name);

function object(text: string): Record<string, unknown> {
	const j: unknown = JSON.parse(text);
	if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Expected a JSON object.');
	return j as Record<string, unknown>;
}

/** Keep only patterns that exist in the vault, canonically spelled. */
function grounded(v: unknown, known: string[]): string[] {
	const byKey = new Map(known.map((k) => [tagKey(k), k]));
	return [...new Set(asStringArray(v).map((p) => byKey.get(tagKey(p))).filter((x): x is string => !!x))];
}

export function parseNewSolution(text: string, knownPatterns: string[]): NewSolutionData {
	const j = object(text);
	const d: NewSolutionData = {
		title: oneLine(str(j.title, 150)),
		problemId: /^\d{1,5}$/.test(str(j.problem_id)) ? str(j.problem_id) : '',
		difficulty: ['Easy', 'Medium', 'Hard'].includes(str(j.difficulty)) ? str(j.difficulty) : '',
		question: str(j.question),
		topics: choices(j.topics),
		patterns: grounded(j.patterns, knownPatterns),
		intuition: str(j.intuition),
		methodName: oneLine(str(j.method_name, 80)),
		howItWorks: str(j.how_it_works),
		time: oneLine(str(j.time, 200)),
		space: oneLine(str(j.space, 200)),
		alternatives: items(j.alternatives)
			.map((a) => ({ name: oneLine(str(a.name, 80)), intuition: str(a.intuition), time: oneLine(str(a.time, 200)), space: oneLine(str(a.space, 200)) }))
			.filter((a) => a.name && a.intuition),
	};
	if (!d.intuition || !d.howItWorks) throw new Error('the explanation is missing.');
	return d;
}

export function parseAddedSolution(text: string, knownPatterns: string[]): AddedSolutionData {
	const j = object(text);
	const d: AddedSolutionData = {
		methodName: oneLine(str(j.method_name, 80)),
		howItWorks: str(j.how_it_works),
		time: oneLine(str(j.time, 200)),
		space: oneLine(str(j.space, 200)),
		compared: str(j.compared),
		sameApproach: j.same_approach === true,
		topics: choices(j.topics),
		patterns: grounded(j.patterns, knownPatterns),
	};
	if (!d.howItWorks) throw new Error('the explanation is missing.');
	return d;
}

// ---------- note assembly ----------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A backtick fence longer than any run inside the code, so pasted code can't close it early. */
export function fenceFor(code: string): string {
	const runs = code.match(/`{3,}/g) ?? [];
	return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

/** Turn #, ##, ### headings in AI text into ####, so they can't break the note's sections. Code is left alone. */
export function demoteHeadings(md: string): string {
	const lines = md.split('\n');
	const levels = headingLevels(lines);
	return lines.map((l, i) => (levels[i]! > 0 && levels[i]! < 4 ? l.replace(/^#{1,3}/, '####') : l)).join('\n');
}

/** Next solution number: one past the highest "### Solution N", or 2 if the note only has an unnumbered solution. */
export function nextSolutionNumber(md: string): number {
	const lines = md.split('\n');
	const levels = headingLevels(lines);
	const nums = lines.filter((l, i) => levels[i]! > 0).map((l) => /^#+\s+Solution\s+(\d+)/i.exec(l)?.[1]).filter(Boolean).map(Number);
	if (nums.length) return Math.max(...nums) + 1;
	return extractCodeBlocks(md).length ? 2 : 1;
}

export interface BlockInput {
	n: number;
	method: string;
	date: string;
	language: string;
	code: string;
	howItWorks: string;
	time: string;
	space: string;
	compared?: string;
}

export function solutionBlock(o: BlockInput): string {
	const fence = fenceFor(o.code);
	const lines = [
		`### Solution ${o.n}: ${o.method || 'My approach'} (mine, ${o.date})`,
		'',
		`${fence}${o.language}`,
		o.code.replace(/\s+$/, ''),
		fence,
		'',
		'**How it works**',
		'',
		demoteHeadings(o.howItWorks),
		'',
		`**Complexity:** time ${o.time || '[verify]'}; space ${o.space || '[verify]'}.`,
	];
	if (o.compared) lines.push('', '**Compared with earlier solutions**', '', demoteHeadings(o.compared));
	return lines.join('\n');
}

export interface NoteInput {
	data: NewSolutionData;
	link: LeetCodeLink;
	input: SolutionInput;
	date: string;
	model: string;
	promptVersion: number;
	/** Frontmatter-ready links to the pattern notes in `data.patterns`, e.g. "[[Sliding Window]]". */
	patternLinks: string[];
}

export function noteTitle(data: NewSolutionData, link: LeetCodeLink): string {
	return data.title || slugTitle(link.slug);
}

export function buildProblemNote({ data, link, input, date, model, promptVersion, patternLinks }: NoteInput): string {
	const title = noteTitle(data, link);
	const frontmatter = [
		'---',
		'type: leetcode',
		...(data.problemId ? [`problem_id: ${data.problemId}`] : []),
		...(data.difficulty ? [`difficulty: ${data.difficulty}`] : []),
		`leetcode_url: ${JSON.stringify(link.url)}`,
		`problem_slug: ${link.slug}`,
		`topics: ${JSON.stringify(data.topics.map((t) => t.name))}`,
		`patterns: ${JSON.stringify(patternLinks)}`,
		'status: attempted',
		`language: ${input.language}`,
		`date_solved: ${date}`,
		'mistake_types: []',
		'---',
	];
	const topicLines = data.topics.map((t) => `- **${t.name}**${t.reason ? `: ${t.reason}` : ''}`);
	if (patternLinks.length) topicLines.push(`- Patterns: ${patternLinks.join(', ')}`);
	const alternatives = data.alternatives.length
		? data.alternatives.flatMap((a) => [
				`### ${a.name}`,
				'',
				demoteHeadings(a.intuition),
				'',
				`**Complexity:** time ${a.time || '[verify]'}; space ${a.space || '[verify]'}.`,
				'',
			])
		: ['None suggested.', ''];

	return [
		...frontmatter,
		'',
		`# ${data.problemId ? `${data.problemId}. ` : ''}${title}`,
		'',
		`[Open on LeetCode](${link.url})`,
		'',
		`> [!info] Generated by DSA Vault Agent · ${date} · ${model} · prompt v${promptVersion}`,
		'> Your code is stored exactly as you pasted it. The explanations are AI-written: [verify] marks claims to check, and nothing was compiled or run.',
		'',
		'## Question',
		'',
		demoteHeadings(data.question || '[verify] No problem statement available.'),
		'',
		'## Topics used',
		'',
		...(topicLines.length ? topicLines : ['- [verify] None identified.']),
		'',
		'## Intuition',
		'',
		demoteHeadings(data.intuition),
		'',
		'## Solutions',
		'',
		solutionBlock({ n: 1, method: data.methodName, date, language: input.language, code: input.code, howItWorks: data.howItWorks, time: data.time, space: data.space }),
		'',
		'## Other ways to solve it',
		'',
		...alternatives,
		'## Revision log',
		'- Attempt 1:',
		'',
	].join('\n');
}
