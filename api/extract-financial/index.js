// api/extract-financial/index.js
module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    const body = req.body || {};
    const normalized = body.normalized;
    const normalizedPrev = body.normalizedPrev || null;

    const compareRaw = body.compare ?? null;
    const compareStr =
      compareRaw === null || compareRaw === undefined
        ? ""
        : String(compareRaw).toLowerCase().trim();

    const noCompare =
      compareStr === "" ||
      compareStr.includes("بدون") ||
      compareStr === "none" ||
      compareStr === "no" ||
      compareStr === "no_compare" ||
      compareStr === "no-compare";

    const usingTwoFiles = Boolean(normalizedPrev) && !noCompare;

    const diag =
      String(req.query?.diag || body.diag || "").toLowerCase() === "1" ||
      String(req.query?.diag || body.diag || "").toLowerCase() === "true";

    const target = String(req.query?.target || body.target || "").toLowerCase();

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    const tablesPreview = Array.isArray(normalized.tablesPreview) ? normalized.tablesPreview : [];
    const pagesMeta = normalized?.meta || null;

    const tablesPreviewPrev = usingTwoFiles
      ? Array.isArray(normalizedPrev.tablesPreview)
        ? normalizedPrev.tablesPreview
        : []
      : [];

    /* =========================
       Helpers
       ========================= */

    const toLatinDigits = (s) => {
      const map = {
        "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
        "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
        "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
        "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
      };
      return String(s || "").replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
    };

    const normalizeSeparators = (s) => {
      return String(s || "")
        .replace(/٫/g, ".")
        .replace(/[٬،]/g, ",");
    };

    // Arabic text normalization (very important for matching)
    const normalizeArabicText = (s) => {
      let x = String(s || "");

      // remove tatweel & diacritics
      x = x.replace(/ـ/g, "");
      x = x.replace(/[\u064B-\u065F\u0670]/g, "");

      // normalize alef forms
      x = x.replace(/[أإآٱ]/g, "ا");

      // normalize ya/ya maksura
      x = x.replace(/[ى]/g, "ي");

      // normalize taa marbuta
      x = x.replace(/[ة]/g, "ه");

      // normalize hamza on waw/ya
      x = x.replace(/[ؤ]/g, "و").replace(/[ئ]/g, "ي");

      // collapse spaces
      x = x.replace(/\s+/g, " ").trim();

      return x;
    };

    const norm = (s) =>
      normalizeArabicText(
        toLatinDigits(normalizeSeparators(String(s || "")))
      )
        .toLowerCase()
        .trim();

    const isMostlyNumberLike = (t) => {
      const s = norm(t);
      if (!s) return true;
      // numbers, punctuation, parentheses, commas, dots, plus/minus
      return /^[\d\s,().+\-/%]+$/.test(s);
    };

    const parseNumberSmart = (raw) => {
      if (raw === null || raw === undefined) return null;

      let s = toLatinDigits(normalizeSeparators(String(raw))).trim();
      if (!s) return null;

      let neg = false;
      if (s.includes("(") && s.includes(")")) {
        neg = true;
        s = s.replace(/[()]/g, "");
      }

      s = s.replace(/[^\d.,\-+]/g, "");
      s = s.replace(/(?!^)[\-+]/g, "");

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      const isGroupedThousands = (x) => /^\d{1,3}([.,]\d{3})+$/.test(x);

      if (isGroupedThousands(s)) {
        const n = Number(s.replace(/[.,]/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (hasDot && hasComma) {
        const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
        const tail = s.slice(lastSep + 1);

        if (/^\d{3}$/.test(tail)) {
          const n = Number(s.replace(/[.,]/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }

        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
          const parts = s.split(",");
          const dec = parts.pop();
          const intPart = parts.join("").replace(/\./g, "");
          const n = Number(intPart + "." + dec);
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        } else {
          const parts = s.split(".");
          const dec = parts.pop();
          const intPart = parts.join("").replace(/,/g, "");
          const n = Number(intPart + "." + dec);
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
      }

      if (!hasDot && hasComma) {
        if (/^\d{1,3}(,\d{3})+$/.test(s)) {
          const n = Number(s.replace(/,/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
        const n = Number(s.replace(",", "."));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (hasDot && !hasComma) {
        if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
          const n = Number(s.replace(/\./g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
        const n = Number(s);
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      const n = Number(s);
      return Number.isFinite(n) ? (neg ? -n : n) : null;
    };

    const findYear = (text) => {
      const s = norm(text);
      const m = s.match(/\b(20\d{2})\b/);
      if (!m) return null;
      const y = Number(m[1]);
      return y >= 2000 && y <= 2100 ? y : null;
    };

    const headerRowLimit = 5;
    const detectColumns = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const colCount = Number(table?.columnCount || 0);

      const cols = Array.from({ length: colCount }, (_, i) => ({
        col: i,
        years: [],
        hasThreeMonths: false,
        hasNineMonths: false,
        hasAnnual: false,
        hasNote: false,
        headerText: "",
      }));

      const topRows = rows.slice(0, headerRowLimit);

      for (const r of topRows) {
        for (let c = 0; c < colCount; c++) {
          const cell = r?.[c];
          const t = norm(cell);
          if (!t) continue;

          cols[c].headerText += " " + t;

          const y = findYear(t);
          if (y) cols[c].years.push(y);

          if (t.includes("الثلاثه") && t.includes("اشهر")) cols[c].hasThreeMonths = true;
          if (t.includes("التسعه") && t.includes("اشهر")) cols[c].hasNineMonths = true;

          if (t.includes("ديسمبر") || t.includes("السنه") || t.includes("منتهيه")) cols[c].hasAnnual = true;

          if (t.includes("ايضاح") || t === "ايضاح") cols[c].hasNote = true;
        }
      }

      for (const c of cols) {
        c.years = Array.from(new Set(c.years)).sort((a, b) => a - b);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {
      const candidates = cols.filter((c) => !c.hasNote);

      const withYears = candidates
        .map((c) => ({
          ...c,
          latestYear: c.years.length ? c.years[c.years.length - 1] : null,
          periodScore: c.hasThreeMonths ? 3 : c.hasNineMonths ? 2 : c.hasAnnual ? 1 : 0,
        }))
        .filter((c) => c.latestYear);

      if (!withYears.length) return { latest: null, previous: null, debug: { reason: "no years detected" } };

      const maxYear = Math.max(...withYears.map((c) => c.latestYear));

      const latestCandidates = withYears
        .filter((c) => c.latestYear === maxYear)
        .sort((a, b) => {
          if (b.periodScore !== a.periodScore) return b.periodScore - a.periodScore;
          return b.col - a.col;
        });

      const latest = latestCandidates[0];

      const yearsAll = Array.from(new Set(withYears.map((c) => c.latestYear))).sort((a, b) => a - b);
      const prevYear = yearsAll.length >= 2 ? yearsAll[yearsAll.length - 2] : null;

      let previous = null;
      if (prevYear) {
        const prevCandidates = withYears
          .filter((c) => c.latestYear === prevYear)
          .sort((a, b) => {
            if (b.periodScore !== a.periodScore) return b.periodScore - a.periodScore;
            return b.col - a.col;
          });
        previous = prevCandidates[0] || null;
      }

      return { latest, previous, debug: { maxYear, prevYear, yearsAll } };
    };

    /* =========================
       Robust row label detection (works for BOTH income & balance)
       ========================= */

    const getRowLabel = (row) => {
      if (!Array.isArray(row)) return "";

      let best = "";
      let bestScore = -1;

      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        if (!cell) continue;

        const raw = String(cell).trim();
        if (!raw) continue;

        const t = norm(raw);
        if (!t) continue;

        // skip typical header-like cells
        if (t.includes("ديسمبر") || t.includes("السنه") || t.includes("منتهيه")) continue;
        if (t === "ايضاح" || t.includes("ايضاح")) continue;

        // skip number-like
        if (isMostlyNumberLike(t)) continue;

        // prefer cells with more letters
        const letters = t.replace(/[^a-z\u0600-\u06ff]/g, ""); // latin + arabic letters
        const score = letters.length * 10 + t.length;

        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }

      // fallback: try last then first non-empty
      if (!best) {
        const last = row[row.length - 1];
        if (last && !isMostlyNumberLike(last)) return norm(last);
        const first = row[0];
        if (first && !isMostlyNumberLike(first)) return norm(first);
      }

      return best || "";
    };

    const bestMatchRow = (rows, names, opts = {}) => {
      const mustInclude = (opts.mustInclude || []).map(norm);
      const mustNotInclude = (opts.mustNotInclude || []).map(norm);

      let best = null;

      for (const r of rows || []) {
        if (!Array.isArray(r)) continue;
        const label = getRowLabel(r);
        if (!label) continue;

        const ln = norm(label);

        // must include terms
        if (mustInclude.length && !mustInclude.every((k) => ln.includes(k))) continue;

        // must not include terms
        if (mustNotInclude.length && mustNotInclude.some((k) => ln.includes(k))) continue;

        // base match: any of names
        let hit = false;
        let hitStrength = 0;

        for (const n of names) {
          const nn = norm(n);
          if (nn && ln.includes(nn)) {
            hit = true;
            // prefer longer/more specific matches
            hitStrength = Math.max(hitStrength, nn.length);
          }
        }
        if (!hit) continue;

        const hasTotalWord =
          ln.includes(norm("اجمالي")) || ln.includes(norm("اجمالى")) || ln.includes("total");

        // scoring: prefer "إجمالي" for total fields, and more specific match
        const score = (hasTotalWord ? 200 : 0) + hitStrength;

        if (!best || score > best.score) {
          best = { row: r, label, score };
        }
      }

      return best ? { row: best.row, label: best.label } : null;
    };

    /* =========================
       INCOME
       ========================= */

    const scoreIncomeTable = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const joined = norm(rows.map((r) => (Array.isArray(r) ? r.join(" ") : "")).join("\n"));

      const hits = [
        "الايرادات", "تكلفه الايرادات", "مجمل الربح",
        "الربح التشغيلي", "صافي الربح",
        "قائمه الدخل", "قائمه الربح والخساره",
        "لفتره", "الثلاثه اشهر", "التسعه اشهر",
      ];

      let score = 0;
      for (const k of hits) if (joined.includes(norm(k))) score += 2;

      if (joined.includes("ايضاح")) score += 1;

      const cc = Number(table?.columnCount || 0);
      if (cc >= 5) score += 1;

      return score;
    };

    const wantIncome = [
      { key: "revenue", names: ["الإيرادات", "الايرادات", "المبيعات", "Revenue"] },
      { key: "costOfRevenue", names: ["تكلفة الإيرادات", "تكلفة الايرادات", "تكلفة المبيعات", "Cost of revenue"] },
      { key: "grossProfit", names: ["مجمل الربح", "Gross profit"] },
      { key: "operatingProfit", names: ["الربح التشغيلي", "Operating profit", "الربح من العمليات"] },
      { key: "netProfitBeforeZakat", names: ["صافي ربح الفترة قبل الزكاة", "صافي ربح السنة قبل الزكاة"] },
      { key: "zakat", names: ["الزكاة"] },
      { key: "netProfit", names: ["صافي ربح الفترة", "صافي ربح السنة", "صافي الربح", "Net profit"] },
    ];

    const extractIncomeSingleTable = (table, latestColIdx, prevColIdx) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const out = {};

      for (const item of wantIncome) {
        const hit = bestMatchRow(rows, item.names);
        if (!hit) {
          out[item.key] = null;
          continue;
        }
        const cur = latestColIdx != null ? parseNumberSmart(hit.row?.[latestColIdx]) : null;
        const prev = prevColIdx != null ? parseNumberSmart(hit.row?.[prevColIdx]) : null;
        out[item.key] = { label: hit.label, current: cur, previous: prev };
      }

      return out;
    };

    const extractIncomeTwoFiles = (tableA, colA, tableB, colB) => {
      const rowsA = Array.isArray(tableA?.sample) ? tableA.sample : [];
      const rowsB = Array.isArray(tableB?.sample) ? tableB.sample : [];
      const out = {};

      for (const item of wantIncome) {
        const hitA = bestMatchRow(rowsA, item.names);
        const hitB = bestMatchRow(rowsB, item.names);

        const cur = hitA && colA != null ? parseNumberSmart(hitA.row?.[colA]) : null;
        const prev = hitB && colB != null ? parseNumberSmart(hitB.row?.[colB]) : null;

        out[item.key] = {
          label: hitA?.label || hitB?.label || null,
          current: cur,
          previous: prev,
        };
      }

      return out;
    };

    /* =========================
       BALANCE SHEET
       - Pick best table(s)
       - Extract from best source per metric
       ========================= */

    const scoreBalanceTable = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const joined = norm(rows.map((r) => (Array.isArray(r) ? r.join(" ") : "")).join("\n"));

      const strong = [
        "قائمة المركز المالي",
        "الميزانية",
        "الميزانية العمومية",
        "قائمة الوضع المالي",
        "balance sheet",
        "statement of financial position",
      ];

      const support = [
        "الموجودات", "الاصول",
        "المطلوبات", "الالتزامات", "الخصوم",
        "حقوق الملكية", "حقوق المساهمين",
        "اجمالي الموجودات", "اجمالي الاصول", "total assets",
        "اجمالي المطلوبات", "اجمالي الالتزامات", "total liabilities",
        "اجمالي حقوق الملكية", "total equity",
        "حقوق الملكية والمطلوبات",
      ];

      let score = 0;
      for (const k of strong) if (joined.includes(norm(k))) score += 40;
      for (const k of support) if (joined.includes(norm(k))) score += 8;

      if (joined.includes(norm("متداولة")) && joined.includes(norm("غير متداولة"))) score += 10;

      return score;
    };

    // IMPORTANT: disambiguation rules to prevent picking subtotal as total
    const wantBalance = [
      {
        key: "totalAssets",
        names: ["إجمالي الموجودات", "اجمالي الموجودات", "إجمالي الأصول", "اجمالي الأصول", "مجموع الموجودات", "مجموع الأصول", "Total assets"],
        opts: { mustInclude: ["اجمالي"], mustNotInclude: ["غير متداولة", "متداولة"] },
      },
      {
        key: "totalLiabilities",
        names: ["إجمالي المطلوبات", "اجمالي المطلوبات", "إجمالي الالتزامات", "اجمالي الالتزامات", "إجمالي الخصوم", "اجمالي الخصوم", "Total liabilities"],
        opts: { mustInclude: ["اجمالي"], mustNotInclude: ["غير متداولة", "متداولة"] },
      },
      {
        key: "totalEquity",
        names: [
          "إجمالي حقوق الملكية",
          "اجمالي حقوق الملكية",
          "إجمالي حقوق المساهمين",
          "اجمالي حقوق المساهمين",
          "إجمالي حقوق الملكية العائدة لمساهمي الشركة الأم",
          "اجمالي حقوق الملكية العائدة لمساهمي الشركة الام",
          "Total equity",
          "Total shareholders' equity",
        ],
        opts: { mustInclude: ["اجمالي"], mustNotInclude: ["غير المسيطرة"] },
      },
      { key: "currentAssets", names: ["إجمالي الموجودات المتداولة", "اجمالي الموجودات المتداولة", "الأصول المتداولة", "اصول متداولة", "Current assets"], opts: { mustInclude: ["متداولة"] } },
      { key: "nonCurrentAssets", names: ["إجمالي الموجودات غير المتداولة", "اجمالي الموجودات غير المتداولة", "الأصول غير المتداولة", "اصول غير متداولة", "Non-current assets"], opts: { mustInclude: ["غير متداولة"] } },
      { key: "currentLiabilities", names: ["إجمالي المطلوبات المتداولة", "اجمالي المطلوبات المتداولة", "المطلوبات المتداولة", "الالتزامات المتداولة", "Current liabilities"], opts: { mustInclude: ["متداولة"] } },
      { key: "nonCurrentLiabilities", names: ["إجمالي المطلوبات غير المتداولة", "اجمالي المطلوبات غير المتداولة", "المطلوبات غير المتداولة", "الالتزامات غير المتداولة", "Non-current liabilities"], opts: { mustInclude: ["غير متداولة"] } },
    ];

    const extractBalanceFromAnyTables = (tables, latestColIdx, prevColIdx) => {
      // We pick the best hit across ALL candidate tables per metric
      const out = {};
      const debugHits = {};

      for (const item of wantBalance) {
        let bestHit = null;
        let bestTableIndex = null;

        for (const t of tables || []) {
          const rows = Array.isArray(t?.sample) ? t.sample : [];
          const hit = bestMatchRow(rows, item.names, item.opts || {});
          if (!hit) continue;

          // quality score: prefer tables with higher balance score
          const tScore = scoreBalanceTable(t);
          const labelLen = (hit.label || "").length;
          const q = tScore * 1000 + labelLen;

          if (!bestHit || q > bestHit.q) {
            bestHit = { ...hit, q };
            bestTableIndex = t?.index ?? null;
          }
        }

        if (!bestHit) {
          out[item.key] = null;
          continue;
        }

        const cur = latestColIdx != null ? parseNumberSmart(bestHit.row?.[latestColIdx]) : null;
        const prev = prevColIdx != null ? parseNumberSmart(bestHit.row?.[prevColIdx]) : null;

        out[item.key] = { label: bestHit.label, current: cur, previous: prev };
        debugHits[item.key] = { tableIndex: bestTableIndex, label: bestHit.label };
      }

      return { out, debugHits };
    };

    /* =========================
       DIAG: rank balance tables (show why we pick)
       ========================= */

    const tableTextQuick = (t) => {
      const rows = Array.isArray(t?.sample) ? t.sample : [];
      const out = [];
      for (let r = 0; r < rows.length && r < 30; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length && c < 12; c++) {
          const v = row[c];
          if (v !== null && v !== undefined && String(v).trim() !== "") out.push(String(v));
        }
      }
      return norm(out.join(" | "));
    };

    const pickBestBalanceSheetTable = (tables) => {
      const ranked = (Array.isArray(tables) ? tables : [])
        .map((t) => {
          const snippet = tableTextQuick(t);
          const score = scoreBalanceTable(t);

          return {
            index: t?.index ?? null,
            score,
            page: t?.pageNumber ?? t?.page ?? null,
            columnCount: t?.columnCount ?? null,
            rowCount: t?.rowCount ?? null,
            snippet: snippet.slice(0, 260),
          };
        })
        .sort((a, b) => b.score - a.score);

      const best = ranked[0] || null;

      return {
        bestTableIndex: best?.index ?? null,
        bestScore: best?.score ?? null,
        candidates: ranked.slice(0, 8),
      };
    };

    if (diag && (target === "" || target === "balance" || target === "balancesheet")) {
      const bsDiag = pickBestBalanceSheetTable(tablesPreview);

      return send(200, {
        ok: true,
        diag: true,
        kind: "balanceSheetCandidates",
        pagesMeta,
        tablesPreviewCount: tablesPreview.length,
        bestTableIndex: bsDiag.bestTableIndex,
        bestScore: bsDiag.bestScore,
        found: bsDiag.candidates.length,
        ranked: bsDiag.candidates,
        hint: "خذ bestTableIndex من ranked (أعلى score). إذا كانت الميزانية موزعة على أكثر من جدول، نقدر نلتقط البنود من أكثر من جدول تلقائياً (وهذا مفعّل هنا).",
      });
    }

    /* =========================
       1) pick best income table (file A)
       ========================= */

    let bestA = null;
    for (const t of tablesPreview) {
      const s = scoreIncomeTable(t);
      if (!bestA || s > bestA.score) bestA = { table: t, score: s };
    }

    if (!bestA) {
      return send(200, {
        ok: true,
        financial: {
          pagesMeta,
          note: "لا توجد tablesPreview داخل normalized.",
          tablesPreviewCount: tablesPreview.length,
        },
      });
    }

    const colsA = detectColumns(bestA.table);
    const pickedA = pickLatestColumns(colsA);

    const latestColA = pickedA.latest?.col ?? null;
    const prevColA = !noCompare ? pickedA.previous?.col ?? null : null;

    let incomeExtract = {};

    if (usingTwoFiles) {
      let bestB = null;
      for (const t of tablesPreviewPrev) {
        const s = scoreIncomeTable(t);
        if (!bestB || s > bestB.score) bestB = { table: t, score: s };
      }

      if (bestB) {
        const colsB = detectColumns(bestB.table);
        const pickedB = pickLatestColumns(colsB);
        const latestColB = pickedB.latest?.col ?? null;

        incomeExtract = extractIncomeTwoFiles(bestA.table, latestColA, bestB.table, latestColB);
      } else {
        incomeExtract = extractIncomeSingleTable(bestA.table, latestColA, null);
      }
    } else {
      incomeExtract = latestColA != null ? extractIncomeSingleTable(bestA.table, latestColA, prevColA) : {};
    }

    /* =========================
       2) Balance extraction
       - Use ALL tables (not just one), because your PDF splits sections
       ========================= */

    // pick columns for balance: we use best balance table just to detect columns
    const bsDiagA = pickBestBalanceSheetTable(tablesPreview);

    // choose a table to detect columns from (best score)
    let balColsSource = null;
    if (bsDiagA.bestTableIndex !== null && bsDiagA.bestTableIndex !== undefined) {
      balColsSource = tablesPreview.find((x) => Number(x?.index) === Number(bsDiagA.bestTableIndex)) || null;
    }
    if (!balColsSource) balColsSource = tablesPreview[0] || null;

    let balanceExtract = {};
    let balancePicked = null;

    if (balColsSource) {
      const colsBalA = detectColumns(balColsSource);
      const pickedBalA = pickLatestColumns(colsBalA);

      const latestBalColA = pickedBalA.latest?.col ?? null;
      const prevBalColA = !noCompare ? pickedBalA.previous?.col ?? null : null;

      // extract from ANY tables in file A
      const balA = extractBalanceFromAnyTables(tablesPreview, latestBalColA, prevBalColA);

      balanceExtract = balA.out;

      balancePicked = {
        fileA: {
          columnsFromTableIndex: balColsSource.index,
          diag: bsDiagA,
          pickedColumns: {
            latest: pickedBalA.latest
              ? { col: pickedBalA.latest.col, year: pickedBalA.latest.years?.slice(-1)?.[0] ?? null }
              : null,
            previous: noCompare
              ? null
              : pickedBalA.previous
              ? { col: pickedBalA.previous.col, year: pickedBalA.previous.years?.slice(-1)?.[0] ?? null }
              : null,
            debug: pickedBalA.debug,
          },
          hits: balA.debugHits,
        },
        note:
          "Balance metrics are extracted by searching across ALL tables (because some PDFs split Assets/Liabilities/Equity across multiple tables).",
      };

      if (usingTwoFiles) {
        const bsDiagB = pickBestBalanceSheetTable(tablesPreviewPrev);
        let balColsSourceB = null;

        if (bsDiagB.bestTableIndex !== null && bsDiagB.bestTableIndex !== undefined) {
          balColsSourceB =
            tablesPreviewPrev.find((x) => Number(x?.index) === Number(bsDiagB.bestTableIndex)) || null;
        }
        if (!balColsSourceB) balColsSourceB = tablesPreviewPrev[0] || null;

        if (balColsSourceB) {
          const colsBalB = detectColumns(balColsSourceB);
          const pickedBalB = pickLatestColumns(colsBalB);
          const latestBalColB = pickedBalB.latest?.col ?? null;

          const balB = extractBalanceFromAnyTables(tablesPreviewPrev, latestBalColB, null);

          // merge: current from A, previous from B when compare + 2 files
          const merged = {};
          for (const item of wantBalance) {
            const k = item.key;
            const curObj = balanceExtract?.[k] || null;
            const prevObj = balB.out?.[k] || null;
            merged[k] = {
              label: (curObj?.label || prevObj?.label || null),
              current: curObj?.current ?? null,
              previous: prevObj?.current ?? null, // B "current" is previous year for comparison
            };
          }

          balanceExtract = merged;

          balancePicked.fileB = {
            columnsFromTableIndex: balColsSourceB.index,
            diag: bsDiagB,
            pickedColumns: {
              latest: pickedBalB.latest
                ? { col: pickedBalB.latest.col, year: pickedBalB.latest.years?.slice(-1)?.[0] ?? null }
                : null,
              debug: pickedBalB.debug,
            },
            hits: balB.debugHits,
          };
        }
      }
    }

    return send(200, {
      ok: true,
      financial: {
        pagesMeta,

        selectionPolicy: {
          noCompare,
          usingTwoFiles,
          rule: noCompare
            ? "No compare selected -> pick latest year/period only."
            : usingTwoFiles
            ? "Compare selected + 2 files -> current from file A (latest) vs previous from file B (latest)."
            : "Compare selected -> pick latest + previous from same file (prefer same period type).",
        },

        bestIncomeTable: {
          index: bestA.table.index,
          score: bestA.score,
          columnCount: bestA.table.columnCount,
          rowCount: bestA.table.rowCount,
        },

        columnsDetected: colsA.map((c) => ({
          col: c.col,
          years: c.years,
          hasThreeMonths: c.hasThreeMonths,
          hasNineMonths: c.hasNineMonths,
          hasAnnual: c.hasAnnual,
          hasNote: c.hasNote,
        })),

        pickedColumns: {
          latest: pickedA.latest
            ? { col: pickedA.latest.col, year: pickedA.latest.years?.slice(-1)?.[0] ?? null }
            : null,
          previous: pickedA.previous
            ? { col: pickedA.previous.col, year: pickedA.previous.years?.slice(-1)?.[0] ?? null }
            : null,
          debug: pickedA.debug,
        },

        incomeStatementLite: incomeExtract,

        // Balance outputs
        balanceSheetLite: balanceExtract,
        balancePickInfo: balancePicked,

        sample: bestA.table.sample?.slice(0, 12) || [],
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
