import { MarkdownView, Notice, Plugin, TFile, getFrontMatterInfo, normalizePath, parseYaml, requestUrl } from 'obsidian';
import {
	ActionKind,
	addDays,
	addRevisionLogEntry,
	appendToSection,
	asStringArray,
	containsCode,
	draftPath,
	executableContentWarnings,
	extractCodeBlocks,
	formatAttempt,
	isTopicNote,
	isUnder,
	isoDate,
	looksLikeLeetCode,
	mergeMissingKeys,
	mergeUnique,
	missingCodeBlocks,
	notePath,
	parsePatternSuggestions,
	planRevision,
	redact,
	renderRevisionReport,
	reviewIntervalDays,
	tagKey,
	validateOutput,
	verifyWikiLinks,
} from './core';
import {
	ADD_SOLUTION_SCHEMA,
	LINK_SCHEMA,
	NEW_SOLUTION_SCHEMA,
	PROMPT_VERSION,
	REQUIRED_HEADINGS,
	TOPIC_HEADINGS,
	buildAddSolutionPrompt,
	buildLinkPrompt,
	buildNewSolutionPrompt,
	buildPrompt,
	buildTopicPrompt,
} from './prompts';
import { AiProvider, AiResponse, AnthropicProvider } from './provider';
import { DEFAULT_SETTINGS, DsaSettingTab, DsaVaultAgentSettings } from './settings';
import {
	LeetCodeLink,
	SOLUTIONS_HEADING,
	SolutionInput,
	buildProblemNote,
	nextSolutionNumber,
	noteTitle,
	parseAddedSolution,
	parseLeetCodeLink,
	parseNewSolution,
	solutionBlock,
} from './solution';
import { PreviewAction, PreviewModal, askText, attemptForm, choose, confirm, pickPatterns, solutionForm } from './ui';

const TITLES: Record<ActionKind, string> = {
	format: 'Format LeetCode note',
	review: 'Review Java solution',
	enrich: 'Enrich topic note',
};
const LABELS: Record<ActionKind, string> = { format: 'formatted', review: 'review', enrich: 'enrichment' };
const HEADER_NOTES: Record<ActionKind, string> = {
	format: 'Text starting with [AI] was written by the AI; [verify] marks claims to check. Your original note is unchanged.',
	review: 'A study aid, not proof of correctness. No code was compiled or run.',
	enrich: 'AI suggestions; [verify] marks claims to check. Your original note is unchanged.',
};
const CONFLICT = 'The source note changed while the AI was working. Re-run the command to use the latest version.';

const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
const fail = (msg: string): null => {
	new Notice(msg);
	return null;
};

type Frontmatter = Record<string, unknown>;
type PatternNote = { name: string; file: TFile; field: 'patterns' | 'topics' };

