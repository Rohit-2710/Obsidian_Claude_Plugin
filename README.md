# DSA Vault Agent

An Obsidian plugin for LeetCode/DSA study. It uses the Anthropic API to format problem notes, review Java solutions and fill gaps in pattern notes. It also builds a revision queue from your notes' metadata, without AI. You see every AI result before anything is written, and your notes are never overwritten without asking.

The goal is learning. An AI explanation never marks a problem as `recalled` or `mastered`. Only you set those.

## Commands

| Command | What it does |
|---|---|
| **New LeetCode solution** | Paste a problem link, pick the language and paste your code. Pasting the problem statement is optional. You get a note with the question, the topics used, the intuition, your solution with an explanation of how it works, and other ways to solve it (intuition only, no code). Your code goes in exactly as pasted: the AI writes only the explanations, and the plugin builds the note. **If the problem is already in your vault** (matched by its LeetCode link, or a problem note with the same name), your new code is added to that note as "Solution N", with a comparison to the earlier solutions. Pasting an identical solution again is refused. |
| **Format current LeetCode note** | Turns a raw note into the problem template. Your code and your initial reasoning are kept as written, and AI-written text starts with `[AI]`. Choose **Create draft** or **Replace note…**. Replace keeps your frontmatter values, saves a backup first, and is disabled if any original code block changed. |
| **Review current Java solution** | Writes a separate review report: summary, definite bugs (each with a failing input), possible risks, suggested test cases, complexity, follow-up questions and a next step. Nothing is compiled or run, and the report says so. |
| **Enrich current topic note** | Suggests only what a pattern note is missing (recognition clues, counterexamples, invariant, Java template, dry run, common mistakes and so on). Choose **Create draft** or **Append to note**, which adds an `## AI additions` section. |
| **New topic note** | You type a topic, e.g. "Sliding Window". The AI drafts a pattern note from the template. Its "Related problems" can link only to problems in your vault already tagged with that pattern. The note is created in the patterns folder with `status: learning`, `confidence: 1`. If a note with that name (or a spelling variant) exists, it offers to enrich it instead. |
| **Link current problem to patterns** | The AI picks patterns for the problem from your existing pattern notes, using JSON output that is checked against the vault. You tick which to keep. Suggestions for brand-new patterns start unticked. Chosen ones are added to `patterns`/`topics` frontmatter as `[[links]]`, so they show up in the graph and backlinks. Existing values are never removed. |
| **Log revision attempt** | No AI. A form for after you re-solve a problem: outcome, confidence and mistakes. It updates `status`, `confidence` and `mistake_types`, sets `next_review`, and adds a line to the note's revision log. |
| **Generate revision queue** | Ranks `type: leetcode` notes by overdue `next_review`, low confidence, repeated `mistake_types`, not-yet-recalled status and weak patterns. Lists invalid metadata instead of crashing. No AI is used. |
| **Process current note** | Runs the action named in frontmatter `ai_action: format | review | enrich`. Without one, pattern/topic notes are enriched and other notes are formatted. |
| **Test AI connection** | Checks the API key and model ID through the free `/v1/models` endpoint. |

Every AI command shows a preview first. The preview lists the source note, what will change, the model, token usage and any warnings, then shows the raw Markdown. It is never rendered, so nothing in it can execute. Cancel leaves your files unchanged.

## Safety behaviour

- **No silent overwrites.** If a draft with the same name exists, you choose between a new version and replacing it.
- **Conflict detection.** If the note changes while the AI is working, you get a warning in the preview, and the plugin refuses to apply to the changed note.
- **Grounded links.** `[[links]]` to notes that don't exist become plain text marked `(unverified link)`. Links inside code are left alone.
- **Prompt-injection handling.** Note content is wrapped as untrusted data, and the model is told not to follow instructions found inside it.
- **Executable content.** The preview warns about `dataviewjs`, `<script>` and Templater commands in AI output.
- **Bounded input.** Notes over the size limit are not sent. Related notes are sent as names and frontmatter summaries only, never their contents, up to a configurable count.
- **Paths stay in the vault.** Configured folders and generated file names are sanitized against path traversal.
- **One request at a time.** A note that is already being processed can't be sent again, and long requests can be cancelled from the progress notice.

## Problem note layout

**New LeetCode solution** creates notes in the problems folder (default `02 Problems`) with this structure:

```
frontmatter: type, problem_id, difficulty, leetcode_url, problem_slug, topics, patterns, status, language, date_solved
# 167. Two Sum II
## Question
## Topics used
## Intuition
## Solutions
### Solution 1: Hash map (mine, 2026-10-18)   ← your code, then How it works + Complexity
### Solution 2: Two pointers (mine, …)          ← added when you solve it again another way
## Other ways to solve it
## Revision log
```

Without a pasted problem statement, the "Question" section is written from the problem name and marked `[verify]`. The plugin never scrapes LeetCode. The `patterns` field links only to pattern notes that exist in your vault. `status` starts at `attempted`; run **Log revision attempt** to record confidence and schedule the next review.

## Review intervals

