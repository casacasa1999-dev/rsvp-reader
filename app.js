'use strict';

const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const $ = id => document.getElementById(id);

/* ---------- Storage (IndexedDB) ---------- */

let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('rsvp-reader', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' });
      req.result.createObjectStore('text');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let result;
    const r = fn(tx);
    if (r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
const listBooks = () => idb('meta', 'readonly', tx => tx.objectStore('meta').getAll());
const getParas = id => idb('text', 'readonly', tx => tx.objectStore('text').get(id));
const putMeta = meta => idb('meta', 'readwrite', tx => { tx.objectStore('meta').put(meta); });
const addBook = (meta, paras) => idb(['meta', 'text'], 'readwrite', tx => {
  tx.objectStore('meta').put(meta);
  tx.objectStore('text').put(paras, meta.id);
});
const deleteBook = id => idb(['meta', 'text'], 'readwrite', tx => {
  tx.objectStore('meta').delete(id);
  tx.objectStore('text').delete(id);
});

/* ---------- Text chunking ---------- */

const CJK = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ々〆]/;
const KANJI = /[㐀-鿿豈-﫿々〆]/;
const KANA = /[぀-ヿｦ-ﾟ]/;
const CONTENT_START = /^[゠-ヿ㐀-鿿豈-﫿々A-Za-z0-9０-９Ａ-Ｚａ-ｚ]/;
const OPEN = '「『（(［[【〈《〔｛“‘';
const LEADING_OPEN = /^[「『（(［[【〈《〔｛“‘]+/;
const VERB_STEM = /^[㐀-鿿々]+[ぁ-ん]?[いきぎしじちびみりえけげせめれべ]$/;
const ALL_KANJI = /^[㐀-鿿々]+$/;
// Kana-only words that begin a new phrase rather than attach to the previous one.
const STARTERS = new Set(('これ それ あれ どれ ここ そこ あそこ どこ この その あの どの こんな そんな あんな どんな '
  + 'こう そう どう とても かなり もっと もう まだ また すぐ ずっと やはり やっぱり ちょっと すこし たくさん '
  + 'いつも いつ なぜ どうして そして しかし だから けれども でも ただ または および つまり たとえば もし かも '
  + 'きっと たぶん ほとんど すべて みんな わたし あなた ぼく かれ かのじょ とんと まるで なかなか あまり').split(' '));
const BREAK_PUNCT =/[。、．，！？!?…‥：；」』）]/;
const SENTENCE_END = /[。．.!?！？]$/;
const CLAUSE_END = /[、，,;:；：…‥―—]$/;
const TRAILING_CLOSERS = /[」』）)\]］】〉》〕｝”’"']+$/;

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

function segments(run) {
  if (segmenter) return segmenter.segment(run);
  const parts = run.match(/[㐀-鿿々]+|[゠-ヿ]+|[぀-ゟ]+|[A-Za-z0-9]+|./g) || [];
  return parts.map(segment => ({ segment, isWordLike: /[\p{L}\p{N}]/u.test(segment) }));
}

// Groups morphemes into phrase-sized chunks (roughly 文節): a content word plus
// the particles / auxiliaries that follow it.
function splitJa(run, out) {
  let cur = '', flushNext = false;
  const flush = () => { if (cur) out.push(cur); cur = ''; flushNext = false; };
  const onlyOpen = () => [...cur].every(c => OPEN.includes(c));
  for (const { segment: s, isWordLike } of segments(run)) {
    if (!isWordLike) {
      if (OPEN.includes(s[0])) {
        if (!onlyOpen()) flush();
        cur += s;
      } else {
        cur += s;
        if (BREAK_PUNCT.test(s)) flushNext = true;
      }
      continue;
    }
    if (flushNext) flush();
    const len = cur.length + s.length;
    if (!cur || onlyOpen()) cur += s;
    else if (CONTENT_START.test(s)) {
      const body = cur.replace(LEADING_OPEN, '');
      const join = (/[0-9０-９]$/.test(cur) && len <= 8)
        // 飛び + 込む, 思い + 直す: verb stem followed by another verb
        || (VERB_STEM.test(body) && !body.endsWith('しい') && KANJI.test(s[0]) && len <= 7)
        // 東京 + 都知事: compound noun
        || (ALL_KANJI.test(body) && ALL_KANJI.test(s) && len <= 5);
      if (join) cur += s;
      else { flush(); cur = s; }
    } else {
      // Kana right after kanji is an inflection (込 + もう), never a new word.
      const afterKana = /[ぁ-ん]$/.test(cur);
      const split = len > 12 || (afterKana && (STARTERS.has(s) || (cur.length >= 7 && s.length >= 3)));
      if (split) { flush(); cur = s; }
      else cur += s;
    }
  }
  flush();
}

// Relative display time of a chunk, in units of "one average English word".
function weight(text, isCjk, paraEnd) {
  let f;
  if (isCjk) {
    f = 0.4;
    for (const ch of text) f += KANJI.test(ch) ? 0.5 : KANA.test(ch) ? 0.35 : /[\p{L}\p{N}]/u.test(ch) ? 0.2 : 0;
  } else {
    f = 0.6 + 0.08 * (text.match(/[\p{L}\p{N}]/gu) || []).length;
  }
  f = Math.min(Math.max(f, 0.7), 4);
  const core = text.replace(TRAILING_CLOSERS, '');
  if (SENTENCE_END.test(core)) f += 1;
  else if (CLAUSE_END.test(core)) f += 0.4;
  if (paraEnd) f += 0.8;
  return f;
}

function tokenize(paras) {
  const texts = [], paraStart = [], cjk = [], ends = [];
  for (const p of paras) {
    paraStart.push(texts.length);
    for (const run of p.split(/\s+/)) {
      if (!run) continue;
      if (CJK.test(run)) {
        const from = texts.length;
        splitJa(run, texts);
        for (let k = from; k < texts.length; k++) cjk.push(1);
      } else {
        texts.push(run);
        cjk.push(0);
      }
    }
    ends[texts.length - 1] = 1;
  }
  const n = texts.length;
  const cum = new Float32Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + weight(texts[k], cjk[k], ends[k]);
  return { texts, cjk, ends, cum, paraStart, n };
}

/* ---------- EPUB import ---------- */

async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = buf.byteLength - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('EPUBファイルとして読み込めませんでした。');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async name => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    const data = u8.subarray(start, start + e.size);
    if (e.method === 0) return dec.decode(data);
    if (e.method !== 8) throw new Error('未対応の圧縮形式です。');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section',
  'article', 'tr', 'td', 'th', 'dt', 'dd', 'pre', 'figcaption', 'header', 'footer', 'aside', 'body']);
