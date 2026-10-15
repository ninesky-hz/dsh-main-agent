#!/bin/sh
set -eu

tutorial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
venv_dir="$tutorial_dir/.venv"

if ! command -v python3 >/dev/null 2>&1; then
  echo "需要 Python 3。请用你的操作系统的包管理器安装它。" >&2
  exit 1
fi

create_venv() {
  python3 -m venv --clear "$venv_dir"
}

if [ ! -x "$venv_dir/bin/python" ] || ! "$venv_dir/bin/python" -m pip --version >/dev/null 2>&1; then
  echo "正在创建教程评分器环境..."
  if ! create_venv >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "缺少 Python venv 支持；正在安装 python3-venv..."
      if [ "$(id -u)" -eq 0 ]; then
        apt-get update
        apt-get install -y python3-venv
      elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y python3-venv
      else
        echo "请以 root 身份跑 'apt-get install python3-venv'，然后重试。" >&2
        exit 1
      fi
      create_venv
    else
      echo "没能创建 Python 虚拟环境。" >&2
      echo "请用你的操作系统的包管理器安装 Python 的 venv 模块，然后重试。" >&2
      exit 1
    fi
  fi
fi

echo "正在把评分器依赖装进 $venv_dir ..."
# Ignore machine-level pip settings such as `user = true`; --user installs are
# invalid inside a virtual environment and would make the course non-portable.
"$venv_dir/bin/python" -m pip --isolated install --no-user --disable-pip-version-check \
  --requirement "$tutorial_dir/requirements.txt"

echo "正在一个未占用的 localhost 端口上启动教程..."
exec "$venv_dir/bin/python" "$tutorial_dir/server.py" --host 127.0.0.1 --port 0
