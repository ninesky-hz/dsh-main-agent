# Prompt 版本记录

由 `npm run sync-preset` 自动追加。每行是一次 prompt 版本 —— 两份 md 的
sha256 前 8 位；同一版本不会重复追加。运行中的是哪一版，用这里的值去
`presets/main-agent.patch.yml` 的文件头 `# prompt-revision:` 一行 grep。

- 2026-11-01T09:40:05.730Z main-agent=4ca9e421 worker=e756e4a2
