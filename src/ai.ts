// 翻译和纪要,都是宿主的一次性调用(不带工具、不进会话)。
// 翻译:宿主有 ctx.tangu.translate 就走它 —— 只翻译,模型是用户在「设置 → 模型 → 翻译」里选的那个(可以是便宜的小模型
// 或专门的翻译模型)。「顺带按上下文改听错的词」要聊天模型按下面那套格式回话,是设置里的一个开关(默认关);
// 旧宿主没有 translate,照旧用 ctx.tangu.complete 一并做。纪要一直走 complete。
// 提示词是给模型读的,一律英文。

import { getLocale, t, targetEnglish } from './i18n'
import { acceptFix, alreadyIn, chunkSegments, clock, looseJson, mergeSummaries, plainLines, readSummary, summaryMd, tagOf, type Rec, type Segment, type SummaryStyle } from './model'
import { emit, prefs, S } from './state'

export const canAi = (): boolean => !!ctx.tangu?.complete

const TRANSLATE = (language: string): string => [
  `The selection is one sentence from a live speech-recognition transcript. The text before it is what was said just earlier (context only); a line starting with "→" is the translation already shown to the user for the sentence above it.`,
  `1. Fix clear recognition errors in the sentence (misheard technical terms, names, homophones) using the context. Change as few words as possible; never add, drop or rephrase content. If nothing is clearly wrong, keep it exactly as it is.`,
  `2. Translate the fixed sentence into ${language}. Keep it natural and concise, keep technical terms, symbols and numbers accurate, and translate a term the same way the earlier "→" lines did.`,
  `Reply in exactly this form and nothing else:`,
  `<source>the fixed sentence, in its original language</source>`,
  `<translation>the ${language} translation</translation>`,
].join('\n')

const STYLE: Record<SummaryStyle, string> = {
  class: 'This is a class or lecture. "points" are the ideas a student must take away, in the order they were taught. "todos" are things the teacher asked students to do (homework, reading, deadlines, exam hints); leave it empty if there were none.',
  meeting: 'This is a meeting. "points" are decisions and conclusions, then the main arguments behind them. "todos" are action items; name the owner and the deadline when they were said.',
  interview: 'This is an interview or conversation. "points" are what the interviewee said that matters, including notable opinions. "todos" are follow-ups that were agreed.',
}

const SUMMARY = (style: SummaryStyle, language: string, part: number, parts: number): string => [
  `The selection is ${parts > 1 ? `part ${part} of ${parts} of ` : ''}a speech transcript. Every line starts with its time as [mm:ss]. The text before the selection, if any, is the listener's own timestamped notes: treat what they wrote down as important.`,
  STYLE[style],
  `Use only what the transcript says. Never invent facts, names, numbers or decisions. The transcript comes from speech recognition, so silently repair obvious mis-hearings.`,
  `Write every value in ${language}. Reply with one JSON object and nothing else:`,
  `{"lead": "two or three sentences saying what this was about", "points": [{"t": "mm:ss", "text": "..."}], "todos": [{"t": "mm:ss", "text": "..."}], "terms": [{"term": "...", "meaning": "one line", "t": "mm:ss"}], "chapters": [{"t": "mm:ss", "title": "short title"}]}`,
  `"t" is the time of the transcript line the item comes from. 5 to 10 points, at most 8 terms (only terms that were explained), and one chapter for every real change of topic.`,
].join('\n')

/** 给 check.mjs 量长度用(一次性补全的指令上限是 2000 字)。 */
export const PROMPTS = { translate: TRANSLATE, summary: SUMMARY }

let changed: (rec: Rec) => void = () => undefined
/** 翻译 / 纪要改了一条记录以后怎么存,由引擎说了算(进行中的攒着存,结束了的立刻存)。 */
export const onChanged = (fn: (rec: Rec) => void): void => { changed = fn }

const waiting: Array<{ rec: Rec; seg: Segment }> = []
let active = 0

export function translate(rec: Rec, seg: Segment): void {
  if (!rec.target || !seg.text || !canAi()) return
  if (alreadyIn(seg.text, rec.target)) { seg.trState = 'skip'; return }
  seg.trState = 'wait'
  waiting.push({ rec, seg })
  pump()
}

