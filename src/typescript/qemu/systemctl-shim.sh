#!/bin/bash
# systemctl shim — emulates select systemctl commands when systemd is not PID 1.
# Baked into container images at /usr/local/bin/systemctl.
# When systemd IS PID 1 (QEMU path), passes through to /usr/bin/systemctl.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Detection gate — if systemd is PID 1, pass through to real systemctl
# ---------------------------------------------------------------------------
detect_systemd() {
    local pid1
    pid1="$(readlink /proc/1/exe 2>/dev/null || true)"
    local comm1
    comm1="$(cat /proc/1/comm 2>/dev/null || true)"
    if [ "$pid1" = "/usr/lib/systemd/systemd" ] || [ "$pid1" = "/lib/systemd/systemd" ] || [ "$comm1" = "systemd" ]; then
        return 0
    fi
    return 1
}

if detect_systemd; then
    exec /usr/bin/systemctl "$@"
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
PREFIX="[systemctl-shim]"
log()  { echo "$PREFIX" "$@" >&2; }
warn() { echo "$PREFIX WARN:" "$@" >&2; }

# ---------------------------------------------------------------------------
# State directory
# ---------------------------------------------------------------------------
STATEDIR="${STATEDIR:-/run/systemctl}"
mkdir -p "$STATEDIR"/{enabled,pids,logs,exited}

# ---------------------------------------------------------------------------
# Unit file search
# ---------------------------------------------------------------------------
SEARCH_PATHS=("/etc/systemd/system" "/run/systemd/system" "/usr/lib/systemd/system")

find_unit() {
    local name="$1"
    # Append .service if no extension
    if [[ "$name" != *.* ]]; then
        name="${name}.service"
    fi
    for dir in "${SEARCH_PATHS[@]}"; do
        local path="${dir}/${name}"
        if [ -f "$path" ]; then
            echo "$path"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Unit file parser (INI-style)
# ---------------------------------------------------------------------------
# Outputs: key=value lines to stdout. Caller evals or reads.
# We accumulate variables prefixed by _U_ to avoid namespace pollution.
parse_unit() {
    local path="$1"
    local section=""
    # Reset variables
    unset _U_Type _U_ExecStart _U_ExecStartPre _U_User _U_Group
    unset _U_WorkingDirectory _U_Restart _U_RestartSec _U_RemainAfterExit
    unset _U_ConditionPathExists _U_TimeoutStopSec
    _U_Environment=()
    _U_ExecStartPre=()

    _U_Type="simple"
    _U_Restart="no"
    _U_RestartSec="5"
    _U_TimeoutStopSec="10"

    while IFS= read -r line || [ -n "$line" ]; do
        # Strip comments and whitespace
        line="${line%%#*}"
        line="${line## }"
        line="${line%% }"
        [ -z "$line" ] && continue

        # Section header
        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi

        # Key=value
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$ ]]; then
            local key="${BASH_REMATCH[1]}"
            local val="${BASH_REMATCH[2]}"

            # Handle continuation lines not needed here — read line-by-line is enough
            # Handle section filtering
            case "$section" in
                Service)
                    case "$key" in
                        Type)              _U_Type="$val" ;;
                        ExecStart)         _U_ExecStart="$val" ;;
                        ExecStartPre)      _U_ExecStartPre+=("$val") ;;
                        User)              _U_User="$val" ;;
                        Group)             _U_Group="$val" ;;
                        WorkingDirectory)  _U_WorkingDirectory="$val" ;;
                        Environment)       _U_Environment+=("$val") ;;
                        Restart)           _U_Restart="$val" ;;
                        RestartSec)        _U_RestartSec="$val" ;;
                        RemainAfterExit)   _U_RemainAfterExit="$val" ;;
                        TimeoutStopSec)    _U_TimeoutStopSec="$val" ;;
                    esac
                    ;;
                Unit)
                    case "$key" in
                        ConditionPathExists) _U_ConditionPathExists="$val" ;;
                    esac
                    ;;
            esac
        fi
    done < "$path"
}

