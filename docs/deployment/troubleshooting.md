# Troubleshooting

Items marked **[Prod-applicable]** also apply to the production deployment — they are linked from [production.md](production.md#troubleshooting).

---

## Prod-applicable issues

### Container won't start **[Prod-applicable]**

Check the logs for the failing service:

```bash
# Local dev:
ps-analytics logs <service>

# Production (from your local Mac):
ps prod logs <service>
```

Common causes:

- **Missing `.env` variable** — the ETL or WrenAI service will exit immediately if a required variable is empty. Check that `P4D_HOST`, `P4D_USER`, `P4D_PASSWORD`, `OPENROUTER_API_KEY`, and `POSTGRES_PASSWORD` are set in `.env`.
- **Port conflict** — if port 3000 or 5432 is in use by another process, the container will fail to bind. Change `HOST_PORT` or `AI_SERVICE_FORWARD_PORT` in `.env`, then `ps-analytics restart` (local dev) or `ps prod restart` (prod). For PostgreSQL, you can change the host port mapping in `docker-compose.yml`.
- **Docker not running** — start Docker Desktop (macOS) or the Docker daemon (Linux), then re-run the command.

### ETL fails to connect to 4D **[Prod-applicable]**

```bash
ps-analytics etl logs
# or on prod: ps prod logs etl
# Look for: connection refused, timeout, authentication failed
```

- **Firewall** — port 19812 must be open from the Docker host to the 4D server. Test with `nc -zv <P4D_HOST> 19812`.
- **4D SQL server not running** — must be started manually in the 4D Server admin console. See [4d-connection.md](4d-connection.md#starting-the-4d-sql-server).
- **Wrong credentials** — re-check `P4D_HOST`, `P4D_USER`, `P4D_PASSWORD` in `.env`.

### ETL hangs or times out **[Prod-applicable]**

- The 4D server may be busy during business hours. The default schedule runs at 2 AM for this reason.
- For large initial syncs (8+ million rows), the ETL can take 30–60 minutes. Let it run.
- If it consistently stalls on a specific table, check 4D Server performance and network stability.

### WrenAI UI blank or loading **[Prod-applicable]**

Allow 1–2 minutes after startup — several services must start in order. If the UI is still blank after 3 minutes:

```bash
# Local dev:
ps-analytics logs wren-ui
ps-analytics logs wren-ai-service
ps-analytics logs bootstrap

# Production:
ps prod logs wren-ui
ps prod logs wren-ai-service
```

- **Bootstrap not finished** — the `bootstrap` container initialises the shared `./data/wren` volume. It must complete before `wren-engine` and `wren-ui` are usable.
- **wren-ui crash** — look for `SQLITE_ERROR` or missing config. Try restarting.

### LLM queries return errors **[Prod-applicable]**

- **Invalid API key** — verify `OPENROUTER_API_KEY` in `.env`. Test at [openrouter.ai](https://openrouter.ai).
- **Model not available** — the model specified in `WREN_LLM_MODEL` may not be available on your OpenRouter account. Check the [OpenRouter models page](https://openrouter.ai/models).
- **Rate limits** — OpenRouter enforces per-minute and per-day rate limits. Check your usage dashboard.
- **Timeout** — complex queries can exceed the 120s LLM timeout in `wren-config.yaml`. Simplify the question or increase `timeout` in the config.

### Disk space **[Prod-applicable]**

Docker images and data volumes grow over time.

```bash
# Check Docker disk usage
docker system df

# Clean up unused images and stopped containers (safe)
docker system prune

# Check data directory size
du -sh ~/powershop/data/    # production
du -sh ./data/              # local dev
```

The `./data/postgres` directory grows as more data is synced. The `./data/qdrant` directory grows as WrenAI indexes schema and query history.

---

## Local dev only

### Data not showing in WrenAI

1. Confirm the ETL has run: `ps-analytics etl status`. If no tables appear, run `ps-analytics etl run`.
2. Confirm the data source is configured in WrenAI — see [wren-setup.md](wren-setup.md#configure-the-data-source).
3. After setting up the data source, WrenAI needs to index the schema. Allow a few minutes.

### Windows-specific

- **Docker Desktop must be running** before any `ps-analytics` command. Start it from the system tray.
- **WSL2 backend is recommended** — use Settings > General > "Use the WSL 2 based engine" in Docker Desktop.
- **Memory limits** — Docker Desktop defaults to 2 GB RAM on Windows. The full stack needs at least 4 GB. Increase in Settings > Resources > Memory.
- **PATH not updated** — after install, restart your terminal (or open a new PowerShell window) for `ps-analytics` to be found.
- **Execution policy** — if the install script is blocked, run: `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`

---

## Getting help

Open an issue at [github.com/alvarolobato/powershop-analytics](https://github.com/alvarolobato/powershop-analytics/issues). Include:
- Output of `ps-analytics version` (local) or `ps prod version` (prod)
- Output of `ps-analytics status` (local) or `ps prod status` (prod)
- Relevant log lines from `ps-analytics logs <service>` or `ps prod logs <service>`
