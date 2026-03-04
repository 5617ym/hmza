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

    // OPTIONAL override to force a balance table index
    const balanceTableIndexOverrideRaw =
      body.balanceTableIndex ?? body.balanceIndex ?? body.balance_table_index ?? null;
    const balanceTableIndexOverride =
      balanceTableIndexOverrideRaw === null || balanceTableIndexOverrideRaw === undefined
        ? null
        : Number(balanceTableIndexOverrideRaw);

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
        "٠": "0",
        "١": "1",
        "٢": "2",
        "٣": "3",
        "٤": "4",
        "٥": "5",
        "٦": "6",
        "٧": "7",
        "٨": "8",
        "٩": "9",
        "۰": "0",
        "۱": "1",
        "۲": "2",
        "۳": "3",
        "۴": "4",
        "۵": "5",
        "۶": "6",
        "۷": "7",
        "۸": "8",
        "۹": "9",
      };
      return String(s || "").replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
    };

    const normalizeSeparators = (s) => {
      return String(s || "")
        .replace(/٫/g, ".")
        .replace(/[٬،]/g, ",");
    };

    const norm = (s) => toLatinDigits(normalizeSeparators(String(s || ""))).toLowerCase().trim();

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
      const s = toLatinDigits(normalizeSeparators(text));
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

          if (t.includes("الثلاثة") && t.includes("أشهر")) cols[c].hasThreeMonths = true;
          if (t.includes("التسعة") && t.includes("أشهر")) cols[c].hasNineMonths = true;

          if (t.includes("ديسمبر") || t.includes("السنة") || t.includes("منتهية")) cols[c].hasAnnual = true;

          if (t.includes("إيضاح") || t.includes("ايضاح") || t === "إيضاح") cols[c].hasNote = true;
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
       Row label detection (STRONG)
       ========================= */

    const isNumericish = (txt) => {
      const t = norm(txt);
      if (!t) return true;
      // allow parentheses, commas, dots, plus/minus only
      return /^[\d\s().,+-]+$/.test(t);
    };

    const isLikelyLabel = (txt) => {
      const raw = String(txt || "").trim();
      if (!raw) return false;
      const t = norm(raw);
      if (!t) return false;
      if (t.length < 3) return false;
      // if it's basically a number, not label
      if (isNumericish(t)) return false;
      // must contain some letters (arabic or latin)
      const hasLetters = /[a-z\u0600-\u06FF]/i.test(raw);
      return hasLetters;
    };

    const getRowLabel = (r) => {
      if (!Array.isArray(r)) return "";

      // prefer scanning from end (often label is last cell in Arabic tables)
      for (let i = r.length - 1; i >= 0; i--) {
        const cell = r[i];
        if (!cell) continue;
        if (isLikelyLabel(cell)) return norm(cell);
      }

      // fallback: scan from start
      for (let i = 0; i < r.length; i++) {
        const cell = r[i];
        if (!cell) continue;
        if (isLikelyLabel(cell)) return norm(cell);
      }

      return "";
    };

    const findRowByLabel = (rows, names) => {
      if (!Array.isArray(rows)) return null;

      // 1) Prefer rows that contain إجمالي/total when looking for totals
      for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const label = getRowLabel(r);
        if (!label) continue;

        const labelNorm = norm(label);
        const hasTotalWord =
          labelNorm.includes(norm("إجمالي")) ||
          labelNorm.includes(norm("اجمالي")) ||
          labelNorm.includes(norm("المجموع")) ||
          labelNorm.includes("total");

        if (!hasTotalWord) continue;

        const ok = names.some((n) => labelNorm.includes(norm(n)));
        if (ok) return { row: r, label };
      }

      // 2) Fallback: normal matching
      for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const label = getRowLabel(r);
        if (!label) continue;

        const labelNorm = norm(label);
        const ok = names.some((n) => labelNorm.includes(norm(n)));
        if (ok) return { row: r, label };
      }

      return null;
    };

    /* =========================
       Income extraction (existing)
       ========================= */

    const scoreIncomeTable = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const joined = norm(rows.map((r) => (Array.isArray(r) ? r.join(" ") : "")).join("\n"));

      const hits = [
        "الإيرادات",
        "الايرادات",
        "تكلفة الإيرادات",
        "تكلفة الايرادات",
        "مجمل الربح",
        "الربح التشغيلي",
        "صافي الربح",
        "قائمة الدخل",
        "قائمة الربح والخسارة",
        "لفترة",
        "الثلاثة أشهر",
        "التسعة أشهر",
      ];

      let score = 0;
      for (const k of hits) if (joined.includes(norm(k))) score += 2;

      if (joined.includes("إيضاح") || joined.includes("ايضاح")) score += 1;

      const cc = Number(table?.columnCount || 0);
      if (cc >= 5) score += 1;

      return score;
    };

    const wantIncome = [
      { key: "revenue", names: ["الإيرادات", "الايرادات", "المبيعات", "إيرادات", "Revenue"] },
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
        const hit = findRowByLabel(rows, item.names);
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
        const hitA = findRowByLabel(rowsA, item.names);
        const hitB = findRowByLabel(rowsB, item.names);

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
       ========================= */

    const wantBalance = [
      {
        key: "totalAssets",
        names: [
          "إجمالي الأصول",
          "اجمالي الأصول",
          "إجمالي الموجودات",
          "اجمالي الموجودات",
          "مجموع الأصول",
          "مجموع الموجودات",
          "إجمالي الموجودات",
          "إجمالي الموجودات",
          "Total assets",
        ],
      },
      {
        key: "totalLiabilities",
        names: [
          "إجمالي المطلوبات",
          "اجمالي المطلوبات",
          "إجمالي الالتزامات",
          "اجمالي الالتزامات",
          "إجمالي الخصوم",
          "اجمالي الخصوم",
          "مجموع المطلوبات",
          "مجموع الالتزامات",
          "Total liabilities",
        ],
      },
      {
        key: "totalEquity",
        names: [
          "إجمالي حقوق الملكية",
          "اجمالي حقوق الملكية",
          "إجمالي حقوق المساهمين",
          "اجمالي حقوق المساهمين",
          "إجمالي حقوق الملكية العائدة لمساهمي الشركة الأم",
          "إجمالي حقوق الملكية العائدة لمساهمي الشركة الام",
          "إجمالي حقوق الملكية العائدة لمساهمي الشركة الأم",
          "Total equity",
          "Total shareholders' equity",
        ],
      },
      { key: "currentAssets", names: ["الأصول المتداولة", "اصول متداولة", "Current assets"] },
      { key: "nonCurrentAssets", names: ["الأصول غير المتداولة", "اصول غير متداولة", "Non-current assets"] },
      {
        key: "currentLiabilities",
        names: ["المطلوبات المتداولة", "الالتزامات المتداولة", "Current liabilities"],
      },
      {
        key: "nonCurrentLiabilities",
        names: ["المطلوبات غير المتداولة", "الالتزامات غير المتداولة", "Non-current liabilities"],
      },
    ];

    const extractBalanceSingleTable = (table, latestColIdx, prevColIdx) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const out = {};

      for (const item of wantBalance) {
        const hit = findRowByLabel(rows, item.names);
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

    const extractBalanceTwoFiles = (tableA, colA, tableB, colB) => {
      const rowsA = Array.isArray(tableA?.sample) ? tableA.sample : [];
      const rowsB = Array.isArray(tableB?.sample) ? tableB.sample : [];
      const out = {};

      for (const item of wantBalance) {
        const hitA = findRowByLabel(rowsA, item.names);
        const hitB = findRowByLabel(rowsB, item.names);

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
       DIAG: pick best balance table (STRICT)
       ========================= */

    const normText2 = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const tableTextQuick = (t) => {
      const rows = Array.isArray(t?.sample) ? t.sample : [];
      const out = [];
      for (let r = 0; r < rows.length && r < 40; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length && c < 14; c++) {
          const v = row[c];
          if (v) out.push(v);
        }
      }
      return normText2(out.join(" | "));
    };

    const hasAny = (text, arr) => arr.some((k) => text.includes(normText2(k)));

    const scoreBalanceSheetText = (text) => {
      const strongTitle = [
        "قائمة المركز المالي",
        "الميزانية",
        "الميزانية العمومية",
        "قائمة الوضع المالي",
        "statement of financial position",
        "balance sheet",
      ];

      const assetsKeys = ["الأصول", "الموجودات", "assets"];
      const liabKeys = ["المطلوبات", "الالتزامات", "الخصوم", "liabilities"];
      const eqKeys = ["حقوق الملكية", "حقوق المساهمين", "equity"];

      const hasTitle = hasAny(text, strongTitle);
      const hasAssets = hasAny(text, assetsKeys);
      const hasLiab = hasAny(text, liabKeys);
      const hasEq = hasAny(text, eqKeys);

      // STRICT GATE:
      // Accept only if hasTitle OR (assets+liabilities+equity all present)
      const passesGate = hasTitle || (hasAssets && hasLiab && hasEq);
      if (!passesGate) return 0;

      let score = 0;

      if (hasTitle) score += 120;

      if (hasAssets) score += 40;
      if (hasLiab) score += 40;
      if (hasEq) score += 40;

      // totals are strong hints
      const totals = [
        "إجمالي الأصول",
        "إجمالي الموجودات",
        "إجمالي المطلوبات",
        "إجمالي الالتزامات",
        "إجمالي حقوق الملكية",
        "إجمالي حقوق المساهمين",
        "total assets",
        "total liabilities",
        "total equity",
      ];
      for (const t of totals) if (text.includes(normText2(t))) score += 18;

      if (text.includes("متداولة") && text.includes("غير متداولة")) score += 15;

      return score;
    };

    const pickBestBalanceSheetTable = (tables) => {
      const ranked = (Array.isArray(tables) ? tables : [])
        .map((t) => {
          const text = tableTextQuick(t);
          const score = scoreBalanceSheetText(text);

          return {
            index: t?.index ?? null,
            score,
            page: t?.pageNumber ?? t?.page ?? null,
            columnCount: t?.columnCount ?? null,
            rowCount: t?.rowCount ?? null,
            snippet: text.slice(0, 260),
          };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = ranked[0] || null;

      return {
        bestTableIndex: best?.index ?? null,
        bestScore: best?.score ?? null,
        candidates: ranked.slice(0, 5),
      };
    };

    // If diag endpoint requested for balance: return candidates directly (no extraction)
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
        hint:
          "إذا ranked فارغ أو bestTableIndex غلط: أرسل balanceTableIndex في body لتثبيت جدول الميزانية يدويًا.",
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
       2) pick best balance table (file A)
       ========================= */

    // 2.1) if override provided, use it
    let bestBalanceA = null;
    let bsDiagA = pickBestBalanceSheetTable(tablesPreview);

    if (balanceTableIndexOverride !== null && Number.isFinite(balanceTableIndexOverride)) {
      const forced = tablesPreview.find((x) => Number(x?.index) === Number(balanceTableIndexOverride));
      if (forced) {
        bestBalanceA = { table: forced, score: scoreBalanceSheetText(tableTextQuick(forced)), pickedBy: "override" };
      }
    }

    // 2.2) else use diag
    if (!bestBalanceA && bsDiagA.bestTableIndex !== null && bsDiagA.bestTableIndex !== undefined) {
      const t = tablesPreview.find((x) => Number(x?.index) === Number(bsDiagA.bestTableIndex));
      if (t) bestBalanceA = { table: t, score: scoreBalanceSheetText(tableTextQuick(t)), pickedBy: "diag" };
    }

    // 2.3) else fallback by strict scoring
    if (!bestBalanceA) {
      for (const t of tablesPreview) {
        const s = scoreBalanceSheetText(tableTextQuick(t));
        if (s <= 0) continue;
        if (!bestBalanceA || s > bestBalanceA.score) bestBalanceA = { table: t, score: s, pickedBy: "fallbackScore" };
      }
    }

    let balanceExtract = {};
    let balancePicked = null;

    if (bestBalanceA?.table) {
      const colsBalA = detectColumns(bestBalanceA.table);
      const pickedBalA = pickLatestColumns(colsBalA);

      const latestBalColA = pickedBalA.latest?.col ?? null;
      const prevBalColA = !noCompare ? pickedBalA.previous?.col ?? null : null;

      if (usingTwoFiles) {
        // file B: allow same override name but with suffix
        const balanceTableIndexOverridePrevRaw =
          body.balanceTableIndexPrev ?? body.balanceIndexPrev ?? body.balance_table_index_prev ?? null;
        const balanceTableIndexOverridePrev =
          balanceTableIndexOverridePrevRaw === null || balanceTableIndexOverridePrevRaw === undefined
            ? null
            : Number(balanceTableIndexOverridePrevRaw);

        let bestBalanceB = null;
        let bsDiagB = pickBestBalanceSheetTable(tablesPreviewPrev);

        if (balanceTableIndexOverridePrev !== null && Number.isFinite(balanceTableIndexOverridePrev)) {
          const forced = tablesPreviewPrev.find((x) => Number(x?.index) === Number(balanceTableIndexOverridePrev));
          if (forced) {
            bestBalanceB = { table: forced, score: scoreBalanceSheetText(tableTextQuick(forced)), pickedBy: "override" };
          }
        }

        if (!bestBalanceB && bsDiagB.bestTableIndex !== null && bsDiagB.bestTableIndex !== undefined) {
          const t = tablesPreviewPrev.find((x) => Number(x?.index) === Number(bsDiagB.bestTableIndex));
          if (t) bestBalanceB = { table: t, score: scoreBalanceSheetText(tableTextQuick(t)), pickedBy: "diag" };
        }

        if (!bestBalanceB) {
          for (const t of tablesPreviewPrev) {
            const s = scoreBalanceSheetText(tableTextQuick(t));
            if (s <= 0) continue;
            if (!bestBalanceB || s > bestBalanceB.score) bestBalanceB = { table: t, score: s, pickedBy: "fallbackScore" };
          }
        }

        if (bestBalanceB?.table) {
          const colsBalB = detectColumns(bestBalanceB.table);
          const pickedBalB = pickLatestColumns(colsBalB);
          const latestBalColB = pickedBalB.latest?.col ?? null;

          balanceExtract = extractBalanceTwoFiles(bestBalanceA.table, latestBalColA, bestBalanceB.table, latestBalColB);

          balancePicked = {
            fileA: {
              tableIndex: bestBalanceA.table.index,
              score: bestBalanceA.score,
              pickedBy: bestBalanceA.pickedBy,
              pickedColumns: {
                latest: pickedBalA.latest ? { col: pickedBalA.latest.col, year: pickedBalA.latest.years?.slice(-1)?.[0] ?? null } : null,
                previous: pickedBalA.previous ? { col: pickedBalA.previous.col, year: pickedBalA.previous.years?.slice(-1)?.[0] ?? null } : null,
                debug: pickedBalA.debug,
              },
              diag: bsDiagA,
              override: balanceTableIndexOverride,
            },
            fileB: {
              tableIndex: bestBalanceB.table.index,
              score: bestBalanceB.score,
              pickedBy: bestBalanceB.pickedBy,
              pickedColumns: {
                latest: pickedBalB.latest ? { col: pickedBalB.latest.col, year: pickedBalB.latest.years?.slice(-1)?.[0] ?? null } : null,
                debug: pickedBalB.debug,
              },
              diag: bsDiagB,
              override: balanceTableIndexOverridePrev,
            },
          };
        } else {
          balanceExtract = latestBalColA != null ? extractBalanceSingleTable(bestBalanceA.table, latestBalColA, null) : {};
          balancePicked = {
            fileA: {
              tableIndex: bestBalanceA.table.index,
              score: bestBalanceA.score,
              pickedBy: bestBalanceA.pickedBy,
              pickedColumns: {
                latest: pickedBalA.latest ? { col: pickedBalA.latest.col, year: pickedBalA.latest.years?.slice(-1)?.[0] ?? null } : null,
                previous: null,
                debug: pickedBalA.debug,
              },
              diag: bsDiagA,
              override: balanceTableIndexOverride,
            },
            note: "No balance table found in file B; used file A latest only.",
          };
        }
      } else {
        balanceExtract = latestBalColA != null ? extractBalanceSingleTable(bestBalanceA.table, latestBalColA, prevBalColA) : {};
        balancePicked = {
          fileA: {
            tableIndex: bestBalanceA.table.index,
            score: bestBalanceA.score,
            pickedBy: bestBalanceA.pickedBy,
            pickedColumns: {
              latest: pickedBalA.latest ? { col: pickedBalA.latest.col, year: pickedBalA.latest.years?.slice(-1)?.[0] ?? null } : null,
              previous: noCompare
                ? null
                : pickedBalA.previous
                ? { col: pickedBalA.previous.col, year: pickedBalA.previous.years?.slice(-1)?.[0] ?? null }
                : null,
              debug: pickedBalA.debug,
            },
            diag: bsDiagA,
            override: balanceTableIndexOverride,
          },
        };
      }
    } else {
      balancePicked = {
        note: "No balance sheet table passed strict gate (assets+liabilities+equity or title). Try DIAG or set balanceTableIndex override.",
        diag: bsDiagA,
        override: balanceTableIndexOverride,
      };
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
          latest: pickedA.latest ? { col: pickedA.latest.col, year: pickedA.latest.years?.slice(-1)?.[0] ?? null } : null,
          previous: pickedA.previous ? { col: pickedA.previous.col, year: pickedA.previous.years?.slice(-1)?.[0] ?? null } : null,
          debug: pickedA.debug,
        },

        incomeStatementLite: incomeExtract,

        balanceSheetLite: balanceExtract,
        balancePickInfo: balancePicked,

        sample: bestA.table.sample?.slice(0, 12) || [],
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
