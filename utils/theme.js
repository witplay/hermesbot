const KEY = 'hermes.theme.v1'

const THEMES = [
  {
    id: 'aurora',
    name: '极光',
    desc: '冷冽青蓝',
    dark: true,
    swatch: 'linear-gradient(135deg, #22d3ee 0%, #4f7cff 55%, #0a1020 100%)',
    accent: '#22d3ee',
    nav: '#060a14',
    vars: {
      bg: '#060a14',
      bg2: '#0a1220',
      panel: 'rgba(14,24,42,0.86)',
      panel2: '#0c1526',
      glass: 'rgba(255,255,255,0.055)',
      glass2: 'rgba(255,255,255,0.015)',
      border: 'rgba(110,190,255,0.16)',
      borderStrong: 'rgba(110,190,255,0.34)',
      text: '#e8f2ff',
      dim: '#93a7c2',
      mute: '#64748b',
      accent: '#22d3ee',
      accent2: '#4f7cff',
      onAccent: '#03121d',
      onGradient: '#03121d',
      line: 'rgba(120,180,255,0.05)',
      glow: 'rgba(34,211,238,0.32)',
      shadow: '0 24rpx 60rpx rgba(0,0,0,0.42)',
      shadowSoft: '0 10rpx 30rpx rgba(0,0,0,0.26)',
      ok: '#34d399',
      warn: '#fbbf24',
      danger: '#fb7185',
      userBubble: 'linear-gradient(150deg, rgba(34,211,238,0.24), rgba(79,124,255,0.32))',
      userBorder: 'rgba(99,180,255,0.36)',
      userText: '#eaf6ff',
      codeBg: 'rgba(3,9,18,0.78)',
      codeText: '#d7ecff',
      inputBg: 'rgba(6,13,24,0.72)',
      fieldBorder: 'rgba(110,190,255,0.2)',
      icon: '#eaf4ff',
      iconSoft: '#a9bdd6',
      surface: '#0b1424',
      surface2: '#101c30',
      surface3: '#16243b',
      chipBg: 'rgba(255,255,255,0.07)',
      composerBg: '#0b1526',
      composerBorder: 'rgba(110,190,255,0.22)',
      bubbleAi: '#0d1829',
      bubbleAiBorder: 'rgba(110,190,255,0.14)',
      headerBg: 'rgba(6,10,20,0.88)',
      headerBorder: 'rgba(110,190,255,0.12)',
      scrim: 'rgba(2,6,16,0.66)',
      link: '#7dd3fc',
      accentSoft: 'rgba(34,211,238,0.14)',
      okSoft: 'rgba(52,211,153,0.14)',
      warnSoft: 'rgba(251,191,36,0.14)',
      dangerSoft: 'rgba(251,113,133,0.14)',
      toolBg: 'rgba(8,17,31,0.65)',
      channelSession: '#22d3ee',
      channelFeishu: '#60a5fa',
      channelApi: '#a78bfa',
      channelCron: '#fbbf24'
    }
  },
  {
    id: 'nebula',
    name: '星云',
    desc: '幽紫幻彩',
    dark: true,
    swatch: 'linear-gradient(135deg, #a78bfa 0%, #f472b6 60%, #120a24 100%)',
    accent: '#a78bfa',
    nav: '#0a0616',
    vars: {
      bg: '#0a0616',
      bg2: '#120a26',
      panel: 'rgba(27,17,48,0.86)',
      panel2: '#160e2b',
      glass: 'rgba(255,255,255,0.06)',
      glass2: 'rgba(255,255,255,0.015)',
      border: 'rgba(190,150,255,0.18)',
      borderStrong: 'rgba(190,150,255,0.38)',
      text: '#f1eaff',
      dim: '#b3a3d4',
      mute: '#7d6fa3',
      accent: '#a78bfa',
      accent2: '#f472b6',
      onAccent: '#150a26',
      onGradient: '#150a26',
      line: 'rgba(190,150,255,0.055)',
      glow: 'rgba(167,139,250,0.36)',
      shadow: '0 24rpx 60rpx rgba(5,0,15,0.5)',
      shadowSoft: '0 10rpx 30rpx rgba(5,0,15,0.32)',
      ok: '#34d399',
      warn: '#fbbf24',
      danger: '#fb7185',
      userBubble: 'linear-gradient(150deg, rgba(167,139,250,0.26), rgba(244,114,182,0.28))',
      userBorder: 'rgba(200,160,255,0.36)',
      userText: '#f7f0ff',
      codeBg: 'rgba(8,3,18,0.78)',
      codeText: '#efe7ff',
      inputBg: 'rgba(12,6,26,0.72)',
      fieldBorder: 'rgba(190,150,255,0.22)',
      icon: '#f3ecff',
      iconSoft: '#c3b3e2',
      surface: '#140b26',
      surface2: '#1b1033',
      surface3: '#241641',
      chipBg: 'rgba(255,255,255,0.07)',
      composerBg: '#150c28',
      composerBorder: 'rgba(190,150,255,0.24)',
      bubbleAi: '#170d2b',
      bubbleAiBorder: 'rgba(190,150,255,0.16)',
      headerBg: 'rgba(10,6,22,0.9)',
      headerBorder: 'rgba(190,150,255,0.14)',
      scrim: 'rgba(4,1,12,0.68)',
      link: '#d8b4fe',
      accentSoft: 'rgba(167,139,250,0.16)',
      okSoft: 'rgba(52,211,153,0.14)',
      warnSoft: 'rgba(251,191,36,0.14)',
      dangerSoft: 'rgba(251,113,133,0.14)',
      toolBg: 'rgba(18,9,34,0.68)',
      channelSession: '#c4b5fd',
      channelFeishu: '#7aa7ff',
      channelApi: '#f0abfc',
      channelCron: '#fbbf24'
    }
  },
  {
    id: 'ember',
    name: '熔金',
    desc: '暖橙余烬',
    dark: true,
    swatch: 'linear-gradient(135deg, #f59e0b 0%, #f43f5e 55%, #140b06 100%)',
    accent: '#f59e0b',
    nav: '#0d0806',
    vars: {
      bg: '#0d0806',
      bg2: '#180f0a',
      panel: 'rgba(34,23,17,0.88)',
      panel2: '#1a110c',
      glass: 'rgba(255,255,255,0.055)',
      glass2: 'rgba(255,255,255,0.015)',
      border: 'rgba(255,180,110,0.16)',
      borderStrong: 'rgba(255,180,110,0.36)',
      text: '#fdf2e3',
      dim: '#c0a993',
      mute: '#8a7462',
      accent: '#f59e0b',
      accent2: '#f43f5e',
      onAccent: '#1a0d03',
      onGradient: '#1a0d03',
      line: 'rgba(255,180,110,0.05)',
      glow: 'rgba(245,158,11,0.32)',
      shadow: '0 24rpx 60rpx rgba(0,0,0,0.45)',
      shadowSoft: '0 10rpx 30rpx rgba(0,0,0,0.3)',
      ok: '#34d399',
      warn: '#fbbf24',
      danger: '#fb7185',
      userBubble: 'linear-gradient(150deg, rgba(245,158,11,0.24), rgba(244,63,94,0.26))',
      userBorder: 'rgba(255,180,110,0.36)',
      userText: '#fff4e6',
      codeBg: 'rgba(10,5,2,0.8)',
      codeText: '#ffe9cf',
      inputBg: 'rgba(16,9,5,0.72)',
      fieldBorder: 'rgba(255,180,110,0.2)',
      icon: '#fff3e2',
      iconSoft: '#d3b79b',
      surface: '#170e09',
      surface2: '#20140d',
      surface3: '#2b1b11',
      chipBg: 'rgba(255,255,255,0.06)',
      composerBg: '#18100a',
      composerBorder: 'rgba(255,180,110,0.22)',
      bubbleAi: '#1a100a',
      bubbleAiBorder: 'rgba(255,180,110,0.15)',
      headerBg: 'rgba(13,8,6,0.9)',
      headerBorder: 'rgba(255,180,110,0.12)',
      scrim: 'rgba(8,3,1,0.68)',
      link: '#fcd34d',
      accentSoft: 'rgba(245,158,11,0.16)',
      okSoft: 'rgba(52,211,153,0.14)',
      warnSoft: 'rgba(251,191,36,0.14)',
      dangerSoft: 'rgba(251,113,133,0.14)',
      toolBg: 'rgba(24,14,8,0.65)',
      channelSession: '#fbbf24',
      channelFeishu: '#fb923c',
      channelApi: '#f472b6',
      channelCron: '#facc15'
    }
  },
  {
    id: 'daylight',
    name: '晨曦',
    desc: '清爽明亮',
    dark: false,
    swatch: 'linear-gradient(135deg, #2563eb 0%, #22d3ee 55%, #eef4ff 100%)',
    accent: '#2563eb',
    nav: '#f4f7fd',
    vars: {
      bg: '#eef2fa',
      bg2: '#f8faff',
      panel: 'rgba(255,255,255,0.94)',
      panel2: '#ffffff',
      glass: 'rgba(255,255,255,0.92)',
      glass2: 'rgba(244,248,255,0.9)',
      border: 'rgba(15,23,42,0.08)',
      borderStrong: 'rgba(37,99,235,0.28)',
      text: '#0f172a',
      dim: '#55627a',
      mute: '#77849c',
      accent: '#2563eb',
      accent2: '#0891b2',
      onAccent: '#ffffff',
      onGradient: '#ffffff',
      line: 'rgba(15,23,42,0.045)',
      glow: 'rgba(37,99,235,0.2)',
      shadow: '0 20rpx 50rpx rgba(30,64,175,0.1)',
      shadowSoft: '0 10rpx 28rpx rgba(30,64,175,0.08)',
      ok: '#047857',
      warn: '#b45309',
      danger: '#d21743',
      userBubble: 'linear-gradient(150deg, rgba(37,99,235,0.12), rgba(6,182,212,0.14))',
      userBorder: 'rgba(37,99,235,0.22)',
      userText: '#0f172a',
      codeBg: 'rgba(241,245,251,0.95)',
      codeText: '#0f172a',
      inputBg: 'rgba(255,255,255,0.92)',
      fieldBorder: 'rgba(15,23,42,0.12)',
      icon: '#0f172a',
      iconSoft: '#475569',
      surface: '#ffffff',
      surface2: '#f6f9ff',
      surface3: '#eaf0fa',
      chipBg: 'rgba(15,23,42,0.045)',
      composerBg: '#ffffff',
      composerBorder: 'rgba(15,23,42,0.1)',
      bubbleAi: '#ffffff',
      bubbleAiBorder: 'rgba(15,23,42,0.07)',
      headerBg: 'rgba(244,247,253,0.94)',
      headerBorder: 'rgba(15,23,42,0.06)',
      scrim: 'rgba(15,23,42,0.38)',
      link: '#1d4ed8',
      accentSoft: 'rgba(37,99,235,0.1)',
      okSoft: 'rgba(5,150,105,0.1)',
      warnSoft: 'rgba(217,119,6,0.12)',
      dangerSoft: 'rgba(225,29,72,0.1)',
      toolBg: 'rgba(244,248,255,0.95)',
      channelSession: '#2563eb',
      channelFeishu: '#0ea5e9',
      channelApi: '#7c3aed',
      channelCron: '#b45309'
    }
  }
]

