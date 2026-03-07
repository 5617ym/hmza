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
       Balance Sheet
       ========================= */

    let balanceExtract = {};

    const balanceTable = pickBestBalanceTable(tablesPreview);

    if (balanceTable) {

      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);

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

    let cashFlowExtract = {};

    const cashTable = pickBestCashTable(tablesPreview);

    if (cashTable) {

      const cols = detectColumns(cashTable);
      const picked = pickLatestColumns(cols);

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

      // fallback 1:
      // ابحث من أسفل الجدول عن ثلاثية متتالية تحقق:
      // ending - beginning = net change
      if (isMissingValueObj(endingCashObj) || isMissingValueObj(beginningCashObj)) {
        const numericRows = rows.filter(r =>
          rowHasNumericValueAt(r, latestCol) || rowHasNumericValueAt(r, previousCol)
        );

        for (let i = numericRows.length - 3; i >= 0; i--) {
          const netRow = numericRows[i];
          const beginRow = numericRows[i + 1];
          const endRow = numericRows[i + 2];

          const netCurrent = latestCol !== null ? parseNumberSmart(getCell(netRow, latestCol)) : null;
          const netPrevious = previousCol !== null ? parseNumberSmart(getCell(netRow, previousCol)) : null;

          const beginCurrent = latestCol !== null ? parseNumberSmart(getCell(beginRow, latestCol)) : null;
          const beginPrevious = previousCol !== null ? parseNumberSmart(getCell(beginRow, previousCol)) : null;

          const endCurrent = latestCol !== null ? parseNumberSmart(getCell(endRow, latestCol)) : null;
          const endPrevious = previousCol !== null ? parseNumberSmart(getCell(endRow, previousCol)) : null;

          const currentValid =
            endCurrent !== null &&
            beginCurrent !== null &&
            netCurrent !== null &&
            (endCurrent - beginCurrent === netCurrent);

          const previousValid =
            endPrevious !== null &&
            beginPrevious !== null &&
            netPrevious !== null &&
            (endPrevious - beginPrevious === netPrevious);

          if (currentValid || previousValid) {
            beginningCashObj = {
              label: "النقد وما في حكمه في بداية السنة (fallback arithmetic)",
              current: beginCurrent,
              previous: beginPrevious
            };

            endingCashObj = {
              label: "النقد وما في حكمه في نهاية السنة (fallback arithmetic)",
              current: endCurrent,
              previous: endPrevious
            };

            netChangeObj = {
              label: "صافي التغير في النقد (fallback arithmetic)",
              current: netCurrent,
              previous: netPrevious
            };

            break;
          }
        }

        // fallback 2:
        // نمط أقوى لملفك الحالي:
        // row3.previous == row2.current
        // row3.current - row2.current == row1.current
        // row3.previous - row2.previous == row1.previous
        if (isMissingValueObj(endingCashObj) || isMissingValueObj(beginningCashObj)) {
          for (let i = rows.length - 3; i >= 0; i--) {
            const row1 = rows[i];
            const row2 = rows[i + 1];
            const row3 = rows[i + 2];

            const r1Current = latestCol !== null ? parseNumberSmart(getCell(row1, latestCol)) : null;
            const r1Previous = previousCol !== null ? parseNumberSmart(getCell(row1, previousCol)) : null;

            const r2Current = latestCol !== null ? parseNumberSmart(getCell(row2, latestCol)) : null;
            const r2Previous = previousCol !== null ? parseNumberSmart(getCell(row2, previousCol)) : null;

            const r3Current = latestCol !== null ? parseNumberSmart(getCell(row3, latestCol)) : null;
            const r3Previous = previousCol !== null ? parseNumberSmart(getCell(row3, previousCol)) : null;

            const chainValid =
              r1Current !== null &&
              r1Previous !== null &&
              r2Current !== null &&
              r2Previous !== null &&
              r3Current !== null &&
              r3Previous !== null &&
              r3Previous === r2Current &&
              (r3Current - r2Current === r1Current) &&
              (r3Previous - r2Previous === r1Previous);

            if (chainValid) {
              netChangeObj = {
                label: "صافي التغير في النقد (fallback chain)",
                current: r1Current,
                previous: r1Previous
              };

              beginningCashObj = {
                label: "النقد وما في حكمه في بداية السنة (fallback chain)",
                current: r2Current,
                previous: r2Previous
              };

              endingCashObj = {
                label: "النقد وما في حكمه في نهاية السنة (fallback chain)",
                current: r3Current,
                previous: r3Previous
              };

              break;
            }
          }
        }
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
