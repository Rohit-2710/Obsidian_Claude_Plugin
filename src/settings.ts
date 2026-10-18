import { App, Notice, Platform, PluginSettingTab, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { safeFolder } from './core';
import { confirm } from './ui';
import type DsaVaultAgent from './main';

export type ProviderId = 'anthropic-api' | 'claude-code';

export interface DsaVaultAgentSettings {
	provider: ProviderId;
	/** Path or command name of the Claude Code CLI (desktop only). */
	claudePath: string;
	/** Model for Claude Code; empty = Claude Code's default. */
	claudeModel: string;
	/** Name of the secret in Obsidian's SecretStorage. The key itself is never stored in data.json. */
	apiKeySecret: string;
	model: string;
	maxOutputTokens: number;
	maxNoteChars: number;
	includeRelatedNotes: boolean;
	maxRelatedNotes: number;
	draftFolder: string;
	problemsFolder: string;
	patternsFolder: string;
	revisionFolder: string;
	revisionQueueSize: number;
}

export const DEFAULT_SETTINGS: DsaVaultAgentSettings = {
	provider: 'anthropic-api',
	claudePath: 'claude',
	claudeModel: '',
	apiKeySecret: '',
	model: 'claude-opus-5-5',
	maxOutputTokens: 16000,
	maxNoteChars: 60000,
	includeRelatedNotes: true,
	maxRelatedNotes: 20,
	draftFolder: '07 AI Output',
	problemsFolder: '02 Problems',
	patternsFolder: '03 Patterns',
	revisionFolder: '05 Revision',
	revisionQueueSize: 10,
};

const wholeNumber = (min: number, max: number) => (v: number) =>
	Number.isInteger(v) && v >= min && v <= max ? undefined : `Enter a whole number from ${min} to ${max}.`;

const insideVault = (v: string): string | undefined => {
	try {
		safeFolder(v);
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : 'Invalid folder.';
	}
};

/** Declarative settings (Obsidian 1.13+): values are read from and saved to `plugin.settings` by Obsidian. */
export class DsaSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DsaVaultAgent) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const api = () => this.plugin.settings.provider === 'anthropic-api';
		const cli = () => !api();
		const folder = (name: string, desc: string, key: FolderKey): SettingDefinition => ({
			name,
			desc,
			control: { type: 'folder', key, includeRoot: true, validate: insideVault },
		});
		return [
			{
				name: 'What is sent, and cost',
				desc:
					'Running an AI command sends the active note (and, if enabled, the names and metadata of related notes) to Anthropic, directly or through Claude Code. ' +
					'Nothing is sent otherwise. Anthropic API usage is billed per request; Claude Code usage counts against your Claude plan.',
			},
			{
				type: 'group',
				heading: 'AI provider',
				items: [
					{
						name: 'AI provider',
						desc: 'Anthropic API: needs an API key (usage-billed) and works everywhere. Claude Code: uses the Claude Code app installed on this computer, signed in with your own Claude subscription (Pro, Max…). Desktop only.',
						control: {
							type: 'dropdown',
							key: 'provider',
							options: Platform.isDesktop
								? { 'anthropic-api': 'Anthropic API (API key)', 'claude-code': 'Claude Code (your Claude subscription)' }
								: { 'anthropic-api': 'Anthropic API (API key)' },
						},
					},
					{
						name: 'Claude Code path',
						desc: 'Usually just "claude". If Obsidian can\'t find it, run "which claude" (macOS/Linux) or "where claude" (Windows) in a terminal and paste the full path here. Sign in once by running "claude" in a terminal.',
						visible: cli,
						control: { type: 'text', key: 'claudePath', placeholder: 'claude', validate: (v) => (v.trim() ? undefined : 'Enter the path to Claude Code.') },
					},
					{
						name: 'Claude Code model',
						desc: 'Optional: a model alias such as "sonnet" or "opus", or a full model ID. Leave empty to use Claude Code\'s default. Requests count against your Claude plan\'s usage limits.',
						visible: cli,
						control: { type: 'text', key: 'claudeModel', placeholder: 'Claude Code default' },
					},
					{
						name: 'Anthropic API key',
						desc: "Pick or create a secret in Obsidian's keychain. This plugin stores only the secret's name, not the key. Manage or delete stored secrets from the keychain.",
						visible: api,
						control: { type: 'secret', key: 'apiKeySecret' },
					},
					{
						name: 'Model ID',
						visible: api,
						desc: 'Any current Anthropic model ID, such as claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5.',
						control: { type: 'text', key: 'model', placeholder: DEFAULT_SETTINGS.model, validate: (v) => (v.trim() ? undefined : 'Enter a model ID.') },
					},
					{
						name: 'Max output tokens',
						visible: api,
						desc: 'Upper bound on each response (cost control).',
						control: { type: 'number', key: 'maxOutputTokens', min: 256, max: 128000, validate: wholeNumber(256, 128000) },
					},
					{
						name: 'Max note size (characters)',
						desc: 'Notes larger than this are not sent.',
						control: { type: 'number', key: 'maxNoteChars', min: 1000, max: 500000, validate: wholeNumber(1000, 500000) },
					},
					{
						name: 'Test connection',
						desc: 'Anthropic API: checks the key and model ID without generating any tokens. Claude Code: checks that it is installed and signed in.',
						action: () => void this.plugin.provider().testConnection().then((r) => new Notice(r.message)),
					},
				],
			},
			{
				type: 'group',
				heading: 'Context',
				items: [
					{
						name: 'Include related notes',
						desc: 'Send the names and frontmatter summary (never the contents) of linked notes and notes sharing patterns/topics, so the AI can link only to notes that exist.',
						control: { type: 'toggle', key: 'includeRelatedNotes' },
					},
					{ name: 'Max related notes', control: { type: 'number', key: 'maxRelatedNotes', min: 0, max: 200, validate: wholeNumber(0, 200) } },
				],
			},
			{
				type: 'group',
				heading: 'Folders',
				items: [
					folder('Problems folder', 'Where "New LeetCode solution" creates notes. Problem notes are recognized anywhere by "type: leetcode".', 'problemsFolder'),
					folder('Patterns folder', 'Where "New topic note" creates pattern/topic notes.', 'patternsFolder'),
					folder('Draft folder', 'AI drafts, review reports and backups go here.', 'draftFolder'),
					folder('Revision folder', 'Where revision queue reports are saved.', 'revisionFolder'),
					{
						name: 'Revision queue size',
						desc: 'How many problems per queue.',
						control: { type: 'number', key: 'revisionQueueSize', min: 1, max: 100, validate: wholeNumber(1, 100) },
					},
				],
			},
			{
				type: 'group',
				heading: 'Reset',
				items: [{ name: 'Reset settings', desc: 'Restore defaults. The secret in the keychain is not deleted.', action: () => void this.reset() }],
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		if (key === 'provider') this.update(); // show the fields for the chosen provider
	}

	private async reset(): Promise<void> {
		if (!(await confirm(this.app, 'Reset settings?', 'All DSA Vault Agent settings return to their defaults.', 'Reset'))) return;
		this.plugin.settings = { ...DEFAULT_SETTINGS };
		await this.plugin.saveSettings();
		this.update();
	}
}

type FolderKey = 'draftFolder' | 'problemsFolder' | 'patternsFolder' | 'revisionFolder';
