#!/usr/bin/env python3
"""常驻监督者课程的里程碑评分器。

用法：
    python3 grade.py m0            # 给单个里程碑打分（m0..m7）
    python3 grade.py m4 --ws "$HOME/agi-lab"
    python3 grade.py all           # 对着实验场工作区跑 m0..m6
    python3 grade.py doctor        # 显示评分器能看见什么

每个里程碑对应某一章的「动手试」方框：
    m0 -> 第 4 章  实验场检查清单        m4 -> 第 9 章  worker（M0 冒烟测试）
    m1 -> 第 6 章  main-agent preset     m5 -> 第 10 章 监督循环
    m2 -> 第 7 章  大脑 + goal setup     m6 -> 第 11 章 Feed 视图标签页
    m3 -> 第 8 章  schedule              m7 -> 第 12 章 验收（也会跑 m2-m5）

检查只读持久产物：preset 文件、profile 补丁、.agi/ 目录树，以及
$DSH_HOME/sessions 下的会话事件日志（用系统 `zstd` 解压）。不修改任何东西。

状态：PASS（1 分）、WARN（0.5 分，证据弱或不完整）、FAIL（0 分）、
MANUAL（不计分 —— 提醒你有些东西只有人能判断）。
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_HOME = Path.home()
DSH_HOME = Path(os.environ.get("DSH_HOME", str(USER_HOME / ".dsh"))).expanduser()
PRESET_DIR = DSH_HOME / ".agent-presets" / "main-agent"
PATCH_FILE = DSH_HOME / "profiles" / "web" / "cordis.patch.yml"
DEFAULT_WS = str(USER_HOME / "agi-lab")
ACCEPTANCE_WS = str(USER_HOME / "agi-acceptance")
WEB_URL = "http://127.0.0.1:3080"

# ---------------------------------------------------------------- utilities

GREEN, RED, YELLOW, BLUE, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[2m", "\033[1m", "\033[0m")
if not sys.stdout.isatty():
    GREEN = RED = YELLOW = BLUE = DIM = BOLD = RESET = ""


def load_yaml(path: Path):
    """Parse YAML tolerating the harness's !!js tags (kept as raw strings)."""
    import yaml

    class Tolerant(yaml.SafeLoader):
        pass

    def unknown(loader, tag_suffix, node):
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    Tolerant.add_multi_constructor("", unknown)
    Tolerant.add_multi_constructor("!", unknown)
    Tolerant.add_multi_constructor("tag:yaml.org,2002:", unknown)
    return yaml.load(path.read_text(), Tolerant)


def all_session_dirs() -> list[Path]:
    root = DSH_HOME / "sessions"
    if not root.is_dir():
        return []
    return [d for wsdir in root.iterdir() if wsdir.is_dir()
            for d in wsdir.iterdir() if d.is_dir()]


_log_cache: dict[Path, list[str]] = {}


def session_lines(session_dir: Path) -> list[str]:
    """Decompressed raw JSONL lines of one session (tolerates a live, partial tail)."""
    if session_dir in _log_cache:
        return _log_cache[session_dir]
    log = session_dir / "session.jsonl.zstd"
    lines: list[str] = []
    if log.exists():
        # A live stream can end mid-frame; retain every complete decoded line.
        if shutil.which("zstd"):
            proc = subprocess.run(["zstd", "-dc", str(log)],
                                  capture_output=True, check=False)
            raw = proc.stdout
        else:
            import zstandard
            chunks = []
            try:
                with log.open("rb") as source, \
                        zstandard.ZstdDecompressor().stream_reader(source) as reader:
                    while chunk := reader.read(131_072):
                        chunks.append(chunk)
            except zstandard.ZstdError:
                pass
            raw = b"".join(chunks)
        lines = raw.decode("utf-8", errors="replace").splitlines()
    _log_cache[session_dir] = lines
    return lines


def session_header(session_dir: Path) -> dict:
    lines = session_lines(session_dir)
    if lines:
        try:
            head = json.loads(lines[0])
            if head.get("type") == "session":
                return head
        except json.JSONDecodeError:
            pass
    return {}


def sessions(ws: str) -> list[Path]:
    """Every session whose durable header records this workspace as its cwd.

    Matching by header.cwd instead of reconstructing the sessions directory
    name keeps the grader independent of the store's path-encoding scheme.
    """
    want = ws.rstrip("/")
    hits = [d for d in all_session_dirs()
            if session_header(d).get("cwd", "").rstrip("/") == want]
    return sorted(hits, key=lambda d: d.stat().st_mtime)


def supervisor_sessions(ws: str) -> list[Path]:
    """Top-level sessions on the main-agent preset (not subagent children)."""
    out = []
    for d in sessions(ws):
        h = session_header(d)
        if h.get("agentPreset") == "main-agent" and h.get("origin") != "subagent":
            out.append(d)
    return out


def child_sessions(ws: str) -> list[Path]:
    out = []
    for d in sessions(ws):
        h = session_header(d)
        if h.get("origin") == "subagent":
            out.append(d)
    return out


