# Third-party notices

ASB includes parts of the following software. Each part keeps its license.

## T3 Code

- Source: https://github.com/pingdotgg/t3code, commit `3cb16cf16509e74e2f483f541010996a9e6fac34`.
- Use: the token usage logic, ported to plain Node modules:
  - `apps/server/src/provider/Drivers/codexUsage.ts` -> `src/usage-codex.mjs`
  - `apps/server/src/provider/Drivers/claudeUsage.ts` -> `src/usage-claude.mjs`
  - `packages/provider-grok/src/server/usage.ts` -> `src/usage-grok.mjs`
  - `packages/provider-pi/src/server/usage.ts` -> `src/usage-pi.mjs`
  - `apps/server/src/provider/Drivers/antigravityUsageReader.ts` and `AntigravityUsage.ts` -> `src/usage-antigravity.mjs`
  - `packages/provider-opencode/src/server/usage.ts` (the tables and the dedupe) -> `src/usage-opencode.mjs`
  - `apps/server/src/usage/usagePricing.ts` -> `src/usage-pricing.mjs`
  - `apps/server/src/usage/usageAggregation.ts` -> `src/usage-aggregation.mjs`
  - `apps/server/src/usage/usageScanCache.ts` -> `src/usage-scan-cache.mjs`
  - `apps/server/src/usage/UsageService.ts` (the rate loading) -> `src/usage-rates.mjs`

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
