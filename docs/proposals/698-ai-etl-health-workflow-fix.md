# Proposal: Fix ai-etl-health.yml turn exhaustion (Issue #698)

**Status**: Pending human commit (D-029 constraint — AI worker cannot write under `.github/workflows/`)

**Owner action required**: Copy the YAML below into `.github/workflows/ai-etl-health.yml` and commit.

## Changes

- Removed `Load knowledge bundle` step and its `${{ steps.load-knowledge.outputs.bundle }}` prompt reference. The ETL health agent reads source files directly and does not need ~7K tokens of retail/wholesale business rules.
- Increased `--max-turns` from 15 to 25 to give the agent sufficient budget for 4 audit areas across multiple files.

## Proposed `.github/workflows/ai-etl-health.yml`

```yaml
name: AI ETL Health Monitor
on:
  schedule:
    - cron: "0 8 * * 1-5"
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  health-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Use role-specific CLAUDE.md
        run: |
          cp .claude-contexts/audit.md CLAUDE.md
          # Hide the swap from git so workflows that commit/push
          # (worker, address-feedback, ci-remediation) don't sweep
          # it into commits, and `git rebase` (mergeability) isn't
          # blocked by an uncommitted tracked-file change.
          git update-index --skip-worktree CLAUDE.md

      - name: ETL Health Check
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: "--model claude-haiku-4-5-20251001 --max-turns 25"
          prompt: |
            You are the ETL Health Monitor. Check the health of the data pipeline.

            ## Checks to perform
            1. **Review ETL code** for potential issues:
               - Read etl/main.py and etl/sync/*.py
               - Check for error handling gaps
               - Verify connection retry logic
               - Check that all sync modules are registered in main.py

            2. **Review schema consistency**:
               - Read etl/schema/init.sql
               - Verify all ps_* tables have proper indexes
               - Check that FK constraints reference valid tables

            3. **Review ETL sync strategy**:
               - Read docs/etl-sync-strategy.md
               - Check that documented delta fields match code implementations
               - Verify watermark logic is correct

            4. **Check Docker health**:
               - Read docker-compose.yml
               - Verify ETL service has proper health checks
               - Check environment variable references

            ## Output
            If issues found, create ONE issue with title prefix `[etl-health]`:
            - List all findings grouped by severity
            - Include file paths and line numbers
            - Suggest fixes

            If everything looks healthy, do NOT create an issue. Silence is golden.
```
