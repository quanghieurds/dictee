// Âm thanh: lưu file vào IndexedDB và nhận dạng giọng nói (Whisper chạy trong trình duyệt).
(function () {
  'use strict';
  const Core = window.DicteeCore;
  const t = (k, p) => window.DicteeI18n.t(k, p);

  // ---------- Lưu file âm thanh (IndexedDB, vì localStorage quá nhỏ) ----------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('dictee-audio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => reject(t.error);
    }));
  }
  const AudioStore = {
    put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };

  // ---------- Nhận dạng giọng nói ----------
  const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/transformers.min.js';
  const MODELS = {
    small: { id: 'onnx-community/whisper-small_timestamped' },
    base: { id: 'onnx-community/whisper-base_timestamped' },
  };

  // Worker tạo từ Blob vì trang mở từ file:// không được nạp worker từ file.
  const WORKER_SRC = `
    let asr = null, loaded = null;
    const HALLU = /amara.org|sous-titr|merci d'avoir regard|abonnez-vous/i;
    self.onmessage = async (e) => {
      const { audio, model, chunks } = e.data;
      try {
        const { pipeline, env } = await import('${LIB}');
        env.allowLocalModels = false;
        if (!asr || loaded !== model) {
          const files = {};
          asr = await pipeline('automatic-speech-recognition', model, {
            dtype: 'q8', device: 'wasm',
            progress_callback: (p) => {
              if (p.status !== 'progress' || !p.total) return;
              files[p.file] = [p.loaded, p.total];
              let a = 0, b = 0;
              for (const k in files) { a += files[k][0]; b += files[k][1]; }
              self.postMessage({ type: 'download', loaded: a, total: b });
            },
          });
          loaded = model;
        }
        // Nhận dạng từng đoạn ngắn (đã cắt ở khoảng lặng), mốc thời gian theo cụm câu.
        const segments = [];
        for (let i = 0; i < chunks.length; i++) {
          self.postMessage({ type: 'transcribing', done: i, total: chunks.length });
          const [a, b] = chunks[i];
          const slice = audio.subarray(Math.floor(a * 16000), Math.ceil(b * 16000));
          const out = await asr(slice, { language: 'french', task: 'transcribe', return_timestamps: true });
          const parts = (out.chunks && out.chunks.length) ? out.chunks : [{ text: out.text, timestamp: [0, b - a] }];
          for (const p of parts) {
            // Bỏ câu trống và câu "ma" Whisper hay tự bịa khi gặp tiếng ồn.
            if (!p.text || !p.text.trim() || HALLU.test(p.text)) continue;
            const ts = p.timestamp || [0, b - a];
            const s = a + Math.min(ts[0] ?? 0, b - a);
            const t = a + Math.min(ts[1] ?? (b - a), b - a);
            segments.push({ text: p.text, start: s, end: Math.max(s, t) });
          }
        }
        self.postMessage({ type: 'done', segments });
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };`;

  let worker = null;
  let workerUrl = null;
  function getWorker() {
    if (!worker) {
      workerUrl = workerUrl || URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
    }
    return worker;
  }

  // Giải mã file (mp3, m4a, wav, ...) thành âm thanh mono 16 kHz cho Whisper.
  async function decode(file) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: 16000 });
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
      }
      return { audio: mono, duration: buf.duration };
    } finally {
      ctx.close();
    }
  }

  let current = null; // lượt nhận dạng đang chạy
  // onStatus({phase: 'decode'|'download'|'transcribing', loaded, total, duration})
  async function transcribe(file, modelKey, onStatus) {
    cancel();
    const job = {};
    current = job;
    onStatus({ phase: 'decode' });
    let decoded;
    try {
      decoded = await decode(file);
    } catch {
      throw new Error(t('err.decode'));
    }
    if (current !== job) throw new Error('cancelled');
    const { audio, duration } = decoded;
    const silences = Core.findSilences(audio, 16000);
    const chunks = Core.planChunks(silences, duration);
    if (!chunks.length) throw new Error(t('err.noSpeech'));
    const w = getWorker();
    return new Promise((resolve, reject) => {
      job.reject = reject;
      let watchdog = null;
      // Hỏng thì bỏ worker này, lần sau tạo worker mới.
      const fail = (msg) => {
        clearTimeout(watchdog);
        if (current !== job) return;
        current = null;
        if (worker === w) { w.terminate(); worker = null; }
        reject(new Error(friendly(msg)));
      };
      // Đến lúc bắt đầu nghe, worker luôn gửi tin (tiến độ tải); im lặng lâu nghĩa là bị treo.
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => fail(t('err.timeout')), 60000);
      };
      w.onmessage = (e) => {
        if (current !== job) return;
        const d = e.data;
        if (d.type === 'download') { arm(); onStatus({ phase: 'download', loaded: d.loaded, total: d.total }); }
        else if (d.type === 'transcribing') { clearTimeout(watchdog); onStatus({ phase: 'transcribing', duration, done: d.done, total: d.total }); }
        else if (d.type === 'error') fail(d.message);
        else if (d.type === 'done') {
          current = null;
          const words = segmentsToWords(d.segments);
          resolve({ text: words.map((x) => x.text).join('').trim(), words, duration, silences });
        }
      };
      w.onerror = (e) => fail(e.message || t('err.unknown'));
      arm();
      w.postMessage({ audio, model: MODELS[modelKey].id, chunks }, [audio.buffer]);
    });
  }

  // Chia mỗi cụm thành từng từ, thời gian chia theo độ dài chữ (điểm cắt câu sẽ được
  // dời vào khoảng lặng sau). Cụm thiếu dấu câu cuối mà cụm sau viết hoa thì thêm dấu chấm.
  function segmentsToWords(segs) {
    const words = [];
    segs.forEach((s, i) => {
      let text = s.text.trim();
      const next = segs[i + 1];
      if (!/[.?!…]["»)]?$/.test(text) && (!next || /^\s*[«"]?\p{Lu}/u.test(next.text))) text = text.replace(/[,;:]$/, '') + '.';
      const parts = text.split(/\s+/);
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      let t = s.start;
      for (const p of parts) {
        const d = ((s.end - s.start) * p.length) / total;
        words.push({ text: ' ' + p, start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100 });
        t += d;
      }
    });
    return words;
  }

  function friendly(msg) {
    if (/fetch|network|import|load|Failed/i.test(msg)) {
      return t('err.load', { m: msg });
    }
    return t('err.fail', { m: msg });
  }

  // Dừng lượt đang chạy (hủy worker vì Whisper không dừng giữa chừng được).
  function cancel() {
    if (!current) return;
    const job = current;
    current = null;
    if (worker) { worker.terminate(); worker = null; }
    if (job.reject) job.reject(new Error('cancelled'));
  }

  window.DicteeAudio = { AudioStore, MODELS, transcribe, cancel, busy: () => !!current };
})();