def tool_calls(session_dir: Path, name: str | None = None) -> list[dict]:
    """Parsed tool/call event data ({name, arguments, ...}) for one session."""
    calls = []
    for line in session_lines(session_dir):
        if '"type":"tool/call"' not in line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = ev.get("data", {})
        if name is None or data.get("name") == name:
            calls.append(data)
    return calls


def any_line_contains(dirs: list[Path], needle: str) -> bool:
    return any(needle in line for d in dirs for line in session_lines(d))


def jsonl_records(path: Path) -> tuple[list[dict], list[str]]:
    """(valid records, invalid raw lines) of a .jsonl file; missing file = ([], [])."""
    if not path.exists():
        return [], []
    good, bad = [], []
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
            good.append(rec) if isinstance(rec, dict) else bad.append(raw)
        except json.JSONDecodeError:
            bad.append(raw)
    return good, bad


# ------------------------------------------------------------ check plumbing

class Result:
    def __init__(self, status: str, detail: str = ""):
        self.status, self.detail = status, detail


def PASS(d=""): return Result("PASS", d)
def FAIL(d=""): return Result("FAIL", d)
def WARN(d=""): return Result("WARN", d)
def MANUAL(d=""): return Result("MANUAL", d)


class Milestone:
    def __init__(self, key: str, title: str):
        self.key, self.title, self.checks = key, title, []

    def check(self, name):
        def deco(fn):
            self.checks.append((name, fn))
            return fn
        return deco

    def run(self, ws: str) -> float:
        icon = {"PASS": f"{GREEN}✔ PASS{RESET}", "FAIL": f"{RED}✘ FAIL{RESET}",
                "WARN": f"{YELLOW}◐ WARN{RESET}", "MANUAL": f"{BLUE}☐ MANUAL{RESET}"}
        print(f"\n{BOLD}{self.key} — {self.title}{RESET}  {DIM}（工作区：{ws}）{RESET}")
        earned = total = 0.0
        for name, fn in self.checks:
            try:
                r = fn(ws)
            except Exception as e:  # a crashed check is a failed check, loudly
                r = FAIL(f"评分器错误：{e.__class__.__name__}: {e}")
            if r.status != "MANUAL":
                total += 1
                earned += {"PASS": 1.0, "WARN": 0.5, "FAIL": 0.0}[r.status]
            detail = f"  {DIM}{r.detail}{RESET}" if r.detail else ""
            print(f"  {icon[r.status]}  {name}{detail}")
        pct = 100.0 * earned / total if total else 100.0
        color = GREEN if pct >= 90 else YELLOW if pct >= 60 else RED
        print(f"  {BOLD}得分: {color}{earned:.1f}/{total:.0f}  ({pct:.0f}%){RESET}")
        return pct


MILESTONES: dict[str, Milestone] = {}


def milestone(key, title):
    m = Milestone(key, title)
    MILESTONES[key] = m
    return m


# ------------------------------------------------------------------- m0: lab

m0 = milestone("m0", "你的实验场（第 4 章）")

@m0.check("dsh web 进程在运行")
def _(ws):
    out = subprocess.run(["pgrep", "-af", "dsh web"], capture_output=True, text=True)
    return PASS(out.stdout.strip().splitlines()[0][:70]) if out.stdout.strip() else \
        FAIL("没有 `dsh web` 进程 —— 在终端里把它起起来（见安装页）")

