const util = require('./util')

const IMAGE_EXT = {
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1, ico: 1
}

const TEXT_EXT = {
  txt: 1, md: 1, markdown: 1, json: 1, jsonl: 1, js: 1, mjs: 1, cjs: 1, ts: 1, tsx: 1,
  jsx: 1, py: 1, sh: 1, bash: 1, zsh: 1, yml: 1, yaml: 1, toml: 1, ini: 1, conf: 1,
  css: 1, scss: 1, less: 1, html: 1, htm: 1, xml: 1, sql: 1, log: 1, csv: 1, env: 1,
  go: 1, rs: 1, java: 1, c: 1, cpp: 1, h: 1, hpp: 1, rb: 1, php: 1, lua: 1, kt: 1,
  swift: 1, vue: 1, svelte: 1, ipynb: 1, gitignore: 1, lock: 1, diff: 1, patch: 1
}

const FILE_EXT = Object.assign({}, TEXT_EXT, {
  pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, zip: 1, tar: 1, gz: 1,
  tgz: 1, bz2: 1, '7z': 1, rar: 1, png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1,
  mp3: 1, mp4: 1, mov: 1, wav: 1, m4a: 1, ogg: 1, webm: 1, apk: 1, exe: 1, bin: 1,
  db: 1, sqlite: 1, sqlite3: 1, parquet: 1, xmind: 1, sketch: 1, fig: 1,
  odt: 1, ods: 1, odp: 1, epub: 1, ipa: 1, xz: 1, tsv: 1, kml: 1, kmz: 1, gpx: 1,
  geojson: 1, mdown: 1, mkd: 1, avif: 1, heic: 1, tiff: 1, flac: 1, opus: 1, mkv: 1
})

// Hermes delivers generated artifacts as `MEDIA:<path>` directives in assistant text.
// The desktop client turns them into chips; here they become image or file cards.
const MEDIA_EXT_ALTERNATION = Object.keys(FILE_EXT).sort((a, b) => b.length - a.length).join('|')
const MEDIA_PATH_ANCHORED = '(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:' +
  MEDIA_EXT_ALTERNATION + ')(?=[\\s`"\'*_,;:)\\]}]|MEDIA:|$)'
const MEDIA_PATH_BARE = '[^\\s`"]+'
const MEDIA_CAPTURE = '(?:`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|' + MEDIA_PATH_ANCHORED + '|' + MEDIA_PATH_BARE + ')'
const MEDIA_TAG_RE = new RegExp('[`"\']?MEDIA:[ \\t]*(' + MEDIA_CAPTURE + ')[`"\']?', 'g')
const MEDIA_TRAILING_PUNCTUATION = '.,;:!?'

function isPlausibleMediaPath(value) {
  const str = String(value || '')
  return str.indexOf('/') >= 0 || str.indexOf('\\') >= 0 || /\.[^.]/.test(str)
}

function unquoteMediaPath(value) {
  const trimmed = String(value || '').trim()
  const quote = trimmed.charAt(0)
  if (quote && quote === trimmed.charAt(trimmed.length - 1) &&
    (quote === '"' || quote === "'" || quote === '`')) {
    return trimmed.slice(1, -1)
  }
  // A trailing backtick/quote is inline-code residue; an apostrophe may belong to the name.
  const last = trimmed.charAt(trimmed.length - 1)
  return last === '`' || last === '"' ? trimmed.slice(0, -1) : trimmed
}

function parseMediaValue(value) {
  const raw = String(value || '').trim()
  const quote = raw.charAt(0)
  const quoted = quote && quote === raw.charAt(raw.length - 1) &&
    (quote === '"' || quote === "'" || quote === '`')
  const unquoted = unquoteMediaPath(raw)
  if (quoted) return { path: unquoted, punctuation: '' }
  let end = unquoted.length
  while (end > 0 && MEDIA_TRAILING_PUNCTUATION.indexOf(unquoted.charAt(end - 1)) >= 0) {
    if (!isPlausibleMediaPath(unquoted.slice(0, end - 1))) break
    end -= 1
  }
  return { path: unquoted.slice(0, end), punctuation: unquoted.slice(end) }
}

