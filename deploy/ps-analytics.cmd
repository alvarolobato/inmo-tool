@echo off
:: PowerShop Analytics — Windows CLI wrapper
:: Manages the self-hosted analytics stack via docker compose.
::
:: Usage: ps-analytics <command> [args]
::
:: Installation: run deploy/install.ps1 — it places this file in
::               %LOCALAPPDATA%\powershop-analytics\ and adds it to PATH.
::
setlocal EnableDelayedExpansion

:: ---------------------------------------------------------------------------
:: Project directory
:: ---------------------------------------------------------------------------
if defined PS_ANALYTICS_HOME (
    set "PROJECT_DIR=%PS_ANALYTICS_HOME%"
) else (
    set "PROJECT_DIR=%APPDATA%\powershop-analytics"
)

set "ENV_FILE=%PROJECT_DIR%\.env"
set "COMPOSE_FILE=%PROJECT_DIR%\docker-compose.yml"
set "VERSION_FILE=%PROJECT_DIR%\.version"
set "REPO=alvarolobato/powershop-analytics"
set "API_BASE=https://api.github.com/repos/%REPO%"
set "RELEASE_BASE=https://github.com/%REPO%/releases/download"

:: ---------------------------------------------------------------------------
:: Dispatch
:: ---------------------------------------------------------------------------
set "CMD=%~1"
if "%CMD%"=="" set "CMD=help"

if /i "%CMD%"=="up"      goto :cmd_up
if /i "%CMD%"=="down"    goto :cmd_down
if /i "%CMD%"=="restart" goto :cmd_restart
if /i "%CMD%"=="status"  goto :cmd_status
if /i "%CMD%"=="logs"    goto :cmd_logs
if /i "%CMD%"=="etl"     goto :cmd_etl
if /i "%CMD%"=="update"  goto :cmd_update
if /i "%CMD%"=="destroy" goto :cmd_destroy
if /i "%CMD%"=="open"    goto :cmd_open
if /i "%CMD%"=="version" goto :cmd_version
if /i "%CMD%"=="help"    goto :cmd_help
if /i "%CMD%"=="-h"      goto :cmd_help
if /i "%CMD%"=="--help"  goto :cmd_help

echo [WARN]  Unknown command: %CMD%
goto :cmd_help

:: ---------------------------------------------------------------------------
:: Helpers
:: ---------------------------------------------------------------------------
:require_project_dir
    if not exist "%PROJECT_DIR%" (
        echo [ERROR] Project directory not found: %PROJECT_DIR%
        echo         Run the installer first.
        exit /b 1
    )
    if not exist "%COMPOSE_FILE%" (
        echo [ERROR] docker-compose.yml not found in %PROJECT_DIR%. Re-run the installer.
        exit /b 1
    )
    if not exist "%ENV_FILE%" (
        echo [ERROR] .env not found in %PROJECT_DIR%. Run: ps-analytics setup
        exit /b 1
    )
    exit /b 0

:dc
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" %*
    exit /b %ERRORLEVEL%

:load_env_var
    :: Load a single variable from .env file
    :: Usage: call :load_env_var VAR_NAME
    for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
        if "%%A"=="%~1" set "%~1=%%B"
    )
    exit /b 0

:: ---------------------------------------------------------------------------
:cmd_up
    call :require_project_dir || exit /b 1
    echo [INFO]  Starting stack...
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" up -d
    echo [OK]    Stack started. Run: ps-analytics status
    goto :end

:cmd_down
    call :require_project_dir || exit /b 1
    echo [INFO]  Stopping stack...
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" down
    echo [OK]    Stack stopped.
    goto :end

:cmd_restart
    call :require_project_dir || exit /b 1
    echo [INFO]  Restarting stack...
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" restart
    echo [OK]    Stack restarted.
    goto :end

:cmd_status
    call :require_project_dir || exit /b 1
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" ps
    call :load_env_var HOST_PORT
    if "%HOST_PORT%"=="" set "HOST_PORT=3000"
    echo.
    echo [INFO]  WrenAI UI: http://localhost:%HOST_PORT%
    goto :end

:cmd_logs
    call :require_project_dir || exit /b 1
    set "SERVICE=%~2"
    if "%SERVICE%"=="" (
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" logs -f
    ) else (
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" logs -f "%SERVICE%"
    )
    goto :end