@m0.check("web UI 在 127.0.0.1:3080 有响应")
def _(ws):
    try:
        req = urllib.request.Request(WEB_URL, method="GET")
        with urllib.request.urlopen(req, timeout=4) as resp:
            return PASS(f"HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        return PASS(f"HTTP {e.code}（服务已在运行）")
    except Exception as e:
        return FAIL(f"{e.__class__.__name__}: {e}")

@m0.check("profile patch 文件存在且能解析")
def _(ws):
    if not PATCH_FILE.exists():
        return FAIL(f"{PATCH_FILE} 不存在")
    try:
        load_yaml(PATCH_FILE)
        return PASS(str(PATCH_FILE))
    except Exception as e:
        return FAIL(f"YAML 错误：{e}")

@m0.check("实验场工作区存在")
def _(ws):
    return PASS(ws) if Path(ws).is_dir() else FAIL(f"mkdir -p {ws}")

@m0.check("你打开过一份会话 JSONL 并认出了事件类型")
def _(ws):
    return MANUAL("zstd -dc <sessions>/<dir>/session.jsonl.zstd | head")


# ---------------------------------------------------------------- m1: preset

m1 = milestone("m1", "main-agent preset（第 6 章）")

def _preset_rows():
    return load_yaml(PRESET_DIR / "agent.cordis.yml")

def _find_rows(rows, pred, nested=False):
    """All rows matching pred; recurses into group config lists."""
    found = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if pred(row):
            found.append((row, nested))
        cfg = row.get("config")
        if row.get("group") and isinstance(cfg, list):
            found += _find_rows(cfg, pred, nested=True)
    return found

def _spawn_row():
    rows = _preset_rows()
    hits = _find_rows(rows, lambda r: r.get("name") == "dsh-main-agent/spawn"
                      and isinstance(r.get("config"), dict)
                      and r["config"].get("toolName") == "subagent")
    return hits[0] if hits else (None, False)

@m1.check("preset 目录里两个文件都在")
def _(ws):
    ok = (PRESET_DIR / "agent.cordis.yml").exists() and (PRESET_DIR / "preset.yml").exists()
    return PASS(str(PRESET_DIR)) if ok else \
        FAIL("安装 dsh-main-agent bundle 并重启 dsh（第 6 章第 2-3 步）")

@m1.check("preset.yml 带着显示名与描述")
def _(ws):
    meta = load_yaml(PRESET_DIR / "preset.yml") or {}
    if meta.get("name") and meta.get("description"):
        return PASS(f'name: "{meta["name"]}"')
    return FAIL("填好 name + description（第 6 章第 2 步）")

@m1.check("agent.cordis.yml 能解析成行列表")
def _(ws):
    rows = _preset_rows()
    return PASS(f"{len(rows)} 个顶层行") if isinstance(rows, list) and rows else \
        FAIL("文件不是 YAML 的行列表")

@m1.check("persona 行存在且文本非空")
def _(ws):
    hits = _find_rows(_preset_rows(), lambda r: r.get("id") == "persona")
    if not hits:
        return FAIL("没有 id: persona 的行")
    text = (hits[0][0].get("config") or {}).get("text") or ""
    return PASS(f"{len(text)} 个字符") if len(text.strip()) > 20 else FAIL("persona 文本为空")

@m1.check("subagent 行：插件拥有、受设置约束的 spawn 前端")
def _(ws):
    row, _n = _spawn_row()
    if row is None:
        return FAIL("没有 config.toolName 为 subagent 的 dsh-main-agent/spawn 行")
    cfg = row["config"]
    problems = []
    if row.get("name") != "dsh-main-agent/spawn":
        problems.append(f'name 是 {row.get("name")}')
    if cfg.get("provider") != "spawn":
        problems.append(f'provider 是 {cfg.get("provider")}')
    if "models" in cfg:
        problems.append("preset 兜底 models 还在")
    return PASS() if not problems else FAIL("; ".join(problems))

@m1.check("受约束的 subagent 行带着 worker persona")
def _(ws):
    row, _n = _spawn_row()
    if row is None:
        return FAIL("行不存在")
    persona = row["config"].get("persona") or ""
    if len(persona.strip()) < 40:
        return FAIL("config.persona 为空或太短 —— 是不是没缩进到该行下面？")
    need = [w for w in ("report", "outcome.md") if w not in persona]
    return PASS(f"{len(persona)} chars") if not need else \
        WARN(f"persona 缺少协议关键词：{need}")

@m1.check("受约束的 subagent 行位于分组（delegation）内，不在顶层")
def _(ws):
    row, nested = _spawn_row()
    if row is None:
        return FAIL("行不存在")
    return PASS() if nested else \
        WARN("该行在顶层；把它移进 delegation 分组的 config 列表里")

@m1.check("有一个会话跑在这个 preset 上（挂载证明）")
def _(ws):
    sup = supervisor_sessions(ws)
    if not sup:
        return FAIL("这个工作区里还没有 main-agent 会话 —— 起一个（第 6 章第 5 步）")
    return PASS(f"{len(sup)} 个会话，最新的：{sup[-1].name}")

@m1.check("第二个会话能干净挂载（realm 冲突检查）")
def _(ws):
    n = len(supervisor_sessions(ws))
    return PASS(f"{n} 个会话") if n >= 2 else \
        WARN("目前只有一个会话 —— 再起一个来证明没有 realm 冲突")

@m1.check("工具列表里只有受约束的 subagent spawn 前端")
def _(ws):
    native = _find_rows(
        _preset_rows(),
        lambda r: r.get("name") == "@deepseek-ai/dsh-tool-subagent"
        and isinstance(r.get("config"), dict)
        and r["config"].get("provider") == "spawn",
    )
    return FAIL("原生 spawn 前端绕过了 workerModels") if native else \
        MANUAL("确认 subagent.model 只列出 Settings 批准的 provider/model 路由")


# ----------------------------------------------------------------- m2: brain

m2 = milestone("m2", "大脑：persona、.agi 契约、非阻塞的 goal setup（第 7 章）")

PERSONA_MARKERS = ["GROUNDING", "PERSISTENCE", "GOAL SETUP", "QUESTIONS", "subagent",
                   "send_message", "interrupt_agent", "schedule_create",
                   "CHANGELOG.jsonl", "GOAL.md", "progress.jsonl",
                   "questions.jsonl", "NOTES.md", "durable continuation path",
                   "bounded ladder of distinct, safe recovery attempts"]

@m2.check(".agi 骨架（config + 四个状态文件）")
def _(ws):
    agi = Path(ws) / ".agi"
    missing = [f for f in ("config.json", "NOTES.md", "progress.jsonl",
                           "questions.jsonl", "CHANGELOG.jsonl")
               if not (agi / f).exists()]
    if not (agi / "subagents").is_dir():
        missing.append("subagents/")
    return PASS(str(agi)) if not missing else FAIL(f"缺少：{missing}")

@m2.check("config.json 合法，wakeMinutes/questionWaitMinutes 是数字")
def _(ws):
    p = Path(ws) / ".agi" / "config.json"
    try:
        cfg = json.loads(p.read_text())
    except Exception as e:
        return FAIL(f"{e}")
    bad = [k for k in ("wakeMinutes", "questionWaitMinutes")
           if not isinstance(cfg.get(k), (int, float))]
    return PASS(json.dumps(cfg)) if not bad else FAIL(f"缺失或不是数字：{bad}")

@m2.check("监督者 persona 带着完整协议")
def _(ws):
    hits = _find_rows(_preset_rows(), lambda r: r.get("id") == "persona")
    if not hits:
        return FAIL("persona 行不存在")
    text = (hits[0][0].get("config") or {}).get("text") or ""
    missing = [m for m in PERSONA_MARKERS if m not in text]
    if not missing:
        return PASS(f"{len(PERSONA_MARKERS)} 个协议标记全部存在")
    return FAIL(f"persona 从未提到：{missing}")

@m2.check("原生 goal setup 期间写出了 GOAL.md")
def _(ws):
    p = Path(ws) / ".agi" / "GOAL.md"
    if not p.exists():
        return FAIL("跑一遍 goal setup（第 7 章动手试）")
    return PASS(f"{p.stat().st_size} bytes") if p.stat().st_size > 80 else \
        WARN("对 objective+constraints+milestones+out-of-scope 来说短得可疑")

@m2.check("goal 通过非阻塞的监督者前端武装")
def _(ws):
    for d in supervisor_sessions(ws):
        started = tool_calls(d, "start_goal")
        if started:
            return PASS(f"start_goal in {d.name}")
    return FAIL("任何 main-agent 会话里都没有 start_goal 调用")

@m2.check("progress.jsonl：行合法且带 ts+text")
def _(ws):
    good, bad = jsonl_records(Path(ws) / ".agi" / "progress.jsonl")
    if bad:
        return FAIL(f"{len(bad)} 行非法")
    shaped = [r for r in good if "ts" in r and "text" in r]
    return PASS(f"{len(shaped)} entries") if shaped else FAIL("还没有 {ts,text} 条目")

@m2.check("questions.jsonl / CHANGELOG.jsonl 是合法 JSONL")
def _(ws):
    agi = Path(ws) / ".agi"
    _q, qbad = jsonl_records(agi / "questions.jsonl")
    ch, cbad = jsonl_records(agi / "CHANGELOG.jsonl")
    if qbad or cbad:
        return FAIL(f"非法行：questions={len(qbad)} changelog={len(cbad)}")
    noact = [r for r in ch if "action" not in r]
    return PASS() if not noact else WARN(f"{len(noact)} 行 changelog 缺少 `action`")

@m2.check("修订纪律：写了 GOAL_AMENDMENTS.md，GOAL.md 未被改动")
def _(ws):
    agi = Path(ws) / ".agi"
    am = agi / "GOAL_AMENDMENTS.md"
    if not am.exists() or am.stat().st_size == 0:
        return WARN("还没有修正案 —— 第 7 章测试第 5 步会练到")
    goal, amend = (agi / "GOAL.md").stat().st_mtime, am.stat().st_mtime
    return PASS() if goal <= amend else FAIL("修正案之后 GOAL.md 又被改动了")

@m2.check("拒绝改 config（说：'set questionWaitMinutes to 2 for me'）")
def _(ws):
    return MANUAL("预期是拒绝 + 一条 config 提议行，绝不真的改（第 7 章第 6 步）")


# -------------------------------------------------------------- m3: schedule

m3 = milestone("m3", "时间：schedule 叠加层（第 8 章）")

@m3.check("dsh-schedule 已插入（profile 补丁或已安装的 bundle）")
def _(ws):
    # dsh-time-context is deliberately NOT required (nor wanted): it injects a
    # per-step timestamp block into every request, and Schedule doesn't need it.
    need = {"@deepseek-ai/dsh-schedule"}

    def inserted_names(path: Path) -> set:
        try:
            patches = load_yaml(path) or []
        except Exception:
            return set()
        names = set()
        for entry in patches if isinstance(patches, list) else []:
            for row in (entry or {}).get("insert") or []:
                if isinstance(row, dict):
                    names.add(row.get("name"))
        return names

    if not need - inserted_names(PATCH_FILE):
        return PASS("通过 profile 补丁这一层")
    # Bundle path (the dsh-main-agent package route): every profile bundle's
    # own cordis.patch.yml is a layer too.
    profile_dir = PATCH_FILE.parent
    try:
        manifest = json.loads((profile_dir / "package.json").read_text())
        bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles", [])
    except Exception:
        bundles = []
    for bundle in bundles:
        bundle_patch = profile_dir / "node_modules" / bundle / "cordis.patch.yml"
        if bundle_patch.exists() and not need - inserted_names(bundle_patch):
            return PASS(f"通过已安装的 bundle {bundle}")
    return FAIL("这些行既不在 profile 补丁里，也不在任何已安装 bundle 里（第 8 章 / README）")

@m3.check("组合树里有 schedule 行（dump-config）")
def _(ws):
    try:
        out = subprocess.run(["dsh", "--profile", "web", "--dump-config"],
                             capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        return WARN("这个 shell 的 PATH 里没有 dsh CLI —— 已跳过")
    except subprocess.TimeoutExpired:
        return WARN("dump-config 超时 —— 请手动检查")
    ok = "dsh-schedule" in out.stdout
    return PASS() if ok else FAIL("组合树里没有这一行 —— 检查 dsh web 日志和第 6 章的 bundle 安装")

@m3.check("监督者确实调用过 schedule_create")
def _(ws):
    for d in supervisor_sessions(ws):
        if tool_calls(d, "schedule_create"):
            return PASS(f"在 {d.name} 里")
    return FAIL("任何 main-agent 会话里都没有 schedule_create（第 8 章测试 2-3）")

@m3.check("提醒作为一轮消息投递回来了")
def _(ws):
    sup = supervisor_sessions(ws)
    # Verified framing: a firing reminder arrives as a plugin-sourced message
    # whose text opens with "[SCHEDULE REMINDER]" and carries the prompt as
    # untrusted reminder content (observed live, 2026-08-21).
    if any_line_contains(sup, "[SCHEDULE REMINDER]"):
        return PASS("观测到 [SCHEDULE REMINDER] 投递")
    if any_line_contains(sup, "patience-test"):
        return PASS("观测到 'patience-test' 提醒")
    return WARN("日志里没找到投递证据 —— 你等满 60 秒了吗（第 8 章测试 2）？")

@m3.check("耐心流程产生了一条 `assumed` 问题")
def _(ws):
    good, _bad = jsonl_records(Path(ws) / ".agi" / "questions.jsonl")
    hits = [r for r in good if r.get("status") == "assumed"]
    return PASS(f"{len(hits)} 条 assumed") if hits else \
        FAIL("没有 assumed 条目 —— 第 8 章测试 3（沉默超过 questionWaitMinutes）")

@m3.check("循环下限：every_seconds < 300 必须被拒绝")
def _(ws):
    return MANUAL("第 8 章测试 4 —— 要一个 60 秒的循环提醒，预期被拒绝")


# --------------------------------------------------------------- m4: workers

m4 = milestone("m4", "worker：派生、纠偏、终止、报告（第 9 章）")

@m4.check("子会话存在（origin: subagent，挂在监督者下）")
def _(ws):
    kids = child_sessions(ws)
    if not kids:
        return FAIL("这个工作区里没有 subagent 来源的会话")
    parents = {session_header(d).get("parentSession") for d in kids}
    sup = {session_header(d).get("id") for d in supervisor_sessions(ws)}
    linked = parents & sup
    return PASS(f"{len(kids)} 个子会话，其中 {len(linked)} 个挂到监督者会话") \
        if linked else WARN(f"有 {len(kids)} 个子会话，但没有一个挂在 main-agent 会话下")

@m4.check("派生：受约束的 subagent 被显式指定了 model")
def _(ws):
    calls = [call for d in supervisor_sessions(ws) for call in tool_calls(d, "subagent")]
    explicit = []
    for call in calls:
        arguments = call.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = None
        if isinstance(arguments, dict) and arguments.get("model"):
            explicit.append(call)
    if explicit:
        return PASS(f"{len(explicit)} 次显式指定 model 的调用")
    return FAIL("没有带必需的 Settings 已批准 model 选择的 subagent 调用")

@m4.check("纠偏：调用了 send_message")
def _(ws):
    n = sum(len(tool_calls(d, "send_message")) for d in supervisor_sessions(ws))
    return PASS(f"{n} 次调用") if n else FAIL("没有 send_message 调用（第 9 章观察点 2）")

@m4.check("终止：调用了 interrupt_agent")
def _(ws):
    n = sum(len(tool_calls(d, "interrupt_agent")) for d in supervisor_sessions(ws))
    return PASS(f"{n} 次调用") if n else FAIL("没有 interrupt_agent 调用（第 9 章观察点 5）")

@m4.check("收敛通知送到了监督者")
def _(ws):
    ok = any_line_contains(supervisor_sessions(ws), '"kind":"subagent-settled"')
    return PASS() if ok else FAIL("监督者日志里没有 subagent-settled 通知")

@m4.check("被卡住的 worker 用了 report")
def _(ws):
    for d in child_sessions(ws):
        if tool_calls(d, "report"):
            return PASS(f"在子会话 {d.name} 里")
    return FAIL("任何子会话里都没有 report 调用（第 9 章观察点 4）")

@m4.check("报告以 subagent-report 消息的形式到达")
def _(ws):
    ok = any_line_contains(supervisor_sessions(ws), '"kind":"subagent-report"')
    return PASS() if ok else WARN("监督者日志里没有 subagent-report 来源的消息")

@m4.check("有 worker 写了 outcome.md")
def _(ws):
    hits = list((Path(ws) / ".agi" / "subagents").glob("*/outcome.md"))
    return PASS(f"{len(hits)} 个 outcome 文件") if hits else \
        FAIL("没有 .agi/subagents/*/outcome.md —— worker 协议没被执行")

@m4.check("worker persona 生效了（子会话按该行的 persona 行事）")
def _(ws):
    return MANUAL("在 UI 里打开一个子会话：它结束时应该给出一份总结报告")


# ------------------------------------------------------------------ m5: loop

m5 = milestone("m5", "监督循环（第 10 章）")

def _changelog_actions(ws):
    good, _bad = jsonl_records(Path(ws) / ".agi" / "CHANGELOG.jsonl")
    return [str(r.get("action", "")) for r in good]

@m5.check("CHANGELOG 覆盖了派生、纠偏、终止")
def _(ws):
    actions = set(_changelog_actions(ws))
    missing = {"spawn", "steer", "kill"} - actions
    return PASS(f"看到的 action：{sorted(actions)}") if not missing else \
        FAIL(f"从未记录：{sorted(missing)}")

@m5.check("记录了一条假定（静默提问分支）")
def _(ws):
    good, _b = jsonl_records(Path(ws) / ".agi" / "questions.jsonl")
    if any(r.get("status") == "assumed" for r in good):
        return PASS()
    if any(a == "assumption" for a in _changelog_actions(ws)):
        return PASS("通过 CHANGELOG")
    return FAIL("没有 assumed 问题 / assumption 条目")

@m5.check("NOTES.md 里存着检查点的结论")
def _(ws):
    p = Path(ws) / ".agi" / "NOTES.md"
    return PASS(f"{p.stat().st_size} bytes") if p.exists() and p.stat().st_size > 40 else \
        FAIL("NOTES.md 是空的 —— 定时唤醒的结论规则（第 10 章）没跑过？")

@m5.check("progress.jsonl 讲述了任务过程（>= 3 条）")
def _(ws):
    good, _b = jsonl_records(Path(ws) / ".agi" / "progress.jsonl")
    return PASS(f"{len(good)} entries") if len(good) >= 3 else \
        WARN(f"只有 {len(good)} 条")

@m5.check("任务交付物存在（SUMMARY.md）")
def _(ws):
    p = Path(ws) / "SUMMARY.md"
    if p.exists():
        return PASS(f"{p.stat().st_size} bytes")
    return WARN("没有 SUMMARY.md —— 如果你的任务交付物不是它也没关系；手工确认一下")

@m5.check("整个任务期间 >= 2 个 worker（终止+重派就意味着两个）")
def _(ws):
    n = len(child_sessions(ws))
    return PASS(f"{n} children") if n >= 2 else WARN(f"只有 {n} 个子会话")

@m5.check("定时器卫生：活干完后 schedule_delete")
def _(ws):
    n = sum(len(tool_calls(d, "schedule_delete")) for d in supervisor_sessions(ws))
    return PASS(f"{n} 次调用") if n else \
        WARN("没看到 schedule_delete —— 用 schedule_list 确认没有残留提醒")


# -------------------------------------------------------------------- m6: ui

m6 = milestone("m6", "UI：监督动态 Feed 视图标签页（第 11 章）")

AUTH_HINT = ("服务带令牌启动时，用 --token <t> 或 DSH_TOKEN，"
             "或把令牌放进 DSH_URL（…?token=<t>）")


def _split_dsh_url(raw: str):
    """`DSH_URL` -> (base, token). `http://h:p/?token=x` becomes `http://h:p` + token.

    The token must never leak into every request path, so the query string is
    stripped off the base and remembered separately.
    """
    parts = urllib.parse.urlsplit(raw)
    token = ""
    for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        if key == "token":
            token = value
    base = urllib.parse.urlunsplit((parts.scheme, parts.netloc,
                                    parts.path.rstrip("/"), "", ""))
    return (base or raw), token


BASE_URL, _URL_TOKEN = _split_dsh_url(os.environ.get("DSH_URL", "http://127.0.0.1:3080"))
# 令牌优先级：--token（main() 里覆盖）> DSH_TOKEN > DSH_URL 内嵌的 ?token=…
TOKEN = os.environ.get("DSH_TOKEN") or _URL_TOKEN

# dsh web 对未认证的请求回 401，只认 `GET /?token=…` 换来的 `dsh-auth-…` cookie，
# 所以评分器要带一个 cookie 罐，并懒做一次握手。
_COOKIE_JAR = http.cookiejar.CookieJar()
_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_COOKIE_JAR))
_HANDSHAKE_DONE = False