function extOf(path) {
  const clean = String(path || '').split(/[?#]/)[0].replace(/\\/g, '/')
  const name = clean.split('/').pop() || ''
  if (!name) return ''
  const idx = name.lastIndexOf('.')
  if (idx > 0 && idx < name.length - 1) return name.slice(idx + 1).toLowerCase()
  // Dotfiles are files too: .env / .gitignore are declared as text above.
  if (idx === 0 && name.length > 1) return name.slice(1).toLowerCase()
  return ''
}

function isImageName(name) {
  return !!IMAGE_EXT[extOf(name)]
}

function isTextName(name) {
  return !!TEXT_EXT[extOf(name)]
}

function baseName(path) {
  const clean = String(path || '').split(/[?#]/)[0].replace(/\\/g, '/').replace(/\/+$/, '')
  return util.safeDecode(clean.split('/').pop() || clean)
}

function cleanHref(href) {
  let value = String(href || '').trim()
  value = value.replace(/^sandbox:/i, '')
  if (/^file:\/\/\//i.test(value)) {
    const rest = value.replace(/^file:\/\/\//i, '')
    value = /^[a-zA-Z]:[\\/]/.test(rest) ? rest : '/' + rest
  } else {
    value = value.replace(/^file:\/\//i, '').replace(/^file:/i, '')
  }
  return value
}

function isFileHref(href) {
  const value = String(href || '').trim()
  if (!value) return false
  if (/^(sandbox|file):/i.test(value)) return true
  if (/^https?:/i.test(value)) return false
  if (value.indexOf(' ') >= 0) return false
  return !!FILE_EXT[extOf(value)]
}

function textNode(text) {
  return { type: 'text', text: String(text == null ? '' : text) }
}

function span(style, children) {
  return { name: 'span', attrs: { style: style }, children: children || [] }
}

function block(style, children) {
  return { name: 'div', attrs: { style: style }, children: children || [] }
}

function inline(text, s) {
  const out = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  let m = re.exec(text)
  while (m) {
    if (m.index > last) out.push(textNode(text.slice(last, m.index)))
    const tok = m[0]
    if (tok.charAt(0) === '`') {
      out.push(span(
        'padding:2rpx 8rpx;border-radius:6rpx;background:' + s.codeBg + ';color:' + s.codeText +
          ';font-family:Menlo,Consolas,monospace;font-size:25rpx;',
        [textNode(tok.slice(1, -1))]
      ))
    } else if (tok.indexOf('**') === 0) {
      out.push(span('font-weight:700;color:' + s.text + ';', inline(tok.slice(2, -2), s)))
    } else if (tok.indexOf('__') === 0) {
      out.push(span('font-weight:700;color:' + s.text + ';', inline(tok.slice(2, -2), s)))
    } else if (tok.indexOf('~~') === 0) {
      out.push(span('text-decoration:line-through;opacity:0.72;', inline(tok.slice(2, -2), s)))
    } else if (tok.charAt(0) === '*') {
      out.push(span('font-style:italic;', inline(tok.slice(1, -1), s)))
    } else {
      const split = tok.indexOf('](')
      const label = tok.slice(1, split)
      out.push(span(
        'color:' + s.link + ';text-decoration:underline;word-break:break-all;',
        [textNode(label), textNode(' ↗')]
      ))
    }
    last = m.index + tok.length
    m = re.exec(text)
  }
  if (last < text.length) out.push(textNode(text.slice(last)))
  return out
}

function extractMedia(raw, images, files) {
  const withoutMedia = String(raw == null ? '' : raw).replace(MEDIA_TAG_RE, (match, value) => {
    const parsed = parseMediaValue(value)
    if (!isPlausibleMediaPath(parsed.path)) return match
    if (IMAGE_EXT[extOf(parsed.path)]) {
      images.push({ alt: '', raw: parsed.path, src: parsed.path, failed: false })
    } else {
      files.push({ name: baseName(parsed.path), path: parsed.path, ext: extOf(parsed.path) })
    }
    return parsed.punctuation
  })
  const withoutImages = withoutMedia.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, alt, src) => {
    const value = cleanHref(src)
    images.push({ alt: alt || '', raw: value, src: value, failed: false })
    return ''
  })
  const withoutLinks = withoutImages.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, label, href) => {
    if (!isFileHref(href)) return match
    const path = cleanHref(href)
    files.push({ name: label || baseName(path), path: path, ext: extOf(path) })
    return label
  })
  return withoutLinks.replace(/<file>([^<]+)<\/file>/gi, (match, path) => {
    files.push({ name: baseName(path), path: path, ext: extOf(path) })
    return ''
  })
}

function flushParagraph(lines, nodes, s) {
  if (!lines.length) return
  const text = lines.join('\n').replace(/\s+$/, '')
  lines.length = 0
  if (!text.trim()) return
  nodes.push(block(
    'margin:0 0 16rpx;font-size:29rpx;line-height:1.68;color:' + s.text +
      ';white-space:pre-wrap;word-break:break-word;',
    inline(text, s)
  ))
}

function listNode(items, s) {
  const rows = items.map((item) => {
    const indent = Math.max(0, Math.min(item.indent, 4))
    const markerColor = item.checked === true ? s.ok : s.accent
    const marker = item.checked === undefined ? (item.ordered ? item.num + '. ' : '• ') : (item.checked ? '☑ ' : '☐ ')
    return block(
      'padding-left:' + (indent * 26) + 'rpx;text-indent:-26rpx;margin:0 0 8rpx;font-size:29rpx;' +
        'line-height:1.62;color:' + s.text + ';word-break:break-word;',
      [span('color:' + markerColor + ';font-weight:600;', [textNode(marker)])].concat(inline(item.text, s))
    )
  })
  return block('margin:0 0 16rpx;', rows)
}

function plainInline(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .trim()
}

function splitTableRow(row) {
  let value = String(row || '').trim()
  if (value.charAt(0) === '|') value = value.slice(1)
  if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1)
  const cells = []
  let buf = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i)
    if (ch === '\\' && value.charAt(i + 1) === '|') {
      buf += '|'
      i += 1
    } else if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
    } else {
      buf += ch
    }
  }
  cells.push(buf.trim())
  return cells
}

