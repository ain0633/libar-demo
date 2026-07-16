// LibAR 온디바이스 인식 로직 — daelim_yolo_pipeline.py 검증본의 JS 이식.
// DOM 무관 순수 로직만 (match·sortkey·LIS·줄분할·CTC 디코드) → node 골든 테스트와 브라우저가 공유.
'use strict';

// ── 정규화 (nn) ──
function recNn(s) {
  return String(s ?? '').normalize('NFC').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ.]/g, '');
}

const JAMO_FIX = { '0': 'ㅇ', 'O': 'ㅇ', 'o': 'ㅇ', 'Q': 'ㅇ', '으': 'ㅇ', '이': 'ㅇ',
  '피': 'ㅍ', '디': 'ㄷ', '기': 'ㄱ', '니': 'ㄴ', '리': 'ㄹ', '미': 'ㅁ',
  '비': 'ㅂ', '시': 'ㅅ', '지': 'ㅈ', '치': 'ㅊ', '키': 'ㅋ', '티': 'ㅌ', '히': 'ㅎ',
  '프': 'ㅍ', '표': 'ㅍ', '드': 'ㄷ', '그': 'ㄱ', '느': 'ㄴ', '르': 'ㄹ', '므': 'ㅁ',
  '브': 'ㅂ', '스': 'ㅅ', '즈': 'ㅈ', '츠': 'ㅊ', '크': 'ㅋ', '트': 'ㅌ', '흐': 'ㅎ' };

// ── difflib.SequenceMatcher.ratio() 이식 (autojunk 무관 — 저자기호는 6자 이하) ──
function smRatio(a, b) {
  if (!a.length && !b.length) return 1.0;
  const b2j = {};
  for (let j = 0; j < b.length; j++) (b2j[b[j]] ??= []).push(j);
  let matched = 0;
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop();
    let besti = alo, bestj = blo, bestsize = 0, j2len = {};
    for (let i = alo; i < ahi; i++) {
      const newj2len = {};
      for (const j of (b2j[a[i]] || [])) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len[j - 1] || 0) + 1;
        newj2len[j] = k;
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    if (bestsize) {
      matched += bestsize;
      stack.push([alo, besti, blo, bestj]);
      stack.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
    }
  }
  return 2 * matched / (a.length + b.length);
}

// ── 카탈로그 준비: [{call,title,...}] → 매칭 인덱스 ──
function prepCatalog(cat) {
  const items = [], byCls = {};
  for (const r of cat) {
    const call = String(r.call).trim().replace(/\s*(?:=|[cC]\.)\d+$/, '');
    const parts = call.split('-');
    if (parts.length < 2) continue;
    const m = parts[0].trim().match(/^[가-힣A-Z]*([\d.]+)$/);
    const it = { call, cls: m ? m[1] : parts[0].trim(),
                 author: recNn(parts[1].trim()), title: r.title };
    items.push(it);
    (byCls[it.cls] ??= []).push(it);
  }
  return { items, byCls };
}

