// 宿主注入的 `ctx`(new Function('ctx', code) 的形参)。只声明本插件用到的面;带 ? 的是较新宿主才有的,用前探测。
// 完整契约见 Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts。

interface HostChatMount {
  ready: Promise<{ ok: boolean; sessionId?: string; error?: string }>
  quote(text: string): void
  prefill(text: string): void
  dispose(): void
}
interface HostViewContext {
  surface?: 'main' | 'mini' | 'floating'
  getParams?(): Readonly<Record<string, unknown>>
  showInMainPanel?(): void
}
interface HostListItem { key: string; title: string; group?: string; hint?: string; icon?: string; renamable?: boolean }
interface HostListAction { id: string; label: string; primary?: boolean; danger?: boolean; run(): void }
type HostLocation = 'main' | 'left' | 'right' | 'bottom'

declare const ctx: {
  app: {
    readFile(path: string): Promise<string | null>
    writeFile(path: string, text: string): Promise<void>
    writeBytes?(path: string, bytes: Uint8Array | ArrayBuffer): Promise<void>
    readBytes?(path: string): Promise<Uint8Array | null>
    assetUrl?(path: string): string
    workFolder?(): string
    vaultRoot?(): string | null
    openNote?(path: string, options?: { reuseKey?: string; activate?: boolean; newTab?: boolean }): void
    loadPage(path: string): void
    reveal?(path: string): void
    trash?(path: string): Promise<void>
    listFiles?(): Promise<string[]>
    openSettings?(target: string): void
  }
  registerView(view: { id: string; title: string; icon?: string; singleton?: boolean; workspaceSource?: string; mount(el: HTMLElement, view?: HostViewContext): (() => void) | void }): void
  openView(viewId: string, opts?: { location?: HostLocation }): void
  closeView?(viewId: string): void
  readonly viewLocations?: readonly HostLocation[]
  openMiniPanel?(viewId: string, opts?: { title?: string; params?: Record<string, unknown>; mainViewId?: string }): void
  registerListSource?(src: {
    id: string; title: string; search?: boolean
    items(filter?: { query?: string; group?: string }): HostListItem[]
    subscribe(cb: () => void): () => void
    activeKey?(): string | null
    open(item: HostListItem): void
    actions?: HostListAction[]
    itemMenu?(item: HostListItem): HostListAction[]
    rename?(item: HostListItem, title: string): void | Promise<void>
  }): void
  registerCommand(command: { id: string; title: string | (() => string); keywords?: string; run(): void }): void
  registerStatusItem?(item: { id: string; text?: string; title?: string; side?: 'left' | 'right'; onClick?(): void }): { update(patch: { text?: string; title?: string }): void; dispose(): void } | void
  registerSettingsView?(def: { id: string; title?: string | (() => string); mount(el: HTMLElement): void | (() => void) }): void
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error' }): void
  getLocale?(): 'zh' | 'en'
  subscribeLocale?(cb: (locale: 'zh' | 'en') => void): () => void
  tangu?: {
    agents?(): Array<{ slug: string; name: string }>
    mountChat?(el: HTMLElement, o?: { agent?: string; folder?: string; title?: string }): HostChatMount
    complete?(req: { prompt: string; selection?: string; before?: string; after?: string; signal?: AbortSignal }): Promise<{ text: string }>
  }
}

interface Window {
  tangu?: {
    transcribeAudio?(req: { audioBase64: string; mime?: string; language?: string; timestamps?: boolean }): Promise<string | { text: string }>
    getConfig?(): Promise<{ asrBackend?: string } | null>
  }
  /** check.mjs / 冒烟用的出口(只在测试里设)。 */
  __DITING_TEST__?: Record<string, unknown>
}

declare module '*.css' { const text: string; export default text }
