const LEVELS = [
  { id: 'minimal', label: '极简' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '很高' },
  { id: 'max', label: '最高' },
  { id: 'ultra', label: '极限' }
]

function shortModel(id) {
  const text = String(id || '')
  const slash = text.lastIndexOf('/')
  return slash >= 0 && slash < text.length - 1 ? text.slice(slash + 1) : text
}

function levelLabel(id) {
  const key = String(id || '').toLowerCase()
  const hit = LEVELS.find((level) => level.id === key)
  return hit ? hit.label : ''
}

function providers(body) {
  return ((body && body.providers) || [])
    .filter((p) => p && p.slug && p.models && p.models.length)
    .map((p) => ({
      slug: p.slug,
      name: p.name || p.slug,
      models: p.models.slice(),
      total: p.total_models || p.models.length,
      current: !!p.is_current,
      caps: p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {}
    }))
    .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
}

function capability(provider, model) {
  const caps = provider && provider.caps
  if (!caps || typeof caps !== 'object') return null
  const cap = caps[model]
  return cap && typeof cap === 'object' ? cap : null
}

function reasoningSupported(provider, model) {
  const cap = capability(provider, model)
  return !cap || cap.reasoning !== false
}

function currentProvider(list, slug) {
  const rows = list || []
  return rows.filter((p) => p.slug === slug)[0] ||
    rows.filter((p) => p.current)[0] ||
    rows[0] || null
}

module.exports = {
  LEVELS,
  shortModel,
  levelLabel,
  providers,
  capability,
  reasoningSupported,
  currentProvider
}
