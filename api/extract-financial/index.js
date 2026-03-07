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

    const isExactLike = (label, names) => {
      const s = stripNonTextNoise(label);
      return names.some(n => s === norm(n));
    };

    const isOneOfPhrases = (label, names) => {
      const s = stripNonTextNoise(label);
      return names.some(n => s.includes(norm(n)));
    };

    const exactLabelGroups = {
      totalAssets: ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول"],
      currentAssets: ["إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة"],
      nonCurrentAssets: ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"],
      totalLiabilities: ["إجمالي المطلوبات", "إجمالي الالتزامات", "مجموع المطلوبات", "مجموع الالتزامات"],
      currentLiabilities: ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"],
      nonCurrentLiabilities: ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"],
      totalEquity: ["إجمالي حقوق الملكية", "إجمالي حقوق المساهمين", "مجموع حقوق الملكية"]
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

      const isCurrent =
        full.includes("المتداولة");

      const isNonCurrent =
        full.includes("غير المتداولة");

      if (!rowHasNumericValueAt(row, latestCol)) {
        score -= 12;
      } else {
        score += 3;
      }

      if (isTotalRow) {
        score += 5;
      }

      if (isSubTotalRow) {
        score -= 3;
      }

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

      if (subKeys.includes(targetKey) && isTotalRow) {
        score -= 25;
      }

      if (totalKeys.includes(targetKey) && isTotalRow) {
        score += 8;
      }

      if (targetKey.includes("Assets") && isAssets) {
        score += 3;
      }

      if (targetKey.includes("Liabilities") && isLiabilities) {
        score += 3;
      }

      if (targetKey === "totalEquity" && isEquity) {
        score += 5;
      }

      if (targetKey.includes("Liabilities") && !isLiabilities) {
        score -= 35;
      }

      if (targetKey.includes("Assets") && !isAssets) {
        score -= 35;
      }

      if (targetKey === "totalEquity" && !isEquity) {
        score -= 35;
      }

      if (targetKey === "currentAssets") {
        if (isCurrent) score += 8;
        if (isNonCurrent) score -= 12;
      }

      if (targetKey === "nonCurrentAssets") {
        if (isNonCurrent) score += 10;
        if (isCurrent) score -= 12;
      }

      if (targetKey === "currentLiabilities") {
        if (isCurrent) score += 8;
        if (isNonCurrent) score -= 12;
      }

      if (targetKey === "nonCurrentLiabilities") {
        if (isNonCurrent) score += 10;
        if (isCurrent) score -= 12;
      }

      if (targetKey === "totalAssets" && isNonCurrent) {
        score -= 25;
      }

      if (targetKey === "totalAssets" && isCurrent) {
        score -= 25;
      }

      if (targetKey === "totalLiabilities" && (isCurrent || isNonCurrent)) {
        score -= 22;
      }

      if (targetKey === "totalAssets" && isTotalRow && isAssets && !isCurrent && !isNonCurrent) {
        score += 18;
      }

      if (targetKey === "totalLiabilities" && isTotalRow && isLiabilities && !isCurrent && !isNonCurrent) {
        score += 18;
      }

      if (targetKey === "nonCurrentLiabilities") {
        if (isLiabilities && isNonCurrent) {
          score += 12;
        }
        if (!isLiabilities) {
          score -= 25;
        }
      }

      if (exactLabelGroups[targetKey] && isExactLike(full, exactLabelGroups[targetKey])) {
        score += 60;
      }

      if (targetKey === "totalAssets") {
        if (isOneOfPhrases(full, ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"])) {
          score -= 60;
        }
        if (isOneOfPhrases(full, ["إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة"])) {
          score -= 60;
        }
      }

      if (targetKey === "totalLiabilities") {
        if (isOneOfPhrases(full, ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"])) {
          score -= 60;
        }
        if (isOneOfPhrases(full, ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"])) {
          score -= 60;
        }
      }

      if (targetKey === "currentLiabilities") {
        if (isExactLike(full, ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"])) {
          score += 40;
        }
        if (isOneOfPhrases(full, ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"])) {
          score -= 45;
        }
      }

      if (targetKey === "nonCurrentLiabilities") {
        if (isExactLike(full, ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة"])) {
          score += 40;
        }
        if (isOneOfPhrases(full, ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة"])) {
          score -= 45;
        }
      }

      if (targetKey === "currentAssets") {
        if (isExactLike(full, ["إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة"])) {
          score += 40;
        }
        if (isOneOfPhrases(full, ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"])) {
          score -= 45;
        }
      }

      if (targetKey === "nonCurrentAssets") {
        if (isExactLike(full, ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة"])) {
          score += 40;
        }
        if (isOneOfPhrases(full, ["إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة"])) {
          score -= 45;
        }
      }

      const nearBottomRatio = totalRows > 0 ? (rowIndex / totalRows) : 0;
      score += nearBottomRatio * 4;

      return score;
    };

    const findBestBalanceSheetMatch = (rows, targetNames, latestCol, targetKey, usedRowIndexes = new Set()) => {
      let bestRow = null;
      let bestScore = -Infinity;
      let bestIndex = -1;

      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

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
          bestIndex = i;
        }
      }

      if (bestScore > 0) {
        return { row: bestRow, index: bestIndex };
      }

      return { row: null, index: -1 };
    };

    const findExactBalanceSheetMatch = (rows, names, latestCol, usedRowIndexes = new Set()) => {
      for (let i = 0; i < rows.length; i++) {
        if (usedRowIndexes.has(i)) continue;

        const row = rows[i];
        const label = getRowLabelFromRow(row);

        if (!label) continue;
        if (!rowHasNumericValueAt(row, latestCol)) continue;

        if (isExactLike(label, names)) {
          return { row, index: i };
        }
      }

      return { row: null, index: -1 };
    };

    const resolveBalanceMatch = (rows, latestCol, targetKey, targetNames, usedRowIndexes = new Set()) => {
      const exactNames = exactLabelGroups[targetKey] || [];

      if (exactNames.length) {
        const exact = findExactBalanceSheetMatch(rows, exactNames, latestCol, usedRowIndexes);
        if (exact.row) return exact;
      }

      return findBestBalanceSheetMatch(rows, targetNames, latestCol, targetKey, usedRowIndexes);
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
      totalAssets: ["إجمالي الموجودات", "إجمالي الأصول", "مجموع الأصول"],
      currentAssets: ["إجمالي الموجودات المتداولة", "إجمالي الأصول المتداولة", "الموجودات المتداولة", "الأصول المتداولة"],
      nonCurrentAssets: ["إجمالي الموجودات غير المتداولة", "إجمالي الأصول غير المتداولة", "الموجودات غير المتداولة", "الأصول غير المتداولة"],
      totalLiabilities: ["إجمالي المطلوبات", "إجمالي الالتزامات", "مجموع المطلوبات", "مجموع الالتزامات"],
      currentLiabilities: ["إجمالي المطلوبات المتداولة", "إجمالي الالتزامات المتداولة", "المطلوبات المتداولة", "الالتزامات المتداولة"],
      nonCurrentLiabilities: ["إجمالي المطلوبات غير المتداولة", "إجمالي الالتزامات غير المتداولة", "المطلوبات غير المتداولة", "الالتزامات غير المتداولة"],
      totalEquity: ["إجمالي حقوق الملكية", "إجمالي حقوق المساهمين", "مجموع حقوق الملكية", "حقوق الملكية"]
    };

    const balanceTable = pickBestBalanceTable(tablesPreview);

    if (balanceTable) {

      const cols = detectColumns(balanceTable);
      const picked = pickLatestColumns(cols);

      const latestCol = picked.latest?.col ?? null;
      const previousCol = picked.previous?.col ?? null;

      const rows = mergeTableRows(balanceTable);
      const usedRowIndexes = new Set();

      const nonCurrentAssetsMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "nonCurrentAssets",
        balanceNames.nonCurrentAssets,
        usedRowIndexes
      );
      if (nonCurrentAssetsMatch.index >= 0) usedRowIndexes.add(nonCurrentAssetsMatch.index);

      const currentAssetsMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "currentAssets",
        balanceNames.currentAssets,
        usedRowIndexes
      );
      if (currentAssetsMatch.index >= 0) usedRowIndexes.add(currentAssetsMatch.index);

      const totalAssetsMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "totalAssets",
        balanceNames.totalAssets,
        usedRowIndexes
      );
      if (totalAssetsMatch.index >= 0) usedRowIndexes.add(totalAssetsMatch.index);

      const totalLiabilitiesMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "totalLiabilities",
        balanceNames.totalLiabilities,
        usedRowIndexes
      );
      if (totalLiabilitiesMatch.index >= 0) usedRowIndexes.add(totalLiabilitiesMatch.index);

      const currentLiabilitiesMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "currentLiabilities",
        balanceNames.currentLiabilities,
        usedRowIndexes
      );
      if (currentLiabilitiesMatch.index >= 0) usedRowIndexes.add(currentLiabilitiesMatch.index);

      const nonCurrentLiabilitiesMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "nonCurrentLiabilities",
        balanceNames.nonCurrentLiabilities,
        usedRowIndexes
      );
      if (nonCurrentLiabilitiesMatch.index >= 0) usedRowIndexes.add(nonCurrentLiabilitiesMatch.index);

      const totalEquityMatch = resolveBalanceMatch(
        rows,
        latestCol,
        "totalEquity",
        balanceNames.totalEquity,
        usedRowIndexes
      );
      if (totalEquityMatch.index >= 0) usedRowIndexes.add(totalEquityMatch.index);

      balanceExtract.nonCurrentAssets = makeValueObject(nonCurrentAssetsMatch.row, "الأصول غير المتداولة", latestCol, previousCol);
      balanceExtract.currentAssets = makeValueObject(currentAssetsMatch.row, "الأصول المتداولة", latestCol, previousCol);
      balanceExtract.totalAssets = makeValueObject(totalAssetsMatch.row, "إجمالي الأصول", latestCol, previousCol);

      balanceExtract.totalLiabilities = makeValueObject(totalLiabilitiesMatch.row, "إجمالي المطلوبات", latestCol, previousCol);
      balanceExtract.currentLiabilities = makeValueObject(currentLiabilitiesMatch.row, "المطلوبات المتداولة", latestCol, previousCol);
      balanceExtract.nonCurrentLiabilities = makeValueObject(nonCurrentLiabilitiesMatch.row, "المطلوبات غير المتداولة", latestCol, previousCol);

      balanceExtract.totalEquity = makeValueObject(totalEquityMatch.row, "إجمالي حقوق الملكية", latestCol, previousCol);

      const totalAssetsCurrent = balanceExtract.totalAssets?.current ?? null;
      const totalAssetsPrevious = balanceExtract.totalAssets?.previous ?? null;

      const currentAssetsCurrent = balanceExtract.currentAssets?.current ?? null;
      const currentAssetsPrevious = balanceExtract.currentAssets?.previous ?? null;

      const nonCurrentAssetsCurrent = balanceExtract.nonCurrentAssets?.current ?? null;
      const nonCurrentAssetsPrevious = balanceExtract.nonCurrentAssets?.previous ?? null;

      const totalLiabilitiesCurrent = balanceExtract.totalLiabilities?.current ?? null;
      const totalLiabilitiesPrevious = balanceExtract.totalLiabilities?.previous ?? null;

      const currentLiabilitiesCurrent = balanceExtract.currentLiabilities?.current ?? null;
      const currentLiabilitiesPrevious = balanceExtract.currentLiabilities?.previous ?? null;

      const totalEquityCurrent = balanceExtract.totalEquity?.current ?? null;
      const totalEquityPrevious = balanceExtract.totalEquity?.previous ?? null;

      // totalAssets fallback
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

      // currentAssets fallback
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

      // nonCurrentLiabilities fallback
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

      // consistency repair للأصول فقط إذا direct extraction التقط صفًا خاطئًا
      const finalTotalAssetsCurrent = balanceExtract.totalAssets?.current ?? null;
      const finalTotalAssetsPrevious = balanceExtract.totalAssets?.previous ?? null;
      const finalCurrentAssetsCurrent = balanceExtract.currentAssets?.current ?? null;
      const finalCurrentAssetsPrevious = balanceExtract.currentAssets?.previous ?? null;
      const finalNonCurrentAssetsCurrent = balanceExtract.nonCurrentAssets?.current ?? null;
      const finalNonCurrentAssetsPrevious = balanceExtract.nonCurrentAssets?.previous ?? null;

      if (
        finalCurrentAssetsCurrent !== null &&
        finalNonCurrentAssetsCurrent !== null &&
        finalTotalAssetsCurrent !== null
      ) {
        const sumCurrent = finalCurrentAssetsCurrent + finalNonCurrentAssetsCurrent;
        const diff = Math.abs(sumCurrent - finalTotalAssetsCurrent);

        if (diff > 10) {
          balanceExtract.totalAssets = {
            label: "إجمالي الأصول (مصحح)",
            current: sumCurrent,
            previous: (
              finalCurrentAssetsPrevious !== null &&
              finalNonCurrentAssetsPrevious !== null
            )
              ? finalCurrentAssetsPrevious + finalNonCurrentAssetsPrevious
              : finalTotalAssetsPrevious
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