:cmd_etl
    call :require_project_dir || exit /b 1
    set "SUBCMD=%~2"
    if "%SUBCMD%"=="" set "SUBCMD=help"

    if /i "%SUBCMD%"=="run" (
        echo [INFO]  Running ETL sync (one-off)...
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" run --rm etl python -m etl.main --once
        goto :end
    )
    if /i "%SUBCMD%"=="status" (
        call :load_env_var POSTGRES_USER
        call :load_env_var POSTGRES_DB
        if "%POSTGRES_USER%"=="" set "POSTGRES_USER=postgres"
        if "%POSTGRES_DB%"=="" set "POSTGRES_DB=powershop"
        echo [INFO]  ETL watermarks:
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" exec -T postgres psql -U "%POSTGRES_USER%" -d "%POSTGRES_DB%" -c "SELECT table_name, last_value, updated_at FROM etl_watermarks ORDER BY table_name;"
        goto :end
    )
    if /i "%SUBCMD%"=="tables" (
        call :load_env_var POSTGRES_USER
        call :load_env_var POSTGRES_DB
        if "%POSTGRES_USER%"=="" set "POSTGRES_USER=postgres"
        if "%POSTGRES_DB%"=="" set "POSTGRES_DB=powershop"
        echo [INFO]  Row counts for synced tables:
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" exec -T postgres psql -U "%POSTGRES_USER%" -d "%POSTGRES_DB%" -c "SELECT schemaname, relname AS table_name, n_live_tup AS row_count FROM pg_stat_user_tables WHERE relname LIKE 'ps_%%' ORDER BY relname;"
        goto :end
    )
    if /i "%SUBCMD%"=="logs" (
        docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" logs -f etl
        goto :end
    )
    echo Usage: ps-analytics etl {run^|status^|tables^|logs}
    goto :end

:cmd_update
    call :require_project_dir || exit /b 1
    echo [INFO]  Checking for latest release...

    :: Get latest tag via GitHub API (requires curl or PowerShell)
    for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "(Invoke-RestMethod '%API_BASE%/releases/latest').tag_name" 2^>nul`) do set "LATEST=%%T"
    if "%LATEST%"=="" (
        echo [ERROR] Could not determine latest release.
        exit /b 1
    )

    set "CURRENT=unknown"
    if exist "%VERSION_FILE%" (
        set /p CURRENT=<"%VERSION_FILE%"
    )

    if "%LATEST%"=="%CURRENT%" (
        echo [OK]    Already on latest version: %LATEST%
        goto :end
    )

    echo [INFO]  Updating from %CURRENT% to %LATEST%...

    :: Download updated files
    powershell -NoProfile -Command "Invoke-WebRequest -Uri '%RELEASE_BASE%/%LATEST%/docker-compose.prod.yml' -OutFile '%PROJECT_DIR%\docker-compose.yml' -UseBasicParsing"
    powershell -NoProfile -Command "Invoke-WebRequest -Uri '%RELEASE_BASE%/%LATEST%/wren-config.yaml' -OutFile '%PROJECT_DIR%\wren-config.yaml' -UseBasicParsing"
    echo [OK]    Stack files updated

    :: Download updated CLI wrapper alongside current (rename on next launch)
    set "CLI_DIR=%LOCALAPPDATA%\powershop-analytics"
    powershell -NoProfile -Command "Invoke-WebRequest -Uri '%RELEASE_BASE%/%LATEST%/ps-analytics.cmd' -OutFile '%CLI_DIR%\ps-analytics.cmd' -UseBasicParsing"
    echo [OK]    CLI wrapper updated

    :: Pull images and restart
    echo [INFO]  Pulling updated images...
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" pull
    echo [INFO]  Restarting stack...
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" down
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" up -d

    echo %LATEST%>"%VERSION_FILE%"
    echo [OK]    Updated to %LATEST%
    goto :end

:cmd_destroy
    call :require_project_dir || exit /b 1
    echo [WARN]  This will STOP all containers and DELETE all data in %PROJECT_DIR%\data\
    echo [WARN]  This action is IRREVERSIBLE.
    set /p CONFIRM="  Type 'yes' to confirm: "
    if /i not "%CONFIRM%"=="yes" (
        echo [INFO]  Aborted.
        goto :end
    )
    docker compose -f "%COMPOSE_FILE%" --env-file "%ENV_FILE%" down -v
    rd /s /q "%PROJECT_DIR%\data" 2>nul
    echo [OK]    Stack destroyed and data removed.
    goto :end

:cmd_open
    call :require_project_dir || exit /b 1
    call :load_env_var HOST_PORT
    if "%HOST_PORT%"=="" set "HOST_PORT=3000"
    echo [INFO]  Opening http://localhost:%HOST_PORT%
    start http://localhost:%HOST_PORT%
    goto :end

:cmd_version
    set "VER=unknown"
    if exist "%VERSION_FILE%" set /p VER=<"%VERSION_FILE%"
    echo ps-analytics %VER%
    goto :end

:cmd_help
    echo PowerShop Analytics CLI (Windows)
    echo.
    echo Usage: ps-analytics ^<command^> [args]
    echo.
    echo Stack management:
    echo   up              Start all containers in the background
    echo   down            Stop all containers
    echo   restart         Restart all containers
    echo   status          Show container status and WrenAI UI port
    echo   logs [service]  Follow logs (optionally for a specific service)
    echo   open            Open WrenAI UI in browser
    echo.
    echo ETL operations:
    echo   etl run         Run a one-off ETL sync
    echo   etl status      Show watermark table (last sync per table)
    echo   etl tables      Show row counts for synced tables (ps_*)
    echo   etl logs        Follow ETL container logs
    echo.
    echo Maintenance:
    echo   update          Fetch latest release, update stack files, restart
    echo   destroy         Stop containers and delete all data (irreversible)
    echo   version         Print installed version
    echo   help            Print this help
    echo.
    echo Project directory: %PROJECT_DIR%
    goto :end

:end
endlocal
