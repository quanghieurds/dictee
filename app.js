(function () {
  'use strict';
  const { splitSentences, compare, tokenize, nextHintIndex, maskSentence, alignSentences, stripHeadings } = window.DicteeCore;
  const { AudioStore, MODELS, transcribe, cancel: cancelAsr } = window.DicteeAudio;
  const I18N = window.DicteeI18n;
  const t = I18N.t;
  const $ = (id) => document.getElementById(id);
  const ic = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- Lưu trữ (localStorage, lỗi thì chạy không lưu) ----------
  const KEY = 'dictee.v1';
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
  }
  function save() {
    try {
      // Mốc thời gian của bài có file âm thanh nằm trong IndexedDB (audio.t = 1) để localStorage
      // (giới hạn ~5 MB) chỉ giữ văn bản và tiến độ.
      const lessons = state.lessons.map((l) => {
        if (!(l.audio && l.audio.t === 1)) return l;
        const { words, silences, ...rest } = l;
        return rest;
      });
      localStorage.setItem(KEY, JSON.stringify({
        lessons, progress: state.progress, settings: state.settings,
        activeId: state.activeId, mode: state.mode,
        hiddenBuiltin: state.hiddenBuiltin, openGroups: state.openGroups,
        builtinVersion: state.builtinVersion, packs: state.packs,
      }));
    } catch { /* bỏ qua */ }
  }

  const SAMPLE = {
    id: 'sample',
    title: 'Bài mẫu – Une matinée',
    text: 'Ce matin, il fait beau sur la ville. Les enfants jouent dans le jardin pendant que leur mère prépare le petit-déjeuner. Mon voisin, M. Dupont, promène son chien tous les jours à huit heures. Est-ce que tu viens avec nous au marché ? Nous achèterons des pommes, du fromage et une baguette bien chaude !',
  };

  const saved = load();
  const state = {
    lessons: saved?.lessons ?? [SAMPLE],
    progress: saved?.progress ?? {},
    settings: Object.assign({ rate: 0.9, pause: 3, voiceURI: null }, saved?.settings),
    activeId: saved?.activeId ?? null,
    mode: saved?.mode ?? 'sentence',
    hiddenBuiltin: saved?.hiddenBuiltin ?? [], // bài mẫu người dùng đã xóa
    openGroups: saved?.openGroups ?? ['mine'],
    packs: saved?.packs ?? [], // gói nghe: [{id, name, created}]
  };

  // Thêm các bài mẫu A1–B2 còn thiếu (không thêm lại bài người dùng đã xóa).
  const BUILTIN = window.DICTEE_BUILTIN || [];
  const BUILTIN_VERSION = window.DICTEE_BUILTIN_VERSION || 1;
  // Bản lưu cũ (trước khi có số phiên bản) coi như phiên bản 1.
  state.builtinVersion = saved ? saved.builtinVersion ?? 1 : BUILTIN_VERSION;

  function mergeBuiltin() {
    // Nội dung bài mẫu đã đổi: cập nhật bài đã lưu, đặt lại tiến độ bài bị đổi.
    if (state.builtinVersion < BUILTIN_VERSION) {
      const byId = new Map(BUILTIN.map((b) => [b.id, b]));
      for (const l of state.lessons) {
        const b = byId.get(l.id);
        if (!b) continue;
        if (l.text !== b.text) delete state.progress[l.id];
        Object.assign(l, b);
      }
      state.builtinVersion = BUILTIN_VERSION;
    }
    const have = new Set(state.lessons.map((l) => l.id));
    const hidden = new Set(state.hiddenBuiltin);
    for (const b of BUILTIN) {
      if (!have.has(b.id) && !hidden.has(b.id)) state.lessons.push({ ...b });
    }
  }
  mergeBuiltin();

  // Nhóm trong thư viện: bài của tôi, các gói nghe, rồi bài mẫu theo trình độ.
  const groups = () => [
    { key: 'mine' },
    ...state.packs.map((p) => ({ key: 'pack:' + p.id, pack: p })),
    ...['A1', 'A2', 'B1', 'B2'].map((key) => ({ key })),
  ];
  const groupOf = (l) => (l.pack ? 'pack:' + l.pack : l.level || 'mine');

  // Trạng thái lúc chạy (không lưu)
  const run = { playing: false, gen: 0, timer: null, fullIdx: 0, fullStarted: false, sentences: [],
    segments: null, audioKey: null, audioLoading: false };

  const lesson = () => state.lessons.find((l) => l.id === state.activeId) || null;
  function prog() {
    const id = state.activeId;
    if (!state.progress[id]) state.progress[id] = { index: 0, done: [], wrongChecks: 0, draft: '' };
    return state.progress[id];
  }

  // ---------- Giọng đọc ----------
  const synth = window.speechSynthesis;
  let voice = null;
  let keepAlive = null;

  const speech = {
    gen: 0,
    speak(text, onend) {
      const g = ++this.gen;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice ? voice.lang : 'fr-FR';
      if (voice) u.voice = voice;
      u.rate = state.settings.rate;
      let started = false;
      u.onstart = () => {
        started = true;
        clearTimeout(this.watch);
        if (g !== this.gen) return;
        setSpeaking(true);
        voiceWorks();
      };
      u.onend = () => {
        if (g !== this.gen) return;
        clearTimeout(this.watch);
        setSpeaking(false);
        if (onend) onend();
      };
      u.onerror = (e) => {
        if (g !== this.gen) return;
        clearTimeout(this.watch);
        setSpeaking(false);
        if (e.error !== 'interrupted' && e.error !== 'canceled') voiceProblem(e.error || 'error');
        if (onend) onend();
      };
      this.current = u; // giữ tham chiếu để trình duyệt không thu hồi giữa chừng
      // Đang rảnh thì đọc ngay, vẫn nằm trong lần chạm của người dùng (iPhone/iPad bắt buộc).
      // Đang đọc dở thì dừng rồi chờ chút mới đọc: Chrome và Safari bỏ qua lệnh đọc ngay sau khi dừng.
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(() => { if (g === this.gen) synth.speak(u); }, 80);
      } else {
        synth.speak(u);
      }
      // Một số máy chặn im lặng: không báo lỗi, cũng không đọc. Sau vài giây vẫn chưa đọc thì báo.
      clearTimeout(this.watch);
      this.watch = setTimeout(() => {
        if (g !== this.gen || started) return;
        voiceProblem('timeout');
        if (synth.speaking || synth.pending) return;
        setSpeaking(false);
        if (onend) onend();
      }, 5000);
    },
    stop() {
      this.gen++;
      clearTimeout(this.watch);
      if (synth && (synth.speaking || synth.pending)) synth.cancel();
      setSpeaking(false);
    },
    // Giữ để tương thích: việc mở khóa giờ do speak() đọc ngay trong lần chạm.
    unlock() {},
  };

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  let voiceIssue = null;
  // Báo cho người dùng khi máy không phát được giọng đọc, kèm cách sửa cho loại máy đó.
  function voiceProblem(code) {
    voiceIssue = code;
    const warn = $('voice-warning');
    warn.textContent = t('voice.problem', { code }) + ' ' + t(IS_IOS ? 'voice.tipsIOS' : IS_ANDROID ? 'voice.tipsAndroid' : 'voice.tipsOther');
    warn.hidden = false;
  }
  function voiceWorks() {
    if (!voiceIssue) return;
    voiceIssue = null;
    $('voice-warning').hidden = true;
  }

  // Phát một đoạn [start, end] của file âm thanh (bài có file mp3).
  const audioEl = new Audio();
  audioEl.preservesPitch = true;
  const clip = {
    gen: 0,
    timer: null,
    play(seg, onend) {
      const g = ++this.gen;
      clearInterval(this.timer);
      audioEl.pause();
      audioEl.playbackRate = state.settings.rate;
      audioEl.currentTime = seg.start;
      const finish = () => {
        if (g !== this.gen) return;
        this.gen++;
        clearInterval(this.timer);
        audioEl.pause();
        setSpeaking(false);
        if (onend) onend();
      };
      setSpeaking(true);
      audioEl.play().catch(finish);
      this.timer = setInterval(() => {
        if (audioEl.currentTime >= seg.end || audioEl.ended) finish();
      }, 25);
    },
    stop() {
      this.gen++;
      clearInterval(this.timer);
      audioEl.pause();
      setSpeaking(false);
    },
  };

  // Đọc câu thứ i: bằng file âm thanh nếu bài có, không thì bằng giọng máy.
  function say(i, onend) {
    if (run.segments) clip.play(run.segments[i], onend);
    else speech.speak(run.sentences[i], onend);
  }
  function stopVoice() {
    speech.stop();
    clip.stop();
  }
  const canPlay = () => !!lesson() && !run.audioLoading && (!!run.segments || !!synth);

  function setSpeaking(on) {
    $('speaking-dot').hidden = !on;
    clearInterval(keepAlive);
    // Giọng Google của Chrome tự ngắt sau ~15 giây; pause/resume giữ nó chạy.
    if (on && voice && /google/i.test(voice.name)) {
      keepAlive = setInterval(() => { synth.pause(); synth.resume(); }, 10000);
    }
  }

  function rankVoice(v) {
    let s = 0;
    if (/natural|online|neural/i.test(v.name)) s -= 10;
    if (/^fr[-_]FR/i.test(v.lang)) s -= 5;
    return s;
  }

  function populateVoices() {
    const sel = $('voice');
    const warn = $('voice-warning');
    if (!synth) {
      warn.textContent = t('voice.noSupport');
      warn.hidden = false;
      return;
    }
    const all = synth.getVoices();
    let list = all.filter((v) => /^fr/i.test(v.lang)).sort((a, b) => rankVoice(a) - rankVoice(b));
    if (!list.length && all.length) {
      warn.textContent = t('voice.noFrench');
      warn.hidden = false;
      list = all;
    } else if (!voiceIssue) {
      warn.hidden = true;
    }
    sel.innerHTML = '';
    // Điện thoại hay chưa có (hoặc không liệt kê) giọng: vẫn đọc được bằng giọng tiếng Pháp mặc định của máy.
    if (!list.length || !list.some((v) => /^fr/i.test(v.lang))) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = t('voice.default');
      sel.appendChild(o);
    }
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name.replace(/^Microsoft\s+/, '').replace(/\s*Online \(Natural\)/i, '').replace(/\s*-\s*French.*$/i, '') + ` (${v.lang})`;
      sel.appendChild(o);
    }
    const frList = list.filter((v) => /^fr/i.test(v.lang));
    voice = state.settings.voiceURI === '' ? null
      : list.find((v) => v.voiceURI === state.settings.voiceURI) || frList[0] || null;
    sel.value = voice ? voice.voiceURI : '';
  }

  // ---------- Thư viện ----------
  function renderLibrary() {
    const ul = $('lesson-list');
    ul.innerHTML = '';
    if (!state.lessons.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t('lib.empty');
      ul.appendChild(li);
    }
    for (const g of groups()) {
      const items = state.lessons.filter((l) => groupOf(l) === g.key);
      if (!items.length) continue;
      const open = state.openGroups.includes(g.key);
      const finished = items.filter((l) => isFinished(l)).length;
      const level = g.pack ? 'pack' : g.key;

      const head = document.createElement('li');
      head.className = 'group' + (open ? ' open' : '') + (g.pack ? ' pack' : '');
      head.dataset.level = level;
      head.tabIndex = 0;
      head.setAttribute('role', 'button');
      head.setAttribute('aria-expanded', String(open));
      const hName = document.createElement('span');
      hName.className = 'g-name';
      hName.innerHTML = ic('chevron') + (g.pack ? ic('headphones') : '<span class="dot"></span>') + `<span class="g-label">${esc(g.pack ? g.pack.name : t('group.' + g.key))}</span>`;
      const hMeta = document.createElement('span');
      hMeta.className = 'meta';
      hMeta.textContent = finished ? t('group.done', { d: finished, n: items.length }) : t('group.count', { n: items.length });
      head.append(hName, hMeta);
      if (g.pack) head.append(packActions(g.pack));
      head.onclick = () => toggleGroup(g.key, open);
      head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(g.key, open); } };
      ul.appendChild(head);
      if (!open) continue;

      for (const l of items) {
        const li = document.createElement('li');
        li.className = 'item';
        li.dataset.level = level;
        li.tabIndex = 0;
        if (l.id === state.activeId) li.classList.add('active');
        const total = splitSentences(l.text).length;
        const p = state.progress[l.id];
        const doneCount = p ? p.done.length : 0;
        const name = document.createElement('span');
        name.className = 'i-name';
        name.innerHTML = (l.audio && !l.pack ? ic('music') : '') + esc(l.level ? l.title.replace(`${l.level} · `, '') : l.title);
        const meta = document.createElement('span');
        meta.className = 'meta' + (doneCount >= total && total ? ' done' : '');
        meta.textContent = doneCount >= total && total ? t('item.done') : doneCount ? `${doneCount}/${total}` : t('item.sentences', { n: total });
        li.append(name, meta);
        li.onclick = () => selectLesson(l.id);
        li.onkeydown = (e) => { if (e.key === 'Enter') selectLesson(l.id); };
        ul.appendChild(li);
      }
    }
    const restore = $('btn-restore');
    restore.hidden = !state.hiddenBuiltin.length;
    restore.textContent = t('lib.restore', { n: state.hiddenBuiltin.length });
  }

  function isFinished(l) {
    const p = state.progress[l.id];
    return !!p && p.done.length > 0 && p.done.length >= splitSentences(l.text).length;
  }

  function openGroupOf(l) {
    if (l && !state.openGroups.includes(groupOf(l))) state.openGroups.push(groupOf(l));
  }

  function toggleGroup(key, isOpen) {
    state.openGroups = isOpen ? state.openGroups.filter((k) => k !== key) : [...state.openGroups, key];
    save();
    renderLibrary();
  }

  function selectLesson(id) {
    stopPlayback();
    resetFull();
    state.activeId = id;
    save();
    renderAll();
    // Điện thoại: chọn bài xong thì thu gọn thư viện để thấy ngay chỗ chép.
    if (narrow.matches) {
      libOpen = false;
      renderLibToggle();
      window.scrollTo({ top: 0 });
    }
  }

  // Thư viện thu gọn được trên màn hình hẹp.
  const narrow = window.matchMedia('(max-width: 860px)');
  let libOpen = !state.activeId;
  function renderLibToggle() {
    const collapsed = narrow.matches && !libOpen;
    document.querySelector('.app').classList.toggle('lib-collapsed', collapsed);
    $('btn-lib-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('lib-toggle-text').textContent = t(collapsed ? 'lib.show' : 'lib.hide');
  }
  $('btn-lib-toggle').onclick = () => { libOpen = !libOpen; renderLibToggle(); };
  narrow.addEventListener?.('change', renderLibToggle);

  // ---------- Luyện tập ----------
  // Gợi ý cho câu (hoặc cả bài) đang luyện.
  const hint = { revealed: new Set(), answer: false, count: 0 };
  function resetHint() {
    hint.revealed = new Set();
    hint.answer = false;
    hint.count = 0;
    renderHint();
  }

  function currentExpected() {
    if (state.mode === 'sentence') return sentenceFinished() ? '' : run.sentences[prog().index];
    return run.sentences.join(' ');
  }

  function showHint() {
    const expected = currentExpected();
    if (!expected || hint.answer) return;
    const i = nextHintIndex(expected, $('input').value, hint.revealed);
    if (i < 0) hint.answer = true;
    else hint.revealed.add(i);
    hint.count++;
    // Mở hết các từ thì coi như đã xem đáp án.
    if (tokenize(expected).every((t) => t.punct || hint.revealed.has(t.i))) hint.answer = true;
    renderHint();
    $('input').focus();
  }

  function showAnswer() {
    if (!currentExpected()) return;
    hint.answer = true;
    renderHint();
    $('input').focus();
  }

  function renderHint() {
    const box = $('hint-box');
    const expected = lesson() ? currentExpected() : '';
    const visible = expected && (hint.answer || hint.revealed.size);
    box.hidden = !visible;
    $('btn-hint').disabled = !expected || hint.answer;
    $('btn-answer').disabled = !expected || hint.answer;
    if (!visible) return;
    box.classList.toggle('answer', hint.answer);
    $('hint-text').textContent = hint.answer ? expected : maskSentence(expected, hint.revealed);
    if (hint.answer) {
      $('hint-label').textContent = t(state.mode === 'sentence' ? 'answer.sentence' : 'answer.full');
    } else {
      $('hint-label').textContent = t('hint.label', { n: hint.revealed.size });
    }
  }

  function resetFull() {
    run.fullIdx = 0;
    run.fullStarted = false;
  }

  function stopPlayback() {
    run.playing = false;
    run.gen++;
    clearTimeout(run.timer);
    stopVoice();
  }

  function sentenceLoop() {
    clearTimeout(run.timer);
    const g = ++run.gen;
    const p = prog();
    if (p.index >= run.sentences.length) return;
    say(p.index, () => {
      if (g !== run.gen || !run.playing) return;
      run.timer = setTimeout(() => { if (g === run.gen && run.playing) sentenceLoop(); }, state.settings.pause * 1000);
    });
  }

  function fullLoop() {
    clearTimeout(run.timer);
    const g = ++run.gen;
    if (run.fullIdx >= run.sentences.length) { run.playing = false; renderPlayer(); return; }
    renderPlayer();
    say(run.fullIdx, () => {
      if (g !== run.gen || !run.playing) return;
      run.fullIdx++;
      if (run.fullIdx >= run.sentences.length) { run.playing = false; renderPlayer(); return; }
      renderPlayer();
      run.timer = setTimeout(() => { if (g === run.gen && run.playing) fullLoop(); }, state.settings.pause * 1000);
    });
  }

  function togglePlay() {
    if (!canPlay()) return;
    speech.unlock();
    if (run.playing) {
      stopPlayback();
    } else if (state.mode === 'sentence') {
      if (sentenceFinished()) return;
      run.playing = true;
      sentenceLoop();
      $('input').focus();
    } else {
      if (run.fullIdx >= run.sentences.length) run.fullIdx = 0;
      run.playing = true;
      run.fullStarted = true;
      fullLoop();
      $('input').focus();
    }
    renderPlayer();
  }

  function replayNow() {
    if (!canPlay()) return;
    speech.unlock();
    if (state.mode === 'sentence') {
      if (sentenceFinished()) return;
      run.playing = true;
      sentenceLoop();
    } else {
      if (run.fullIdx >= run.sentences.length) run.fullIdx = run.sentences.length - 1;
      run.playing = true;
      fullLoop();
    }
    renderPlayer();
    $('input').focus();
  }

  function prevSentence() {
    if (!canPlay()) return;
    speech.unlock();
    run.fullIdx = Math.max(0, Math.min(run.fullIdx, run.sentences.length) - 1);
    run.playing = true;
    fullLoop();
    $('input').focus();
  }

  const sentenceFinished = () => prog().index >= run.sentences.length;

  function advance(entry) {
    const p = prog();
    p.done.push(Object.assign(entry, { hints: hint.answer ? 0 : hint.revealed.size, answer: hint.answer }));
    p.index++;
    resetHint();
    save();
    renderDone();
    renderLibrary();
    if (sentenceFinished()) {
      stopPlayback();
      renderPlayer();
      return;
    }
    const wasPlaying = run.playing;
    stopVoice();
    run.gen++;
    clearTimeout(run.timer);
    renderPlayer();
    if (wasPlaying) {
      run.timer = setTimeout(() => { run.playing = true; sentenceLoop(); renderPlayer(); }, 700);
    }
  }

  function check() {
    const input = $('input');
    const text = input.value;
    if (!text.trim() || !lesson()) return;

    if (state.mode === 'sentence') {
      if (sentenceFinished()) return;
      const p = prog();
      const expected = run.sentences[p.index];
      const r = compare(expected, text);
      p.tries = (p.tries || 0) + 1;
      if (r.correct) {
        showFeedback(r, text);
        input.value = '';
        autosize();
        input.classList.add('flash-ok');
        setTimeout(() => input.classList.remove('flash-ok'), 600);
        advance({ text: expected, skipped: false, tries: p.tries });
        p.tries = 0;
        save();
      } else {
        p.wrongChecks++;
        save();
        showFeedback(r, text);
      }
    } else {
      const r = compare(run.sentences.join(' '), text);
      showFeedback(r, text);
    }
  }

  function skipSentence() {
    if (state.mode !== 'sentence' || sentenceFinished()) return;
    const p = prog();
    const expected = run.sentences[p.index];
    $('input').value = '';
    $('feedback').hidden = true;
    advance({ text: expected, skipped: true, tries: p.tries || 0 });
    p.tries = 0;
    save();
  }

  function restart() {
    const p = state.progress[state.activeId];
    const hasProgress = p && (p.done.length || p.draft);
    if (hasProgress && !confirm(t('confirm.restart'))) return;
    stopPlayback();
    delete state.progress[state.activeId];
    resetFull();
    save();
    renderAll();
  }

  // ---------- Hiển thị kết quả ----------
  const VI_IME = /[đĐơƠưƯăĂ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

  let lastFeedback = null; // để dịch lại khi đổi ngôn ngữ
  function showFeedback(r, userText) {
    lastFeedback = { r, userText };
    const fb = $('feedback');
    let html = '';
    let first = true;
    for (const op of r.ops) {
      const tok = op.user || op.expected;
      const sep = first || tok.punct ? '' : ' ';
      first = false;
      if (op.type === 'ok') html += sep + esc(op.user.text);
      else if (op.type === 'wrong') {
        const cls = op.reason === 'case' ? 'tok-case' : 'tok-wrong';
        const tip = t(op.reason === 'case' ? 'tip.case' : 'tip.spelling');
        html += sep + `<span class="${cls}" title="${tip}">${esc(op.user.text)}</span>`;
      } else if (op.type === 'extra') html += sep + `<span class="tok-extra" title="${t('tip.extra')}">${esc(op.user.text)}</span>`;
      else html += sep + `<span class="tok-missing${op.expected.punct ? ' punct' : ''}" title="${t(op.expected.punct ? 'tip.missingPunct' : 'tip.missingWord')}"></span>`;
    }
    let summary;
    if (r.correct) summary = t('fb.correct');
    else summary = t('fb.errors', { n: r.errors });
    let extra = '';
    if (!r.correct) {
      extra = `<div class="legend"><span><i class="tok-wrong">abc</i> ${t('legend.spelling')}</span><span><i class="tok-case">Abc</i> ${t('legend.case')}</span><span><i class="tok-extra">abc</i> ${t('legend.extra')}</span><span><i class="tok-missing"></i> ${t('legend.missing')}</span></div>`;
      if (VI_IME.test(userText)) extra += `<div class="legend warn">${t('fb.ime')}</div>`;
    }
    fb.className = 'feedback ' + (r.correct ? 'ok' : 'bad');
    fb.innerHTML = `<div class="summary">${summary}</div>${r.correct && state.mode === 'sentence' ? '' : `<div class="marked">${html}</div>`}${extra}`;
    fb.hidden = false;
  }

  function renderDone() {
    const p = state.progress[state.activeId];
    const list = $('done-list');
    list.innerHTML = '';
    const show = state.mode === 'sentence' && p && p.done.length;
    $('done-section').hidden = !show;
    if (!show) return;
    for (const d of p.done) {
      const li = document.createElement('li');
      li.textContent = d.text;
      const tag = document.createElement('span');
      if (d.skipped) { tag.className = 'tag skip'; tag.textContent = t('tag.skip'); }
      else if (d.answer) { tag.className = 'tag answer'; tag.textContent = t('tag.answer'); }
      else if (d.hints) { tag.className = 'tag hint'; tag.textContent = t('tag.hints', { n: d.hints }); }
      else { tag.className = 'tag ok'; tag.textContent = t('tag.tries', { n: Math.max(1, d.tries || 1) }); }
      li.appendChild(tag);
      list.appendChild(li);
    }
  }

  const KBD = {
    sentence: [['Enter', 'kbd.check'], ['Shift+Enter', 'kbd.newline'], ['Ctrl+Space', 'kbd.replay'], ['Esc', 'kbd.toggle'], ['Ctrl+I', 'kbd.hint'], ['Ctrl+→', 'kbd.skip']],
    full: [['Ctrl+Enter', 'kbd.check'], ['Ctrl+Space', 'kbd.replay'], ['Esc', 'kbd.toggle']],
  };
  const setPlay = (icon, key) => { $('btn-play').innerHTML = ic(icon) + `<span>${t(key)}</span>`; };
  const setStatus = (main, sub) => {
    $('status-text').innerHTML = `<b>${esc(main)}</b>` + (sub ? ` <span class="sub">${esc(sub)}</span>` : '');
  };

  // Thanh tiến độ: mỗi câu một vạch (đã chép / đang chép / bỏ qua).
  function renderProgress(n, doneCount, current, marks) {
    const el = $('progress');
    if (el.childElementCount !== n) {
      el.innerHTML = '';
      for (let i = 0; i < n; i++) el.appendChild(document.createElement('i'));
    }
    [...el.children].forEach((c, i) => {
      c.className = i < doneCount ? (marks[i] || 'done') : i === current ? 'cur' : '';
    });
  }

  function renderPlayer() {
    const n = run.sentences.length;
    const play = $('btn-play');
    const sentence = state.mode === 'sentence';
    $('btn-skip').hidden = !sentence;
    $('btn-prev').hidden = sentence;
    $('hint').innerHTML = KBD[state.mode].map(([k, key]) => `<span><kbd>${k}</kbd>${esc(t(key))}</span>`).join('');

    if (sentence) {
      const p = prog();
      const done = p.index >= n;
      $('input').disabled = done;
      $('btn-check').disabled = done;
      $('btn-skip').disabled = done;
      $('btn-replay').disabled = done;
      play.disabled = done;
      renderProgress(n, Math.min(p.index, n), done ? -1 : p.index,
        p.done.map((d) => (d.skipped ? 'skip' : d.answer || d.hints ? 'help' : 'done')));
      if (done) {
        const skipped = p.done.filter((d) => d.skipped).length;
        setPlay('check', 'play.done');
        setStatus(t('status.finished'), t('status.stats', { n, w: p.wrongChecks, s: skipped }));
      } else {
        if (run.playing) setPlay('pause', 'play.pause');
        else setPlay('play', p.index || p.done.length ? 'play.resume' : 'play.start');
        setStatus(t('status.sentence', { i: p.index + 1, n }), t(run.playing ? 'status.looping' : 'status.stopped'));
      }
    } else {
      $('input').disabled = false;
      $('btn-check').disabled = false;
      $('btn-replay').disabled = false;
      play.disabled = false;
      const finished = run.fullIdx >= n;
      renderProgress(n, Math.min(run.fullIdx, n), run.playing || run.fullStarted ? run.fullIdx : -1, []);
      if (run.playing) {
        setPlay('pause', 'play.pause');
        setStatus(t('status.reading', { i: run.fullIdx + 1, n }));
      } else if (finished) {
        setPlay('replay', 'play.again');
        setStatus(t('status.readAll'));
      } else {
        setPlay('play', run.fullStarted ? 'play.resume' : 'play.start');
        setStatus(run.fullStarted ? t('status.pausedAt', { i: run.fullIdx + 1, n }) : t('item.sentences', { n }));
      }
      $('btn-prev').disabled = run.fullIdx === 0;
    }
    if (run.audioLoading) {
      play.disabled = true;
      $('btn-replay').disabled = true;
      setStatus(t('status.loadingAudio'));
    }
  }

  // ---------- File âm thanh của bài ----------
  // Nạp file của bài (nếu có) rồi tính đoạn thời gian cho từng câu.
  // Mốc thời gian từng từ: trong bộ nhớ nếu có, không thì đọc từ IndexedDB.
  async function getTiming(l) {
    if (l.words) return { words: l.words, silences: l.silences || [] };
    const tm = await AudioStore.get(l.id + '#t').catch(() => null);
    if (tm && Array.isArray(tm.words)) { l.words = tm.words; l.silences = tm.silences || []; return tm; }
    return null;
  }
  // Ghi mốc thời gian vào IndexedDB rồi mới đánh dấu để save() bỏ chúng khỏi localStorage.
  async function putTiming(l, words, silences) {
    l.words = words;
    l.silences = silences || [];
    try {
      await AudioStore.put(l.id + '#t', { words, silences: l.silences });
      l.audio.t = 1;
    } catch { /* để nguyên trong localStorage */ }
  }
  const delAudio = (id) => { AudioStore.del(id).catch(() => {}); AudioStore.del(id + '#t').catch(() => {}); };

  async function loadAudio(l) {
    const key = l.audio ? l.id + ':' + l.audio.added : null;
    if (key && key === run.audioKey) {
      if (!run.audioLoading && audioEl.src && l.words) run.segments = alignSentences(run.sentences, l.words, l.audio.duration, l.silences);
      return;
    }
    run.audioKey = key;
    run.segments = null;
    if (audioEl.src) {
      URL.revokeObjectURL(audioEl.src);
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    renderAudioInfo(l, false);
    if (!key) { run.audioLoading = false; return; }
    run.audioLoading = true;
    let blob = null;
    let timing = null;
    try { [blob, timing] = await Promise.all([AudioStore.get(l.id), getTiming(l)]); } catch { /* không mở được kho */ }
    if (run.audioKey !== key) return;
    run.audioLoading = false;
    const ok = !!(blob && timing);
    if (ok) {
      audioEl.src = URL.createObjectURL(blob);
      run.segments = alignSentences(run.sentences, timing.words, l.audio.duration, timing.silences);
    }
    renderAudioInfo(l, !ok);
    renderPlayer();
  }

  function renderAudioInfo(l, missing) {
    const badge = $('audio-badge');
    badge.hidden = !l.audio;
    badge.classList.toggle('missing', !!missing);
    $('audio-badge-text').textContent = t(missing ? 'badge.missing' : 'badge.audio');
    run.audioMissing = !!missing;
    $('ctrl-voice').hidden = !!l.audio && !missing;
  }

  function renderAll() {
    renderLibrary();
    const l = lesson();
    $('empty-state').hidden = !!l;
    $('practice-view').hidden = !l;
    if (!l) return;
    run.sentences = splitSentences(l.text);
    loadAudio(l);
    $('lesson-title').textContent = l.level ? l.title.replace(`${l.level} · `, '') : l.title;
    $('lesson-level').hidden = !l.level;
    $('lesson-level').textContent = l.level || '';
    $('lesson-level').dataset.level = l.level || '';
    $('mode-full').classList.toggle('active', state.mode === 'full');
    $('mode-sentence').classList.toggle('active', state.mode === 'sentence');
    $('feedback').hidden = true;
    lastFeedback = null;
    resetHint();
    $('input').value = state.mode === 'full' ? prog().draft || '' : '';
    $('input').placeholder = t(state.mode === 'full' ? 'ph.full' : 'ph.sentence');
    $('input').setAttribute('enterkeyhint', state.mode === 'sentence' ? 'send' : 'enter');
    autosize();
    renderPlayer();
    renderDone();
  }

  function setMode(m) {
    if (state.mode === m) return;
    stopPlayback();
    state.mode = m;
    resetFull();
    save();
    renderAll();
  }

  // ---------- Thêm / sửa bài ----------
  let editingId = null;
  function openEditor(l) {
    editingId = l ? l.id : null;
    $('editor').returnValue = '';
    $('editor-title').textContent = t(l ? 'ed.edit' : 'ed.add');
    edAudio = null;
    setAsrBusy(false);
    if (l && l.audio) setAudioStatus(t('asr.using', { f: describeAudio(l.audio.name, l.audio.duration) }));
    else setAudioStatus(window.matchMedia('(pointer: coarse)').matches ? t('asr.mobileWarn') : '');
    renderAudioButtons();
    $('ed-title').value = l ? l.title : '';
    $('ed-text').value = l ? l.text : '';
    updatePreview();
    $('editor').showModal();
    $('ed-title').focus();
  }
  function updatePreview() {
    const s = splitSentences($('ed-text').value);
    $('ed-count').textContent = t('ed.count', { n: s.length });
    const ol = $('ed-preview');
    ol.innerHTML = '';
    for (const x of s) { const li = document.createElement('li'); li.textContent = x; ol.appendChild(li); }
  }
  $('ed-text').addEventListener('input', updatePreview);
  $('editor').addEventListener('close', async () => {
    cancelAsr();
    const pending = edAudio;
    edAudio = null;
    if ($('editor').returnValue !== 'save') return;
    const title = $('ed-title').value.trim();
    const text = $('ed-text').value.trim();
    if (!title || !text) return;
    let l;
    if (editingId) {
      l = state.lessons.find((x) => x.id === editingId);
      if (l.text !== text) delete state.progress[l.id];
      l.title = title;
      l.text = text;
    } else {
      l = { id: 'l' + Date.now().toString(36), title, text };
      state.lessons.push(l);
      state.activeId = l.id;
      openGroupOf(l);
    }
    if (pending && pending.remove) {
      delete l.words;
      delete l.audio;
      delete l.silences;
      delAudio(l.id);
    } else if (pending) {
      try {
        await AudioStore.put(l.id, pending.file);
        l.audio = { name: pending.name, duration: pending.duration, added: Date.now() };
        await putTiming(l, pending.words, pending.silences);
        delete state.progress[l.id];
      } catch {
        alert(t('asr.saveFail'));
      }
    }
    stopPlayback();
    resetFull();
    save();
    renderAll();
  });

  // ---------- Nhận dạng từ file âm thanh (trong hộp thoại) ----------
  let edAudio = null; // file mới đã nhận dạng {file, words, duration, name} | {remove: true}
  const modelSel = $('ed-model');
  function renderModelOptions() {
    const v = modelSel.value;
    modelSel.innerHTML = '';
    for (const k of Object.keys(MODELS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = t('model.' + k);
      modelSel.appendChild(o);
    }
    if (v) modelSel.value = v;
  }
  renderModelOptions();
  modelSel.value = MODELS[state.settings.asrModel] ? state.settings.asrModel : 'small';
  modelSel.onchange = () => { state.settings.asrModel = modelSel.value; save(); };

  function fmtTime(s) {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  const mb = (b) => (b / 1048576).toFixed(0);
  const describeAudio = (name, duration) => t('asr.file', { name, dur: fmtTime(duration) });

  function setAudioStatus(text, cls = '', progress = null) {
    const st = $('ed-audio-status');
    st.textContent = text;
    st.className = 'audio-status ' + cls;
    $('ed-audio-progress').hidden = progress === null;
    if (progress !== null) $('ed-audio-bar').style.width = Math.round(progress * 100) + '%';
  }
  function setAsrBusy(on) {
    $('ed-audio-cancel').hidden = !on;
    $('ed-save').disabled = on;
    $('ed-audio').disabled = on;
    modelSel.disabled = on;
    $('ed-audio-pick').classList.toggle('disabled', on);
    if (on) $('ed-audio-remove').hidden = true;
  }
  function renderAudioButtons() {
    const l = editingId ? state.lessons.find((x) => x.id === editingId) : null;
    const has = edAudio ? !edAudio.remove : !!(l && l.audio);
    $('ed-audio-remove').hidden = !has;
  }

  $('ed-audio').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!$('ed-title').value.trim()) $('ed-title').value = file.name.replace(/\.[^.]+$/, '');
    setAsrBusy(true);
    let timer = null;
    let t0 = 0;
    try {
      const r = await transcribe(file, modelSel.value, (s) => {
        clearInterval(timer);
        if (s.phase === 'decode') setAudioStatus(t('asr.decode'));
        else if (s.phase === 'download') {
          setAudioStatus(t('asr.download', { a: mb(s.loaded), b: mb(s.total) }), '', s.loaded / s.total);
        } else if (s.phase === 'transcribing') {
          if (!t0) t0 = Date.now();
          const tick = () => {
            const el = (Date.now() - t0) / 1000;
            setAudioStatus(t('asr.transcribing', { i: s.done + 1, n: s.total, dur: fmtTime(s.duration), el: fmtTime(el) }), '', (s.done + 0.5) / s.total);
          };
          tick();
          timer = setInterval(tick, 500);
        }
      });
      clearInterval(timer);
      if (!r.text || !r.words.length) throw new Error(t('err.noSpeech'));
      // Bỏ các dòng tiêu đề mà file đề thi hay đọc (Activité 8, Exercice 1...).
      const { sentences, removed } = stripHeadings(splitSentences(r.text));
      if (!sentences.length) throw new Error(t('err.noSpeech'));
      $('ed-text').value = sentences.join('\n');
      updatePreview();
      edAudio = { file, words: r.words, silences: r.silences, duration: r.duration, name: file.name };
      setAudioStatus(t('asr.done', { f: describeAudio(file.name, r.duration) }) + (removed ? ' ' + t('asr.headings', { n: removed }) : ''), 'ok');
    } catch (err) {
      clearInterval(timer);
      const cancelled = err.message === 'cancelled';
      setAudioStatus(cancelled ? t('asr.cancelled') : err.message, cancelled ? '' : 'err');
    } finally {
      setAsrBusy(false);
      renderAudioButtons();
    }
  };
  $('ed-audio-cancel').onclick = () => cancelAsr();
  $('ed-audio-remove').onclick = () => {
    edAudio = { remove: true };
    setAudioStatus(t('asr.willRemove'));
    renderAudioButtons();
  };

  // ---------- Sao lưu / khôi phục ----------
  const blobToDataURL = (b) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // Một bài kèm file âm thanh (dạng data URL) để mang sang điện thoại / máy khác.
  async function lessonForExport(l) {
    const { words, audio, silences, ...rest } = l;
    const out = { ...rest };
    if (audio) {
      try {
        const [blob, tm] = await Promise.all([AudioStore.get(l.id), getTiming(l)]);
        if (blob && tm) {
          const { t, ...meta } = audio;
          Object.assign(out, { words: tm.words, silences: tm.silences, audio: meta, audioData: await blobToDataURL(blob) });
        }
      } catch { /* không đọc được file âm thanh: chỉ lưu văn bản */ }
    }
    return out;
  }

  $('btn-export').onclick = async () => {
    const lessons = [];
    for (const l of state.lessons) lessons.push(await lessonForExport(l));
    download({ lessons, packs: state.packs }, 'dictee-thu-vien.json');
  };

  // Gắn file âm thanh từ bản sao lưu vào bài (nếu có).
  async function importAudio(target, l) {
    if (!l.audioData || !Array.isArray(l.words) || !l.audio) return false;
    try {
      const blob = await (await fetch(l.audioData)).blob();
      await AudioStore.put(target.id, blob);
      const { t, ...meta } = l.audio;
      target.audio = { ...meta, added: Date.now() };
      await putTiming(target, l.words, l.silences);
      return true;
    } catch {
      return false;
    }
  }
  // Thêm các bài từ bản sao lưu hoặc gói nghe. Trả về số bài thêm mới.
  async function addLessons(incoming, packId) {
    let added = 0;
    for (const l of incoming) {
      if (!l || !l.id || !l.title || !l.text) continue;
      const have = state.lessons.find((x) => x.id === l.id);
      const pack = packId || l.pack;
      if (!have) {
        const entry = { id: l.id, title: l.title, text: l.text, ...(l.level ? { level: l.level } : {}), ...(pack ? { pack } : {}) };
        await importAudio(entry, l);
        state.lessons.push(entry);
        added++;
      } else if (!have.audio && have.text === l.text && await importAudio(have, l)) {
        // Bài đã có nhưng thiếu file âm thanh: bổ sung từ bản sao lưu.
        run.audioKey = null;
      }
    }
    return added;
  }
  const addPack = (p) => {
    let pack = state.packs.find((x) => x.id === p.id);
    if (!pack) {
      pack = { id: p.id, name: p.name || t('pack.defaultName'), created: p.created || Date.now() };
      state.packs.push(pack);
    }
    return pack;
  };

  // Dùng chung cho "Khôi phục" (bản sao lưu) và "Nhập gói nghe": tự nhận loại file.
  async function importFile(f, labelEl) {
    const old = labelEl && labelEl.textContent;
    if (labelEl) labelEl.textContent = t('pack.importing');
    try {
      const data = JSON.parse(await f.text());
      if (data.type === 'dictee-pack' && data.pack && data.pack.id && Array.isArray(data.lessons)) {
        const pack = addPack(data.pack);
        const n = await addLessons(data.lessons, pack.id);
        const key = 'pack:' + pack.id;
        if (!state.openGroups.includes(key)) state.openGroups.push(key);
        save();
        renderAll();
        alert(t('pack.imported', { name: pack.name, n }));
        return;
      }
      if (!Array.isArray(data.lessons)) throw new Error('invalid');
      for (const p of data.packs || []) if (p && p.id) addPack(p);
      for (const l of data.lessons) if (l && l.pack) addPack({ id: l.pack });
      const valid = data.lessons.filter((l) => l && l.id && l.title && l.text).length;
      const added = await addLessons(data.lessons);
      save();
      renderAll();
      alert(valid - added ? t('import.skipped', { a: added, s: valid - added }) : t('import.done', { a: added }));
    } catch {
      alert(t('import.invalid'));
    } finally {
      if (labelEl) labelEl.textContent = old;
    }
  }
  $('file-import').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('pack-import').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f, $('pack-import-text')); };

  // ---------- Gói nghe ----------
  const packLessons = (id) => state.lessons.filter((l) => l.pack === id);

  // Nút ở tên nhóm gói: xuất, đổi tên, xóa.
  function packActions(pack) {
    const box = document.createElement('span');
    box.className = 'g-actions';
    const mk = (icon, key, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-btn';
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
      b.innerHTML = ic(icon);
      b.onclick = (e) => { e.stopPropagation(); fn(pack); };
      b.onkeydown = (e) => e.stopPropagation();
      return b;
    };
    box.append(mk('download', 'pack.export', exportPack), mk('edit', 'pack.rename', renamePack), mk('trash', 'pack.delete', deletePack));
    return box;
  }

  async function exportPack(pack) {
    const lessons = [];
    for (const l of packLessons(pack.id)) lessons.push(await lessonForExport(l));
    const slug = pack.name.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'goi';
    download({ type: 'dictee-pack', version: 1, pack: { id: pack.id, name: pack.name, created: pack.created }, lessons }, `goi-nghe-${slug}.json`);
  }

  function renamePack(pack) {
    const name = prompt(t('pack.renamePrompt'), pack.name);
    if (!name || !name.trim()) return;
    pack.name = name.trim();
    save();
    renderLibrary();
  }

  function deletePack(pack) {
    const items = packLessons(pack.id);
    if (!confirm(t('pack.confirmDelete', { name: pack.name, n: items.length }))) return;
    if (items.some((l) => l.id === state.activeId)) { stopPlayback(); resetFull(); state.activeId = null; }
    for (const l of items) { delete state.progress[l.id]; delAudio(l.id); }
    state.lessons = state.lessons.filter((l) => l.pack !== pack.id);
    state.packs = state.packs.filter((p) => p.id !== pack.id);
    state.openGroups = state.openGroups.filter((k) => k !== 'pack:' + pack.id);
    save();
    renderAll();
  }

  // Tạo gói: nhận dạng lần lượt nhiều file trên máy tính.
  const pk = { files: [], running: false, stop: false };
  const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(mp3|m4a|wav|ogg|oga|aac|flac|opus|webm)$/i.test(f.name);
  // "09035199_001_ACT 1-1.mp3" → "ACT 1-1"
  function cleanTitle(name) {
    const base = name.replace(/\.[^.]+$/, '');
    return base.replace(/^(\d+[_\-\s.]+)+(?=\D)/, '').replace(/_/g, ' ').trim() || base;
  }
  function fillPackModels() {
    const sel = $('pk-model');
    const v = sel.value || modelSel.value;
    sel.innerHTML = '';
    for (const k of Object.keys(MODELS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = t('model.' + k);
      sel.appendChild(o);
    }
    sel.value = v;
  }
  fillPackModels();

  function setPkStatus(text, cls = '') {
    const s = $('pk-status');
    s.textContent = text;
    s.className = 'audio-status ' + cls;
  }
  function setPackFiles(list) {
    pk.files = [...list].filter(isAudioFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const ol = $('pk-list');
    ol.innerHTML = '';
    for (const f of pk.files) {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.className = 'pk-name';
      nm.textContent = cleanTitle(f.name);
      const st = document.createElement('span');
      st.className = 'pk-st';
      st.textContent = t('pack.wait');
      li.append(nm, st);
      ol.appendChild(li);
    }
    const total = pk.files.reduce((n, f) => n + f.size, 0) / 1048576;
    $('pk-summary').textContent = pk.files.length ? t('pack.selected', { n: pk.files.length, mb: total.toFixed(1) }) : t('pack.none');
    $('pk-start').disabled = !pk.files.length;
    $('pk-progress').hidden = true;
    setPkStatus('');
  }
  function setPkBusy(on) {
    pk.running = on;
    $('pk-start').disabled = on || !pk.files.length;
    $('pk-stop').hidden = !on;
    $('pk-close').disabled = on;
    for (const id of ['pk-files', 'pk-folder', 'pk-model', 'pk-name']) $(id).disabled = on;
    $('pk-pick-files').classList.toggle('disabled', on);
    $('pk-pick-folder').classList.toggle('disabled', on);
  }
  function openPackDialog() {
    if (!pk.running) {
      $('pk-name').value = '';
      setPackFiles([]);
      if (window.matchMedia('(pointer: coarse)').matches) $('pk-summary').textContent = t('asr.mobileWarn');
      setPkBusy(false);
    }
    $('pack-dialog').showModal();
  }
  $('btn-pack').onclick = openPackDialog;
  $('pk-close').onclick = () => $('pack-dialog').close();
  $('pack-dialog').addEventListener('cancel', (e) => { if (pk.running) e.preventDefault(); });
  $('pk-files').onchange = (e) => { setPackFiles(e.target.files); e.target.value = ''; };
  $('pk-folder').onchange = (e) => {
    const files = [...e.target.files];
    const folder = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : '';
    if (folder && !$('pk-name').value.trim()) $('pk-name').value = folder;
    setPackFiles(files);
    e.target.value = '';
  };
  $('pk-stop').onclick = () => {
    if (!confirm(t('pack.confirmStop'))) return;
    pk.stop = true;
    cancelAsr();
  };

  $('pk-start').onclick = async () => {
    if (pk.running || !pk.files.length) return;
    const files = pk.files;
    const model = $('pk-model').value;
    const pack = { id: 'p' + Date.now().toString(36), name: $('pk-name').value.trim() || t('pack.defaultName'), created: Date.now() };
    state.packs.push(pack);
    state.openGroups.push('pack:' + pack.id);
    save();
    pk.stop = false;
    setPkBusy(true);
    let wake = null;
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* không bắt buộc */ }
    const items = [...$('pk-list').children];
    const setBar = (x) => { $('pk-bar').style.width = Math.round((x / files.length) * 100) + '%'; };
    $('pk-progress').hidden = false;
    setBar(0);
    setPkStatus(t('pack.keepOpen'));
    let ok = 0;
    let finished = 0;
    for (let i = 0; i < files.length && !pk.stop; i++) {
      const f = files[i];
      const st = items[i].lastChild;
      items[i].className = 'running';
      st.textContent = t('pack.running');
      items[i].scrollIntoView({ block: 'nearest' });
      try {
        const r = await transcribe(f, model, (s) => {
          if (s.phase === 'download') setPkStatus(t('asr.download', { a: mb(s.loaded), b: mb(s.total) }));
          else if (s.phase === 'transcribing') {
            st.textContent = `${t('pack.running')} ${s.done + 1}/${s.total}`;
            setBar(finished + (s.done + 0.5) / s.total);
          }
        });
        const { sentences } = stripHeadings(splitSentences(r.text));
        if (!sentences.length) throw new Error(t('err.noSpeech'));
        const l = {
          id: `${pack.id}-${String(i + 1).padStart(3, '0')}`, pack: pack.id, title: cleanTitle(f.name),
          text: sentences.join('\n'), words: r.words, silences: r.silences,
          audio: { name: f.name, duration: r.duration, added: Date.now() },
        };
        await AudioStore.put(l.id, f);
        await putTiming(l, r.words, r.silences);
        state.lessons.push(l);
        ok++;
        save();
        renderLibrary();
        items[i].className = 'done';
        st.textContent = t('pack.doneItem', { n: sentences.length });
      } catch (err) {
        if (pk.stop || err.message === 'cancelled') {
          items[i].className = '';
          st.textContent = t('pack.wait');
          break;
        }
        items[i].className = 'err';
        st.textContent = t('pack.skipped', { m: err.message });
      }
      finished++;
      setBar(finished);
      setPkStatus(t('pack.overall', { d: finished, n: files.length }));
    }
    try { if (wake) await wake.release(); } catch { /* bỏ qua */ }
    if (!ok) {
      state.packs = state.packs.filter((p) => p.id !== pack.id);
      state.openGroups = state.openGroups.filter((k) => k !== 'pack:' + pack.id);
    }
    save();
    setPkBusy(false);
    $('pk-start').disabled = true; // tránh bấm lại tạo gói trùng
    setPkStatus(t(pk.stop ? 'pack.stopped' : 'pack.finished', { ok, name: pack.name }), pk.stop ? '' : 'ok');
    renderAll();
  };

  // ---------- Sự kiện ----------
  $('btn-add').onclick = () => openEditor(null);
  $('btn-edit').onclick = () => openEditor(lesson());
  $('btn-delete').onclick = () => {
    const l = lesson();
    if (!l || !confirm(t('confirm.delete', { t: l.title }))) return;
    stopPlayback();
    resetFull();
    state.lessons = state.lessons.filter((x) => x.id !== l.id);
    delete state.progress[l.id];
    delAudio(l.id);
    if (BUILTIN.some((b) => b.id === l.id)) state.hiddenBuiltin.push(l.id);
    state.activeId = null;
    save();
    renderAll();
  };
  $('btn-restore').onclick = () => {
    state.hiddenBuiltin = [];
    mergeBuiltin();
    save();
    renderAll();
  };
  $('mode-full').onclick = () => setMode('full');
  $('mode-sentence').onclick = () => setMode('sentence');
  $('btn-play').onclick = togglePlay;
  $('btn-replay').onclick = replayNow;
  $('btn-prev').onclick = prevSentence;
  $('btn-skip').onclick = skipSentence;
  $('btn-restart').onclick = restart;
  $('btn-check').onclick = check;
  $('btn-hint').onclick = showHint;
  $('btn-answer').onclick = showAnswer;

  function bindRange(id, outId, key, fmt) {
    const el = $(id);
    el.value = state.settings[key];
    $(outId).textContent = fmt(state.settings[key]);
    el.oninput = () => {
      state.settings[key] = parseFloat(el.value);
      $(outId).textContent = fmt(state.settings[key]);
      if (key === 'rate') audioEl.playbackRate = state.settings.rate;
      save();
    };
  }
  bindRange('rate', 'rate-out', 'rate', (v) => v.toFixed(2) + 'x');
  bindRange('pause', 'pause-out', 'pause', (v) => t('unit.sec', { n: v }));

  $('voice').onchange = () => {
    state.settings.voiceURI = $('voice').value;
    voice = state.settings.voiceURI ? synth.getVoices().find((v) => v.voiceURI === state.settings.voiceURI) || voice : null;
    save();
  };

  $('input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (state.mode === 'sentence' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); check(); }
    else if (state.mode === 'full' && e.ctrlKey) { e.preventDefault(); check(); }
  });
  $('input').addEventListener('input', () => {
    autosize();
    if (state.mode === 'full' && lesson()) { prog().draft = $('input').value; save(); }
  });

  // Ô chép giãn theo nội dung, luôn bằng số dòng kẻ của trang vở (32px/dòng).
  function autosize() {
    const el = $('input');
    el.style.height = 'auto';
    el.style.height = Math.max(2, Math.ceil((el.scrollHeight - 8) / 32)) * 32 + 8 + 'px';
  }

  // ---------- Ngôn ngữ giao diện ----------
  function renderLang() {
    document.querySelectorAll('.lang-switch button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang));
    });
  }
  function retranslate() {
    I18N.apply();
    renderLang();
    renderLibToggle();
    renderModelOptions();
    fillPackModels();
    populateVoices();
    updatePreview();
    $('pause-out').textContent = t('unit.sec', { n: state.settings.pause });
    renderLibrary();
    const l = lesson();
    if (!l) return;
    $('input').placeholder = t(state.mode === 'full' ? 'ph.full' : 'ph.sentence');
    if (l.audio) renderAudioInfo(l, run.audioMissing);
    renderPlayer();
    renderHint();
    renderDone();
    if (lastFeedback && !$('feedback').hidden) showFeedback(lastFeedback.r, lastFeedback.userText);
  }
  document.querySelectorAll('.lang-switch button').forEach((b) => {
    b.onclick = () => { I18N.setLang(b.dataset.lang); retranslate(); };
  });

  document.addEventListener('keydown', (e) => {
    if ($('editor').open || !lesson()) return;
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); replayNow(); }
    else if (e.key === 'Escape') { e.preventDefault(); togglePlay(); }
    else if (e.ctrlKey && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); showHint(); }
    else if (e.ctrlKey && e.key === 'ArrowRight' && state.mode === 'sentence') { e.preventDefault(); skipSentence(); }
  });

  window.addEventListener('beforeunload', () => { if (synth) synth.cancel(); });

  // ---------- Khởi động ----------
  I18N.apply();
  renderLang();
  if (synth) {
    populateVoices();
    synth.addEventListener?.('voiceschanged', populateVoices);
    // iPhone/Android nạp danh sách giọng chậm và đôi khi không báo: hỏi lại vài lần.
    let tries = 0;
    const retry = setInterval(() => {
      if (synth.getVoices().length && $('voice').options.length > 1 || ++tries > 20) clearInterval(retry);
      populateVoices();
    }, 500);
  } else {
    populateVoices();
  }
  if (!lesson()) state.activeId = state.lessons[0]?.id ?? null;
  openGroupOf(lesson());
  save(); // lưu ngay kết quả gộp/cập nhật bài mẫu
  renderAll();
  renderLibToggle();

  // Bài cũ còn mốc thời gian trong localStorage: chuyển sang IndexedDB cho nhẹ localStorage.
  (async () => {
    const old = state.lessons.filter((l) => l.audio && l.audio.t !== 1 && Array.isArray(l.words));
    for (const l of old) await putTiming(l, l.words, l.silences);
    if (old.length) save();
  })();

  // Bản trên mạng (https): cài được như app và mở được khi mất mạng.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* không bắt buộc */ });
  }
})();