# ---------------------------------------------------------------------------
# ConditionPathExists check
# ---------------------------------------------------------------------------
check_condition() {
    local cond="${1:-}"
    [ -z "$cond" ] && return 0  # no condition → pass

    # Handle negation: ConditionPathExists=!/some/path
    if [[ "$cond" == \!* ]]; then
        local path="${cond#!}"
        if [ -e "$path" ]; then
            log "ConditionPathExists=!${path}: path exists, skipping"
            return 1
        fi
    else
        if [ ! -e "$cond" ]; then
            log "ConditionPathExists=${cond}: path missing, skipping"
            return 1
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Build and run command for a service
# ---------------------------------------------------------------------------
run_service_command() {
    local cmd="$1"
    shift
    local -a env_vars=("${_U_Environment[@]}")
    local user="${_U_User:-}"
    local group="${_U_Group:-${user}}"
    local wd="${_U_WorkingDirectory:-}"

    # Build command with env/working-dir prefix
    local env_prefix=""
    for e in "${env_vars[@]}"; do
        env_prefix="${env_prefix}export ${e}; "
    done

    local wd_prefix=""
    [ -n "$wd" ] && wd_prefix="cd ${wd} && "

    local full_cmd="${env_prefix}${wd_prefix}${cmd}"

    if [ -n "$user" ]; then
        # Try sudo first, fall back to su
        if command -v sudo >/dev/null 2>&1; then
            if [ -n "$group" ]; then
                sudo -u "$user" -g "$group" bash -c "$full_cmd" &
            else
                sudo -u "$user" bash -c "$full_cmd" &
            fi
        elif command -v su >/dev/null 2>&1; then
            su -s /bin/bash "$user" -c "$full_cmd" &
        else
            warn "Neither sudo nor su available, running as root"
            bash -c "$full_cmd" &
        fi
    else
        bash -c "$full_cmd" &
    fi
    echo $!
}

# ---------------------------------------------------------------------------
# Start a oneshot service
# ---------------------------------------------------------------------------
start_oneshot() {
    local unit="$1" unit_name="$2" no_block="$3"

    # Run ExecStartPre commands first
    for pre in "${_U_ExecStartPre[@]}"; do
        log "Running ExecStartPre for ${unit_name}: ${pre}"
        if ! bash -c "$pre"; then
            log "ExecStartPre failed for ${unit_name}"
            return 1
        fi
    done

    local cmd="${_U_ExecStart}"
    if [ -z "$cmd" ]; then
        warn "No ExecStart defined for ${unit_name}"
        return 1
    fi

    log "Starting ${unit_name} (oneshot)"

    if [ "$no_block" = "true" ]; then
        log "  (no-block, running in background)"
        (
            bash -c "$cmd"
            local rc=$?
            log "${unit_name} completed with exit code ${rc}"
            # RemainAfterExit marker
            if [ "${_U_RemainAfterExit:-no}" = "yes" ] || [ "${_U_RemainAfterExit:-no}" = "true" ]; then
                echo "$rc" > "$STATEDIR/exited/${unit_name}"
            fi
        ) &
        echo $! > "$STATEDIR/pids/${unit_name}"
    else
        bash -c "$cmd"
        local rc=$?
        log "${unit_name} completed with exit code ${rc}"
        if [ "${_U_RemainAfterExit:-no}" = "yes" ] || [ "${_U_RemainAfterExit:-no}" = "true" ]; then
            echo "$rc" > "$STATEDIR/exited/${unit_name}"
        fi
        return $rc
    fi
}

# ---------------------------------------------------------------------------
# Start a simple service (long-running, with optional restart loop)
# ---------------------------------------------------------------------------
start_simple() {
    local unit="$1" unit_name="$2"

    # Run ExecStartPre commands first
    for pre in "${_U_ExecStartPre[@]}"; do
        log "Running ExecStartPre for ${unit_name}: ${pre}"
        if ! bash -c "$pre"; then
            log "ExecStartPre failed for ${unit_name}"
            return 1
        fi
    done

    local cmd="${_U_ExecStart}"
    if [ -z "$cmd" ]; then
        warn "No ExecStart defined for ${unit_name}"
        return 1
    fi

    local restart="${_U_Restart:-no}"
    local restart_sec="${_U_RestartSec:-5}"

    log "Starting ${unit_name} (simple)"

    (
        while true; do
            local pid
            pid="$(run_service_command "$cmd")"
            echo "$pid" > "$STATEDIR/pids/${unit_name}"
            wait "$pid" 2>/dev/null || true
            local rc=$?
            case "$restart" in
                always)
                    log "${unit_name} exited (rc=${rc}), restarting in ${restart_sec}s"
                    sleep "${restart_sec}"
                    ;;
                on-failure)
                    if [ "$rc" -ne 0 ]; then
                        log "${unit_name} failed (rc=${rc}), restarting in ${restart_sec}s"
                        sleep "${restart_sec}"
                    else
                        log "${unit_name} exited cleanly, not restarting (on-failure)"
                        exit 0
                    fi
                    ;;
                *)
                    log "${unit_name} exited (rc=${rc}), not restarting"
                    exit 0
                    ;;
            esac
        done
    ) &
    local wrapper_pid=$!
    echo "$wrapper_pid" > "$STATEDIR/pids/${unit_name}"
    log "  PID ${wrapper_pid}"
}

