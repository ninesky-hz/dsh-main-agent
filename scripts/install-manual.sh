#!/usr/bin/env bash
# 常驻监督者（Always-On Supervisor）配置的手工安装（非 bundle 方式）。
#
# 优先用 README 里的 bundle 方式（`dsh plugin --profile web add …`），
# 它会注册 preset 行并自动安装 preset。本脚本是备选路径，
# 适用于那些更愿意手工管理 profile 的部署。
# 两条路径都不声明 schedule 服务（那个 service 归 dsh-web-app 的 host 层），
# 所以不会再撞 `service "schedule" has been registered at <ScheduleService>`。
#
# 幂等且非破坏性：没有 --force 时，绝不覆盖已存在的 main-agent
# preset，也不覆盖非空的 profile patch。
#
# 用法：  ./install-manual.sh [workspace-dir]        （默认：~/agi-lab）
#         ./install-manual.sh --force [workspace-dir]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
FORCE=0
[ "${1:-}" = "--force" ] && { FORCE=1; shift; }
WS="${1:-$HOME/agi-lab}"

echo "DSH 主目录：$DSH_HOME"
echo "工作区：  $WS"

# ── 1. main-agent preset ────────────────────────────────────────────────────
PRESET_DIR="$DSH_HOME/.agent-presets/main-agent"
if [ -e "$PRESET_DIR" ] && [ "$FORCE" != 1 ]; then
  echo "preset: $PRESET_DIR 已存在 —— 跳过（用 --force 覆盖）"
else
  mkdir -p "$DSH_HOME/.agent-presets"
  rm -rf "$PRESET_DIR"
  cp -r "$REPO/agent-presets/main-agent" "$PRESET_DIR"
  echo "preset: 已安装 main-agent"
fi

# ── 2. schedule 无需安装 ───────────────────────────────────────────────────
# `@deepseek-ai/dsh-schedule` 的 service 由 dsh-web-app 的 host 层提供
# （那条 `- id: schedule` 行），四个提醒工具由 main-agent preset 自己声明。
# 这里以前会往 profile 写一行 `- id: schedule`，那是重复注册，启动即报：
#   service "schedule" has been registered at <ScheduleService>
echo "patch:  跳过 —— schedule 服务由 dsh-web-app 的 host 层提供，无需写入 profile"

# ── 3. 工作区 .agi 骨架 ─────────────────────────────────────────────────────
mkdir -p "$WS/.agi/subagents"
[ -f "$WS/.agi/config.json" ] || cp "$REPO/agi-template/config.json" "$WS/.agi/config.json"
touch "$WS/.agi/NOTES.md" "$WS/.agi/progress.jsonl" \
      "$WS/.agi/questions.jsonl" "$WS/.agi/CHANGELOG.jsonl"
python3 -c "import json; json.load(open('$WS/.agi/config.json'))"
echo "agi:    $WS/.agi 已就绪"

cat <<EOF

完成。接下来：
  1. 启动（或保持运行）Web UI：  dsh web
  2. 打开 http://127.0.0.1:3080 -> 新建会话 -> 工作区 $WS
     -> preset "Main Agent（监督者）"。
  3. 随时给进展打分：
       "$REPO/tutorial/grade.sh" all --ws "$WS"
EOF