// ── match(txt) 이식 — 반환 [row|null, score] ──
// 권차 수술(07-14): ①v.N 토큰이 분류번호-저자 사이에 끼면 인접 정규식이 끊김 → 매칭 전 제거
// ②복본(v.1/v.2) 다의성은 권차로 판별(폴백 포함) ③첫 글자만 오독(상↔싱)은 나머지 완전일치 유일 인정
// 재채점 실측: 걷기 판독률 89%→99% — daelim_yolo_pipeline.py match()와 동일해야 함
function volPick(hits, txt) {
  const mv = String(txt).match(/[vV]\.?(\d+)/);
  if (mv) {
    const re = new RegExp('^[vV]?\\.?0*' + mv[1] + '$');
    const vhits = hits.filter(c => re.test(c.call.split('-').pop()));
    if (vhits.length === 1) return vhits[0];
  }
  if (new Set(hits.map(c => c.call)).size === 1) return hits[0];
  return null;
}
function matchCall(txt, idx) {
  const t = recNn(String(txt).replace(/[vV]\.?\d+/g, ' '));
  let m = null, sawCls = false;
  for (const m2 of t.matchAll(/(\d{3}(?:\.\d+)?)([가-힣][0-9]{1,3}[가-힣ㄱ-ㅎ0Oo]?)/g)) {
    sawCls = true;
    if (idx.byCls[m2[1]]) { m = m2; break; }
  }
  let clsv, author, cands;
  if (m) { clsv = m[1]; author = m[2]; cands = idx.byCls[clsv]; }
  else {
    let best = null;
    for (const am of t.matchAll(/[가-힣][0-9]{2,3}[가-힣ㄱ-ㅎ]?/g)) {
      const a = am[0];
      const vs = new Set([a]);
      if (JAMO_FIX[a[a.length - 1]]) vs.add(a.slice(0, -1) + JAMO_FIX[a[a.length - 1]]);
      const hits = idx.items.filter(c => vs.has(c.author));
      if (hits.length === 1 && a.length >= 4) best = hits[0];
      else if (hits.length > 1 && a.length >= 4) {
        const p = volPick(hits, txt);
        if (p) best = p;
      }
    }
    // 분류번호가 읽혔는데 목록 밖 번호인 경우: 오독(673.5090↔673.5099)은 살리고
    // 남의 구간(004↔813)은 차단 — 매칭 책의 분류번호가 읽힌 번호와 닮아야(≥0.7) 인정.
    // (현장 07-14: 000번대 서가에서 저자기호 단독 매칭이 '확인 5권' 오탐 — 파이프라인과 의도적 분기)
    if (best && sawCls) {
      // 토큰 추출은 원문(공백 보존)에서 — 정규화로 공백이 빠지면 이웃 쓰레기 숫자와 붙어
      // '…큰8 573.53'이 '857…'로 오파싱돼 정당한 오독 구제(573.53→673.53)까지 기각된다
      const clsToks = [...String(txt).matchAll(/\d{3}(?:\.\d+)?/g)].map(x => x[0]);
      if (!clsToks.some(ct => smRatio(ct, best.cls) >= 0.7)) best = null;
    }
    return best ? [best, 0.9] : [null, 0.0];
  }
  const variants = new Set([author]);
  if (JAMO_FIX[author[author.length - 1]])
    variants.add(author.slice(0, -1) + JAMO_FIX[author[author.length - 1]]);
  const hits = cands.filter(c => variants.has(c.author));
  if (hits.length > 1) {
    const p = volPick(hits, txt);
    return p ? [p, 1.0] : [null, 1.0];
  }
  if (hits.length === 1) return [hits[0], 1.0];
  const h3 = cands.filter(c => c.author.length === author.length &&
    c.author.slice(1) === author.slice(1) && c.author.slice(0, 1) !== author.slice(0, 1));
  if (new Set(h3.map(c => c.author)).size === 1) {
    const p = h3.length > 1 ? volPick(h3, txt) : h3[0];
    if (p) return [p, 0.95];
  }
  const digitOk = c => {
    const da = author.replace(/\D/g, ''), dc = c.author.replace(/\D/g, '');
    return !(da.length === dc.length && da !== dc);
  };
  const scored = cands
    .filter(c => c.author.slice(0, 1) === author.slice(0, 1) && digitOk(c))
    .map(c => [Math.max(...[...variants].map(v => smRatio(v, c.author))), c])
    .sort((x, y) => x[0] - y[0]);
  if (!scored.length || scored[scored.length - 1][0] < 0.75)
    return [null, scored.length ? scored[scored.length - 1][0] : 0.0];
  if (scored.length > 1 && scored[scored.length - 1][0] - scored[scored.length - 2][0] < 0.05)
    return [null, scored[scored.length - 1][0]];
  return [scored[scored.length - 1][1], scored[scored.length - 1][0]];
}

