// 入口:宿主把打包后的这份文件当成函数体执行(new Function('ctx', code)),返回值是卸载时的清理函数。
// 每个窗口(主窗口、Mini 小窗、分出去的窗口)各跑一遍;只有主窗口管录音和写盘。

import { dispose, flush, importFile, setTick } from './engine'
import { duration, setLocale, t } from './i18n'
import { clock, groupOf } from './model'
import { emit, on, OWNER, prefs, S } from './state'
import { init, loadIndex, vaultReady } from './store'
import css from './style.css'
import { act, publish, startSync } from './sync'
import { disposeUi, playerState, mountCaptions, mountChapters, mountChatView, mountMini, mountSession, mountSettings, newRecord, openRecord, pickImport, syncCaptions } from './ui'

const cleanups: Array<() => void> = []

setLocale(ctx.getLocale?.() || 'zh')
const offLocale = ctx.subscribeLocale?.((l) => { setLocale(l); emit() })
if (offLocale) cleanups.push(offLocale)

const style = document.createElement('style')
style.dataset.plugin = 'diting'
style.textContent = css
document.head.append(style)
cleanups.push(() => style.remove())

/** 视图的容器要有高度、能定位(页面是铺满它的)。 */
const hosted = (mount: (el: HTMLElement, view?: HostViewContext) => () => void) => (el: HTMLElement, view?: HostViewContext): (() => void) => {
  el.classList.add('dt-host')
  const off = mount(el, view)
  return () => { off(); el.classList.remove('dt-host') }
}

ctx.registerView({ id: 'session', title: t('name'), icon: 'quote', singleton: true, workspaceSource: 'records', mount: hosted(mountSession) })
ctx.registerView({ id: 'chat', title: t('chat'), icon: 'callout-note', singleton: true, mount: hosted(mountChatView) })
ctx.registerView({ id: 'chapters', title: t('chapters'), icon: 'bulleted-list', singleton: true, mount: hosted(mountChapters) })
ctx.registerView({ id: 'captions', title: t('captions'), icon: 'quote', singleton: true, mount: hosted(mountCaptions) })
ctx.registerView({ id: 'mini', title: t('name'), icon: 'quote', singleton: true, mount: hosted(mountMini) })

// 左栏:记录列表(进行中 / 本周 / 更早)。
ctx.registerListSource?.({
  id: 'records',
  get title() { return t('name') },
  search: true,
  items(filter) {
    const q = (filter?.query || '').trim().toLowerCase(); const now = new Date()
    return S.index.filter((r) => !q || r.title.toLowerCase().includes(q)).map((r) => {
      const live = S.live?.id === r.id && S.phase !== 'idle'
      const group = live ? 'live' : groupOf({ ...r, status: 'done' }, now)
      return {
        key: r.id, title: r.title, icon: 'quote',
        group: t(group === 'live' ? 'groupLive' : group === 'week' ? 'groupWeek' : 'groupEarlier'),
        hint: live ? (S.phase === 'paused' ? t('pausedHint') : t('liveHint')) : duration(r.duration),
        renamable: true,
      }
    })
  },
  subscribe: (cb) => {const off=on(cb);void vaultReady().then(ok=>ok ? loadIndex():undefined).catch(()=>undefined);return off},
  activeKey: () => S.open?.id ?? null,
  open: (item) => { void openRecord(item.key) },
  get actions() { return [{ id: 'new', label: t('newRecord'), primary: true, run: newRecord }, ...(OWNER ? [{ id: 'import', label: t('importFile'), run: pickImport }] : [])] },
  itemMenu: (item) => (S.live?.id === item.key || !ctx.app.trash ? [] : [{ id: 'delete', label: t('deleteRecord'), danger: true, run: () => act({ c: 'delete', rec: item.key }) }]),
  rename: (item, title) => act({ c: 'rename', rec: item.key, title }),
})

ctx.registerCommand({ id: 'open', title: () => t('cmdOpen'), keywords: 'diting 谛听 转写 录音 transcript record', run: () => ctx.openView('session', { location: 'main' }) })
ctx.registerCommand({ id: 'start', title: () => t('cmdStart'), keywords: 'diting 谛听 开始 录音 start record', run: () => { ctx.openView('session', { location: 'main' }); act({ c: 'start', target: prefs().target, keep: prefs().keep }) } })
if (ctx.openMiniPanel) ctx.registerCommand({ id: 'mini', title: () => t('cmdMini'), keywords: 'diting 谛听 mini 小窗', run: () => ctx.openMiniPanel?.('mini', { title: t('name'), mainViewId: 'session' }) })

ctx.registerSettingsView?.({ id: 'general', mount: mountSettings })

cleanups.push(startSync())

if (OWNER) {
  // 状态栏:录着的时候一直在,切到别的 Space 也看得见;点一下回到这次记录。
  const status = ctx.registerStatusItem?.({ id: 'rec', side: 'right', text: '', title: t('statusTitle'), onClick: () => { if (S.live) void openRecord(S.live.id) } })
  let shown = ''
  let was = S.phase
  setTick(() => {
    const text = S.phase === 'live' ? `● ${clock(S.seconds)}` : S.phase === 'paused' ? `❙❙ ${clock(S.seconds)}` : S.phase === 'importing' ? `${t('importing')} ${Math.round(S.progress * 100)}%` : S.phase === 'stopping' ? t('finishing') : ''
    if (status && text !== shown) { shown = text; status.update({ text, title: t('statusTitle') }) }
    // 「笔记为主」的布局:开始录的时候把底部的字幕打开。
    if (was === 'idle' && S.phase !== 'idle') syncCaptions()
    was = S.phase
    publish()
  })
  cleanups.push(on(publish))
  window.addEventListener('beforeunload', flush)
  cleanups.push(() => { window.removeEventListener('beforeunload', flush); if (status) status.dispose(); setTick(() => undefined) })
  void vaultReady(30_000).then(async (ok) => { S.vault = ok; if (ok) await init(); emit() }).catch((e) => console.warn('[diting] startup', e))
} else {
  void vaultReady(30_000).then((ok) => { S.vault = ok; return ok ? loadIndex() : undefined }).then(emit).catch(() => undefined)
}

// 测试用的出口:只有台架预先打了标记才挂(有它的时候回放一律静音)。
let testing = false
try { testing = localStorage.getItem('diting.test') === '1' } catch { /* 读不到就不是测试 */ }
if (testing) window.__DITING_TEST__ = { S, act, prefs, emit, importFile, player: playerState, mini: () => ctx.openMiniPanel?.('mini', { title: t('name'), mainViewId: 'session' }) }

export default (): void => {
  // 插件被停用 / 重载:正在录的先收尾存盘,别留一个没人管的麦克风。
  if (OWNER) dispose()
  disposeUi()
  if (testing) delete window.__DITING_TEST__
  for (const fn of cleanups.splice(0)) { try { fn() } catch (e) { console.warn('[diting] cleanup', e) } }
}