const SKIP = new Set(['script', 'style', 'rt', 'rp', 'head', 'svg', 'math']);

function cleanPara(s) {
  return s.replace(/\s+/g, ' ')
    .replace(/([　-ヿ㐀-鿿＀-￯]) (?=[　-ヿ㐀-鿿＀-￯])/g, '$1')
    .trim();
}

function extractParas(root) {
  const out = [];
  let buf = '';
  const flush = () => { const t = cleanPara(buf); if (t) out.push(t); buf = ''; };
  const walk = node => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) buf += c.nodeValue;
      else if (c.nodeType === 1) {
        const tag = c.localName.toLowerCase();
        if (SKIP.has(tag)) continue;
        if (tag === 'br') { flush(); continue; }
        const block = BLOCK.has(tag);
        if (block) flush();
        walk(c);
        if (block) flush();
      }
    }
  };
  walk(root);
  flush();
  return out;
}

function parseXml(src, type) {
  let doc = new DOMParser().parseFromString(src, type);
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(src, 'text/html');
  return doc;
}

async function importEpub(buf, fallbackTitle) {
  const read = await unzip(buf);
  const container = parseXml(await read('META-INF/container.xml') || '', 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUBの構成情報が見つかりません。');
  const opf = parseXml(await read(opfPath), 'application/xml');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const byTag = name => [...opf.getElementsByTagName('*')].filter(e => e.localName === name);
  const hrefs = new Map(byTag('item').map(e => [e.getAttribute('id'), e.getAttribute('href')]));
  const title = byTag('title')[0]?.textContent.trim() || fallbackTitle;

  const paras = [], chapters = [];
  for (const ref of byTag('itemref')) {
    const href = hrefs.get(ref.getAttribute('idref'));
    if (!href) continue;
    const path = new URL(href.split('#')[0], 'http://x/' + dir).pathname.slice(1);
    const src = await read(decodeURIComponent(path));
    if (!src) continue;
    const doc = parseXml(src, 'application/xhtml+xml');
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    const found = extractParas(body);
    if (!found.length) continue;
    const heading = body.querySelector('h1, h2, h3');
    const name = heading ? cleanPara(extractParas(heading).join(' ')) : '';
    chapters.push({ title: (name || `セクション ${chapters.length + 1}`).slice(0, 40), para: paras.length });
    paras.push(...found);
  }
  return { title, paras, chapters };
}

/* ---------- PDF import ---------- */

let pdfjs;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import(PDFJS_BASE + 'legacy/build/pdf.min.mjs');
  // Workers must be same-origin, so wrap the CDN worker script in a blob URL.
  const src = await (await fetch(PDFJS_BASE + 'legacy/build/pdf.worker.min.mjs')).text();
  lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return pdfjs = lib;
}