// ── 정렬 키 (hkey/authkey/sortkey) — 파이썬 튜플 비교와 동일한 중첩 배열 비교 ──
const _CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function hkey(ch) {
  const o = ch.codePointAt(0);
  if (o >= 0xAC00 && o <= 0xD7A3) {
    const i = o - 0xAC00;
    return [Math.floor(i / 588), Math.floor(i % 588 / 28) + 1, i % 28];
  }
  const ci = _CHO.indexOf(ch);
  if (ci >= 0) return [ci, 0, 0];
  return [o + 100, 0, 0];
}
function authkey(a) {
  const m = a.match(/^([가-힣A-Z]+)(\d*)(.*)$/);
  if (!m) return [[...a].map(hkey), 0, []];
  return [[...m[1]].map(hkey), m[2] ? parseFloat('0.' + m[2]) : 0, [...m[3]].map(hkey)];
}
function sortkey(call) {
  const p = call.split('-');
  const cls2 = p[0].replace(/^[가-힣A-Z]+/, '');
  let vol = 0;
  if (p.length > 2) { const mv = p[2].match(/\d+/); vol = mv ? parseInt(mv[0]) : 0; }
  return [/^[\d.]+$/.test(cls2) ? parseFloat(cls2) : 999,
          p.length > 1 ? authkey(recNn(p[1])) : [], vol];
}
function cmpKey(x, y) {          // 파이썬 튜플 사전식 비교
  const ax = Array.isArray(x), ay = Array.isArray(y);
  if (!ax && !ay) return x < y ? -1 : x > y ? 1 : 0;
  if (!ax || !ay) return ax ? 1 : -1;   // 파이썬에선 타입 에러 — 실제 키에선 미발생, 안전값
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) { const c = cmpKey(x[i], y[i]); if (c) return c; }
  return x.length - y.length;
}

// ── LIS 오배열: 최장 비감소 부분열 밖 = 의심 (libar_ondevice.lis_misplaced 이식) ──
function lisMisplaced(keys) {
  const n = keys.length;
  if (!n) return new Set();
  const L = new Array(n).fill(1), P = new Array(n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++)
      if (cmpKey(keys[j], keys[i]) <= 0 && L[j] + 1 > L[i]) { L[i] = L[j] + 1; P[i] = j; }
  let e = 0;
  for (let i = 1; i < n; i++) if (L[i] > L[e]) e = i;
  const keep = new Set();
  while (e !== -1) { keep.add(e); e = P[e]; }
  const out = new Set();
  for (let i = 0; i < n; i++) if (!keep.has(i)) out.add(i);
  return out;
}

// ── 줄(band) 클러스터: y중심 정렬 후 연쇄 (파이프라인 검증본) ──
function bandCluster(rows) {
  const bxs = rows.slice().sort((a, b) => (a.box[1] + a.box[3]) - (b.box[1] + b.box[3]));
  if (!bxs.length) return;
  const hs = bxs.map(r => r.box[3] - r.box[1]).sort((a, b) => a - b);
  const hmed = hs[Math.floor(hs.length / 2)];
  let band = -1, lastY = -1e9;
  for (const r of bxs) {
    const yc = (r.box[1] + r.box[3]) / 2;
    if (yc - lastY > hmed * 0.8) band++;
    r.band = band; lastY = yc;
  }
}

// ── 행별 LIS 판정: 플래그는 직독(청구기호)만 ──
function flagMisplaced(rows) {
  let nMis = 0;
  const bands = new Set(rows.map(r => r.band));
  for (const b of bands) {
    const seq = rows.filter(r => r.band === b && r.call)
                    .sort((x, y) => x.box[0] - y.box[0]);
    const mis = lisMisplaced(seq.map(r => sortkey(r.call)));
    seq.forEach((r, j) => {
      r.mis = mis.has(j) && r.how === '청구기호';
      if (r.mis) nMis++;
    });
  }
  return nMis;
}

