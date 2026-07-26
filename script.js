/* =========================================================
   まねっこ英語 - ゲームロジック
   ========================================================= */

// ---------- 要素取得 ----------
const screens = {
  title: document.getElementById("screen-title"),
  game: document.getElementById("screen-game"),
  result: document.getElementById("screen-result"),
  ranking: document.getElementById("screen-ranking"),
};

const el = {
  btnStart: document.getElementById("btn-start"),
  btnShowRanking: document.getElementById("btn-show-ranking"),
  btnListen: document.getElementById("btn-listen"),
  btnRecord: document.getElementById("btn-record"),
  recordIcon: document.getElementById("record-icon"),
  recordStatus: document.getElementById("record-status"),
  feedback: document.getElementById("feedback"),
  hudScore: document.getElementById("hud-score"),
  hudQnum: document.getElementById("hud-qnum"),
  questionText: document.getElementById("question-text"),
  questionJp: document.getElementById("question-jp"),
  btnRetry: document.getElementById("btn-retry"),
  btnGotoRanking: document.getElementById("btn-goto-ranking"),
  btnGotoTitle2: document.getElementById("btn-goto-title2"),
  btnBackTitle: document.getElementById("btn-back-title"),
  resultTitle: document.getElementById("result-title"),
  resultScore: document.getElementById("result-score"),
  resultName: document.getElementById("result-name"),
  rankingList: document.getElementById("ranking-list"),
  rankingEmpty: document.getElementById("ranking-empty"),
  unsupportedBanner: document.getElementById("unsupported-banner"),
  mistakeCard: document.getElementById("mistake-card"),
  heardText: document.getElementById("heard-text"),
  diffWordsEl: document.getElementById("diff-words"),
  tipText: document.getElementById("tip-text"),
  reviewCard: document.getElementById("review-card"),
  reviewTarget: document.getElementById("review-target"),
  reviewHeard: document.getElementById("review-heard"),
  reviewDiff: document.getElementById("review-diff"),
  reviewTip: document.getElementById("review-tip"),
};

const RANKING_KEY = "manekko_eigo_ranking_v1";
const MAX_ATTEMPTS_PER_QUESTION = 2; // マイクの聞き取りミス救済のため1問2回まで挑戦OK

// ---------- 状態 ----------
let state = {
  score: 0,
  qIndex: 0,
  attemptsLeft: MAX_ATTEMPTS_PER_QUESTION,
  currentSentence: null,
  usedIndices: [],
  playerName: "",
  lastMistake: null, // { target, heardText, wordsHtml, tip }
};

// ---------- 画面切り替え ----------
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

// ---------- 音声合成 (読み上げ) ----------
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 0.9;
  utter.pitch = 1.05;
  window.speechSynthesis.speak(utter);
}

// ---------- 音声認識 ----------
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isRecording = false;

function setupRecognition() {
  if (!SpeechRecognitionAPI) return null;
  const rec = new SpeechRecognitionAPI();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  rec.continuous = false;
  return rec;
}

// ---------- 文字列の正規化・類似度判定 ----------
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[.,!?'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// レーベンシュタイン距離
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - dist / maxLen;
}

// 単語一致率もあわせてチェック（短い文の誤差を吸収）
function wordOverlapRatio(a, b) {
  const wa = normalize(a).split(" ").filter(Boolean);
  const wb = normalize(b).split(" ").filter(Boolean);
  if (wa.length === 0) return 0;
  let hit = 0;
  const bCopy = [...wb];
  wa.forEach((w) => {
    const idx = bCopy.indexOf(w);
    if (idx !== -1) {
      hit++;
      bCopy.splice(idx, 1);
    }
  });
  return hit / wa.length;
}

function isMatch(target, candidates) {
  return candidates.some((c) => {
    const sim = similarity(target, c);
    const overlap = wordOverlapRatio(target, c);
    return sim >= 0.72 || overlap >= 0.75;
  });
}

