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
      return norm(s)
        .replace(/[|ـ\-–—_:;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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
        return { latest: null, previous: null, latestYear: null, previousYear: null };
      }

      const uniqueYears = [...new Set(years)].sort((a, b) => b - a);
      const maxYear = uniqueYears[0];
      const prevYear = uniqueYears[1] || null;

      const latest = usable.find(c => c.years.includes(maxYear)) || null;
      const previous = prevYear
        ? (usable.find(c => c.years.includes(prevYear)) || null)
        : null;

      return {
        latest,
        previous,
        latestYear: maxYear,
        previousYear: prevYear
      };
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

    const findExactBalanceSheetMatch = (rows, names, latestCol, usedRowIndexes = new Set()) => {
      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s === norm(n))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findContainsBalanceSheetMatch = (rows, names, latestCol, usedRowIndexes = new Set()) => {
      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s.includes(norm(n)))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findExactRowMatch = (rows, names, latestCol) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s === norm(n))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const findContainsRowMatch = (rows, names, latestCol) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        const s = stripNonTextNoise(label);
        if (names.some(n => s.includes(norm(n)))) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const tableTextBlob = (table) => {
      return norm(JSON.stringify([
        ...(table.sample || []),
        ...(table.sampleTail || [])
      ]));
    };

    const mergeTableRows = (table) => {
      return [
        ...(Array.isArray(table?.sample) ? table.sample : []),
        ...(Array.isArray(table?.sampleTail) ? table.sampleTail : [])
      ];
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

    const hasCurrent = (obj) => !!obj && obj.current !== null && obj.current !== undefined;
    const hasPrevious = (obj) => !!obj && obj.previous !== null && obj.previous !== undefined;

    const safePercentChange = (current, previous) => {
      if (current === null || current === undefined) return null;
      if (previous === null || previous === undefined) return null;
      if (previous === 0) return null;
      return ((current - previous) / Math.abs(previous)) * 100;
    };

    const safeRatio = (numerator, denominator) => {
      if (numerator === null || numerator === undefined) return null;
      if (denominator === null || denominator === undefined) return null;
      if (denominator === 0) return null;
      return numerator / denominator;
    };

    const safeMarginPct = (numerator, denominator) => {
      const ratio = safeRatio(numerator, denominator);
      return ratio === null ? null : ratio * 100;
    };

    const boolOrNull = (value) => {
      if (value === true) return true;
      if (value === false) return false;
      return null;
    };

    const round2 = (n) => {
      if (n === null || n === undefined) return null;
      return Math.round(n * 100) / 100;
    };

    const pctDescriptor = (value, goodThreshold, weakThreshold) => {
      if (value === null || value === undefined) return null;
      if (value >= goodThreshold) return "strong";
      if (value <= weakThreshold) return "weak";
      return "moderate";
    };

    const ratioDescriptor = (value, strongThreshold, weakThreshold) => {
      if (value === null || value === undefined) return null;
      if (value >= strongThreshold) return "strong";
      if (value <= weakThreshold) return "weak";
      return "moderate";
    };

    const pushInsight = (arr, text) => {
      if (text && !arr.includes(text)) arr.push(text);
    };

    /* =========================
       Table scoring
       ========================= */

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

      if (text.includes("التدفقات النقدية")) score += 12;
      if (text.includes("قائمة التدفقات النقدية")) score += 16;
      if (text.includes("cash flow")) score += 12;
      if (text.includes("النقد وما في حكمه")) score += 10;
      if (text.includes("cash and cash")) score += 10;
      if (text.includes("صافي التغير")) score += 8;
      if (text.includes("net change")) score += 8;

      if (Number(table.columnCount) >= 2 && Number(table.columnCount) <= 4) score += 3;
      if (Number(table.rowCount) >= 15) score += 3;

      if (text.includes("الإيرادات") || text.includes("مجمل الربح")) score -= 5;
      if (text.includes("الموجودات") || text.includes("حقوق الملكية")) score -= 5;

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

    /* =========================
       Income
       ========================= */

    const incomeNames = {
      revenue: ["الإيرادات", "الايرادات"],
      costOfRevenue: ["تكلفة الإيرادات", "تكلفة الايرادات"],
      grossProfit: ["مجمل الربح"],
      operatingProfit: ["الربح التشغيلي"]
    };

    let incomeExtract = {};
    let incomeYears = { current: null, previous: null };

    const incomeTable = pickBestIncomeTable(tablesPreview);

    if (incomeTable) {
      const cols = detectColumns(incomeTable);
      const picked = pickLatestColumns(cols);

      incomeYears = {
        current: picked.latestYear ?? null,
        previous: picked.previousYear ?? null
      };

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
       Balance Sheet
       ========================= */

    let balanceExtract = {};
    let balanceYears = { current: null, previous: null };

    const balanceTable = pickBestBalanceTable(tablesPreview);

    if (balanceTable) {
      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);

      balanceYears = {
        current: picked.latestYear ?? null,
        previous: picked.previousYear ?? null
      };

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(balanceTable);
      const usedRowIndexes = new Set();

      const nonCurrentAssetsMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"],
        latestCol,
        usedRowIndexes
      );

      if (nonCurrentAssetsMatch.index >= 0) usedRowIndexes.add(nonCurrentAssetsMatch.index);

      balanceExtract.nonCurrentAssets = makeValueObject(
        nonCurrentAssetsMatch.row,
        "الأصول غير المتداولة",
        latestCol,
        previousCol
      );

      const totalAssetsDirectMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول"],
        latestCol,
        usedRowIndexes
      );

      if (totalAssetsDirectMatch.index >= 0) usedRowIndexes.add(totalAssetsDirectMatch.index);

      let totalAssetsObj = makeValueObject(
        totalAssetsDirectMatch.row,
        "إجمالي الأصول",
        latestCol,
        previousCol
      );

      if (isMissingValueObj(totalAssetsObj)) {
        const totalAssetsFromAccountingMatch = findContainsBalanceSheetMatch(
          rows,
          ["إجمالي حقوق الملكية والمطلوبات"],
          latestCol,
          usedRowIndexes
        );

        if (totalAssetsFromAccountingMatch.index >= 0) {
          usedRowIndexes.add(totalAssetsFromAccountingMatch.index);

          totalAssetsObj = makeValueObject(
            totalAssetsFromAccountingMatch.row,
            "إجمالي الأصول",
            latestCol,
            previousCol
          );
        }
      }

      balanceExtract.totalAssets = totalAssetsObj;

      if (hasCurrent(balanceExtract.totalAssets) && hasCurrent(balanceExtract.nonCurrentAssets)) {
        balanceExtract.currentAssets = {
          label: "الأصول المتداولة (مشتق)",
          current: balanceExtract.totalAssets.current - balanceExtract.nonCurrentAssets.current,
          previous:
            hasPrevious(balanceExtract.totalAssets) && hasPrevious(balanceExtract.nonCurrentAssets)
              ? balanceExtract.totalAssets.previous - balanceExtract.nonCurrentAssets.previous
              : null
        };
      } else {
        balanceExtract.currentAssets = null;
      }

      const totalLiabilitiesMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي المطلوبات", "إجمالي الالتزامات", "مجموع المطلوبات", "مجموع الالتزامات"],
        latestCol,
        usedRowIndexes
      );
      if (totalLiabilitiesMatch.index >= 0) usedRowIndexes.add(totalLiabilitiesMatch.index);

      balanceExtract.totalLiabilities = makeValueObject(
        totalLiabilitiesMatch.row,
        "إجمالي المطلوبات",
        latestCol,
        previousCol
      );

      const currentLiabilitiesMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"],
        latestCol,
        usedRowIndexes
      );
      if (currentLiabilitiesMatch.index >= 0) usedRowIndexes.add(currentLiabilitiesMatch.index);

      balanceExtract.currentLiabilities = makeValueObject(
        currentLiabilitiesMatch.row,
        "المطلوبات المتداولة",
        latestCol,
        previousCol
      );

      const nonCurrentLiabilitiesMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"],
        latestCol,
        usedRowIndexes
      );
      if (nonCurrentLiabilitiesMatch.index >= 0) usedRowIndexes.add(nonCurrentLiabilitiesMatch.index);

      balanceExtract.nonCurrentLiabilities = makeValueObject(
        nonCurrentLiabilitiesMatch.row,
        "المطلوبات غير المتداولة",
        latestCol,
        previousCol
      );

      const totalEquityMatch = findExactBalanceSheetMatch(
        rows,
        ["إجمالي حقوق الملكية", "إجمالي حقوق المساهمين", "مجموع حقوق الملكية"],
        latestCol,
        usedRowIndexes
      );
      if (totalEquityMatch.index >= 0) usedRowIndexes.add(totalEquityMatch.index);

      balanceExtract.totalEquity = makeValueObject(
        totalEquityMatch.row,
        "إجمالي حقوق الملكية",
        latestCol,
        previousCol
      );

      const totalLiabilitiesCurrent = balanceExtract.totalLiabilities?.current ?? null;
      const totalLiabilitiesPrevious = balanceExtract.totalLiabilities?.previous ?? null;

      const currentLiabilitiesCurrent = balanceExtract.currentLiabilities?.current ?? null;
      const currentLiabilitiesPrevious = balanceExtract.currentLiabilities?.previous ?? null;

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

      if (isMissingValueObj(balanceExtract.totalAssets)) {
        const totalEquityCurrent = balanceExtract.totalEquity?.current ?? null;
        const totalEquityPrevious = balanceExtract.totalEquity?.previous ?? null;

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
        const totalAssetsCurrent = balanceExtract.totalAssets?.current ?? null;
        const totalAssetsPrevious = balanceExtract.totalAssets?.previous ?? null;
        const nonCurrentAssetsCurrent = balanceExtract.nonCurrentAssets?.current ?? null;
        const nonCurrentAssetsPrevious = balanceExtract.nonCurrentAssets?.previous ?? null;

        if (totalAssetsCurrent !== null && nonCurrentAssetsCurrent !== null) {
          balanceExtract.currentAssets = {
            label: "الأصول المتداولة (مشتق)",
            current: totalAssetsCurrent - nonCurrentAssetsCurrent,
            previous: (totalAssetsPrevious !== null && nonCurrentAssetsPrevious !== null)
              ? totalAssetsPrevious - nonCurrentAssetsPrevious
              : null
          };
        }
      }
    }

    /* =========================
       CASH FLOW
       ========================= */

    const detectCashTriplet = (rows, latestCol, previousCol) => {
      if (latestCol === null || previousCol === null) return null;

      const numericRows = rows.filter(r =>
        rowHasNumericValueAt(r, latestCol) || rowHasNumericValueAt(r, previousCol)
      );

      if (numericRows.length < 3) return null;

      for (let i = numericRows.length - 3; i >= 0; i--) {
        const row1 = numericRows[i];
        const row2 = numericRows[i + 1];
        const row3 = numericRows[i + 2];

        const r1Current = parseNumberSmart(getCell(row1, latestCol));
        const r1Previous = parseNumberSmart(getCell(row1, previousCol));

        const r2Current = parseNumberSmart(getCell(row2, latestCol));
        const r2Previous = parseNumberSmart(getCell(row2, previousCol));

        const r3Current = parseNumberSmart(getCell(row3, latestCol));
        const r3Previous = parseNumberSmart(getCell(row3, previousCol));

        const arithmeticValid =
          r1Current !== null &&
          r1Previous !== null &&
          r2Current !== null &&
          r2Previous !== null &&
          r3Current !== null &&
          r3Previous !== null &&
          (r3Current - r2Current === r1Current) &&
          (r3Previous - r2Previous === r1Previous);

        const chainValid =
          arithmeticValid &&
          (r3Previous === r2Current);

        if (chainValid) {
          return {
            netChange: {
              label: "صافي التغير في النقد (detected)",
              current: r1Current,
              previous: r1Previous
            },
            beginningCash: {
              label: "النقد وما في حكمه في بداية السنة (detected)",
              current: r2Current,
              previous: r2Previous
            },
            endingCash: {
              label: "النقد وما في حكمه في نهاية السنة (detected)",
              current: r3Current,
              previous: r3Previous
            }
          };
        }
      }

      for (let i = numericRows.length - 3; i >= 0; i--) {
        const row1 = numericRows[i];
        const row2 = numericRows[i + 1];
        const row3 = numericRows[i + 2];

        const r1Current = parseNumberSmart(getCell(row1, latestCol));
        const r1Previous = parseNumberSmart(getCell(row1, previousCol));

        const r2Current = parseNumberSmart(getCell(row2, latestCol));
        const r2Previous = parseNumberSmart(getCell(row2, previousCol));

        const r3Current = parseNumberSmart(getCell(row3, latestCol));
        const r3Previous = parseNumberSmart(getCell(row3, previousCol));

        const arithmeticValid =
          r1Current !== null &&
          r1Previous !== null &&
          r2Current !== null &&
          r2Previous !== null &&
          r3Current !== null &&
          r3Previous !== null &&
          (r3Current - r2Current === r1Current) &&
          (r3Previous - r2Previous === r1Previous);

        if (arithmeticValid) {
          return {
            netChange: {
              label: "صافي التغير في النقد (detected)",
              current: r1Current,
              previous: r1Previous
            },
            beginningCash: {
              label: "النقد وما في حكمه في بداية السنة (detected)",
              current: r2Current,
              previous: r2Previous
            },
            endingCash: {
              label: "النقد وما في حكمه في نهاية السنة (detected)",
              current: r3Current,
              previous: r3Previous
            }
          };
        }
      }

      return null;
    };

    const scoreCashCandidate = (table) => {
      const baseScore = scoreCashFlowTable(table);
      const cols = detectColumns(table);
      const picked = pickLatestColumns(cols);
      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;
      const rows = mergeTableRows(table);

      let score = baseScore;

      if (latestCol !== null && previousCol !== null) score += 4;
      if (Number(table.columnCount) === 3 || Number(table.columnCount) === 4) score += 3;
      if (Number(table.rowCount) >= 18) score += 4;

      const detected = detectCashTriplet(rows, latestCol, previousCol);
      if (detected) score += 40;

      const text = tableTextBlob(table);
      if (text.includes("الزكاة")) score += 1;
      if (text.includes("الإستهلاك") || text.includes("الاستهلاك")) score += 1;
      if (text.includes("تكاليف تمويلية") || text.includes("إيرادات تمويلية")) score += 1;

      if (Number(table.pageNumber) >= 8 && Number(table.pageNumber) <= 12) score += 4;

      return {
        table,
        score,
        detected,
        years: {
          current: picked.latestYear ?? null,
          previous: picked.previousYear ?? null
        }
      };
    };

    const pickBestCashTableRobust = (tables) => {
      if (!Array.isArray(tables) || !tables.length) {
        return { table: null, detected: null, years: { current: null, previous: null } };
      }

      let best = { table: null, detected: null, score: -Infinity, years: { current: null, previous: null } };

      for (const t of tables) {
        const candidate = scoreCashCandidate(t);
        if (candidate.score > best.score) {
          best = candidate;
        }
      }

      return {
        table: best.score > 0 ? best.table : null,
        detected: best.score > 0 ? best.detected : null,
        years: best.score > 0 ? best.years : { current: null, previous: null }
      };
    };

    let cashFlowExtract = {};
    let cashFlowYears = { current: null, previous: null };

    const pickedCash = pickBestCashTableRobust(tablesPreview);
    const cashTable = pickedCash.table;
    let detectedCashTriplet = pickedCash.detected;
    cashFlowYears = pickedCash.years || { current: null, previous: null };

    if (cashTable) {
      const cols = detectColumns(cashTable);
      const picked = pickLatestColumns(cols);

      cashFlowYears = {
        current: picked.latestYear ?? cashFlowYears.current ?? null,
        previous: picked.previousYear ?? cashFlowYears.previous ?? null
      };

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(cashTable);

      const endingCashNamesExact = [
        "النقد وما في حكمه في نهاية السنة",
        "النقد والنقد المعادل في نهاية السنة",
        "النقد وما في حكمه في نهاية الفترة",
        "النقد والنقد المعادل في نهاية الفترة"
      ];

      const beginningCashNamesExact = [
        "النقد وما في حكمه في بداية السنة",
        "النقد والنقد المعادل في بداية السنة",
        "النقد وما في حكمه في بداية الفترة",
        "النقد والنقد المعادل في بداية الفترة"
      ];

      const endingCashNamesContains = [
        "في نهاية السنة",
        "في نهاية الفترة"
      ];

      const beginningCashNamesContains = [
        "في بداية السنة",
        "في بداية الفترة"
      ];

      let endingCashMatch = findExactRowMatch(rows, endingCashNamesExact, latestCol);
      if (endingCashMatch.index < 0) {
        endingCashMatch = findContainsRowMatch(rows, endingCashNamesContains, latestCol);
      }

      let beginningCashMatch = findExactRowMatch(rows, beginningCashNamesExact, latestCol);
      if (beginningCashMatch.index < 0) {
        beginningCashMatch = findContainsRowMatch(rows, beginningCashNamesContains, latestCol);
      }

      let endingCashObj = makeValueObject(
        endingCashMatch.row,
        "النقد وما في حكمه في نهاية السنة",
        latestCol,
        previousCol
      );

      let beginningCashObj = makeValueObject(
        beginningCashMatch.row,
        "النقد وما في حكمه في بداية السنة",
        latestCol,
        previousCol
      );

      let netChangeObj = {
        label: "صافي التغير في النقد",
        current: null,
        previous: null
      };

      if ((!hasCurrent(endingCashObj) || !hasCurrent(beginningCashObj)) && !detectedCashTriplet) {
        detectedCashTriplet = detectCashTriplet(rows, latestCol, previousCol);
      }

      if ((!hasCurrent(endingCashObj) || !hasCurrent(beginningCashObj)) && detectedCashTriplet) {
        beginningCashObj = detectedCashTriplet.beginningCash;
        endingCashObj = detectedCashTriplet.endingCash;
        netChangeObj = detectedCashTriplet.netChange;
      }

      if (netChangeObj.current === null && hasCurrent(endingCashObj) && hasCurrent(beginningCashObj)) {
        netChangeObj.current = endingCashObj.current - beginningCashObj.current;
      }

      if (netChangeObj.previous === null && hasPrevious(endingCashObj) && hasPrevious(beginningCashObj)) {
        netChangeObj.previous = endingCashObj.previous - beginningCashObj.previous;
      }

      cashFlowExtract = {
        endingCash: endingCashObj,
        beginningCash: beginningCashObj,
        netChangeInCash: netChangeObj
      };
    }

    /* =========================
       Organized output
       ========================= */

    const statements = {
      incomeStatementLite: incomeExtract,
      balanceSheetLite: balanceExtract,
      cashFlowLite: cashFlowExtract
    };

    const accountingEquationCurrent =
      balanceExtract?.totalAssets?.current !== null &&
      balanceExtract?.totalAssets?.current !== undefined &&
      balanceExtract?.totalLiabilities?.current !== null &&
      balanceExtract?.totalLiabilities?.current !== undefined &&
      balanceExtract?.totalEquity?.current !== null &&
      balanceExtract?.totalEquity?.current !== undefined
        ? balanceExtract.totalAssets.current ===
          (balanceExtract.totalLiabilities.current + balanceExtract.totalEquity.current)
        : null;

    const accountingEquationPrevious =
      balanceExtract?.totalAssets?.previous !== null &&
      balanceExtract?.totalAssets?.previous !== undefined &&
      balanceExtract?.totalLiabilities?.previous !== null &&
      balanceExtract?.totalLiabilities?.previous !== undefined &&
      balanceExtract?.totalEquity?.previous !== null &&
      balanceExtract?.totalEquity?.previous !== undefined
        ? balanceExtract.totalAssets.previous ===
          (balanceExtract.totalLiabilities.previous + balanceExtract.totalEquity.previous)
        : null;

    const cashFlowEquationCurrent =
      cashFlowExtract?.endingCash?.current !== null &&
      cashFlowExtract?.endingCash?.current !== undefined &&
      cashFlowExtract?.beginningCash?.current !== null &&
      cashFlowExtract?.beginningCash?.current !== undefined &&
      cashFlowExtract?.netChangeInCash?.current !== null &&
      cashFlowExtract?.netChangeInCash?.current !== undefined
        ? (cashFlowExtract.endingCash.current - cashFlowExtract.beginningCash.current) ===
          cashFlowExtract.netChangeInCash.current
        : null;

    const cashFlowEquationPrevious =
      cashFlowExtract?.endingCash?.previous !== null &&
      cashFlowExtract?.endingCash?.previous !== undefined &&
      cashFlowExtract?.beginningCash?.previous !== null &&
      cashFlowExtract?.beginningCash?.previous !== undefined &&
      cashFlowExtract?.netChangeInCash?.previous !== null &&
      cashFlowExtract?.netChangeInCash?.previous !== undefined
        ? (cashFlowExtract.endingCash.previous - cashFlowExtract.beginningCash.previous) ===
          cashFlowExtract.netChangeInCash.previous
        : null;

    const checks = {
      accountingEquation: {
        current: boolOrNull(accountingEquationCurrent),
        previous: boolOrNull(accountingEquationPrevious)
      },
      cashFlowEquation: {
        current: boolOrNull(cashFlowEquationCurrent),
        previous: boolOrNull(cashFlowEquationPrevious)
      },
      completeness: {
        incomeStatementLite: {
          hasRevenue: hasCurrent(incomeExtract?.revenue),
          hasCostOfRevenue: hasCurrent(incomeExtract?.costOfRevenue),
          hasGrossProfit: hasCurrent(incomeExtract?.grossProfit),
          hasOperatingProfit: hasCurrent(incomeExtract?.operatingProfit)
        },
        balanceSheetLite: {
          hasTotalAssets: hasCurrent(balanceExtract?.totalAssets),
          hasCurrentAssets: hasCurrent(balanceExtract?.currentAssets),
          hasNonCurrentAssets: hasCurrent(balanceExtract?.nonCurrentAssets),
          hasTotalLiabilities: hasCurrent(balanceExtract?.totalLiabilities),
          hasCurrentLiabilities: hasCurrent(balanceExtract?.currentLiabilities),
          hasNonCurrentLiabilities: hasCurrent(balanceExtract?.nonCurrentLiabilities),
          hasTotalEquity: hasCurrent(balanceExtract?.totalEquity)
        },
        cashFlowLite: {
          hasEndingCash: hasCurrent(cashFlowExtract?.endingCash),
          hasBeginningCash: hasCurrent(cashFlowExtract?.beginningCash),
          hasNetChangeInCash: hasCurrent(cashFlowExtract?.netChangeInCash)
        }
      }
    };

    const derived = {
      detectedYears: {
        incomeStatement: incomeYears,
        balanceSheet: balanceYears,
        cashFlow: cashFlowYears
      },
      growth: {
        revenuePct: round2(safePercentChange(
          incomeExtract?.revenue?.current ?? null,
          incomeExtract?.revenue?.previous ?? null
        )),
        grossProfitPct: round2(safePercentChange(
          incomeExtract?.grossProfit?.current ?? null,
          incomeExtract?.grossProfit?.previous ?? null
        )),
        operatingProfitPct: round2(safePercentChange(
          incomeExtract?.operatingProfit?.current ?? null,
          incomeExtract?.operatingProfit?.previous ?? null
        )),
        totalAssetsPct: round2(safePercentChange(
          balanceExtract?.totalAssets?.current ?? null,
          balanceExtract?.totalAssets?.previous ?? null
        )),
        totalEquityPct: round2(safePercentChange(
          balanceExtract?.totalEquity?.current ?? null,
          balanceExtract?.totalEquity?.previous ?? null
        )),
        endingCashPct: round2(safePercentChange(
          cashFlowExtract?.endingCash?.current ?? null,
          cashFlowExtract?.endingCash?.previous ?? null
        ))
      }
    };

    /* =========================
       Basic ratios
       ========================= */

    const ratios = {
      profitability: {
        grossMarginPct: {
          current: round2(safeMarginPct(
            incomeExtract?.grossProfit?.current ?? null,
            incomeExtract?.revenue?.current ?? null
          )),
          previous: round2(safeMarginPct(
            incomeExtract?.grossProfit?.previous ?? null,
            incomeExtract?.revenue?.previous ?? null
          ))
        },
        operatingMarginPct: {
          current: round2(safeMarginPct(
            incomeExtract?.operatingProfit?.current ?? null,
            incomeExtract?.revenue?.current ?? null
          )),
          previous: round2(safeMarginPct(
            incomeExtract?.operatingProfit?.previous ?? null,
            incomeExtract?.revenue?.previous ?? null
          ))
        }
      },
      liquidity: {
        currentRatio: {
          current: round2(safeRatio(
            balanceExtract?.currentAssets?.current ?? null,
            balanceExtract?.currentLiabilities?.current ?? null
          )),
          previous: round2(safeRatio(
            balanceExtract?.currentAssets?.previous ?? null,
            balanceExtract?.currentLiabilities?.previous ?? null
          ))
        },
        cashToCurrentLiabilities: {
          current: round2(safeRatio(
            cashFlowExtract?.endingCash?.current ?? null,
            balanceExtract?.currentLiabilities?.current ?? null
          )),
          previous: round2(safeRatio(
            cashFlowExtract?.endingCash?.previous ?? null,
            balanceExtract?.currentLiabilities?.previous ?? null
          ))
        }
      },
      leverage: {
        debtToAssets: {
          current: round2(safeRatio(
            balanceExtract?.totalLiabilities?.current ?? null,
            balanceExtract?.totalAssets?.current ?? null
          )),
          previous: round2(safeRatio(
            balanceExtract?.totalLiabilities?.previous ?? null,
            balanceExtract?.totalAssets?.previous ?? null
          ))
        },
        equityRatio: {
          current: round2(safeRatio(
            balanceExtract?.totalEquity?.current ?? null,
            balanceExtract?.totalAssets?.current ?? null
          )),
          previous: round2(safeRatio(
            balanceExtract?.totalEquity?.previous ?? null,
            balanceExtract?.totalAssets?.previous ?? null
          ))
        },
        debtToEquity: {
          current: round2(safeRatio(
            balanceExtract?.totalLiabilities?.current ?? null,
            balanceExtract?.totalEquity?.current ?? null
          )),
          previous: round2(safeRatio(
            balanceExtract?.totalLiabilities?.previous ?? null,
            balanceExtract?.totalEquity?.previous ?? null
          ))
        }
      },
      growth: {
        revenueGrowthPct: round2(safePercentChange(
          incomeExtract?.revenue?.current ?? null,
          incomeExtract?.revenue?.previous ?? null
        )),
        grossProfitGrowthPct: round2(safePercentChange(
          incomeExtract?.grossProfit?.current ?? null,
          incomeExtract?.grossProfit?.previous ?? null
        )),
        operatingProfitGrowthPct: round2(safePercentChange(
          incomeExtract?.operatingProfit?.current ?? null,
          incomeExtract?.operatingProfit?.previous ?? null
        )),
        totalAssetsGrowthPct: round2(safePercentChange(
          balanceExtract?.totalAssets?.current ?? null,
          balanceExtract?.totalAssets?.previous ?? null
        )),
        totalEquityGrowthPct: round2(safePercentChange(
          balanceExtract?.totalEquity?.current ?? null,
          balanceExtract?.totalEquity?.previous ?? null
        )),
        endingCashGrowthPct: round2(safePercentChange(
          cashFlowExtract?.endingCash?.current ?? null,
          cashFlowExtract?.endingCash?.previous ?? null
        ))
      }
    };

    /* =========================
       4C: Insights
       ========================= */

    const insights = {
      profitability: [],
      liquidity: [],
      leverage: [],
      growth: [],
      summary: []
    };

    const gmCurrent = ratios?.profitability?.grossMarginPct?.current ?? null;
    const gmPrevious = ratios?.profitability?.grossMarginPct?.previous ?? null;
    const omCurrent = ratios?.profitability?.operatingMarginPct?.current ?? null;
    const omPrevious = ratios?.profitability?.operatingMarginPct?.previous ?? null;

    const currentRatioCurrent = ratios?.liquidity?.currentRatio?.current ?? null;
    const currentRatioPrevious = ratios?.liquidity?.currentRatio?.previous ?? null;
    const cashCoverageCurrent = ratios?.liquidity?.cashToCurrentLiabilities?.current ?? null;
    const cashCoveragePrevious = ratios?.liquidity?.cashToCurrentLiabilities?.previous ?? null;

    const debtToAssetsCurrent = ratios?.leverage?.debtToAssets?.current ?? null;
    const debtToAssetsPrevious = ratios?.leverage?.debtToAssets?.previous ?? null;
    const equityRatioCurrent = ratios?.leverage?.equityRatio?.current ?? null;
    const equityRatioPrevious = ratios?.leverage?.equityRatio?.previous ?? null;
    const debtToEquityCurrent = ratios?.leverage?.debtToEquity?.current ?? null;
    const debtToEquityPrevious = ratios?.leverage?.debtToEquity?.previous ?? null;

    const revenueGrowth = ratios?.growth?.revenueGrowthPct ?? null;
    const grossProfitGrowth = ratios?.growth?.grossProfitGrowthPct ?? null;
    const operatingProfitGrowth = ratios?.growth?.operatingProfitGrowthPct ?? null;
    const totalAssetsGrowth = ratios?.growth?.totalAssetsGrowthPct ?? null;
    const totalEquityGrowth = ratios?.growth?.totalEquityGrowthPct ?? null;
    const endingCashGrowth = ratios?.growth?.endingCashGrowthPct ?? null;

    // Profitability insights
    if (gmCurrent !== null && gmPrevious !== null) {
      if (gmCurrent > gmPrevious) {
        pushInsight(insights.profitability, "الهامش الإجمالي تحسن مقارنة بالفترة السابقة، مما يشير إلى تحسن نسبي في كفاءة تحقيق الربح من الإيرادات.");
      } else if (gmCurrent < gmPrevious) {
        pushInsight(insights.profitability, "الهامش الإجمالي تراجع مقارنة بالفترة السابقة، مما قد يعكس ضغوطًا أعلى على تكلفة الإيرادات أو تسعيرًا أقل كفاءة.");
      } else {
        pushInsight(insights.profitability, "الهامش الإجمالي بقي مستقرًا تقريبًا مقارنة بالفترة السابقة.");
      }
    }

    if (omCurrent !== null && omPrevious !== null) {
      if (omCurrent > omPrevious) {
        pushInsight(insights.profitability, "هامش التشغيل ارتفع عن الفترة السابقة، وهذا يدعم وجود تحسن في الكفاءة التشغيلية.");
      } else if (omCurrent < omPrevious) {
        pushInsight(insights.profitability, "هامش التشغيل انخفض عن الفترة السابقة، ما قد يشير إلى زيادة الضغط التشغيلي أو ارتفاع المصروفات التشغيلية.");
      } else {
        pushInsight(insights.profitability, "هامش التشغيل بقي قريبًا من مستواه السابق دون تغير جوهري.");
      }
    }

    const profitabilitySignalHint = pctDescriptor(omCurrent, 10, 5);
    if (profitabilitySignalHint === "strong") {
      pushInsight(insights.profitability, "الربحية التشغيلية الحالية تظهر عند مستوى جيد نسبيًا.");
    } else if (profitabilitySignalHint === "moderate") {
      pushInsight(insights.profitability, "الربحية التشغيلية الحالية مقبولة لكنها ليست مرتفعة جدًا.");
    } else if (profitabilitySignalHint === "weak") {
      pushInsight(insights.profitability, "الربحية التشغيلية الحالية ما زالت ضعيفة نسبيًا وتحتاج متابعة.");
    }

    // Liquidity insights
    if (currentRatioCurrent !== null) {
      if (currentRatioCurrent >= 2) {
        pushInsight(insights.liquidity, "السيولة الجارية تبدو قوية، إذ تتجاوز الأصول المتداولة المطلوبات المتداولة بفارق مريح.");
      } else if (currentRatioCurrent >= 1) {
        pushInsight(insights.liquidity, "السيولة الجارية عند مستوى مقبول، لكنها ليست مرتفعة بشكل كبير.");
      } else {
        pushInsight(insights.liquidity, "السيولة الجارية ضعيفة نسبيًا لأن المطلوبات المتداولة تضغط على الأصول المتداولة.");
      }
    }

    if (cashCoverageCurrent !== null) {
      if (cashCoverageCurrent >= 1) {
        pushInsight(insights.liquidity, "النقد وما في حكمه يغطي المطلوبات المتداولة بمستوى جيد، وهو عنصر داعم للمرونة المالية قصيرة الأجل.");
      } else if (cashCoverageCurrent >= 0.5) {
        pushInsight(insights.liquidity, "تغطية النقد للمطلوبات المتداولة مقبولة لكنها ليست مرتفعة جدًا.");
      } else {
        pushInsight(insights.liquidity, "تغطية النقد للمطلوبات المتداولة منخفضة نسبيًا، ما يعني اعتمادًا أكبر على بقية الأصول المتداولة.");
      }
    }

    if (currentRatioCurrent !== null && currentRatioPrevious !== null) {
      if (currentRatioCurrent > currentRatioPrevious) {
        pushInsight(insights.liquidity, "مؤشر السيولة الجارية تحسن مقارنة بالفترة السابقة.");
      } else if (currentRatioCurrent < currentRatioPrevious) {
        pushInsight(insights.liquidity, "مؤشر السيولة الجارية تراجع مقارنة بالفترة السابقة، رغم بقاءه ضمن مستوى قد يظل مريحًا بحسب القيمة الحالية.");
      }
    }

    if (cashCoverageCurrent !== null && cashCoveragePrevious !== null) {
      if (cashCoverageCurrent < cashCoveragePrevious) {
        pushInsight(insights.liquidity, "قدرة النقد على تغطية المطلوبات المتداولة تراجعت عن الفترة السابقة.");
      } else if (cashCoverageCurrent > cashCoveragePrevious) {
        pushInsight(insights.liquidity, "قدرة النقد على تغطية المطلوبات المتداولة تحسنت عن الفترة السابقة.");
      }
    }

    // Leverage insights
    if (debtToAssetsCurrent !== null) {
      if (debtToAssetsCurrent < 0.4) {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى الأصول تبدو منخفضة نسبيًا، ما يشير إلى اعتماد غير مرتفع على التمويل بالالتزامات.");
      } else if (debtToAssetsCurrent < 0.6) {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى الأصول في مستوى متوسط وتحتاج متابعة دون أن تكون مرتفعة جدًا.");
      } else {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى الأصول مرتفعة نسبيًا، ما يعكس اعتمادًا أكبر على الالتزامات في هيكل التمويل.");
      }
    }

    if (equityRatioCurrent !== null) {
      if (equityRatioCurrent >= 0.6) {
        pushInsight(insights.leverage, "نسبة حقوق الملكية إلى الأصول جيدة، وهذا يعكس متانة مقبولة في هيكل رأس المال.");
      } else if (equityRatioCurrent >= 0.4) {
        pushInsight(insights.leverage, "نسبة حقوق الملكية إلى الأصول متوسطة وتعطي درجة معقولة من الدعم الرأسمالي.");
      } else {
        pushInsight(insights.leverage, "نسبة حقوق الملكية إلى الأصول منخفضة نسبيًا، ما قد يعني اعتمادًا أكبر على الالتزامات.");
      }
    }

    if (debtToEquityCurrent !== null) {
      if (debtToEquityCurrent < 1) {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى حقوق الملكية تبدو تحت السيطرة.");
      } else {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى حقوق الملكية مرتفعة نسبيًا وتستحق مراقبة إضافية.");
      }
    }

    if (debtToAssetsCurrent !== null && debtToAssetsPrevious !== null) {
      if (debtToAssetsCurrent < debtToAssetsPrevious) {
        pushInsight(insights.leverage, "الاعتماد على المطلوبات انخفض مقارنة بالفترة السابقة.");
      } else if (debtToAssetsCurrent > debtToAssetsPrevious) {
        pushInsight(insights.leverage, "الاعتماد على المطلوبات ارتفع مقارنة بالفترة السابقة.");
      }
    }

    if (equityRatioCurrent !== null && equityRatioPrevious !== null) {
      if (equityRatioCurrent > equityRatioPrevious) {
        pushInsight(insights.leverage, "حصة حقوق الملكية في تمويل الأصول تحسنت عن الفترة السابقة.");
      } else if (equityRatioCurrent < equityRatioPrevious) {
        pushInsight(insights.leverage, "حصة حقوق الملكية في تمويل الأصول تراجعت عن الفترة السابقة.");
      }
    }

    if (debtToEquityCurrent !== null && debtToEquityPrevious !== null) {
      if (debtToEquityCurrent < debtToEquityPrevious) {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى حقوق الملكية تحسنت مقارنة بالفترة السابقة.");
      } else if (debtToEquityCurrent > debtToEquityPrevious) {
        pushInsight(insights.leverage, "نسبة المطلوبات إلى حقوق الملكية ارتفعت مقارنة بالفترة السابقة.");
      }
    }

    // Growth insights
    if (revenueGrowth !== null) {
      if (revenueGrowth > 15) {
        pushInsight(insights.growth, "الإيرادات نمت بوتيرة جيدة مقارنة بالفترة السابقة.");
      } else if (revenueGrowth > 0) {
        pushInsight(insights.growth, "الإيرادات سجلت نموًا إيجابيًا لكن بوتيرة معتدلة.");
      } else if (revenueGrowth < 0) {
        pushInsight(insights.growth, "الإيرادات تراجعت مقارنة بالفترة السابقة.");
      }
    }

    if (operatingProfitGrowth !== null) {
      if (operatingProfitGrowth > 20) {
        pushInsight(insights.growth, "الربح التشغيلي نما بقوة، وهو مؤشر إيجابي على تحسن الأداء التشغيلي.");
      } else if (operatingProfitGrowth > 0) {
        pushInsight(insights.growth, "الربح التشغيلي حقق نموًا إيجابيًا مقارنة بالفترة السابقة.");
      } else if (operatingProfitGrowth < 0) {
        pushInsight(insights.growth, "الربح التشغيلي تراجع مقارنة بالفترة السابقة.");
      }
    }

    if (revenueGrowth !== null && operatingProfitGrowth !== null) {
      if (operatingProfitGrowth > revenueGrowth) {
        pushInsight(insights.growth, "نمو الربح التشغيلي أسرع من نمو الإيرادات، ما يدعم فرضية تحسن الكفاءة التشغيلية.");
      } else if (operatingProfitGrowth < revenueGrowth) {
        pushInsight(insights.growth, "نمو الربح التشغيلي أبطأ من نمو الإيرادات، ما قد يعني أن جزءًا من النمو تم امتصاصه عبر المصروفات.");
      }
    }

    if (endingCashGrowth !== null) {
      if (endingCashGrowth > 0) {
        pushInsight(insights.growth, "الرصيد النقدي النهائي ارتفع عن الفترة السابقة.");
      } else if (endingCashGrowth < 0) {
        pushInsight(insights.growth, "الرصيد النقدي النهائي انخفض عن الفترة السابقة، رغم ضرورة قراءته مع جودة التدفقات واستخدامات النقد.");
      }
    }

    if (totalAssetsGrowth !== null) {
      if (totalAssetsGrowth > 0) {
        pushInsight(insights.growth, "إجمالي الأصول نما مقارنة بالفترة السابقة.");
      } else if (totalAssetsGrowth < 0) {
        pushInsight(insights.growth, "إجمالي الأصول تراجع مقارنة بالفترة السابقة.");
      }
    }

    if (totalEquityGrowth !== null) {
      if (totalEquityGrowth > 0) {
        pushInsight(insights.growth, "حقوق الملكية ارتفعت مقارنة بالفترة السابقة.");
      } else if (totalEquityGrowth < 0) {
        pushInsight(insights.growth, "حقوق الملكية تراجعت مقارنة بالفترة السابقة.");
      }
    }

    // Summary insights
    if (gmCurrent !== null && omCurrent !== null && gmPrevious !== null && omPrevious !== null) {
      if (gmCurrent > gmPrevious && omCurrent > omPrevious) {
        pushInsight(insights.summary, "الصورة العامة تشير إلى تحسن واضح في الربحية على مستوى الهامش الإجمالي والتشغيلي.");
      } else if (gmCurrent < gmPrevious && omCurrent < omPrevious) {
        pushInsight(insights.summary, "الصورة العامة تشير إلى ضغوط على الربحية مع تراجع في كل من الهامش الإجمالي والتشغيلي.");
      }
    }

    if (boolOrNull(accountingEquationCurrent) === true && boolOrNull(cashFlowEquationCurrent) === true) {
      pushInsight(insights.summary, "البيانات المستخرجة تبدو متماسكة محاسبيًا في المعادلات الأساسية.");
    }

    if (
      currentRatioCurrent !== null &&
      currentRatioCurrent >= 1.5 &&
      debtToAssetsCurrent !== null &&
      debtToAssetsCurrent < 0.5
    ) {
      pushInsight(insights.summary, "المركز المالي الحالي يبدو متماسكًا من ناحية السيولة والاعتماد على المطلوبات.");
    }

    if (
      endingCashGrowth !== null &&
      endingCashGrowth < 0 &&
      operatingProfitGrowth !== null &&
      operatingProfitGrowth > 0
    ) {
      pushInsight(insights.summary, "هناك تحسن في التشغيل مقابل تراجع في الرصيد النقدي النهائي، وهذه نقطة تستحق قراءة أعمق لأسباب استخدام النقد.");
    }

    if (!insights.summary.length) {
      pushInsight(insights.summary, "القراءة الأولية تشير إلى توازن عام في الأداء، مع الحاجة إلى تحليل أعمق للتفاصيل التشغيلية والنقدية.");
    }

    /* =========================
       5A: Financial signals
       ========================= */

    const signals = {
      profitability: null,
      liquidity: null,
      leverage: null,
      growth: null
    };

    const opMargin = ratios?.profitability?.operatingMarginPct?.current ?? null;
    const currentRatio = ratios?.liquidity?.currentRatio?.current ?? null;
    const debtToAssets = ratios?.leverage?.debtToAssets?.current ?? null;

    if (opMargin !== null) {
      if (opMargin >= 15) signals.profitability = "strong";
      else if (opMargin >= 8) signals.profitability = "good";
      else if (opMargin >= 4) signals.profitability = "moderate";
      else signals.profitability = "weak";
    }

    if (currentRatio !== null) {
      if (currentRatio >= 2) signals.liquidity = "strong";
      else if (currentRatio >= 1.2) signals.liquidity = "acceptable";
      else signals.liquidity = "weak";
    }

    if (debtToAssets !== null) {
      if (debtToAssets <= 0.35) signals.leverage = "low";
      else if (debtToAssets <= 0.6) signals.leverage = "moderate";
      else signals.leverage = "high";
    }

    if (revenueGrowth !== null) {
      if (revenueGrowth > 15) signals.growth = "strong";
      else if (revenueGrowth > 5) signals.growth = "moderate";
      else if (revenueGrowth > 0) signals.growth = "slow";
      else signals.growth = "negative";
    }

    /* =========================
       5A: Executive summary
       ========================= */

    const executiveSummary = [];

    if (signals.profitability === "strong" || signals.profitability === "good") {
      executiveSummary.push(
        "الربحية التشغيلية تبدو جيدة نسبيًا مقارنة بمستوى الإيرادات."
      );
    } else if (signals.profitability === "moderate") {
      executiveSummary.push(
        "الربحية التشغيلية مقبولة، لكنها ما زالت دون مستوى القوة العالية."
      );
    } else if (signals.profitability === "weak") {
      executiveSummary.push(
        "الربحية التشغيلية الحالية ضعيفة نسبيًا وتحتاج متابعة."
      );
    }

    if (signals.liquidity === "strong") {
      executiveSummary.push(
        "السيولة المتاحة تبدو مريحة، حيث تغطي الأصول المتداولة المطلوبات المتداولة بفارق جيد."
      );
    } else if (signals.liquidity === "acceptable") {
      executiveSummary.push(
        "السيولة الحالية عند مستوى مقبول دون أن تكون مرتفعة جدًا."
      );
    } else if (signals.liquidity === "weak") {
      executiveSummary.push(
        "السيولة الحالية ضعيفة نسبيًا وتحتاج مراقبة."
      );
    }

    if (signals.leverage === "low") {
      executiveSummary.push(
        "هيكل التمويل يميل إلى الاعتماد الأقل على المطلوبات."
      );
    } else if (signals.leverage === "moderate") {
      executiveSummary.push(
        "هيكل التمويل متوازن نسبيًا مع اعتماد متوسط على المطلوبات."
      );
    } else if (signals.leverage === "high") {
      executiveSummary.push(
        "هيكل التمويل يعتمد بشكل أعلى نسبيًا على المطلوبات."
      );
    }

    if (signals.growth === "strong") {
      executiveSummary.push(
        "الإيرادات تسجل نموًا قويًا مقارنة بالفترة السابقة."
      );
    } else if (signals.growth === "moderate") {
      executiveSummary.push(
        "الإيرادات تنمو بوتيرة جيدة لكن ليست استثنائية."
      );
    } else if (signals.growth === "slow") {
      executiveSummary.push(
        "الإيرادات ما زالت تنمو ولكن بوتيرة بطيئة نسبيًا."
      );
    } else if (signals.growth === "negative") {
      executiveSummary.push(
        "الإيرادات في مسار تراجع مقارنة بالفترة السابقة."
      );
    }

    if (
      endingCashGrowth !== null &&
      endingCashGrowth < 0 &&
      operatingProfitGrowth !== null &&
      operatingProfitGrowth > 0
    ) {
      executiveSummary.push(
        "هناك تحسن تشغيلي مقابل تراجع في الرصيد النقدي النهائي، وهي نقطة تستحق تحليلًا أعمق في استخدامات النقد."
      );
    }

    if (!executiveSummary.length) {
      executiveSummary.push(
        "الأداء العام متوازن دون مؤشرات استثنائية واضحة في الوقت الحالي."
      );
    }

    /* =========================
       5B: Strategic evaluation
       ========================= */

    const evaluation = {
      strengths: [],
      watchPoints: [],
      opportunities: [],
      risks: []
    };

    if (signals.liquidity === "strong") {
      evaluation.strengths.push(
        "السيولة القوية تمنح الشركة مرونة جيدة في مواجهة الالتزامات قصيرة الأجل."
      );
    }

    if (signals.leverage === "low") {
      evaluation.strengths.push(
        "مستوى الاعتماد على المطلوبات منخفض نسبيًا، مما يدعم استقرار الهيكل المالي."
      );
    }

    if (signals.growth === "strong") {
      evaluation.strengths.push(
        "نمو الإيرادات القوي يشير إلى توسع النشاط أو تحسن الطلب."
      );
    }

    if (
      ratios?.profitability?.grossMarginPct?.current !== null &&
      ratios?.profitability?.grossMarginPct?.current > 20
    ) {
      evaluation.strengths.push(
        "الهامش الإجمالي الجيد يعكس قدرة الشركة على تحقيق قيمة من الإيرادات."
      );
    }

    if (signals.profitability === "moderate") {
      evaluation.watchPoints.push(
        "الربحية التشغيلية مقبولة لكنها ليست مرتفعة بما يكفي لتعطي هامش أمان كبير."
      );
    }

    if (
      ratios?.liquidity?.currentRatio?.current !== null &&
      ratios?.liquidity?.currentRatio?.current < 1.5
    ) {
      evaluation.watchPoints.push(
        "السيولة الجارية ليست مرتفعة بشكل كبير وقد تحتاج متابعة في الفترات القادمة."
      );
    }

    if (
      endingCashGrowth !== null &&
      endingCashGrowth < 0
    ) {
      evaluation.watchPoints.push(
        "تراجع الرصيد النقدي النهائي يستدعي فهم استخدامات النقد خلال الفترة."
      );
    }

    if (
      revenueGrowth !== null &&
      revenueGrowth > 10 &&
      signals.profitability !== "strong"
    ) {
      evaluation.opportunities.push(
        "في حال تحسن الكفاءة التشغيلية يمكن تحويل نمو الإيرادات إلى نمو أقوى في الأرباح."
      );
    }

    if (
      signals.leverage === "low" &&
      signals.growth === "strong"
    ) {
      evaluation.opportunities.push(
        "انخفاض مستوى المديونية يتيح مجالًا للتوسع أو التمويل المستقبلي إذا لزم الأمر."
      );
    }

    if (signals.profitability === "weak") {
      evaluation.risks.push(
        "ضعف الربحية التشغيلية قد يؤثر على قدرة الشركة على تمويل النمو مستقبلاً."
      );
    }

    if (
      endingCashGrowth !== null &&
      endingCashGrowth < -20
    ) {
      evaluation.risks.push(
        "الانخفاض الكبير في الرصيد النقدي قد يشير إلى استنزاف نقدي يحتاج تحليلًا أعمق."
      );
    }

    if (
      ratios?.leverage?.debtToAssets?.current !== null &&
      ratios?.leverage?.debtToAssets?.current > 0.65
    ) {
      evaluation.risks.push(
        "الاعتماد المرتفع على المطلوبات قد يزيد حساسية الشركة للمخاطر المالية."
      );
    }

    const meta = {
      source: {
        hasNormalized: !!normalized,
        hasNormalizedPrev: !!normalizedPrev,
        tablesPreviewCount: tablesPreview.length
      },
      pagesMeta,
      extractionStatus: {
        incomeStatementLite: hasCurrent(incomeExtract?.revenue),
        balanceSheetLite: hasCurrent(balanceExtract?.totalAssets),
        cashFlowLite: hasCurrent(cashFlowExtract?.endingCash)
      },
      summary: {
        currentYearDetected:
          incomeYears.current !== null ||
          balanceYears.current !== null ||
          cashFlowYears.current !== null,
        previousYearDetected:
          incomeYears.previous !== null ||
          balanceYears.previous !== null ||
          cashFlowYears.previous !== null
      }
    };

    return send(200, {
      ok: true,
      financial: {
        pagesMeta,
        incomeStatementLite: incomeExtract,
        balanceSheetLite: balanceExtract,
        cashFlowLite: cashFlowExtract,
        statements,
        checks,
        meta,
        derived,
        ratios,
        signals,
        insights,
        executiveSummary,
        evaluation
      }
    });

  } catch (e) {
    return send(500, {
      ok: false,
      error: e.message || String(e)
    });
  }

};