async function importPdf(buf, fallbackTitle, onProgress) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: buf, cMapUrl: PDFJS_BASE + 'cmaps/', cMapPacked: true }).promise;
  const lines = [], pageAt = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress(`PDFを解析中… ${n} / ${pdf.numPages} ページ`);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pageAt.push(lines.length);
    let line = '';
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
    }
    if (line.trim()) lines.push(line.trim());
    page.cleanup();
  }
  if (!lines.length) throw new Error('このPDFには文字情報がありません（スキャン画像のPDFは読めません）。');

  const sorted = lines.map(l => l.length).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)];
  const paras = [], chapters = [];
  let cur = '', nextPage = 0;
  lines.forEach((l, k) => {
    while (nextPage < pageAt.length && pageAt[nextPage] <= k) {
      chapters.push({ title: `p.${nextPage + 1}`, para: paras.length });
      nextPage++;
    }
    if (!cur) cur = l;
    else if (CJK.test(cur.slice(-1)) || CJK.test(l[0]) || /[、。」』）]$/.test(cur)) cur += l;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(l)) cur = cur.slice(0, -1) + l;
    else cur += ' ' + l;
    if (/[。．.!?！？」』”"）)]$/.test(l) && l.length < typical * 0.85) { paras.push(cleanPara(cur)); cur = ''; }
  });
  if (cur) paras.push(cleanPara(cur));

  const info = await pdf.getMetadata().catch(() => null);
  return { title: info?.info?.Title?.trim() || fallbackTitle, paras, chapters };
}

/* ---------- Library ---------- */

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

async function importFile(file) {
  busy('読み込み中…');
  try {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const base = file.name.replace(/\.[^.]+$/, '');
    let book, type;
    if (head[0] === 0x25 && head[1] === 0x50) { type = 'PDF'; book = await importPdf(buf, base, busy); }
    else if (head[0] === 0x50 && head[1] === 0x4b) { type = 'EPUB'; book = await importEpub(buf, base); }
    else throw new Error('EPUB または PDF ファイルを選んでください。');
    if (!book.paras.length) throw new Error('本文を取り出せませんでした。');
    busy('文章を分割中…');
    const { n } = tokenize(book.paras);
    const meta = { id: Date.now().toString(36), title: book.title, type, chapters: book.chapters, pos: 0, total: n, lastRead: Date.now() };
    await addBook(meta, book.paras);
    await renderLibrary();
  } catch (e) {
    console.error(e);
    alert(e.message || '読み込みに失敗しました。');
  } finally {
    busy('');
  }
}