function isTableSeparator(row) {
  const cells = splitTableRow(row)
  if (!cells.length) return false
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, '')))
}

function isTableRow(line) {
  const value = String(line || '').trim()
  if (!value || value.indexOf('|') < 0) return false
  return !/^\u0000CODE\d+\u0000$/.test(value)
}

function tableAligns(row) {
  return splitTableRow(row).map((cell) => {
    const value = cell.replace(/\s+/g, '')
    const left = value.charAt(0) === ':'
    const right = value.charAt(value.length - 1) === ':'
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

// 表格列宽按内容估算：半角字符 1 个单位、全角 2 个单位。
// 列宽有上限，超长单元格由此折行；总宽超过气泡时交给横向滚动容器。
const TABLE_COL_PAD = 28
const TABLE_COL_MIN = 140
const TABLE_COL_MAX = 300
const TABLE_CHAR_W = 12
const TABLE_AVAIL = 620
const TABLE_UNIT_LIMIT = 40

function isWideCode(code) {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
}

function displayUnits(text) {
  const value = String(text || '')
  let units = 0
  for (let i = 0; i < value.length; i++) {
    units += isWideCode(value.charCodeAt(i)) ? 2 : 1
    if (units >= TABLE_UNIT_LIMIT) break
  }
  return units
}

function tableColumnWidths(textRows, cols) {
  const widths = []
  for (let c = 0; c < cols; c++) {
    let units = 0
    for (let r = 0; r < textRows.length; r++) {
      // 表头加粗略宽一点，多留 1 个半角单位
      const current = displayUnits(textRows[r][c]) + (r === 0 ? 1 : 0)
      if (current > units) units = current
    }
    const natural = TABLE_COL_PAD + units * TABLE_CHAR_W
    widths.push(Math.max(TABLE_COL_MIN, Math.min(TABLE_COL_MAX, natural)))
  }
  return widths
}

function tableBlock(rows, aligns, seq, s) {
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 1)
  const alignAt = (index) => (aligns && aligns[index]) || 'left'
  const textRows = rows.map((cells) => {
    const out = []
    for (let c = 0; c < cols; c++) out.push(plainInline(cells[c] || ''))
    return out
  })
  const widths = tableColumnWidths(textRows, cols)
  const totalWidth = widths.reduce((sum, width) => sum + width, 0)
  const availWidth = Math.max(320, Number(s.tableWidth) || TABLE_AVAIL)
  const scroll = totalWidth > availWidth
  const cellStyle = (index) => {
    return 'width:' + widths[index] + 'rpx;' +
      'flex:' + (scroll ? '0 0 ' : '1 1 ') + widths[index] + 'rpx;' +
      'text-align:' + alignAt(index) + ';'
  }
  const makeCells = (texts, prefix) => texts.map((text, c) => ({
    key: prefix + '-c' + c,
    text: text,
    align: alignAt(c),
    style: cellStyle(c)
  }))
  return {
    kind: 'table',
    key: 'table' + seq,
    scroll: scroll,
    colCount: cols,
    tableStyle: scroll ? 'width:' + totalWidth + 'rpx;' : '',
    hint: '共 ' + cols + ' 列，左右滑动查看完整表格',
    head: makeCells(textRows[0] || [], 'h'),
    rows: textRows.slice(1).map((cells, index) => ({
      key: 'r' + index,
      alt: index % 2 === 1,
      cells: makeCells(cells, 'r' + index)
    }))
  }
}

function codeNode(code, lang, s) {
  const children = []
  if (lang) {
    children.push(block(
      'margin-bottom:8rpx;font-size:20rpx;letter-spacing:2rpx;color:' + s.mute + ';font-family:Menlo,Consolas,monospace;',
      [textNode(String(lang).toUpperCase())]
    ))
  }
  children.push(block(
    'font-family:Menlo,Consolas,monospace;font-size:24rpx;line-height:1.55;color:' + s.codeText +
      ';white-space:pre-wrap;word-break:break-word;',
    [textNode(code)]
  ))
  return block(
    'margin:0 0 18rpx;padding:18rpx 20rpx;border-radius:14rpx;background:' + s.codeBg +
      ';border:1rpx solid ' + s.border + ';overflow-x:auto;',
    children
  )
}

function render(markdown, styles) {
  const s = Object.assign({
    text: '#e8f2ff',
    dim: '#93a7c2',
    mute: '#64748b',
    accent: '#22d3ee',
    accentSoft: 'rgba(34,211,238,0.14)',
    link: '#7dd3fc',
    codeBg: 'rgba(3,9,18,0.78)',
    codeText: '#d7ecff',
    border: 'rgba(110,190,255,0.16)',
    surface2: '#101c30',
    ok: '#34d399',
    tableWidth: TABLE_AVAIL
  }, styles || {})

  let raw = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-9;]*m/g, '')

  const codeBlocks = []
  const sourceLines = raw.split('\n')
  const lines = []
  let i = 0
  while (i < sourceLines.length) {
    const fence = sourceLines[i].match(/^\s*```+\s*([\w+#.-]*)\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      const buf = []
      i += 1
      while (i < sourceLines.length && !/^\s*```+\s*$/.test(sourceLines[i])) {
        buf.push(sourceLines[i])
        i += 1
      }
      i += 1
      codeBlocks.push({ lang: lang, text: buf.join('\n') })
      lines.push('\u0000CODE' + (codeBlocks.length - 1) + '\u0000')
      continue
    }
    lines.push(sourceLines[i])
    i += 1
  }

  const images = []
  const files = []
  const cleaned = lines.map((line) => {
    if (/^\u0000CODE\d+\u0000$/.test(line)) return line
    return extractMedia(line, images, files)
  })

  const nodes = []
  const blocks = []
  let tableSeq = 0
  const flushRich = () => {
    if (!nodes.length) return
    blocks.push({ kind: 'rich', key: 'r' + blocks.length, nodes: nodes.slice() })
    nodes.length = 0
  }
  let paragraph = []
  i = 0
  while (i < cleaned.length) {
    const line = cleaned[i]
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph(paragraph, nodes, s)
      i += 1
      continue
    }

    const codeRef = trimmed.match(/^\u0000CODE(\d+)\u0000$/)
    if (codeRef) {
      flushParagraph(paragraph, nodes, s)
      const code = codeBlocks[Number(codeRef[1])] || { lang: '', text: '' }
      nodes.push(codeNode(code.text, code.lang, s))
      flushRich()
      i += 1
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph(paragraph, nodes, s)
      const level = heading[1].length
      const size = level === 1 ? 40 : level === 2 ? 36 : level === 3 ? 32 : 30
      nodes.push(block(
        'margin:18rpx 0 12rpx;font-size:' + size + 'rpx;line-height:1.4;font-weight:700;color:' + s.text + ';word-break:break-word;',
        inline(heading[2], s)
      ))
      flushRich()
      i += 1
      continue
    }

    if (/^(\s*([-*_])\s*){3,}$/.test(trimmed)) {
      flushParagraph(paragraph, nodes, s)
      nodes.push(block('height:1rpx;margin:24rpx 0;background:' + s.border + ';', []))
      flushRich()
      i += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph(paragraph, nodes, s)
      const quote = []
      while (i < cleaned.length && /^\s*>\s?/.test(cleaned[i])) {
        quote.push(cleaned[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      nodes.push(block(
        'margin:0 0 16rpx;padding:8rpx 0 8rpx 20rpx;border-left:4rpx solid ' + s.accent +
          ';color:' + s.dim + ';font-style:italic;font-size:28rpx;line-height:1.62;white-space:pre-wrap;',
        inline(quote.join('\n'), s)
      ))
      flushRich()
      continue
    }

    if (isTableRow(trimmed) && i + 1 < cleaned.length && isTableSeparator(cleaned[i + 1].trim())) {
      const rows = []
      let aligns = null
      while (i < cleaned.length && isTableRow(cleaned[i].trim())) {
        const row = cleaned[i].trim()
        if (isTableSeparator(row)) aligns = tableAligns(row)
        else rows.push(splitTableRow(row))
        i += 1
      }
      if (rows.length) {
        flushParagraph(paragraph, nodes, s)
        flushRich()
        tableSeq += 1
        blocks.push(tableBlock(rows, aligns, tableSeq, s))
      }
      continue
    }

    const listMatch = trimmed.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/)
    if (listMatch) {
      flushParagraph(paragraph, nodes, s)
      const items = []
      while (i < cleaned.length) {
        const m = cleaned[i].match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/)
        if (!m) break
        let body = m[3]
        let checked
        const task = body.match(/^\[([ xX])\]\s+(.*)$/)
        if (task) {
          checked = task[1].toLowerCase() === 'x'
          body = task[2]
        }
        items.push({
          indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
          ordered: /^\d/.test(m[2]),
          num: m[2].replace(/[.)]$/, ''),
          text: body,
          checked: checked
        })
        i += 1
      }
      nodes.push(listNode(items, s))
      flushRich()
      continue
    }

    paragraph.push(line)
    i += 1
  }
  flushParagraph(paragraph, nodes, s)
  flushRich()

  const seenFiles = {}
  const uniqueFiles = files.filter((file) => {
    const key = file.path + '|' + file.name
    if (seenFiles[key]) return false
    seenFiles[key] = true
    return true
  })

  const allNodes = []
  blocks.forEach((item) => {
    if (item.kind === 'rich') allNodes.push.apply(allNodes, item.nodes)
  })

  return { nodes: allNodes, blocks: blocks, images: images, files: uniqueFiles }
}

module.exports = {
  render,
  extOf,
  baseName,
  isImageName,
  isTextName,
  isFileHref,
  isPlausibleMediaPath,
  parseMediaValue,
  IMAGE_EXT,
  TEXT_EXT
}
