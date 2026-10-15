#!/usr/bin/env bash
set -euo pipefail
umask 077

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$app_dir/scripts/start-private-test.sh"
client="$app_dir/.local/tunnel-client"
profile_dir="$app_dir/.local/tunnel-profiles"
known_hosts="$app_dir/.local/known_hosts"
pid_file="$app_dir/.local/private-test.pid"
log_file="$app_dir/.local/private-test.log"
env_file="$app_dir/.local/tunnel.env"

managed_running() {
  [[ -f "$pid_file" ]] || return 1
  read -r managed_pid < "$pid_file"
  [[ "$managed_pid" =~ ^[0-9]+$ ]] && kill -0 "$managed_pid" 2>/dev/null || return 1
  [[ -r "/proc/$managed_pid/cmdline" ]] || return 1
  local args
  args="$(tr '\0' ' ' < "/proc/$managed_pid/cmdline")"
  [[ "$args" == *"$script _run"* ]]
}

load_key() {
  if [[ -z "${CONTROL_PLANE_API_KEY:-}" && -f "$env_file" ]]; then
    chmod 600 "$env_file"
    # This is a user-owned local shell environment file; never print its contents.
    source "$env_file"
  fi
  if [[ -z "${CONTROL_PLANE_API_KEY:-}" && -t 0 ]]; then
    read -r -s -p 'Platform 运行 API key（输入不显示）: ' CONTROL_PLANE_API_KEY
    printf '\n'
  fi
  if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
    printf '缺少 CONTROL_PLANE_API_KEY。请设置环境变量或填写 %s。\n' "$env_file" >&2
    return 1
  fi
  export CONTROL_PLANE_API_KEY
}

check_files() {
  if [[ ! -x "$client" || ! -f "$profile_dir/visa-helper-test.yaml" || ! -f "$known_hosts" ]]; then
    printf '本机 tunnel-client、配置或 SSH 主机密钥文件缺失。\n' >&2
    return 1
  fi
}

run_client() {
  check_files
  load_key
  mkdir -p "$app_dir/.local"
  exec 9>"$app_dir/.local/private-test.lock"
  flock -n 9 || { printf '后台服务已在运行。\n' >&2; return 1; }
  if curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    printf '8080 已有客户端运行，请先停止旧客户端再切换。\n' >&2
    return 1
  fi
  printf '%s\n' "$$" > "$pid_file"
  ssh_pid=''
  tunnel_pid=''
  cleanup() {
    trap - EXIT INT TERM
    if [[ -n "$tunnel_pid" ]]; then kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true; fi
    if [[ -n "$ssh_pid" ]]; then kill "$ssh_pid" 2>/dev/null || true; wait "$ssh_pid" 2>/dev/null || true; fi
    if [[ -f "$pid_file" && "$(cat "$pid_file")" == "$$" ]]; then rm -f "$pid_file"; fi
  }
  trap cleanup EXIT
  trap 'exit 0' INT TERM

  if [[ "$(curl -fsS --max-time 2 http://127.0.0.1:18081/ 2>/dev/null || true)" == 'Visa Helper MCP App prototype' ]]; then
    printf '复用已运行的 MCP SSH 转发。\n'
  else
    ssh -N -o BatchMode=yes -o ConnectTimeout=8 -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
      -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" \
      -L 127.0.0.1:18081:127.0.0.1:18081 ubuntu@129.204.29.242 9>&- &
    ssh_pid=$!
  fi

  local reachable=false
  for _ in {1..12}; do
    if [[ -n "$ssh_pid" ]] && ! kill -0 "$ssh_pid" 2>/dev/null; then
      printf 'SSH 转发启动失败。\n' >&2
      return 1
    fi
    if [[ "$(curl -fsS --max-time 2 http://127.0.0.1:18081/ 2>/dev/null || true)" == 'Visa Helper MCP App prototype' ]]; then
      reachable=true; break
    fi
    sleep 1
  done
  [[ "$reachable" == true ]] || { printf '无法通过 SSH 转发访问 MCP 服务。\n' >&2; return 1; }

  "$client" doctor --profile visa-helper-test --profile-dir "$profile_dir" --explain 9>&-
  "$client" run --profile visa-helper-test --profile-dir "$profile_dir" 9>&- &
  tunnel_pid=$!
  if [[ -n "$ssh_pid" ]]; then
    wait -n "$ssh_pid" "$tunnel_pid"
  else
    wait "$tunnel_pid"
  fi
}

case "${1:-start}" in
  start)
    if managed_running; then printf '后台服务已在运行，PID %s。\n' "$managed_pid"; exit 0; fi
    check_files
    load_key
    touch "$log_file"
    chmod 600 "$log_file"
    nohup setsid bash "$script" _run >>"$log_file" 2>&1 < /dev/null &
    launcher_pid=$!
    for _ in {1..40}; do
      sleep 0.5
      if managed_running && curl -fsS --max-time 1 http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
        printf 'Tunnel 已在后台就绪，PID %s。终端可以关闭。\n日志：%s\n' "$managed_pid" "$log_file"
        exit 0
      fi
      if ! kill -0 "$launcher_pid" 2>/dev/null; then
        printf '启动失败，请查看日志：%s\n' "$log_file" >&2
        exit 1
      fi
    done
    printf '后台进程正在连接；用 status 查看状态。\n日志：%s\n' "$log_file"
    ;;
  status)
    if managed_running; then
      if curl -fsS --max-time 2 http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
        printf '后台服务已就绪，PID %s。\n' "$managed_pid"
      else
        printf '后台服务运行中，尚未就绪，PID %s。\n' "$managed_pid"
      fi
    else
      printf '本脚本管理的后台服务未运行。\n'
    fi
    printf '日志：%s\n' "$log_file"
    ;;
  stop)
    if managed_running; then
      kill -TERM "$managed_pid"
      for _ in {1..40}; do managed_running || break; sleep 0.25; done
      if managed_running; then printf '进程尚未退出，请检查日志。\n' >&2; exit 1; fi
      printf '后台服务已停止。\n'
    else
      printf '本脚本管理的后台服务未运行。\n'
    fi
    ;;
  foreground|_run) run_client ;;
  *) printf '用法：%s [start|status|stop|foreground]\n' "$script" >&2; exit 2 ;;
esac
