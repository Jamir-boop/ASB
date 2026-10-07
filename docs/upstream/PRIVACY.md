# Agent Mission Control privacy (archived)

This document describes the retained Agent Mission Control server. It does not describe ASB. The default ASB commands use the data boundary in [ASB privacy](../PRIVACY.md).

Agent Mission Control runs locally and does not send telemetry.

What it reads:

- Codex local state under `~/.codex`
- Codex ChatGPT auth at `~/.codex/auth.json` only when Codex reset-credit
  display is enabled. The access token is used only as an Authorization header
  for the ChatGPT reset-credit endpoint and is not returned to the browser.
- OpenCode CLI output or desktop state under
  `~/Library/Application Support/ai.opencode.desktop`
- Claude Code and Claude Desktop metadata under `~/.claude` and
  `~/Library/Application Support/Claude`
- Claude Desktop's local Chromium cache entry for the Claude usage endpoint,
  used only to read aggregate rate-limit percentages and reset times
- Kimi client model/capacity cache under
  `~/Library/Application Support/kimi-desktop/kimi-agent`, plus the client's
  Chromium Local Storage LevelDB files to extract the current, unexpired
  access token for Kimi quota requests. It does not extract or use refresh
  tokens. The access token is never logged, persisted by Agent Mission
  Control, or returned to the browser.
- Cindy's local `sessions`, `orca_teams`, `orca_workers`, and `subagent_runs`
  metadata under `~/Library/Application Support/Cindy`. These fields identify
  the Cindy frontend, selected harness, host/worker relationships, status,
  token totals, and exact `cindy://session/<id>` recovery link. Agent Mission
  Control does not read Cindy's `messages` table.
- Cindy's non-secret `custom_providers` metadata and sanitized
  `account_usage_snapshots`. For Grok and DeepSeek quota only, Agent Mission
  Control also reads the provider owner binding and asks macOS Keychain to
  decrypt Cindy's current xAI access token or DeepSeek API key in process
  memory. It does not use the xAI refresh token, persist account identifiers
  or credentials, or return a credential to the browser.
- When the optional Bailian Chrome bridge is installed, the visible text in
  the smallest "plan quota" and "subscription information" DOM sections of
  the logged-in Bailian console page. The extension does not request cookie
  access and does not read or persist Cookie values, API keys, account names,
  UIDs, orders, or billing details.
- Local file and URL references mentioned in Codex rollout messages, used to
  summarize artifacts for the dashboard and search results
- Aggregate event counters from a bounded set of high-cost Codex rollouts,
  including context compactions, tool calls, Agent tasks/turns, user inputs,
  verification-signal kinds, and goal completion. Full events and tool
  arguments are not persisted in Mission Control state.
- Local raster image files only when you explicitly preview an artifact image
- Its own notification state under `~/.agent-mission-control`
- Its own review job state under `~/.agent-mission-control/reviews.jsonl`
- Its own local search index under
  `~/.agent-mission-control/search-index.sqlite`
- Prompt Pack drafts in browser `localStorage`, plus attachment copies that you
  explicitly paste or select under `~/.agent-mission-control/prompt-packs`

What it may display locally:

- Thread titles, project names, working directories, models, status, token
  usage, quota samples, and recent user/final-message signals needed for the
  dashboard
- Pending permission or review signals
- Artifact titles, local paths, URLs, file types, image previews, and artifact
  timelines extracted from local Codex rollout messages
- Review job status, source/target Agent metadata, selected input preview,
  stderr snippets, and truncated review results stored locally in
  `~/.agent-mission-control/reviews.jsonl`
- Prompt Pack segment titles, segment text, attachment names, and local
  attachment paths while you prepare a Markdown handoff package
- Portfolio governance evidence, stale/duplicate/recovery-title clues,
  possible canonical-thread titles, long-run warning counters, and selected
  cleanup candidates. Cleanup copy/export is an explicit local browser action.
- The optional macOS menu bar helper shows only aggregate pending/progress
  counts and does not display thread titles or message text

Network requests:

- Agent Mission Control does not send telemetry.
- By default, when a dashboard scan runs and Codex ChatGPT auth is available,
  it may call `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
  to read aggregate gifted Codex reset-credit count and expiry timestamps.
- Set `AMC_CODEX_RESET_CREDITS=0` to disable that ChatGPT reset-credit request.
- The request uses the local Codex/ChatGPT access token only in the outbound
  Authorization header. The token is not logged, persisted by Agent Mission
  Control, sent to the frontend, included in test fixtures, or included in
  visible error payloads.
- Unless `AMC_DEEPSEEK_BALANCE=0` is set, a detected Cindy DeepSeek key may be
  used to call `https://api.deepseek.com/user/balance` to read prepaid balance.
  `AMC_DEEPSEEK_API_KEY` remains an explicit override. The key is used only in
  the outbound Authorization header and is not returned to the browser,
  logged, or persisted. Successful balance reads are throttled in memory for
  60 seconds using an irreversible key fingerprint.
- Unless `AMC_KIMI_QUOTA=0` is set, a detected Kimi desktop login may be used
  to call Kimi's Membership `GetSubscriptionStats` and `GetSubscription`
  endpoints at most once per 60 seconds. The local access token is used only
  in the outbound Authorization header. Only normalized percentages, reset
  times, plan label, and observation time are persisted in
  `~/.agent-mission-control/kimi-quota.json` with owner-only permissions.
- Unless `AMC_GROK_QUOTA=0` is set, a detected Cindy xAI login may be used to
  call `https://cli-chat-proxy.grok.com/v1/settings` and
  `https://cli-chat-proxy.grok.com/v1/billing?format=credits` at most once per
  60 seconds. The access token is held only in process memory. Only plan name,
  weekly percentage, reset time, product percentages, balance, and observation
  time are persisted in `~/.agent-mission-control/grok-quota.json` with
  owner-only permissions.
