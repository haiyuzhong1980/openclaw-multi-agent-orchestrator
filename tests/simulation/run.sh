#!/bin/bash
# OMA 自进化模拟器 — 快速启动脚本
#
# 用法:
#   ./tests/simulation/run.sh                    # 默认 30 天 × 40 消息
#   ./tests/simulation/run.sh --days 10          # 快速测试
#   ./tests/simulation/run.sh --docker           # Docker 模式
#   ./tests/simulation/run.sh --docker --days 60 # Docker + 自定义天数

set -euo pipefail

cd "$(dirname "$0")/../.."

DAYS=30
MESSAGES=40
USE_DOCKER=false
VERBOSE=false
SEED=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --days) DAYS="$2"; shift 2;;
    --messages) MESSAGES="$2"; shift 2;;
    --docker) USE_DOCKER=true; shift;;
    --verbose|-v) VERBOSE=true; shift;;
    --seed) SEED="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if $USE_DOCKER; then
  echo "🐳 Docker 模式启动..."
  TOTAL_DAYS=$DAYS MESSAGES_PER_DAY=$MESSAGES \
    docker compose -f tests/simulation/docker-compose.yml up --build
else
  echo "🧪 本地模式启动..."
  ARGS=(--days "$DAYS" --messages-per-day "$MESSAGES")
  $VERBOSE && ARGS+=(--verbose)
  [[ -n "$SEED" ]] && ARGS+=(--seed "$SEED")

  node --experimental-strip-types tests/simulation/simulate-days.ts "${ARGS[@]}"
fi
