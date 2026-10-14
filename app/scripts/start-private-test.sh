#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client="$app_dir/.local/tunnel-client"
profile_dir="$app_dir/.local/tunnel-profiles"
known_hosts="$app_dir/.local/known_hosts"

if [[ ! -x "$client" || ! -f "$profile_dir/visa-helper-test.yaml" || ! -f "$known_hosts" ]]; then
  printf '本机 tunnel-client、配置或 SSH 主机密钥文件缺失。\n' >&2
  exit 1
fi

ssh -N -o BatchMode=yes -o ConnectTimeout=8 -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" \
  -L 127.0.0.1:18081:127.0.0.1:18081 ubuntu@129.204.29.242 &
ssh_pid=$!
trap 'kill "$ssh_pid" 2>/dev/null || true' EXIT

ready=false
for _ in {1..12}; do
  if ! kill -0 "$ssh_pid" 2>/dev/null; then
    printf 'SSH 转发启动失败。\n' >&2
    exit 1
  fi
  if curl -fsS --max-time 2 http://127.0.0.1:18081/ >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf '无法通过 SSH 转发访问 MCP 服务。\n' >&2
  exit 1
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  if [[ ! -t 0 ]]; then
    printf '请在交互式终端运行并输入 Platform 运行 API key。\n' >&2
    exit 1
  fi
  read -r -s -p 'Platform 运行 API key（输入不显示）: ' CONTROL_PLANE_API_KEY
  printf '\n'
  export CONTROL_PLANE_API_KEY
fi

"$client" doctor --profile visa-helper-test --profile-dir "$profile_dir" --explain
printf '\nTunnel 检查通过。保持本终端运行，以便 ChatGPT 访问。\n'
"$client" run --profile visa-helper-test --profile-dir "$profile_dir"
