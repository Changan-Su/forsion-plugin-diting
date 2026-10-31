#!/usr/bin/env node
/**
 * 真应用里的冒烟:隔离的 Forsion 家目录 + 把一个 WAV 文件当成麦克风喂进去。**全程不出声**(不放音、不用真麦克风;回放一律静音)。
 *
 *   node build.mjs && node verify/smoke.cjs
 *   DITING_WAV=/path/to/16k-mono.wav node verify/smoke.cjs     # 换成真实录音(默认用系统的 say 合成几句中文)
 *   DITING_SPOKEN=en …                                          # 钉「说的是」(英文录音给 en:导入的那条不许混进中日韩文字)
 *   DITING_TARGET=zh …                                          # 翻译成哪种语言(默认 en;英文录音要给 zh,不然不用翻)
 *   KEEP=1 …                                                    # 跑完留着临时目录
 *   HIDE_MS=330000 …                                            # 窗口隐藏那两段各等多久(默认 25 秒;超过 5 分钟才碰得到 Chromium 对长时间隐藏页面的重度降频)
 *   REAL_AI=1 [REAL_MODEL=codex/gpt-6-luna] …                   # 翻译 / 纪要转给真引擎 + 真模型(真烧订阅额度:每句一次小调用);
 *                                                               #   要同级有 Forsion-Genesis/tangu-agent 且已 build,凭证软链 ~/.forsion-dev/provider-auth.json
 *
 * 要求:macOS;同级目录有 Forsion-Genesis/desktop(已 npm install、已 build);本机装过离线语音模型
 * (~/.forsion-dev/models/sensevoice 或 ~/.forsion/models/sensevoice,只读链接过去用,不联网、不花额度)。
 * 翻译和纪要由脚本里的假引擎回话:这里验的是「接没接对」,模型写得好不好要另跑真模型。
 *
 * 验:① 录音 → 切句 → 识别 → 翻译 → 落盘;② 切到别的 Space、窗口隐藏、窗口关掉(收进托盘)时继续录;
 *     ③ Mini 小窗跟着显示,并且能从小窗暂停 / 继续 / 记笔记;④ 结束后的文件、纪要、回放拖动(静音);
 *     ⑤ 三种布局;⑥ 上次没正常结束的记录被收尾。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const HERE = path.resolve(__dirname, '..')
const DESK = process.env.FORSION_DESKTOP || path.resolve(HERE, '../../Forsion-Genesis/desktop')
const { MAC_FLAGS, workspaceEnv } = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const { startStubEngine } = require(path.join(DESK, 'scripts/lib/stub-engine.cjs'))
const { synthMic } = require(path.join(DESK, 'scripts/lib/voice-fixture.cjs'))

const SHOTS = process.env.SHOTS || path.join(HERE, '.shots'); fs.mkdirSync(SHOTS, { recursive: true })
const NATIVE_ONLY = process.env.WINDOWS_NATIVE_AUDIO_ONLY === '1' || process.argv.includes('--native-background')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const results = []
// 被测的桌面有没有专门的翻译口子(ctx.tangu.translate):有 → 谛听默认逐句只翻译;没有(2.13.3 及更早)→ 照旧翻译 + 纠正一起做。
const HOST_SEAM = /\btranslate\?\(req:/.test(fs.readFileSync(path.join(DESK, 'frontend/src/amadeus/plugins/types.ts'), 'utf8'))
const ok = (name, pass, detail = '') => { results.push({ name, pass: !!pass }); console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`) }

const LINES = ['今天我们讲二能级原子和辐射场的相互作用。', '先把电场写成一个单色的平面波。', '然后我们需要做一个近似,叫做旋转波近似。', '这样方程里只剩下缓慢变化的那一项。', '最后得到的振荡频率叫做拉比频率。']

/** 起一个真引擎(和 verify/live-prompts.mjs 同一套隔离办法):只给一次性补全用。 */
async function startRealEngine(home) {
  const ENGINE = process.env.FORSION_ENGINE || path.resolve(HERE, '../../Forsion-Genesis/tangu-agent')
  const entry = path.join(ENGINE, 'dist/standalone/main.js'); const auth = path.join(os.homedir(), '.forsion-dev/provider-auth.json')
  if (!fs.existsSync(entry) || !fs.existsSync(auth)) throw new Error(`REAL_AI 要 ${entry} 和 ${auth}`)
  const shared = path.join(home, 'real-engine', 'forsion'); const th = path.join(shared, 'tangu'); fs.mkdirSync(th, { recursive: true })
  const link = path.join(shared, 'provider-auth.json'); fs.symlinkSync(auth, link)
  const port = await freePort(); const token = require('crypto').randomUUID(); const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(th, 'state.db'), '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', token],
    { env: { ...process.env, TANGU_HOME: th, TANGU_DEFAULT_WORKSPACE: path.join(home, 'real-engine', 'workspace'), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' }, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break; await sleep(500); if (i === 59) throw new Error('真引擎 30 秒没起来') }
  try { fs.unlinkSync(link) } catch { /* 引擎已经读完 */ }
  const model = process.env.REAL_MODEL || 'codex/gpt-6-luna'
  console.log(`真引擎就绪,模型 ${model}`)
  return { base, token, model, ms: [], stop: () => child.kill('SIGTERM') }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-diting-'))
  const userData = path.join(home, 'userdata'); const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true }); fs.writeFileSync(path.join(vault, '选题.md'), '# 选题\n')

  // 插件:只拷发布时会带的那几样
  const dest = path.join(home, 'plugins', 'diting'); fs.mkdirSync(dest, { recursive: true })
  for (const f of ['manifest.json', 'main.js', 'icon.svg', 'icon.png', 'spaces', 'agents']) fs.cpSync(f === 'main.js' && process.env.DITING_BUNDLE ? process.env.DITING_BUNDLE : path.join(HERE, f), path.join(dest, f), { recursive: true })

  // 离线语音模型:链接本机已有的
  const model = [process.env.DITING_MODEL, path.join(os.homedir(), '.forsion-dev/models/sensevoice'), path.join(os.homedir(), '.forsion/models/sensevoice')].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'tokens.txt')))
  if (!model) throw new Error('本机没有离线语音模型(设置 › 语音 里下载一次)')
  fs.mkdirSync(path.join(home, 'models'), { recursive: true }); fs.symlinkSync(model, path.join(home, 'models', 'sensevoice'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ asr: { backend: 'local' } }))

  // 一条「上次没正常结束」的旧记录(夹具;插件自己装好是空的)
  const oldFolder = '谛听/2026-10-01 0900 没收尾的那次'
  fs.mkdirSync(path.join(vault, oldFolder), { recursive: true })
  const old = { v: 1, id: 'old1', folder: oldFolder, title: '没收尾的那次', createdAt: '2026-10-01T08:00:00.000Z', duration: 0, status: 'live', source: 'mic', target: '', segments: [{ id: 1, start: 2, end: 6, text: '这是上次留下来的一句话。' }], notes: [], chapters: [] }
  fs.writeFileSync(path.join(vault, oldFolder, '.record.json'), JSON.stringify(old))
  fs.writeFileSync(path.join(vault, '谛听', '.diting-index.json'), JSON.stringify([{ id: 'old1', folder: oldFolder, title: old.title, createdAt: old.createdAt, duration: 0, status: 'live' }]))

  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
  }

  // 假麦克风:不带 %noloop,文件放完从头再来(窗口隐藏那几段要一直有人说话)
  const wav = process.env.DITING_WAV || synthMic(home, LINES, [0.8, 1.6, 1.6, 1.6, 1.6, 1.6]).file
  const mic = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--disable-features=AudioServiceOutOfProcess']

  // REAL_AI:另起一个真引擎(隔离的家目录),假引擎把一次性补全原样转给它
  const REAL = process.env.REAL_AI === '1' ? await startRealEngine(home) : null

  // 假引擎:只多接一条一次性补全(翻译 / 纪要)
  const inline = []; const cloudAsr = []; let cloudFailNext = 0
  const sse = (content) => ({ __buffer: Buffer.from(`data: ${JSON.stringify({ type: 'done', content, toolCallText: false })}\n\n`), contentType: 'text/event-stream' })
  const stub = await startStubEngine({
    ...(process.env.MODEL_UI ? { models: [{ id: 'm1', name: 'Model A', provider: 'probe', source: 'direct', modelType: 'llm' }, { id: 'm2', name: 'Model B', provider: 'probe', source: 'direct', modelType: 'llm' }, { id: 'probe/speech', name: 'Speech probe', provider: 'probe', source: 'direct', modelType: 'asr' }], modelsMeta: { translateModels: [{ id: 'mt', name: 'Translation only', provider: 'probe' }] } } : REAL ? { models: [{ id: REAL.model, name: 'GPT 6 Luna', provider: 'Codex', source: 'direct', modelType: 'llm' }] } : {}),
    handle: async ({ path: p, method, body: read }) => {
      if (p === '/audio/transcriptions' && method === 'POST') { const body = await read(); cloudAsr.push(body.__raw || ''); if (cloudFailNext) { cloudFailNext--; return { __code: 503, body: { detail: 'fixture ASR failure' } } } return { text: '今天我们讲拉比频率。', segments: [{ start: 0, end: 4, text: '今天我们讲拉比频率。' }] } }
      if (p !== '/agent/inline' || method !== 'POST') return undefined
      const body = await read()
      inline.push(body)
      if (REAL) {
        const t0 = Date.now()
        // 收尾时真引擎先关了、还有请求在路上:当成一次失败回给页面,别让脚本自己崩掉。
        try {
          const r = await fetch(`${REAL.base}/agent/inline`, { method: 'POST', headers: { Authorization: `Bearer ${REAL.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
          const text = await r.text(); REAL.ms.push(Date.now() - t0)
          return r.ok ? { __buffer: Buffer.from(text), contentType: 'text/event-stream' } : { __code: r.status, body: { detail: text.slice(0, 200) } }
        } catch (e) { return { __code: 503, body: { detail: String(e && e.message || e).slice(0, 200) } } }
      }
      if (process.env.MODEL_UI) await sleep(100)
      const sel = String(body.selection || '')
      if (String(body.instruction || '').includes('"chapters"')) return sse(JSON.stringify({ lead: '这一讲讲了二能级原子和辐射场。', points: [{ t: '00:02', text: '把电场写成单色平面波' }, { t: '00:09', text: '旋转波近似' }], todos: [], terms: [{ term: '拉比频率', meaning: '布居数振荡的频率', t: '00:15' }], chapters: [{ t: '00:00', title: '开场' }, { t: '00:09', title: '旋转波近似' }] }))
      // 宿主的翻译口子(引擎的 translate 动作):只回译文,不带标签
      if (body.action === 'translate') return sse(`EN: ${sel}`)
      // 顺手「改」一个词,验「按上下文改错」那条路
      // (哪一句都要能「改」到:含「今天」的换成「今日」,别的句子换掉第一个字)
      const fixedSel = sel.includes('今天') ? sel.replace('今天', '今日') : sel.replace(/^./u, (c) => (c === '这' ? '那' : '这'))
      return sse(`<source>${fixedSel}</source>\n<translation>EN: ${sel}</translation>`)
    },
  })

  if (process.env.MODEL_UI) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ asr: { backend: 'local' }, models: { translate: 'm1' }, providers: [{ providerId: 'probe', baseUrl: stub.url, apiKey: 'test-only', asrModelIds: ['speech'] }] }))
  for (const d of [userData, `${userData}-dev`]) fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'fixture', modelId: 'm1' }))

  // 裸起 Electron 再用 CDP 接上:playwright 的 _electron.launch 会顶掉 AudioServiceOutOfProcess,假麦克风就没声音了
  // (desktop 的 scripts/lib/voice-fixture.cjs 记过)。主进程那头(隐藏 / 关闭窗口)走 --inspect。
  const port = await freePort(); const iport = await freePort()
  const launchDesktop = () => {
    const child = spawn(require(path.join(DESK, 'node_modules/electron')), [...mic, ...(NATIVE_ONLY ? [] : [`--remote-debugging-port=${port}`]), `--inspect=${iport}`, `--user-data-dir=${userData}`, '--lang=zh-CN', DESK, ...MAC_FLAGS], {
      cwd: DESK, env: workspaceEnv({ ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const output of [child.stdout, child.stderr]) output.on('data', data => fs.appendFileSync(path.join(home, 'desktop.log'), data))
    return child
  }
  let child = launchDesktop()
  const mainEval = async (expression) => {
    const list = await (await fetch(`http://127.0.0.1:${iport}/json/list`)).json()
    const ws = new WebSocket(list[0].webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('主进程调试口连不上')) })
    const out = await new Promise((r) => { ws.onmessage = (m) => r(JSON.parse(m.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })) })
    ws.close()
    if (out.result?.exceptionDetails) throw new Error(`主进程里执行失败:${out.result.exceptionDetails.exception?.description || expression}`)
    return out.result?.result?.value
  }
  // 主窗口按网址认(Mini 小窗开了以后窗口列表的顺序不可靠;应用还有别的不显示的窗口)
  let mainUrl = ''
  const inMain = (body) => mainEval(`(async () => { const { BrowserWindow } = process.mainModule ? process.mainModule.require('electron') : process.getBuiltinModule ? process.getBuiltinModule('module').createRequire(process.execPath)('electron') : await import('electron'); const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().split('#')[0] === ${JSON.stringify(mainUrl)}); if (!w) throw new Error('找不到主窗口'); ${body} })()`)
  const mainWin = (op, ...args) => inMain(`w.${op}(...${JSON.stringify(args)}); return true`)
  /** 不经 Playwright,直接让主进程在页面里跑一段脚本(隐藏窗口那几段用)。 */
  const inPage = (js) => inMain(`return await w.webContents.executeJavaScript(${JSON.stringify(js)}, true)`)
  const attach = async () => {
    for (let i = 0; i < 100 && !browser; i++) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); if (!browser) await sleep(300) }
    if (!browser) throw new Error('30 秒没接上应用')
    for (let i = 0; i < 60; i++) { for (const pg of pages()) if (!/[?&]window=/.test(pg.url()) && await pg.locator('#root').count().catch(() => 0)) return pg; await sleep(500) }
    throw new Error('30 秒没找到主窗口')
  }
  let failed = null; let browser = null
  const consoleErrors = []
  const pages = () => (browser ? browser.contexts().flatMap((c) => c.pages()) : [])
  try {
    if (NATIVE_ONLY) {
      for (let i = 0; i < 100 && !mainUrl; i++) {
        mainUrl = await mainEval(`(async () => { const { BrowserWindow } = process.mainModule.require('electron'); return BrowserWindow.getAllWindows().map(w => w.webContents.getURL()).find(url => url.startsWith('file:') && !/[?&]window=/.test(url))?.split('#')[0] || '' })()`).catch(() => '')
        if (!mainUrl) await sleep(300)
      }
      if (!mainUrl) throw new Error('30 秒没找到原生主窗口')
      await require('./native-background.cjs')({ inMain, mainWin, home, vault, SHOTS, ok })
    } else {
    let win = await attach()
    if (process.env.AUDIO_PROBE) await win.addInitScript(() => {
      // Observe the native callback without replacing its data or scheduling.
      window.__audioProbe = []
      const original = AudioContext.prototype.createScriptProcessor
      AudioContext.prototype.createScriptProcessor = function (...args) {
        const node = original.apply(this, args)
        const context = this
        const row = { rate: context.sampleRate, samples: 0, callbacks: 0, maxGap: 0, lastPlayback: null, start: context.currentTime, wall: Date.now(), context: () => context.currentTime }
        window.__audioProbe.push(row)
        node.addEventListener('audioprocess', e => {
          row.samples += e.inputBuffer.length; row.callbacks++
          if (row.lastPlayback !== null) row.maxGap = Math.max(row.maxGap, e.playbackTime - row.lastPlayback)
          row.lastPlayback = e.playbackTime
        })
        return node
      }
    })
    mainUrl = win.url().split('#')[0]
    await mainWin('setContentSize', 1440, 900)
    await win.waitForTimeout(2000)
    // 合成的那几句是中文,翻成英文;换成真实录音时用 DITING_TARGET 指定(英文课要翻成中文就给 zh)。
    await win.evaluate(([target, spoken]) => { localStorage.setItem('diting.test', '1'); localStorage.setItem('plugin.diting.workFolder', '谛听'); localStorage.setItem('plugin.diting.target', target); if (spoken) localStorage.setItem('plugin.diting.spoken', spoken) }, [process.env.DITING_TARGET || 'en', process.env.DITING_SPOKEN || ''])
    await win.reload(); await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const errors = []
    const watch = pg => { pg.on('pageerror', e => errors.push(String(e))); pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text()) }) }; watch(win)
    const shot = async (name, page = win) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
    const enter = async (label) => {
      const hit = () => win.evaluate((l) => { const b = [...document.querySelectorAll('.rb-space')].find((x) => [x.getAttribute('aria-label'), x.getAttribute('title'), (x.querySelector('.rb-label')?.textContent || '').trim()].includes(l)); if (b) b.click(); return !!b }, label)
      let found = await hit()
      if (!found) {
        // Plugins register asynchronously after a window reload. Wait for the
        // actual space button; the workspace shell alone is not plugin readiness.
        for (let i = 0; i < 40 && !found; i++) {
          // Reload preserves an expanded ribbon. Toggle only a collapsed one;
          // otherwise a pending plugin load gets hidden for the whole wait.
          const more = win.locator('.rb-top .rb-more[aria-expanded="false"]').first()
          if (await more.count()) await more.click()
          await sleep(500); found = await hit()
          if (!found && await win.locator('.rb-top .rb-more[aria-expanded="true"]').count()) {
            // At 125% UI zoom the expanded ribbon still virtualizes its tail.
            // Scroll the actual ribbon instead of assuming all icons exist.
            await win.locator('.rb-top .rb-strip').hover(); await win.mouse.wheel(0, 220)
          }
        }
        if (!found) {
          const diagnostic = await win.evaluate(async () => {
            const src = document.querySelector('script[type="module"][src]').src
            const mod = await import(src)
            const store = Object.values(mod).find(x => typeof x === 'function' && x.getState?.().activeIds)
            const s = store?.getState()
            return { url: location.href, plugins: await window.amadeus.listPlugins().then(xs => xs.map(x => ({ id: x.id, blocked: x.blocked })), e => String(e)), disabled: localStorage.getItem('amadeus.plugins.disabled'), buttons: [...document.querySelectorAll('.rb-space')].map(x => x.getAttribute('aria-label')), host: s ? { active: s.activeIds, plugins: s.plugins.map(p => ({ id: p.id, error: p.error })), views: s.views.map(v => ({ plugin: v.pluginId, id: v.item.id })), keys: Object.keys(s) } : null }
          })
          fs.writeFileSync(path.join(SHOTS, 'missing-space.json'), JSON.stringify(diagnostic, null, 2))
          throw new Error(`功能条上没有 ${label}`)
        }
      }
      await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click()); await win.waitForTimeout(1200)
    }
    const T = (fn, arg) => win.evaluate(fn, arg)
    const state = () => T(() => { const t = window.__DITING_TEST__; const r = t.S.live; return { phase: t.S.phase, seconds: t.S.seconds, segs: r ? r.segments.length : -1, texts: r ? r.segments.map((s) => s.text) : [], tr: r ? r.segments.filter((s) => s.trState === 'done').length : 0, trs: r ? r.segments.map((s) => s.tr || '') : [], fixed: r ? r.segments.filter((s) => s.raw).length : 0, notes: r ? r.notes.map((n) => n.text) : [], error: t.S.error, hidden: document.visibilityState, healed: t.S.healed, index: t.S.index.map((x) => `${x.id}:${x.status}`) } })
    const audioProbe = async label => {
      if (!process.env.AUDIO_PROBE) return
      const rows = await inPage('window.__audioProbe?.map(r => ({ rate: r.rate, samples: r.samples, callbacks: r.callbacks, maxGap: r.maxGap, contextSeconds: r.context() - r.start, wallSeconds: (Date.now() - r.wall) / 1000 }))')
      console.log('AUDIO_PROBE ' + JSON.stringify({ label, rows }))
    }
    const until = async (what, fn, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const s = await state(); if (fn(s)) return s; if (Date.now() > end) throw new Error(`等不到:${what} — ${JSON.stringify(s)}`); await sleep(400) } }

    await enter('谛听')
    await win.waitForSelector('.dt-start', { timeout: 20_000 })
    ok('插件装载,进 Space 看到开始页', !!(await T(() => window.__DITING_TEST__)))
    const healed = await until('旧记录被收尾', (s) => s.index.includes('old1:done'), 20_000).then(() => true, () => false)
    ok('上次没正常结束的记录:状态改成已结束,内容还在', healed && JSON.parse(fs.readFileSync(path.join(vault, oldFolder, '.record.json'), 'utf8')).segments.length === 1)
    ok('右栏默认显示的是对话,不是章节', await T(() => { const a = document.querySelector('.dt-chat'); return !!a && a.offsetParent !== null }))
    await shot('01-start')

    if (process.env.MODEL_UI) {
      await require('./space-models.cjs').run({ win, T, state, until, shot, ok, enter, inline, cloudAsr, failNextAsr: () => { cloudFailNext = 3 }, vault, home, mainWin })
    } else {
    await win.locator('[data-field="title"]').fill('PHYS3721 第 2 讲')
    await win.locator('.dt-go').click()
    await until('开始录', (s) => s.phase === 'live')
    const first = await until('识别出两句', (s) => s.segs >= 2, 40_000)
    ok('麦克风 → 切句 → 识别', first.segs >= 2, first.texts.slice(0, 2).join(' / '))
    const tr = await until('翻译出来', (s) => s.tr >= 1, REAL ? 60_000 : 20_000).then((s) => s, () => null)
    ok(REAL ? '翻译(真模型)' : '翻译(假引擎回话)', !!tr, `一次性补全被调了 ${inline.length} 次`)
    if (!REAL) {
      const shown = (tr ? tr.trs : []).filter(Boolean)
      const calls = inline.filter((b) => !String(b.instruction || '').includes('"chapters"'))
      if (HOST_SEAM) {
        const targetLanguage = { zh: 'Simplified Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish' }[process.env.DITING_TARGET || 'en']
        ok('翻译走宿主的翻译口子:引擎收到的是 translate 动作 + 目标语言,显示的只有译文', calls.length > 0 && calls.every((b) => b.action === 'translate' && b.language === targetLanguage && b.selection) && shown.length > 0 && shown.every((x) => x.startsWith('EN: ') && !x.includes('<')), `${calls.length} 次;第一句:${shown[0] || ''}`)
        ok('默认不改原文(「顺带纠正」关着)', tr && tr.fixed === 0)
        // 打开「翻译时顺带纠正听错的词」:后面的句子回到聊天模型那条(按固定格式回话、原文被改正)
        await T(() => { localStorage.setItem('plugin.diting.fix', 'true') })
        const fx = await until('打开纠正后有句子被改', (s) => s.fixed >= 1, 40_000).then((s) => s, () => null)
        ok('打开「顺带纠正」后使用选中的可纠错翻译模型', !!fx && inline.some((b) => b.action === 'custom' && String(b.instruction || '').includes('<translation>')) && fx.trs.filter(Boolean).every((x) => !x.includes('<')), fx ? `改了 ${fx.fixed} 句` : '')
      } else {
        ok('旧宿主没有翻译口子:照旧一次调用里翻译 + 纠正', calls.length > 0 && calls.every((b) => b.action === 'custom') && shown.length > 0 && shown.every((x) => x.startsWith('EN: ') && !x.includes('<')), `${calls.length} 次;第一句:${shown[0] || ''}`)
      }
    }
    await shot('02-live')
    if (process.env.AUDIO_STRESS) {
      const before = await state()
      const wallStart = Date.now()
      // Deliberately busy the renderer; the audio thread and MediaRecorder keep running.
      await T(() => new Promise(resolve => {
        let times = 0
        const id = setInterval(() => {
          const end = performance.now() + 650
          while (performance.now() < end) { /* simulate a busy application view */ }
          if (++times === 12) { clearInterval(id); resolve() }
        }, 1000)
      }))
      await sleep(600)
      const after = await state(); const wall = (Date.now() - wallStart) / 1000
      ok('渲染线程持续繁忙时采样不丢失', after.seconds - before.seconds > wall * .9, `墙上 ${wall.toFixed(2)}s / 转写 ${(after.seconds - before.seconds).toFixed(2)}s`)
      await audioProbe('renderer-stress')
    }

    // ② 后台:三种「不在眼前」
    {
      const spaceMs = Number(process.env.SPACE_MS || 12_000)
      const a = await state(); await enter('笔记'); await sleep(spaceMs); const b = await state(); await enter('谛听')
      // 真实录音里一句话可以说十几秒,12 秒里不一定正好说完一句;合成的那几句短,必须有新句子。
      ok('切到别的 Space 时继续录', b.seconds - a.seconds > spaceMs / 1000 * 0.9 && (spaceMs >= 300_000 || !process.env.DITING_WAV ? b.segs > a.segs : b.segs >= a.segs), `${spaceMs / 1000} 秒里时间轴走了 ${(b.seconds - a.seconds).toFixed(1)} 秒,句子 ${a.segs} → ${b.segs}`)
      await audioProbe('space')
    }
    // Playwright 接着页面的时候,页面一直算「看得见」(它开了焦点模拟),量不到真的隐藏。
    // 所以这两段先把它断开(应用不受影响),只从主进程那头读页面里的状态,量完再接回来。
    const focusSession = await win.context().newCDPSession(win)
    await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await focusSession.detach()
    await browser.close(); browser = null
    const PROBE = `(() => { const t = window.__DITING_TEST__; return JSON.stringify({ seconds: t.S.seconds, segs: t.S.live ? t.S.live.segments.length : -1, hidden: document.visibilityState, phase: t.S.phase, error: t.S.error }) })()`
    const probe = async () => JSON.parse(await inPage(PROBE))
    const HIDE_MS = Number(process.env.HIDE_MS || 25_000)
    // strict = 页面自己也得算作隐藏(这才碰得到浏览器对隐藏页面的降频,是难的那种情况)。
    // 收进托盘那一段不强求:窗口确实不可见了,但页面有时仍然自认为「看得见」(六次里见过三次,宿主 / 系统的行为),那种情况下本来就不降频。
    const away = async (name, op, strict) => {
      const a = await probe(); const t0 = Date.now(); await mainWin(op)
      // 页面知道自己被隐藏要一点时间:最多等 10 秒,等不到就照实记「没隐藏」。
      let mid = await probe(); for (let i = 0; i < 20 && mid.hidden !== 'hidden'; i++) { await sleep(500); mid = await probe() }
      await sleep(HIDE_MS)
      const b = await probe(); const native = await inMain('return { visible: w.isVisible(), minimized: w.isMinimized(), throttling: w.webContents.getBackgroundThrottling() }'); const shown = native.visible; const wall = (Date.now() - t0) / 1000
      if (op === 'minimize') await mainWin('restore')
      await mainWin('showInactive'); await sleep(800)
      const adv = b.seconds - a.seconds
      ok(name, (strict ? mid.hidden === 'hidden' && b.hidden === 'hidden' : true) && (op === 'minimize' ? native.minimized : shown === false) && adv > wall * 0.9 && b.segs > mid.segs && b.phase === 'live', `页面可见性=${mid.hidden}→${b.hidden},窗口可见=${shown},最小化=${native.minimized},throttling=${native.throttling};墙上 ${wall.toFixed(0)} 秒,时间轴走了 ${adv.toFixed(1)} 秒,句子 ${a.segs} → ${b.segs}${b.error ? `;报错 ${b.error}` : ''}`)
      await audioProbe(name)
    }
    await away(process.env.WINDOWS_EXTENDED ? '主窗口实际最小化时继续录' : '窗口隐藏时继续录', process.env.WINDOWS_EXTENDED ? 'minimize' : 'hide', true)
    if (process.env.WINDOWS_BACKGROUND_CASE !== 'minimize') await away('关掉主窗口(收进托盘)时继续录', 'close', false)
    win = await attach(); watch(win)

    // ③ Mini 小窗
    const before = pages().length
    await T(() => window.__DITING_TEST__.mini())
    let mini = null
    for (let i = 0; i < 40 && !mini; i++) { await sleep(500); for (const w of pages()) { if (w !== win && await w.locator('.dt-mini').count().catch(() => 0)) mini = w } }
    ok('Mini 小窗打开', !!mini, `窗口数 ${before} → ${pages().length}`)
    if (mini) {
      await mini.waitForFunction(() => /\d\d:\d\d/.test(document.querySelector('.dt-mini .tm')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {})
      const m1 = await mini.evaluate(() => ({ tm: document.querySelector('.dt-mini .tm')?.textContent, lines: document.querySelectorAll('.dt-mini .ln').length, kind: document.documentElement.dataset.window }))
      await sleep(3000)
      const m2 = await mini.evaluate(() => document.querySelector('.dt-mini .tm')?.textContent)
      ok('小窗跟着主窗口走(时间在变、有字幕)', m1.lines > 0 && m1.tm !== m2, `窗口类型=${m1.kind},${m1.tm} → ${m2},${m1.lines} 行`)
      await shot('03-mini', mini)
      await mini.locator('[data-act="pause"]').click()
      ok('从小窗暂停', (await until('暂停', (s) => s.phase === 'paused', 8000).then(() => true, () => false)))
      const p1 = await state(); await sleep(2500); const p2 = await state()
      ok('暂停时时间轴不走', Math.abs(p2.seconds - p1.seconds) < 0.3, `${p1.seconds.toFixed(1)} → ${p2.seconds.toFixed(1)}`)
      // 暂停着的时候没有音频回调推着存盘:这时候记的东西要当场落盘,不能等到「继续」。
      const liveDir = await T(() => { const t = window.__DITING_TEST__; t.act({ c: 'note', rec: t.S.live.id, text: '暂停时记的', t: t.S.seconds }); return t.S.live.folder })
      let onDisk = false
      for (let i = 0; i < 20 && !onDisk; i++) { await sleep(200); try { onDisk = JSON.parse(fs.readFileSync(path.join(vault, liveDir, '.record.json'), 'utf8')).notes.some((n) => n.text === '暂停时记的') } catch { /* 正在写 */ } }
      ok('暂停时记的笔记当场存盘,不等「继续」', onDisk)
      await mini.locator('[data-act="resume"]').click()
      ok('从小窗继续', (await until('继续', (s) => s.phase === 'live', 8000).then(() => true, () => false)))
      await mini.locator('.dt-note-in').fill('旋转波近似这里没听懂'); await mini.locator('.dt-note-in').press('Enter')
      ok('从小窗记一条笔记', (await until('笔记', (s) => s.notes.includes('旋转波近似这里没听懂'), 8000).then(() => true, () => false)))
    }

    // ④ 结束
    const folder = await T(() => window.__DITING_TEST__.S.live.folder)
    await win.locator('.dt-dock [data-act="markNow"]').click()
    await win.locator('.dt-dock [data-act="stop"]').click()
    await until('结束', (s) => s.phase === 'idle', 90_000)
    const dir = path.join(vault, folder)
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.record.json'), 'utf8'))
    const audio = rec.audio ? fs.statSync(path.join(dir, rec.audio)).size : 0
    ok('结束后落盘:记录、转写、笔记、录音', rec.status === 'done' && fs.existsSync(path.join(dir, '转写.md')) && fs.existsSync(path.join(dir, '笔记.md')) && audio > 20_000, `${rec.segments.length} 句,${rec.duration} 秒,录音 ${Math.round(audio / 1024)} KB,标了重点 ${rec.segments.filter((s) => s.mark).length} 句`)
    if (REAL) console.log(`  真模型:${REAL.ms.length} 次调用,中位 ${[...REAL.ms].sort((a, b) => a - b)[Math.floor(REAL.ms.length / 2)]} 毫秒;按上下文改了 ${rec.segments.filter((s) => s.raw).length} 句:${rec.segments.filter((s) => s.raw).slice(0, 4).map((s) => `「${s.raw}」→「${s.text}」`).join(' ')}`)
    else ok('按上下文改过的句子留着原样', rec.segments.some((s) => s.raw), `${rec.segments.filter((s) => s.raw).length} 句`)
    ok('时间轴连续(每句的起点不早于上一句)', rec.segments.every((s, i, a) => i === 0 || s.start >= a[i - 1].start))
    await T((ms) => new Promise((r) => { const end = Date.now() + ms; const t = setInterval(() => { const o = window.__DITING_TEST__.S.open; if ((o && o.summary) || Date.now() > end) { clearInterval(t); r() } }, 300) }), REAL ? 120_000 : 20_000)
    ok('结束后自动写纪要和章节', fs.existsSync(path.join(dir, '纪要.md')) && JSON.parse(fs.readFileSync(path.join(dir, '.record.json'), 'utf8')).chapters.length >= (REAL ? 1 : 2))
    await shot('04-done-transcript')

    // 回放:静音,拖到后面看位置对不对
    const target = Math.max(5, Math.floor(rec.duration * 0.6))
    await T((sec) => { const b = document.querySelector('.dt-track'); b.value = String(sec); b.dispatchEvent(new Event('input', { bubbles: true })) }, target)
    await sleep(2500)
    const pl = await T(() => window.__DITING_TEST__.player())
    ok('回放能拖到后面(静音)', pl.muted === true && Math.abs(pl.time - target) < 1.5 && pl.on === false, JSON.stringify(pl))

    // ⑤ 布局 / 标签
    // Current hosts put these modes in the shared view header; old hosts render
    // plugin-local tab buttons. Exercise the visible control in either host.
    await win.locator('button:visible').filter({ hasText: /^纪要$/ }).first().click(); await shot('05-summary')
    await win.locator('button:visible').filter({ hasText: /^笔记$/ }).first().click(); await shot('06-notes')
    await win.locator('[data-act="menu"]').click(); await shot('07-menu')
    await win.locator('.dt-menu [data-act="layout"][data-v="split"]').click(); await win.waitForSelector('.dt-two', { timeout: 8000 })
    ok('并排布局', (await win.locator('.dt-two .dt-scroll').count()) === 2); await shot('08-split')
    await win.locator('[data-act="menu"]').click(); await win.locator('.dt-menu [data-act="layout"][data-v="notes"]').click()
    const cap = await win.waitForSelector('.dt-capview .dt-s', { timeout: 10_000 }).then(() => true, () => false)
    ok('「笔记为主」:转写进了底部面板', cap); await shot('09-notes-layout')
    await win.locator('[data-act="menu"]').click(); await win.locator('.dt-menu [data-act="layout"][data-v="transcript"]').click(); await win.waitForTimeout(800)
    ok('换回「转写为主」后底部面板收起', (await win.locator('.dt-capview').count()) === 0)

    // ⑥ 导入文件(不走系统的选文件对话框:把字节直接交给插件)
    const bytes = fs.readFileSync(wav)
    const had = (await state()).index.length
    await T(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); void window.__DITING_TEST__.importFile(new File([u8], '导入的课.wav', { type: 'audio/wav' })) }, bytes.toString('base64'))
    await until('导入结束', (s) => s.phase === 'idle' && s.index.length > had, 180_000) // 本机模型下几十秒的文件不到一秒就转完,所以不等「开始」
    const impFolder = await T(() => window.__DITING_TEST__.S.open.folder)
    const imp = JSON.parse(fs.readFileSync(path.join(vault, impFolder, '.record.json'), 'utf8'))
    const wavSec = (bytes.length - 44) / 2 / 16000
    ok('导入文件:转成同样的记录,原文件拷进文件夹', imp.source === 'file' && imp.status === 'done' && imp.segments.length >= 3 && Math.abs(imp.duration - wavSec) < 2 && fs.existsSync(path.join(vault, impFolder, '录音.wav')), `${imp.segments.length} 句,${imp.duration} 秒(文件 ${wavSec.toFixed(1)} 秒):${imp.segments.slice(0, 2).map((s) => s.text).join(' / ')}`)
    // 钉了「说的是」:本机模型不许再逐句自己判语言(英文课被判成粤语 / 日语出乱码,10-25 实录)。没钉的时候只报数,当负对照看。
    // 看识别原文(raw):假引擎的「顺带纠正」会把每句第一个字换成「这」。
    const foreign = imp.segments.filter((s) => (process.env.DITING_SPOKEN || 'en') === 'en' ? /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s.raw || s.text) : false)
    if (process.env.DITING_SPOKEN) ok(`「说的是」= ${process.env.DITING_SPOKEN}:识别照着它出字`, imp.spoken === process.env.DITING_SPOKEN && (process.env.DITING_SPOKEN !== 'en' || foreign.length === 0), `${foreign.length}/${imp.segments.length} 句混进别的文字${foreign[0] ? ':' + (foreign[0].raw || foreign[0].text) : ''}`)
    else console.log(`  (没钉语言:${foreign.length}/${imp.segments.length} 句混进中日韩文字)`)
    await shot('10-imported')
    if (process.env.MEDIA_DIR) {
      for (const [ext, type] of [['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['mp4', 'video/mp4']]) {
        const file = path.join(process.env.MEDIA_DIR, `lecture.${ext}`), encoded = fs.readFileSync(file).toString('base64')
        const beforeImport = (await state()).index.length
        await T(({ b64, ext, type }) => { const bytes = Uint8Array.from(atob(b64), x => x.charCodeAt(0)); void window.__DITING_TEST__.importFile(new File([bytes], `中文 课程.${ext}`, { type })) }, { b64: encoded, ext, type })
        await until(`导入 ${ext}`, s => s.phase === 'idle' && s.index.length > beforeImport, 180_000)
        const location = await T(() => window.__DITING_TEST__.S.open.folder)
        const record = JSON.parse(fs.readFileSync(path.join(vault, location, '.record.json'), 'utf8'))
        ok(`真实 ${ext} 解码、转写和原文件落盘`, record.status === 'done' && record.source === 'file' && record.segments.length >= 3 && Math.abs(record.duration - 125) < 2 && fs.existsSync(path.join(vault, location, `录音.${ext}`)), `${record.duration}s / ${record.segments.length} 句`)
      }
    }

    // ⑦ 主窗口收起来以后,从小窗开始一次新的(没有用户在主窗口里点过任何东西)
    if (mini) {
      await mainWin('hide'); await sleep(1500)
      await mini.locator('[data-act="start"]').click()
      const s1 = await until('小窗发起的记录开始', (s) => s.phase === 'live', 20_000).then((s) => s, () => null)
      const s2 = s1 ? await until('有内容', (s) => s.segs >= 1, process.env.DITING_WAV ? 150_000 : 40_000).then((s) => s, () => null) : null
      ok('主窗口隐藏时从小窗开始记录', !!s2, s2 ? `页面可见性=${s2.hidden},${s2.segs} 句` : JSON.stringify(await state()))
      await mini.locator('[data-act="stop"]').click()
      ok('从小窗结束', (await until('结束', (s) => s.phase === 'idle', 90_000).then(() => true, () => false)))
      await mainWin('showInactive'); await sleep(800)
    }
    if (process.env.WINDOWS_EXTENDED && mini) {
      await mainWin('setContentSize', 1100, 800)
      for (const zoom of [1.1, 1.25]) {
        await T(z => localStorage.setItem('forsion_ui_zoom', String(z)), zoom)
        await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await enter('谛听')
        await mini.reload(); await mini.waitForSelector('.dt-mini', { timeout: 20000 })
        const actual = await T(() => parseFloat(getComputedStyle(document.body).zoom))
        const miniZoom = await mini.evaluate(() => parseFloat(getComputedStyle(document.body).zoom))
        ok(`${zoom * 100}% 使用应用实际界面缩放`, Math.abs(actual - zoom) < .001 && Math.abs(miniZoom - zoom) < .001, `main=${actual}, mini=${miniZoom}`)
        await mini.locator('[data-act="start"]').click(); await until('缩放后开始录音', s => s.phase === 'live')
        await win.locator('[data-act="menu"]').click()
        const menu = await win.locator('.dt-menu').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight } })
        ok(`${zoom * 100}% 菜单完整显示在窗口内`, menu.x >= 0 && menu.y >= 0 && menu.right <= menu.w + 1 && menu.bottom <= menu.h + 1, JSON.stringify(menu))
        await win.locator('[data-act="menu"]').click()
        const controlsInside = async page => page.locator('[data-act="pause"]:visible').first().evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 })
        ok(`${zoom * 100}% 录音条和 Mini 控件未被裁切`, await controlsInside(win) && await controlsInside(mini))
        await win.locator('.dt-dock [data-act="pause"]').click(); await until('主窗暂停', s => s.phase === 'paused')
        await mini.locator('[data-act="resume"]').click(); await until('Mini 继续', s => s.phase === 'live')
        await shot(`zoom-${Math.round(zoom * 100)}`); await shot(`mini-zoom-${Math.round(zoom * 100)}`, mini)
        await mini.locator('[data-act="stop"]').click(); await until('缩放测试结束', s => s.phase === 'idle', 90000)
        ok(`${zoom * 100}% 主窗和 Mini 实际操作生效`, (await state()).phase === 'idle')
      }
      await mini.locator('[data-act="start"]').click()
      await until('强退前有真实转写', s => s.phase === 'live' && s.segs >= 2, 60000)
      const crashFolder = await T(() => window.__DITING_TEST__.S.live.folder)
      await sleep(6000)
      const recordFile = path.join(vault, crashFolder, '.record.json')
      const beforeCrash = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      ok('强退前实际记录已经落盘', beforeCrash.status === 'live' && beforeCrash.segments.length >= 2)
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
      await browser.close().catch(() => {}); browser = null
      child = launchDesktop(); win = await attach(); mainUrl = win.url().split('#')[0]; watch(win)
      await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await enter('谛听')
      await until('实际强退记录自动收尾', s => s.index.includes(`${beforeCrash.id}:done`), 30000)
      const recovered = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      ok('真实强退重启后记录结束且已识别文字保留', recovered.status === 'done' && recovered.segments.length >= beforeCrash.segments.length && beforeCrash.segments.every((s, i) => recovered.segments[i]?.text === s.text))
      await shot('actual-crash-recovered')
    }
    }
    ok('页面没有抛错', errors.length === 0, errors.slice(0, 3).join(' | '))
    }
  } catch (e) {
    failed = e
    for (const [i, page] of pages().entries()) {
      await page.screenshot({ path: path.join(SHOTS, `failure-${i}.png`), timeout: 5000 }).catch(() => {})
      fs.writeFileSync(path.join(SHOTS, `failure-${i}.txt`), await page.locator('body').innerText({ timeout: 5000 }).catch(() => 'unavailable'))
    }
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2))
    REAL?.stop()
    await browser?.close().catch(() => {}); child.kill('SIGTERM'); await sleep(800); if (child.exitCode == null) child.kill('SIGKILL'); await stub.close?.()
    if (!process.env.KEEP) fs.rmSync(home, { recursive: true, force: true }); else console.log('临时目录', home)
  }
  fs.writeFileSync(path.join(SHOTS, process.env.MODEL_UI ? 'space-results.json' : process.env.REAL_AI ? 'live-smoke-results.json' : 'smoke-results.json'), JSON.stringify({ results, aborted: failed?.message || null, passed: results.filter(r => r.pass).length }, null, 2))
  if (failed) { console.error('中断:', failed.message); process.exitCode = 1 }
  const bad = results.filter((r) => !r.pass)
  console.log(`\n${results.length - bad.length}/${results.length} 通过${bad.length ? `;没过:${bad.map((r) => r.name).join('、')}` : ''}`)
  if (bad.length) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exit(1) })
