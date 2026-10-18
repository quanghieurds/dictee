const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences, compare } = require('../core.js');
const core = require('../core.js');

test('tách câu cơ bản theo . ? !', () => {
  assert.deepEqual(
    splitSentences('Il fait beau. Tu viens ? Oui ! Allons-y.'),
    ['Il fait beau.', 'Tu viens ?', 'Oui !', 'Allons-y.']
  );
});

test('không tách ở từ viết tắt và chữ cái đầu tên', () => {
  assert.deepEqual(
    splitSentences('M. Dupont et Mme Martin arrivent. J. Verne écrit en 1870 apr. J.-C. Bien.'),
    ['M. Dupont et Mme Martin arrivent.', 'J. Verne écrit en 1870 apr. J.-C. Bien.']
  );
});

test('dấu ba chấm, ngoặc kép kiểu Pháp và xuống dòng', () => {
  assert.deepEqual(
    splitSentences('Il dit : « Viens ici ! » Puis il part...\nLigne deux sans point'),
    ['Il dit : « Viens ici ! »', 'Puis il part...', 'Ligne deux sans point']
  );
});

test('không tách khi sau dấu chấm là chữ thường', () => {
  assert.deepEqual(splitSentences('Il a vu etc. et puis rien.'), ['Il a vu etc. et puis rien.']);
});

test('bỏ qua dấu trên chữ và œ', () => {
  const r = compare("L'élève a vu sa sœur à l'école.", "L'eleve a vu sa soeur a l'ecole.");
  assert.equal(r.correct, true);
});

test('bỏ qua dấu phẩy, hai chấm, ngoặc kép', () => {
  const r = compare('Il dit : « Oui, bien sûr. »', 'Il dit Oui bien sur.');
  assert.equal(r.correct, true);
});

test('bắt buộc viết hoa', () => {
  const r = compare('Paul mange.', 'paul mange.');
  assert.equal(r.correct, false);
  assert.equal(r.ops[0].type, 'wrong');
  assert.equal(r.ops[0].reason, 'case');
});

test('bắt buộc dấu chấm cuối câu và đúng loại dấu', () => {
  assert.equal(compare('Tu viens.', 'Tu viens').correct, false);
  assert.equal(compare('Tu viens ?', 'Tu viens.').correct, false);
  assert.equal(compare('Tu viens ?', 'Tu viens?').correct, true);
  assert.equal(compare('Il part...', 'Il part…').correct, true);
});

test('sai chính tả được ghép đúng vị trí, không báo thiếu/thừa', () => {
  const r = compare('Les enfants jouent dans le jardin.', 'Les enfants joue dans le jardin.');
  assert.equal(r.errors, 1);
  const w = r.ops.find((o) => o.type !== 'ok');
  assert.equal(w.type, 'wrong');
  assert.equal(w.user.text, 'joue');
});

test('thiếu từ và thừa từ', () => {
  const missing = compare('Les enfants jouent.', 'Les jouent.');
  assert.deepEqual(missing.ops.map((o) => o.type), ['ok', 'missing', 'ok', 'ok']);
  const extra = compare('Les enfants jouent.', 'Les petits enfants jouent.');
  assert.deepEqual(extra.ops.map((o) => o.type), ['ok', 'extra', 'ok', 'ok', 'ok']);
});

test('dấu nháy đơn kiểu khác nhau vẫn đúng, gạch nối bắt buộc', () => {
  assert.equal(compare('C’est l’heure.', "C'est l'heure.").correct, true);
  assert.equal(compare('Peut-être.', 'Peut être.').correct, false);
});

test('bài trống không bao giờ đúng', () => {
  assert.equal(compare('Bonjour.', '').correct, false);
});

const { nextHintIndex, maskSentence } = require('../core.js');

test('che câu, giữ dấu nối và dấu câu', () => {
  assert.equal(maskSentence("C'est le petit-déjeuner, Paul !", new Set()), "_'___ __ _____-________, ____ !");
  assert.equal(maskSentence('Il fait beau.', new Set([2])), 'Il fait beau.'.replace('Il', '__').replace('fait', '____'));
});

test('gợi ý ưu tiên từ sai đầu tiên', () => {
  const s = 'Les enfants jouent dans le jardin.';
  assert.equal(nextHintIndex(s, 'Les enfants joue dans le jardin.', new Set()), 2);
  assert.equal(nextHintIndex(s, 'Les jouent dans le jardin.', new Set()), 1);
});

test('gợi ý khi chưa gõ gì: lần lượt từ đầu, hết thì -1', () => {
  const s = 'Il part.';
  const r = new Set();
  r.add(nextHintIndex(s, '', r));
  assert.deepEqual([...r], [0]);
  r.add(nextHintIndex(s, '', r));
  assert.equal(nextHintIndex(s, '', r), -1);
});