// 認識候補の中から、お手本にいちばん近いものを選ぶ（フィードバック表示用）
function pickBestCandidate(target, candidates) {
  if (!candidates || candidates.length === 0) return "";
  let best = candidates[0];
  let bestScore = -1;
  candidates.forEach((c) => {
    const s = similarity(target, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  });
  return best;
}

// 単語単位のLCS差分（お手本の文の中で「言えていた／言えていなかった」単語を判定）
function diffWords(targetWords, heardWords) {
  const n = targetWords.length;
  const m = heardWords.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (targetWords[i - 1] === heardWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const matchedIdx = new Set();
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (targetWords[i - 1] === heardWords[j - 1]) {
      matchedIdx.add(i - 1);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return targetWords.map((w, idx) => ({ word: w, matched: matchedIdx.has(idx) }));
}

// 発音のアドバイス（聞き取れなかった単語の特徴から、簡単なヒントを出す）
function getPronunciationTip(word) {
  const w = (word || "").toLowerCase();
  if (!w) return "もういちど、おおきな こえで はっきり いってみよう！";
  if (/th/.test(w)) {
    return `「th」の おと に ちゅうい！ したの さきを かるく はの あいだに だして「ドゥ」に ちかい おとを だしてみよう（例: think, this）。`;
  }
  if (/v/.test(w)) {
    return `「v」の おと は したくちびる に うわの はを かるく あてて「ヴー」と いってみよう！`;
  }
  if (/r/.test(w)) {
    return `「r」の おと は くちを まるく すぼめて、したを どこにも つけずに いってみよう！`;
  }
  if (/l/.test(w)) {
    return `「l」の おと は したの さき を うえの は の うらに ちょんと つけて いってみよう！`;
  }
  if (/s$/.test(w) && w.length > 2) {
    return `さいごの「s」の おと を わすれずに、しっかり きこえるように いってみよう！`;
  }
  if (w.length >= 7) {
    return `ながい たんご は、みじかく くぎって ひとつずつ ゆっくり いってみよう！`;
  }
  return `もういちど、おおきな こえで はっきり いってみよう！`;
}

// まちがえたときの表示内容（きこえた文・単語のちがい・アドバイス）を組み立てる
function buildMistakeFeedback(target, candidates) {
  const heardBest = pickBestCandidate(target, candidates);
  const targetWords = normalize(target).split(" ").filter(Boolean);
  const heardWords = normalize(heardBest).split(" ").filter(Boolean);
  const diff = diffWords(targetWords, heardWords);
  const mismatched = diff.filter((d) => !d.matched).map((d) => d.word);
  const wordsHtml = diff
    .map((d) => `<span class="${d.matched ? "word-ok" : "word-ng"}">${d.word}</span>`)
    .join(" ");
  const tip =
    mismatched.length > 0
      ? getPronunciationTip(mismatched[0])
      : "おしい！もういちど はっきり いってみよう。";
  return {
    heardText: heardBest ? heardBest : "（うまく きこえなかったよ）",
    wordsHtml,
    tip,
  };
}

// ---------- ランダム出題 ----------
function pickNextSentence() {
  if (state.usedIndices.length >= SENTENCES.length) {
    state.usedIndices = []; // 全部出したら仕切り直し
  }
  let idx;
  do {
    idx = Math.floor(Math.random() * SENTENCES.length);
  } while (state.usedIndices.includes(idx));
  state.usedIndices.push(idx);
  return SENTENCES[idx];
}

// ---------- ゲーム開始 ----------
function startGame() {
  state.score = 0;
  state.qIndex = 1;
  state.usedIndices = [];
  state.lastMistake = null;
  el.hudScore.textContent = "0";
  el.hudQnum.textContent = "1";
  el.feedback.textContent = "";
  el.feedback.className = "feedback";
  el.mistakeCard.style.display = "none";
  el.reviewCard.style.display = "none";
  showScreen("game");
  nextQuestion();
}

function nextQuestion() {
  state.currentSentence = pickNextSentence();
  state.attemptsLeft = MAX_ATTEMPTS_PER_QUESTION;
  el.questionText.textContent = state.currentSentence.en;
  el.questionJp.textContent = `（${state.currentSentence.jp}）`;
  el.hudQnum.textContent = String(state.qIndex);
  el.recordStatus.textContent = "マイクを おしてね";
  el.feedback.textContent = "";
  el.feedback.className = "feedback";
  el.mistakeCard.style.display = "none";
  setTimeout(() => speak(state.currentSentence.en), 400);
}

// ---------- 録音（音声認識）処理 ----------
function toggleRecording() {
  if (!SpeechRecognitionAPI) {
    showUnsupported();
    return;
  }
  if (isRecording) return; // 二重起動防止

  recognition = setupRecognition();
  if (!recognition) {
    showUnsupported();
    return;
  }

  isRecording = true;
  el.btnRecord.classList.add("recording");
  el.recordIcon.textContent = "⏺";
  el.recordStatus.textContent = "きいているよ...はなしてね！";
  el.feedback.textContent = "";
  el.feedback.className = "feedback";

  recognition.onresult = (event) => {
    const results = event.results[0];
    const candidates = [];
    for (let i = 0; i < results.length; i++) {
      candidates.push(results[i].transcript);
    }
    handleRecognitionResult(candidates);
  };

  recognition.onerror = (event) => {
    stopRecordingUI();
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      el.recordStatus.textContent = "マイクの きょかが ひつようです🎤";
    } else if (event.error === "no-speech") {
      el.recordStatus.textContent = "こえが きこえなかったよ。もういちど！";
    } else {
      el.recordStatus.textContent = "うまく きこえなかったよ。もういちど！";
    }
  };

  recognition.onend = () => {
    stopRecordingUI();
  };

  try {
    recognition.start();
  } catch (e) {
    stopRecordingUI();
  }
}

function stopRecordingUI() {
  isRecording = false;
  el.btnRecord.classList.remove("recording");
  el.recordIcon.textContent = "🎤";
}

function handleRecognitionResult(candidates) {
  const target = state.currentSentence.en;
  const matched = isMatch(target, candidates);

  if (matched) {
    onCorrect();
  } else {
    onWrong(candidates);
  }
}

function onCorrect() {
  state.score++;
  el.hudScore.textContent = String(state.score);
  el.feedback.textContent = pickPraise();
  el.feedback.className = "feedback ok";
  el.recordStatus.textContent = "せいかい！";
  el.mistakeCard.style.display = "none";
  burstConfetti();

  setTimeout(() => {
    state.qIndex++;
    nextQuestion();
  }, 1100);
}

function onWrong(candidates) {
  state.attemptsLeft--;

  const fb = buildMistakeFeedback(state.currentSentence.en, candidates);

  // 単語ごとの違い・きこえた文・発音アドバイスを表示
  el.heardText.textContent = `"${fb.heardText}"`;
  el.diffWordsEl.innerHTML = fb.wordsHtml;
  el.tipText.textContent = `💡 ${fb.tip}`;
  el.mistakeCard.style.display = "block";

  // ゲーム終了時にも見返せるよう記録しておく
  state.lastMistake = {
    target: state.currentSentence.en,
    targetJp: state.currentSentence.jp,
    heardText: fb.heardText,
    wordsHtml: fb.wordsHtml,
    tip: fb.tip,
  };

  if (state.attemptsLeft > 0) {
    el.feedback.textContent = `おしい！もういちど ちょうせん！`;
    el.feedback.className = "feedback ng";
    el.recordStatus.textContent = "した の アドバイスを みて、もういちど はなしてね";
  } else {
    el.feedback.textContent = `ゲームオーバー...`;
    el.feedback.className = "feedback ng";
    setTimeout(() => endGame(), 1400);
  }
}

function pickPraise() {
  const list = ["せいかい！🎉", "すごい！👏", "パーフェクト！✨", "ナイス！🌟", "グレート！🏅"];
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- 紙吹雪 ----------
function burstConfetti() {
  const colors = ["#ff6fa5", "#ffa447", "#ffd23f", "#4fd67f", "#3ec7ff", "#a06bff"];
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = 1.2 + Math.random() * 1.2 + "s";
    piece.style.width = piece.style.height = 6 + Math.random() * 8 + "px";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 2600);
  }
}

// ---------- ゲームオーバー & ランキング ----------
function generateRandomName() {
  const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  return adj + noun;
}

function loadRanking() {
  try {
    const raw = localStorage.getItem(RANKING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveRanking(list) {
  localStorage.setItem(RANKING_KEY, JSON.stringify(list));
}

function addRankingEntry(name, score) {
  const list = loadRanking();
  list.push({ name, score, date: new Date().toISOString() });
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, 30);
  saveRanking(trimmed);
  return trimmed;
}

function endGame() {
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  const name = generateRandomName();
  state.playerName = name;
  addRankingEntry(name, state.score);

  el.resultScore.textContent = String(state.score);
  el.resultName.textContent = name;
  el.resultTitle.textContent = resultMessage(state.score);

  // 最後にまちがえた問題のふりかえりを表示（発音のアドバイス付き）
  if (state.lastMistake) {
    el.reviewTarget.textContent = `${state.lastMistake.target}（${state.lastMistake.targetJp}）`;
    el.reviewHeard.textContent = `"${state.lastMistake.heardText}"`;
    el.reviewDiff.innerHTML = state.lastMistake.wordsHtml;
    el.reviewTip.textContent = `💡 ${state.lastMistake.tip}`;
    el.reviewCard.style.display = "block";
  } else {
    el.reviewCard.style.display = "none";
  }

  showScreen("result");
}

function resultMessage(score) {
  if (score >= 15) return "きみは えいごマスターだ！🏆";
  if (score >= 8) return "すごい！よく がんばったね！";
  if (score >= 3) return "いいちょうし！つぎも がんばろう！";
  return "よく ちょうせんしたね！";
}

// ---------- ランキング画面描画 ----------
function renderRanking() {
  const list = loadRanking();
  el.rankingList.innerHTML = "";

  if (list.length === 0) {
    el.rankingEmpty.style.display = "block";
    return;
  }
  el.rankingEmpty.style.display = "none";

  const medals = ["🥇", "🥈", "🥉"];
  list.slice(0, 10).forEach((entry, i) => {
    const li = document.createElement("li");
    if (i < 3) li.classList.add(`rank-${i + 1}`);
    const rankLabel = i < 3 ? medals[i] : String(i + 1);
    li.innerHTML = `
      <span class="rank-num">${rankLabel}</span>
      <span class="rank-name">${escapeHtml(entry.name)}</span>
      <span class="rank-score">${entry.score}問</span>
    `;
    el.rankingList.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- 非対応ブラウザ表示 ----------
function showUnsupported() {
  el.unsupportedBanner.style.display = "block";
  el.recordStatus.textContent = "このブラウザは マイクにんしきに たいおうしていません";
}

// ---------- イベント登録 ----------
el.btnStart.addEventListener("click", () => {
  // 初回タップでSpeechSynthesisをアンロック(iOS対策)
  if ("speechSynthesis" in window) {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }
  if (!SpeechRecognitionAPI) {
    showUnsupported();
  }
  startGame();
});

el.btnShowRanking.addEventListener("click", () => {
  renderRanking();
  showScreen("ranking");
});

el.btnListen.addEventListener("click", () => {
  if (state.currentSentence) speak(state.currentSentence.en);
});

el.btnRecord.addEventListener("click", toggleRecording);

el.btnRetry.addEventListener("click", () => {
  startGame();
});

el.btnGotoRanking.addEventListener("click", () => {
  renderRanking();
  showScreen("ranking");
});

el.btnGotoTitle2.addEventListener("click", () => {
  showScreen("title");
});

el.btnBackTitle.addEventListener("click", () => {
  showScreen("title");
});

// ---------- 初期化 ----------
if (!SpeechRecognitionAPI) {
  // 対応していない場合はタイトル画面でも案内を出す
  document.addEventListener("DOMContentLoaded", showUnsupported);
}

showScreen("title");
