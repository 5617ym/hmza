// api/extract-financial/index.jss
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
        "٠": "0","١": "1","٢": "2","٣": "3","٤": "4",
        "٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
        "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4",
        "۵": "5","۶": "6","۷": "7","۸": "8","۹": "9",
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

    const isProbablyNumberCell = (cell) => {
      const s = norm(cell);
      if (!s) return false;
      if (parseNumberSmart(cell) !== null) return true;
      if (/^[\d\s,.\-+()]+$/.test(s)) return true;
      return false;
    };

    const findYear = (text) => {
      const s = toLatinDigits(normalizeSeparators(text));
      const m = s.match(/\b(20\d{2})\b/);
      if (!m) return null;
      const y = Number(m[1]);
      return y >= 2000 && y <= 2100 ? y : null;
    };

    // ✅ مهم: دمج head + tail
    const getTableRows = (table) => {
      const head = Array.isArray(table?.sample) ? table.sample : [];
      const tail =
        Array.isArray(table?.sampleTail) ? table.sampleTail :
        Array.isArray(table?.tail) ? table.tail :
        [];
      if (!tail.length) return head;
      const headStr = new Set(head.map((r) => JSON.stringify(r)));
      const merged = [...head];
      for (const r of tail) {
        const key = JSON.stringify(r);
        if (!headStr.has(key)) merged.push(r);
      }
      return merged;
    };

    const headerRowLimit = 6;
    const detectColumns = (table) => {
      const rows = getTableRows(table);
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
       Row matching (FINAL)
       ========================= */

    const findRowByLabel = (rows, item) => {
      if (!Array.isArray(rows)) return null;

      const names = Array.isArray(item?.names) ? item.names : [];
      const exclude = Array.isArray(item?.exclude) ? item.exclude : [];

      const isExcluded = (cellNorm) => exclude.some((e) => cellNorm.includes(norm(e)));

      for (const r of rows) {
        if (!Array.isArray(r)) continue;

        for (let i = 0; i < r.length; i++) {
          const cell = r[i];
          const cellNorm = norm(cell);
          if (!cellNorm) continue;

          // تجاهل الخلايا الرقمية
          if (isProbablyNumberCell(cell)) continue;

          if (isExcluded(cellNorm)) continue;

          const ok = names.some((n) => cellNorm.includes(norm(n)));
          if (ok) return { row: r, label: cellNorm, labelCellIndex: i };
        }
      }

      return null;
    };

    /* =========================
       INCOME STATEMENT
       ========================= */

    const scoreIncomeTable = (table) => {
      const rows = getTableRows(table);
      const joined = norm(rows.map((r) => (Array.isArray(r) ? r.join(" ") : "")).join("\n"));

      const hits = [
        "الإيرادات","الايرادات","تكلفة الإيرادات","تكلفة الايرادات",
        "مجمل الربح","الربح التشغيلي","صافي الربح",
        "قائمة الدخل","قائمة الربح والخسارة","لفترة","الثلاثة أشهر","التسعة أشهر",
      ];

      let score = 0;
      for (const k of hits) if (joined.includes(norm(k))) score += 2;

      if (joined.includes("إيضاح") || joined.includes("ايضاح")) score += 1;

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
      const rows = getTableRows(table);
      const out = {};

      for (const item of wantIncome) {
        const hit = findRowByLabel(rows, { names: item.names });
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
      const rowsA = getTableRows(tableA);
      const rowsB = getTableRows(tableB);
      const out = {};

      for (const item of wantIncome) {
        const hitA = findRowByLabel(rowsA, { names: item.names });
        const hitB = findRowByLabel(rowsB, { names: item.names });

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

    const normText2 = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

    const tableTextQuick = (t) => {
      const rows = getTableRows(t);
      const out = [];
      for (let r = 0; r < rows.length && r < 60; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length && c < 12; c++) {
          const v = row[c];
          if (v) out.push(v);
        }
      }
      return normText2(out.join(" | "));
    };

    const scoreBalanceSheetText = (text) => {
      const keysStrong = [
        "قائمة المركز المالي",
        "الميزانية",
        "الميزانية العمومية",
        "قائمة الوضع المالي",
        "statement of financial position",
        "balance sheet",
      ];
      const keysSupport = [
        "الأصول","assets","الموجودات",
        "المطلوبات","liabilities","الالتزامات",
        "حقوق الملكية","equity",
        "إجمالي الأصول","total assets",
        "إجمالي المطلوبات","total liabilities",
        "إجمالي حقوق الملكية","total equity",
      ];

      let score = 0;
      for (const k of keysStrong) if (text.includes(normText2(k))) score += 50;
      for (const k of keysSupport) if (text.includes(normText2(k))) score += 10;
      if (text.includes("متداولة") || text.includes("غير متداولة")) score += 8;
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

    const scoreBalanceTable = (table) => {
      const rows = getTableRows(table);
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
        "الأصول","الموجودات","assets",
        "المطلوبات","liabilities","الالتزامات",
        "حقوق الملكية","equity",
        "إجمالي الأصول","total assets",
      ];

      let score = 0;
      for (const k of strong) if (joined.includes(norm(k))) score += 20;
      for (const k of support) if (joined.includes(norm(k))) score += 6;
      if (joined.includes(norm("متداولة")) && joined.includes(norm("غير متداولة"))) score += 6;

      return score;
    };

    const wantBalance = [
      {
        key: "totalAssets",
        names: [
          "إجمالي الموجودات",
          "اجمالي الموجودات",
          "إجمالي الأصول",
          "اجمالي الأصول",
          "مجموع الأصول",
          "مجموع الموجودات",
          "Total assets",
        ],
        // ✅ حماية: لا تلتقط المتداولة/غير المتداولة
        exclude: [
          "المتداولة",
          "غير المتداولة",
          "غير المتداوله",
          "current",
          "non-current",
        ],
      },
      {
        key: "currentAssets",
        names: [
          "إجمالي الموجودات المتداولة",
          "إجمالي الأصول المتداولة",
          "الموجودات المتداولة",
          "الأصول المتداولة",
          "Current assets",
        ],
      },
      {
        key: "nonCurrentAssets",
        names: [
          "إجمالي الموجودات غير المتداولة",
          "إجمالي الأصول غير المتداولة",
          "الموجودات غير المتداولة",
          "الأصول غير المتداولة",
          "Non-current assets",
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
          "Total liabilities",
        ],
        
        // ✅ حماية: لا تلتقط المتداولة/غير المتداولة ولا “وحقوق الملكية”
        exclude: [
          "المتداولة",
          "غير المتداولة",
          "غير المتداوله",
          "current",
          "non-current",
          "وحقوق",
          "and equity",
          "and shareholders",
      },
      {
        key: "currentLiabilities",
        names: [
          "إجمالي المطلوبات المتداولة",
          "المطلوبات المتداولة",
          "الالتزامات المتداولة",
          "الخصوم المتداولة",
          "Current liabilities",
        ],
      },
      {
        key: "nonCurrentLiabilities",
        names: [
          "إجمالي المطلوبات غير المتداولة",
          "المطلوبات غير المتداولة",
          "الالتزامات غير المتداولة",
          "الخصوم غير المتداولة",
          "Non-current liabilities",
        ],
      },
      {
        key: "totalEquity",
        names: [
          "إجمالي حقوق الملكية",
          "اجمالي حقوق الملكية",
          "إجمالي حقوق المساهمين",
          "اجمالي حقوق المساهمين",
          "حقوق الملكية العائدة لمساهمي الشركة الأم",
          "إجمالي حقوق الملكية العائدة لمساهمي الشركة الأم",
          "Total equity",
          "Total shareholders' equity",
        ],
      },
    ];

    const extractBalanceSingleTable = (table, latestColIdx, prevColIdx) => {
      const rows = getTableRows(table);

      // ✅ بدل ما نوقف بسبب عدم وجود sampleTail: نكمل ونعطي تحذير فقط
      const hasTail = Array.isArray(table?.sampleTail) && table.sampleTail.length > 0;
      const out = {
        __warning: hasTail ? null : "No sampleTail in tablesPreview; extracted from sample rows only (may miss bottom totals).",
      };

      for (const item of wantBalance) {
        const hit = findRowByLabel(rows, item);
        if (!hit) {
          out[item.key] = null;
          continue;
        }
        const cur = latestColIdx != null ? parseNumberSmart(hit.row?.[latestColIdx]) : null;
        const prev = prevColIdx != null ? parseNumberSmart(hit.row?.[prevColIdx]) : null;
        out[item.key] = { label: hit.label, current: cur, previous: prev };
      }

      // Derivation rules
      const a = out.totalAssets?.current ?? null;
      const ca = out.currentAssets?.current ?? null;
      const nca = out.nonCurrentAssets?.current ?? null;

      const l = out.totalLiabilities?.current ?? null;
      const cl = out.currentLiabilities?.current ?? null;
      const ncl = out.nonCurrentLiabilities?.current ?? null;

      const e = out.totalEquity?.current ?? null;

      if (a == null && ca != null && nca != null) {
        out.totalAssets = { label: "derived: currentAssets + nonCurrentAssets", current: ca + nca, previous: null };
      }

      if (l == null && cl != null && ncl != null) {
        out.totalLiabilities = { label: "derived: currentLiabilities + nonCurrentLiabilities", current: cl + ncl, previous: null };
      }

      const a2 = out.totalAssets?.current ?? null;
      const l2 = out.totalLiabilities?.current ?? null;
      const e2 = out.totalEquity?.current ?? null;

      if (a2 != null && l2 != null && e2 == null) {
        out.totalEquity = { label: "derived: assets - liabilities", current: a2 - l2, previous: null };
      }

      return out;
    };

    const extractBalanceTwoFiles = (tableA, colA, tableB, colB) => {
      const rowsA = getTableRows(tableA);
      const rowsB = getTableRows(tableB);

      const hasTailA = Array.isArray(tableA?.sampleTail) && tableA.sampleTail.length > 0;
      const hasTailB = Array.isArray(tableB?.sampleTail) && tableB.sampleTail.length > 0;

      const out = {
        __warning: (!hasTailA || !hasTailB)
          ? "Compare mode: missing sampleTail in one/both files; extracted from sample rows only (may miss bottom totals)."
          : null,
      };

      for (const item of wantBalance) {
        const hitA = findRowByLabel(rowsA, item);
        const hitB = findRowByLabel(rowsB, item);

        const cur = hitA && colA != null ? parseNumberSmart(hitA.row?.[colA]) : null;
        const prev = hitB && colB != null ? parseNumberSmart(hitB.row?.[colB]) : null;

        out[item.key] = {
          label: hitA?.label || hitB?.label || null,
          current: cur,
          previous: prev,
        };
      }

      const ca = out.currentAssets?.current ?? null;
      const nca = out.nonCurrentAssets?.current ?? null;
      if (out.totalAssets?.current == null && ca != null && nca != null) {
        out.totalAssets = { label: "derived: currentAssets + nonCurrentAssets", current: ca + nca, previous: out.totalAssets?.previous ?? null };
      }

      const cl = out.currentLiabilities?.current ?? null;
      const ncl = out.nonCurrentLiabilities?.current ?? null;
      if (out.totalLiabilities?.current == null && cl != null && ncl != null) {
        out.totalLiabilities = { label: "derived: currentLiabilities + nonCurrentLiabilities", current: cl + ncl, previous: out.totalLiabilities?.previous ?? null };
      }

      const a = out.totalAssets?.current ?? null;
      const l = out.totalLiabilities?.current ?? null;
      const e = out.totalEquity?.current ?? null;
      if (a != null && l != null && e == null) {
        out.totalEquity = { label: "derived: assets - liabilities", current: a - l, previous: out.totalEquity?.previous ?? null };
      }

      return out;
    };

    // ✅ جديد: تعبئة القيم الناقصة من جداول أخرى مرشحة (Top 5)
    const fillMissingFromCandidates = (tables, candidates, out, wantKeys, noCompareFlag) => {
      if (!Array.isArray(candidates) || !candidates.length) return out;
      if (!Array.isArray(tables) || !tables.length) return out;

      const isMissing = (k) => out?.[k] == null || (typeof out?.[k] === "object" && out?.[k]?.current == null);

      for (const cand of candidates) {
        const t = tables.find((x) => Number(x?.index) === Number(cand.index));
        if (!t) continue;

        const cols = detectColumns(t);
        const picked = pickLatestColumns(cols);
        const latestCol = picked.latest?.col ?? null;
        const prevCol = !noCompareFlag ? picked.previous?.col ?? null : null;
        if (latestCol == null) continue;

        const tmp = extractBalanceSingleTable(t, latestCol, prevCol);

        for (const k of wantKeys) {
          if (!isMissing(k) && out[k] != null) continue;
          if (tmp[k] != null && (tmp[k]?.current ?? tmp[k]) != null) {
            out[k] = tmp[k];
          }
        }

        const stillMissing = wantKeys.some(isMissing);
        if (!stillMissing) break;
      }

      return out;
    };

    // DIAG
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
      });
    }

    /* =========================
       Pick income table A
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
       Pick balance table A
       ========================= */

    const bsDiagA = pickBestBalanceSheetTable(tablesPreview);

    let bestBalanceA = null;
    if (bsDiagA.bestTableIndex !== null && bsDiagA.bestTableIndex !== undefined) {
      const t = tablesPreview.find((x) => Number(x?.index) === Number(bsDiagA.bestTableIndex));
      if (t) bestBalanceA = { table: t, score: scoreBalanceTable(t), pickedBy: "diag" };
    }
    if (!bestBalanceA) {
      for (const t of tablesPreview) {
        const s = scoreBalanceTable(t);
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
        const bsDiagB = pickBestBalanceSheetTable(tablesPreviewPrev);

        let bestBalanceB = null;
        if (bsDiagB.bestTableIndex !== null && bsDiagB.bestTableIndex !== undefined) {
          const t = tablesPreviewPrev.find((x) => Number(x?.index) === Number(bsDiagB.bestTableIndex));
          if (t) bestBalanceB = { table: t, score: scoreBalanceTable(t), pickedBy: "diag" };
        }
        if (!bestBalanceB) {
          for (const t of tablesPreviewPrev) {
            const s = scoreBalanceTable(t);
            if (!bestBalanceB || s > bestBalanceB.score) bestBalanceB = { table: t, score: s, pickedBy: "fallbackScore" };
          }
        }

        if (bestBalanceB?.table) {
          const colsBalB = detectColumns(bestBalanceB.table);
          const pickedBalB = pickLatestColumns(colsBalB);
          const latestBalColB = pickedBalB.latest?.col ?? null;

          balanceExtract = extractBalanceTwoFiles(bestBalanceA.table, latestBalColA, bestBalanceB.table, latestBalColB);

          // ✅ محاولة تعبئة ناقص من مرشحات أخرى في كل ملف
          const keys = ["totalAssets","currentAssets","nonCurrentAssets","totalLiabilities","currentLiabilities","nonCurrentLiabilities","totalEquity"];
          balanceExtract = fillMissingFromCandidates(tablesPreview, bsDiagA.candidates, balanceExtract, keys, true);
          balanceExtract = fillMissingFromCandidates(tablesPreviewPrev, bsDiagB.candidates, balanceExtract, keys, true);

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
            },
          };
        } else {
          balanceExtract = latestBalColA != null ? extractBalanceSingleTable(bestBalanceA.table, latestBalColA, null) : {};
          const keys = ["totalAssets","currentAssets","nonCurrentAssets","totalLiabilities","currentLiabilities","nonCurrentLiabilities","totalEquity"];
          balanceExtract = fillMissingFromCandidates(tablesPreview, bsDiagA.candidates, balanceExtract, keys, true);

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
            },
            note: "No balance table found in file B; used file A latest only.",
          };
        }
      } else {
        balanceExtract = latestBalColA != null ? extractBalanceSingleTable(bestBalanceA.table, latestBalColA, prevBalColA) : {};

        // ✅ محاولة تعبئة ناقص من مرشحات أخرى (Top 5)
        const keys = ["totalAssets","currentAssets","nonCurrentAssets","totalLiabilities","currentLiabilities","nonCurrentLiabilities","totalEquity"];
        balanceExtract = fillMissingFromCandidates(tablesPreview, bsDiagA.candidates, balanceExtract, keys, noCompare);

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
          },
        };
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
        pickedColumns: {
          latest: pickedA.latest ? { col: pickedA.latest.col, year: pickedA.latest.years?.slice(-1)?.[0] ?? null } : null,
          previous: pickedA.previous ? { col: pickedA.previous.col, year: pickedA.previous.years?.slice(-1)?.[0] ?? null } : null,
          debug: pickedA.debug,
        },
        incomeStatementLite: incomeExtract,
        balanceSheetLite: balanceExtract,
        balancePickInfo: balancePicked,
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