async function renderLibrary() {
  const books = (await listBooks()).sort((a, b) => b.lastRead - a.lastRead);
  const ul = $('books');
  ul.textContent = '';
  $('empty').hidden = books.length > 0;
  for (const b of books) {
    const pct = b.total > 1 ? Math.round(b.pos / (b.total - 1) * 100) : 0;
    const li = document.createElement('li');
    const info = document.createElement('div'); info.className = 'info';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = b.title;
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${b.type} ・ ${pct}%`;
    const bar = document.createElement('div'); bar.className = 'progress';
    const fill = document.createElement('i'); fill.style.width = pct + '%';
    bar.append(fill);
    info.append(name, meta, bar);
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕';
    del.setAttribute('aria-label', '削除');
    del.onclick = async ev => {
      ev.stopPropagation();
      if (confirm(`「${b.title}」を削除しますか？`)) { await deleteBook(b.id); renderLibrary(); }
    };
    li.append(info, del);
    li.onclick = () => openBook(b);
    ul.append(li);
  }
}

/* ---------- Reader ---------- */

const settings = Object.assign({ wpm: 300, font: 40 }, JSON.parse(localStorage.getItem('rsvp-settings') || '{}'));
const saveSettings = () => localStorage.setItem('rsvp-settings', JSON.stringify(settings));

const R = { meta: null, tok: null, i: 0, playing: false, timer: 0, lastSave: 0, wake: null };

async function openBook(meta) {
  busy('開いています…');
  try {
    R.meta = meta;
    R.tok = tokenize(await getParas(meta.id));
    R.i = Math.min(meta.pos, R.tok.n - 1);
    $('title').textContent = meta.title;
    $('seek').max = R.tok.n - 1;
    const sel = $('chapters');
    sel.textContent = '';
    if (meta.chapters.length > 1) meta.chapters.forEach((c, k) => sel.append(new Option(c.title, k)));
    $('library').hidden = true;
    $('reader').hidden = false;
    renderSpeed();
    show();
  } finally {
    busy('');
  }
}

function closeBook() {
  pause();
  $('reader').hidden = true;
  $('library').hidden = false;
  renderLibrary();
}

function orpIndex(word) {
  const lead = word.match(/^[^\p{L}\p{N}]*/u)[0].length;
  const len = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  return Math.min(word.length - 1, lead + (len <= 1 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : len <= 13 ? 3 : 4));
}

function show() {
  const { texts, cjk, cum, n } = R.tok;
  const t = texts[R.i];
  let em = 0;
  for (const ch of t) em += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.6;
  const size = Math.min(settings.font, ($('stage').clientWidth - 32) / em) + 'px';
  $('orp').hidden = !!cjk[R.i];
  $('plain').hidden = !cjk[R.i];
  if (cjk[R.i]) {
    $('plain').style.fontSize = size;
    $('plain').textContent = t;
  } else {
    const k = orpIndex(t);
    $('orp').style.fontSize = size;
    $('pre').textContent = t.slice(0, k);
    $('pivot').textContent = t[k];
    $('post').textContent = t.slice(k + 1);
  }
  $('seek').value = R.i;
  const mins = Math.ceil((cum[n] - cum[R.i]) * 60 / settings.wpm / 60);
  const left = mins >= 60 ? `${Math.floor(mins / 60)}時間${mins % 60}分` : `${mins}分`;
  $('status').textContent = `${n > 1 ? Math.round(R.i / (n - 1) * 100) : 100}% ・ 残り ${left}`;
  if (!R.playing) renderContext();
}

function renderContext() {
  const { texts, cjk, paraStart } = R.tok;
  const box = $('context');
  box.textContent = '';
  const from = Math.max(0, R.i - 25), to = Math.min(R.tok.n, R.i + 40);
  for (let k = from; k < to; k++) {
    if (k > from && !(cjk[k] && cjk[k - 1])) box.append(' ');
    if (k === R.i) { const m = document.createElement('mark'); m.textContent = texts[k]; box.append(m); }
    else box.append(texts[k]);
  }
  const sel = $('chapters');
  if (sel.options.length) {
    let c = 0;
    R.meta.chapters.forEach((ch, k) => { if (paraStart[ch.para] <= R.i) c = k; });
    sel.value = c;
  }
}

function savePos() {
  R.lastSave = Date.now();
  R.meta.pos = R.i;
  R.meta.lastRead = Date.now();
  putMeta(R.meta);
}

function step() {
  show();
  if (Date.now() - R.lastSave > 3000) savePos();
  const { cum, n } = R.tok;
  R.timer = setTimeout(() => {
    if (R.i >= n - 1) return pause();
    R.i++;
    step();
  }, (cum[R.i + 1] - cum[R.i]) * 60000 / settings.wpm);
}

async function play() {
  if (R.playing) return;
  if (R.i >= R.tok.n - 1) R.i = 0;
  R.playing = true;
  $('reader').classList.add('playing');
  $('play').textContent = '⏸';
  try { R.wake = await navigator.wakeLock?.request('screen'); } catch {}
  step();
}

function pause() {
  if (!R.playing) return;
  clearTimeout(R.timer);
  R.playing = false;
  $('reader').classList.remove('playing');
  $('play').textContent = '▶';
  R.wake?.release().catch(() => {});
  R.wake = null;
  savePos();
  show();
}

const toggle = () => R.playing ? pause() : play();

function seek(i) {
  const was = R.playing;
  if (was) clearTimeout(R.timer);
  R.i = Math.min(Math.max(i, 0), R.tok.n - 1);
  if (was) step(); else { show(); savePos(); }
}

function sentenceStart() {
  const { texts, ends } = R.tok;
  const isEnd = k => ends[k] || SENTENCE_END.test(texts[k].replace(TRAILING_CLOSERS, ''));
  const start = k => { while (k > 0 && !isEnd(k - 1)) k--; return k; };
  let s = start(R.i);
  // Already at (or just past) the start of a sentence: go to the previous one.
  if (R.i - s <= 1 && s > 0) s = start(s - 1);
  seek(s);
}

function renderSpeed() {
  $('speed').innerHTML = `${settings.wpm} WPM<small>日本語 約${settings.wpm * 2}字/分</small>`;
}
function setSpeed(delta) {
  settings.wpm = Math.min(1000, Math.max(100, settings.wpm + delta));
  saveSettings(); renderSpeed(); if (!R.playing) show();
}
function setFont(delta) {
  settings.font = Math.min(96, Math.max(20, settings.font + delta));
  saveSettings(); show();
}

/* ---------- Wiring ---------- */

$('file').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; if (f) importFile(f); };
$('back').onclick = closeBook;
$('stage').onclick = toggle;
$('play').onclick = toggle;
$('sentence').onclick = sentenceStart;
$('rew').onclick = () => seek(R.i - 10);
$('fwd').onclick = () => seek(R.i + 10);
$('slower').onclick = () => setSpeed(-25);
$('faster').onclick = () => setSpeed(25);
$('smaller').onclick = () => setFont(-4);
$('larger').onclick = () => setFont(4);
$('seek').oninput = ev => seek(+ev.target.value);
$('chapters').onchange = ev => seek(R.tok.paraStart[R.meta.chapters[+ev.target.value].para]);

document.addEventListener('visibilitychange', () => { if (document.hidden && R.playing) pause(); });
window.addEventListener('resize', () => { if (R.tok && !$('reader').hidden) show(); });
document.addEventListener('keydown', ev => {
  if ($('reader').hidden || ev.target.tagName === 'SELECT') return;
  const actions = {
    ' ': toggle, ArrowLeft: () => seek(R.i - 10), ArrowRight: () => seek(R.i + 10),
    ArrowUp: () => setSpeed(25), ArrowDown: () => setSpeed(-25),
  };
  if (actions[ev.key]) { ev.preventDefault(); actions[ev.key](); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
navigator.storage?.persist?.();
renderLibrary();
