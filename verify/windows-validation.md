# Windows 验证记录 / Windows validation

2026-10-23，Windows 11（10.0.26200），真实 Forsion Electron，真实 SenseVoice 模型。

本轮修正 Windows 台架：模型路径可通过 `DITING_MODEL` 指定，模型目录链接在 Windows 使用 junction；翻译检查遵循选择的目标语言；纪要/笔记通过当前宿主的可见页头控件切换。CSS 固定 LF，跨平台构建产物保持一致。没有修改插件的录音、翻译或存储实现。

- `npm run verify`：32 项自检、10 项模型范围检查，以及存储迁移/恢复检查全部通过。
- `verify/smoke.cjs`：修正台架后 **30/30** 通过。真实文件麦克风输入→切句→本地 ASR→保存录音/转写/笔记；翻译与纪要使用测试后端。Mini 显示、暂停/继续/笔记/结束、回放定位、三种布局、WAV 导入、异常未结束记录恢复均通过，无页面错误。
- 单独的长录音运行：隐藏主窗 330 秒时，时间轴推进 330 秒，句子 5→63；关闭主窗进入托盘 330 秒，句子 64→121。结束落盘 123 句、696 秒录音并可回放。该次运行在旧台架的目标语言硬编码和页头选择器处报错，已保留失败结果；后续 30 项复跑没有把这次失败改写成全绿。
- 音频是离线 Windows 语音合成的测试文件，经 Chromium 文件麦克风输入。未占用用户真实麦克风，也未验证权限弹窗、拔掉物理麦克风、MP3/M4A/MP4 导入或强制退出时的真实录音恢复。这些原始验收项仍未完成，Issue #1 保持打开。

复跑（先构建宿主，准备 16kHz mono WAV 和 SenseVoice 模型）：

```powershell
$env:FORSION_DESKTOP = 'C:\path\to\Forsion-Genesis\desktop'
$env:DITING_MODEL = 'C:\path\to\sensevoice'
$env:DITING_WAV = 'C:\path\to\speech.wav'
$env:DITING_TARGET = 'zh'
$env:HIDE_MS = '330000'
node verify/smoke.cjs
```

长运行的两段隐藏检查各至少 5 分钟；切换 Space 的现有检查为 12 秒，未声称完成所有物理后台场景。
# 2026-10-24 续验：真实最小化、缩放和强退

宿主使用 Genesis `codex/windows-remaining-acceptance` 的 Windows 音频时钟修复，插件发布 bundle 不变。Windows 11 26200、Electron 40.10.2，隔离 profile、离线 SenseVoice、英文 PCM 文件麦克风，`DITING_TARGET=zh`。

- 短流程 40/40，包括实际最小化/托盘、110%/125% UI 缩放、Mini 操作、真实强退后同 profile 重启恢复已落盘文字。
- 显式关闭 CDP 焦点模拟后，`HIDE_MS=330000 WINDOWS_BACKGROUND_CASE=minimize WINDOWS_EXTENDED=1` 的严格 hidden 长最小化流程 39/39：330 秒推进 330.0 秒，hidden→hidden，原生 minimized=true。记录共 366 秒，媒体回放约 366.544 秒。
- 三段长流程的切 Space 330 秒推进 331.0 秒，托盘继续录及真实 125 秒 MP3/M4A/MP4 解码/转写/原文件落盘通过。该次最小化虽音频时长正常，但页面 visible，严格 hidden 项未通过；旧 Ribbon 定位脚本又在 125% 中断，不冒充整套通过。
- Ribbon 在 125% 展开后仍会虚拟化尾部，台架现实际滚动再找插件；`reload-probe.cjs` 可在 smoke 自己的临时 profile 查询真实插件/视图/Space 注册状态。英文到英文会正确跳过翻译，不能拿它跑要求出现译文的断言。
- Windows 最小化时原生 AudioContext 变慢的修复在宿主侧：保护音频所在 renderer 的已有计时精度请求，浏览器主进程的策略不够。独立探针 20 秒非静音 PCM 19.968 秒通过。

用户暂不能配合真实麦克风说话、拔插与权限弹窗，相关项目仍未验，issue #1 保持开放。GUI 工具后因无法可靠确认 Windows 浏览器 URL 终止，本轮未绕过限制或关闭缺证据的 issue。

