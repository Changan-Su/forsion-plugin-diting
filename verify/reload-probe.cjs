// Reuse only a smoke-created isolated profile; inspect the real host across reloads.
const fs = require('node:fs'), path = require('node:path')
async function main() {
  const desktop = process.env.FORSION_DESKTOP, home = process.env.DITING_PROBE_HOME
  if (!desktop || !path.basename(home || '').startsWith('forsion-diting-')) throw Error('Expected an isolated Diting smoke profile')
  const electron = require(path.join(desktop, 'scripts/lib/launch-electron.cjs'))
  const { startStubEngine } = require(path.join(desktop, 'scripts/lib/stub-engine.cjs'))
  const stub = await startStubEngine()
  const userData = path.join(home, 'userdata')
  let app
  try {
    for (const d of [userData, userData + '-dev']) fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'fixture', modelId: 'm1' }))
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', desktop], cwd: desktop, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    const win = await app.firstWindow()
    await require(path.join(desktop, 'scripts/lib/skip-onboarding.cjs')).skipOnboarding(win)
    win.on('pageerror', e => console.log('PAGE_ERROR', String(e)))
    for (const zoom of [1, 1.1, 1.25, 1, 1.25]) {
      await win.waitForSelector('.dv-groupview')
      await win.evaluate(z => localStorage.setItem('forsion_ui_zoom', String(z)), zoom)
      await win.reload(); await win.waitForTimeout(6000)
      console.log(JSON.stringify(await win.evaluate(async () => {
        const m = await import(document.querySelector('script[type="module"][src]').src)
        const s = Object.values(m).find(x => typeof x === 'function' && x.getState?.().activeIds)?.getState()
        const registry = Object.values(m).find(x => typeof x === 'function' && x.getState?.().spaces)?.getState()
        const getView = Object.values(m).find(x => typeof x === 'function' && x.name === 'getView')
        return { zoom: getComputedStyle(document.body).zoom, active: s?.activeIds, views: s?.views.map(v => `${v.pluginId}:${v.item.id}`), hasView: !!getView?.('plugin:diting:session'), registry: registry?.spaces.map(x => x.id), diskSpaces: (await window.tangu.spacesList()).map(x => ({slug:x.slug,plugin:x.plugin})), health: localStorage.getItem('forsion_plugin_space_health'), spaces: [...document.querySelectorAll('.rb-space')].map(x => x.getAttribute('aria-label')) }
      })))
    }
  } finally { try { await app?.close() } finally { await stub.close() } }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
