# Maintenance and packaging

Read only when changing, validating, or distributing this skill. Normal coach questions do not require protocol capture, implementation details, or packaging history. Commands and code paths below are relative to the installed skill root.

## 资源

- `scripts/discover_coaches.js` — **首次/换账号先跑**：实时发现两个教练并打印解析结果（`--all`/`--json`/`--resolve`）
- `scripts/coach-discover.js` — 发现库：读「智能体」目录 + 「全部」会话，按精确名解析别名，切 tab/重试
- `scripts/await_task.js` — 异步任务等待器（`<taskId>` + `--out`，适合 detached/子 Agent）
- `scripts/coach_headless.js` — 无头客户端（通道 D，协议直连，仅内置模块）
- `scripts/ws_client.js` — 裸 RFC6455 WebSocket 客户端（支持自定义握手头/子协议）
- `scripts/bg.js` — **后台无窗口启动器**（detached + windowsHide + 日志落 logs/；`--list`/`--tail`/`--kill`）
- `scripts/coach_ask_server.js` — 本地 ask API（通道 C；异步 taskId + `/result`/`/stream`/`/queue`，按实时发现的教练路由，FIFO 排队带位置/阶段）
- `scripts/queue.js` — 打印当前队列：谁在跑、后面排了谁（`--json`）
- `scripts/ask.js` — CLI 客户端（中文安全，`--peer impl|delivery|标题片段|ipa_ id`）
- `scripts/ask_both.js` — **一次问两个教练**（按别名，不写死 id），产出合并 markdown（`--out`/`--tag`）
- `scripts/list_peers.js` — 枚举消息库里所有 `ipa_` 机器人会话 peer
- `scripts/identify_peers.js` — 逐个看最近问答内容，判定哪个是哪个教练
- `scripts/list_conversations.js` — 兼容入口（已委托 `coach-discover`；新代码用 `discover_coaches.js --all`）
- `scripts/list_digitals.js` — 查 `digitals` 数字人名录（实测空壳，留作取证）
- `scripts/probe_peer_scope.js` — **peerId 可见性实测**：18 个 `ipa_` 会话清单 + 每peer's tenantId/chatId/digitalCode + tenantId 分布
- `scripts/youzone_cdp.js` — 零依赖 CDP 客户端（CLI + 库两用）
- `scripts/lib.js` — 消息库复制/GBK 解码/行解析
- `scripts/dump_chat.js` — 导出问答记录（替代旧 dump_coach_chat.py）
- `scripts/coach_capture.js` — 一轮问答的全 target 网络抓包（Network+WS+SSE）
- `scripts/capture_ws_handshake.js` — 抓真实 WS 握手头与 AUTH 帧（配合 Page.reload）
- `references/coach-chat-log.md` — 问答记录（可随时 dump_chat.js 重导）
- `references/peer-id-scope.md` — **peerId 可见性与跨账号复用**（全局ID vs chatId 隔离的实测证据）
- `references/protocol-map.md` — 协议逆向详细笔记（认证链/帧布局/时序/错误结论修正）
- `scripts/preflight.js` — 环境体检（Node/库/CDP/凭据/WS 鉴权，只握手不提问；`--no-ws`/`--json`）
- `scripts/selftest.js` — 离线自检（`npm test`，不联网、不碰原库）
- `scripts/pack.js` — 打包（`npm run pack` → `dist/<name>-<ver>.zip` + `.skill` + `MANIFEST.md`）
- `scripts/check-doc-links.mjs` — 文档链接/导航检查（`npm run docs:check`，CI 同款）
- `package.json` / `README.md` — 运行要求（Node >= 22.5）与快速开始

## 分发打包（pack.js）

```bash
npm run pack                # -> dist/youzone-coach-<ver>.zip
                            #    dist/youzone-coach.skill   （单顶层目录，供 skill 导入）
                            #    dist/MANIFEST.md           （逐文件 sha256 + 安装步骤）
node scripts/pack.js --out D:\somewhere --no-skill
```

- **白名单**：`SKILL.md` `README.md` `package.json` `LICENSE` `.gitattributes` `.gitignore` + `scripts/*.{js,mjs,ps1,json,txt}` + `references/*.{md,json,txt}`。
- **黑名单**：`.git/` `node_modules/` `dist/` `tmp/` `*.db(-wal|-shm)` `capture-*.json` `db-inspect-*.json` `ws-*.json` `*payload*.json` `aip-*.json` `replay-sse.txt` `*.log`。
- 产物**不含** `yht_access_token` 与会话库；`references/coach-chat-log.md` 含问答正文，外发前人工过一遍。
- **纯 Node 写 zip**（自带CRC-32 + store/deflate 自适应），不 spawn 任何外部工具。三种方案都试过、都不行：
  - `Compress-Archive` 拒绝非 `.zip` 目标扩展名（`.skill` 报 `NotSupportedArchiveFileExtension`），且沙箱下会被静默杀掉返回 `status=null`、留下半成品；
  - `System32\tar.exe`（bsdtar）从 node spawn 报 `EBUSY`；
  - Git Bash 的 GNU tar 是另一个二进制，会把 `C:\...` 当远程主机（`Cannot connect to C: resolve failed`）。
- 落地即 `.skill` 必须**单顶层目录**：`<name>/SKILL.md`，不能把文件直接摊在zip 根（代码里给每条路径加 `<name>/` 前缀）。
- 打包后**必须用外部工具独立验证**，不要只信脚本自己的校验：
  ```bash
  python -c "import zipfile; z=zipfile.ZipFile('dist/youzone-coach.skill'); print(z.testzip() or 'CRC OK', len(z.namelist()))"
  ```
  `testzip()` 逐条校验 CRC，能抓出 store/deflate 写错的问题。
- ⚠️ 验证解压产物要用 `C:\Users\<u>\AppData\Local\Temp\...` 这类**绝对路径**：Git Bash 的 `/tmp` 与 Windows 侧 Python 看到的 `/tmp` 不是同一处，否则误报 `MODULE_NOT_FOUND`。
- ⚠️ `npm test` 里的 `CLI exit codes` 用 `spawnSync(process.execPath, ...)` 测子进程退出码，**在沙箱下子进程会被静默杀掉**（`status === null`），脚本已改为跳过并打印提示，不要把它当成回归。语法检查已改成用 `vm.Script` 进程内解析，不再 spawn。
- **文档检查**：改过任何 `.md` 后跑 `npm run docs:check`。本地会按 `.gitignore` 跳过 `dist/`、`logs/` 等生成物，与 CI 的干净 checkout 结果一致；每个文档都要求有 `## Related documents` 且从 README 可达。
- 验证套路：解压到干净目录 → `npm test` + `npm run docs:check` 应全过。

## Related documents

- [Skill entrypoint](../SKILL.md)
- [Project overview](../README.md)
- [Peer identity evidence](peer-id-scope.md)
- [Protocol map](protocol-map.md)
