// Read a CSV exported from Outlook 2010 via
// 檔案 → 開啟 → 匯入/匯出 → 匯出至檔案 → 逗點分隔值 (Windows).
//
// The export is usually in the system ANSI code page (Big5 on Traditional
// Chinese Windows), sometimes UTF-8 or UTF-16 (with or without BOM). Header
// names depend on the Outlook language, so the renderer lets the user confirm
// which column is the title and which is the content; we only guess here.

function looksLikeUtf16(buf) {
  // ASCII-heavy UTF-16 has a zero byte in every other position.
  const n = Math.min(buf.length, 4000);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) (i % 2 ? oddZeros++ : evenZeros++);
  if (oddZeros > n / 8 && oddZeros > evenZeros * 4) return 'utf-16le';
  if (evenZeros > n / 8 && evenZeros > oddZeros * 4) return 'utf-16be';
  return null;
}

function decode(buf) {
  let text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  else if (looksLikeUtf16(buf)) text = new TextDecoder(looksLikeUtf16(buf)).decode(buf);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('big5').decode(buf);
    }
  }
  // Drop invisible control characters (keep tab and line breaks).
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f﻿]/g, '');
}

// Pick the separator that splits the header line into the most fields.
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

// RFC 4180 CSV: quoted fields may contain separators, "" and line breaks.
function parseCsv(text, delim = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (c === delim) {
      row.push(field); field = ''; atFieldStart = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; atFieldStart = true;
      rows.push(row); row = [];
    } else {
      field += c;
      atFieldStart = false;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const TITLE_NAMES = ['subject', '主旨', '主題', '标题', '主题', '標題'];
const BODY_NAMES = ['body', '記事本文', '記事內文', '內文', '本文', '內容', '内容', '正文', 'notes', '記事', '附註'];

function guessColumn(header, rows, names, exclude = -1) {
  const norm = header.map((h) => h.trim().toLowerCase());
  const byName = norm.findIndex((h, i) => i !== exclude && names.includes(h));
  if (byName >= 0) return byName;
  // Otherwise the column with the most text.
  let best = -1;
  let bestLen = 0;
  for (let c = 0; c < header.length; c++) {
    if (c === exclude) continue;
    const len = rows.reduce((sum, r) => sum + (r[c] || '').trim().length, 0);
    if (len > bestLen) { best = c; bestLen = len; }
  }
  return best;
}

function readOutlookCsv(buf) {
  const text = decode(buf);
  const rows = parseCsv(text, detectDelimiter(text));
  if (!rows.length) return { columns: [], rows: [], guess: { title: -1, body: -1 } };
  const header = rows[0].map((h, i) => h.trim() || `第 ${i + 1} 欄`);
  const data = rows.slice(1);
  const body = guessColumn(header, data, BODY_NAMES);
  const titleByName = header.map((h) => h.trim().toLowerCase()).findIndex((h) => TITLE_NAMES.includes(h));
  return { columns: header, rows: data, guess: { title: titleByName, body } };
}

module.exports = { readOutlookCsv, parseCsv, decode, detectDelimiter };