function byId(id) {
  for (let i = 0; i < THEMES.length; i++) {
    if (THEMES[i].id === id) return THEMES[i]
  }
  return null
}

function camelToKebab(key) {
  return key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

let currentCache = null
let paletteCache = null
let paletteCacheId = ''

const THEME_OPTIONS = THEMES.map((t) => ({
  id: t.id,
  name: t.name,
  desc: t.desc,
  dark: t.dark,
  swatch: t.swatch,
  accent: t.accent
}))

function varsOf(theme) {
  const vars = theme.vars
  const out = []
  Object.keys(vars).forEach((key) => {
    out.push('--' + camelToKebab(key) + ':' + vars[key])
    if (key === 'accent2') out.push('--accent-2:' + vars[key])
  })
  if (!Object.prototype.hasOwnProperty.call(vars, 'textDim')) {
    out.push('--text-dim:' + vars.dim)
  }
  return out.join(';')
}

function palette() {
  const t = current()
  if (paletteCache && paletteCacheId === t.id) return paletteCache
  const v = t.vars
  paletteCacheId = t.id
  paletteCache = {
    dark: t.dark,
    text: v.text,
    dim: v.dim,
    mute: v.mute,
    accent: v.accent,
    accent2: v.accent2,
    link: v.link,
    codeBg: v.codeBg,
    codeText: v.codeText,
    border: v.border,
    borderStrong: v.borderStrong,
    accentSoft: v.accentSoft,
    surface: v.surface,
    surface2: v.surface2,
    surface3: v.surface3,
    ok: v.ok,
    warn: v.warn,
    danger: v.danger
  }
  return paletteCache
}

function options() {
  return THEME_OPTIONS.slice()
}

function current() {
  if (currentCache) return currentCache
  try {
    currentCache = byId(wx.getStorageSync(KEY)) || THEMES[0]
  } catch (e) {
    currentCache = THEMES[0]
  }
  return currentCache
}

function setTheme(id) {
  const theme = byId(id)
  if (!theme) return current()
  try { wx.setStorageSync(KEY, theme.id) } catch (e) { /* ignore */ }
  currentCache = theme
  paletteCache = null
  paletteCacheId = ''
  return theme
}

function apply(page, extra) {
  const theme = current()
  const patch = Object.assign({
    theme: theme.id,
    themeName: theme.name,
    themeDark: theme.dark,
    themeOptions: options(),
    themeVars: varsOf(theme)
  }, extra || {})
  if (page && typeof page.setData === 'function') page.setData(patch)
  try {
    wx.setNavigationBarColor({
      frontColor: theme.dark ? '#ffffff' : '#000000',
      backgroundColor: theme.nav,
      animation: { duration: 200, timingFunc: 'easeOut' }
    })
    wx.setBackgroundColor({
      backgroundColor: theme.vars.bg,
      backgroundColorTop: theme.vars.bg,
      backgroundColorBottom: theme.vars.bg
    })
    wx.setBackgroundTextStyle({ textStyle: theme.dark ? 'light' : 'dark' })
  } catch (e) { /* older base libraries */ }
  return theme
}

function pick(id, page) {
  setTheme(id)
  const theme = apply(page, { showTheme: false })
  return theme
}

module.exports = {
  KEY,
  THEMES,
  options,
  current,
  setTheme,
  apply,
  pick,
  varsOf,
  palette
}