- If the optional Bailian Chrome bridge is installed, Chrome loads the
  Bailian "My subscriptions" page in an inactive tab every five minutes using
  the browser's existing login. It sends only plan label, seven-day usage
  percentage, reset time, expiry time, and observation time to
  `http://127.0.0.1:4629`; no credential is sent to Agent Mission Control.

File watching:

- The local server can watch provider state directories such as `~/.codex`,
  `~/.codex/sessions`, `~/.claude/projects`, Claude Desktop metadata/cache
  folders, OpenCode Desktop state, Cindy, and Kimi's `kimi-agent` cache. Agent
  Mission Control's own notification store is deliberately excluded so a
  refresh cannot trigger itself.
- The local server may also watch
  `~/.agent-mission-control/bailian-quota.json` so a new browser-bridge sample
  can invalidate the dashboard snapshot.
- Watchers only mark the in-process snapshot as dirty and notify connected
  local browser clients over `/api/events` at a bounded rate; they do not upload
  file contents or force clients to bypass a still-warm snapshot.
- Missing provider directories are ignored. A periodic browser refresh remains
  the fallback when a platform or filesystem cannot provide recursive watch
  events reliably.

Performance checkpoints:

- `~/.agent-mission-control/codex-work-metrics-v1.json` stores a bounded local
  checkpoint for long-rollout governance scans: aggregate counters, rollout
  path/file signature, and the processed byte offset. It does not store full
  rollout events, message text, or tool arguments.
- `~/.agent-mission-control/kimi-quota.json` stores only the last normalized
  Kimi quota sample so the dashboard can show a clearly marked stale value
  when the client login or network is temporarily unavailable. It contains no
  access token, refresh token, account id, or raw API response.
- `~/.agent-mission-control/grok-quota.json` stores only the last normalized
  Grok plan and weekly quota sample. It contains no access token, refresh
  token, owner id, account fingerprint, or raw API response.
- `~/.agent-mission-control/bailian-quota.json` stores only the last sanitized
  Bailian plan label, seven-day used/available percentages, reset time, plan
  expiry time, and observation time with owner-only permissions. The local
  endpoint accepts only Chrome-extension origins and a strict field whitelist.
- The checkpoint lets a restarted server continue from appended bytes instead
  of rereading the complete rollout history.

Review workflow:

- When you start a review job, Agent Mission Control sends the selected
  thread's current preview content to another local CLI Agent such as Codex
  CLI, Claude Code CLI, or OpenCode CLI.
- The P0 review input is the recent Agent output signal already shown in the
  dashboard. It does not read complete provider transcripts or write back to
  Codex, OpenCode, or Claude state.
- The `thread-summary` review input sends a bounded summary built from the
  current thread's standard Mission Control fields plus recent user/Agent
  signals. It does not read provider transcript files.
- The `latest-turn` review input can read more local session content. In P1 it
  is supported for Codex threads with an explicit `rolloutPath`; Mission
  Control starts with a bounded tail of that JSONL file and can progressively
  expand the read when a long final answer hides the matching user message.
  The extracted prompt content remains capped before it is sent to the target
  CLI Agent. Malformed JSONL lines are ignored.
- Claude Code and OpenCode `latest-turn` inputs return an explicit unavailable
  error unless Mission Control has a stable transcript path or export source.
  The app does not guess private provider cache locations for this mode.
- Review job metadata and results are stored only in Agent Mission Control's
  own local state file: `~/.agent-mission-control/reviews.jsonl`.
- Search metadata is stored only in Agent Mission Control's local SQLite index:
  `~/.agent-mission-control/search-index.sqlite`.
- The review debug summary is generated from stored job metadata such as job
  id, source, target, input mode, status, error, and stderr. It does not include
  the full prompt or full review result.
- Fix Loop metadata records only local workflow status and timestamps, such as
  whether a fix prompt was copied, the source thread was opened, or the review
  was marked applied/dismissed. It does not write to Codex, Claude, or OpenCode
  conversation databases.
- Future complete-transcript review modes would expand local data exposure
  beyond P1 and should require an explicit confirmation before sending that
  larger content to a target CLI Agent.

Prompt Pack workflow:

- Prompt Pack is a local drafting tool. It does not send content to Codex,
  Claude, OpenCode, or any external service by itself.
- Images pasted from the clipboard and files selected in the browser are copied
  into `~/.agent-mission-control/prompt-packs/<pack-id>/attachments/`.
- The copied Markdown package references those attachments by local absolute
  path. The receiving Agent only sees the attachment content if you paste the
  package into that Agent and the Agent can read the referenced local files.
- Clearing the browser draft removes the visible pack metadata from
  `localStorage`; it does not automatically delete attachment files already
  copied under `~/.agent-mission-control/prompt-packs`.

What it avoids:

- Writing to Codex, OpenCode, or Claude state
- Automatically archiving, deleting, moving, or otherwise mutating candidate
  threads from Portfolio Cleanup; the workspace only copies or downloads a
  dry-run Markdown checklist after an explicit user action
- Publishing data externally
- Logging or exposing Codex/ChatGPT access tokens
- Caching dashboard API payloads in the PWA service worker
- Caching local image previews or search API payloads in the PWA service worker
- Embedding Prompt Pack attachment bytes or base64 file contents into copied
  Markdown prompts
- Sending desktop/system notifications in the public release

Keep `HOST` at the default `127.0.0.1` unless you fully understand the privacy
tradeoff. Binding the server to a LAN or public interface can expose local
agent metadata to other machines.
