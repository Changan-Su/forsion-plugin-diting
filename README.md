# 谛听 Diting

Forsion 的插件:把上课、开会、访谈时听到的话变成带时间的文字,可以同时翻译,可以随时提问,结束以后写纪要。

A Forsion plugin that turns what you hear in a class, meeting or interview into timestamped text, translates it as it goes, answers questions about it at any time, and writes a summary when it ends. (English notes are at the end.)

## 能做什么

- **实时转写**:按说话的停顿切成一句一句,一句说完一两秒内出文字。用的是 Forsion 自己的语音识别(设置 › 语音),选本机模型就不联网、不花额度。
- **实时翻译**:每句下面跟着译文(也可以左右对照)。翻译时顺带按上下文改听错的专业词,改过的词下面有细线,点开能看到原来听成了什么、改回去、或者加进术语表。
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
- 翻译一句调用一次模型,用的是主对话当前选的那个模型。用按量计费的模型时,一节 50 分钟的课大约是三四百次小调用。
- 退出 Forsion、电脑睡眠时记录会停;已经记下的内容都在。
- 换翻译语言会把这条记录里已有的句子全部重译(同样是一句一次调用);只是关掉翻译的话,译文留着,再开回同一种语言不用重来。
- 右栏的对话第一次提问时才会建(它是一条真的 Forsion 会话,会出现在主对话列表里),每条记录一条。
- 暂停再继续,录音文件和文字的时间每次可能差出 0.1 秒左右。

前三条都要 Forsion 宿主先加接口(主进程里的流式识别、说话人分离、系统声音采集)。

## 开发

```bash
npm install
node build.mjs          # src/ → main.js(要提交,商店安装时不构建)
node check.mjs          # 纯逻辑自检:切句、数据模型、文案成对、发布物和源码一致
node verify/smoke.cjs   # 真应用冒烟:隔离的家目录 + 文件当麦克风,全程不出声(要同级有 Forsion-Genesis/desktop)
node verify/slice-probe.mjs <16k 单声道 wav>   # 把一段真实录音喂给切句器,看切成了多长的句子(不开界面)
node verify/live-prompts.mjs   # 真引擎 × 真模型跑翻译 / 纪要 / 随包 Agent 的提示词(烧订阅额度)
sh install.sh           # 装进 ~/.forsion-dev(sh install.sh prod 装进 ~/.forsion)
```

代码在 `src/`:`vad.ts` 切句、`engine.ts` 录音引擎(只在主窗口跑)、`sync.ts` 跨窗口同步、`ai.ts` 翻译和纪要、`store.ts` 落盘、`ui.ts` 界面。

## English

- **Live transcription** in sentences split at pauses, using Forsion's own speech recognition (Settings › Voice; the on-device model is offline and free).
- **Live translation** under each sentence, with context-based correction of misheard terms (marked, reversible, and addable to a glossary).
- **Ask at any time**: the side panel is Forsion's native chat, working in the recording's folder.
- **Notes, marks, summary with chapters, playback from any timestamp, import of audio / video files (up to two hours).**
- **Runs in the background** when you switch Space, close the tab or hide the window; a mini window shows the latest lines.
- **Three layouts**: transcript first, notes first (transcript in the bottom panel), side by side.

Limits today: no speaker labels, microphone only (no system audio), text appears per sentence rather than per word. All three need new host seams in Forsion.

Everything is saved in your vault, one folder per recording.

## License

Apache-2.0
