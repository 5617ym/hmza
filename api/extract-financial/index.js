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
       Row matching
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
       BALANCE SHEET (FIXED: multi-table)
       ========================= */

    const normText2 = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

    const tableTextQuick = (t) => {
      const rows = getTableRows(t);
      const out = [];
      for (let r = 0; r < rows.length && r < 70; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length && c < 14; c++) {
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
        "إجمالي الموجودات","إجمالي الأصول","total assets",
        "إجمالي المطلوبات","total liabilities",
        "إجمالي حقوق الملكية","total equity",
        "إجمالي المطلوبات وحقوق الملكية",
      ];

      let score = 0;
      for (const k of keysStrong) if (text.includes(normText2(k))) score += 60;
      for (const k of keysSupport) if (text.includes(normText2(k))) score += 12;

      if (text.includes("متداولة") || text.includes("غير متداولة")) score += 8;

      return score;
    };

    const rankBalanceTables = (tables) => {
      const ranked = (Array.isArray(tables) ? tables : [])
        .map((t) => {
          const text = tableTextQuick(t);
          const score = scoreBalanceSheetText(text);
          return {
            table: t,
            index: t?.index ?? null,
            score,
            page: t?.pageNumber ?? t?.page ?? null,
            columnCount: t?.columnCount ?? null,
            rowCount: t?.rowCount ?? null,
            snippet: text.slice(0, 260),
            hasTail: Array.isArray(t?.sampleTail) && t.sampleTail.length > 0,
          };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      return ranked;
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
        exclude: ["غير المتداولة", "غير المتداوله", "non-current"],
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
        exclude: ["وحقوق", "and equity", "and shareholders"],
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

    // ✅ جديد: استخراج من عدة جداول (أصول + مطلوبات/حقوق ملكية)
    const extractBalanceFromRankedTables = (ranked, noCompareFlag) => {
      const out = {
        totalAssets: null,
        currentAssets: null,
        nonCurrentAssets: null,
        totalLiabilities: null,
        currentLiabilities: null,
        nonCurrentLiabilities: null,
        totalEquity: null,
      };

      const evidence = []; // لشرح من أي جدول أخذنا كل رقم

      // خذ أفضل 10 جداول مرشحة (عادةً تكفي)
      const top = ranked.slice(0, 10);

      // نبحث عن كل بند عبر كل جدول، مع أعمدة مناسبة لكل جدول
      for (const item of wantBalance) {
        let found = null;

        for (const cand of top) {
          const t = cand.table;
          const rows = getTableRows(t);

          // لازم يكون عنده tail غالباً عشان الإجماليات بالأسفل
          // لكن ما نمنعه، بعض التقارير تحط الإجمالي في النص
          const cols = detectColumns(t);
          const picked = pickLatestColumns(cols);

          const latestCol = picked.latest?.col ?? null;
          const prevCol = noCompareFlag ? null : picked.previous?.col ?? null;

          if (latestCol == null) continue;

          const hit = findRowByLabel(rows, item);
          if (!hit) continue;

          const cur = parseNumberSmart(hit.row?.[latestCol]);
          const prev = prevCol != null ? parseNumberSmart(hit.row?.[prevCol]) : null;

          // لازم current يكون رقم فعلاً
          if (cur == null) continue;

          found = {
            value: { label: hit.label, current: cur, previous: prev },
            meta: {
              tableIndex: t.index,
              pageNumber: t.pageNumber ?? null,
              pickedColumns: {
                latest: picked.latest ? { col: picked.latest.col, year: picked.latest.years?.slice(-1)?.[0] ?? null } : null,
                previous: picked.previous ? { col: picked.previous.col, year: picked.previous.years?.slice(-1)?.[0] ?? null } : null,
              },
              score: cand.score,
              hasTail: cand.hasTail,
            },
          };
          break;
        }

        if (found) {
          out[item.key] = found.value;
          evidence.push({ key: item.key, ...found.meta });
        }
      }

      // ✅ اشتقاقات لو بعض الإجماليات ناقصة
      const ca = out.currentAssets?.current ?? null;
      const nca = out.nonCurrentAssets?.current ?? null;
      if (out.totalAssets?.current == null && ca != null && nca != null) {
        out.totalAssets = { label: "derived: currentAssets + nonCurrentAssets", current: ca + nca, previous: null };
      }

      const cl = out.currentLiabilities?.current ?? null;
      const ncl = out.nonCurrentLiabilities?.current ?? null;
      if (out.totalLiabilities?.current == null && cl != null && ncl != null) {
        out.totalLiabilities = { label: "derived: currentLiabilities + nonCurrentLiabilities", current: cl + ncl, previous: null };
      }

      const a = out.totalAssets?.current ?? null;
      const l = out.totalLiabilities?.current ?? null;
      const e = out.totalEquity?.current ?? null;
      if (a != null && l != null && e == null) {
        out.totalEquity = { label: "derived: assets - liabilities", current: a - l, previous: null };
      }

      return { out, evidence };
    };

    // DIAG: اعرض أفضل مرشحين للميزانية
    if (diag && (target === "" || target === "balance" || target === "balancesheet")) {
      const ranked = rankBalanceTables(tablesPreview);
      return send(200, {
        ok: true,
        diag: true,
        kind: "balanceSheetCandidates",
        pagesMeta,
        tablesPreviewCount: tablesPreview.length,
        found: ranked.length,
        ranked: ranked.slice(0, 12).map((x) => ({
          index: x.index,
          score: x.score,
          page: x.page,
          rowCount: x.rowCount,
          columnCount: x.columnCount,
          hasTail: x.hasTail,
          snippet: x.snippet,
        })),
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
       Balance Sheet extraction (multi-table)
       ========================= */

    const rankedBalA = rankBalanceTables(tablesPreview);
    const balA = extractBalanceFromRankedTables(rankedBalA, noCompare);

    let balanceExtract = balA.out;
    let balancePickInfo = {
      fileA: {
        candidates: rankedBalA.slice(0, 10).map((x) => ({
          index: x.index,
          score: x.score,
          page: x.page,
          rowCount: x.rowCount,
          columnCount: x.columnCount,
          hasTail: x.hasTail,
          snippet: x.snippet,
        })),
        evidence: balA.evidence,
      },
    };

    // Compare mode (2 files): current من A ، previous من B
    if (usingTwoFiles) {
      const rankedBalB = rankBalanceTables(tablesPreviewPrev);
      const balB = extractBalanceFromRankedTables(rankedBalB, true /* noCompare for B side (we take its latest as previous) */);

      // امزج previous من B داخل نفس keys
      const merged = {};
      for (const k of Object.keys(balanceExtract)) {
        const curObj = balanceExtract[k];
        const prevObj = balB.out[k];

        if (curObj && typeof curObj === "object") {
          merged[k] = {
            ...curObj,
            previous: prevObj?.current ?? curObj.previous ?? null,
          };
        } else {
          merged[k] = curObj;
        }
      }

      // اشتقاق equity إذا ناقصة بعد الدمج
      const aCur = merged.totalAssets?.current ?? null;
      const lCur = merged.totalLiabilities?.current ?? null;
      if ((merged.totalEquity?.current ?? null) == null && aCur != null && lCur != null) {
        merged.totalEquity = { label: "derived: assets - liabilities", current: aCur - lCur, previous: merged.totalEquity?.previous ?? null };
      }

      balanceExtract = merged;
      balancePickInfo.fileB = {
        candidates: rankedBalB.slice(0, 10).map((x) => ({
          index: x.index,
          score: x.score,
          page: x.page,
          rowCount: x.rowCount,
          columnCount: x.columnCount,
          hasTail: x.hasTail,
          snippet: x.snippet,
        })),
        evidence: balB.evidence,
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
        pickedColumns: {
          latest: pickedA.latest ? { col: pickedA.latest.col, year: pickedA.latest.years?.slice(-1)?.[0] ?? null } : null,
          previous: pickedA.previous ? { col: pickedA.previous.col, year: pickedA.previous.years?.slice(-1)?.[0] ?? null } : null,
          debug: pickedA.debug,
        },
        incomeStatementLite: incomeExtract,
        balanceSheetLite: balanceExtract,
        balancePickInfo,
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
