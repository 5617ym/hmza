// api/extract-financial/index.js
module.exports = async function (context, req) {

  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload
    };
  };

  try {

    const body = req.body || {};
    const normalized = body.normalized;
    const normalizedPrev = body.normalizedPrev || null;

    if (!normalized) {
      return send(400, { ok: false, error: "Missing normalized" });
    }

    const tablesPreview = Array.isArray(normalized.tablesPreview)
      ? normalized.tablesPreview
      : [];

    const pagesMeta = normalized.meta || null;

    /* =========================
       Helpers
       ========================= */

    const toLatinDigits = (s) => {
      const map = {
        "٠": "0","١": "1","٢": "2","٣": "3","٤": "4",
        "٥": "5","٦": "6","٧": "7","٨": "8","٩": "9"
      };

      return String(s || "").replace(/[٠-٩]/g, d => map[d] || d);
    };

    const normalizeSeparators = (s) => {
      return String(s || "")
        .replace(/٫/g, ".")
        .replace(/[٬،]/g, ",");
    };

    const norm = (s) =>
      toLatinDigits(normalizeSeparators(String(s || "")))
        .toLowerCase()
        .trim();

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

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      const isGroupedThousands = /^\d{1,3}([.,]\d{3})+$/;

      if (isGroupedThousands.test(s)) {
        const n = Number(s.replace(/[.,]/g, ""));
        return neg ? -n : n;
      }

      if (hasDot && hasComma) {
        const n = Number(s.replace(/,/g, ""));
        return neg ? -n : n;
      }

      if (!hasDot && hasComma) {
        if (/^\d{1,3}(,\d{3})+$/.test(s)) {
          const n = Number(s.replace(/,/g, ""));
          return neg ? -n : n;
        }
      }

      const n = Number(s);
      return neg ? -n : n;
    };

    const findYear = (text) => {
      const s = toLatinDigits(text);
      const m = s.match(/\b(20\d{2})\b/);
      return m ? Number(m[1]) : null;
    };

    const detectColumns = (table) => {

      const rows = table.sample || [];
      const colCount = table.columnCount || 0;

      const cols = [];

      for (let i = 0; i < colCount; i++) {

        const c = {
          col: i,
          years: [],
          hasNote: false
        };

        for (let r = 0; r < Math.min(5, rows.length); r++) {

          const cell = norm(rows[r][i]);

          const y = findYear(cell);

          if (y) c.years.push(y);

          if (cell.includes("إيضاح") || cell.includes("note")) {
            c.hasNote = true;
          }
        }

        c.years = [...new Set(c.years)];

        cols.push(c);
      }

      return cols;
    };

    const pickLatestColumns = (cols) => {

      const usable = cols.filter(c => !c.hasNote);

      const years = [];

      usable.forEach(c => c.years.forEach(y => years.push(y)));

      if (!years.length) {
        return { latest: null, previous: null };
      }

      const maxYear = Math.max(...years);

      const latest = usable.find(c => c.years.includes(maxYear));

      return {
        latest,
        previous: null
      };
    };

    const getRowLabel = (r) => {
      if (!Array.isArray(r)) return "";
      return norm(r[r.length - 1] || r[r.length - 2] || "");
    };

    const findRowByLabel = (rows, names) => {

      for (const r of rows) {

        const label = getRowLabel(r);

        if (!label) continue;

        for (const n of names) {

          if (label.includes(norm(n))) {
            return r;
          }

        }

      }

      return null;
    };

    /* =========================
       INCOME
       ========================= */

    const incomeNames = {
      revenue: ["الإيرادات","الايرادات"],
      costOfRevenue: ["تكلفة الإيرادات","تكلفة الايرادات"],
      grossProfit: ["مجمل الربح"],
      operatingProfit: ["الربح التشغيلي"]
    };

    let incomeExtract = {};

    const incomeTable = tablesPreview.find(t =>
      JSON.stringify(t.sample).includes("الإيرادات")
    );

    if (incomeTable) {

      const cols = detectColumns(incomeTable);
      const picked = pickLatestColumns(cols);

      const latestCol = picked.latest?.col;

      const rows = incomeTable.sample || [];

      for (const key in incomeNames) {

        const r = findRowByLabel(rows, incomeNames[key]);

        if (!r) {
          incomeExtract[key] = null;
          continue;
        }

        incomeExtract[key] = {
          label: getRowLabel(r),
          current: parseNumberSmart(r[latestCol]),
          previous: null
        };

      }

    }

    /* =========================
       BALANCE SHEET
       ========================= */

    let balanceExtract = {};

    const balanceTable = tablesPreview.find(t =>
      JSON.stringify(t.sample).includes("الموجودات")
    );

    if (balanceTable) {

      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);
      const latestCol = picked.latest?.col;

      const rows = [
        ...(balanceTable.sample || []),
        ...(balanceTable.sampleTail || [])
      ];

      const totalAssetsRow = findRowByLabel(rows, ["إجمالي الموجودات","إجمالي الأصول"]);
      const totalLiabilitiesRow = findRowByLabel(rows, ["إجمالي المطلوبات"]);
      const equityRow = findRowByLabel(rows, ["إجمالي حقوق الملكية"]);

      if (totalAssetsRow) {
        balanceExtract.totalAssets = {
          label: "إجمالي الأصول",
          current: parseNumberSmart(totalAssetsRow[latestCol]),
          previous: null
        };
      }

      if (totalLiabilitiesRow) {
        balanceExtract.totalLiabilities = {
          label: "إجمالي المطلوبات",
          current: parseNumberSmart(totalLiabilitiesRow[latestCol]),
          previous: null
        };
      }

      if (equityRow) {
        balanceExtract.totalEquity = {
          label: "إجمالي حقوق الملكية",
          current: parseNumberSmart(equityRow[latestCol]),
          previous: null
        };
      }

    }

    /* =========================
       CASH FLOW
       ========================= */

    let cashFlowExtract = {};

    const cashTable = tablesPreview.find(t => Number(t.index) === 4);

    if (cashTable) {

      const cols = detectColumns(cashTable);
      const picked = pickLatestColumns(cols);
      const latestCol = picked.latest?.col;

      const rows = [
        ...(cashTable.sample || []),
        ...(cashTable.sampleTail || [])
      ];

      const lastRow = rows[rows.length - 1];
      const prevRow = rows[rows.length - 2];

      const endingCash = parseNumberSmart(lastRow?.[latestCol]);
      const beginningCash = parseNumberSmart(prevRow?.[latestCol]);

      let netChange = null;

      if (endingCash != null && beginningCash != null) {
        netChange = endingCash - beginningCash;
      }

      cashFlowExtract = {

        endingCash: {
          label: "النقد نهاية السنة",
          current: endingCash,
          previous: null
        },

        beginningCash: {
          label: "النقد بداية السنة",
          current: beginningCash,
          previous: null
        },

        netChangeInCash: {
          label: "صافي التغير في النقد",
          current: netChange,
          previous: null
        }

      };

    }

    return send(200, {
      ok: true,
      financial: {
        pagesMeta,
        incomeStatementLite: incomeExtract,
        balanceSheetLite: balanceExtract,
        cashFlowLite: cashFlowExtract
      }
    });

  } catch (e) {

    return send(500, {
      ok: false,
      error: e.message || String(e)
    });

  }

};
