const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function utf8(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
        i++
      } else {
        out.push(0xef, 0xbf, 0xbd)
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd)
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

function bytesToBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const b1 = has1 ? bytes[i + 1] : 0
    const b2 = has2 ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += has1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += has2 ? B64[b2 & 63] : '='
  }
  return out
}

function base64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytesSync(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256)
  }
  return out
}

function randomBytes(n) {
  return new Promise((resolve) => {
    if (typeof wx !== 'undefined' && typeof wx.getRandomValues === 'function') {
      wx.getRandomValues({
        length: n,
        success(res) {
          const buf = res && res.randomValues
          if (buf && buf.byteLength >= n) {
            resolve(new Uint8Array(buf).slice(0, n))
            return
          }
          resolve(randomBytesSync(n))
        },
        fail() {
          resolve(randomBytesSync(n))
        }
      })
      return
    }
    resolve(randomBytesSync(n))
  })
}

function shortId(prefix) {
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function safeDecode(value) {
  const text = String(value == null ? '' : value)
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

function parseQuery(url, key) {
  if (!url) return ''
  const qIndex = url.indexOf('?')
  if (qIndex < 0) return ''
  const parts = url.slice(qIndex + 1).split('#')[0].split('&')
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    const k = eq < 0 ? parts[i] : parts[i].slice(0, eq)
    if (safeDecode(k) === key) {
      return eq < 0 ? '' : safeDecode(parts[i].slice(eq + 1).replace(/\+/g, ' '))
    }
  }
  return ''
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (d.getFullYear() === now.getFullYear()) return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function makeError(code, message, extra) {
  const err = new Error(message || code)
  err.code = code
  if (extra) {
    Object.keys(extra).forEach((k) => { err[k] = extra[k] })
  }
  return err
}

function errorText(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return err.message || err.code || '未知错误'
}

module.exports = {
  utf8,
  bytesToBase64,
  base64url,
  randomBytes,
  randomBytesSync,
  shortId,
  safeDecode,
  parseQuery,
  formatTime,
  formatDateTime,
  makeError,
  errorText
}