// ── DB(det) 간이 후처리: prob>0.3 연결요소 → box_score 0.6 → unclip 1.5 근사 패딩 ──
// (기각: 라벨 크롭 Otsu 줄분할 휴리스틱 — 광각에서 이웃 라벨·구분 스티커가 섞여 demo1 2권.
//  det 스트립 구조로 교체 후 demo1 12권 = 서버 det 파이프라인과 동률, 파이썬 리허설 실측.)
function dbComponents(prob, w, h) {
  const n = w * h;
  const bin = new Uint8Array(n), seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prob[i] > 0.3 ? 1 : 0;
  const stack = new Int32Array(n);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!bin[i] || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let minx = w, miny = h, maxx = 0, maxy = 0, sum = 0, cnt = 0;
    while (sp) {
      const p = stack[--sp];
      const y = (p / w) | 0, x = p - y * w;
      sum += prob[p]; cnt++;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (bin[np] && !seen[np]) { seen[np] = 1; stack[sp++] = np; }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (cnt < 12 || bw < 4 || bh < 4 || sum / cnt < 0.6) continue;
    const px = Math.round(bh * 0.45), py = Math.round(bh * 0.28);
    out.push([Math.max(0, minx - px), Math.max(0, miny - py),
              Math.min(w, maxx + 1 + px), Math.min(h, maxy + 1 + py)]);
  }
  return out;
}

// ── 토큰 → 박스 배정 + 클러스터 채널 (파이프라인 검증본) — extras(회수 라벨) 반환 ──
function assignTokens(rb, toks, matchFn) {
  const cmp2 = (a, b) => (Math.round(a.y / 30) - Math.round(b.y / 30)) || (a.x - b.x);
  const centers = rb.map(r => (r.box[0] + r.box[2]) / 2);
  const assign = rb.map(() => []);
  for (const t of toks) {
    let j = 0, bd = Infinity;
    centers.forEach((c, k) => { const d = Math.abs(c - t.x); if (d < bd) { bd = d; j = k; } });
    if (rb.length && bd <= Math.max(60, (rb[j].box[2] - rb[j].box[0]) * 0.9)) assign[j].push(t);
  }
  const have = new Set();
  rb.forEach((r, j) => {
    r.read = assign[j].slice().sort(cmp2).map(t => t.t).join(' ');
    if (!r.read) return;
    const [row, sc] = matchFn(r.read);
    if (row) { r.call = row.call; r.title = row.title; r.how = '청구기호';
      r.score = +sc.toFixed(2); have.add(row.call); }
  });
  const extras = [];
  if (toks.length && rb.length) {
    const ws = rb.map(r => r.box[2] - r.box[0]).sort((a, b) => a - b);
    const wmed = ws[Math.floor(ws.length / 2)];
    const ts = toks.slice().sort((a, b) => a.x - b.x);
    const cl = [[ts[0]]];
    for (let i = 1; i < ts.length; i++) {
      const last = cl[cl.length - 1];
      if (ts[i].x - last[last.length - 1].x > wmed * 0.7) cl.push([]);
      cl[cl.length - 1].push(ts[i]);
    }
    const sy0 = Math.min(...rb.map(r => r.box[1])), sy1 = Math.max(...rb.map(r => r.box[3]));
    for (const c2 of cl) {
      const txt = c2.slice().sort(cmp2).map(t => t.t).join(' ');
      const [row, sc] = matchFn(txt);
      if (!row || have.has(row.call)) continue;
      const xs = c2.map(t => t.x);
      extras.push({ box: [Math.min(...xs) - wmed * 0.4, sy0, Math.max(...xs) + wmed * 0.4, sy1],
                    band: rb[0].band, read: txt, call: row.call, title: row.title,
                    how: '청구기호', score: +sc.toFixed(2) });
      have.add(row.call);
    }
  }
  return extras;
}

// ── CTC 그리디 디코드 (blank=0, charset[t-1]) ──
function ctcDecode(data, T, C, charset) {
  let out = '', prev = -1;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -Infinity;
    const off = t * C;
    for (let c = 0; c < C; c++) if (data[off + c] > bv) { bv = data[off + c]; bi = c; }
    if (bi !== prev && bi !== 0) out += charset[bi - 1] ?? '';
    prev = bi;
  }
  return out.normalize('NFC');
}

if (typeof module !== 'undefined') module.exports = {
  recNn, smRatio, prepCatalog, matchCall, hkey, authkey, sortkey, cmpKey,
  lisMisplaced, bandCluster, flagMisplaced, dbComponents, assignTokens, ctcDecode, JAMO_FIX };
