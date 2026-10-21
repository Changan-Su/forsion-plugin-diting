## 0.3.2 — Automatic upgrade migration / 升级自动迁移

- On a host with the migration API, previous vault-root records automatically copy to the default `Plugins/谛听` before the first list/read/write. Record/index paths are rewritten together; recordings, transcripts, notes and minutes retain their content.
- Original folders stay as backup. A per-vault completion journal prevents repeated imports, including after records are deleted. Manual folder choices are respected; conflicts or incomplete records stop automatic migration and retain recovery options.
- 在新版宿主上自动执行一次旧资料迁移，保留旧目录备份和手动设置；冲突或校验失败时停止保存并显示恢复入口。Space / Agent 版本仍为 0.3.0。

## 0.3.1 — Previous-folder recovery / 旧目录接回

- Detect known previous recording directories and show both old/current counts with explicit confirmation. Validate record JSON before reconnecting the standard work folder; keep paths and files unchanged.
- Separate unreadable indexes from empty storage and block writes when the index is invalid. Refuse folder recovery during active processing or after a vault change.
- 旧目录检测与确认接回；保留原位置和路径；索引损坏时停止保存。Space / Agent 指令版本保持 0.3.0，避免无关布局重置或提示改动。

# 更新记录

## 0.3.0 — 2026-10-19

- Space 内分别选择转文字与翻译模型，可跟随宿主设置或设为 Space 默认；全局设置保持原值
- 翻译模型与语言切换支持仅后续句子、后续和失败项、重译已有内容；迟到结果不会覆盖新译文
- 批量重试失败项；可恢复的转写失败与翻译失败一起处理，完成的句子保持原样
- Space 直接添加、删除术语；每句保留实际模型与译文语言，旧记录兼容读取
- 专用翻译模型不支持纠错时明确提示，不会改用聊天模型
- 在 Space 里换模型要比 2.13.4 更新的桌面版本；2.13.4 及更早的版本上两处显示「跟随语音设置 / 跟随翻译设置」，照旧在设置里换，其余改动都能用

- Choose transcription and translation models in Space; follow host settings or save Space defaults without changing global slots.
- Apply translation changes to future sentences, future and failed items, or all existing content. Late results cannot overwrite replacements.
- Retry failed transcription and translation items in one action; completed sentences retain their content.
- Add and remove glossary terms in Space. Sentence model receipts and translation languages survive reload.
- Dedicated translation models remain selected when correction is enabled; their limitation is shown.
- Choosing models in Space needs a desktop newer than 2.13.4. On 2.13.4 and earlier both fields follow the global settings; everything else works.

## 0.2.0 — 2026-10-13

- 翻译改用 Forsion 的「翻译」模型(设置 → 模型 → 翻译;没选就用聊天当前的模型),不再固定用聊天模型。要比 2.13.3 更新的桌面版本才生效;2.13.3 和更早的版本上和 0.1.1 一样
- 「翻译时顺带纠正听错的词」成了插件设置里的一个开关,默认关。打开以后每句改交给聊天当前的模型,更费额度

## 0.1.1 — 2026-10-13

- 翻译改成默认关:要翻译时在开始页或页面右上角选一种语言。原来默认跟着界面语言开着,中文界面听英文课会一装上就每句调用一次模型

## 0.1.0 — 2026-10-13

第一版。

- 麦克风录音,按说话的停顿切成一句一句,用 Forsion 自己的语音识别转成文字(设置 › 语音;本机模型不联网、不花额度)
- 边录边翻译;翻译时顺带按上下文改听错的词,改过的词有标记,可以改回去,也可以加进术语表
- 右栏是 Forsion 的原生对话,工作目录就是这次记录的文件夹,可以对已经记下的内容随时提问;点一句话可以引用提问
- 笔记(每条自动带时间)、标重点
- 结束后写纪要(课堂 / 会议 / 访谈三种写法)和章节
- 保留录音(可以关),点任何一个时间从那里回放
- 导入已有的音频 / 视频文件(两小时以内)
- 三种布局:转写为主、笔记为主(转写在底部面板)、并排;在插件设置或页面右上角的「…」里换
- 后台:切到别的 Space、关掉标签页、把主窗口收进托盘都继续录;状态栏显示计时
- Mini 小窗:显示最近几句,可以暂停 / 继续 / 标重点 / 记笔记 / 结束
- 中英文界面

还没有的:区分发言人、录电脑里播放的声音、真正逐字出现的流式字幕。这三样都要宿主先加接口。
