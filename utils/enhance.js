const http = require('./http')
const store = require('./store')
const util = require('./util')

const KEY = 'hermes.enhance.v1'
const TIMEOUT_MS = 60000

// 预置的系统提示词参照 CodeBuddy / Cursor 一类产品的「Prompt 增强」实践：
// 只做改写、不做回答，保留原意，补齐工程细节，输出可直接投喂给编码智能体。
const DEFAULT_PROMPT = [
  '你是「提示词增强器」，负责把用户在 AI 编程助手的输入框里写下的模糊需求，改写成一条可以直接交给编码智能体执行的清晰指令。',
  '',
  '必须遵守：',
  '1. 只输出改写后的提示词本身。不要解释、不要寒暄、不要用代码块包裹，也不要直接回答或实现用户的需求。',
  '2. 保留用户的原始意图、语言和专有名词，不要擅自更换技术栈、产品形态或命名。',
  '3. 补齐缺失的关键信息：目标与范围、技术栈与运行环境、界面与交互细节、数据结构或接口、边界与异常、验收标准。',
  '4. 信息不足时可以给出合理的默认假设，但要显式标注为「假设」，方便用户修改。',
  '5. 用简洁的分点表述，每点一句话，删掉空话和营销用语；总长度控制在原文的三倍以内。',
  '6. 用户已经写清楚的部分不要重写，只做必要的补充和顺序整理；原文足够清晰时只做最小改动，不要凭空扩充需求。',
  '7. 输出语言与用户输入保持一致，不要输出任何前言、后缀或「以下是优化后的提示词」之类的引导语。'
].join('\n')

// 只列 OpenAI 兼容接口真正认的档位；空值表示不下发该参数。
const REASONING_LEVELS = [
  { id: '', label: '默认' },
  { id: 'minimal', label: '极简' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' }
]

function normalizeReasoning(value) {
  const id = String(value || '').trim().toLowerCase()
  return REASONING_LEVELS.some((level) => level.id === id) ? id : ''
}

function normalizeBase(raw) {
  let url = String(raw || '').trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/\/+$/, '')
  return store.isValidBaseUrl(url) ? url : ''
}

function readConfig() {
  try {
    const saved = wx.getStorageSync(KEY)
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch (e) {
    return {}
  }
}

function getConfig() {
  const saved = readConfig()
  return {
    baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : '',
    apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
    model: typeof saved.model === 'string' ? saved.model : '',
    reasoning: normalizeReasoning(saved.reasoning),
    systemPrompt: typeof saved.systemPrompt === 'string' && saved.systemPrompt.trim()
      ? saved.systemPrompt
      : DEFAULT_PROMPT
  }
}

function saveConfig(patch) {
  const source = patch && typeof patch === 'object' ? patch : {}
  const next = {
    baseUrl: normalizeBase(source.baseUrl),
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || '').trim(),
    reasoning: normalizeReasoning(source.reasoning),
    systemPrompt: String(source.systemPrompt || '').trim() || DEFAULT_PROMPT
  }
  try { wx.setStorageSync(KEY, next) } catch (e) { /* ignore */ }
  return next
}

function isReady(config) {
  const cfg = config || getConfig()
  return !!(cfg.baseUrl && cfg.model)
}

function normalizeBaseUrl(raw) {
  return normalizeBase(raw)
}

function pickText(body) {
  if (!body || typeof body !== 'object') return ''
  const choices = body.choices
  const choice = choices && choices[0]
  if (!choice) {
    if (body.message && typeof body.message.content === 'string') return body.message.content
    return ''
  }
  const message = choice.message || choice.delta || {}
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return ''
    }).join('')
  }
  if (typeof choice.text === 'string') return choice.text
  return ''
}

// 服务端可能无视 stream:false 仍然回 SSE；两种形态都接受。
function textFromBody(body) {
  if (body && typeof body === 'object') return pickText(body)
  const raw = String(body || '')
  if (!raw) return ''
  if (raw.indexOf('data:') >= 0) {
    let streamed = ''
    raw.split(/\r?\n/).forEach((line) => {
      const text = line.trim()
      if (text.indexOf('data:') !== 0) return
      const chunk = text.slice(5).trim()
      if (!chunk || chunk === '[DONE]') return
      try { streamed += pickText(JSON.parse(chunk)) } catch (e) { /* ignore */ }
    })
    if (streamed) return streamed
  }
  try {
    return pickText(JSON.parse(raw))
  } catch (e) {
    return ''
  }
}

