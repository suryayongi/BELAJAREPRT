/* ==========================================================================
   EPrT Tel-U Prep Arena — Core Application Logic
   Offline-first (works directly via file:// using window.EPRT_QUIZ_DATA)
   ========================================================================== */

(function () {
  "use strict";

  const DATA = window.EPRT_QUIZ_DATA;
  if (!DATA) {
    document.body.innerHTML =
      '<div style="padding:32px;font-family:sans-serif"><h2>questions.js tidak ditemukan</h2><p>Pastikan file <code>questions.js</code> berada di folder yang sama dengan <code>index.html</code>.</p></div>';
    return;
  }

  const STORAGE_KEY = "eprt_telu_prep_arena_v2";
  const THEME_KEY = "eprt_telu_theme_v1";
  const BASELINE = DATA.meta.baseline2023; // { listening: 56, grammar: 49, reading: 53, total: 527 }
  const LETTERS = ["A", "B", "C", "D"];

  // Authentic ETS TOEFL ITP / EPrT Raw-to-Scaled conversion curves (interpolated cleanly)
  const SCALE_CURVES = {
    listening: [
      [0, 31], [5, 34], [10, 37], [15, 41], [20, 45], [25, 48],
      [30, 51], [35, 54], [38, 56], [40, 57], [43, 60], [46, 63], [48, 66], [50, 68]
    ],
    grammar: [
      [0, 31], [5, 33], [10, 35], [15, 40], [20, 44], [24, 48],
      [25, 49], [28, 52], [30, 54], [32, 56], [34, 58], [35, 60],
      [37, 63], [38, 65], [39, 67], [40, 68]
    ],
    reading: [
      [0, 31], [5, 33], [10, 35], [15, 38], [20, 42], [25, 46],
      [30, 49], [34, 52], [36, 53], [40, 56], [43, 59], [46, 62], [48, 65], [50, 67]
    ]
  };

  const SECTION_META = {
    grammar: {
      name: "Grammar Blitz",
      fullCount: 40,
      blitzSeconds: 37,
      examSeconds: 25 * 60,
      baseline: BASELINE.grammar
    },
    reading: {
      name: "Reading Mastery Sprint",
      fullCount: 50,
      blitzSeconds: 66,
      examSeconds: 55 * 60,
      baseline: BASELINE.reading
    },
    listening: {
      name: "Listening Trap Arena",
      fullCount: 50,
      blitzSeconds: 45,
      examSeconds: 35 * 60,
      baseline: BASELINE.listening
    }
  };

  // ==================== PERSISTENT STATE ====================
  let store = loadStore();
  let timerPrefs = { grammar: "blitz", reading: "blitz", listening: "blitz" };
  let sessionSizePrefs = { grammar: "standard", reading: "standard", listening: "standard" };
  let passageFontSize = 16;

  // ==================== ACTIVE SESSION STATE ====================
  let session = null;
  let timerHandle = null;
  let speechRate = 1.0;
  let speechQueue = [];
  let speechIndex = 0;
  let speechPlaying = false;
  let speechPaused = false;
  let availableVoices = [];

  // ==================== DOM SHORTCUTS ====================
  const $ = (id) => document.getElementById(id);

  const views = {
    home: $("view-home"),
    quiz: $("view-quiz"),
    report: $("view-report")
  };

  // ==================== INITIALIZATION ====================
  function init() {
    initTheme();
    initVoices();
    bindGlobalEvents();
    renderDashboard();
    showView("home");
  }

  function createEmptyStore() {
    return {
      sections: {},
      seenIds: { grammar: [], reading: [], listening: [] }
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.sections) {
          if (!parsed.seenIds || typeof parsed.seenIds !== "object") {
            parsed.seenIds = { grammar: [], reading: [], listening: [] };
          } else {
            ["grammar", "reading", "listening"].forEach((sec) => {
              if (!Array.isArray(parsed.seenIds[sec])) parsed.seenIds[sec] = [];
            });
          }
          return parsed;
        }
      }
    } catch (_) {
      // ignore storage errors in restricted environments
    }
    return createEmptyStore();
  }

  function saveStore(silent) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      if (!silent) {
        const ind = $("saved-indicator");
        ind.hidden = false;
        clearTimeout(ind._t);
        ind._t = setTimeout(() => {
          ind.hidden = true;
        }, 2200);
      }
    } catch (_) {
      // ignore
    }
  }

  // ==================== THEME ====================
  function initTheme() {
    let saved = "light";
    try {
      saved = localStorage.getItem(THEME_KEY) || "light";
    } catch (_) {}
    applyTheme(saved);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    $("theme-label").textContent = theme === "dark" ? "Terang" : "Gelap";
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {}
  }

  // ==================== EPrT SCALING MATH ====================
  function interpolateScale(section, rawCorrect, totalInQuiz) {
    const meta = SECTION_META[section];
    const scaledRaw = totalInQuiz > 0 ? (rawCorrect / totalInQuiz) * meta.fullCount : 0;
    const pts = SCALE_CURVES[section];
    if (scaledRaw <= pts[0][0]) return pts[0][1];
    if (scaledRaw >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      if (scaledRaw >= x0 && scaledRaw <= x1) {
        const t = (scaledRaw - x0) / (x1 - x0);
        return Math.round(y0 + t * (y1 - y0));
      }
    }
    return pts[0][1];
  }

  function calcCombinedEprt(l, g, r) {
    return Math.round(((l + g + r) * 10) / 3);
  }

  function getCefrBand(total) {
    if (total >= 627) return "CEFR C1";
    if (total >= 543) return "CEFR B2";
    if (total >= 460) return "CEFR B1";
    return "CEFR A2";
  }

  function getProjectedSections() {
    const out = {};
    ["listening", "grammar", "reading"].forEach((sec) => {
      const rec = store.sections[sec];
      if (rec && typeof rec.latestScaled === "number") {
        out[sec] = { score: rec.latestScaled, isLive: true, label: "Simulasi terbaru" };
      } else {
        out[sec] = {
          score: BASELINE[sec],
          isLive: false,
          label: sec === "grammar" ? "Target utama (2023)" : "Baseline 2023"
        };
      }
    });
    const total = calcCombinedEprt(out.listening.score, out.grammar.score, out.reading.score);
    return { sections: out, total, delta: total - BASELINE.total, cefr: getCefrBand(total) };
  }

  // ==================== DASHBOARD RENDERING ====================
  function renderDashboard() {
    const proj = getProjectedSections();
    $("dash-projected-total").textContent = proj.total;
    $("dash-cefr-badge").textContent = proj.cefr;

    const deltaEl = $("dash-projected-delta");
    deltaEl.className = "delta-pill";
    if (proj.delta > 0) {
      deltaEl.textContent = `+${proj.delta} vs 2023 (527)`;
      deltaEl.classList.add("is-up");
    } else if (proj.delta < 0) {
      deltaEl.textContent = `${proj.delta} vs 2023 (527)`;
      deltaEl.classList.add("is-down");
    } else {
      deltaEl.textContent = "Baseline 2023 (527)";
    }

    ["listening", "grammar", "reading"].forEach((sec) => {
      const info = proj.sections[sec];
      $(`dash-score-${sec}`).textContent = info.score;
      $(`dash-src-${sec}`).textContent = info.label;
    });

    const pctToTarget = Math.max(0, Math.min(100, ((proj.total - 310) / (677 - 310)) * 100));
    $("dash-target-fill").style.width = `${pctToTarget.toFixed(1)}%`;
    const gap = 650 - proj.total;
    $("dash-target-gap").textContent = gap > 0 ? `Butuh +${gap} poin` : `Target 650 tercapai (+${-gap})`;

    // Dynamic header & bank pool status
    const gTotal = DATA.grammar.length;
    const rPassages = DATA.reading.passages.length;
    const rTotal = DATA.reading.questions.length;
    const lTotal = DATA.listening.questions.length;
    const grandTotal = gTotal + rTotal + lTotal;

    const brandSub = $("brand-sub-count");
    if (brandSub) {
      brandSub.textContent = `Telkom University · Edisi 2 (${grandTotal} Soal Resmi LaC)`;
    }

    const gStructCount = DATA.grammar.filter((q) => q.subtype === "structure").length;
    const gWeCount = DATA.grammar.filter((q) => q.subtype === "written_expression").length;
    const metaG = $("meta-count-grammar");
    if (metaG) metaG.textContent = `${gTotal} soal resmi · ${gStructCount}S + ${gWeCount}WE`;

    const rPerPassage = rPassages > 0 ? Math.round(rTotal / rPassages) : 0;
    const metaR = $("meta-count-reading");
    if (metaR) metaR.textContent = `${rPassages} teks × ${rPerPassage} soal · ${rTotal} soal`;

    const lPartA = DATA.listening.questions.filter((q) => q.part === "A").length;
    const lPartB = DATA.listening.questions.filter((q) => q.part === "B").length;
    const lPartC = DATA.listening.questions.filter((q) => q.part === "C").length;
    const metaL = $("meta-count-listening");
    if (metaL) metaL.textContent = `${lTotal} soal · ${lPartA}A + ${lPartB}B + ${lPartC}C`;

    // Update each section's bank pool status & saved progress card
    ["grammar", "reading", "listening"].forEach((sec) => {
      const pool = getQuestionPool(sec);
      const validSeen = getValidSeenSet(sec);
      const poolCount = pool.length;
      const seenCount = validSeen.size;
      const remaining = Math.max(0, poolCount - seenCount);
      const seenPct = poolCount > 0 ? Math.round((seenCount / poolCount) * 100) : 0;

      const bankBar = $(`bank-status-${sec}`);
      if (bankBar) {
        const textEl = bankBar.querySelector(".bank-status-text");
        const pctEl = bankBar.querySelector(".bank-status-pct");
        const fillEl = bankBar.querySelector(".bank-status-fill");
        if (textEl) {
          textEl.textContent =
            remaining > 0
              ? `Bank: ${poolCount} Soal · Sisa Belum Dikerjakan: ${remaining}`
              : `Bank: ${poolCount} Soal · Semua sudah dicoba (siap acak ulang)`;
        }
        if (pctEl) pctEl.textContent = `${seenPct}%`;
        if (fillEl) fillEl.style.width = `${seenPct}%`;
      }

      const rec = store.sections[sec];
      const box = $(`progress-${sec}`);
      const retryBtn = $(`btn-home-retry-${sec}`);
      if (!rec) {
        box.innerHTML = '<span class="muted-note">Belum dikerjakan — siap mulai sesi pertama</span>';
        retryBtn.hidden = true;
      } else {
        const diff = rec.latestScaled - BASELINE[sec];
        const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
        box.innerHTML = `
          <span>Terakhir: <strong class="tabular">${rec.lastCorrect}/${rec.lastTotal}</strong> (${rec.lastPct}%)</span>
          <span class="tabular">Scaled <strong>${rec.latestScaled}</strong> (${diffStr})</span>
        `;
        if (rec.missedIds && rec.missedIds.length > 0) {
          retryBtn.hidden = false;
          retryBtn.textContent = `Ulangi Salah (${rec.missedIds.length})`;
        } else {
          retryBtn.hidden = true;
        }
      }
    });
  }

  // ==================== VIEW SWITCHING ====================
  function showView(name) {
    stopSpeech();
    clearTimer();
    Object.keys(views).forEach((k) => {
      views[k].hidden = k !== name;
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  // ==================== SMART NON-REPEATING DRAW & SHUFFLE ====================
  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function shuffleQuestionOptions(q) {
    // Shuffle options for ALL question types (including Error Recognition, matching official LaC EPrT format
    // where underlined segments appear without A-D tags in the sentence and answer choices can appear in any order).
    if (!Array.isArray(q.options) || q.options.length === 0) {
      return { ...q, options: [] };
    }
    const order = shuffleArray(q.options.map((_, idx) => idx));
    const newOptions = order.map((oldIdx) => q.options[oldIdx]);
    const newCorrect = order.indexOf(q.correct);
    return {
      ...q,
      options: newOptions,
      correct: newCorrect,
      optionOrder: order
    };
  }

  function getQuestionPool(section) {
    if (section === "grammar") return DATA.grammar;
    if (section === "reading") return DATA.reading.questions;
    if (section === "listening") return DATA.listening.questions;
    return [];
  }

  function getValidSeenSet(section) {
    const poolIds = new Set(getQuestionPool(section).map((q) => q.id));
    const rawSeen = (store.seenIds && store.seenIds[section]) || [];
    const valid = new Set();
    rawSeen.forEach((id) => {
      if (poolIds.has(id)) valid.add(id);
    });
    return valid;
  }

  function markQuestionSeen(section, qId) {
    if (!store.seenIds) store.seenIds = { grammar: [], reading: [], listening: [] };
    if (!Array.isArray(store.seenIds[section])) store.seenIds[section] = [];
    if (!store.seenIds[section].includes(qId)) {
      store.seenIds[section].push(qId);
    }
  }

  function drawPrioritized(items, count, isSeenFn) {
    const unseen = shuffleArray(items.filter((item) => !isSeenFn(item)));
    const seen = shuffleArray(items.filter((item) => isSeenFn(item)));
    if (unseen.length >= count) {
      return unseen.slice(0, count);
    }
    return unseen.concat(seen.slice(0, Math.max(0, count - unseen.length)));
  }

  function drawSectionQuestions(section, sessionSize) {
    const pool = getQuestionPool(section);
    let seenSet = getValidSeenSet(section);

    // If the entire pool has already been seen, seamlessly start a fresh cycle!
    if (pool.length > 0 && seenSet.size >= pool.length) {
      store.seenIds[section] = [];
      seenSet = new Set();
      saveStore(true);
    }

    let picked = [];

    if (section === "grammar") {
      const structPool = DATA.grammar.filter((q) => q.subtype === "structure");
      const wePool = DATA.grammar.filter((q) => q.subtype === "written_expression");
      const targetS =
        sessionSize === "quick"
          ? Math.min(8, structPool.length)
          : Math.min(15, structPool.length);
      const targetW =
        sessionSize === "quick"
          ? Math.min(12, wePool.length)
          : Math.min(25, wePool.length);
      const pickedS = drawPrioritized(structPool, targetS, (q) => seenSet.has(q.id));
      const pickedW = drawPrioritized(wePool, targetW, (q) => seenSet.has(q.id));
      picked = pickedS.concat(pickedW);
    } else if (section === "reading") {
      const qByPassage = {};
      DATA.reading.questions.forEach((q) => {
        if (!qByPassage[q.passageId]) qByPassage[q.passageId] = [];
        qByPassage[q.passageId].push(q);
      });
      const validPassages = DATA.reading.passages.filter((p) => (qByPassage[p.id] || []).length > 0);
      const targetPassages =
        sessionSize === "quick"
          ? Math.min(2, validPassages.length)
          : Math.min(5, validPassages.length);
      const isPassageSeen = (p) => (qByPassage[p.id] || []).every((q) => seenSet.has(q.id));
      const pickedPassages = drawPrioritized(validPassages, targetPassages, isPassageSeen);
      // Keep each passage's questions grouped together in passage order
      pickedPassages.forEach((p) => {
        picked.push(...qByPassage[p.id]);
      });
    } else if (section === "listening") {
      const partAPool = DATA.listening.questions.filter((q) => q.part === "A");
      const bByGroup = {};
      const cByGroup = {};
      DATA.listening.questions.forEach((q) => {
        if (q.part === "B") {
          if (!bByGroup[q.groupId]) bByGroup[q.groupId] = [];
          bByGroup[q.groupId].push(q);
        } else if (q.part === "C") {
          if (!cByGroup[q.groupId]) cByGroup[q.groupId] = [];
          cByGroup[q.groupId].push(q);
        }
      });
      const bGroups = Object.keys(bByGroup);
      const cGroups = Object.keys(cByGroup);

      if (sessionSize === "quick") {
        // Quick 20-question sprint: 1 Part B group + 1 Part C group + remaining Part A to hit 20 exactly
        const pickedBGroups = drawPrioritized(bGroups, Math.min(1, bGroups.length), (gid) =>
          bByGroup[gid].every((q) => seenSet.has(q.id))
        );
        const pickedCGroups = drawPrioritized(cGroups, Math.min(1, cGroups.length), (gid) =>
          cByGroup[gid].every((q) => seenSet.has(q.id))
        );
        const bItems = [];
        pickedBGroups.forEach((gid) => bItems.push(...bByGroup[gid]));
        const cItems = [];
        pickedCGroups.forEach((gid) => cItems.push(...cByGroup[gid]));
        const targetA = Math.min(partAPool.length, Math.max(0, 20 - bItems.length - cItems.length));
        const pickedA = drawPrioritized(partAPool, targetA, (q) => seenSet.has(q.id));
        picked = pickedA.concat(bItems, cItems);
      } else {
        // Full official EPrT LaC Listening: 30 Part A + 10 Part B + 10 Part C = 50 questions
        const pickedA = drawPrioritized(partAPool, Math.min(30, partAPool.length), (q) => seenSet.has(q.id));
        const pickedBGroups = drawPrioritized(bGroups, bGroups.length, (gid) =>
          bByGroup[gid].every((q) => seenSet.has(q.id))
        );
        const pickedCGroups = drawPrioritized(cGroups, cGroups.length, (gid) =>
          cByGroup[gid].every((q) => seenSet.has(q.id))
        );
        picked = pickedA.slice();
        pickedBGroups.forEach((gid) => picked.push(...bByGroup[gid]));
        pickedCGroups.forEach((gid) => picked.push(...cByGroup[gid]));
      }
    }

    return picked.map(shuffleQuestionOptions);
  }

  // ==================== START QUIZ SESSION ====================
  function startQuiz(section, missedOnlyIds) {
    const allPool = getQuestionPool(section);
    const sessionSize = sessionSizePrefs[section] || "standard";
    let questions = [];
    let isRetryMissed = false;

    if (Array.isArray(missedOnlyIds) && missedOnlyIds.length > 0) {
      const idSet = new Set(missedOnlyIds);
      const rawMissed = allPool.filter((q) => idSet.has(q.id));
      questions = rawMissed.map(shuffleQuestionOptions);
      isRetryMissed = true;
    } else {
      questions = drawSectionQuestions(section, sessionSize);
    }

    if (questions.length === 0) return;

    const timerMode = timerPrefs[section] || "blitz";
    const meta = SECTION_META[section];

    // Compute proportional exam duration for Full EPrT vs Latihan Cepat vs Missed-only
    let examSec = 0;
    if (timerMode === "exam") {
      if (isRetryMissed) {
        examSec = Math.max(60, questions.length * meta.blitzSeconds);
      } else {
        examSec = Math.max(60, Math.round((questions.length / meta.fullCount) * meta.examSeconds));
      }
    }

    // Track ordered passage list for clean "Teks 1/5" badge in Reading
    const passageOrder = [];
    if (section === "reading") {
      questions.forEach((q) => {
        if (!passageOrder.includes(q.passageId)) passageOrder.push(q.passageId);
      });
    }

    session = {
      section,
      sessionSize,
      isRetryMissed,
      timerMode,
      questions,
      passageOrder,
      index: 0,
      answers: [], // { id, chosen, correct, isRight, timeSpent, pattern }
      streak: 0,
      bestStreak: 0,
      locked: false,
      questionStartTs: Date.now(),
      totalSecondsRemaining: examSec,
      totalSecondsInitial: examSec,
      qSecondsRemaining: meta.blitzSeconds,
      qSecondsInitial: meta.blitzSeconds,
      lastPassageId: null,
      lastListeningGroupId: null
    };

    showView("quiz");

    const titleSuffix = isRetryMissed
      ? " (Ulangi Soal Salah)"
      : sessionSize === "quick"
      ? ` (Latihan Cepat ${questions.length} Soal)`
      : ` (Full EPrT ${questions.length} Soal)`;
    $("hud-quiz-name").textContent = meta.name + titleSuffix;

    // Configure split-pane for Reading vs single column for Grammar/Listening
    const layout = $("arena-layout");
    const passagePane = $("passage-pane");
    if (section === "reading") {
      layout.classList.add("is-split");
      passagePane.hidden = false;
    } else {
      layout.classList.remove("is-split");
      passagePane.hidden = true;
    }

    renderQuestion();
  }

  // ==================== RENDER CURRENT QUESTION ====================
  function renderQuestion() {
    if (!session) return;
    stopSpeech();
    clearTimer();

    const q = session.questions[session.index];
    const total = session.questions.length;
    session.locked = false;
    session.questionStartTs = Date.now();

    // Update HUD
    $("hud-q-counter").textContent = `Soal ${session.index + 1} / ${total}`;
    $("quiz-progress-fill").style.width = `${(session.index / total) * 100}%`;
    updateHudMetrics();

    // Hide feedback banner
    const fb = $("feedback-banner");
    fb.hidden = true;
    fb.className = "feedback-banner";

    // Question Meta
    $("q-id-label").textContent = q.id;
    $("q-pattern-hint").textContent = session.section === "grammar"
      ? (q.subtype === "structure" ? "Fill in the blank" : "Temukan 1 bagian yang salah")
      : (session.section === "reading" ? "Reading Comprehension" : `Listening Part ${q.part}`);

    // Audio studio visibility
    const audioStudio = $("audio-studio");
    if (session.section === "listening") {
      audioStudio.hidden = false;
      setupListeningCard(q);
    } else {
      audioStudio.hidden = true;
    }

    // Reading passage pane update
    if (session.section === "reading") {
      renderReadingPassage(q.passageId, null);
    }

    // Render stem & instruction
    const badgeEl = $("q-subtype-badge");
    const instrEl = $("q-instruction");
    const stemEl = $("q-stem");

    if (session.section === "grammar") {
      if (q.subtype === "structure") {
        badgeEl.textContent = "Structure";
        instrEl.textContent = "Pilih kata atau frasa yang paling tepat melengkapi kalimat berikut:";
        stemEl.innerHTML = escapeHtml(q.prompt).replace(
          /_______/g,
          '<span class="blank-slot" id="blank-slot">_______</span>'
        );
      } else {
        badgeEl.textContent = "Error Recognition";
        instrEl.textContent = "Pilih SATU bagian bergaris bawah yang salah secara tata bahasa (format resmi EPrT LaC — urutan opsi diacak):";
        stemEl.innerHTML = renderWrittenExpressionMarkup(q);
      }
    } else if (session.section === "reading") {
      const pIdx = session.passageOrder.indexOf(q.passageId) + 1;
      const pTotal = session.passageOrder.length;
      badgeEl.textContent = q.paragraphRef
        ? `Teks ${pIdx}/${pTotal} · Paragraf ${q.paragraphRef}`
        : `Teks ${pIdx}/${pTotal} · Keseluruhan`;
      instrEl.textContent = "Baca teks di panel kiri lalu pilih jawaban terbaik:";
      stemEl.textContent = q.prompt;
    } else if (session.section === "listening") {
      badgeEl.textContent = `Part ${q.part}`;
      instrEl.textContent = "Dengarkan audio percakapan/kuliah, lalu jawab pertanyaan berikut:";
      stemEl.textContent = q.narratorQuestion;
    }

    // Render 4 Quizizz-Style Answer Tiles
    const grid = $("options-grid");
    const avgOptLen = q.options.reduce((acc, s) => acc + s.length, 0) / 4;
    if (avgOptLen > 34 || session.section === "reading" || session.section === "listening") {
      grid.classList.add("is-single-col");
    } else {
      grid.classList.remove("is-single-col");
    }

    grid.innerHTML = q.options
      .map(
        (opt, i) => `
      <button type="button" class="option-tile" data-idx="${i}">
        <span class="option-key">${LETTERS[i]}</span>
        <span class="option-text">${escapeHtml(opt)}</span>
        <span class="option-kbd">[${i + 1}]</span>
      </button>
    `
      )
      .join("");

    grid.querySelectorAll(".option-tile").forEach((btn) => {
      btn.addEventListener("click", () => handleAnswer(Number(btn.dataset.idx)));
    });

    // Start Timer
    startTimerForQuestion();
  }

  function renderWrittenExpressionMarkup(q) {
    const sentence = typeof q === "string" ? q : q.sentence;
    const order = (q && Array.isArray(q.optionOrder)) ? q.optionOrder : null;
    const escaped = escapeHtml(sentence);
    return escaped.replace(/\[([A-D]):([^\]]+)\]/g, (_, letter, text) => {
      const oldIdx = LETTERS.indexOf(letter);
      const mappedIdx = order ? order.indexOf(oldIdx) : oldIdx;
      return `<span class="we-span" data-we-idx="${mappedIdx}"><span class="we-text">${text}</span></span>`;
    });
  }

  function renderReadingPassage(passageId, highlightParaNum) {
    const p = DATA.reading.passages.find((item) => item.id === passageId);
    if (!p) return;

    if (session.lastPassageId !== passageId) {
      session.lastPassageId = passageId;
      $("passage-category").textContent = p.category;
      $("passage-title").textContent = p.title;
      const wc = p.paragraphs.join(" ").split(/\s+/).length;
      $("passage-wordcount").textContent = `${wc} kata`;
      const body = $("passage-body");
      body.innerHTML = p.paragraphs
        .map(
          (para, idx) =>
            `<p class="passage-para" data-para="${idx + 1}"><span class="para-num">¶${idx + 1}</span>${escapeHtml(para)}</p>`
        )
        .join("");
      body.scrollTop = 0;
    }

    // Highlight cited paragraph cleanly
    const paras = $("passage-body").querySelectorAll(".passage-para");
    paras.forEach((el) => {
      const isTarget = highlightParaNum !== null && Number(el.dataset.para) === highlightParaNum;
      el.classList.toggle("is-highlighted", isTarget);
      if (isTarget) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  // ==================== TIMER ENGINE ====================
  function startTimerForQuestion() {
    const timerBox = $("hud-timer-box");
    const timerRail = $("timer-rail");
    const timerFill = $("quiz-timer-fill");

    if (session.timerMode === "untimed") {
      timerBox.className = "hud-timer";
      $("hud-timer-text").textContent = "Bebas";
      timerRail.hidden = true;
      return;
    }

    timerRail.hidden = false;
    const meta = SECTION_META[session.section];

    if (session.timerMode === "blitz") {
      session.qSecondsInitial = meta.blitzSeconds;
      session.qSecondsRemaining = meta.blitzSeconds;
    }

    updateTimerDisplay();

    timerHandle = setInterval(() => {
      if (!session || session.locked) return;
      if (session.timerMode === "blitz") {
        session.qSecondsRemaining = Math.max(0, session.qSecondsRemaining - 1);
        updateTimerDisplay();
        if (session.qSecondsRemaining <= 0) {
          clearTimer();
          handleAnswer(-1); // Time up!
        }
      } else if (session.timerMode === "exam") {
        session.totalSecondsRemaining = Math.max(0, session.totalSecondsRemaining - 1);
        updateTimerDisplay();
        if (session.totalSecondsRemaining <= 0) {
          clearTimer();
          finishExamOnTimeout();
        }
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const timerBox = $("hud-timer-box");
    const timerText = $("hud-timer-text");
    const timerFill = $("quiz-timer-fill");

    const rem = session.timerMode === "blitz" ? session.qSecondsRemaining : session.totalSecondsRemaining;
    const initSec = session.timerMode === "blitz" ? session.qSecondsInitial : session.totalSecondsInitial;
    const ratio = initSec > 0 ? rem / initSec : 1;

    timerText.textContent = formatClock(rem);
    timerFill.style.width = `${(ratio * 100).toFixed(1)}%`;

    timerBox.classList.remove("is-warn", "is-danger");
    timerFill.classList.remove("is-warn", "is-danger");
    if (ratio <= 0.15 || rem <= 8) {
      timerBox.classList.add("is-danger");
      timerFill.classList.add("is-danger");
    } else if (ratio <= 0.35 || rem <= 15) {
      timerBox.classList.add("is-warn");
      timerFill.classList.add("is-warn");
    }
  }

  function clearTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function finishExamOnTimeout() {
    // Mark remaining unanswered items as timeout (-1) and open score report
    while (session.index < session.questions.length) {
      const q = session.questions[session.index];
      const already = session.answers.find((a) => a.id === q.id);
      if (!already) {
        session.answers.push({
          id: q.id,
          chosen: -1,
          correct: q.correct,
          isRight: false,
          timeSpent: 0,
          pattern: q.pattern
        });
      }
      session.index++;
    }
    finishSession();
  }

  // ==================== ANSWER HANDLING & INSTANT FEEDBACK ====================
  function handleAnswer(chosenIdx) {
    if (!session || session.locked) return;
    session.locked = true;
    if (session.timerMode === "blitz") clearTimer();

    const q = session.questions[session.index];
    const isRight = chosenIdx === q.correct;
    const elapsed = Math.max(1, Math.round((Date.now() - session.questionStartTs) / 1000));

    if (isRight) {
      session.streak += 1;
      if (session.streak > session.bestStreak) session.bestStreak = session.streak;
    } else {
      session.streak = 0;
    }

    session.answers.push({
      id: q.id,
      chosen: chosenIdx,
      correct: q.correct,
      isRight,
      timeSpent: elapsed,
      pattern: q.pattern
    });

    markQuestionSeen(session.section, q.id);
    saveStore(true);

    updateHudMetrics();

    // Update option tiles visual states
    const tiles = $("options-grid").querySelectorAll(".option-tile");
    tiles.forEach((tile) => {
      const idx = Number(tile.dataset.idx);
      tile.disabled = true;
      if (idx === q.correct) {
        tile.classList.add("is-correct");
      } else if (idx === chosenIdx && !isRight) {
        tile.classList.add("is-wrong");
      } else {
        tile.classList.add("is-dimmed");
      }
    });

    // Grammar visual enrichment on answer
    if (session.section === "grammar") {
      if (q.subtype === "structure") {
        const slot = $("blank-slot");
        if (slot) {
          slot.textContent = q.options[q.correct];
          slot.classList.add("is-filled");
        }
      } else {
        const spans = $("q-stem").querySelectorAll(".we-span");
        spans.forEach((sp) => {
          const idx = Number(sp.dataset.weIdx);
          if (idx === q.correct) {
            sp.classList.add("is-error-revealed");
            const fix = document.createElement("span");
            fix.className = "we-fix-chip";
            fix.textContent = `→ ${q.correction}`;
            sp.after(fix);
          } else {
            sp.classList.add("is-ok-revealed");
          }
        });
      }
    }

    // Highlight relevant Reading paragraph on answer
    if (session.section === "reading" && q.paragraphRef) {
      renderReadingPassage(q.passageId, q.paragraphRef);
    }

    // Auto-reveal Listening script on answer so student can review traps immediately!
    if (session.section === "listening") {
      setScriptVisible(true);
    }

    // Populate & show Feedback Banner
    const fb = $("feedback-banner");
    fb.hidden = false;
    fb.className = `feedback-banner ${isRight ? "is-correct" : "is-wrong"}`;

    $("feedback-status").textContent =
      chosenIdx === -1 ? "Waktu habis" : isRight ? "Jawaban benar" : "Belum tepat";
    $("feedback-pattern").textContent = q.pattern;
    $("feedback-text").textContent = q.explanation;

    const corrBadge = $("feedback-correction");
    if (q.correction) {
      corrBadge.hidden = false;
      corrBadge.textContent = `Perbaikan: ${q.options[q.correct]} → ${q.correction}`;
    } else {
      corrBadge.hidden = true;
    }

    const isLast = session.index === session.questions.length - 1;
    $("btn-next-label").textContent = isLast ? "Lihat Laporan Skor EPrT" : "Soal Berikutnya";
    $("btn-next-q").focus();
  }

  function nextQuestion() {
    if (!session || !session.locked) return;
    if (session.index < session.questions.length - 1) {
      session.index += 1;
      renderQuestion();
    } else {
      finishSession();
    }
  }

  function updateHudMetrics() {
    const answered = session.answers.length;
    const right = session.answers.filter((a) => a.isRight).length;
    const pct = answered > 0 ? Math.round((right / answered) * 100) : 0;

    $("hud-streak").textContent = session.streak;
    $("hud-streak-pill").classList.toggle("is-hot", session.streak >= 2);
    $("hud-accuracy-text").textContent = `${pct}%`;

    const circ = 2 * Math.PI * 14; // 87.96
    $("hud-ring-fill").style.strokeDashoffset = (circ * (1 - pct / 100)).toFixed(2);
  }

  // ==================== WEB SPEECH API AUDIO PLAYER (LISTENING) ====================
  function initVoices() {
    if (!("speechSynthesis" in window)) return;
    const load = () => {
      availableVoices = window.speechSynthesis.getVoices() || [];
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }

  function pickVoice(speaker) {
    if (!availableVoices.length) {
      availableVoices = ("speechSynthesis" in window && window.speechSynthesis.getVoices()) || [];
    }
    const enVoices = availableVoices.filter((v) => /^en(-|_)/i.test(v.lang));
    if (!enVoices.length) return null;

    const lower = (v) => `${v.name} ${v.voiceURI}`.toLowerCase();
    const femaleHints = ["zira", "samantha", "jenny", "aria", "susan", "victoria", "female", "google us english"];
    const maleHints = ["david", "mark", "guy", "daniel", "alex", "george", "male", "google uk english male"];

    if (speaker === "Woman") {
      return enVoices.find((v) => femaleHints.some((h) => lower(v).includes(h))) || enVoices[0];
    }
    if (speaker === "Man") {
      return enVoices.find((v) => maleHints.some((h) => lower(v).includes(h))) || enVoices[Math.min(1, enVoices.length - 1)];
    }
    return enVoices.find((v) => lower(v).includes("en-us") || lower(v).includes("united states")) || enVoices[0];
  }

  function getListeningScript(q) {
    if (q.script) return q.script;
    const grp = DATA.listening.groups[q.groupId];
    return grp ? grp.script : [];
  }

  function setupListeningCard(q) {
    const script = getListeningScript(q);
    const isSharedGroup = q.part === "B" || q.part === "C";
    const sameGroupAsPrev = isSharedGroup && session.lastListeningGroupId === q.groupId;
    session.lastListeningGroupId = q.groupId;

    $("audio-part-label").textContent = q.groupTitle;
    $("btn-audio-qonly").hidden = !isSharedGroup;

    // Render script box (hidden by default so user truly practices listening!)
    const scriptBox = $("script-box");
    const scriptHtml = script
      .map(
        (t) =>
          `<p class="script-line"><span class="script-speaker">${escapeHtml(t.speaker)}:</span>${escapeHtml(t.text)}</p>`
      )
      .join("");
    scriptBox.innerHTML =
      scriptHtml +
      `<p class="script-line"><span class="script-speaker">Narrator:</span>${escapeHtml(q.narratorQuestion)}</p>`;
    setScriptVisible(false);

    if (!("speechSynthesis" in window)) {
      $("audio-status-line").textContent =
        "Browser ini tidak mendukung Web Speech API. Gunakan tombol Tampilkan Script untuk latihan.";
      return;
    }

    $("audio-status-line").textContent = sameGroupAsPrev
      ? "Audio dialog/kuliah sama dengan soal sebelumnya — klik Pertanyaan Saja atau Ulangi untuk mendengar ulang seluruh audio."
      : "Klik Putar Audio atau tekan Space untuk mendengarkan percakapan.";
    setPlayUiState(false, null);
  }

  function setScriptVisible(visible) {
    $("script-box").hidden = !visible;
    $("script-toggle-label").textContent = visible ? "Sembunyikan Script" : "Tampilkan Script";
  }

  function playListeningAudio(questionOnly) {
    if (!session || session.section !== "listening") return;
    if (!("speechSynthesis" in window)) return;

    const q = session.questions[session.index];

    // If paused and clicking Play (not questionOnly), resume
    if (!questionOnly && speechPaused && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      speechPaused = false;
      speechPlaying = true;
      setPlayUiState(true, speechQueue[speechIndex]?.speaker || null);
      return;
    }

    // If currently playing and clicking Play button -> Pause
    if (!questionOnly && speechPlaying && !speechPaused) {
      window.speechSynthesis.pause();
      speechPaused = true;
      setPlayUiState(false, null, true);
      return;
    }

    // Fresh start (defer 60ms after cancel() to avoid Chromium speechSynthesis silent-drop bug)
    stopSpeech();
    const turns = questionOnly ? [] : getListeningScript(q).slice();
    turns.push({ speaker: "Narrator", text: q.narratorQuestion });

    speechQueue = turns;
    speechIndex = 0;
    speechPlaying = true;
    speechPaused = false;
    setTimeout(() => {
      if (speechPlaying) speakNextTurn();
    }, 60);
  }

  function speakNextTurn() {
    if (!speechPlaying || speechIndex >= speechQueue.length) {
      speechPlaying = false;
      speechPaused = false;
      setPlayUiState(false, null);
      $("audio-status-line").textContent = "Audio selesai diputar. Pilih jawaban atau klik Ulangi.";
      return;
    }

    const turn = speechQueue[speechIndex];
    const utter = new SpeechSynthesisUtterance(turn.text);
    const voice = pickVoice(turn.speaker);
    if (voice) utter.voice = voice;
    utter.lang = "en-US";
    utter.rate = speechRate;
    utter.pitch = turn.speaker === "Man" ? 0.86 : turn.speaker === "Woman" ? 1.14 : 1.0;

    utter.onstart = () => {
      setPlayUiState(true, turn.speaker);
      $("audio-status-line").textContent = `Sedang berbicara: ${turn.speaker} (${speechIndex + 1}/${speechQueue.length})`;
    };

    utter.onend = () => {
      if (!speechPlaying) return;
      speechIndex += 1;
      setTimeout(speakNextTurn, 260);
    };

    utter.onerror = () => {
      speechPlaying = false;
      speechPaused = false;
      setPlayUiState(false, null);
    };

    window.speechSynthesis.speak(utter);
  }

  function stopSpeech() {
    speechPlaying = false;
    speechPaused = false;
    speechQueue = [];
    speechIndex = 0;
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
    }
    setPlayUiState(false, null);
  }

  function setPlayUiState(isPlaying, activeSpeaker, isPaused) {
    const label = $("audio-play-label");
    if (label) {
      label.textContent = isPlaying ? "Jeda" : isPaused ? "Lanjutkan" : "Putar Audio";
    }
    const wf = $("audio-waveform");
    if (wf) wf.classList.toggle("is-playing", Boolean(isPlaying));

    const pills = $("speaker-pills");
    if (pills) {
      pills.querySelectorAll(".speaker-pill").forEach((el) => {
        el.classList.toggle("is-speaking", isPlaying && el.dataset.speaker === activeSpeaker);
      });
    }
  }

  // ==================== FINISH SESSION & EPrT SCORE REPORT ====================
  function finishSession() {
    clearTimer();
    stopSpeech();

    const sec = session.section;
    const total = session.questions.length;
    const correctCount = session.answers.filter((a) => a.isRight).length;
    const wrongCount = total - correctCount;
    const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const totalTime = session.answers.reduce((acc, a) => acc + a.timeSpent, 0);
    const avgTime = total > 0 ? Math.round(totalTime / total) : 0;
    const scaled = interpolateScale(sec, correctCount, total);
    const missedIds = session.answers.filter((a) => !a.isRight).map((a) => a.id);

    // Save to localStorage (only overwrite full-section scaled score when not a tiny missed-only drill,
    // OR if no previous record exists; always update missedIds so user sees remaining weak items!)
    const prev = store.sections[sec];
    if (!session.isRetryMissed || !prev) {
      store.sections[sec] = {
        latestScaled: scaled,
        bestScaled: prev ? Math.max(prev.bestScaled || 0, scaled) : scaled,
        lastCorrect: correctCount,
        lastTotal: total,
        lastPct: pct,
        bestStreak: prev ? Math.max(prev.bestStreak || 0, session.bestStreak) : session.bestStreak,
        missedIds,
        updatedAt: new Date().toISOString()
      };
    } else {
      // Missed-only retry: update remaining missedIds cleanly
      store.sections[sec] = {
        ...prev,
        missedIds,
        updatedAt: new Date().toISOString()
      };
    }
    saveStore();

    renderReport({
      sec,
      total,
      correctCount,
      wrongCount,
      pct,
      avgTime,
      scaled,
      missedIds,
      isRetryMissed: session.isRetryMissed
    });
    renderDashboard();
    showView("report");
  }

  function renderReport(res) {
    const meta = SECTION_META[res.sec];
    $("report-eyebrow").textContent = res.isRetryMissed
      ? "Sesi Pengulangan Soal Salah"
      : "Laporan Hasil Simulasi EPrT";
    $("report-title").textContent = `${meta.name} Selesai`;

    // Retry missed button
    const retryBtn = $("btn-retry-missed");
    if (res.missedIds.length > 0) {
      retryBtn.hidden = false;
      $("retry-missed-count").textContent = res.missedIds.length;
    } else {
      retryBtn.hidden = true;
    }

    // Ring & raw stats
    $("report-pct").textContent = `${res.pct}%`;
    $("report-raw").textContent = `${res.correctCount} / ${res.total}`;
    $("report-streak").textContent = session.bestStreak;
    $("report-avg-time").textContent = `${res.avgTime} dtk`;
    $("report-wrong").textContent = res.wrongCount;

    const circ = 2 * Math.PI * 50; // 314.16
    const ringFill = $("report-ring-fill");
    ringFill.style.strokeDashoffset = (circ * (1 - res.pct / 100)).toFixed(2);
    ringFill.style.stroke = res.pct >= 80 ? "var(--emerald)" : res.pct >= 60 ? "var(--amber)" : "var(--coral)";

    // Section Scaled Score
    $("report-scaled").textContent = res.scaled;
    const secDelta = res.scaled - meta.baseline;
    const secSign = secDelta >= 0 ? `+${secDelta}` : `${secDelta}`;
    $("report-section-delta").textContent = `${secSign} poin dibanding baseline 2023 (${meta.baseline})`;
    $("report-section-note").textContent =
      res.scaled >= 58
        ? "Performa melampaui target B2 kuat. Pertahankan ritme dan periksa sisa pola yang masih meleset."
        : res.scaled >= 52
        ? "Sudah di jalur aman B2. Fokuskan review NotebookLM pada pola merah di bawah untuk tembus 58+."
        : "Perlu penguatan cepat pada pola dasar. Klik Ulangi Soal Salah Saja sampai akurasi minimal 85%.";

    // Combined EPrT Projection
    const proj = getProjectedSections();
    // If this was a retry-missed session, compute live projection using stored latestScaled
    $("report-combined-total").textContent = proj.total;
    $("report-cefr").textContent = proj.cefr;
    const cDelta = $("report-combined-delta");
    cDelta.className = "delta-pill";
    if (proj.delta > 0) {
      cDelta.textContent = `+${proj.delta} vs 527`;
      cDelta.classList.add("is-up");
    } else if (proj.delta < 0) {
      cDelta.textContent = `${proj.delta} vs 527`;
      cDelta.classList.add("is-down");
    } else {
      cDelta.textContent = "Sama dgn 527";
    }

    $("report-combined-breakdown").innerHTML = [
      ["Listening", proj.sections.listening],
      ["Grammar", proj.sections.grammar],
      ["Reading", proj.sections.reading]
    ]
      .map(
        ([label, info]) => `
        <div class="comb-pill ${info.isLive ? "is-live" : ""}">
          <span>${label}</span>
          <strong>${info.score}</strong>
          <span>${info.isLive ? "Simulasi" : "2023"}</span>
        </div>
      `
      )
      .join("");

    // Weak Pattern Breakdown (sorted worst accuracy first!)
    const patMap = {};
    session.answers.forEach((a) => {
      if (!patMap[a.pattern]) patMap[a.pattern] = { name: a.pattern, right: 0, total: 0 };
      patMap[a.pattern].total += 1;
      if (a.isRight) patMap[a.pattern].right += 1;
    });
    const patterns = Object.values(patMap).sort((a, b) => {
      const ra = a.right / a.total;
      const rb = b.right / b.total;
      if (ra !== rb) return ra - rb;
      return b.total - a.total;
    });

    $("report-pattern-list").innerHTML = patterns
      .map((p) => {
        const ratio = Math.round((p.right / p.total) * 100);
        const cls = ratio < 60 ? "is-weak" : ratio < 100 ? "is-mid" : "";
        return `
          <div class="pattern-row">
            <div class="pattern-row-top">
              <span class="pattern-name">${escapeHtml(p.name)}</span>
              <span class="pattern-stat">${p.right}/${p.total} benar (${ratio}%)</span>
            </div>
            <div class="pattern-bar-track">
              <div class="pattern-bar-fill ${cls}" style="width: ${ratio}%"></div>
            </div>
          </div>
        `;
      })
      .join("");

    // Default review filter: "wrong" if any wrong exist, otherwise "all"
    const defaultFilter = res.wrongCount > 0 ? "wrong" : "all";
    document.querySelectorAll(".filter-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.reviewFilter === defaultFilter);
    });
    renderReviewList(defaultFilter);
  }

  function renderReviewList(filter) {
    const list = $("report-review-list");
    const items = session.answers
      .map((ans, idx) => ({ ans, q: session.questions[idx], num: idx + 1 }))
      .filter((entry) => (filter === "wrong" ? !entry.ans.isRight : true));

    if (!items.length) {
      list.innerHTML = '<p class="muted-note">Tidak ada soal salah pada sesi ini. Semua jawaban benar.</p>';
      return;
    }

    list.innerHTML = items
      .map(({ ans, q, num }) => {
        const stemText =
          q.subtype === "written_expression"
            ? q.sentence.replace(/\[[A-D]:([^\]]+)\]/g, "[$1]")
            : q.prompt || q.narratorQuestion;
        const yourLabel =
          ans.chosen === -1
            ? "Waktu habis"
            : `${LETTERS[ans.chosen]}. ${q.options[ans.chosen]}`;
        const rightLabel = `${LETTERS[q.correct]}. ${q.options[q.correct]}${q.correction ? ` (→ ${q.correction})` : ""}`;

        return `
          <div class="review-item ${ans.isRight ? "" : "is-wrong"}">
            <div class="review-item-head">
              <strong class="tabular">#${num} · ${q.id}</strong>
              <span>${escapeHtml(q.pattern)}</span>
            </div>
            <p class="review-q">${escapeHtml(stemText)}</p>
            <div class="review-answers">
              ${
                ans.isRight
                  ? `<span class="ans-badge-right">Jawabanmu benar: ${escapeHtml(rightLabel)}</span>`
                  : `<span class="ans-badge-wrong">Jawabanmu: ${escapeHtml(yourLabel)}</span>
                     <span class="ans-badge-right">Kunci: ${escapeHtml(rightLabel)}</span>`
              }
            </div>
            <p class="review-expl">${escapeHtml(q.explanation)}</p>
          </div>
        `;
      })
      .join("");
  }

  // ==================== EVENT BINDING ====================
  function bindGlobalEvents() {
    // Theme toggle
    $("btn-theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(cur === "dark" ? "light" : "dark");
    });

    // Brand home button
    $("btn-brand-home").addEventListener("click", () => {
      if (!views.quiz.hidden && session && session.answers.length > 0 && session.answers.length < session.questions.length) {
        if (!confirm("Keluar dari sesi kuis yang sedang berjalan? Progres soal pada sesi ini belum disimpan.")) return;
      }
      renderDashboard();
      showView("home");
    });

    // Reset progress (full reset: scores + missedIds + seenIds)
    $("btn-reset-progress").addEventListener("click", () => {
      if (!confirm("Hapus semua skor latihan, riwayat bank soal, dan daftar soal salah yang tersimpan di browser ini?")) return;
      store = createEmptyStore();
      saveStore();
      renderDashboard();
      if (!views.quiz.hidden) showView("home");
    });

    // Reset seen bank history independently (keeps scores & missedIds!)
    $("btn-reset-bank").addEventListener("click", () => {
      if (!confirm("Reset riwayat soal yang sudah pernah dikerjakan? Skor simulasi tetap disimpan, dan semua soal kembali tersedia sebagai soal baru.")) return;
      store.seenIds = { grammar: [], reading: [], listening: [] };
      saveStore();
      renderDashboard();
    });

    // Session size segmented controls on Home (Standard vs Marathon)
    document.querySelectorAll(".seg-btn[data-size-section]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = btn.dataset.sizeSection;
        const size = btn.dataset.size;
        sessionSizePrefs[sec] = size;
        document.querySelectorAll(`.seg-btn[data-size-section="${sec}"]`).forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
      });
    });

    // Timer mode segmented controls on Home
    document.querySelectorAll(".seg-btn[data-section]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = btn.dataset.section;
        const mode = btn.dataset.timer;
        timerPrefs[sec] = mode;
        document.querySelectorAll(`.seg-btn[data-section="${sec}"]`).forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
      });
    });

    // Start buttons on Home
    document.querySelectorAll("[data-start]").forEach((btn) => {
      btn.addEventListener("click", () => startQuiz(btn.dataset.start, null));
    });

    // Retry missed buttons on Home
    document.querySelectorAll("[data-retry-missed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = btn.dataset.retryMissed;
        const missed = store.sections[sec]?.missedIds || [];
        startQuiz(sec, missed);
      });
    });

    // Quiz exit & next
    $("btn-quiz-exit").addEventListener("click", () => {
      if (session && session.answers.length > 0 && session.answers.length < session.questions.length) {
        if (!confirm("Keluar dari sesi kuis ini?")) return;
      }
      renderDashboard();
      showView("home");
    });

    $("btn-next-q").addEventListener("click", nextQuestion);

    // Reading font size buttons
    $("btn-font-dec").addEventListener("click", () => {
      passageFontSize = Math.max(13, passageFontSize - 1);
      $("passage-body").style.setProperty("--passage-fs", `${passageFontSize}px`);
    });
    $("btn-font-inc").addEventListener("click", () => {
      passageFontSize = Math.min(21, passageFontSize + 1);
      $("passage-body").style.setProperty("--passage-fs", `${passageFontSize}px`);
    });

    // Listening audio controls
    $("btn-audio-play").addEventListener("click", () => playListeningAudio(false));
    $("btn-audio-replay").addEventListener("click", () => {
      stopSpeech();
      playListeningAudio(false);
    });
    $("btn-audio-qonly").addEventListener("click", () => playListeningAudio(true));
    $("btn-toggle-script").addEventListener("click", () => {
      setScriptVisible($("script-box").hidden);
    });
    document.querySelectorAll(".speed-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        speechRate = Number(btn.dataset.rate);
        document.querySelectorAll(".speed-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });

    // Report actions
    $("btn-retry-missed").addEventListener("click", () => {
      if (!session) return;
      const missed = session.answers.filter((a) => !a.isRight).map((a) => a.id);
      startQuiz(session.section, missed);
    });
    $("btn-retry-all").addEventListener("click", () => {
      if (!session) return;
      startQuiz(session.section, null);
    });
    $("btn-report-home").addEventListener("click", () => {
      renderDashboard();
      showView("home");
    });

    document.querySelectorAll(".filter-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".filter-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
        renderReviewList(tab.dataset.reviewFilter);
      });
    });

    // Keyboard shortcuts (1/2/3/4, A/B/C/D, Enter, Space)
    document.addEventListener("keydown", (e) => {
      if (views.quiz.hidden || !session) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (!session.locked) {
        if (k === "1" || k === "a") { e.preventDefault(); handleAnswer(0); return; }
        if (k === "2" || k === "b") { e.preventDefault(); handleAnswer(1); return; }
        if (k === "3" || k === "c") { e.preventDefault(); handleAnswer(2); return; }
        if (k === "4" || k === "d") { e.preventDefault(); handleAnswer(3); return; }
      } else if (e.key === "Enter") {
        e.preventDefault();
        nextQuestion();
        return;
      }

      if (e.code === "Space" && session.section === "listening") {
        const tag = document.activeElement?.tagName;
        if (tag !== "BUTTON") {
          e.preventDefault();
          playListeningAudio(false);
        }
      }
    });
  }

  // ==================== UTILITIES ====================
  function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  init();
})();