/** 把一条记录里还没翻译的句子都排上(换了目标语言、或者打开旧记录以后开翻译)。 */
export function translateAll(rec: Rec): void {
  for (const seg of rec.segments) if (seg.trState !== 'done' && seg.trState !== 'wait') translate(rec, seg)
}

// ponytail: 一句一次调用、同时最多两句。导入长文件时会慢、也费额度;要省就把排队的句子几句并成一次。
function pump(): void {
  while (active < 2 && waiting.length) {
    const job = waiting.shift()!
    active++
    void one(job.rec, job.seg).finally(() => { active--; pump() })
  }
}

/** 换了目标语言:还排着的不要了(调用方会重新排)。 */
export function cancelWaiting(rec: Rec): void { for (let i = waiting.length; i--;) if (waiting[i].rec === rec) waiting.splice(i, 1) }

async function one(rec: Rec, seg: Segment): Promise<void> {
  const target = rec.target
  if (!target) { seg.trState = undefined; return }
  const i = rec.segments.indexOf(seg)
  // 前面几句连同已经给出的译文一起带上:同一个术语前后要译成一样的。
  const before = rec.segments.slice(Math.max(0, i - 6), Math.max(0, i)).filter((s) => s.text).map((s) => (s.tr ? `${s.text}\n→ ${s.tr}` : s.text)).join('\n').slice(-3000)
  try {
    const seam = prefs().fix ? undefined : ctx.tangu?.translate
    const r = seam
      ? await seam({ text: seg.text, language: targetEnglish(target), before })
      : await ctx.tangu!.complete!({ prompt: TRANSLATE(targetEnglish(target)), selection: seg.text, before })
    // 等的时候目标语言换了:这份是旧语言的,不要。
    if (rec.target !== target) return
    const tr = seam ? r.text.trim() : tagOf(r.text, 'translation')
    if (!tr) throw new Error('no translation in reply')
    if (!seam) {
      const fixed = tagOf(r.text, 'source')
      if (!seg.raw && acceptFix(seg.text, fixed)) { seg.raw = seg.text; seg.text = fixed }
    }
    seg.tr = tr; seg.trState = 'done'
  } catch (e) {
    console.warn('[diting] translate', e)
    if (rec.target !== target) return
    seg.trState = 'fail'
  }
  changed(rec)
}

const SUMMARY_LANG: Record<string, string> = { zh: 'Simplified Chinese', en: 'English' }

export async function summarize(rec: Rec, style: SummaryStyle): Promise<void> {
  if (!canAi() || S.summarizing) return
  const segs = rec.segments.filter((s) => s.text)
  if (!segs.length) return
  S.summarizing = rec.id; S.summaryError = ''; emit()
  try {
    // 写给看的人:开了翻译就用翻译的目标语言,没开就用界面语言。
    const language = targetEnglish(rec.target) || SUMMARY_LANG[getLocale()]
    const notes = rec.notes.map((n) => `[${clock(n.t)}] ${n.text}`).join('\n').slice(0, 3800)
    // 一次性补全的正文上限是 2 万字:长的切成几块分别写,再把要点、章节合起来。
    // ponytail: 合并时每块的开头几句直接接在一起,不再让模型重写一遍;长记录的开头会长一些。
    const chunks = chunkSegments(segs, 15000)
    const parts = []
    for (let i = 0; i < chunks.length; i++) {
      const r = await ctx.tangu!.complete!({ prompt: SUMMARY(style, language, i + 1, chunks.length), selection: plainLines(chunks[i]), before: notes || undefined })
      const j = looseJson(r.text)
      if (!j) throw new Error('the model did not return a summary')
      parts.push(readSummary(j))
    }
    const all = mergeSummaries(parts)
    const todoKey = style === 'meeting' ? 'hTodosMeeting' : style === 'interview' ? 'hTodosInterview' : 'hTodosClass'
    const md = summaryMd(all, { points: t('hPoints'), todos: t(todoKey), terms: t('hTerms') })
    if (!md) throw new Error('the model returned an empty summary')
    rec.summary = md; rec.chapters = all.chapters; rec.summaryAt = new Date().toISOString(); rec.summaryStyle = style
    changed(rec)
  } catch (e) {
    S.summaryError = e instanceof Error ? e.message : String(e)
  } finally {
    S.summarizing = ''; emit()
  }
}