export default class DsaVaultAgent extends Plugin {
	settings!: DsaVaultAgentSettings;
	private busy = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new DsaSettingTab(this.app, this));

		const add = (id: string, name: string, run: () => Promise<unknown>) =>
			this.addCommand({ id, name, callback: () => void run().catch((e) => new Notice(`DSA Vault Agent: ${errMsg(e)}`)) });
		add('format-current-note', 'Format current LeetCode note', () => this.runAction('format'));
		add('review-java-solution', 'Review current Java solution', () => this.runAction('review'));
		add('enrich-topic-note', 'Enrich current topic note', () => this.runAction('enrich'));
		add('new-leetcode-solution', 'New LeetCode solution', () => this.newSolution());
		add('new-topic-note', 'New topic note', () => this.newTopicNote());
		add('link-patterns', 'Link current problem to patterns', () => this.linkPatterns());
		add('log-attempt', 'Log revision attempt', () => this.logAttempt());
		add('generate-revision-queue', 'Generate revision queue', () => this.revisionQueue());
		add('process-current-note', 'Process current note', () => this.processCurrent());
		add('test-ai-connection', 'Test AI connection', async () => new Notice((await this.provider().testConnection()).message));
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<DsaVaultAgentSettings>) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	provider(): AiProvider {
		const id = this.settings.apiKeySecret;
		const key = id ? this.app.secretStorage.getSecret(id) : null;
		return new AnthropicProvider(key ?? '', this.settings.model.trim(), requestUrl);
	}

	/** Runs the action named by `ai_action` in frontmatter, else the default for the note type. */
	private processCurrent(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const fm: Frontmatter = (file && this.app.metadataCache.getFileCache(file)?.frontmatter) || {};
		const requested = typeof fm.ai_action === 'string' ? fm.ai_action.toLowerCase() : '';
		const kind: ActionKind =
			requested === 'format' || requested === 'review' || requested === 'enrich'
				? requested
				: isTopicNote(fm) ? 'enrich' : 'format';
		return this.runAction(kind);
	}

	// ---------- format / review / enrich ----------

	private async runAction(kind: ActionKind): Promise<void> {
		const s = this.settings;
		const note = await this.activeNote();
		if (!note) return;
		const { file, content: original, fm } = note;

		if (kind === 'review' && !extractCodeBlocks(original).some((b) => b.lang === 'java')) {
			return void new Notice('No Java code block found in this note.');
		}
		if (kind === 'format' && !looksLikeLeetCode(original, fm)) {
			const ok = await confirm(this.app, 'Not a LeetCode note?', 'This note has no "type: leetcode", LeetCode mention or Java code. Format it anyway?');
			if (!ok) return;
		}
		if (kind === 'enrich' && !isTopicNote(fm)) {
			const ok = await confirm(this.app, 'Not a topic note?', 'This note is not marked "type: dsa-pattern". Enrich it anyway?');
			if (!ok) return;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selection = view?.file === file ? view.editor.getSelection() : '';
		const vaultNotes = s.includeRelatedNotes
			? this.relatedNotes([file.basename, ...asStringArray(fm.patterns), ...asStringArray(fm.topics)], file)
			: [];
		const prompt = buildPrompt(kind, { path: file.path, content: original, selection, vaultNotes });
		const res = await this.ask(file.path, `${TITLES[kind]}: sending "${file.basename}" and ${vaultNotes.length} related note names`, prompt);
		if (!res) return;

		if (kind === 'enrich' && res.text.trim() === 'NO_ADDITIONS') return void new Notice('The AI found nothing to add to this note.');
		const out = this.checkOutput(res, REQUIRED_HEADINGS[kind], file.path);
		if (!out) return;
		const { text, warnings } = out;
		const lostCode = kind === 'format' ? missingCodeBlocks(original, text) : [];
		if (lostCode.length) warnings.push(`${lostCode.length} original code block(s) are not preserved verbatim, so "Replace note" is disabled.`);
		if ((await this.app.vault.read(file)) !== original) {
			warnings.unshift('The source note changed while the request was running. Review the output before applying.');
		}

		const model = res.model ?? s.model;
		const date = isoDate();
		const pathFor = (n: number) => draftPath(s.draftFolder, file.basename, LABELS[kind], date, n);
		const sourceLink = this.app.fileManager.generateMarkdownLink(file, pathFor(1));
		const draft = withHeader(
			text,
			`> [!info] AI ${LABELS[kind]} draft of ${sourceLink}\n> ${date} · ${model} · prompt v${PROMPT_VERSION}. ${HEADER_NOTES[kind]}`,
		);

		const actions: PreviewAction[] = [
			{
				label: kind === 'review' ? 'Create review report' : 'Create draft',
				cta: true,
				run: () => this.createAndOpen(pathFor, draft),
			},
		];
		if (kind === 'format') {
			actions.push({
				label: 'Replace note…',
				destructive: true,
				disabledReason: lostCode.length ? 'The output does not preserve your original code.' : undefined,
				run: () => this.replaceNote(file, original, text),
			});
		}
		if (kind === 'enrich') actions.push({ label: 'Append to note', run: () => this.appendToNote(file, original, text, model) });

		const where = s.draftFolder || 'the vault root';
		new PreviewModal(this.app, {
			title: TITLES[kind],
			details: [
				['Source', file.path],
				[
					'Effect',
					kind === 'review'
						? `Creates a report in ${where}. The note is not changed.`
						: `Creates a draft in ${where}. The note changes only if you choose "${kind === 'format' ? 'Replace note' : 'Append to note'}".`,
				],
				...this.responseDetails(res),
			],
			warnings,
			content: text,
			actions,
		}).open();
	}

	private async replaceNote(file: TFile, original: string, aiText: string): Promise<boolean> {
		const ok = await confirm(
			this.app,
			'Replace the whole note?',
			`"${file.path}" will be replaced by the AI version. Your frontmatter values are kept and a backup is saved to the draft folder first.`,
			'Replace',
		);
		if (!ok) return false;
		if ((await this.app.vault.read(file)) !== original) throw new Error(CONFLICT);

		const backup = await this.createFile(
			(n) => draftPath(`${this.settings.draftFolder}/Backups`, file.basename, 'backup', isoDate(), n),
			original,
			'version',
		);
		const ai = getFrontMatterInfo(aiText);
		const body = aiText.slice(ai.contentStart).replace(/^\n+/, '');
		const keptFrontmatter = original.slice(0, getFrontMatterInfo(original).contentStart);
		let conflict = false;
		await this.app.vault.process(file, (data) => {
			if (data !== original) {
				conflict = true;
				return data;
			}
			return keptFrontmatter + body;
		});
		if (conflict) throw new Error(CONFLICT);

		if (ai.exists) {
			let aiFm: unknown = null;
			try {
				aiFm = parseYaml(ai.frontmatter);
			} catch {
				// handled below
			}
			if (aiFm && typeof aiFm === 'object' && !Array.isArray(aiFm)) {
				await this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => mergeMissingKeys(fm, aiFm as Frontmatter));
			} else {
				new Notice('The AI frontmatter was not valid YAML; kept your existing frontmatter only.');
			}
		}
		new Notice(`Replaced ${file.path}. Backup: ${backup?.path}`);
		return true;
	}

	private async appendToNote(file: TFile, original: string, aiText: string, model: string): Promise<void> {
		const body = aiText.slice(getFrontMatterInfo(aiText).contentStart).trim();
		const block = `\n\n## AI additions (${isoDate()})\n\n> [!info] Added by DSA Vault Agent (${model}). [verify] marks claims to check.\n\n${body}\n`;
		let conflict = false;
		await this.app.vault.process(file, (data) => {
			if (data !== original) {
				conflict = true;
				return data;
			}
			return data.trimEnd() + block;
		});
		if (conflict) throw new Error(CONFLICT);
		new Notice(`Appended AI additions to ${file.path}.`);
	}

	// ---------- new topic note ----------

	private async newTopicNote(): Promise<void> {
		const s = this.settings;
		const topic = await askText(this.app, 'New topic note', 'Topic or pattern, e.g. Sliding Window', 'Generate');
		if (!topic) return;
		const path = normalizePath(notePath(s.patternsFolder, topic));

		// Also catch spelling variants ("sliding-window" vs "Sliding Window") to avoid duplicate topic notes.
		const existing =
			this.app.vault.getFileByPath(path) ??
			this.app.metadataCache.getFirstLinkpathDest(topic, '') ??
			this.patternNotes().find((p) => tagKey(p.name) === tagKey(topic))?.file;
		if (existing) {
			const choice = await choose(this.app, 'Note already exists', `"${existing.path}" already exists.`, ['Enrich it instead']);
			if (!choice) return;
			await this.app.workspace.getLeaf(false).openFile(existing);
			return this.runAction('enrich');
		}

		const vaultNotes = s.includeRelatedNotes ? this.relatedNotes([topic]) : [];
		const res = await this.ask(`topic:${tagKey(topic)}`, `New topic note: sending "${topic}" and ${vaultNotes.length} related note names`, buildTopicPrompt(topic, vaultNotes));
		if (!res) return;
		const out = this.checkOutput(res, TOPIC_HEADINGS, path);
		if (!out) return;

		const header = `> [!info] AI-generated starting point (${isoDate()} · ${res.model ?? s.model} · prompt v${PROMPT_VERSION}). Check it and rewrite it in your own words; [verify] marks claims to check.`;
		new PreviewModal(this.app, {
			title: 'New topic note',
			details: [['Topic', topic], ['Effect', `Creates ${path}.`], ...this.responseDetails(res)],
			warnings: out.warnings,
			content: out.text,
			actions: [
				{
					label: 'Create note',
					cta: true,
					run: () =>
						this.createAndOpen((n) => (n === 1 ? path : path.replace(/\.md$/, ` (${n}).md`)), withHeader(out.text, header), async (f) => {
							// The AI never decides progress: a new topic always starts at "learning".
							await this.app.fileManager.processFrontMatter(f, (fm: Frontmatter) => {
								fm.type = 'dsa-pattern';
								fm.status = 'learning';
								fm.confidence = 1;
							});
						}),
				},
			],
		}).open();
	}

	// ---------- link problem to patterns ----------

	private async linkPatterns(): Promise<void> {
		const note = await this.activeNote();
		if (!note) return;
		const { file, content, fm } = note;
		if (isTopicNote(fm)) return void new Notice('This is a pattern/topic note. Run this on a problem note.');

		const vocab = this.patternNotes();
		const existing = [...asStringArray(fm.patterns), ...asStringArray(fm.topics)];
		const res = await this.ask(
			file.path,
			`Link to patterns: sending "${file.basename}" and ${vocab.length} pattern names`,
			buildLinkPrompt(file.path, content, vocab.map((v) => v.name)),
			LINK_SCHEMA,
		);
		if (!res) return;

		const suggestions = this.parseJson(res, (t) => parsePatternSuggestions(t, vocab.map((v) => v.name), existing));
		if (!suggestions) return;
		const { matched, proposed } = suggestions;
		if (!matched.length && !proposed.length) {
			return void new Notice(existing.length ? 'No further patterns suggested.' : 'The AI could not tell which patterns apply. Add more of your approach to the note.');
		}

		const picked = await pickPatterns(this.app, file.basename, existing, [
			...matched.map((m) => ({ ...m, isNew: false })),
			...proposed.map((p) => ({ ...p, isNew: true })),
		]);
		if (!picked?.length) return;

		await this.app.fileManager.processFrontMatter(file, (f: Frontmatter) => {
			for (const name of picked) {
				const target = vocab.find((v) => v.name === name);
				const field = target?.field ?? 'patterns';
				f[field] = mergeUnique(f[field], [target ? this.patternLink(target.file, file.path) : `[[${name}]]`]);
			}
		});
		const missing = picked.filter((p) => !vocab.some((v) => v.name === p));
		new Notice(
			`Linked "${file.basename}" to ${picked.join(', ')}.` +
				(missing.length ? ` No note yet for ${missing.join(', ')}; run "New topic note" to create one.` : ''),
		);
	}

	// ---------- new LeetCode solution ----------

	private async newSolution(): Promise<void> {
		const s = this.settings;
		const input = await solutionForm(this.app);
		if (!input) return;
		const link = parseLeetCodeLink(input.url)!; // validated by the form
		if (input.code.length + input.question.length > s.maxNoteChars) {
			return void new Notice(`That is too much text (limit ${s.maxNoteChars} characters). Raise the limit in settings.`);
		}
		const vocab = this.patternNotes();
		const names = vocab.map((v) => v.name);
		const existing = this.findProblemNote(link.slug);
		if (existing) return this.addSolution(existing, link, input, vocab);

		const res = await this.ask(
			`solution:${link.slug}`,
			`New LeetCode solution: sending your ${input.language} code for "${link.slug}"${input.question ? ', the problem statement' : ''} and ${names.length} pattern names`,
			buildNewSolutionPrompt({ ...input, ...link, patternNames: names }),
			NEW_SOLUTION_SCHEMA,
		);
		if (!res) return;
		const data = this.parseJson(res, (t) => parseNewSolution(t, names));
		if (!data) return;

		const path = normalizePath(notePath(s.problemsFolder, noteTitle(data, link)));
		const patternLinks = data.patterns.map((n) => this.patternLink(vocab.find((v) => v.name === n)!.file, path));
		const note = buildProblemNote({ data, link, input, date: isoDate(), model: res.model ?? s.model, promptVersion: PROMPT_VERSION, patternLinks });
		const { text, warnings } = this.defang(note, path);
		if (!input.question) warnings.push('No problem statement was pasted, so the "Question" section is written from the problem name. Check it against LeetCode.');

		new PreviewModal(this.app, {
			title: 'New LeetCode solution',
			details: [['Problem', link.url], ['Effect', `Creates ${path}.`], ...this.responseDetails(res)],
			warnings,
			content: text,
			actions: [
				{
					label: 'Create note',
					cta: true,
					run: () => this.createAndOpen((n) => (n === 1 ? path : path.replace(/\.md$/, ` (${n}).md`)), text),
				},
			],
		}).open();
	}

	/** Same problem solved again: add the code as "Solution N" to the existing note. */
	private async addSolution(file: TFile, link: LeetCodeLink, input: SolutionInput, vocab: PatternNote[]): Promise<void> {
		const s = this.settings;
		const names = vocab.map((v) => v.name);
		const original = await this.app.vault.read(file);
		if (containsCode(original, input.code)) return void new Notice(`This exact solution is already in "${file.basename}".`);
		if (original.length + input.code.length > s.maxNoteChars) {
			return void new Notice(`"${file.basename}" is too large to send (limit ${s.maxNoteChars} characters). Raise the limit in settings.`);
		}

		const res = await this.ask(
			file.path,
			`"${file.basename}" is already in your vault. Sending it and your new ${input.language} solution`,
			buildAddSolutionPrompt({ ...input, ...link, patternNames: names, notePath: file.path, note: original }),
			ADD_SOLUTION_SCHEMA,
		);
		if (!res) return;
		const data = this.parseJson(res, (t) => parseAddedSolution(t, names));
		if (!data) return;

		const n = nextSolutionNumber(original);
		const block = solutionBlock({
			n,
			method: data.methodName,
			date: isoDate(),
			language: input.language,
			code: input.code,
			howItWorks: data.howItWorks,
			time: data.time,
			space: data.space,
			compared: data.compared,
		});
		const { text, warnings } = this.defang(block, file.path);
		if (data.sameApproach) warnings.unshift('The AI thinks this is the same approach as a solution already in the note. Add it only if it differs in a way you want to remember.');
		if ((await this.app.vault.read(file)) !== original) warnings.unshift('The note changed while the request was running. Re-run the command.');

		const newTopics = data.topics.map((t) => t.name);
		const newPatterns = data.patterns.map((p) => this.patternLink(vocab.find((v) => v.name === p)!.file, file.path));
		new PreviewModal(this.app, {
			title: `Add solution ${n}`,
			details: [
				['Note', file.path],
				[
					'Effect',
					`Adds "Solution ${n}" at the end of the note's Solutions section` +
						(newTopics.length || newPatterns.length ? ` and adds ${[...newTopics, ...newPatterns].join(', ')} to its topics/patterns` : '') +
						'. Nothing else changes.',
				],
				...this.responseDetails(res),
			],
			warnings,
			content: text,
			actions: [
				{
					label: 'Add to note',
					cta: true,
					run: async () => {
						let conflict = false;
						await this.app.vault.process(file, (current) => {
							if (current !== original) {
								conflict = true;
								return current;
							}
							return appendToSection(current, SOLUTIONS_HEADING, text, 'Solutions');
						});
						if (conflict) throw new Error(CONFLICT);
						await this.app.fileManager.processFrontMatter(file, (f: Frontmatter) => {
							if (newTopics.length) f.topics = mergeUnique(f.topics, newTopics);
							if (newPatterns.length) f.patterns = mergeUnique(f.patterns, newPatterns);
							f.leetcode_url ||= link.url;
							f.problem_slug ||= link.slug;
						});
						await this.app.workspace.getLeaf(false).openFile(file);
						new Notice(`Added Solution ${n} to ${file.path}.`);
					},
				},
			],
		}).open();
	}

	/** A problem note for this LeetCode slug: by frontmatter slug/URL, else by a "type: leetcode" note named after it. */
	private findProblemNote(slug: string): TFile | null {
		return (
			this.noteFiles().find((f) => {
				const fm: Frontmatter = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
				if (fm.problem_slug === slug) return true;
				if ([fm.leetcode_url, fm.url, fm.link].some((u) => typeof u === 'string' && parseLeetCodeLink(u)?.slug === slug)) return true;
				return fm.type === 'leetcode' && tagKey(f.basename.replace(/^\d+\.\s*/, '')) === slug;
			}) ?? null
		);
	}

	// ---------- log attempt ----------

	private async logAttempt(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') return void new Notice('No active Markdown note.');
		const fm: Frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		if (fm.type !== 'leetcode') {
			const ok = await confirm(this.app, 'Not a problem note?', 'This note is not marked "type: leetcode". Log an attempt anyway?');
			if (!ok) return;
		}
		const c = Number(fm.confidence);
		const attempt = await attemptForm(this.app, file.basename, Number.isInteger(c) && c >= 1 && c <= 5 ? c : 3);
		if (!attempt) return;

		const today = isoDate();
		const next = addDays(today, reviewIntervalDays(attempt.outcome, attempt.confidence));
		await this.app.vault.process(file, (data) => addRevisionLogEntry(data, formatAttempt(today, attempt)));
		await this.app.fileManager.processFrontMatter(file, (f: Frontmatter) => {
			f.status = attempt.outcome;
			f.confidence = attempt.confidence;
			f.next_review = next;
			if (attempt.mistakes.length) f.mistake_types = mergeUnique(f.mistake_types, attempt.mistakes);
			f.date_started ||= today;
			if (attempt.outcome !== 'attempted') f.date_solved ||= today;
		});
		new Notice(`Logged attempt. Next review: ${next}.`);
	}

	// ---------- revision queue ----------

	private async revisionQueue(): Promise<void> {
		const s = this.settings;
		const today = isoDate();
		const notes = this.noteFiles()
			.map((f) => ({ path: f.path, name: f.basename, fm: this.app.metadataCache.getFileCache(f)?.frontmatter ?? {} }))
			.filter((n) => n.fm.type === 'leetcode');
		if (!notes.length) return void new Notice('No problem notes found (they need "type: leetcode" in frontmatter).');

		const plan = planRevision(notes, today, s.revisionQueueSize);
		if (!plan.items.length) return void new Notice('No notes are due for revision.');
		const report = renderRevisionReport(plan, today);

		new PreviewModal(this.app, {
			title: 'Revision queue',
			details: [
				['Problems scanned', String(notes.length)],
				['Due or overdue', String(plan.dueCount)],
				['Effect', `Creates a report in ${s.revisionFolder || 'the vault root'}. No AI is used.`],
			],
			warnings: plan.dataIssues.length ? [`${plan.dataIssues.length} metadata issue(s); listed in the report.`] : [],
			content: report,
			actions: [
				{
					label: 'Create report',
					cta: true,
					run: () => this.createAndOpen((n) => draftPath(s.revisionFolder, 'DSA', 'revision queue', today, n), report),
				},
			],
		}).open();
	}

	// ---------- shared helpers ----------

	/** The active Markdown note, or null after telling the user why not. */
	private async activeNote(): Promise<{ file: TFile; content: string; fm: Frontmatter } | null> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') return fail('No active Markdown note.');
		if (this.busy.has(file.path)) return fail('Already processing this note.');
		const content = await this.app.vault.read(file);
		if (!content.trim()) return fail('This note is empty.');
		const max = this.settings.maxNoteChars;
		if (content.length > max) return fail(`Note is too large (${content.length} characters; limit ${max}). Raise the limit in settings or split the note.`);
		return { file, content, fm: this.app.metadataCache.getFileCache(file)?.frontmatter ?? {} };
	}

	/** One AI request with a cancellable progress notice. Returns null after telling the user on failure. */
	private async ask(busyKey: string, what: string, prompt: { system: string; user: string }, jsonSchema?: object): Promise<AiResponse | null> {
		if (this.busy.has(busyKey)) return fail('Already processing this.');
		const controller = new AbortController();
		const approxTokens = Math.ceil((prompt.system.length + prompt.user.length) / 4);
		const notice = new Notice(`${what} (~${approxTokens} tokens) to ${this.settings.model}… `, 0);
		notice.messageEl.createEl('button', { text: 'Cancel' }).onclick = () => controller.abort();
		this.busy.add(busyKey);
		try {
			return await this.provider().generate({
				systemPrompt: prompt.system,
				userPrompt: prompt.user,
				maxOutputTokens: this.settings.maxOutputTokens,
				jsonSchema,
				signal: controller.signal,
			});
		} catch (e) {
			return fail(controller.signal.aborted ? 'Cancelled. No files were changed.' : `AI request failed: ${errMsg(e)}`);
		} finally {
			notice.hide();
			this.busy.delete(busyKey);
		}
	}

	/** Validate Markdown output and defang links to notes that don't exist. Returns null after telling the user if unusable. */
	private checkOutput(res: AiResponse, headings: string[], sourcePath: string): { text: string; warnings: string[] } | null {
		const v = validateOutput(res.text, headings);
		if (v.errors.length) return fail(v.errors.join(' '));
		const out = this.defang(v.text, sourcePath);
		if (res.stopReason === 'max_tokens') out.warnings.unshift('Output hit the max output token limit and is probably cut off.');
		out.warnings.unshift(...v.warnings);
		return out;
	}

	/** Parse a structured (JSON) response. Returns null after telling the user if unusable. */
	private parseJson<T>(res: AiResponse, parse: (text: string) => T): T | null {
		if (res.stopReason === 'max_tokens') return fail('The AI response was cut off. Raise "Max output tokens" in settings and try again.');
		try {
			return parse(res.text);
		} catch (e) {
			return fail(`The AI response was not usable (${errMsg(e)}). Try again.`);
		}
	}

	/** Turn links to notes that don't exist into plain text, and flag content that plugins might execute. */
	private defang(md: string, sourcePath: string): { text: string; warnings: string[] } {
		const links = verifyWikiLinks(md, (t) => !!this.app.metadataCache.getFirstLinkpathDest(t, sourcePath));
		const warnings = links.unresolved.length ? [`Links to notes that don't exist were turned into plain text: ${links.unresolved.join(', ')}.`] : [];
		warnings.push(...executableContentWarnings(links.text));
		return { text: links.text, warnings };
	}

	private patternLink(target: TFile, sourcePath: string): string {
		return `[[${this.app.metadataCache.fileToLinktext(target, sourcePath, true)}]]`;
	}

	private responseDetails(res: AiResponse): [string, string][] {
		return [
			['Model', `${res.model ?? this.settings.model} (Anthropic API)`],
			['Tokens', `${res.usage?.inputTokens ?? '?'} in / ${res.usage?.outputTokens ?? '?'} out`],
		];
	}

	private async createAndOpen(pathFor: (version: number) => string, content: string, after?: (f: TFile) => Promise<void>): Promise<boolean> {
		const f = await this.createFile(pathFor, content, 'ask');
		if (!f) return false;
		await after?.(f);
		new Notice(`Created ${f.path}`);
		await this.app.workspace.getLeaf('tab').openFile(f);
		return true;
	}

	/** Create a file without ever silently overwriting: on collision, ask or pick the next free version. */
	private async createFile(pathFor: (version: number) => string, content: string, onExists: 'ask' | 'version'): Promise<TFile | null> {
		const vault = this.app.vault;
		let path = normalizePath(pathFor(1));
		const existing = vault.getAbstractFileByPath(path);
		if (existing) {
			const choice =
				onExists === 'ask'
					? await choose(this.app, 'File already exists', `"${path}" already exists.`, ['Create new version', 'Replace it'])
					: 'Create new version';
			if (!choice) return null;
			if (choice === 'Replace it' && existing instanceof TFile) {
				await vault.modify(existing, content);
				return existing;
			}
			for (let n = 2; vault.getAbstractFileByPath(path); n++) path = normalizePath(pathFor(n));
		}
		const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
		return vault.create(path, content);
	}

	/** Markdown files that are the user's notes, not this plugin's drafts or reports. */
	private noteFiles(): TFile[] {
		const { draftFolder, revisionFolder } = this.settings;
		return this.app.vault.getMarkdownFiles().filter((f) => !isUnder(f.path, draftFolder) && !isUnder(f.path, revisionFolder));
	}

	/** Pattern/topic notes in the vault: the only names "Link to patterns" may pick from. */
	private patternNotes(): PatternNote[] {
		// ponytail: capped at 500 names to bound the prompt; page or pre-filter if a vault has more.
		return this.noteFiles()
			.flatMap((file): PatternNote[] => {
				const type: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
				if (typeof type !== 'string' || !/pattern|topic/i.test(type)) return [];
				return [{ name: file.basename, file, field: /pattern/i.test(type) ? 'patterns' : 'topics' }];
			})
			.slice(0, 500);
	}

	/**
	 * Names + a little metadata of notes that share a pattern/topic with `wanted`, plus (for an
	 * existing note) notes linked to or from it. Never note bodies.
	 */
	private relatedNotes(wanted: string[], file?: TFile): string[] {
		const { metadataCache } = this.app;
		const want = new Set(wanted.map(tagKey).filter(Boolean));
		const linked = new Set<string>();
		if (file) {
			for (const target of Object.keys(metadataCache.resolvedLinks[file.path] ?? {})) linked.add(target);
			for (const [src, targets] of Object.entries(metadataCache.resolvedLinks)) if (targets[file.path]) linked.add(src);
		}

		return this.noteFiles()
			.filter((f) => f !== file)
			.map((f) => {
				const m: Frontmatter = metadataCache.getFileCache(f)?.frontmatter ?? {};
				const tags = [...asStringArray(m.patterns), ...asStringArray(m.topics)];
				const shares = tags.some((t) => want.has(tagKey(t)));
				const score = (linked.has(f.path) ? 2 : 0) + (shares ? 1 : 0) + (isTopicNote(m) ? 0.5 : 0);
				return { f, m, tags, score };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || a.f.basename.localeCompare(b.f.basename))
			.slice(0, this.settings.maxRelatedNotes)
			.map(({ f, m, tags }) => {
				const meta = [
					typeof m.type === 'string' ? m.type : '',
					typeof m.difficulty === 'string' ? m.difficulty : '',
					tags.length ? `patterns/topics: ${tags.join(', ')}` : '',
				].filter(Boolean).join('; ');
				return `- ${f.basename}${meta ? ` (${meta})` : ''}`;
			});
	}
}

/** Insert a callout right after the frontmatter (or at the top if there is none). */
function withHeader(md: string, header: string): string {
	const start = getFrontMatterInfo(md).contentStart;
	return md.slice(0, start) + header + '\n\n' + md.slice(start).replace(/^\n+/, '');
}
