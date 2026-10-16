# Changelog

## [Unreleased] - 2026-03-11

### 功能

- **彻底移除内置 Catty Agent，仅保留本地 CLI/SDK Agent**：移除内置 AI agent（`cattyAgent/`、Catty turn driver / stream processor / runtime context、Catty 工具按需渲染本地执行器、Catty 供应商模型目录与推理档位、Catty 系统提示与 harness 工具面、`cattyToolSpecs.json` 生成产物、`ai:capability`/`netcatty:ai:exec` 渲染进程入口及相关设置项）。AI 侧边栏仅保留用户本机的外部 CLI/SDK Agent（Codex、Claude Code、GitHub Copilot CLI、Cursor、CodeBuddy、OpenCode 等），其工具执行仍走 MCP / 主进程链路，`netcatty:ai:exec` 与取消通道（重命名为 `netcatty:ai:exec:cancel`）继续由 MCP/vault 复用。共享类型（`NetcattyBridge`/`ExecutorContext`）迁移到 `infrastructure/ai/bridgeTypes.ts`，`cattyHistoryReplay` 重命名为 `agentHistoryReplay`
- **移除 AI 设置中的「提供商」子标签页**：删除仅服务于内置 agent 的供应商配置 UI（ProviderCard、ProviderConfigForm、AddProviderDropdown、ProviderIconBadge、ModelSelector 等）、`useAIState`/`useAISettingsState` 中的供应商状态与 CRUD、云端同步载荷中的 providers/activeProviderId/activeModelId/agentProviderMap 字段、主进程 `netcatty:ai:sync-providers` IPC 处理器与 preload/类型声明、相关 localStorage key 及设置搜索目录条目。AI 设置默认子标签改为「Agents」；用户本机外部 CLI/SDK Agent 的配置（模型/推理档位）保留在 `agentModelMap`/`agentThinkingMap`
- 修复选择 OpenCode 时模型选择器先显示硬编码的占位模型（OpenAI GPT-5.1 / Claude Sonnet 4.6 / DeepSeek Chat 等）再被真实模型替换的问题：移除 `OPENCODE_MODEL_PRESETS` 静态兜底列表（OpenCode 的模型完全由用户在本机 `opencode` 配置，应只来自实时 provider 目录）；实时目录返回前模型芯片显示「正在加载模型...」并带 spinner
- 统一其他本地 CLI Agent（Claude Code、Cursor、CodeBuddy、Grok、GitHub Copilot CLI）的模型选择体验：首次拉取实时模型目录期间不再先闪出精选静态列表再被替换，而是直接显示「正在加载模型...」；拉取结束后精选列表仍作为兜底保留（如 Codex SDK 无模型枚举接口，仍即时展示内置列表）
- 设置界面「版本号」上方显示应用名称（来自 `getAppInfo`，开发版为 "Intelligent Terminal"），不再只显示版本号
- **将用户可见的应用名称由 Netcatty 统一改为 Intelligent Terminal**：涵盖全部 5 种语言的界面文案、终端主题名（`Intelligent Terminal Dark/Light`）、系统通知与 OSC 通知默认标题、应用锁窗口标题、锁屏/授权窗口标题、CLI/ MCP 工具提示与错误信息、插件运行时文案、AI 系统提示词上下文（`[Intelligent Terminal session context]` 等）、macOS 权限用途描述；开发模式下 `app.setName` 亦改为 "Intelligent Terminal"。内部标识（userData 目录名、Windows 注册表 verb、发布仓库 `binaricat/Netcatty`、OSC7 rc 标记、`Netcatty*` 类型名）保持不变以确保兼容性
- **彻底移除系统托盘图标与托盘面板**：移除顶部托盘图标、托盘菜单、托盘面板窗口（`#/tray`）、托盘会话跳转/端口转发开关、"关闭到托盘"（close-to-tray）设置；保留全局快捷键（Quake 模式）与 macOS Dock 菜单（"新连接"入口）。外部 MCP/CLI 的 `openMainWindow` 与 Dock 连接链路不受影响
- **自动更新默认关闭（opt-in）**：新安装/未显式设置的用户默认不启用自动更新，启动时不再自动检查与下载，需在 Settings > System 手动开启；已有用户显式开启/关闭的偏好不受影响
- Linux deb/rpm/pacman 安装包启用应用内自动更新；未标记的开发包和 Snap 继续提供手动下载入口
- 终端新增"粘贴时自动上传剪贴板图片"选项：剪贴板含图片时，在远程会话中粘贴（快捷键/右键/中键）自动通过 SFTP 上传图片到远端 `.netcatty-paste-images/` 目录并输入远端路径，否则保持原有文本粘贴行为（设置 > 终端 > 行为，默认关闭）
- 修复自动更新 IPC 事件仅发送到单个窗口的问题，改为广播所有窗口（主窗口 + 设置窗口均可收到）
- 统一手动检查更新与自动更新的状态机，消除三套并行状态
- 手动"检查更新"通过 GitHub API 检测版本，发现更新后异步触发 electron-updater 下载
- 设置窗口中点击"检查更新"后，下载进度可实时反映在 UI 中
- 应用启动后 5 秒自动触发 `electron-updater` 检查更新，无需用户手动点击
- 发现新版本后自动开始下载（`autoDownload=true`）
- 下载完成后弹出持久 toast 通知，用户点击"立即重启"即可安装
- 下载失败时弹出错误 toast，提供"打开 Releases"降级入口
- Settings > System 进度条实时展示自动下载进度，由 `useUpdateCheck` 统一驱动
- Linux Snap、未标记的开发包等不支持 electron-updater 的平台自动跳过，保持原有 GitHub API 通知行为

### 设计原理

- `broadcastToAllWindows` 替换 `getSenderWindow` 单点发送，保证所有窗口都能收到 IPC 事件
- `manualCheckStatus` 字段追踪手动检查 UI 状态（idle/checking/available/up-to-date/error），与 `autoDownloadStatus` 在 UI 层按优先级渲染
- `SettingsSystemTab` 不再持有本地 update state，单向接收 `useUpdateCheck` 统一数据
- 将原有两套独立系统（GitHub API 通知 + electron-updater 手动下载）合并为统一状态机：`useUpdateCheck` 作为唯一事实来源，同时驱动 `App.tsx` toast 和 `SettingsSystemTab` 进度条
- 全局持久化 IPC 监听器在 `autoUpdateBridge.init()` 时一次性注册，避免每次手动下载请求重复注册/清理监听器
- `autoInstallOnAppQuit=false`，不做静默安装，由用户主动触发重启

### 接口变更（SettingsSystemTabProps）

- 移除：`autoDownloadStatus`、`downloadPercent`
- 新增：`updateState`（完整 UpdateState）、`checkNow`、`installUpdate`、`openReleasePage`

### 注意事项

- `checkNow` 语义：使用 GitHub API（`performCheck`）检测是否有新版本，若发现更新且 electron-updater 尚未开始下载，则异步触发 `bridge.checkForUpdate()` 启动自动下载流程
- 此功能仅对打包后的应用（Windows NSIS、macOS dmg/zip、Linux AppImage/deb/rpm/pacman）生效，dev 模式需配合 `forceDevUpdateConfig=true` + `dev-app-update.yml` 测试（见 `.gitignore`）
- `hasUpdate` 旧 toast 在 `autoDownloadStatus !== 'idle'` 时自动抑制，避免与新 toast 重复
