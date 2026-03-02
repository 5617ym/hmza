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

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    // عندك الآن tablesPreview (ليس tables)
    const tablesPreview = Array.isArray(normalized.tablesPreview)
      ? normalized.tablesPreview
      : [];

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
        "٫": ".", // decimal
        "٬": ",", // thousands
      };
      return String(s || "").replace(/[٠-٩۰-۹٫٬]/g, (ch) => map[ch] ?? ch);
    };

    const norm = (s) => toLatinDigits(String(s || "")).toLowerCase().trim();

    // يدعم: (1,234,567.89) و ١٫٢٣٤٫٥٦٧ و ١,٢٣٤,٥٦٧ إلخ
    const parseNumberSmart = (raw) => {
      if (raw === null || raw === undefined) return null;
      let s = toLatinDigits(String(raw)).trim();
      if (!s) return null;

      // سالب بين أقواس
      let neg = false;
      if (s.includes("(") && s.includes(")")) {
        neg = true;
        s = s.replace(/[()]/g, "");
      }

      // إزالة أي حروف
      s = s.replace(/[^\d.,\-+]/g, "");

      // إزالة فواصل آلاف
      s = s.replace(/,/g, "");

      // لو بقي أكثر من نقطة، خذ أول وحدة فقط (احتياط)
      const firstDot = s.indexOf(".");
      if (firstDot !== -1) {
        const before = s.slice(0, firstDot + 1);
        const after = s.slice(firstDot + 1).replace(/\./g, "");
        s = before + after;
      }

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };

    const findYear = (text) => {
      // بعد تحويل الأرقام العربية → لاتينية
      const s = toLatinDigits(text);
      const m = s.match(/\b(20\d{2})\b/);
      if (!m) return null;
      const y = Number(m[1]);
      return y >= 2000 && y <= 2100 ? y : null;
    };

    const headerRowLimit = 5;
    const detectColumns = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const colCount = Number(table?.columnCount || 0);

      // meta per column
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

          // سنوي
          if (t.includes("ديسمبر") || t.includes("السنة") || t.includes("منتهية")) cols[c].hasAnnual = true;

          // إيضاح
          if (t.includes("إيضاح") || t.includes("ايضاح") || t === "إيضاح") cols[c].hasNote = true;
        }
      }

      // simplify years
      for (const c of cols) {
        c.years = Array.from(new Set(c.years)).sort((a, b) => a - b);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {
      // استبعد أعمدة الإيضاح
      const candidates = cols.filter((c) => !c.hasNote);

      // أعمدة فيها سنوات
      const withYears = candidates
        .map((c) => ({
          ...c,
          latestYear: c.years.length ? c.years[c.years.length - 1] : null,
          // أولوية: 3 أشهر > 9 أشهر > سنوي > غير معروف
          periodScore: c.hasThreeMonths ? 3 : c.hasNineMonths ? 2 : c.hasAnnual ? 1 : 0,
        }))
        .filter((c) => c.latestYear);

      if (!withYears.length) return { latest: null, previous: null, debug: { reason: "no years detected" } };

      // أحدث سنة
      const maxYear = Math.max(...withYears.map((c) => c.latestYear));

      const latestCandidates = withYears
        .filter((c) => c.latestYear === maxYear)
        .sort((a, b) => {
          // فضّل 3 أشهر ثم 9 أشهر ثم سنوي
          if (b.periodScore !== a.periodScore) return b.periodScore - a.periodScore;
          // ثم فضّل العمود الأيمن (عادة الأحدث)
          return b.col - a.col;
        });

      const latest = latestCandidates[0];

      // السابقة (للمقارنة)
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

      return {
        latest,
        previous,
        debug: { maxYear, prevYear, yearsAll },
      };
    };

    const scoreIncomeTable = (table) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];
      const joined = norm(rows.map((r) => (Array.isArray(r) ? r.join(" ") : "")).join("\n"));

      // كلمات قوية لقائمة الدخل
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

      // إذا فيه "إيضاح" عادة موجود
      if (joined.includes("إيضاح") || joined.includes("ايضاح")) score += 1;

      // إذا عدد الأعمدة كبير غالباً ربع
      const cc = Number(table?.columnCount || 0);
      if (cc >= 5) score += 1;

      return score;
    };

    const extractIncomeFromTable = (table, latestColIdx, prevColIdx) => {
      const rows = Array.isArray(table?.sample) ? table.sample : [];

      const want = [
        { key: "revenue", names: ["الإيرادات", "الايرادات", "Revenue"] },
        { key: "costOfRevenue", names: ["تكلفة الإيرادات", "تكلفة الايرادات", "Cost of revenue", "تكلفة المبيعات"] },
        { key: "grossProfit", names: ["مجمل الربح", "Gross profit"] },
        { key: "operatingProfit", names: ["الربح التشغيلي", "Operating profit", "الربح من العمليات"] },
        { key: "netProfitBeforeZakat", names: ["صافي ربح الفترة قبل الزكاة", "صافي ربح السنة قبل الزكاة"] },
        { key: "zakat", names: ["الزكاة"] },
        { key: "netProfit", names: ["صافي ربح الفترة", "صافي ربح السنة", "صافي الربح", "Net profit"] },
      ];

      const getRowLabel = (r) => {
        // في كثير من الجداول "البيان" في آخر عمود، وأحيانًا قبل الأخير
        const last = norm(r?.[r.length - 1]);
        const prev = norm(r?.[r.length - 2]);
        // لو آخر خلية فاضية خذ اللي قبلها
        return last || prev || "";
      };

      const findValue = (r, colIdx) => {
        if (colIdx === null || colIdx === undefined) return null;
        const cell = r?.[colIdx];
        return parseNumberSmart(cell);
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

          // خذ قيم العمود المحدد
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

    const incomeExtract = latestCol != null
      ? extractIncomeFromTable(bestIncome.table, latestCol, prevCol)
      : {};

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
          latest: picked.latest
            ? { col: picked.latest.col, year: picked.latest.years?.slice(-1)?.[0] ?? null }
            : null,
          previous: picked.previous
            ? { col: picked.previous.col, year: picked.previous.years?.slice(-1)?.[0] ?? null }
            : null,
          debug: picked.debug,
        },

        incomeStatementLite: incomeExtract,

        // عينة صغيرة للعرض فقط
        sample: bestIncome.table.sample?.slice(0, 12) || [],
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
