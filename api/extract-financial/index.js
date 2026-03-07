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
        "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
        "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9"
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
        .replace(/\s+/g, " ")
        .trim();

    const stripNonTextNoise = (s) => {
      return norm(s).replace(/[|ـ\-–—_:;]+/g, " ").replace(/\s+/g, " ").trim();
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

      if (!s) return null;

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      const isGroupedThousands = /^\d{1,3}([.,]\d{3})+$/;

      if (isGroupedThousands.test(s)) {
        const n = Number(s.replace(/[.,]/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (hasDot && hasComma) {
        const n = Number(s.replace(/,/g, ""));
        return Number.isFinite(n) ? (neg ? -n : n) : null;
      }

      if (!hasDot && hasComma) {
        if (/^\d{1,3}(,\d{3})+$/.test(s)) {
          const n = Number(s.replace(/,/g, ""));
          return Number.isFinite(n) ? (neg ? -n : n) : null;
        }
      }

      const n = Number(s);
      return Number.isFinite(n) ? (neg ? -n : n) : null;
    };

    const findYear = (text) => {
      const s = toLatinDigits(String(text || ""));
      const m = s.match(/\b(20\d{2})\b/);
      return m ? Number(m[1]) : null;
    };

    const detectColumns = (table) => {

      const rows = table.sample || [];
      const colCount = Number(table.columnCount) || 0;

      const cols = [];

      for (let i = 0; i < colCount; i++) {

        const c = {
          col: i,
          years: [],
          hasNote: false
        };

        for (let r = 0; r < Math.min(6, rows.length); r++) {

          const cell = norm(rows?.[r]?.[i]);

          const y = findYear(cell);

          if (y) c.years.push(y);

          if (cell.includes("إيضاح") || cell.includes("ايضاح") || cell.includes("note")) {
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

      const uniqueYears = [...new Set(years)].sort((a, b) => b - a);
      const maxYear = uniqueYears[0];
      const prevYear = uniqueYears[1] || null;

      const latest = usable.find(c => c.years.includes(maxYear)) || null;
      const previous = prevYear
        ? (usable.find(c => c.years.includes(prevYear)) || null)
        : null;

      return { latest, previous };
    };

    const getCell = (row, index) => {
      if (!Array.isArray(row)) return "";
      if (index === null || index === undefined) return "";
      return row[index];
    };

    const getRowLabelFromRow = (row) => {
      if (!Array.isArray(row) || !row.length) return "";

      const candidates = [];

      for (let i = row.length - 1; i >= 0; i--) {
        const raw = String(row[i] || "").trim();
        const asNumber = parseNumberSmart(raw);

        if (raw && asNumber === null) {
          candidates.push(raw);
        }
      }

      return stripNonTextNoise(candidates[0] || "");
    };

    const buildRowLabelVariants = (row) => {
      const label = getRowLabelFromRow(row);
      const clean = stripNonTextNoise(label);

      const words = clean.split(" ").filter(Boolean);
      const head = words.slice(0, 5).join(" ").trim();
      const tail = words.slice(-5).join(" ").trim();
      const merged = [head, tail].filter(Boolean).join(" ").trim();

      return {
        labelFull: clean,
        labelSample: head,
        labelTail: tail,
        labelMerged: merged
      };
    };

    const rowHasNumericValueAt = (row, colIndex) => {
      if (!Array.isArray(row)) return false;
      if (colIndex === null || colIndex === undefined) return false;
      return parseNumberSmart(row[colIndex]) !== null;
    };

    const findRowByLabel = (rows, names) => {

      for (const r of rows) {

        const label = getRowLabelFromRow(r);

        if (!label) continue;

        for (const n of names) {
          if (label.includes(norm(n))) {
            return r;
          }
        }
      }

      return null;
    };

    const tableTextBlob = (table) => {
      return norm(JSON.stringify([
        ...(table.sample || []),
        ...(table.sampleTail || [])
      ]));
    };

    const scoreIncomeTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

      if (text.includes("الإيرادات") || text.includes("الايرادات")) score += 8;
      if (text.includes("تكلفة الإيرادات") || text.includes("تكلفة الايرادات")) score += 6;
      if (text.includes("مجمل الربح")) score += 6;
      if (text.includes("الربح التشغيلي")) score += 6;
      if (text.includes("قائمة الدخل")) score += 4;
      if (text.includes("الربح")) score += 2;
      if (text.includes("المراجعة") || text.includes("أمر المراجعة") || text.includes("امر المراجعة")) score -= 10;
      if (text.includes("الموجودات") || text.includes("الأصول")) score -= 4;
      if (text.includes("التدفقات النقدية")) score -= 4;

      return score;
    };

    const pickBestIncomeTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreIncomeTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    const scoreBalanceTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

      if (text.includes("الموجودات")) score += 7;
      if (text.includes("الأصول")) score += 7;
      if (text.includes("المطلوبات")) score += 7;
      if (text.includes("حقوق الملكية")) score += 7;
      if (text.includes("إجمالي الموجودات") || text.includes("إجمالي الأصول")) score += 8;
      if (text.includes("إجمالي المطلوبات")) score += 8;
      if (text.includes("إجمالي حقوق الملكية")) score += 8;
      if (text.includes("قائمة المركز المالي") || text.includes("المركز المالي")) score += 5;

      if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 6;
      if (text.includes("التدفقات النقدية")) score -= 6;

      return score;
    };

    const pickBestBalanceTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreBalanceTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    const scoreCashFlowTable = (table) => {
      const text = tableTextBlob(table);
      let score = 0;

      if (text.includes("التدفقات النقدية")) score += 8;
      if (text.includes("النقد") || text.includes("النقدية")) score += 4;
      if (text.includes("صافي")) score += 2;
      if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 4;
      if (text.includes("الموجودات") || text.includes("حقوق الملكية")) score -= 4;

      return score;
    };

    const pickBestCashTable = (tables) => {
      let best = null;
      let bestScore = -Infinity;

      for (const t of tables) {
        const score = scoreCashFlowTable(t);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }

      return bestScore > 0 ? best : null;
    };

    const mergeTableRows = (table) => {
      return [
        ...(Array.isArray(table?.sample) ? table.sample : []),
        ...(Array.isArray(table?.sampleTail) ? table.sampleTail : [])
      ];
    };

    const hasAnyNameMatch = (text, names) => {
      const s = stripNonTextNoise(text);
      return names.some(n => s.includes(norm(n)));
    };

    const scoreBalanceSheetRow = (row, targetNames, latestCol, rowIndex, totalRows, targetKey) => {

      const variants = buildRowLabelVariants(row);

      const texts = [
        variants.labelFull,
        variants.labelMerged,
        variants.labelSample,
        variants.labelTail
      ].filter(Boolean);

      let score = 0;

      /* =========================
         Match label
      ========================= */

      for (const t of texts) {
        if (hasAnyNameMatch(t, targetNames)) {
          score += 15;
          break;
        }
      }

      const full = variants.labelFull;

      const isTotalRow =
        full.includes("إجمالي") ||
        full.includes("المجموع") ||
        full.includes("total");

      const isSubTotalRow =
        full.includes("الفرعي") ||
        full.includes("subtotal");

      const isAssets =
        full.includes("الأصول") ||
        full.includes("الموجودات");

      const isLiabilities =
        full.includes("المطلوبات") ||
        full.includes("الالتزامات");

      const isEquity =
        full.includes("حقوق الملكية");

      /* =========================
         Numeric check
      ========================= */

      if (!rowHasNumericValueAt(row, latestCol)) {
        score -= 12;
      } else {
        score += 3;
      }

      /* =========================
         Row type adjustments
      ========================= */

      if (isTotalRow) {
        score += 5;
      }

      if (isSubTotalRow) {
        score -= 3;
      }

      /* =========================
         Prevent wrong totals
      ========================= */

      const subKeys = [
        "currentAssets",
        "nonCurrentAssets",
        "currentLiabilities",
        "nonCurrentLiabilities"
      ];

      const totalKeys = [
        "totalAssets",
        "totalLiabilities",
        "totalEquity"
      ];

      // لا تسمح لصف الإجمالي أن يكون بند فرعي
      if (subKeys.includes(targetKey) && isTotalRow) {
        score -= 25;
      }

      // شجع صف الإجمالي للبنود الكلية
      if (totalKeys.includes(targetKey) && isTotalRow) {
        score += 8;
      }

      /* =========================
         Context hints
      ========================= */

      if (targetKey.includes("Assets") && isAssets) {
        score += 3;
      }

      if (targetKey.includes("Liabilities") && isLiabilities) {
        score += 3;
      }

      if (targetKey === "totalEquity" && isEquity) {
        score += 5;
      }

      /* =========================
         Position weight
      ========================= */

      const nearBottomRatio = totalRows > 0 ? (rowIndex / totalRows) : 0;
      score += nearBottomRatio * 4;

      return score;
    };

    const findBestBalanceSheetMatch = (rows, targetNames, latestCol, targetKey) => {
      let bestRow = null;
      let bestScore = -Infinity;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const score = scoreBalanceSheetRow(
          row,
          targetNames,
          latestCol,
          i,
          rows.length,
          targetKey
        );

        if (score > bestScore) {
          bestRow = row;
          bestScore = score;
        }
      }

      return bestScore > 0 ? bestRow : null;
    };

    const makeValueObject = (row, labelOverride, latestCol, previousCol) => {
      if (!row) return null;

      return {
        label: labelOverride || getRowLabelFromRow(row) || null,
        current: latestCol !== null && latestCol !== undefined
          ? parseNumberSmart(getCell(row, latestCol))
          : null,
        previous: previousCol !== null && previousCol !== undefined
          ? parseNumberSmart(getCell(row, previousCol))
          : null
      };
    };

    const isMissingValueObj = (obj) => {
      return !obj || (obj.current === null && obj.previous === null);
    };

    /* =========================
       INCOME
       ========================= */

    const incomeNames = {
      revenue: ["الإيرادات", "الايرادات"],
      costOfRevenue: ["تكلفة الإيرادات", "تكلفة الايرادات"],
      grossProfit: ["مجمل الربح"],
      operatingProfit: ["الربح التشغيلي"]
    };

    let incomeExtract = {};

    const incomeTable = pickBestIncomeTable(tablesPreview);

    if (incomeTable) {

      const cols = detectColumns(incomeTable);
      const picked = pickLatestColumns(cols);

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = Array.isArray(incomeTable.sample) ? incomeTable.sample : [];

      for (const key in incomeNames) {

        const r = findRowByLabel(rows, incomeNames[key]);

        if (!r) {
          incomeExtract[key] = null;
          continue;
        }

        incomeExtract[key] = makeValueObject(r, getRowLabelFromRow(r), latestCol, previousCol);
      }
    }

    /* =========================
       BALANCE SHEET
       ========================= */

    let balanceExtract = {};

    const balanceNames = {
      totalAssets: ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول", "إجمالي الموجودات والأصول"],
      currentAssets: ["الموجودات المتداولة", "الأصول المتداولة", "إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة"],
      nonCurrentAssets: ["الموجودات غير المتداولة", "الأصول غير المتداولة", "إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"],
      totalLiabilities: ["إجمالي المطلوبات", "مجموع المطلوبات", "إجمالي الالتزامات", "مجموع الالتزامات"],
      currentLiabilities: ["المطلوبات المتداولة", "الالتزامات المتداولة", "إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"],
      nonCurrentLiabilities: ["المطلوبات غير المتداولة", "الالتزامات غير المتداولة", "إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"],
      totalEquity: ["إجمالي حقوق الملكية", "مجموع حقوق الملكية", "إجمالي حقوق المساهمين", "حقوق الملكية"]
    };

    const balanceTable = pickBestBalanceTable(tablesPreview);

    if (balanceTable) {

      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(balanceTable);

      const totalAssetsRow = findBestBalanceSheetMatch(rows, balanceNames.totalAssets, latestCol, "totalAssets");
      const currentAssetsRow = findBestBalanceSheetMatch(rows, balanceNames.currentAssets, latestCol, "currentAssets");
      const nonCurrentAssetsRow = findBestBalanceSheetMatch(rows, balanceNames.nonCurrentAssets, latestCol, "nonCurrentAssets");

      const totalLiabilitiesRow = findBestBalanceSheetMatch(rows, balanceNames.totalLiabilities, latestCol, "totalLiabilities");
      const currentLiabilitiesRow = findBestBalanceSheetMatch(rows, balanceNames.currentLiabilities, latestCol, "currentLiabilities");
      const nonCurrentLiabilitiesRow = findBestBalanceSheetMatch(rows, balanceNames.nonCurrentLiabilities, latestCol, "nonCurrentLiabilities");

      const totalEquityRow = findBestBalanceSheetMatch(rows, balanceNames.totalEquity, latestCol, "totalEquity");

      balanceExtract.totalAssets = makeValueObject(totalAssetsRow, "إجمالي الأصول", latestCol, previousCol);
      balanceExtract.currentAssets = makeValueObject(currentAssetsRow, "الأصول المتداولة", latestCol, previousCol);
      balanceExtract.nonCurrentAssets = makeValueObject(nonCurrentAssetsRow, "الأصول غير المتداولة", latestCol, previousCol);

      balanceExtract.totalLiabilities = makeValueObject(totalLiabilitiesRow, "إجمالي المطلوبات", latestCol, previousCol);
      balanceExtract.currentLiabilities = makeValueObject(currentLiabilitiesRow, "المطلوبات المتداولة", latestCol, previousCol);
      balanceExtract.nonCurrentLiabilities = makeValueObject(nonCurrentLiabilitiesRow, "المطلوبات غير المتداولة", latestCol, previousCol);

      balanceExtract.totalEquity = makeValueObject(totalEquityRow, "إجمالي حقوق الملكية", latestCol, previousCol);

      const totalAssetsCurrent = balanceExtract.totalAssets?.current ?? null;
      const totalAssetsPrevious = balanceExtract.totalAssets?.previous ?? null;

      const nonCurrentAssetsCurrent = balanceExtract.nonCurrentAssets?.current ?? null;
      const nonCurrentAssetsPrevious = balanceExtract.nonCurrentAssets?.previous ?? null;

      const totalLiabilitiesCurrent = balanceExtract.totalLiabilities?.current ?? null;
      const totalLiabilitiesPrevious = balanceExtract.totalLiabilities?.previous ?? null;

      const currentLiabilitiesCurrent = balanceExtract.currentLiabilities?.current ?? null;
      const currentLiabilitiesPrevious = balanceExtract.currentLiabilities?.previous ?? null;

      const totalEquityCurrent = balanceExtract.totalEquity?.current ?? null;
      const totalEquityPrevious = balanceExtract.totalEquity?.previous ?? null;

      if (isMissingValueObj(balanceExtract.totalAssets)) {
        if (totalLiabilitiesCurrent !== null && totalEquityCurrent !== null) {
          balanceExtract.totalAssets = {
            label: "إجمالي الأصول (مشتق)",
            current: totalLiabilitiesCurrent + totalEquityCurrent,
            previous: (totalLiabilitiesPrevious !== null && totalEquityPrevious !== null)
              ? totalLiabilitiesPrevious + totalEquityPrevious
              : null
          };
        }
      }

      if (isMissingValueObj(balanceExtract.currentAssets)) {
        const derivedTotalAssetsCurrent = balanceExtract.totalAssets?.current ?? null;
        const derivedTotalAssetsPrevious = balanceExtract.totalAssets?.previous ?? null;

        if (derivedTotalAssetsCurrent !== null && nonCurrentAssetsCurrent !== null) {
          balanceExtract.currentAssets = {
            label: "الأصول المتداولة (مشتق)",
            current: derivedTotalAssetsCurrent - nonCurrentAssetsCurrent,
            previous: (derivedTotalAssetsPrevious !== null && nonCurrentAssetsPrevious !== null)
              ? derivedTotalAssetsPrevious - nonCurrentAssetsPrevious
              : null
          };
        }
      }

      if (isMissingValueObj(balanceExtract.nonCurrentLiabilities)) {
        if (totalLiabilitiesCurrent !== null && currentLiabilitiesCurrent !== null) {
          balanceExtract.nonCurrentLiabilities = {
            label: "المطلوبات غير المتداولة (مشتق)",
            current: totalLiabilitiesCurrent - currentLiabilitiesCurrent,
            previous: (totalLiabilitiesPrevious !== null && currentLiabilitiesPrevious !== null)
              ? totalLiabilitiesPrevious - currentLiabilitiesPrevious
              : null
          };
        }
      }
    }

    /* =========================
       CASH FLOW
       ========================= */

    let cashFlowExtract = {};

    const cashTable = pickBestCashTable(tablesPreview);

    if (cashTable) {

      const cols = detectColumns(cashTable);
      const picked = pickLatestColumns(cols);

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(cashTable);

      const lastRow = rows[rows.length - 1] || null;
      const prevRow = rows[rows.length - 2] || null;

      const endingCash = latestCol !== null ? parseNumberSmart(lastRow?.[latestCol]) : null;
      const beginningCash = latestCol !== null ? parseNumberSmart(prevRow?.[latestCol]) : null;

      let netChange = null;
      if (endingCash !== null && beginningCash !== null) {
        netChange = endingCash - beginningCash;
      }

      cashFlowExtract = {
        endingCash: {
          label: "النقد نهاية السنة",
          current: endingCash,
          previous: previousCol !== null ? parseNumberSmart(lastRow?.[previousCol]) : null
        },
        beginningCash: {
          label: "النقد بداية السنة",
          current: beginningCash,
          previous: previousCol !== null ? parseNumberSmart(prevRow?.[previousCol]) : null
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
