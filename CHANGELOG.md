# Changelog

## 0.2.0-experimental.13

- Added an experimental per-session switch that follows the selected DSH provider and model.
- Projects an authorized example into the first turn without writing the new session's example messages to its event history.
- Supports the tested OpenAI Chat Completions and DSH DeepSeek Messages mappings; other protocols may be unsupported.
- Publishes an authorized example, documented compatibility and limitations, and a curated synthetic test suite.
- **Known issue:** concurrent disable, reload, update, or removal can lose a claimed but uncommitted message or allow a request without the example. Earlier sessions with legacy references have additional migration limitations. Read the README before installation or maintenance.

Earlier development, experiments and validation boundaries are summarized in [the development record](docs/DEVELOPMENT.zh-CN.md).
