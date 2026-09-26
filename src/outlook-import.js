// Parse notes exported from Outlook 2010 via
// 檔案 → 開啟 → 匯入/匯出 → 匯出至檔案 → 逗點分隔值 (Windows).
//
// The export is usually in the system ANSI code page (Big5 on Traditional
// Chinese Windows), sometimes UTF-8/UTF-16 with a BOM. Header names depend on
// the Outlook language, e.g. "Subject","Body","Categories",... or 主旨/內文/類別.

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('big5').decode(buf);
  }
}

// RFC 4180 CSV: quoted fields may contain commas, "" and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const SUBJECT_NAMES = ['subject', '主旨', '主題', '标题', '主题'];
const BODY_NAMES = ['body', '內文', '本文', '內容', '内容', '正文', 'notes', '記事'];
const CATEGORY_NAMES = ['categories', '類別', '分類', '类别'];

function findColumn(header, names) {
  const norm = header.map((h) => h.trim().toLowerCase());
  return norm.findIndex((h) => names.includes(h));
}

function parseOutlookNotesCsv(buf) {
  const rows = parseCsv(decode(buf));
  if (!rows.length) return [];
  const header = rows[0];
  let subjectCol = findColumn(header, SUBJECT_NAMES);
  let bodyCol = findColumn(header, BODY_NAMES);
  const categoryCol = findColumn(header, CATEGORY_NAMES);
  if (subjectCol < 0 && bodyCol < 0) { subjectCol = 0; bodyCol = 1; }

  const notes = [];
  for (const r of rows.slice(1)) {
    const subject = (r[subjectCol] || '').trim();
    let body = (r[bodyCol] || '').replace(/\r\n?/g, '\n');
    // An Outlook note's subject is simply its first line; don't repeat it.
    const lines = body.split('\n');
    if (subject && lines[0].trim() === subject) body = lines.slice(1).join('\n');
    body = body.replace(/^\n+/, '').replace(/\s+$/, '');
    if (!subject && !body) continue;
    notes.push({ title: subject, body, category: categoryCol >= 0 ? (r[categoryCol] || '').trim() : '' });
  }
  return notes;
}

module.exports = { parseOutlookNotesCsv, parseCsv, decode };
