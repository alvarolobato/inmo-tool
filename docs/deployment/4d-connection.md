# 4D Database Connection

The ETL reads from a PowerShop ERP running on 4D v18.0.6 (compiled mode). It connects via the P4D SQL driver on port 19812. The ETL is read-only — it never writes to the 4D database.

## Network requirements

The Docker host machine must be able to reach the 4D server on:

| Port | Protocol | Purpose |
|------|----------|---------|
| 19812 | TCP | P4D SQL driver (required for ETL) |

Check connectivity before starting the stack:

```bash
# Linux/macOS
nc -zv <P4D_HOST> 19812

# Windows
Test-NetConnection -ComputerName <P4D_HOST> -Port 19812
```

## Configuration in .env

```env
P4D_HOST=192.168.1.100    # 4D server hostname or IP
P4D_PORT=19812            # P4D SQL port (default: 19812)
P4D_USER=your_user        # 4D SQL username
P4D_PASSWORD=your_pass    # 4D SQL password
```

The installer prompts for these values. To change them later:

```bash
# Linux/macOS: interactive reconfigure
ps-analytics setup

# Windows (PowerShell): delete .env and rerun the installer
Remove-Item "$env:APPDATA\powershop-analytics\.env"
irm https://github.com/alvarolobato/powershop-analytics/releases/latest/download/install.ps1 | iex

# Or edit .env directly on any platform, then restart:
ps-analytics restart
```

## Starting the 4D SQL server

The 4D SQL server is **not started automatically** — it must be enabled in the 4D Server administration console before the ETL can connect.

In 4D Server:
1. Open **Server Administration** window
2. Go to **SQL Server** section
3. Start the SQL server (it listens on port 19812 by default)

This only needs to be done once; the SQL server persists across 4D Server restarts if configured to auto-start.

## Testing the connection

Run a one-off ETL sync and watch the logs:

```bash
ps-analytics etl run
ps-analytics etl logs
```

A successful connection shows sync progress per table. A failure shows a connection error immediately.

## Troubleshooting

**Connection refused / timeout**

- Verify `P4D_HOST` is reachable from the Docker host (see `nc`/`Test-NetConnection` above).
- Confirm the 4D SQL server is running in the 4D Server admin console.
- Check firewall rules — port 19812 must be open between the Docker host and the 4D server.
- On Windows, Windows Firewall may block the port even on a LAN.

**Authentication failure**

- Double-check `P4D_USER` and `P4D_PASSWORD` in `.env`.
- The 4D SQL user must have read access to the relevant tables.
- 4D SQL users are managed separately from 4D Designer/runtime users.

**Slow queries / timeouts during sync**

- The 4D server may be under load from ERP users during business hours.
- The ETL runs nightly at `ETL_CRON_HOUR` (default: 2 AM) to avoid contention.
- If timeouts occur consistently, first check 4D Server performance. Changing ETL query timeouts is not configurable via `.env` in the stock `alobato/powershop-etl` image; it requires building or pinning a custom ETL image with adjusted settings in `etl/config.py`.

**SQL feature not available (compiled mode)**

4D v18.0.6 in compiled mode has SQL limitations. Some advanced SQL constructs are not available. The ETL is written to work within these constraints. If you add custom queries, test against the actual 4D server.

## Read-only guarantee

The ETL only issues `SELECT` statements. The CLI (`ps sql query`) is intended for read-only use and will refuse queries whose trimmed text begins with `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, or `TRUNCATE`, but this safeguard is not comprehensive; you must not run statements that modify data. There is no write path to the 4D database in the ETL.
