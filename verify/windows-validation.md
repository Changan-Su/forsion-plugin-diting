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
