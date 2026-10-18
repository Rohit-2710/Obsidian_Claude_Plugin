import { App, Modal, Notice, Setting } from 'obsidian';
import { Attempt, MISTAKE_TYPES, Outcome } from './core';
import { LANGUAGES, SolutionInput, parseLeetCodeLink } from './solution';

export interface PreviewAction {
	label: string;
	cta?: boolean;
	destructive?: boolean;
	/** If set, the button is disabled and this explains why. */
	disabledReason?: string;
	/** Return false to keep the preview open (e.g. the user backed out of a follow-up prompt). */
	run: () => Promise<boolean | void>;
}

export interface PreviewOptions {
	title: string;
	details: [string, string][];
	warnings: string[];
	content: string;
	actions: PreviewAction[];
}

/** Shows AI output as raw Markdown (never rendered, so nothing in it executes) until the user picks an action. */
export class PreviewModal extends Modal {
	constructor(app: App, private opts: PreviewOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		this.setTitle(opts.title);
		this.modalEl.addClass('dsa-agent-preview');

		const dl = contentEl.createEl('dl', { cls: 'dsa-agent-details' });
		for (const [k, v] of opts.details) {
			dl.createEl('dt', { text: k });
			dl.createEl('dd', { text: v });
		}
		if (opts.warnings.length) {
			const ul = contentEl.createEl('ul', { cls: 'dsa-agent-warnings' });
			for (const w of opts.warnings) ul.createEl('li', { text: w });
		}
		const area = contentEl.createEl('textarea', { cls: 'dsa-agent-output', attr: { readonly: 'true', spellcheck: 'false' } });
		area.value = opts.content;

		const row = new Setting(contentEl);
		const buttons: { setDisabled(d: boolean): unknown }[] = [];
		for (const a of opts.actions) {
			row.addButton((b) => {
				b.setButtonText(a.label);
				if (a.cta) b.setCta();
				if (a.destructive) b.setDestructive();
				if (a.disabledReason) b.setDisabled(true).setTooltip(a.disabledReason);
				else buttons.push(b);
				const click = async () => {
					buttons.forEach((x) => x.setDisabled(true));
					try {
						if ((await a.run()) !== false) return this.close();
					} catch (e) {
						new Notice(e instanceof Error ? e.message : String(e));
					}
					buttons.forEach((x) => x.setDisabled(false));
				};
				b.onClick(() => void click());
			});
		}
		row.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Open a modal and resolve with whatever `build` passes to `done`, or null if the user closes it.
 * `build` gets the content element and a `done(value)` callback that closes the modal.
 */
function form<T>(app: App, title: string, build: (el: HTMLElement, done: (value: T | null) => void) => void): Promise<T | null> {
	return new Promise((resolve) => {
		let result: T | null = null;
		new (class extends Modal {
			onOpen() {
				this.setTitle(title);
				build(this.contentEl, (value) => {
					result = value;
					this.close();
				});
			}
			onClose() {
				this.contentEl.empty();
				resolve(result);
			}
		})(app).open();
	});
}

/** Ask the user to pick one option. Resolves to the chosen label, or null on cancel. */
export function choose(app: App, title: string, message: string, options: string[]): Promise<string | null> {
	return form<string>(app, title, (el, done) => {
		el.createEl('p', { text: message });
		const row = new Setting(el);
		options.forEach((label, i) => {
			row.addButton((b) => {
				b.setButtonText(label).onClick(() => done(label));
				if (i === 0) b.setCta();
			});
		});
		row.addButton((b) => b.setButtonText('Cancel').onClick(() => done(null)));
	});
}

export async function confirm(app: App, title: string, message: string, confirmLabel = 'Continue'): Promise<boolean> {
	return (await choose(app, title, message, [confirmLabel])) === confirmLabel;
}

export function askText(app: App, title: string, placeholder: string, submitLabel: string): Promise<string | null> {
	return form<string>(app, title, (el, done) => {
		let value = '';
		new Setting(el).addText((t) => {
			t.setPlaceholder(placeholder).onChange((v) => (value = v));
			t.inputEl.addClass('dsa-agent-wide');
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && value.trim()) done(value.trim());
			});
			window.setTimeout(() => t.inputEl.focus());
		});
		new Setting(el).addButton((b) =>
			b
				.setButtonText(submitLabel)
				.setCta()
				.onClick(() => value.trim() && done(value.trim())),
		);
	});
}

export interface Suggestion {
	name: string;
	reason: string;
	isNew: boolean;
}