# ---------------------------------------------------------------------------
# Stop a service
# ---------------------------------------------------------------------------
stop_service() {
    local unit_name="$1"
    local pid_file="$STATEDIR/pids/${unit_name}"
    local timeout="${_U_TimeoutStopSec:-10}"

    if [ ! -f "$pid_file" ]; then
        log "${unit_name}: not running (no PID file)"
        return 0
    fi

    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -z "$pid" ]; then
        rm -f "$pid_file"
        return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
        log "${unit_name}: PID ${pid} already gone"
        rm -f "$pid_file"
        return 0
    fi

    log "Stopping ${unit_name} (PID ${pid})"
    kill -TERM "$pid" 2>/dev/null || true

    # Wait with timeout
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$timeout" ]; do
        sleep 0.5
        waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        log "${unit_name}: didn't stop, sending SIGKILL"
        kill -KILL "$pid" 2>/dev/null || true
        sleep 0.5
    fi

    rm -f "$pid_file"
    rm -f "$STATEDIR/exited/${unit_name}"
    log "${unit_name}: stopped"
}

# ---------------------------------------------------------------------------
# Status helpers
# ---------------------------------------------------------------------------
service_pid() {
    local unit_name="$1"
    if [ -f "$STATEDIR/pids/${unit_name}" ]; then
        cat "$STATEDIR/pids/${unit_name}" 2>/dev/null || true
    fi
}

service_running() {
    local pid
    pid="$(service_pid "$1")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    return 1
}

service_exited() {
    if [ -f "$STATEDIR/exited/${1}" ]; then
        return 0
    fi
    return 1
}

# ---------------------------------------------------------------------------
# Main command dispatcher
# ---------------------------------------------------------------------------
COMMAND="${1:-}"
shift || true