function cleanText(raw) {
  const label = /^(优化后(的)?提示词|增强后(的)?提示词|改写后(的)?提示词|提示词)\s*[:：]\s*/
  let text = String(raw || '').trim().replace(label, '')
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/)
  if (fence) text = fence[1].trim().replace(label, '')
  return text.trim()
}

function errorMessage(res) {
  const body = res && res.data
  if (body && typeof body === 'object') {
    const err = body.error
    if (err && typeof err === 'string') return err
    if (err && typeof err.message === 'string') return err.message
    if (typeof body.detail === 'string') return body.detail
    if (typeof body.message === 'string') return body.message
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 160)
  const code = res && res.statusCode
  if (code === 401 || code === 403) return 'API Key 无效或没有权限（HTTP ' + code + '）'
  if (code === 404) return '接口地址不正确（HTTP 404）'
  if (code === 429) return '请求过于频繁，请稍后再试（HTTP 429）'
  return '接口返回异常（HTTP ' + code + '）'
}

function networkText(err) {
  const raw = String((err && err.message) || '')
  if (/not in domain list|合法域名|domain list/i.test(raw)) {
    return '域名未加入小程序的 request 合法域名：请在公众平台配置，或在开发者工具中勾选「不校验合法域名」'
  }
  if (/timeout|超时/i.test(raw)) return '请求超时，请检查网络或接口地址'
  if (/ssl|certificate|证书/i.test(raw)) return 'HTTPS 证书校验失败，请检查接口地址'
  if (/abort|interrupt/i.test(raw)) return '请求被中断，请重试'
  return raw || '网络请求失败'
}

// 统一的一次性补全请求：run 与 test 共用
function post(config, payload) {
  const base = normalizeBase(config.baseUrl)
  const path = /\/chat\/completions$/i.test(base) ? '' : '/chat/completions'
  const headers = { Accept: 'application/json' }
  if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey

  return http.raw({ baseUrl: base }, {
    path: path,
    method: 'POST',
    headers: headers,
    data: payload,
    timeout: TIMEOUT_MS
  }).then((res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw util.makeError('ENHANCE_HTTP', errorMessage(res), { statusCode: res.statusCode })
    }
    const result = cleanText(textFromBody(res.data))
    if (!result) throw util.makeError('ENHANCE_EMPTY', '模型没有返回可用的文本')
    return result
  }, (err) => {
    throw util.makeError('ENHANCE_NETWORK', networkText(err), { cause: err })
  })
}

function payloadFor(config, messages, temperature) {
  const body = {
    model: config.model,
    stream: false,
    temperature: temperature,
    messages: messages
  }
  // 只有用户显式选了档位才下发，避免不支持该参数的厂商直接 400
  if (config.reasoning) body.reasoning_effort = config.reasoning
  return body
}

function run(text) {
  const input = String(text || '').trim()
  if (!input) return Promise.reject(util.makeError('EMPTY', '没有需要增强的内容'))
  const cfg = getConfig()
  if (!isReady(cfg)) return Promise.reject(util.makeError('UNCONFIGURED', '尚未配置增强提示词模型'))

  return post(cfg, payloadFor(cfg, [
    { role: 'system', content: cfg.systemPrompt },
    { role: 'user', content: input }
  ], 0.4))
}

// 用面板里的草稿配置探一次真实请求，不需要先保存
function test(draft) {
  const source = draft && typeof draft === 'object' ? draft : {}
  const config = {
    baseUrl: normalizeBase(source.baseUrl),
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || '').trim(),
    reasoning: normalizeReasoning(source.reasoning)
  }
  if (!config.baseUrl) return Promise.reject(util.makeError('BAD_URL', '请先填写正确的接口地址'))
  if (!config.model) return Promise.reject(util.makeError('BAD_MODEL', '请先填写模型名称'))

  const started = Date.now()
  return post(config, payloadFor(config, [
    { role: 'user', content: '只回复两个字：正常' }
  ], 0)).then((text) => ({
    text: String(text || ''),
    ms: Date.now() - started,
    model: config.model
  }))
}

module.exports = {
  KEY,
  DEFAULT_PROMPT,
  REASONING_LEVELS,
  normalizeBaseUrl,
  normalizeReasoning,
  getConfig,
  saveConfig,
  isReady,
  run,
  test
}