// Kết quả nhận dạng thật (Whisper base) của 4 câu tiếng Pháp.
const WORDS = [[' Ce',0,0.34],[' matin,',0.34,0.78],[' il',1.08,1.2],[' fait',1.2,1.44],[' beau',1.44,1.66],[' sur',1.66,1.92],[' la',1.92,2.08],[' ville.',2.08,2.46],[' Les',3.38,3.72],[' enfants',3.72,4.1],[' jouent',4.1,4.46],[' dans',4.46,4.6],[' le',4.6,4.74],[' jardin.',4.74,5.32],[' Mon',6.3,6.52],[' voisin',6.52,7],[' promène',7,7.46],[' son',7.46,7.74],[' chien',7.74,8.08],[' tous',8.08,8.34],[' les',8.34,8.52],[' jours',8.52,8.7],[' à',8.7,8.9],[' 8',8.9,9.1],[' heures.',9.1,9.62],[' Est',10.52,10.76],['-ce',10.76,10.92],[' que',10.92,11.04],[' tu',11.04,11.22],[' viens',11.22,11.46],[' avec',11.46,11.8],[' nous',11.8,12.06],[' au',12.06,12.26],[' marché?',12.26,12.68]]
  .map(([text, start, end]) => ({ text, start, end }));

test('alignSentences: ghép câu với đoạn âm thanh, cắt giữa khoảng lặng', () => {
  const text = WORDS.map((w) => w.text).join('');
  const sents = core.splitSentences(text);
  assert.equal(sents.length, 4);
  const seg = core.alignSentences(sents, WORDS, 13.7);
  assert.equal(seg.length, 4);
  assert.equal(seg[0].start, 0);
  assert.ok(seg[0].end >= 2.46 && seg[0].end <= 3.0, JSON.stringify(seg[0]));
  assert.ok(seg[1].start > 2.46 && seg[1].start <= 3.38, JSON.stringify(seg[1]));
  assert.ok(seg[2].start <= 6.3 && seg[2].end >= 9.62, JSON.stringify(seg[2]));
  assert.ok(seg[3].start <= 10.52 && Math.abs(seg[3].end - 13.38) < 0.011, JSON.stringify(seg[3]));
  for (let k = 1; k < 4; k++) assert.ok(seg[k].start >= seg[k - 1].end);
});

test('alignSentences: vẫn đúng khi người dùng sửa văn bản và tách câu khác', () => {
  // "8" sửa thành "huit", gộp câu 1+2, câu cuối thêm một từ.
  const sents = ['Ce matin, il fait beau sur la ville. Les enfants jouent dans le jardin.',
    'Mon voisin promène son chien tous les jours à huit heures.',
    'Est-ce que tu viens aussi avec nous au marché ?'];
  const seg = core.alignSentences(sents, WORDS, 13.7);
  assert.ok(seg[0].start === 0 && seg[0].end >= 5.32 && seg[0].end < 6.3, JSON.stringify(seg[0]));
  assert.ok(seg[1].start <= 6.3 && seg[1].end >= 9.62 && seg[1].end < 10.52, JSON.stringify(seg[1]));
  assert.ok(seg[2].start <= 10.52 && seg[2].start > 9.62, JSON.stringify(seg[2]));
});

test('alignSentences: câu không có trong âm thanh nằm giữa hai câu bên cạnh', () => {
  const sents = ['Ce matin, il fait beau sur la ville.', 'Zzz.', 'Les enfants jouent dans le jardin.'];
  const seg = core.alignSentences(sents, WORDS.slice(0, 14), 6);
  assert.ok(seg[1].start >= seg[0].end && seg[1].end <= seg[2].start + 0.01, JSON.stringify(seg));
});

test('findSilences + planChunks: cắt ở khoảng lặng, bỏ đoạn im lặng', () => {
  const rate = 1000;
  // 0–1s im, 1–11s nói, 11–12s im, 12–40s nói (có nghỉ ngắn ở 30s), 40–41s im
  const s = new Float32Array(41 * rate);
  for (let i = 0; i < s.length; i++) {
    const t = i / rate;
    const speak = (t >= 1 && t < 11) || (t >= 12 && t < 30) || (t >= 30.4 && t < 40);
    s[i] = speak ? 0.3 * Math.sin(i) : 0.0005 * Math.sin(i * 7);
  }
  const sil = core.findSilences(s, rate);
  assert.equal(sil.length, 4, JSON.stringify(sil));
  assert.deepEqual(sil[1], [11, 12]);
  const ch = core.planChunks(sil, 41);
  assert.ok(ch.every(([a, b]) => b - a <= 25), JSON.stringify(ch));
  assert.ok(Math.abs(ch[0][0] - 0.8) < 0.01 && Math.abs(ch[0][1] - 11.5) < 0.01, JSON.stringify(ch));
  assert.ok(Math.abs(ch[1][1] - 30.2) < 0.01, JSON.stringify(ch));
});

