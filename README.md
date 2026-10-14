# 谛听 Diting

Forsion 的插件:把上课、开会、访谈时听到的话变成带时间的文字,可以同时翻译,可以随时提问,结束以后写纪要。

A Forsion plugin that turns what you hear in a class, meeting or interview into timestamped text, translates it as it goes, answers questions about it at any time, and writes a summary when it ends. (English notes are at the end.)

## 安装

Forsion 桌面端 2.13.2 及以上:打开「商店」,搜「谛听」,点安装。装好后在功能条的「…」里找「谛听」,或者在命令面板里搜「谛听：打开」。

从源码装:

```bash
git clone https://github.com/Changan-Su/forsion-plugin-diting.git
cd forsion-plugin-diting
sh install.sh prod      # 装进 ~/.forsion;不带参数装进开发用的 ~/.forsion-dev
```

转写用的是 Forsion 自己的语音识别。在 Space 中选转文字模型，或跟随 设置 › 语音；本机模型需先下载，运行时不联网、不花额度。Space 模型选择需要包含 `ctx.ui.mountModelPicker` / `ctx.tangu.modelCatalog` 接口的新宿主；旧版本保留原有全局设置行为。只在桌面端测过(macOS);Windows 还没有实测。

## 能做什么

- **实时转写**:按说话的停顿切成一句一句,一句说完一两秒内出文字。Space 内直接选择本机或云端转文字模型，切换从下一句生效；已排队的音频保留原模型。
- **实时翻译**(默认关):Space 内选翻译模型和目标语言，或跟随宿主翻译设置。切换时选择仅后续句子、后续和失败项、重译已有内容；旧译文成功重译后才替换。支持指令的模型可顺带纠正听错的词，改动有标记且可撤回；专用翻译模型只翻译，不会自动换成聊天模型。
- **失败批量重试**:页面显示失败数，一次重试所有失败译文和本次运行中仍有音频的转写失败项；已完成的句子不重跑。
- **术语表**:在 Space 直接添加、删除“听成了 → 改为”，用于后续识别，已有原文保留。
- **随时提问**:右栏是 Forsion 的原生对话,它读的就是这次记录的转写。点一句话可以引用它提问。
- **笔记和重点**:随手记一条,自动带上当时的时间;一键标「刚才这句」。
- **纪要和章节**:结束后自动写(课堂 / 会议 / 访谈三种写法),每条要点带时间。
- **回放**:保留了录音的话,点任何一个时间就从那里听。
- **导入**:已有的音频 / 视频文件(两小时以内)可以转成同样的记录。
- **后台和小窗**:切到别的 Space、关掉标签页、把主窗口收进托盘都不会停;「谛听：打开小窗」把字幕放在一边。
- **三种布局**:转写为主 / 笔记为主(转写在底部面板里滚)/ 并排。

## 存在哪里

都在你的笔记库里,每次记录一个文件夹(默认在 `谛听/` 下,可以在插件设置里改工作文件夹):

```
谛听/2026-10-13 1405 PHYS3721 第 2 讲/
  转写.md        每句一段,[mm:ss] 开头;译文是紧跟着的引用块
  笔记.md        你记的
  纪要.md        结束后写的
  录音.webm      保留了录音才有
  .record.json   全部数据(界面读的是它)
```

## 现在的限制

- **不区分发言人**。音量比平时小很多的句子会标「没听清」(多半是离麦克风远的人)。
- **只录麦克风**,录不到电脑里播放的声音(网课、线上会议要外放,或者事后导入文件)。
- **不是逐字出现**:一句话说完才出字。用本机模型时,会在说的过程中先显示一个大概(设置里可以关)。
- 翻译一句调用一次模型。一节 50 分钟的课大约是三四百次小调用,可以在 Space 选择适合的翻译模型；纠错也使用所选模型。
- 退出 Forsion、电脑睡眠时记录会停;已经记下的内容都在。
- 重译已有内容会对每句重新调用模型；“仅后续句子”保留已有和已排队的模型与语言。关掉翻译会停止在途翻译并保留已完成的译文。
- 右栏的对话第一次提问时才会建(它是一条真的 Forsion 会话,会出现在主对话列表里),每条记录一条。
- 暂停再继续,录音文件和文字的时间每次可能差出 0.1 秒左右。

前三条都要 Forsion 宿主先加接口(主进程里的流式识别、说话人分离、系统声音采集)。

## 开发

```bash
npm install
node build.mjs          # src/ → main.js(要提交,商店安装时不构建)
npm run check          # 纯逻辑自检:切句、数据模型、文案成对、发布物和源码一致
MODEL_UI=1 node verify/smoke.cjs # Space 模型、范围、术语、IPC、重载验收
node verify/smoke.cjs   # 真应用冒烟:隔离的家目录 + 文件当麦克风,全程不出声(要同级有 Forsion-Genesis/desktop)
node verify/slice-probe.mjs <16k 单声道 wav>   # 把一段真实录音喂给切句器,看切成了多长的句子(不开界面)
node verify/live-prompts.mjs   # 真引擎 × 真模型跑翻译 / 纪要 / 随包 Agent 的提示词(烧订阅额度)
sh install.sh           # 装进 ~/.forsion-dev(sh install.sh prod 装进 ~/.forsion)
```

代码在 `src/`:`configuration.ts` 选择范围与术语、`models.ts` 捕获本次调用模型、`vad.ts` 切句、`engine.ts` 录音引擎(只在主窗口跑)、`sync.ts` 跨窗口同步、`ai.ts` 翻译和纪要、`store.ts` 落盘、`ui.ts` 界面。

## English

- **Live transcription** in sentences split at pauses, using Forsion's own speech recognition (Settings › Voice; the on-device model is offline and free).
- **Model choices in Space**: pick transcription and translation models for one recording, follow host slots, or save Space defaults. Global settings retain their values. This requires a host with the model-picker APIs; older hosts retain their previous behavior.
- **Translation scope**: future sentences only, future and failed items, or all existing content. Each sentence retains model and language provenance.
- **Bulk retry and glossary**: retry failed translations and recoverable ASR failures. Add or remove terms directly in Space; changes apply to later recognition.
- **Correction** stays on the selected instruction-capable translation model. Dedicated translation models translate only; corrections are marked and reversible.
- **Ask at any time**: the side panel is Forsion's native chat, working in the recording's folder.
- **Notes, marks, summary with chapters, playback from any timestamp, import of audio / video files (up to two hours).**
- **Runs in the background** when you switch Space, close the tab or hide the window; a mini window shows the latest lines.
- **Three layouts**: transcript first, notes first (transcript in the bottom panel), side by side.

Limits today: no speaker labels, microphone only (no system audio), text appears per sentence rather than per word. All three need new host seams in Forsion.

Everything is saved in your vault, one folder per recording.

Install: Forsion desktop 2.13.2 or later → Store → search "Diting". Tested on macOS only so far.

## License

Apache-2.0
