const auth = require('./auth')
const http = require('./http')
const util = require('./util')
const markdown = require('./markdown')

// A single base64 data URL is materialised as one temp file. Keep it bounded so
// a huge image cannot exhaust the mini program heap before we can show an error.
const MAX_DATA_URL_LENGTH = 16 * 1024 * 1024

function api(endpoint, path, profile) {
  let full = path
  if (profile) {
    full += (full.indexOf('?') >= 0 ? '&' : '?') + 'profile=' + encodeURIComponent(profile)
  }
  return http.authed(endpoint, { path: full, timeout: 30000 }).then((res) => {
    if (res.statusCode === 401) {
      throw util.makeError('AUTH', '登录已过期，请重新登录', { statusCode: 401 })
    }
    if (res.statusCode !== 200) {
      const body = res.data || {}
      const detail = body.detail || body.error
      throw util.makeError('HTTP', typeof detail === 'string'
        ? detail
        : ('请求失败（HTTP ' + res.statusCode + '）'), { statusCode: res.statusCode })
    }
    return res.data || {}
  })
}

function listError(code) {
  if (code === 'ENOENT') return '目录不存在'
  if (code === 'EACCES') return '没有访问权限'
  if (code === 'ENOTDIR') return '路径不是目录'
  return '无法读取目录'
}

function normalizeEntry(entry) {
  const name = entry.name || ''
  const isDirectory = !!entry.isDirectory
  const ext = markdown.extOf(name)
  return {
    name: name,
    path: entry.path || '',
    isDirectory: isDirectory,
    ext: ext,
    isImage: !isDirectory && markdown.isImageName(name),
    isText: !isDirectory && markdown.isTextName(name),
    extLabel: isDirectory ? '文件夹' : (ext ? ext.toUpperCase() + ' 文件' : '文件')
  }
}

function list(endpoint, path, profile) {
  return api(endpoint, '/api/fs/list?path=' + encodeURIComponent(path || ''), profile)
    .then((body) => {
      if (body.error) throw util.makeError('FS', listError(body.error))
      return {
        path: path || '',
        entries: (body.entries || []).map(normalizeEntry)
      }
    })
}

function readText(endpoint, path, profile) {
  return api(endpoint, '/api/fs/read-text?path=' + encodeURIComponent(path || ''), profile)
    .then((body) => {
      if (body.binary) throw util.makeError('BINARY', '该文件不是文本文件')
      return body
    })
}

function readDataUrl(endpoint, path, profile) {
  return api(endpoint, '/api/fs/read-data-url?path=' + encodeURIComponent(path || ''), profile)
    .then((body) => {
      if (!body.dataUrl) throw util.makeError('FS', '无法读取图片')
      return body.dataUrl
    })
}

function defaultCwd(endpoint, profile) {
  return api(endpoint, '/api/fs/default-cwd', profile)
}

function stripLocalScheme(path) {
  let value = String(path || '').trim()
  value = value.replace(/^sandbox:/i, '')
  if (/^file:\/\/\//i.test(value)) {
    const rest = value.replace(/^file:\/\/\//i, '')
    value = /^[a-zA-Z]:[\\/]/.test(rest) ? rest : '/' + rest
  } else {
    value = value.replace(/^file:\/\//i, '').replace(/^file:/i, '')
  }
  return value
}

function absolute(path, cwd) {
  let value = stripLocalScheme(path)
  if (!value) return ''
  // `~` belongs to the server's home directory, not to the session cwd. Leave it
  // intact so the server can resolve it; prefixing cwd used to produce cwd/~/x.
  if (value === '~' || /^~[\\/]/.test(value)) return value.replace(/\\/g, '/')
  if (/^[a-zA-Z]:[\\/]/.test(value)) return value.replace(/\\/g, '/')
  if (value.charAt(0) === '/') return value.replace(/\\/g, '/')
  if (!cwd) return value.replace(/\\/g, '/')
  const base = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = value.replace(/^\.\//, '').replace(/\\/g, '/')
  return base + '/' + rel
}

function parentPath(path) {
  let clean = String(path || '').replace(/[\\/]+$/, '')
  if (!clean || clean === '/') return '/'
  if (/^[a-zA-Z]:$/.test(clean)) return clean + '/'
  if (/^[a-zA-Z]:[\\/]/.test(clean)) {
    const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
    if (idx <= 2) return clean.slice(0, 2) + '/'
    return clean.slice(0, idx).replace(/\\/g, '/')
  }
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (idx <= 0) return '/'
  return clean.slice(0, idx)
}

function download(endpoint, path, profile) {
  const query = 'path=' + encodeURIComponent(path) +
    (profile ? '&profile=' + encodeURIComponent(profile) : '')
  const url = endpoint.baseUrl + '/api/fs/download?' + query

  function fetchWith(token) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url: url,
        header: { Authorization: 'Bearer ' + token },
        timeout: 180000,
        success(res) {
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath)
            return
          }
          reject(util.makeError('HTTP', '下载失败（HTTP ' + res.statusCode + '）', { statusCode: res.statusCode }))
        },
        fail(err) {
          reject(util.makeError('NETWORK', (err && err.errMsg) || '下载失败'))
        }
      })
    })
  }

  return auth.ensureToken(endpoint)
    .then((token) => fetchWith(token))
    .catch((err) => {
      if (!err || (err.statusCode !== 401 && err.code !== 'AUTH')) throw err
      return auth.refresh(endpoint).then((next) => fetchWith(next.accessToken))
    })
}