/** Checkbox list of suggested patterns. Existing-note matches start ticked; brand-new names start unticked. */
export function pickPatterns(app: App, noteName: string, existing: string[], suggestions: Suggestion[]): Promise<string[] | null> {
	return form<string[]>(app, `Link "${noteName}" to patterns`, (el, done) => {
		el.createEl('p', {
			cls: 'setting-item-description',
			text: existing.length ? `Already linked: ${existing.join(', ')}. Those stay as they are.` : 'No patterns linked yet.',
		});
		const picked = new Set(suggestions.filter((s) => !s.isNew).map((s) => s.name));
		for (const s of suggestions) {
			new Setting(el)
				.setName(s.isNew ? `${s.name} (new: no note yet)` : s.name)
				.setDesc(s.reason)
				.addToggle((t) =>
					t.setValue(picked.has(s.name)).onChange((on) => {
						if (on) picked.add(s.name);
						else picked.delete(s.name);
					}),
				);
		}
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Add links')
				.setCta()
				.onClick(() => done([...picked])),
		);
	});
}

const OUTCOME_LABELS: Record<Outcome, string> = {
	recalled: 'Solved it from memory',
	reviewed: 'Solved it with hints, or after reviewing',
	attempted: "Couldn't solve it yet",
	mastered: 'Mastered: solid, review rarely',
};

export function attemptForm(app: App, noteName: string, currentConfidence: number): Promise<Attempt | null> {
	return form<Attempt>(app, `Log attempt: ${noteName}`, (el, done) => {
		const a: Attempt = { outcome: 'recalled', confidence: currentConfidence, mistakes: [], note: '' };
		let other = '';
		new Setting(el).setName('Outcome').addDropdown((d) =>
			d
				.addOptions(OUTCOME_LABELS)
				.setValue(a.outcome)
				.onChange((v) => (a.outcome = v as Outcome)),
		);
		new Setting(el)
			.setName('Confidence')
			.setDesc('1 = shaky, 5 = could explain it to anyone')
			.addDropdown((d) =>
				d
					.addOptions({ 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' })
					.setValue(String(a.confidence))
					.onChange((v) => (a.confidence = Number(v))),
			);
		new Setting(el).setName('Mistakes this time').setHeading();
		for (const m of MISTAKE_TYPES) {
			new Setting(el).setName(m).addToggle((t) =>
				t.onChange((on) => (a.mistakes = on ? [...a.mistakes, m] : a.mistakes.filter((x) => x !== m))),
			);
		}
		new Setting(el)
			.setName('Other mistakes')
			.setDesc('Comma-separated')
			.addText((t) => t.onChange((v) => (other = v)));
		new Setting(el).setName('Note').addText((t) => {
			t.setPlaceholder('Optional, one line').onChange((v) => (a.note = v));
			t.inputEl.addClass('dsa-agent-wide');
		});
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Save attempt')
				.setCta()
				.onClick(() => {
					const extra = other.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
					done({ ...a, mistakes: [...new Set([...a.mistakes, ...extra])] });
				}),
		);
	});
}

/** Paste form for "New LeetCode solution". Validates the link and code before closing. */
export function solutionForm(app: App): Promise<SolutionInput | null> {
	return form<SolutionInput>(app, 'New LeetCode solution', (el, done) => {
		const v: SolutionInput = { url: '', language: 'java', code: '', question: '' };
		new Setting(el).setName('LeetCode link').addText((t) => {
			t.setPlaceholder('https://leetcode.com/problems/two-sum/').onChange((x) => (v.url = x));
			t.inputEl.addClass('dsa-agent-wide');
			window.setTimeout(() => t.inputEl.focus());
		});
		new Setting(el).setName('Language').addDropdown((d) =>
			d
				.addOptions(Object.fromEntries(LANGUAGES.map((l) => [l, l])))
				.setValue(v.language)
				.onChange((x) => (v.language = x)),
		);
		new Setting(el)
			.setName('Your solution')
			.setDesc('Stored exactly as you paste it. If this problem is already in your vault, it is added there as a new solution.')
			.setClass('dsa-agent-stacked')
			.addTextArea((t) => {
				t.onChange((x) => (v.code = x));
				t.inputEl.addClass('dsa-agent-code');
			});
		new Setting(el)
			.setName('Problem statement (optional)')
			.setDesc('Paste it for accuracy. Without it, the AI writes the question from the problem name and marks it [verify].')
			.setClass('dsa-agent-stacked')
			.addTextArea((t) => {
				t.onChange((x) => (v.question = x));
				t.inputEl.addClass('dsa-agent-code');
			});
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Generate')
				.setCta()
				.onClick(() => {
					if (!parseLeetCodeLink(v.url)) return void new Notice('Paste a LeetCode problem link, e.g. https://leetcode.com/problems/two-sum/');
					if (!v.code.trim()) return void new Notice('Paste your solution code.');
					done({ ...v, code: v.code.replace(/\s+$/, ''), question: v.question.trim() });
				}),
		);
	});
}
