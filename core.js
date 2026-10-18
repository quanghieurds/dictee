// Lõi xử lý: tách câu và chấm bài chép chính tả.
// Dùng được cả trong trình duyệt (window.DicteeCore) và Node (require) để test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DicteeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Từ viết tắt có dấu chấm nhưng không phải cuối câu.
  const ABBREVIATIONS = new Set([
    'M', 'MM', 'Mme', 'Mmes', 'Mlle', 'Mlles', 'Dr', 'Pr', 'Me', 'Mgr',
    'St', 'Ste', 'av', 'apr', 'cf', 'ex', 'p', 'pp', 'vol', 'chap', 'fig',
    'env', 'n', 'no', 'boul', 'bd', 'J.-C', 'C',
  ]);

  const SENTENCE_END = /[.!?…]/;
  const CLOSERS = /[»"”’')\]]/;
  const OPENERS = /[«"“‘'(\[—–-]/;

  function isUpperStart(ch) {
    return !!ch && (/\p{Lu}/u.test(ch) || /\p{N}/u.test(ch));
  }

  // Lấy từ ngay trước vị trí i (để nhận biết từ viết tắt).
  function wordBefore(text, i) {
    let j = i;
    while (j > 0 && /[\p{L}.\-]/u.test(text[j - 1])) j--;
    return text.slice(j, i);
  }

  function splitBlock(block) {
    const out = [];
    let start = 0;
    let i = 0;
    while (i < block.length) {
      const ch = block[i];
      if (!SENTENCE_END.test(ch)) { i++; continue; }
      // Gom cả cụm dấu (vd: "?!", "...") và dấu đóng ngoặc/nháy phía sau.
      let end = i + 1;
      while (end < block.length && SENTENCE_END.test(block[end])) end++;
      while (end < block.length && (CLOSERS.test(block[end]) || block[end] === ' ' && CLOSERS.test(block[end + 1] || ''))) end++;

      // Phải là cuối khối, hoặc khoảng trắng rồi chữ hoa (có thể sau dấu mở).
      let k = end;
      while (k < block.length && /\s/.test(block[k])) k++;
      const atEnd = k >= block.length;
      let boundary = false;
      if (atEnd) boundary = true;
      else if (k > end) {
        let m = k;
        while (m < block.length && (OPENERS.test(block[m]) || /\s/.test(block[m]))) m++;
        boundary = isUpperStart(block[m]);
      }

      if (boundary && ch === '.' && end === i + 1) {
        const w = wordBefore(block, i);
        const lastPart = w.split('.').pop();
        const isInitial = /^\p{Lu}$/u.test(lastPart);
        if (ABBREVIATIONS.has(w) || ABBREVIATIONS.has(lastPart) || isInitial) boundary = false;
      }

      if (boundary) {
        const s = block.slice(start, end).trim();
        if (s) out.push(s);
        start = end;
      }
      i = end;
    }
    const rest = block.slice(start).trim();
    if (rest) out.push(rest);
    return out;
  }

  // Tách văn bản thành câu. Mỗi dòng xuống hàng luôn là ranh giới câu.
  function splitSentences(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .flatMap(splitBlock);
  }

  // ---------- Chấm bài ----------
  // Quy tắc: bỏ qua dấu trên chữ (é = e, œ = oe), bắt buộc đúng chữ cái,
  // viết hoa và dấu . ? ! (… = ...). Các dấu khác (, ; : « » ...) bỏ qua.

  const TOKEN_RE = /(\.{3}|…|[.!?])|([\p{L}\p{N}]+(?:['’ʼ‘\-‐‑][\p{L}\p{N}]+)*)/gu;

  function tokenize(text) {
    const tokens = [];
    const s = String(text || '');
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s))) {
      // i: thứ tự token, start: vị trí trong văn bản gốc (dùng cho gợi ý).
      const base = { i: tokens.length, start: m.index };
      if (m[1]) tokens.push({ ...base, text: m[1], key: m[1] === '...' ? '…' : m[1], punct: true });
      else tokens.push({ ...base, text: m[2], key: normalizeWord(m[2]), punct: false });
    }
    return tokens;
  }

  function normalizeWord(w) {
    return w
      .replace(/œ/g, 'oe').replace(/Œ/g, 'Oe')
      .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
      .normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/['’ʼ‘]/g, "'")
      .replace(/[‐‑]/g, '-');
  }

  function charDistance(a, b) {
    if (a === b) return 0;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  }

  // Chi phí thay thế luôn trong (0, 1], nhỏ hơn xóa + chèn (2),
  // nên từ viết sai được ghép với từ đúng thay vì báo "thiếu" + "thừa".
  function substCost(u, e) {
    if (u.key === e.key) return 0;
    if (u.punct !== e.punct) return 1.9;
    if (u.key.toLowerCase() === e.key.toLowerCase()) return 0.1;
    const d = charDistance(u.key.toLowerCase(), e.key.toLowerCase());
    return 0.2 + 0.8 * Math.min(1, d / Math.max(u.key.length, e.key.length));
  }

  // So bài chép với câu gốc. Trả về danh sách thao tác theo thứ tự:
  // ok | wrong (kèm reason: 'case' | 'spelling') | extra | missing.
  function compare(expectedText, userText) {
    const E = tokenize(expectedText);
    const U = tokenize(userText);
    const n = U.length, m = E.length;
    const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = 1; i <= n; i++) cost[i][0] = i;
    for (let j = 1; j <= m; j++) cost[0][j] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        cost[i][j] = Math.min(
          cost[i - 1][j - 1] + substCost(U[i - 1], E[j - 1]),
          cost[i - 1][j] + 1,
          cost[i][j - 1] + 1
        );
      }
    }
    const ops = [];
    let i = n, j = m;
    const eq = (a, b) => Math.abs(a - b) < 1e-9;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && eq(cost[i][j], cost[i - 1][j - 1] + substCost(U[i - 1], E[j - 1]))) {
        const u = U[i - 1], e = E[j - 1];
        if (u.key === e.key) ops.push({ type: 'ok', user: u, expected: e });
        else {
          const reason = !u.punct && !e.punct && u.key.toLowerCase() === e.key.toLowerCase() ? 'case' : 'spelling';
          ops.push({ type: 'wrong', reason, user: u, expected: e });
        }
        i--; j--;
      } else if (i > 0 && eq(cost[i][j], cost[i - 1][j] + 1)) {
        ops.push({ type: 'extra', user: U[i - 1] });
        i--;
      } else {
        ops.push({ type: 'missing', expected: E[j - 1] });
        j--;
      }
    }
    ops.reverse();
    const errors = ops.filter((o) => o.type !== 'ok').length;
    return { correct: errors === 0 && m > 0, errors, ops, expectedCount: m };
  }

  // ---------- Gợi ý ----------
  // Chọn từ tiếp theo cần mở: từ sai/thiếu đầu tiên trong bài chép hiện tại,
  // nếu không có thì từ đầu tiên chưa mở. Trả về chỉ số token, hoặc -1 nếu đã mở hết.
  function nextHintIndex(expectedText, userText, revealed) {
    const words = tokenize(expectedText).filter((t) => !t.punct);
    if (String(userText || '').trim()) {
      for (const op of compare(expectedText, userText).ops) {
        if ((op.type === 'wrong' || op.type === 'missing') && !op.expected.punct && !revealed.has(op.expected.i)) {
          return op.expected.i;
        }
      }
    }
    const w = words.find((t) => !revealed.has(t.i));
    return w ? w.i : -1;
  }

  // Câu gốc với các từ chưa mở thay bằng "_" (giữ độ dài, dấu nối, dấu câu).
  function maskSentence(expectedText, revealed) {
    const s = String(expectedText || '');
    let out = '';
    let pos = 0;
    for (const t of tokenize(s)) {
      out += s.slice(pos, t.start);
      out += t.punct || revealed.has(t.i) ? t.text : t.text.replace(/[\p{L}\p{N}]/gu, '_');
      pos = t.start + t.text.length;
    }
    return out + s.slice(pos);
  }

  // Gán đoạn thời gian [start, end] (giây) cho từng câu từ kết quả nhận dạng giọng nói
  // (words: [{text, start, end}], text nối lại thành cả bài). Văn bản câu có thể đã
  // được người dùng sửa, nên ghép từ bằng so khớp gần đúng thay vì so từng chữ.
  function alignSentences(sentences, words, duration, silences) {
    const total = duration || (words.length ? words[words.length - 1].end : 0);
    // Token nhận dạng kèm thời gian (một token có thể trải qua nhiều mảnh, vd "Est" + "-ce").
    let full = '';
    const spans = [];
    for (const w of words) {
      const s = full.length;
      full += w.text;
      spans.push({ e: full.length, start: w.start, end: w.end });
    }
    const rec = [];
    let p = 0;
    for (const t of tokenize(full)) {
      if (t.punct) continue;
      while (p < spans.length - 1 && t.start >= spans[p].e) p++;
      let q = p;
      while (q < spans.length - 1 && t.start + t.text.length > spans[q].e) q++;
      rec.push({ key: t.key.toLowerCase(), start: spans[p].start, end: spans[q].end });
    }
    const exp = [];
    sentences.forEach((s, si) => {
      for (const t of tokenize(s)) if (!t.punct) exp.push({ key: t.key.toLowerCase(), si });
    });

    // So khớp hai dãy từ (chi phí thay thế < 1 = chi phí thêm/bớt một từ).
    const n = exp.length, m = rec.length, W = m + 1;
    const back = new Uint8Array((n + 1) * W); // 0 chéo, 1 bỏ từ gốc, 2 bỏ từ nhận dạng
    let prev = new Float64Array(W), cur = new Float64Array(W);
    for (let j = 0; j <= m; j++) { prev[j] = j; back[j] = 2; }
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      back[i * W] = 1;
      const a = exp[i - 1].key;
      for (let j = 1; j <= m; j++) {
        const b = rec[j - 1].key;
        const sub = a === b ? 0 : 0.3 + 0.7 * Math.min(1, charDistance(a, b) / Math.max(a.length, b.length));
        let best = prev[j - 1] + sub, dir = 0;
        if (prev[j] + 1 < best) { best = prev[j] + 1; dir = 1; }
        if (cur[j - 1] + 1 < best) { best = cur[j - 1] + 1; dir = 2; }
        cur[j] = best;
        back[i * W + j] = dir;
      }
      [prev, cur] = [cur, prev];
    }
    const seg = sentences.map(() => ({ start: Infinity, end: -Infinity }));
    for (let i = n, j = m; i > 0 || j > 0;) {
      const dir = i === 0 ? 2 : j === 0 ? 1 : back[i * W + j];
      if (dir === 0) {
        const s = seg[exp[i - 1].si], r = rec[j - 1];
        s.start = Math.min(s.start, r.start);
        s.end = Math.max(s.end, r.end);
        i--; j--;
      } else if (dir === 1) i--;
      else j--;
    }

    // Câu không ghép được từ nào: lấy khoảng giữa hai câu bên cạnh.
    for (let k = 0; k < seg.length; k++) {
      if (seg[k].start !== Infinity) continue;
      const before = seg.slice(0, k).reverse().find((x) => x.start !== Infinity);
      const after = seg.slice(k + 1).find((x) => x.start !== Infinity);
      seg[k].start = before ? before.end : 0;
      seg[k].end = after ? after.start : total;
      if (seg[k].end < seg[k].start) seg[k].end = seg[k].start;
    }
    // Cắt ở giữa khoảng lặng giữa hai câu, thêm chút đệm để không mất âm cuối.
    const out = seg.map((s) => ({ start: s.start, end: s.end }));
    for (let k = 0; k < out.length - 1; k++) {
      const mid = (seg[k].end + seg[k + 1].start) / 2;
      out[k].end = Math.max(seg[k].end, Math.min(mid, seg[k].end + 0.7));
      out[k + 1].start = Math.min(seg[k + 1].start, Math.max(mid, seg[k + 1].start - 0.3));
    }
    if (out.length) {
      out[0].start = Math.max(0, seg[0].start - 0.3);
      out[out.length - 1].end = Math.min(total, seg[seg.length - 1].end + 0.7);
    }

    // Có danh sách khoảng lặng: dời điểm cắt vào khoảng lặng gần nhất,
    // vì mốc thời gian ước lượng có thể lệch cả giây.
    if (silences && silences.length) {
      for (let k = 0; k < out.length - 1; k++) {
        const est = (seg[k].end + seg[k + 1].start) / 2;
        let best = null, bestScore = Infinity;
        for (const s of silences) {
          const mid = (s[0] + s[1]) / 2;
          if (s[1] < est - 1.5 || s[0] > est + 1.5) continue;
          if (mid <= out[k].start + 0.3 || mid >= out[k + 1].end - 0.3) continue;
          const score = Math.abs(mid - est) - 0.3 * Math.min(s[1] - s[0], 1.5);
          if (score < bestScore) { best = s; bestScore = score; }
        }
        if (!best) continue;
        out[k].end = Math.min(best[1], best[0] + 0.6);
        out[k + 1].start = Math.max(best[0], best[1] - 0.3);
      }
      // Đầu câu đầu / cuối câu cuối: bám vào khoảng lặng ngay sát (không lấy cả tiêu đề bị xóa).
      const s0 = seg[0].start, sL = seg[seg.length - 1].end;
      const pre = silences.filter((s) => s[1] >= s0 - 1.5 && s[1] <= s0 + 0.3)
        .sort((a, b) => Math.abs(a[1] - s0) - Math.abs(b[1] - s0))[0];
      if (pre && pre[1] - 0.3 < out[0].end) out[0].start = Math.max(pre[0], pre[1] - 0.3);
      const post = silences.filter((s) => s[0] >= sL - 0.3 && s[0] <= sL + 1.5)
        .sort((a, b) => Math.abs(a[0] - sL) - Math.abs(b[0] - sL))[0];
      const L = out[out.length - 1];
      if (post && post[0] > L.start) L.end = Math.min(total, post[1], post[0] + 0.7);
    }
    return out.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 }));
  }

  const r2 = (x) => Math.round(x * 100) / 100;

  // Tìm các khoảng lặng (>= minLen giây) trong âm thanh mono. Trả về [[start, end], ...] (giây).
  function findSilences(samples, rate, minLen = 0.25) {
    const hop = Math.max(1, Math.round(rate * 0.02));
    const n = Math.floor(samples.length / hop);
    if (!n) return [];
    const rms = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) s += samples[i] * samples[i];
      rms[f] = Math.sqrt(s / hop);
    }
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
    // Ngưỡng theo nền ồn và độ to của giọng trong chính file này.
    const loud = q(0.95);
    const thr = Math.max(Math.min(q(0.1) * 2.5, loud * 0.15), loud * 0.06, 0.002);
    const step = hop / rate;
    const out = [];
    let start = -1;
    for (let f = 0; f <= n; f++) {
      const quiet = f < n && rms[f] < thr;
      if (quiet && start < 0) start = f;
      else if (!quiet && start >= 0) {
        if ((f - start) * step >= minLen) out.push([r2(start * step), r2(f * step)]);
        start = -1;
      }
    }
    return out;
  }

  // Chia file thành các đoạn ngắn để nhận dạng. Whisper gặp khoảng nghỉ dài (vd sau tiêu đề)
  // hay tưởng hết bài và bỏ phần sau, nên luôn cắt ở khoảng nghỉ >= breakLen giây;
  // đoạn vẫn dài hơn maxLen thì cắt thêm ở khoảng lặng dài nhất.
  function planChunks(silences, duration, maxLen = 25, breakLen = 0.6) {
    const chunks = [];
    let start = 0;
    if (silences.length && silences[0][0] <= 0.05) start = Math.max(0, silences[0][1] - 0.2);
    while (start < duration - 0.3) {
      const brk = silences.find((s) => s[1] - s[0] >= breakLen && (s[0] + s[1]) / 2 > start + 0.5 && s[1] < duration - 0.05);
      const brkMid = brk ? (brk[0] + brk[1]) / 2 : Infinity;
      if (brkMid - start <= maxLen) { chunks.push([start, brkMid]); start = brkMid; continue; }
      if (duration - start <= maxLen) { chunks.push([start, duration]); break; }
      let best = null;
      for (const s of silences) {
        const mid = (s[0] + s[1]) / 2;
        if (mid <= start + 5 || mid >= start + maxLen) continue;
        if (!best || s[1] - s[0] > best[1] - best[0]) best = s;
      }
      const cut = best ? (best[0] + best[1]) / 2 : start + maxLen;
      chunks.push([start, cut]);
      start = cut;
    }
    // Bỏ đoạn gần như chỉ có im lặng (dưới 0,3 giây có tiếng).
    const quiet = (a, b) => silences.reduce((n, s) => n + Math.max(0, Math.min(b, s[1]) - Math.max(a, s[0])), 0);
    return chunks
      .filter(([a, b]) => b - a - quiet(a, b) >= 0.3)
      .map(([a, b]) => [r2(a), r2(b)]);
  }

  // Dòng tiêu đề mà file đề thi hay đọc: "Activité 8", "Exercice 1", "Compréhension de l'oral",
  // "DELF blanc n°2", "Comprendre une annonce", số thứ tự đứng một mình...
  const SEP = String.raw`[\s.,:;\-–—]*`;
  const NUM = String.raw`(?:n°\s*|num[ée]ro\s*)?\d+(?:\s*[.,\-–]\s*\d+)*`;
  const HEAD_PREFIX = new RegExp('^(?:' + [
    String.raw`activit[ée]s?\s*` + NUM,
    String.raw`exercices?\s*` + NUM,
    String.raw`(?:document|piste|partie|[ée]preuve|enregistrement|sujet|track)\s*` + NUM,
    String.raw`compr[ée]hension\s+(?:de\s+l['’]\s*)?(?:orale?|écrite?|ecrite?)`,
    String.raw`d[ée]l(?:f|ph)(?:[\s\-]*(?:blanc?|a1|a2|b1|b2|junior|prim))*(?:\s*` + NUM + ')?',
  ].join('|') + ')' + SEP, 'i');
  const HEAD_WHOLE = new RegExp('^(?:' + [
    String.raw`comprendre\s+(?:une?|des|les?|la|l['’])\s*\S+(?:\s+\S+)?`,
    NUM,
    String.raw`exercices?`,
    String.raw`(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|premier|première|deuxième|troisième)`,
  ].join('|') + ')' + SEP + '$', 'i');

  // Bỏ tiêu đề ở đầu câu; trả về phần còn lại ('' nếu cả câu là tiêu đề).
  function stripHeading(sentence) {
    let s = String(sentence).trim();
    for (let k = 0; k < 6; k++) {
      if (HEAD_WHOLE.test(s)) return '';
      const m = s.match(HEAD_PREFIX);
      if (!m || !m[0]) break;
      s = s.slice(m[0].length).trim();
    }
    if (!/[\p{L}]/u.test(s)) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Lọc danh sách câu nhận dạng được: bỏ các dòng tiêu đề, trả về {sentences, removed}.
  function stripHeadings(sentences) {
    const out = [];
    let removed = 0;
    for (const s of sentences) {
      const r = stripHeading(s);
      if (r !== s.trim()) removed++;
      if (r) out.push(r);
    }
    return { sentences: out, removed };
  }

  return { splitSentences, tokenize, normalizeWord, compare, nextHintIndex, maskSentence, alignSentences, findSilences, planChunks, stripHeadings };
});
