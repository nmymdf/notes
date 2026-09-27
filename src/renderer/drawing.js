// Drawing canvas: freehand drawing on a blank page or on top of an image.
//
//   DrawingEditor.open({ drawing, baseUrl, title }) → Promise<{ blob, drawing } | null>
//
// `drawing` is the editable description that gets stored with the image:
//   { v: 1, w, h, bg: 'white' | 'black' | 'grid' | 'image', base?: <original image URL>,
//     items: [ { t: 'pen' | 'hl', c, s, pts: [[x, y, pressure], …] },
//              { t: 'line' | 'arrow' | 'rect' | 'ellipse', c, s, x1, y1, x2, y2 },
//              { t: 'text', c, s, x, y, text } ] }
// Coordinates are in image pixels, so the result keeps the original resolution.
// `baseUrl` is a loadable (same-origin) URL of the image being annotated.
(function () {
  const COLORS = ['#111111', '#ffffff', '#e5484d', '#f2c037', '#3fb950', '#3b82f6'];
  const SIZES = [{ label: '細', v: 2 }, { label: '中', v: 4 }, { label: '粗', v: 8 }];
  const TOOLS = [
    { id: 'pen', label: '✏️', title: '筆' },
    { id: 'hl', label: '🖍', title: '螢光筆' },
    { id: 'line', label: '／', title: '直線（按住 Shift 畫水平／垂直）' },
    { id: 'arrow', label: '➔', title: '箭頭' },
    { id: 'rect', label: '▭', title: '方框' },
    { id: 'ellipse', label: '◯', title: '圓圈' },
    { id: 'text', label: 'T', title: '文字' },
    { id: 'eraser', label: '🧽', title: '橡皮擦（點一下擦掉整筆）' },
  ];

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = url;
  });

  // ---------- rendering ----------

  function unit(d) { return Math.max(1, Math.max(d.w, d.h) / 1000); } // scale tool sizes to the picture

  function drawBackground(ctx, d, baseImg) {
    ctx.save();
    if (d.bg === 'image' && baseImg) {
      ctx.drawImage(baseImg, 0, 0, d.w, d.h);
    } else {
      ctx.fillStyle = d.bg === 'black' ? '#111111' : '#ffffff';
      ctx.fillRect(0, 0, d.w, d.h);
      if (d.bg === 'grid') {
        const step = 40 * unit(d);
        ctx.strokeStyle = '#dde3ea';
        ctx.lineWidth = Math.max(1, unit(d));
        ctx.beginPath();
        for (let x = step; x < d.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, d.h); }
        for (let y = step; y < d.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(d.w, y); }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawItem(ctx, d, it) {
    const u = unit(d);
    const w = it.s * u;
    ctx.save();
    ctx.strokeStyle = it.c;
    ctx.fillStyle = it.c;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (it.t === 'pen') {
      const p = it.pts;
      if (p.length === 1) {
        ctx.beginPath();
        ctx.arc(p[0][0], p[0][1], (w * (0.5 + p[0][2])) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 1; i < p.length; i++) {
        ctx.lineWidth = w * (0.5 + (p[i - 1][2] + p[i][2]) / 2); // pen pressure changes the width
        ctx.beginPath();
        ctx.moveTo(p[i - 1][0], p[i - 1][1]);
        ctx.lineTo(p[i][0], p[i][1]);
        ctx.stroke();
      }
    } else if (it.t === 'hl') {
      // One path, so overlapping parts of the stroke don't get darker.
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = w * 4;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      it.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (it.pts.length === 1) ctx.lineTo(it.pts[0][0] + 0.1, it.pts[0][1]);
      ctx.stroke();
    } else if (it.t === 'line' || it.t === 'arrow') {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(it.x1, it.y1);
      ctx.lineTo(it.x2, it.y2);
      ctx.stroke();
      if (it.t === 'arrow') {
        const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
        const head = Math.max(10 * u, w * 4);
        ctx.beginPath();
        ctx.moveTo(it.x2, it.y2);
        ctx.lineTo(it.x2 - head * Math.cos(a - 0.45), it.y2 - head * Math.sin(a - 0.45));
        ctx.lineTo(it.x2 - head * Math.cos(a + 0.45), it.y2 - head * Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    } else if (it.t === 'rect') {
      ctx.lineWidth = w;
      ctx.strokeRect(Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
    } else if (it.t === 'ellipse') {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.ellipse((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, Math.abs(it.x2 - it.x1) / 2, Math.abs(it.y2 - it.y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.t === 'text') {
      const size = it.s * 6 * u;
      ctx.font = `bold ${size}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
      ctx.textBaseline = 'top';
      it.text.split('\n').forEach((line, i) => ctx.fillText(line, it.x, it.y + i * size * 1.25));
    }
    ctx.restore();
  }

  function renderAll(ctx, d, baseImg) {
    ctx.clearRect(0, 0, d.w, d.h);
    drawBackground(ctx, d, baseImg);
    for (const it of d.items) drawItem(ctx, d, it);
  }

  // Distance from a point to an item (for the eraser).
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hitItem(d, it, x, y, tol) {
    if (it.t === 'pen' || it.t === 'hl') {
      const p = it.pts;
      if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) < tol;
      for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < tol) return true;
      return false;
    }
    if (it.t === 'line' || it.t === 'arrow') return segDist(x, y, it.x1, it.y1, it.x2, it.y2) < tol;
    if (it.t === 'rect') {
      const [a, b, c, e] = [Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.max(it.x1, it.x2), Math.max(it.y1, it.y2)];
      return [[a, b, c, b], [c, b, c, e], [c, e, a, e], [a, e, a, b]].some(([p, q, r, s]) => segDist(x, y, p, q, r, s) < tol);
    }
    if (it.t === 'ellipse') {
      const cx = (it.x1 + it.x2) / 2;
      const cy = (it.y1 + it.y2) / 2;
      const rx = Math.abs(it.x2 - it.x1) / 2 || 1;
      const ry = Math.abs(it.y2 - it.y1) / 2 || 1;
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(r - 1) * Math.min(rx, ry) < tol;
    }
    if (it.t === 'text') {
      const size = it.s * 6 * unit(d);
      const lines = it.text.split('\n');
      const wmax = Math.max(...lines.map((l) => l.length)) * size;
      return x >= it.x - tol && x <= it.x + wmax + tol && y >= it.y - tol && y <= it.y + lines.length * size * 1.25 + tol;
    }
    return false;
  }

  // ---------- editor UI ----------

  function open({ drawing, baseUrl, title = '畫圖', askText }) {
    return new Promise(async (resolve) => {
      const d = JSON.parse(JSON.stringify(drawing));
      d.items ||= [];
      let baseImg = null;
      if (d.bg === 'image') {
        try { baseImg = await loadImage(baseUrl); } catch (err) { resolve({ error: err.message }); return; }
      }
      const undo = [];
      const redo = [];
      let tool = 'pen';
      let color = d.bg === 'black' ? '#ffffff' : (d.bg === 'image' ? '#e5484d' : '#111111');
      let size = 4;
      let changed = false;

      const root = el('div', 'draw-view');
      const bar = el('div', 'draw-bar');
      const toolBox = el('div', 'draw-group');
      for (const t of TOOLS) {
        const b = el('button', 'draw-tool', t.label);
        b.title = t.title;
        b.dataset.tool = t.id;
        toolBox.appendChild(b);
      }
      const colorBox = el('div', 'draw-group');
      for (const c of COLORS) {
        const b = el('button', 'draw-color');
        b.style.background = c;
        b.dataset.color = c;
        b.title = c;
        colorBox.appendChild(b);
      }
      const sizeBox = el('div', 'draw-group');
      for (const s of SIZES) {
        const b = el('button', 'draw-size', s.label);
        b.dataset.size = s.v;
        sizeBox.appendChild(b);
      }
      const editBox = el('div', 'draw-group');
      const bUndo = el('button', 'draw-tool', '↶'); bUndo.title = '復原 (Ctrl+Z)';
      const bRedo = el('button', 'draw-tool', '↷'); bRedo.title = '重做 (Ctrl+Y)';
      const bClear = el('button', 'draw-tool', '🗑'); bClear.title = '清除全部';
      editBox.append(bUndo, bRedo, bClear);
      let bgSel = null;
      if (d.bg !== 'image') {
        bgSel = el('select', 'draw-bg');
        for (const [v, label] of [['white', '白色'], ['black', '黑色'], ['grid', '方格紙']]) bgSel.add(new Option(label, v));
        bgSel.value = d.bg;
        editBox.appendChild(bgSel);
      }
      const spacer = el('div', 'draw-spacer');
      spacer.appendChild(el('b')).textContent = title;
      const bCancel = el('button', 'text-btn', '取消');
      const bDone = el('button', 'text-btn primary', '完成');
      bar.append(toolBox, colorBox, sizeBox, editBox, spacer, bCancel, bDone);

      const stage = el('div', 'draw-stage');
      const wrap = el('div', 'draw-wrap');
      const canvas = el('canvas');
      const overlay = el('canvas', 'draw-overlay');
      for (const c of [canvas, overlay]) { c.width = d.w; c.height = d.h; }
      wrap.append(canvas, overlay);
      stage.appendChild(wrap);
      root.append(bar, stage);
      document.body.appendChild(root);
      const ctx = canvas.getContext('2d');
      const octx = overlay.getContext('2d');

      function fit() {
        const r = stage.getBoundingClientRect();
        const k = Math.min((r.width - 24) / d.w, (r.height - 24) / d.h, 4); // small pictures are shown enlarged
        wrap.style.width = `${d.w * k}px`;
        wrap.style.height = `${d.h * k}px`;
      }
      const redraw = () => renderAll(ctx, d, baseImg);
      function refreshBar() {
        toolBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
        colorBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
        sizeBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.size === size));
        bUndo.disabled = !undo.length;
        bRedo.disabled = !redo.length;
        overlay.style.cursor = tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : 'crosshair';
      }
      const snapshot = () => { undo.push(JSON.stringify(d.items)); redo.length = 0; changed = true; };
      function restore(from, to) {
        if (!from.length) return;
        to.push(JSON.stringify(d.items));
        d.items = JSON.parse(from.pop());
        changed = true;
        redraw();
        refreshBar();
      }

      function toCanvas(e) {
        const r = overlay.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width) * d.w, ((e.clientY - r.top) / r.height) * d.h];
      }
      const pressure = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

      let current = null;
      overlay.addEventListener('pointerdown', async (e) => {
        if (e.button !== 0) return;
        const [x, y] = toCanvas(e);
        if (tool === 'text') {
          const text = await askText();
          if (!text) return;
          snapshot();
          d.items.push({ t: 'text', c: color, s: size, x, y, text });
          redraw();
          refreshBar();
          return;
        }
        overlay.setPointerCapture(e.pointerId);
        if (tool === 'eraser') {
          current = { eraser: true };
          eraseAt(x, y);
          return;
        }
        current = tool === 'pen' || tool === 'hl'
          ? { t: tool, c: color, s: size, pts: [[Math.round(x), Math.round(y), +pressure(e).toFixed(2)]] }
          : { t: tool, c: color, s: size, x1: x, y1: y, x2: x, y2: y };
        drawCurrent();
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!current) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        if (current.eraser) { for (const ev of events) eraseAt(...toCanvas(ev)); return; }
        if (current.pts) {
          for (const ev of events) {
            const [x, y] = toCanvas(ev);
            const last = current.pts[current.pts.length - 1];
            if (Math.hypot(x - last[0], y - last[1]) >= 1) current.pts.push([Math.round(x), Math.round(y), +pressure(ev).toFixed(2)]);
          }
        } else {
          let [x, y] = toCanvas(e);
          if (e.shiftKey && (current.t === 'line' || current.t === 'arrow')) {
            // snap to horizontal / vertical / 45°
            const a = Math.round(Math.atan2(y - current.y1, x - current.x1) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x - current.x1, y - current.y1);
            x = current.x1 + len * Math.cos(a);
            y = current.y1 + len * Math.sin(a);
          }
          current.x2 = x;
          current.y2 = y;
        }
        drawCurrent();
      });
      const finish = () => {
        if (!current) return;
        octx.clearRect(0, 0, d.w, d.h);
        if (!current.eraser) {
          const tiny = !current.pts && Math.hypot(current.x2 - current.x1, current.y2 - current.y1) < 3;
          if (!tiny) {
            snapshot();
            for (const k of ['x1', 'y1', 'x2', 'y2']) if (k in current) current[k] = Math.round(current[k]);
            d.items.push(current);
            drawItem(ctx, d, current);
          }
        }
        current = null;
        refreshBar();
      };
      overlay.addEventListener('pointerup', finish);
      overlay.addEventListener('pointercancel', finish);

      function drawCurrent() {
        octx.clearRect(0, 0, d.w, d.h);
        drawItem(octx, d, current);
      }
      function eraseAt(x, y) {
        const tol = 8 * unit(d);
        const idx = d.items.findLastIndex((it) => hitItem(d, it, x, y, tol));
        if (idx < 0) return;
        snapshot();
        d.items.splice(idx, 1);
        redraw();
      }

      toolBox.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tool = b.dataset.tool; refreshBar(); } });
      colorBox.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { color = b.dataset.color; refreshBar(); } });
      sizeBox.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { size = +b.dataset.size; refreshBar(); } });
      bUndo.onclick = () => restore(undo, redo);
      bRedo.onclick = () => restore(redo, undo);
      bClear.onclick = () => { if (!d.items.length) return; snapshot(); d.items = []; redraw(); refreshBar(); };
      if (bgSel) bgSel.onchange = () => { d.bg = bgSel.value; changed = true; redraw(); };

      // While drawing, keys belong to the drawing (not the note behind it),
      // except inside the text dialog that the text tool opens.
      const onKey = (e) => {
        if (e.target.closest && e.target.closest('.modal')) return;
        e.stopImmediatePropagation();
        const k = e.key.toLowerCase();
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.ctrlKey && k === 'z') { e.preventDefault(); restore(undo, redo); }
        else if (e.ctrlKey && k === 'y') { e.preventDefault(); restore(redo, undo); }
        else if (e.ctrlKey || e.metaKey || e.key === 'Delete' || e.key === 'Backspace') e.preventDefault();
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', fit);

      function close(result) {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', fit);
        root.remove();
        resolve(result);
      }
      bCancel.onclick = () => close(null);
      bDone.onclick = () => {
        if (!changed) { close(null); return; }
        canvas.toBlob((blob) => close({ blob, drawing: d }), 'image/png');
      };

      fit();
      redraw();
      refreshBar();
    });
  }

  window.DrawingEditor = { open, renderAll };
}());
