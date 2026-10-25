import { act } from './sync'
import { getLocale, t, targetLabel, type Key } from './i18n'
import { on, prefs, S, setPref } from './state'
import { supportsModels } from './models'
import type { ChangeScope, Rec } from './model'

// spoken 没在开始页动过就是 undefined:开录时再读偏好,设置里刚改的默认值才算数。
const initialDraft = () => ({ spoken: undefined as string | undefined, title: '', target: prefs().target, keep: prefs().keep, asrModel: prefs().asrModel, translationModel: prefs().translationModel })
export const recordingDraft = initialDraft()
let submitted = false
on(() => { if (S.phase === 'live' || S.phase === 'importing') submitted = true })
export function prepareDraft(): void { if (submitted) { Object.assign(recordingDraft, initialDraft()); submitted = false } }
const termsDraft = { from: '', to: '' }

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node
}
function button(label: string, click: () => void, className = 'dt-config-button'): HTMLButtonElement {
  const node = el('button', label, className) as HTMLButtonElement; node.type = 'button'; node.onclick = click; return node
}

let dialog: { node: HTMLElement; off(): void; owner?: HTMLElement; before: HTMLElement | null } | null = null
export function closeConfiguration(): void {
  const old = dialog; dialog = null; old?.off(); old?.node.remove()
  if (old?.before?.isConnected) old.before.focus({ preventScroll: true })
}
function showDialog(title: Key, owner: HTMLElement | undefined, content: () => HTMLElement, signature: () => string = () => getLocale()): void {
  closeConfiguration()
  const before = document.activeElement as HTMLElement | null
  const shade = el('div', undefined, 'dt-config-shade')
  const panel = el('section', undefined, 'dt-config-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true')
  shade.append(panel); document.body.append(shade)
  const close = closeConfiguration
  let sig = ''
  const draw = () => {
    const next = signature(); if (next === sig) return; sig = next
    const hadFocus = panel.contains(document.activeElement)
    const field = (document.activeElement as HTMLElement | null)?.dataset.termField
    const head = el('div', undefined, 'dt-config-head'); head.append(el('strong', t(title)), button('×', close)); (head.lastChild as HTMLElement).setAttribute('aria-label', t('cancel'))
    panel.setAttribute('aria-label', t(title)); panel.replaceChildren(head, content())
    if (hadFocus) (field ? panel.querySelector<HTMLElement>(`[data-term-field="${field}"]`) : panel.querySelector<HTMLElement>('input,button'))?.focus()
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') {
      const items = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }
  shade.onclick = event => { if (event.target === shade) close() }
  panel.addEventListener('keydown', keys)
  const off = on(draw); dialog = { node: shade, owner, before, off: () => { off(); panel.removeEventListener('keydown', keys) } }; draw()
  panel.querySelector<HTMLElement>('input,button')?.focus()
}

export function chooseTarget(rec: Rec, target: string, owner?: HTMLElement): void {
  if (!target) { act({ c: 'target', rec: rec.id, target, scope: 'future' }); return }
  if (target === rec.target) return
  scopeDialog(rec, { field: 'target', value: target }, owner)
}
function scopeDialog(rec: Rec, change: { field: 'target' | 'model'; value: string; label?: string }, owner?: HTMLElement): void {
  let selected: ChangeScope = 'future'
  showDialog('modelScopeTitle', owner, () => {
    const body = el('div')
    body.append(el('p', change.field === 'target' ? targetLabel(change.value) : change.label || change.value, 'dt-config-hint'))
    for (const [value, label, hint] of [['future', 'scopeFuture', 'scopeFutureHint'], ['failed', 'scopeFailed', 'scopeFailedHint'], ['all', 'scopeAll', 'scopeAllHint']] as Array<[ChangeScope, Key, Key]>) {
      const row = el('label', undefined, 'dt-config-choice'); const input = document.createElement('input'); input.type = 'radio'; input.name = 'diting-change-scope'; input.value = value; input.checked = selected === value; input.onchange = () => { selected = value }
      const text = el('span'); text.append(el('span', t(label)), el('small', t(hint, { n: rec.segments.filter(s => s.text && !s.fail).length }))); row.append(input, text); body.append(row)
    }
    const actions = el('div', undefined, 'dt-config-actions')
    actions.append(button(t('cancel'), closeConfiguration), button(t('scopeApply'), () => {
      if (change.field === 'target') act({ c: 'target', rec: rec.id, target: change.value, scope: selected })
      else act({ c: 'model', rec: rec.id, kind: 'translation', value: change.value, scope: selected })
      closeConfiguration()
    }, 'dt-config-button primary')); body.append(actions); return body
  })
}