case "$COMMAND" in
    daemon-reload)
        log "daemon-reload: no-op (no systemd)"
        exit 0
        ;;

    enable)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl enable <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            echo "Failed to enable unit: Unit file ${UNIT} not found." >&2
            exit 1
        fi
        UNIT_NAME="$(basename "$UNIT_FILE")"
        touch "$STATEDIR/enabled/${UNIT_NAME}"
        echo "Created symlink /etc/systemd/system/multi-user.target.wants/${UNIT_NAME} → ${UNIT_FILE}"
        exit 0
        ;;

    disable)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl disable <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            UNIT_NAME="$UNIT"
            [[ "$UNIT_NAME" != *.* ]] && UNIT_NAME="${UNIT_NAME}.service"
        else
            UNIT_NAME="$(basename "$UNIT_FILE")"
        fi
        rm -f "$STATEDIR/enabled/${UNIT_NAME}"
        echo "Removed /etc/systemd/system/multi-user.target.wants/${UNIT_NAME}."
        exit 0
        ;;

    start)
        NO_BLOCK="false"
        if [ "${1:-}" = "--no-block" ]; then
            NO_BLOCK="true"
            shift
        fi
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl start [--no-block] <unit>" >&2; exit 1; }

        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            echo "Failed to start ${UNIT}: Unit not found." >&2
            exit 1
        fi
        UNIT_NAME="$(basename "$UNIT_FILE")"

        # Already running?
        if service_running "$UNIT_NAME"; then
            log "${UNIT_NAME} already running"
            exit 0
        fi

        parse_unit "$UNIT_FILE"

        # Check condition
        if ! check_condition "${_U_ConditionPathExists:-}"; then
            exit 0
        fi

        case "${_U_Type:-simple}" in
            oneshot)
                start_oneshot "$UNIT_FILE" "$UNIT_NAME" "$NO_BLOCK"
                ;;
            simple|forking)
                start_simple "$UNIT_FILE" "$UNIT_NAME"
                ;;
            *)
                warn "Unknown service type: ${_U_Type}, treating as simple"
                start_simple "$UNIT_FILE" "$UNIT_NAME"
                ;;
        esac
        exit 0
        ;;

    stop)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl stop <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            UNIT_NAME="$UNIT"
            [[ "$UNIT_NAME" != *.* ]] && UNIT_NAME="${UNIT_NAME}.service"
        else
            UNIT_NAME="$(basename "$UNIT_FILE")"
        fi
        # Parse unit to get timeout
        if [ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ]; then
            parse_unit "$UNIT_FILE"
        fi
        stop_service "$UNIT_NAME"
        exit 0
        ;;

    is-active)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl is-active <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            UNIT_NAME="$UNIT"
            [[ "$UNIT_NAME" != *.* ]] && UNIT_NAME="${UNIT_NAME}.service"
        else
            UNIT_NAME="$(basename "$UNIT_FILE")"
        fi

        if service_running "$UNIT_NAME"; then
            echo "active"
            exit 0
        fi
        if service_exited "$UNIT_NAME"; then
            echo "active"
            exit 0
        fi
        echo "inactive"
        exit 3
        ;;

    is-enabled)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl is-enabled <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            UNIT_NAME="$UNIT"
            [[ "$UNIT_NAME" != *.* ]] && UNIT_NAME="${UNIT_NAME}.service"
        else
            UNIT_NAME="$(basename "$UNIT_FILE")"
        fi

        if [ -f "$STATEDIR/enabled/${UNIT_NAME}" ]; then
            echo "enabled"
            exit 0
        fi
        echo "disabled"
        exit 1
        ;;

    status)
        UNIT="${1:-}"
        [ -z "$UNIT" ] && { echo "Usage: systemctl status <unit>" >&2; exit 1; }
        UNIT_FILE="$(find_unit "$UNIT" || true)"
        if [ -z "$UNIT_FILE" ]; then
            UNIT_NAME="$UNIT"
            [[ "$UNIT_NAME" != *.* ]] && UNIT_NAME="${UNIT_NAME}.service"
        else
            UNIT_NAME="$(basename "$UNIT_FILE")"
        fi

        echo "● ${UNIT_NAME} - systemctl shim (no systemd)"
        if service_running "$UNIT_NAME"; then
            PID="$(service_pid "$UNIT_NAME")"
            echo "   Active: active (running) since $(date)"
            echo "   Main PID: ${PID}"
        elif service_exited "$UNIT_NAME"; then
            echo "   Active: active (exited) since $(date)"
        else
            echo "   Active: inactive (dead)"
        fi
        if [ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ]; then
            echo "   Unit: ${UNIT_FILE}"
        fi
        exit 0
        ;;

    --version|version)
        echo "systemctl-shim 1.0 (container mode)"
        exit 0
        ;;

    *)
        # Catch-all: try real systemctl
        if command -v /usr/bin/systemctl >/dev/null 2>&1; then
            exec /usr/bin/systemctl "$COMMAND" "$@"
        fi
        echo "Unsupported systemctl command: ${COMMAND}" >&2
        exit 1
        ;;
esac
