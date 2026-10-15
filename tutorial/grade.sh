#!/bin/sh
set -eu

# 中文输出：Windows 上 Python 默认按控制台代码页（本机为 gbk）写 stdout，
# 一旦重定向到文件再按 UTF-8 读就会乱码；固定为 UTF-8，POSIX shell 下无副作用。
export PYTHONUTF8=1

tutorial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python="$tutorial_dir/.venv/bin/python"

if [ ! -x "$python" ]; then
  echo "教程评分器的环境还没准备好。先跑 ./tutorial/setup.sh。" >&2
  exit 1
fi

exec "$python" "$tutorial_dir/grade.py" "$@"
