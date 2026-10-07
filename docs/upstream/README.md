# Agent Mission Control archive

ASB is based on [Agent Mission Control 0.6.0](https://github.com/forxidian/agent-mission-control/releases/tag/v0.6.0) by forxidian. The original [MIT license](../../LICENSE) is unchanged. The upstream source and tests remain in this repository for credit, shared readers, and development context.

ASB has its own `1.0.0` release series and a smaller runtime. `npm start` launches ASB. `npm run desktop` launches the native ASB window. The retained upstream entry is [src/server.mjs](../../src/server.mjs).

The upstream dashboard includes Cindy, OpenCode, Cowork, token and quota views, artifacts, search, Prompt Pack, notifications, and explicit review jobs. Some of these paths read credentials or call external services. They are not enabled by ASB. Read [upstream privacy](PRIVACY.md) before running the upstream entry.

Retained records:

- [Upstream release 0.6.0](../releases/v0.6.0.md)
- [Upstream history in CHANGELOG.md](../../CHANGELOG.md#upstream-history)
- [Agent Review requirements](../agent-review-workflow-requirements.md)
- [Agent Review technical design](../agent-review-workflow-technical-design.md)
- [Agent Review implementation plan](../plans/2026-05-12-agent-review-workflow.md)
- [Agent Loop principles](../agent-loop-principles.md)
- [Thread artifact design brief](../thread-artifact-detail-brief.md)

The design records preserve upstream context. They are not current ASB requirements or proof of current CLI compatibility. Historical upstream screenshots use synthetic data and show the upstream dashboard, not ASB.