function openDocument(filePath, name) {
  const ext = markdown.extOf(name)
  const supported = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']
  const options = {
    filePath: filePath,
    showMenu: true,
    success: () => {},
    fail: (err) => {}
  }
  if (supported.indexOf(ext) >= 0) options.fileType = ext
  return new Promise((resolve, reject) => {
    options.success = resolve
    options.fail = (err) => reject(util.makeError('OPEN', (err && err.errMsg) || '无法打开文件'))
    wx.openDocument(options)
  })
}

function open(endpoint, path, profile, name) {
  return download(endpoint, path, profile).then((tempPath) => openDocument(tempPath, name || path))
}

function dataUrlToFile(dataUrl) {
  const raw = String(dataUrl || '')
  if (!raw) return Promise.reject(util.makeError('DATA_URL', '图片数据无效'))
  if (raw.length > MAX_DATA_URL_LENGTH) {
    return Promise.reject(util.makeError('DATA_URL', '图片过大，无法预览'))
  }
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(raw)
  if (!match) return Promise.reject(util.makeError('DATA_URL', '图片数据无效'))
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = !!match[2]
  let payload = match[3]
  if (!isBase64) {
    try { payload = decodeURIComponent(payload) } catch (e) { payload = match[3] }
  }
  let ext = mime.split('/')[1] || 'bin'
  ext = ext.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'bin'
  if (ext === 'jpeg') ext = 'jpg'
  const filePath = wx.env.USER_DATA_PATH + '/hermes_img_' + Date.now() +
    Math.floor(Math.random() * 10000) + '.' + ext
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: filePath,
      data: payload,
      encoding: isBase64 ? 'base64' : 'utf8',
      success: () => resolve(filePath),
      fail: (err) => reject(util.makeError('FILE', (err && err.errMsg) || '图片缓存失败'))
    })
  })
}

function previewLocal(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath) {
      reject(util.makeError('PREVIEW', '图片路径无效'))
      return
    }
    wx.previewImage({
      urls: [filePath],
      current: filePath,
      success: resolve,
      fail: (err) => reject(util.makeError('PREVIEW', (err && err.errMsg) || '无法预览图片'))
    })
  })
}

function isLocalPath(value) {
  const text = String(value || '')
  if (!text) return false
  if (/^(wxfile|file):/i.test(text)) return true
  try {
    if (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH &&
      text.indexOf(wx.env.USER_DATA_PATH) === 0) return true
  } catch (e) { /* ignore */ }
  return false
}

function readImageFile(endpoint, path, profile) {
  return readDataUrl(endpoint, path, profile).then((dataUrl) => dataUrlToFile(dataUrl))
}

function previewDataUrl(dataUrl) {
  return dataUrlToFile(dataUrl).then((filePath) => previewLocal(filePath))
}

function previewImageSrc(endpoint, src, profile, cwd) {
  const value = String(src || '')
  if (!value) return Promise.reject(util.makeError('PREVIEW', '图片路径无效'))
  if (isLocalPath(value)) return previewLocal(value)
  if (/^data:/i.test(value)) return previewDataUrl(value)
  if (/^https?:/i.test(value)) return previewLocal(value)
  if (value.charAt(0) === '/') {
    return readImageFile(endpoint, value, profile).then((filePath) => previewLocal(filePath))
  }
  return readImageFile(endpoint, absolute(value, cwd), profile).then((filePath) => previewLocal(filePath))
}

function previewPath(endpoint, path, profile) {
  return readImageFile(endpoint, path, profile).then((filePath) => previewLocal(filePath))
}

module.exports = {
  list,
  readText,
  readDataUrl,
  readImageFile,
  defaultCwd,
  absolute,
  parentPath,
  download,
  openDocument,
  open,
  dataUrlToFile,
  isLocalPath,
  previewLocal,
  previewDataUrl,
  previewImageSrc,
  previewPath
}