export function showGlossary(owner?: HTMLElement): void {
  showDialog('glossaryOpen', owner, () => {
    const body = el('div'); body.append(el('p', t('glossarySharedHint'), 'dt-config-hint'))
    for (const [from, to] of Object.entries(prefs().terms)) {
      const row = el('div', undefined, 'dt-config-term'); row.append(el('span', `${from} → ${to}`), button(t('del'), () => act({ c: 'termRemove', from }))); body.append(row)
    }
    for (const [field, label] of [['from', 'glossaryFrom'], ['to', 'glossaryTo']] as const) {
      const row = el('label', t(label), 'dt-config-field'); const input = document.createElement('input'); input.value = termsDraft[field]; input.maxLength = 256; input.dataset.termField = field; input.oninput = () => { termsDraft[field] = input.value }; row.append(input); body.append(row)
    }
    const actions = el('div', undefined, 'dt-config-actions')
    actions.append(button(t('glossaryAdd'), () => {
      const from = termsDraft.from.trim(), to = termsDraft.to.trim()
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) { ctx.notify?.(t('glossaryInvalid'), { level: 'warning' }); return }
      termsDraft.from = ''; termsDraft.to = ''; act({ c: 'term', from, to })
    }, 'dt-config-button primary')); body.append(actions); return body
  }, () => `${getLocale()}|${JSON.stringify(prefs().terms)}`)
}

/** Two native menu mounts. State and side effects remain owned by the plugin. */
export function mountModelControls(host: HTMLElement, rec: Rec | null): () => void {
  let alive = true, intent = 0
  const row = el('div', undefined, 'dt-model-row'); const foot = el('div', undefined, 'dt-model-foot'); host.append(row, foot)
  const handles: Array<{ kind: 'asr' | 'translation'; mount: ReturnType<NonNullable<NonNullable<typeof ctx.ui>['mountModelPicker']>> }> = []
  const currentRec = () => rec && (S.open?.id === rec.id ? S.open : S.live?.id === rec.id ? S.live : rec)
  const selected = (kind: 'asr' | 'translation') => rec ? kind === 'asr' ? currentRec()!.asrModel || '' : currentRec()!.translationModel || '' : kind === 'asr' ? recordingDraft.asrModel : recordingDraft.translationModel
  for (const kind of ['asr', 'translation'] as const) {
    const field = el('div', undefined, 'dt-model-field'); field.append(el('span', t(kind === 'asr' ? 'modelAsr' : 'modelTranslation'), 'dt-model-label'))
    const mountHost = el('span', undefined, 'dt-model-picker'); field.append(mountHost); row.append(field)
    const label = t(kind === 'asr' ? 'modelAsr' : 'modelTranslation'), followLabel = t(kind === 'asr' ? 'followVoice' : 'followTranslation')
    if (!supportsModels()) { mountHost.append(el('span', selected(kind) || followLabel)); mountHost.setAttribute('title', t('modelHostRequired')); continue }
    const mount = ctx.ui!.mountModelPicker!(mountHost, { kind, value: selected(kind), label, followLabel, scopeKey: rec?.id || 'new', onChange: value => {
      if (selected(kind) === value) return
      if (!rec) { if (kind === 'asr') recordingDraft.asrModel = value; else recordingDraft.translationModel = value; draw(true); return }
      if (kind === 'asr') { act({ c: 'model', rec: rec.id, kind, value }); ctx.notify?.(t('asrNextSentence'), { level: 'info' }) }
      else if (!currentRec()!.target) act({ c: 'model', rec: rec.id, kind, value, scope: 'future' })
      else {
        const revision = ++intent
        void ctx.tangu!.modelCatalog!('translation').then(catalog => {
          if (!alive || revision !== intent) return
          scopeDialog(currentRec()!, { field: 'model', value, label: value ? catalog.models.find(m => m.id === value)?.name || value : t('followTranslation') }, host)
        }).catch(() => ctx.notify?.(t('modelUnavailable'), { level: 'warning' }))
      }
    } }); handles.push({ kind, mount })
  }
  const save = button(t('spaceDefaults'), () => {
    setPref('asrModel', selected('asr')); setPref('translationModel', selected('translation')); setPref('target', currentRec()?.target ?? recordingDraft.target); setPref('spoken', currentRec()?.spoken ?? recordingDraft.spoken ?? prefs().spoken); ctx.notify?.(t('defaultsSaved'), { level: 'success' })
  }, 'dt-config-link')
  const glossary = button(t('glossaryOpen'), () => showGlossary(host), 'dt-config-link')
  foot.append(el('span', t('modelScopeHint')), glossary, save)
  const correctionHint = el('small', undefined, 'dt-model-correction-hint'); host.append(correctionHint)
  let sig = ''
  const draw = (force = false) => {
    const next = `${selected('asr')}|${selected('translation')}|${getLocale()}|${prefs().fix}`; if (!force && sig === next) return; sig = next
    for (const { kind, mount } of handles) mount.update({ value: selected(kind), label: t(kind === 'asr' ? 'modelAsr' : 'modelTranslation'), followLabel: t(kind === 'asr' ? 'followVoice' : 'followTranslation') })
    correctionHint.textContent = ''
    if (prefs().fix && ctx.tangu?.modelCatalog) void ctx.tangu.modelCatalog('translation').then(catalog => {
      if (!host.isConnected || sig !== next) return
      const choice = catalog.models.find(m => m.id === (selected('translation') || catalog.defaultModelId))
      correctionHint.textContent = choice?.supportsCorrection === false ? t('onlyTranslationMT') : ''
    }).catch(() => undefined)
  }
  const off = on(() => draw()); draw()
  return () => { alive = false; off(); handles.forEach(h => h.mount.dispose()); if (dialog?.owner === host) closeConfiguration(); row.remove(); foot.remove(); correctionHint.remove() }
}
