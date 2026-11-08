# Prompt 版本记录

**只保留当前版本一行。** 每行是两份 md 的 sha256 前 8 位；同一版本不会重复追加，
旧版本会被新版本顶掉（`tests/prompts.test.mjs` 钉住「恒为一行」）。要查历史版本
和当时改了什么，用 `git log -p prompts/` —— 正文改动本身就在提交里。

运行中的是哪一版，用这里的值去 `presets/main-agent.patch.yml` 的文件头
`# prompt-revision:` 一行 grep。

- 2026-11-08T06:28:39.837Z main-agent=4ca9e421 worker=8cc5d712
