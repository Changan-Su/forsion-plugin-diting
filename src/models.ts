import { t } from './i18n'
import type { ModelReceipt } from './model'

export type ModelKind = 'asr' | 'translation'
export const supportsModels = (): boolean => !!ctx.tangu?.modelCatalog && !!ctx.ui?.mountModelPicker
export async function resolveModel(kind: ModelKind, selected = ''): Promise<ModelReceipt & { supportsCorrection?: boolean }> {
  const read = ctx.tangu?.modelCatalog
  if (read) {
    const catalog = await read(kind)
    const id = selected || catalog.defaultModelId
    const model = catalog.models.find(m => m.id === id)
    if (selected && (!model || !model.available)) throw new Error(t('modelUnavailable'))
    if (kind === 'asr') return { id, name: model?.name || id || t('cloudDefault'), backend: id === 'local' ? 'local' : 'cloud' }
    return { id, name: model?.name || id || t('followTranslation'), supportsCorrection: model?.supportsCorrection !== false }
  }
  if (selected) throw new Error(t('modelHostRequired'))
  // Old hosts choose their route when executing; they cannot confirm a queued model snapshot.
  if (kind === 'asr') return { id: '', name: t('followVoice') }
  return { id: '', name: t('followTranslation'), supportsCorrection: true }
}
/** Capture the host slot when queued, and handle rejection immediately even if this job waits. */
export const captureModel = (kind: ModelKind, selected?: string) => resolveModel(kind, selected).then(model => ({ model, error: null }), error => ({ model: null, error }))