def _handshake():
    """One `GET <base>/?token=…` so the cookie jar receives the `dsh-auth-…` cookie.

    The host answers 303 + Set-Cookie there; the opener follows it and stores the
    cookie, which every later request then carries. A failure is not reported
    here —— the request that follows reports it with its own status code.
    """
    global _HANDSHAKE_DONE
    _HANDSHAKE_DONE = True
    if not TOKEN:
        return
    url = f"{BASE_URL}/?token={urllib.parse.quote(TOKEN, safe='')}"
    try:
        with _OPENER.open(urllib.request.Request(url, method="GET"), timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        e.read()
    except Exception:  # noqa: BLE001 - grading, not serving
        pass


def _once(path: str):
    """One GET through the cookie-carrying opener -> (status, body-bytes)."""
    try:
        with _OPENER.open(urllib.request.Request(f"{BASE_URL}{path}", method="GET"),
                          timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001 - grading, not serving
        return None, str(e).encode()


def _http(path: str):
    """GET BASE_URL+path -> (status, body-bytes) or (None, reason).

    A real HTTP status is always reported as itself (4xx included); only a
    transport-level failure yields (None, reason). With a token in hand a
    401/403 triggers exactly one re-handshake and one retry.
    """
    global _HANDSHAKE_DONE
    if not _HANDSHAKE_DONE:
        _handshake()
    status, body = _once(path)
    if status in (401, 403) and TOKEN:
        _HANDSHAKE_DONE = False
        _handshake()
        status, body = _once(path)
    return status, body


def _auth_fail(status: int) -> str:
    """The FAIL detail for a non-200 status, naming a missing or rejected token."""
    if status in (401, 403) and not TOKEN:
        return f"未提供令牌（HTTP {status}）：{AUTH_HINT}"
    if status in (401, 403):
        return f"令牌被拒（HTTP {status}）：核对 --token / DSH_TOKEN 与这次 dsh web 的令牌"
    return f"HTTP {status}：{AUTH_HINT}"

@m6.check("已安装的 bundle 带客户端半边（dsh.client + lib/client.js）")
def _(ws):
    profile_dir = PATCH_FILE.parent
    pkg_dir = profile_dir / "node_modules" / "dsh-main-agent"
    try:
        manifest = json.loads((pkg_dir / "package.json").read_text())
    except Exception:
        return FAIL("dsh-main-agent 没有安装进 web profile")
    if (manifest.get("dsh", {}).get("client", {}).get("platform")) != "web":
        return FAIL("package.json 缺少 dsh.client { platform: web }")
    if not (pkg_dir / "lib" / "client.js").exists():
        return FAIL("已安装的包里缺少 lib/client.js")
    return PASS()

@m6.check("启动图里带着 dsh-main-agent 行（client-modules 扫描）")
def _(ws):
    status, body = _http("/")
    if status is None:
        return WARN(f"dsh web 在 {BASE_URL} 不可达 —— {body.decode()[:80]}")
    if status != 200:
        return FAIL(f"GET / 返回 {status}：{_auth_fail(status)}")
    ok = b"__DSH_BOOT__" in body and b"dsh-main-agent" in body
    return PASS() if ok else FAIL("index 页的 __DSH_BOOT__ 图里没有 dsh-main-agent 行 —— 安装后重启过了吗？")


BOOT_PLUGIN_ID = "dsh-main-agent"

def _boot_payload(html: bytes):
    """Decode the index page's `__DSH_BOOT__` graph, or None when unreadable.

    The host emits one JSON object holding a flat `entries` list; each entry
    declares the exact URL its browser half is served from.
    """
    text = html.decode("utf-8", "replace")
    at = text.find("__DSH_BOOT__")
    start = text.find("{", at) if at >= 0 else -1
    end = text.find("</script>", start) if start >= 0 else -1
    if start < 0 or end < 0:
        return None
    try:
        return json.loads(text[start:end].rstrip().rstrip(";"))
    except Exception:  # noqa: BLE001 - grading, not serving
        return None

def _advertised_client_url(payload):
    """The client URL the page advertises for this package, or None."""
    for entry in (payload or {}).get("entries", []):
        if entry.get("id") == BOOT_PLUGIN_ID:
            return entry.get("url")
    return None

@m6.check("客户端 bundle 能被服务出来（按 __DSH_BOOT__ 宣告的路径）")
def _(ws):
    status, body = _http("/")
    if status is None:
        return WARN(f"dsh web 在 {BASE_URL} 不可达 —— {body.decode()[:80]}")
    if status != 200:
        return FAIL(f"GET / 返回 {status}：{_auth_fail(status)}")
    payload = _boot_payload(body)
    if payload is None:
        return FAIL("index 页里没有可解析的 __DSH_BOOT__ 启动图")
    url = _advertised_client_url(payload)
    if not url:
        return FAIL("__DSH_BOOT__ 启动图里没有 dsh-main-agent 条目 —— 安装后重启过了吗？")
    path = "/" + url.lstrip("/")
    status, _body = _http(path)
    if status is None:
        return WARN(f"dsh web 在 {BASE_URL} 不可达")
    if status == 200:
        return PASS()
    return FAIL(f"{path} 返回 {status}（该路径由 index 页的 __DSH_BOOT__ 宣告）")

@m6.check("feed 路由能提供该工作区的 .agi 状态")
def _(ws):
    status, body = _http(f"/supervisor/feed?ws={ws}")
    if status is None:
        return WARN(f"dsh web 在 {BASE_URL} 不可达")
    if status != 200:
        return FAIL(f"/supervisor/feed 返回 {status}：{_auth_fail(status)}；正文 {body.decode()[:120]}")
    try:
        doc = json.loads(body)
    except Exception:
        return FAIL("feed 路由返回的不是 JSON")
    need = {"goal", "progress", "questions", "changelog", "subagents"}
    missing = need - doc.keys()
    return PASS() if not missing else FAIL(f"feed 文档缺少 {sorted(missing)}")

@m6.check("Feed 标签页在会话视图里渲染 goal/worker/进度")
def _(ws):
    return MANUAL("打开一个 main-agent 会话 -> 视图环 -> 监督动态 Feed：goal 卡片、worker、进度时间线")


# ------------------------------------------------------------ m7: acceptance

m7 = milestone("m7", "验收运行（第 12 章）")

@m7.check("重启韧性：进程重启后会话能恢复")
def _(ws):
    for d in supervisor_sessions(ws):
        if any('"type":"session/end-seed"' in ln or "end-seed" in ln
               for ln in session_lines(d)):
            return PASS(f"{d.name} 里有恢复标记")
    return FAIL("没有恢复标记 —— 重启演练（第 12 章）还没做")

@m7.check("完成之后练过 goal 修正案")
def _(ws):
    am = Path(ws) / ".agi" / "GOAL_AMENDMENTS.md"
    return PASS() if am.exists() and am.stat().st_size > 0 else \
        FAIL("没有修正案条目（脚本第 8 步）")

@m7.check("重启后不重新问答；没有重复的 worker")
def _(ws):
    return MANUAL("从对话记录判断：'continue' 必须复用当前活跃的原生 goal，不重跑 setup")

@m7.check("退出标准：每一步连续两次通过")
def _(ws):
    return MANUAL("把记录台账放在 DESIGN.md 旁边；连续两次干净跑完 = 完成")


# ----------------------------------------------------------------------- cli

def doctor():
    print(f"{BOLD}评分器 doctor{RESET}")
    print(f"  DSH_HOME:          {DSH_HOME}  {'（正常）' if DSH_HOME.is_dir() else '（缺失）'}")
    print(f"  DSH_URL:           {BASE_URL}  "
          f"{'（已带令牌）' if TOKEN else '（无令牌 —— 服务要求令牌时加 --token <t>）'}")
    print(f"  preset 目录:       {PRESET_DIR}  {'（正常）' if PRESET_DIR.is_dir() else '（不存在）'}")
    print(f"  profile 补丁:      {PATCH_FILE}  {'（正常）' if PATCH_FILE.exists() else '（缺失）'}")
    z = shutil.which("zstd")
    if z:
        print(f"  zstd 解码器:       {z}")
    else:
        try:
            import zstandard  # noqa: F401
            print("  zstd 解码器:       Python zstandard（正常）")
        except ImportError:
            print("  zstd 解码器:       缺失（跑 ./tutorial/setup.sh）")
    try:
        import yaml  # noqa: F401
        print("  PyYAML:            正常")
    except ImportError:
        print("  PyYAML:            缺失（pip install pyyaml）")
    root = DSH_HOME / "sessions"
    for wsdir in sorted(root.iterdir()) if root.is_dir() else []:
        dirs = [d for d in wsdir.iterdir() if d.is_dir()]
        presets = {}
        for d in dirs:
            h = session_header(d)
            key = (h.get("agentPreset", "?"), h.get("origin", "top"))
            presets[key] = presets.get(key, 0) + 1
        print(f"  {wsdir.name}: {len(dirs)} 个会话 {dict(sorted(presets.items()))}")


def main():
    global TOKEN
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", choices=[*MILESTONES.keys(), "all", "doctor"])
    ap.add_argument("--ws", help=f"工作区（默认 {DEFAULT_WS}；m7 默认 {ACCEPTANCE_WS}）")
    ap.add_argument("--token", metavar="<t>",
                    help="dsh web 的访问令牌（优先级：--token > DSH_TOKEN > DSH_URL 里的 ?token=…）")
    args = ap.parse_args()

    if args.token:
        TOKEN = args.token

    if args.target == "doctor":
        doctor()
        return

    if args.target == "all":
        keys = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]
        ws = args.ws or DEFAULT_WS
        scores = [(k, MILESTONES[k].run(ws)) for k in keys]
        print(f"\n{BOLD}=== 总览 ==={RESET}")
        for k, s in scores:
            bar = "█" * int(s / 10) + "░" * (10 - int(s / 10))
            print(f"  {k}  {bar}  {s:.0f}%")
        sys.exit(0 if all(s >= 90 for _k, s in scores) else 1)

    if args.target == "m7":
        ws = args.ws or ACCEPTANCE_WS
        print(f"{DIM}m7 会先在验收工作区上重跑 m2-m5：{RESET}")
        scores = [MILESTONES[k].run(ws) for k in ("m2", "m3", "m4", "m5")]
        scores.append(MILESTONES["m7"].run(ws))
        sys.exit(0 if all(s >= 90 for s in scores) else 1)

    score = MILESTONES[args.target].run(args.ws or DEFAULT_WS)
    sys.exit(0 if score >= 90 else 1)


if __name__ == "__main__":
    main()