test('alignSentences: dời điểm cắt vào khoảng lặng', () => {
  // Thời gian chia đều (ước lượng) nhưng thật ra câu 1 kết thúc ở 4.0s
  const words = [' Un', ' deux', ' trois.', ' Quatre', ' cinq.'].map((text, i) => ({ text, start: i * 1.2, end: i * 1.2 + 1.2 }));
  const seg = core.alignSentences(['Un deux trois.', 'Quatre cinq.'], words, 6, [[4.0, 4.5]]);
  assert.equal(seg[0].end, 4.5);
  assert.equal(seg[1].start, 4.2);
});

test('alignSentences: xóa dòng tiêu đề thì câu đầu không phát lại tiêu đề', () => {
  const words = [[' Activité', 0.1, 1], [' 8.', 1, 1.8], [' Bienvenue', 3.8, 5], [' dans', 5, 6], [' le', 6, 7], [' train.', 7, 9.8]]
    .map(([text, start, end]) => ({ text, start, end }));
  const sil = [[0, 0.1], [1.8, 3.8], [9.8, 11]];
  const seg = core.alignSentences(['Bienvenue dans le train.'], words, 11, sil);
  assert.ok(seg[0].start >= 3.4 && seg[0].start <= 3.8, JSON.stringify(seg));
  assert.ok(seg[0].end >= 9.8 && seg[0].end <= 10.6, JSON.stringify(seg));
});

test('stripHeadings: bỏ dòng tiêu đề của file đề thi, giữ câu thường', () => {
  const input = ['Activité 8.', 'Compréhension de l\'oral.', 'Comprendre une annonce.', 'Activité 1, 1.',
    'Activité 55, Delph Blanc n°2, compréhension orale.', 'DELF-BLAN NUMERO 2.', 'Exercice 1 1 2.', '5.', 'Trois.',
    'Activité 3-2.', 'Activité 8 il arrivera à Paris à 13h12.',
    'Madame, Monsieur, bienvenue dans le train.', 'Exercice physique tous les matins.', 'Deux enfants jouent.', 'Message aux voyageurs.'];
  const r = core.stripHeadings(input);
  assert.deepEqual(r.sentences, ['Il arrivera à Paris à 13h12.', 'Madame, Monsieur, bienvenue dans le train.',
    'Exercice physique tous les matins.', 'Deux enfants jouent.', 'Message aux voyageurs.']);
  assert.equal(r.removed, 11);
});

test('stripHeadings: câu đầu "Comprendre ..." là tên dạng bài, câu sau giữ nguyên', () => {
  const r = core.stripHeadings(['Comprendre un message sur son répondeur téléphonique.', 'Coucou, c\'est Isabelle.', 'Comprendre une langue demande du temps.']);
  assert.deepEqual(r.sentences, ['Coucou, c\'est Isabelle.', 'Comprendre une langue demande du temps.']);
  assert.deepEqual(core.stripHeadings(['Hein? comprendre un message sur son répondeur téléphonique.', 'Dona mi.']).sentences, ['Dona mi.']);
  assert.deepEqual(core.stripHeadings(['Activité 3.', 'Comprendre une interaction entre locuteurs natifs.', 'Tu as vu les photos ?']).sentences, ['Tu as vu les photos ?']);
});

test('stripHeadings: nhãn "Dialogue 1", "Situation numéro 2", "D\'Elf Blanc 3"', () => {
  const r = core.stripHeadings(['Situation numéro 1.', 'Tu as vu le film ?', 'Dialogue!', 'Dialogue 2.', "D'Elf Blanc 3.", 'Vous êtes en vacances.', 'Message 2. Bonjour à tous.', 'Le message est clair.']);
  assert.deepEqual(r.sentences, ['Tu as vu le film ?', 'Vous êtes en vacances.', 'Bonjour à tous.', 'Le message est clair.']);
});

test('stripHeadings: bỏ ghi chú âm thanh *Bip* [Musique], "Activité neuve", "Épreuve type"', () => {
  const r = core.stripHeadings(['*Bip*.', 'Bonjour, c\'est Rose.', '[Musique].', 'Activité neuve!', 'Épreuve type.', 'Salut [rires] tout le monde.']);
  assert.deepEqual(r.sentences, ['Bonjour, c\'est Rose.', 'Salut tout le monde.']);
});
