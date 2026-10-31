// Keep the renderer free of CDP/Playwright focus emulation. Only the main
// process inspector drives this isolated fake-WAV/offline-ASR fixture.
const fs = require('fs')
const path = require('path')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async ({ inMain, mainWin, vault, SHOTS, ok }) => {
  const holdMs = Number(process.env.HIDE_MS || 330000)
  const cases = (process.env.WINDOWS_BACKGROUND_CASE || 'space,minimize,close').split(',')
  if (!Number.isFinite(holdMs) || holdMs < 1000 || cases.some(c => !['space', 'minimize', 'close'].includes(c))) throw new Error('Invalid native background test interval/cases')
  const page = (js, gesture = false) => inMain(`return await w.webContents.executeJavaScript(${JSON.stringify(js)}, ${gesture})`)
  const until = async (what, fn, timeout = 30000) => {
    const end = Date.now() + timeout
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() >= end) throw new Error(`等不到:${what}`)
      await sleep(400)
    }
  }
  await until('启动页', () => page('!!document.querySelector(".dv-groupview")').catch(() => false))
  await page(`localStorage.setItem('diting.test','1'); localStorage.setItem('plugin.diting.workFolder','谛听'); localStorage.setItem('plugin.diting.target',${JSON.stringify(process.env.DITING_TARGET || 'en')}); localStorage.setItem('forsion_default_space','diting')`)
  await inMain('w.reload(); return true')
  await until('谛听插件就绪', () => page('!!window.__DITING_TEST__ && !!document.querySelector(".dt-start")').catch(() => false))
  ok('无渲染器调试连接的谛听真实主窗口已就绪', true)
  await page(`(() => {
    window.__nativeAudioProbe = []
    const original = AudioContext.prototype.createScriptProcessor
    AudioContext.prototype.createScriptProcessor = function (...args) {
      const node = original.apply(this,args), context = this
      const row = { rate:context.sampleRate,samples:0,callbacks:0,maxGap:0,last:null,start:context.currentTime,wall:Date.now(),context:()=>context.currentTime }
      window.__nativeAudioProbe.push(row)
      node.addEventListener('audioprocess', e => { row.samples += e.inputBuffer.length; row.callbacks++; if(row.last!==null) row.maxGap=Math.max(row.maxGap,e.playbackTime-row.last); row.last=e.playbackTime })
      return node
    }
    window.__DITING_TEST__.act({c:'start'})
  })()`, true)
  const snapshot = () => page(`(() => { const t=window.__DITING_TEST__,r=t.S.live,recognized=r?.segments.filter(s=>!s.fail && typeof s.text==='string' && s.text.trim()) || []; return {phase:t.S.phase,seconds:t.S.seconds,segs:recognized.length,texts:recognized.map(s=>({id:s.id,text:s.text})),folder:r?.folder,error:t.S.error,hidden:document.visibilityState,rows:window.__nativeAudioProbe.map(r=>({rate:r.rate,samples:r.samples,callbacks:r.callbacks,maxGap:r.maxGap,contextSeconds:r.context()-r.start,wallSeconds:(Date.now()-r.wall)/1000}))} })()`)
  await until('真实离线转写开始', async () => { const s=await snapshot(); return s.phase==='live'&&s.segs>=2 },60000)
  if (cases.includes('space')) {
    const a = await snapshot(), t0 = Date.now()
    await page(`(() => { const b=document.querySelector('.rb-space[aria-label="笔记"]'); if(!b) throw Error('Notes space button is unavailable'); b.click() })()`, true)
    await until('笔记 Space 已激活', () => page(`document.querySelector('.rb-space[aria-label="笔记"]')?.classList.contains('on') === true`))
    console.log('开始真实其他 Space 长测', holdMs)
    await sleep(holdMs)
    const b = await snapshot(), wall = (Date.now()-t0)/1000, adv=b.seconds-a.seconds
    fs.writeFileSync(path.join(SHOTS,'space.json'),JSON.stringify({a,b,wall,adv},null,2))
    ok('切到其他 Space 后持续录音和离线转写',adv>wall*.9 && b.segs>a.segs && b.phase==='live',JSON.stringify({wall,adv,segs:[a.segs,b.segs]}))
  }
  const away = async (label, op) => {
    const a = await snapshot(), t0 = Date.now()
    await mainWin(op)
    await until('页面真实 hidden', async () => (await snapshot()).hidden === 'hidden',12000).catch(async error => {
      const diagnostic={snapshot:await snapshot(),windows:await inMain('return BrowserWindow.getAllWindows().map(x=>({id:x.id,url:x.webContents.getURL(),visible:x.isVisible(),minimized:x.isMinimized(),throttling:x.webContents.getBackgroundThrottling(),debugger:x.webContents.debugger.isAttached()}))')}
      fs.writeFileSync(path.join(SHOTS,`${op}-precondition.json`),JSON.stringify(diagnostic,null,2))
      throw error
    })
    const mid = await snapshot()
    console.log('开始真实 hidden 长测', op, holdMs)
    await sleep(holdMs)
    const b = await snapshot()
    const native = await inMain('return {visible:w.isVisible(),minimized:w.isMinimized(),throttling:w.webContents.getBackgroundThrottling()}')
    const wall=(Date.now()-t0)/1000, adv=b.seconds-a.seconds
    const evidence={label,a,mid,b,native,wall,adv}
    fs.writeFileSync(path.join(SHOTS,`${op}.json`),JSON.stringify(evidence,null,2))
    ok(label,b.hidden==='hidden' && native.visible===false && (op!=='minimize'||native.minimized) && native.throttling && adv>wall*.9 && b.segs>mid.segs && b.phase==='live',JSON.stringify({wall,adv,segs:[a.segs,b.segs],hidden:b.hidden,native}))
    if(op==='minimize') await mainWin('restore')
    await mainWin('show'); await sleep(800)
  }
  if(cases.includes('minimize')) await away('实际最小化且页面 hidden 后持续录音和离线转写','minimize')
  if(cases.includes('close')) await away('实际收进托盘且页面 hidden 后持续录音和离线转写','close')
  const beforeStop=await snapshot()
  await page(`window.__DITING_TEST__.act({c:'stop'})`,true)
  await until('录音收尾',async () => (await snapshot()).phase==='idle',90000)
  const record=JSON.parse(fs.readFileSync(path.join(vault,beforeStop.folder,'.record.json'),'utf8'))
  ok('后台录音结果真实落盘且识别文字保留',record.status==='done'&&beforeStop.texts.length>=2&&beforeStop.texts.every(s=>record.segments.some(saved=>saved.id===s.id&&!saved.fail&&saved.text===s.text))&&record.duration>=beforeStop.seconds-1)
}