**Log revision attempt** sets `next_review` from a fixed table. The table does not adapt to your history.

| Outcome | Next review |
|---|---|
| Couldn't solve it yet (`attempted`) | 1 day |
| Solved with hints (`reviewed`) | 3 days |
| Solved from memory (`recalled`) | 3 / 5 / 7 / 14 / 30 days for confidence 1–5 |
| Mastered (`mastered`) | 60 days |

## Note metadata

The plugin reads these frontmatter fields. Unknown fields are preserved.

| Field | Values |
|---|---|
| `type` | `leetcode` for problem notes; `dsa-pattern` (linked via `patterns`) or `dsa-topic` (linked via `topics`) for pattern/topic notes |
| `status` | `attempted` (tried it), `reviewed` (studied a solution or review), `recalled` (solved again from memory), `mastered` (set by you only) |
| `confidence` | integer 1–5 |
| `next_review`, `date_started`, `date_solved` | `YYYY-MM-DD` |
| `patterns`, `topics`, `mistake_types` | lists |

The problem and pattern templates the plugin produces are in [`src/prompts.ts`](src/prompts.ts).

## Disclosures

- **Network use.** The AI commands send requests to the Anthropic API (`api.anthropic.com`), which generates the notes, reviews and suggestions. A request is made only when you run an AI command (or click **Test connection**). It contains the active note, any selected text, and, if **Include related notes** is on, the names and frontmatter of up to *N* related notes (never their contents). For **New LeetCode solution** it also contains the code and problem statement you paste. Your vault is never uploaded in bulk. **Log revision attempt** and **Generate revision queue** make no network requests.
- **Account and payment.** The AI commands need an Anthropic API account and API key, which is a paid, usage-billed service from Anthropic, separate from a Claude.ai or Claude Code subscription. The non-AI commands work without one.
- **No telemetry, no ads.** The plugin collects no analytics and contacts no service other than Anthropic.
- **Files.** The plugin reads and writes only inside your vault.

## Privacy and cost

- **API key storage.** The key is stored in Obsidian's keychain (`SecretStorage`), not in this plugin's `data.json` (which lives in your vault and travels with vault sync). The plugin stores only the secret's name. You can delete the secret from Obsidian's keychain settings. For how secrets are protected on your platform, see Obsidian's documentation; this plugin adds no encryption of its own. The key never appears in error messages.
- **Cost control.** You choose the model and the output-token limit. The default model is `claude-opus-5-5`. For lower cost, use `claude-sonnet-5-5` or `claude-haiku-5-5`. Each request's progress notice shows an estimated input size.
- **Cancelling.** Obsidian's `requestUrl` can't abort a request in flight. Cancelling stops waiting and discards the result, but the request still completes on Anthropic's side and is billed.

## Install

Requires Obsidian 1.13.2 or later. Works on desktop, tablets and phones.

- **From Community plugins** (once it's approved): *Settings → Community plugins → Browse*, search for "DSA Vault Agent", then **Install** and **Enable**.
- **Before approval, with BRAT:** install the *BRAT* plugin from Community plugins, run **BRAT: Add a beta plugin for testing**, and enter `https://github.com/Rohit-2710/Obsidian_Claude_Plugin`. BRAT also works on tablets and keeps the plugin updated.
- **Manually:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases/latest) into `<YourVault>/.obsidian/plugins/dsa-vault-agent/`, then enable **DSA Vault Agent** under *Settings → Community plugins*.

Then open the plugin settings, pick or create a keychain secret holding your Anthropic API key, and click **Test connection**. If the secret isn't available on another device, such as your tablet, add it there once with the same name.

## Not included (yet)

- Claude Code CLI adapter
- Automatic folder watcher (use **Process current note**)
- Batch linking of all untagged problems
- Hint ladder
- A free-text request box that dispatches to the commands above
- Applying a change to only the selected section (selected text is sent as the focus area, but output goes to a draft or the whole note)
- Running tests against solutions
- Cloud processing

## Development

```bash
npm install
npm run dev        # rebuild main.js on change
npm run build      # type-check, then a production build
npm run lint       # Obsidian's plugin review rules (eslint-plugin-obsidianmd)
npm test           # unit tests (Node's built-in test runner)
```

- The code is split by role:
  - `src/core.ts` holds pure logic: paths, validation, link checks, section editing and revision scoring.
  - `src/solution.ts` builds "New LeetCode solution" notes and checks the AI's JSON.
  - `src/prompts.ts` holds the versioned prompts and JSON schemas.
  - `src/provider.ts` is the Anthropic client. It has no runtime dependency on Obsidian.
  - `src/ui.ts` contains the preview, form and confirmation modals.
  - `src/settings.ts` contains the settings and the settings tab.
  - `src/main.ts` contains the commands and the file operations.
- **Releasing:** `npm version patch|minor|major` bumps `package.json`, `manifest.json` and `versions.json` and creates a tag without a `v` prefix. Push the tag (`git push --follow-tags`): the release workflow builds the plugin, attests the files and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css`. Publish the draft to make it live.

## License

[MIT](LICENSE)
