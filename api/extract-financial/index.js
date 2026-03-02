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

    // compare يجي من الواجهة أحيانًا
    const compare = body.compare ?? null;
    const noCompare =
      compare === null ||
      compare === undefined ||
      String(compare).trim() === "" ||
      String(compare).includes("بدون");

    // === DIAG FLAGS (NEW) ===
    // diag=1 -> يرجّع مرشحين الميزانية فقط (بدون استخراج قائمة الدخل)
    const diag =
      String(req.query?.diag || body.diag || "").toLowerCase() === "1" ||
      String(req.query?.diag || body.diag || "").toLowerCase() === "true";

    // target اختياري للمستقبل (balance / income)
    const target = String(req.query?.target || body.target || "").toLowerCase();

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    // عندك الآن tablesPreview (ليس tables)
    const tablesPreview = Array.isArray(normalized.tablesPreview) ? normalized.tablesPreview : [];

    const pagesMeta = normalized?.meta || null;

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
      // توحيد الفواصل العربية/الأوربية
      return String(s || "")
        .replace(/٫/g, ".") // Arabic decimal
        .replace(/[٬،]/g, ","); // Arabic thousands/comma
    };

    const norm = (s) => toLatinDigits(normalizeSeparators(String(s || ""))).toLowerCase().trim();

    /**
     * parseNumberSmart (FIXED)
     * - يتعامل مع:
     *   (1,234,567)
     *   ١٬٢٣٤٬٥٦٧
     *   ٢٫٢١٨,٦٦٢٫٧٣٥  => 2218662735  (تجميع آلاف مختلط)
     *   1,234,567.89
     *   1.234.567,89 (لو حصلت)
     */
    const parseNumberSmart = (raw) => {
      if (raw === null || raw === undefined) return null;

      let s = toLatinDigits(normalizeSeparators(String(raw))).trim();
      if (!s) return null;

      // سالب بين أقواس
      let neg = false;
      if (s.includes("(") && s.includes(")")) {
        neg = true;
        s = s.replace(/[()]/g, "");
      }

      // إزالة أي شيء غير الأرقام والفواصل والنقاط والإشارة
      s = s.replace(/[^\d.,\-+]/g, "");

      // أحيانًا يكون فيه أكثر من إشارة، نظفها
      s = s.replace(/(?!^)[\-+]/g, "");

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      const isGroupedThousands = (x) => /^\d{1,3}([.,]\d{3})+$/.test(x);

      // حالة نمط تجميع آلاف واضح
      if (isGroupedThousands(s)) {
        const n = Number(s.replace(/[.,]/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      // إذا فيه نقط + فواصل مع بعض:
      if (hasDot && hasComma) {
        // لو آخر جزء بعد آخر فاصلة/نقطة طوله 3 غالباً تجميع آلاف
        const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
        const tail = s.slice(lastSep + 1);

        if (/^\d{3}$/.test(tail)) {
          // اعتبرها كلها تجميع آلاف (مثل 2.218,662.735)
          const n = Number(s.replace(/[.,]/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }

        // غير ذلك: حدّد العشري من آخر فاصل (الأقرب أنه عشري)
        // إذا آخر فاصل هو ',' -> عشري أوروبي
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
          // احذف نقاط التجميع، وحول آخر ',' إلى '.'
          const parts = s.split(",");
          const dec = parts.pop(); // آخر جزء
          const intPart = parts.join("").replace(/\./g, "");
          const n = Number(intPart + "." + dec);
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        } else {
          // آخر فاصل هو '.' -> عشري أمريكي
          const parts = s.split(".");
          const dec = parts.pop();
          const intPart = parts.join("").replace(/,/g, "");
          const n = Number(intPart + "." + dec);
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
      }

      // إذا فقط فاصلة
      if (!hasDot && hasComma) {
        // إن كان نمط 1,234,567 اعتبره تجميع آلاف
        if (/^\d{1,3}(,\d{3})+$/.test(s)) {
          const n = Number(s.replace(/,/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
        // وإلا اعتبرها عشري (1,23)
        const n = Number(s.replace(",", "."));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      // إذا فقط نقطة
      if (hasDot && !hasComma) {
        // إن كان نمط 1.234.567 اعتبره تجميع آلاف
        if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
          const n = Number(s.replace(/\./g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
        // وإلا عشري عادي
        const n = Number(s);
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      // لا فواصل ولا نقاط
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

      if (!withYears.length)
        return { latest: null, previous: null, debug: { reason: "no years detected" } };

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

    const extractIncomeFromTable = (table, latestColIdx, prevColIdx) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];

      const want = [
        { key: "revenue", names: ["الإيرادات", "الايرادات", "المبيعات", "إيرادات", "Revenue"] },
        {
          key: "costOfRevenue",
          names: ["تكلفة الإيرادات", "تكلفة الايرادات", "تكلفة المبيعات", "Cost of revenue"],
        },
        { key: "grossProfit", names: ["مجمل الربح", "Gross profit"] },
        { key: "operatingProfit", names: ["الربح التشغيلي", "Operating profit", "الربح من العمليات"] },
        { key: "netProfitBeforeZakat", names: ["صافي ربح الفترة قبل الزكاة", "صافي ربح السنة قبل الزكاة"] },
        { key: "zakat", names: ["الزكاة"] },
        { key: "netProfit", names: ["صافي ربح الفترة", "صافي ربح السنة", "صافي الربح", "Net profit"] },
      ];

      const getRowLabel = (r) => {
        const last = norm(r?.[r.length - 1]);
        const prev = norm(r?.[r.length - 2]);
        return last || prev || "";
      };

      const findValue = (r, colIdx) => {
        if (colIdx === null || colIdx === undefined) return null;
        return parseNumberSmart(r?.[colIdx]);
      };

      const out = {};
      for (const item of want) {
        let found = null;
        for (const r of rows) {
          if (!Array.isArray(r)) continue;
          const label = getRowLabel(r);
          if (!label) continue;

          const ok = item.names.some((n) => label.includes(norm(n)));
          if (!ok) continue;

          const cur = findValue(r, latestColIdx);
          const prev = prevColIdx != null ? findValue(r, prevColIdx) : null;

          found = { label, current: cur, previous: prev };
          break;
        }
        out[item.key] = found;
      }
      return out;
    };

    /* =========================
       DIAG: Balance Sheet candidates from tablesPreview (NEW)
       ========================= */

    const normText2 = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const tableTextQuick = (t) => {
      const rows = Array.isArray(t?.sample) ? t.sample : [];
      let out = [];
      for (let r = 0; r < rows.length && r < 30; r++) {
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
        "financial position",
      ];
      const keysSupport = [
        "الأصول",
        "assets",
        "الموجودات",
        "المطلوبات",
        "liabilities",
        "الالتزامات",
        "حقوق الملكية",
        "equity",
        "إجمالي الأصول",
        "total assets",
        "إجمالي المطلوبات",
        "total liabilities",
      ];

      let score = 0;
      for (const k of keysStrong) if (text.includes(normText2(k))) score += 50;
      for (const k of keysSupport) if (text.includes(normText2(k))) score += 10;

      // مكافأة إذا ظهر "متداولة/غير متداولة" لأنها عادة بالميزانية
      if (text.includes("متداولة") || text.includes("غير متداولة")) score += 8;

      return score;
    };

    if (diag && (target === "" || target === "balance" || target === "balancesheet")) {
      const ranked = tablesPreview
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
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      return send(200, {
        ok: true,
        diag: true,
        kind: "balanceSheetCandidates",
        pagesMeta,
        tablesPreviewCount: tablesPreview.length,
        found: ranked.length,
        ranked,
        hint: "اختر index الجدول الأعلى Score، ثم سنثبت استخراج الميزانية منه في الخطوة التالية.",
      });
    }

    /* =========================
       1) اختيار أفضل جدول قائمة دخل
       ========================= */

    let bestIncome = null;
    for (const t of tablesPreview) {
      const s = scoreIncomeTable(t);
      if (!bestIncome || s > bestIncome.score) bestIncome = { table: t, score: s };
    }

    if (!bestIncome) {
      return send(200, {
        ok: true,
        financial: {
          pagesMeta,
          note: "لا توجد tablesPreview داخل normalized.",
          tablesPreviewCount: tablesPreview.length,
        },
      });
    }

    /* =========================
       2) تحديد أعمدة السنة الأحدث (ومقارنة إن وجدت)
       ========================= */

    const cols = detectColumns(bestIncome.table);
    const picked = pickLatestColumns(cols);

    const latestCol = picked.latest?.col ?? null;
    const prevCol = !noCompare ? picked.previous?.col ?? null : null;

    /* =========================
       3) استخراج أرقام قائمة الدخل من نفس الجدول
       ========================= */

    const incomeExtract =
      latestCol != null ? extractIncomeFromTable(bestIncome.table, latestCol, prevCol) : {};

    /* =========================
       4) استخراج قائمة المركز المالي (Balance Sheet) من index ثابت = 2
       - بدون مقارنة: أحدث سنة فقط
       - مع مقارنة: أحدث سنة + السنة السابقة
       ========================= */

    const BALANCE_TABLE_INDEX = 2;
    const balanceTable = tablesPreview.find((t) => Number(t?.index) === BALANCE_TABLE_INDEX) || null;

    const balanceCols = balanceTable ? detectColumns(balanceTable) : [];
    const balancePicked = balanceTable
      ? pickLatestColumns(balanceCols)
      : { latest: null, previous: null, debug: { reason: "balance table not found" } };

    const balanceLatestCol = balancePicked.latest?.col ?? null;
    const balancePrevCol = !noCompare ? balancePicked.previous?.col ?? null : null;

    const extractBalanceFromTable = (table, latestColIdx, prevColIdx) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];

      const want = [
        { key: "totalAssets", names: ["إجمالي الأصول", "اجمالي الاصول", "total assets"] },
        { key: "currentAssets", names: ["إجمالي الأصول المتداولة", "اجمالي الاصول المتداولة", "الأصول المتداولة", "الاصول المتداولة", "current assets"] },
        { key: "nonCurrentAssets", names: ["إجمالي الأصول غير المتداولة", "اجمالي الاصول غير المتداولة", "الأصول غير المتداولة", "الاصول غير المتداولة", "non-current assets"] },

        { key: "totalLiabilities", names: ["إجمالي المطلوبات", "اجمالي المطلوبات", "إجمالي الالتزامات", "اجمالي الالتزامات", "total liabilities"] },
        { key: "currentLiabilities", names: ["إجمالي المطلوبات المتداولة", "اجمالي المطلوبات المتداولة", "المطلوبات المتداولة", "current liabilities"] },
        { key: "nonCurrentLiabilities", names: ["إجمالي المطلوبات غير المتداولة", "اجمالي المطلوبات غير المتداولة", "المطلوبات غير المتداولة", "non-current liabilities"] },

        { key: "totalEquity", names: ["إجمالي حقوق الملكية", "اجمالي حقوق الملكية", "حقوق الملكية", "total equity", "equity"] },
      ];

      const getRowLabel = (r) => {
        const last = norm(r?.[r.length - 1]);
        const prev = norm(r?.[r.length - 2]);
        return last || prev || "";
      };

      const findValue = (r, colIdx) => {
        if (colIdx === null || colIdx === undefined) return null;
        return parseNumberSmart(r?.[colIdx]);
      };

      const out = {};
      for (const item of want) {
        let found = null;
        for (const r of rows) {
          if (!Array.isArray(r)) continue;

          const label = getRowLabel(r);
          if (!label) continue;

          const ok = item.names.some((n) => label.includes(norm(n)));
          if (!ok) continue;

          const cur = findValue(r, latestColIdx);
          const prev = prevColIdx != null ? findValue(r, prevColIdx) : null;

          found = { label, current: cur, previous: prev };
          break;
        }
        out[item.key] = found;
      }
      return out;
    };

    const balanceSheetLite =
      balanceTable && balanceLatestCol != null
        ? extractBalanceFromTable(balanceTable, balanceLatestCol, balancePrevCol)
        : { note: "Balance table not found or columns not detected", tableIndex: BALANCE_TABLE_INDEX };

    return send(200, {
      ok: true,
      financial: {
        pagesMeta,

        selectionPolicy: {
          noCompare,
          rule: noCompare
            ? "No compare selected -> pick latest year only (prefer 3-month if quarterly)."
            : "Compare selected -> pick latest year + previous year (prefer same period type).",
        },

        bestIncomeTable: {
          index: bestIncome.table.index,
          score: bestIncome.score,
          columnCount: bestIncome.table.columnCount,
          rowCount: bestIncome.table.rowCount,
        },

        columnsDetected: cols.map((c) => ({
          col: c.col,
          years: c.years,
          hasThreeMonths: c.hasThreeMonths,
          hasNineMonths: c.hasNineMonths,
          hasAnnual: c.hasAnnual,
          hasNote: c.hasNote,
        })),

        pickedColumns: {
          latest: picked.latest ? { col: picked.latest.col, year: picked.latest.years?.slice(-1)?.[0] ?? null } : null,
          previous: picked.previous
            ? { col: picked.previous.col, year: picked.previous.years?.slice(-1)?.[0] ?? null }
            : null,
          debug: picked.debug,
        },

        incomeStatementLite: incomeExtract,

        // ✅ Balance Sheet additions
        balanceSheetTable: balanceTable
          ? { index: balanceTable.index, columnCount: balanceTable.columnCount, rowCount: balanceTable.rowCount }
          : null,

        balanceColumnsDetected: balanceCols.map((c) => ({
          col: c.col,
          years: c.years,
          hasThreeMonths: c.hasThreeMonths,
          hasNineMonths: c.hasNineMonths,
          hasAnnual: c.hasAnnual,
          hasNote: c.hasNote,
        })),

        balancePickedColumns: {
          latest: balancePicked.latest
            ? { col: balancePicked.latest.col, year: balancePicked.latest.years?.slice(-1)?.[0] ?? null }
            : null,
          previous: balancePicked.previous
            ? { col: balancePicked.previous.col, year: balancePicked.previous.years?.slice(-1)?.[0] ?? null }
            : null,
          debug: balancePicked.debug,
        },

        balanceSheetLite,

        sample: bestIncome.table.sample?.slice(0, 12) || [],
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
