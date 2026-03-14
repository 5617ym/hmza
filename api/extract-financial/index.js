const { detectSector } = require("../_lib/sector-detection");
const sectorProfiles = require("../_lib/sector-profiles");

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
    const normalized = body.normalized || {};
    const normalizedPrev = body.normalizedPrev || null;

    if (!normalized || typeof normalized !== "object") {
      return send(400, {
        ok: false,
        error: "normalized payload is required"
      });
    }

    const rawSectorInfo = detectSector(normalized);
    const detectedSector = rawSectorInfo?.sector || "operating_company";
    const activeSectorProfile =
      sectorProfiles[detectedSector] || sectorProfiles.operating_company || {};

    const sectorStatements = activeSectorProfile.statements || {};
    const incomeKeywords = Array.isArray(sectorStatements.income)
      ? sectorStatements.income
      : Array.isArray(activeSectorProfile.incomeStatement)
        ? activeSectorProfile.incomeStatement
        : [];
    const balanceKeywords = Array.isArray(sectorStatements.balance)
      ? sectorStatements.balance
      : Array.isArray(activeSectorProfile.balanceSheet)
        ? activeSectorProfile.balanceSheet
        : [];
    const cashflowKeywords = Array.isArray(sectorStatements.cashflow)
      ? sectorStatements.cashflow
      : Array.isArray(activeSectorProfile.cashFlow)
        ? activeSectorProfile.cashFlow
        : [];

    const pages = Array.isArray(normalized.pages) ? normalized.pages : [];
    const tablesPreview = Array.isArray(normalized.tablesPreview)
      ? normalized.tablesPreview
      : Array.isArray(normalized.tables)
        ? normalized.tables
        : [];

    // =========================================================
    // Layer 1: Normalization Helpers
    // =========================================================

    const DIGIT_MAP = {
      "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
      "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
      "٫": ".", "٬": ",", "−": "-", "–": "-", "—": "-", "ـ": ""
    };

    function toEnglishDigits(value) {
      return String(value || "").replace(/[٠-٩٫٬−–—ـ]/g, (m) => DIGIT_MAP[m] || m);
    }

    function normalizeArabic(text) {
      return String(text || "")
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[إأآا]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/ؤ/g, "و")
        .replace(/ئ/g, "ي");
    }

    function normalizeText(value) {
      return normalizeArabic(toEnglishDigits(String(value || "")))
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function unique(arr) {
      return Array.from(new Set((arr || []).filter(Boolean)));
    }

    function safeNumber(v, fallback = 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }

    function flattenValue(v) {
      if (v == null) return "";
      if (Array.isArray(v)) return v.map(flattenValue).join("\n");
      if (typeof v === "object") return Object.values(v).map(flattenValue).join("\n");
      return String(v);
    }

    function parseNumberSmart(value) {
      if (value == null) return null;

      let s = String(value).trim();
      if (!s) return null;

      s = toEnglishDigits(s)
        .replace(/\s/g, "")
        .replace(/[ ريالرسعوديةsarusd$]/gi, "")
        .replace(/[^\d.,()\-]/g, "");

      if (!s) return null;

      let negative = false;
      if (s.includes("(") && s.includes(")")) negative = true;
      s = s.replace(/[()]/g, "");

      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      if (hasDot && hasComma) {
        const lastDot = s.lastIndexOf(".");
        const lastComma = s.lastIndexOf(",");
        if (lastDot > lastComma) {
          s = s.replace(/,/g, "");
        } else {
          s = s.replace(/\./g, "").replace(",", ".");
        }
      } else if (hasComma && !hasDot) {
        const parts = s.split(",");
        const last = parts[parts.length - 1];
        if (last.length === 1 || last.length === 2) {
          s = parts.slice(0, -1).join("") + "." + last;
        } else {
          s = s.replace(/,/g, "");
        }
      } else if (hasDot && !hasComma) {
        const parts = s.split(".");
        const last = parts[parts.length - 1];
        if (!(last.length === 1 || last.length === 2)) {
          s = s.replace(/\./g, "");
        }
      }

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return negative ? -n : n;
    }

    function extractYears(text) {
      const s = toEnglishDigits(String(text || ""));
      const years = s.match(/\b(19\d{2}|20\d{2})\b/g) || [];
      return unique(years.map(Number)).sort((a, b) => b - a);
    }

    function isYearCell(cell) {
      return /^(19|20)\d{2}$/.test(toEnglishDigits(String(cell || "").trim()));
    }

    function getYearFromCell(cell) {
      const raw = toEnglishDigits(String(cell || "").trim());
      if (!raw) return null;

      if (/^(19|20)\d{2}$/.test(raw)) {
        return Number(raw);
      }

      const years = raw.match(/\b(19\d{2}|20\d{2})\b/g) || [];
      if (years.length === 1) {
        const n = Number(years[0]);
        if (Number.isFinite(n)) return n;
      }

      return null;
    }

    function isNoteHeaderCell(cell) {
      const s = normalizeText(cell);
      return s === "ايضاح" || s === "الايضاح" || s === "notes" || s === "note";
    }

    function isQuarterOrPeriodCell(cell) {
      const s = normalizeText(cell);
      return (
        s.includes("ثلاثه اشهر") ||
        s.includes("ثلاثة اشهر") ||
        s.includes("3 اشهر") ||
        s.includes("for the year ended") ||
        s.includes("for the period ended") ||
        s.includes("for the year") ||
        s.includes("for the period") ||
        s.includes("3 months") ||
        s.includes("12 months") ||
        s.includes("السنه المنتهيه") ||
        s.includes("الفتره المنتهيه") ||
        s.includes("as of") ||
        s.includes("كما في") ||
        s.includes("المنتهيه في")
      );
    }

    function countNumbers(text) {
      const s = toEnglishDigits(String(text || ""));
      const matches = s.match(/(?:\(?-?\d[\d,]*\.?\d*\)?)/g);
      return matches ? matches.length : 0;
    }

    function containsAny(text, phrases) {
      const s = normalizeText(text);
      return (phrases || []).some((p) => s.includes(normalizeText(p)));
    }

    function keywordHits(text, phrases) {
      const s = normalizeText(text);
      let score = 0;
      for (const p of (phrases || [])) {
        const x = normalizeText(p);
        if (!x) continue;
        if (s.includes(x)) score += 1;
      }
      return score;
    }

    function countDistinctPhraseHits(text, phrases) {
      const s = normalizeText(text);
      const hits = [];
      for (const phrase of (phrases || [])) {
        const p = normalizeText(phrase);
        if (!p) continue;
        if (s.includes(p)) hits.push(p);
      }
      return unique(hits);
    }

    function isBlank(v) {
      return String(v == null ? "" : v).trim() === "";
    }

    function cleanupLabel(label) {
      let s = String(label || "").trim();
      s = s.replace(/\s+/g, " ").trim();
      s = s.replace(/^[\-\–\—•·*]+\s*/, "");
      s = s.replace(/\s*[:：]\s*$/, "");
      return s.trim();
    }

    function pageNumFromObj(obj) {
      return safeNumber(
        obj?.pageNumber ??
        obj?.page ??
        obj?.pageIndex ??
        obj?.page_no ??
        obj?.pageNum,
        null
      );
    }

    function tableText(table) {
      return [
        table?.sample,
        table?.sampleHead,
        table?.sampleTail,
        table?.text,
        table?.content,
        table?.markdown,
        table?.preview,
        table?.tableText,
        table?.rawText
      ]
        .filter(Boolean)
        .map(flattenValue)
        .join("\n");
    }

    function getTableRowCount(table) {
      return safeNumber(table?.rowCount ?? table?.rows ?? table?.nRows ?? 0, 0);
    }

    function getTableColumnCount(table) {
      return safeNumber(table?.columnCount ?? table?.columns ?? table?.nCols ?? 0, 0);
    }

    function extractTableRows(table) {
      const rows = [];
      const parts = [];

      if (Array.isArray(table?.sampleHead)) parts.push(...table.sampleHead);
      if (Array.isArray(table?.sample)) parts.push(...table.sample);
      if (Array.isArray(table?.sampleTail)) parts.push(...table.sampleTail);

      for (const row of parts) {
        if (Array.isArray(row)) {
          rows.push(row.map((x) => String(x == null ? "" : x).trim()));
        } else if (row != null) {
          rows.push([String(row).trim()]);
        }
      }

      return rows.filter((r) => r.some((c) => !isBlank(c)));
    }

    function rowsWithMeta(table) {
      const rows = extractTableRows(table);
      return rows.map((cells, index) => ({
        index,
        cells,
        joined: cells.join(" | "),
        normalized: normalizeText(cells.join(" | "))
      }));
    }

    function isLikelyOnlyReferenceText(value) {
      const raw = toEnglishDigits(String(value || "").trim());
      const s = normalizeText(raw);
      if (!raw) return false;

      if (/^\(?\d{1,3}[a-zA-Z]?\)?$/.test(raw)) return true;
      if (/^[a-zA-Z]\d{1,3}$/.test(raw)) return true;
      if (/^\d{1,2}(\.\d{1,2})?$/.test(raw)) return true;
      if (/^\d+\s*\/\s*\d+$/.test(raw)) return true;
      if (/^\d+\s*-\s*\d+$/.test(raw)) return true;
      if (/^\d+\s*(,|&)\s*\d+$/.test(raw)) return true;
      if (/^\d+\s*and\s*\d+$/i.test(raw)) return true;
      if (/^\d+\s*و\s*\d+$/.test(raw)) return true;
      if (/^\d+\s*و\d+$/.test(raw)) return true;
      if (/^\(?\d{1,3}\)?\s*(و|and|\/|-)\s*\(?\d{1,3}\)?$/i.test(raw)) return true;
      if (s === "n/a") return false;

      return false;
    }

    function isLikelyReferenceValue(cell) {
      const raw = String(cell || "").trim();
      if (!raw) return false;
      if (isNoteHeaderCell(raw)) return true;
      if (isYearCell(raw)) return false;
      return isLikelyOnlyReferenceText(raw);
    }

        function isLikelyStatementDateText(text) {
      const s = normalizeText(text);
      return (
        s.includes("31 december") ||
        s.includes("31 ديسمبر") ||
        s.includes("كما في") ||
        s.includes("as of") ||
        s.includes("for the year ended") ||
        s.includes("for the period ended") ||
        s.includes("السنه المنتهيه") ||
        s.includes("الفتره المنتهيه")
      );
    }

    function isLikelyStandardEffectiveDateText(text) {
      const s = normalizeText(text);
      return (
        s.includes("effective date") ||
        s.includes("effective dates") ||
        s.includes("1 january") ||
        s.includes("1 يناير") ||
        s.includes("تاريخ سريان") ||
        s.includes("ifrs amendments") ||
        s.includes("international accounting standard") ||
        s.includes("international financial reporting standard")
      );
    }

    function isLikelyNarrativeLine(text) {
      const s = normalizeText(text);
      if (!s) return false;
      return (
        s.includes("تم تاجيل") ||
        s.includes("لم يتم تحديد") ||
        s.includes("تعتبر الايضاحات") ||
        s.includes("تشكل الايضاحات") ||
        s.includes("integral part of these consolidated financial statements") ||
        s.includes("accompanying notes") ||
        s.includes("تشكل الايضاحات المرفقة") ||
        s.includes("جزءا لا يتجزا")
      );
    }

    function isPureNumericSymbolCell(text) {
      const raw = toEnglishDigits(String(text || "").trim());
      if (!raw) return false;
      return /^[\d,.\-()]+$/.test(raw);
    }

    function hasArabicChars(text) {
      return /[\u0600-\u06FF]/.test(String(text || ""));
    }

    function hasLatinChars(text) {
      return /[A-Za-z]/.test(String(text || ""));
    }

    function isLikelyTextLabelCell(cell) {
      const raw = String(cell || "").trim();
      if (!raw) return false;
      if (isNoteHeaderCell(raw)) return false;
      if (getYearFromCell(raw) != null) return false;
      if (isLikelyReferenceValue(raw)) return false;
      if (isLikelyStatementDateText(raw)) return false;
      if (isLikelyStandardEffectiveDateText(raw)) return false;
      if (isLikelyNarrativeLine(raw)) return false;
      if (isQuarterOrPeriodCell(raw)) return false;
      if (isPureNumericSymbolCell(raw)) return false;

      const n = parseNumberSmart(raw);
      if (n != null && !/[^\d.,()\-]/.test(toEnglishDigits(raw))) return false;

      return /[A-Za-z\u0600-\u06FF]/.test(raw);
    }

    function countLikelyTextLabels(rows, limit = 24) {
      let count = 0;
      for (const row of (rows || []).slice(0, limit)) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (isLikelyTextLabelCell(cell)) count += 1;
        }
      }
      return count;
    }

    // =========================================================
    // Layer 2: Page / Table Context Builder
    // =========================================================

    function getTablesForPage(pageNumber) {
      return tablesPreview.filter((t) => pageNumFromObj(t) === pageNumber);
    }

    function getTableDensityScore(table) {
      return (getTableRowCount(table) * 10) + getTableColumnCount(table);
    }

    function pickMainTable(tables) {
      const list = Array.isArray(tables) ? tables : [];
      if (!list.length) return null;
      return list.slice().sort((a, b) => getTableDensityScore(b) - getTableDensityScore(a))[0];
    }

    function getHeaderRows(rows) {
      return [rows[0] || [], rows[1] || [], rows[2] || [], rows[3] || [], rows[4] || [], rows[5] || []];
    }

    function getNumericColumnDensity(rows, limit = 24) {
      const out = {};
      for (const row of (rows || []).slice(0, limit)) {
        if (!Array.isArray(row)) continue;
        row.forEach((cell, idx) => {
          const num = parseNumberSmart(cell);
          if (num != null && !isLikelyReferenceValue(cell) && !isYearCell(cell)) {
            out[idx] = (out[idx] || 0) + 1;
          }
        });
      }

      return Object.keys(out)
        .map((k) => ({ idx: Number(k), score: out[k] }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);
    }

    function detectTableLanguageDirection(rows) {
      let arabicScore = 0;
      let latinScore = 0;

      for (const row of (rows || []).slice(0, 20)) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          const raw = String(cell || "").trim();
          if (!raw) continue;
          if (hasArabicChars(raw)) arabicScore += 2;
          if (hasLatinChars(raw)) latinScore += 1;
        }
      }

      return {
        isArabicTable: arabicScore > latinScore,
        direction: arabicScore > latinScore ? "rtl" : "ltr",
        arabicScore,
        latinScore
      };
    }

    function detectHeaderColumns(rows) {
      const headerRows = getHeaderRows(rows);
      const language = detectTableLanguageDirection(rows);

      let latest = null;
      let previous = null;
      let currentCol = null;
      let previousCol = null;
      let noteCol = null;
      let labelCol = null;
      let headerRowIndex = null;
      let mode = "fallback";

      for (let i = 0; i < headerRows.length; i += 1) {
        const row = headerRows[i];
        if (!Array.isArray(row) || !row.length) continue;

        const yearCells = row
          .map((cell, idx) => ({ idx, year: getYearFromCell(cell) }))
          .filter((x) => Number.isFinite(x.year));

        if (yearCells.length >= 2) {
          const sortedYears = yearCells.slice().sort((a, b) => b.year - a.year || a.idx - b.idx);
          latest = sortedYears[0]?.year ?? null;
          previous = sortedYears[1]?.year ?? null;
          currentCol = yearCells.find((x) => x.year === latest)?.idx ?? null;
          previousCol = yearCells.find((x) => x.year === previous)?.idx ?? null;
          headerRowIndex = i;
          mode = "year_header";
          break;
        }
      }

      for (const row of headerRows) {
        for (let i = 0; i < row.length; i += 1) {
          if (isNoteHeaderCell(row[i])) {
            noteCol = i;
            break;
          }
        }
        if (noteCol != null) break;
      }

      if (currentCol == null || previousCol == null) {
        const numericCols = getNumericColumnDensity(rows, 24)
          .filter((x) => x.idx !== noteCol);

        if (numericCols.length >= 2) {
          const candidates = numericCols
            .slice(0, 6)
            .map((x) => x.idx)
            .sort((a, b) => a - b)
            .slice(-2);

          previousCol = candidates[0] ?? previousCol;
          currentCol = candidates[1] ?? currentCol;
          mode = mode === "fallback" ? "numeric_density" : mode;
        } else if (numericCols.length === 1) {
          currentCol = numericCols[0].idx;
          mode = mode === "fallback" ? "single_numeric_column" : mode;
        }
      }

      const maxColCount = Math.max(0, ...((rows || []).map((r) => Array.isArray(r) ? r.length : 0)));
      const reservedCols = new Set([currentCol, previousCol, noteCol].filter((x) => Number.isFinite(x)));

      const freeCols = [];
      for (let c = 0; c < maxColCount; c += 1) {
        if (!reservedCols.has(c)) freeCols.push(c);
      }

      if (freeCols.length > 0) {
        labelCol = language.direction === "rtl" ? Math.max(...freeCols) : Math.min(...freeCols);
      }

      const distinctLabel = Number.isFinite(labelCol) && !reservedCols.has(labelCol);

      return {
        latest,
        previous,
        currentCol,
        previousCol,
        noteCol,
        labelCol: distinctLabel ? labelCol : null,
        hasDistinctLabelColumn: distinctLabel,
        headerRowIndex,
        resolutionMode: mode,
        direction: language.direction,
        isArabicTable: language.isArabicTable,
        languageScores: {
          arabic: language.arabicScore,
          latin: language.latinScore
        }
      };
    }

        function buildPageContext(pageNumber, orderedPageNumbers) {
      const pageMeta = pages.find((p) => safeNumber(p.pageNumber) === pageNumber) || {};
      const pageTables = getTablesForPage(pageNumber);
      const mainTable = pickMainTable(pageTables);
      const mainRows = extractTableRows(mainTable);
      const header = detectHeaderColumns(mainRows);

      const mainTableText = tableText(mainTable);
      const allText = pageTables.map(tableText).join("\n\n");
      const headerText = getHeaderRows(mainRows).map((r) => flattenValue(r)).join("\n");
      const firstRowsText = mainRows.slice(0, 10).map((r) => r.join(" | ")).join("\n");
      const lastRowsText = mainRows.slice(-10).map((r) => r.join(" | ")).join("\n");
      const structuralText = `${headerText}\n${firstRowsText}\n${lastRowsText}\n${mainTableText}\n${allText}`;
      const normalizedText = normalizeText(structuralText);

      const index = orderedPageNumbers.indexOf(pageNumber);
      const positionRatio = orderedPageNumbers.length > 1
        ? index / (orderedPageNumbers.length - 1)
        : 0;

      const hasStatementTitle = containsAny(`${headerText}\n${mainTableText}\n${allText}`, [
        "قائمة المركز المالي",
        "قائمة الدخل",
        "قائمة الدخل الموحدة",
        "قائمة التدفقات النقدية",
        "statement of financial position",
        "income statement",
        "statement of income",
        "statement of cash flows",
        "cash flow statement",
        "statement of profit or loss",
        "statement of comprehensive income",
        "statement of profit or loss and other comprehensive income"
      ]);

      const hasYearLikeHeader = getHeaderRows(mainRows).some((r) => {
        const joined = normalizeText(r.join(" | "));
        return extractYears(joined).length >= 2 && (
          joined.includes("ايضاح") ||
          joined.includes("notes") ||
          joined.includes("note") ||
          isQuarterOrPeriodCell(joined)
        );
      });

      const isLikelyIndexPage =
        containsAny(normalizedText, [
          "الفهرس",
          "جدول المحتويات",
          "table of contents",
          "independent auditor",
          "تقرير مراجعي الحسابات المستقلين"
        ]) &&
        containsAny(normalizedText, [
          "قائمة المركز المالي",
          "قائمة الدخل",
          "قائمة التدفقات النقدية",
          "statement of financial position",
          "statement of profit or loss",
          "statement of cash flows"
        ]);

      const isLikelyStandardsPage =
        (
          containsAny(normalizedText, [
            "السياسات المحاسبية",
            "السياسة المحاسبية",
            "accounting policies",
            "financial instruments",
            "risk management",
            "تحليل الحساسية",
            "liquidity risk",
            "credit risk",
            "maturity",
            "repricing",
            "ifrs",
            "international accounting standard",
            "international financial reporting standard"
          ]) ||
          isLikelyStandardEffectiveDateText(normalizedText)
        ) &&
        !hasStatementTitle;

      const isLikelyEquityStatement =
        getTableColumnCount(mainTable) >= 8 ||
        containsAny(normalizedText, [
          "قائمة التغيرات في حقوق الملكية",
          "قائمة التغيرات في حقوق المساهمين",
          "statement of changes in equity",
          "retained earnings",
          "treasury shares",
          "non-controlling interests",
          "احتياطي نظامي",
          "اسهم خزينة",
          "أسهم خزينة",
          "share capital",
          "share premium"
        ]);

      const isLikelyComprehensiveIncome =
        containsAny(normalizedText, [
          "قائمة الدخل الشامل",
          "الدخل الشامل",
          "statement of comprehensive income",
          "other comprehensive income",
          "بنود الدخل الشامل الاخر",
          "other comprehensive"
        ]);

      const isLikelyNarrativePage =
        isLikelyNarrativeLine(normalizedText) ||
        isLikelyStandardEffectiveDateText(normalizedText);

      return {
        pageNumber,
        pageMeta,
        tables: pageTables,
        mainTable,
        mainTableText,
        mainRows,
        mainRowsMeta: rowsWithMeta(mainTable),
        mainColumnCount: getTableColumnCount(mainTable),
        mainRowCount: getTableRowCount(mainTable),
        tableCount: pageTables.length,
        rowCount: pageTables.reduce((sum, t) => sum + getTableRowCount(t), 0),
        columnCount: pageTables.reduce((sum, t) => sum + getTableColumnCount(t), 0),
        text: allText,
        headerText,
        structuralText,
        normalizedText,
        numbersCount: countNumbers(allText),
        years: extractYears(allText),
        header,
        hasDistinctLabelColumn: !!header?.hasDistinctLabelColumn,
        positionRatio,
        hasStatementTitle,
        hasYearLikeHeader,
        isLikelyIndexPage,
        isLikelyStandardsPage,
        isLikelyEquityStatement,
        isLikelyComprehensiveIncome,
        isLikelyNarrativePage
      };
    }

    const allPageNumbers = unique(
      tablesPreview
        .map((t) => pageNumFromObj(t))
        .filter((n) => Number.isFinite(n) && n > 0)
    ).sort((a, b) => a - b);

    const pageContexts = allPageNumbers.map((pageNumber) =>
      buildPageContext(pageNumber, allPageNumbers)
    );

    // =========================================================
    // Layer 3: Statement Profile Detection
    // =========================================================

    const PROFILE_CONFIG = {
      bank: {
        key: "bank",
        positive: [
          "الدخل من التمويل",
          "التمويل والاستثمارات",
          "رسوم الخدمات المصرفية",
          "اجمالي دخل العمليات",
          "ودائع العملاء",
          "البنوك المركزية",
          "المؤسسات المالية الاخرى",
          "تمويل وسلف",
          "صكوك",
          "special commission",
          "customer deposits",
          "central banks",
          "due from banks",
          "due to banks",
          "financing and advances",
          "commission income"
        ],
        negative: [
          "revenue",
          "cost of sales",
          "gross profit",
          "inventories",
          "selling and distribution expenses",
          "insurance revenue",
          "investment properties"
        ]
      },

      insurance: {
        key: "insurance",
        positive: [
          "ايرادات التامين",
          "إيرادات التأمين",
          "خدمة التامين",
          "خدمة التأمين",
          "اعاده التامين",
          "إعادة التأمين",
          "مطالبات",
          "claims",
          "reinsurance",
          "insurance revenue",
          "insurance service result",
          "insurance finance income",
          "insurance finance expenses",
          "liability for incurred claims"
        ],
        negative: [
          "customer deposits",
          "special commission",
          "gross financing",
          "investment properties"
        ]
      },

      reit: {
        key: "reit",
        positive: [
          "عقارات استثمارية",
          "دخل ايجار",
          "دخل إيجار",
          "وحدات الصندوق",
          "القيمه العادله للوحده",
          "القيمة العادلة للوحدة",
          "investment properties",
          "rental income",
          "fair value of unit",
          "fund units",
          "real estate"
        ],
        negative: [
          "customer deposits",
          "insurance revenue",
          "gross financing and investment income"
        ]
      },

      operating_company: {
        key: "operating_company",
        positive: [
          "الايرادات",
          "المبيعات",
          "تكلفة المبيعات",
          "تكلفة الايرادات",
          "مجمل الربح",
          "الربح التشغيلي",
          "المخزون",
          "المدينون التجاريون",
          "الموردون",
          "revenue",
          "sales",
          "cost of sales",
          "cost of revenue",
          "gross profit",
          "operating profit",
          "inventories",
          "trade receivables",
          "trade payables",
          "selling and distribution expenses",
          "general and administrative expenses"
        ],
        negative: [
          "ودائع العملاء",
          "البنوك المركزية",
          "المؤسسات المالية الاخرى",
          "special commission",
          "customer deposits",
          "central banks",
          "due from banks",
          "due to banks",
          "insurance revenue"
        ]
      }
    };

    function detectStatementProfile() {
      const fullText = pageContexts.map((p) => p.structuralText || "").join("\n\n");
      const scores = {};

      for (const key of Object.keys(PROFILE_CONFIG)) {
        const cfg = PROFILE_CONFIG[key];
        const positive = keywordHits(fullText, cfg.positive);
        const negative = keywordHits(fullText, cfg.negative);
        scores[key] = (positive * 8) - (negative * 5);
      }

      const sorted = Object.keys(scores)
        .map((k) => ({ key: k, score: scores[k] }))
        .sort((a, b) => b.score - a.score);

      const statementProfile = sorted[0]?.key || "operating_company";

      return {
        statementProfile,
        scores,
        rankedProfiles: sorted,
        reason: `${statementProfile} keywords strongest`
      };
    }

    const profileDetection = detectStatementProfile();
    const statementProfile = profileDetection.statementProfile;
    let finalSector = detectedSector;

    if (
      finalSector === "operating_company" &&
      statementProfile &&
      sectorProfiles[statementProfile]
    ) {
      finalSector = statementProfile;
    }

    const finalSectorProfile =
      sectorProfiles[finalSector] || sectorProfiles.operating_company || {};

    const sectorInfo =
      finalSector !== rawSectorInfo?.sector
        ? {
            ...rawSectorInfo,
            sector: finalSector,
            reasons: [
              `sector overridden by statement profile: ${rawSectorInfo?.sector} -> ${finalSector}`
            ]
          }
        : {
            ...rawSectorInfo,
            sector: finalSector
          };
        // =========================================================
    // Layer 4: Statement Page Ranking and Selection
    // =========================================================

    const STATEMENT_CONFIGS = {
      bank: {
        balance: {
          key: "balance",
          titles: [
            "قائمة المركز المالي",
            "المركز المالي",
            "قائمة الوضع المالي",
            "الميزانية",
            "الميزانية العمومية",
            "statement of financial position",
            "financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: [
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "اجمالي المطلوبات وحقوق الملكيه",
            "الموجودات",
            "المطلوبات",
            "حقوق الملكيه",
            "ودائع العملاء",
            "نقد وارصده لدى البنوك المركزيه",
            "ارصده لدى البنوك والمؤسسات الماليه الاخرى",
            "تمويل وسلف",
            "استثمارات",
            "total assets",
            "total liabilities",
            "total equity",
            "total liabilities and equity",
            "assets",
            "liabilities",
            "equity"
          ],
          negatives: [
            "قائمة الدخل",
            "الدخل الشامل",
            "قائمة التغيرات في حقوق الملكية",
            "قائمة التدفقات النقدية",
            "statement of income",
            "statement of comprehensive income",
            "changes in equity",
            "cash flow"
          ]
        },
        income: {
          key: "income",
          titles: [
            "قائمة الدخل",
            "قائمة الدخل الموحدة",
            "قائمة الارباح والخسائر",
            "قائمة الربح والخسارة",
            "statement of income",
            "income statement",
            "profit and loss",
            "profit or loss",
            "statement of profit or loss",
            "consolidated statement of profit or loss"
          ],
          structure: [
            "الدخل من التمويل",
            "الدخل من التمويل والاستثمارات",
            "صافي الدخل من التمويل والاستثمار",
            "صافي دخل العمولات الخاصة",
            "ايرادات العمولات الخاصة",
            "رسوم الخدمات المصرفية",
            "صافي دخل الاتعاب والعمولات",
            "اجمالي دخل العمليات",
            "اجمالي مصاريف العمليات",
            "دخل العمليات",
            "دخل السنة قبل الزكاة",
            "صافي دخل السنة",
            "ربحية السهم",
            "gross financing and investment income",
            "net financing and investment income",
            "fee from banking services",
            "net special commission income",
            "total operating income",
            "operating income",
            "operating profit",
            "net income",
            "earnings"
          ],
          negatives: [
            "الدخل الشامل",
            "قائمة الدخل الشامل",
            "statement of comprehensive income",
            "other comprehensive income",
            "قائمة التغيرات في حقوق الملكية",
            "changes in equity",
            "قائمة المركز المالي",
            "قائمة التدفقات النقدية"
          ]
        },
        cashflow: {
          key: "cashflow",
          titles: [
            "قائمة التدفقات النقدية",
            "بيان التدفقات النقدية",
            "التدفقات النقدية",
            "cash flow statement",
            "statement of cash flows",
            "consolidated statement of cash flows"
          ],
          structure: [
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد من الانشطة التشغيلية",
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد من الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية",
            "صافي النقد من الانشطة التمويلية",
            "التغير في النقد",
            "التغير في النقد وما في حكمه",
            "النقد وشبه النقد",
            "النقد وما في حكمه",
            "operating activities",
            "investing activities",
            "financing activities",
            "cash and cash equivalents",
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities"
          ],
          negatives: [
            "قائمة الدخل",
            "الدخل الشامل",
            "قائمة المركز المالي",
            "قائمة التغيرات في حقوق الملكية",
            "statement of income",
            "comprehensive income",
            "financial position",
            "changes in equity"
          ]
        }
      },

      insurance: {
        balance: {
          key: "balance",
          titles: [
            "قائمة المركز المالي",
            "المركز المالي",
            "statement of financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: [
            "نقد وما في حكمه",
            "ودائع لاجل",
            "استثمارات",
            "ذمم اعاده التامين",
            "موجودات اعاده التامين",
            "مطلوبات عقود التامين",
            "liabilities for incurred claims",
            "reinsurance contract assets",
            "insurance contract liabilities",
            "total assets",
            "total liabilities",
            "total equity",
            "assets",
            "liabilities",
            "equity"
          ],
          negatives: [
            "statement of cash flows",
            "statement of comprehensive income",
            "changes in equity"
          ]
        },
        income: {
          key: "income",
          titles: [
            "قائمة الدخل",
            "statement of income",
            "income statement",
            "statement of profit or loss",
            "consolidated statement of profit or loss"
          ],
          structure: [
            "ايرادات التامين",
            "إيرادات التأمين",
            "نتيجه خدمه التامين",
            "نتيجة خدمة التأمين",
            "مطالبات",
            "اعاده التامين",
            "إعادة التأمين",
            "insurance revenue",
            "insurance service result",
            "reinsurance",
            "claims",
            "net income",
            "operating income"
          ],
          negatives: [
            "statement of comprehensive income",
            "other comprehensive income",
            "statement of cash flows",
            "changes in equity"
          ]
        },
        cashflow: {
          key: "cashflow",
          titles: [
            "قائمة التدفقات النقدية",
            "statement of cash flows",
            "cash flow statement",
            "consolidated statement of cash flows"
          ],
          structure: [
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد من الانشطة التشغيلية",
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد من الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية",
            "صافي النقد من الانشطة التمويلية",
            "التغير في النقد",
            "التغير في النقد وما في حكمه",
            "cash flows from operating activities",
            "cash and cash equivalents",
            "operating activities",
            "investing activities",
            "financing activities"
          ],
          negatives: [
            "statement of comprehensive income",
            "effective date",
            "المعايير",
            "changes in equity"
          ]
        }
      },

      reit: {
        balance: {
          key: "balance",
          titles: [
            "قائمة المركز المالي",
            "المركز المالي",
            "statement of financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: [
            "عقارات استثمارية",
            "موجودات",
            "مطلوبات",
            "حقوق الملكية",
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "اجمالي حقوق الملكية",
            "investment properties",
            "assets",
            "liabilities",
            "equity",
            "total assets",
            "total liabilities",
            "total equity"
          ],
          negatives: [
            "statement of cash flows",
            "statement of comprehensive income",
            "changes in equity"
          ]
        },
        income: {
          key: "income",
          titles: [
            "قائمة الدخل",
            "statement of income",
            "income statement",
            "statement of profit or loss",
            "consolidated statement of profit or loss"
          ],
          structure: [
            "دخل ايجار",
            "دخل إيجار",
            "صافي الربح",
            "ربح التشغيل",
            "ايرادات",
            "investment properties",
            "rental income",
            "operating profit",
            "net income",
            "revenue"
          ],
          negatives: [
            "statement of comprehensive income",
            "other comprehensive income",
            "statement of cash flows",
            "changes in equity"
          ]
        },
        cashflow: {
          key: "cashflow",
          titles: [
            "قائمة التدفقات النقدية",
            "statement of cash flows",
            "cash flow statement",
            "consolidated statement of cash flows"
          ],
          structure: [
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد من الانشطة التشغيلية",
            "صافي النقد من الانشطة الاستثمارية",
            "صافي النقد من الانشطة التمويلية",
            "التغير في النقد",
            "النقد وما في حكمه",
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "cash and cash equivalents"
          ],
          negatives: [
            "statement of comprehensive income",
            "changes in equity"
          ]
        }
      },

      operating_company: {
        balance: {
          key: "balance",
          titles: [
            "قائمة المركز المالي",
            "المركز المالي",
            "قائمة الوضع المالي",
            "الميزانية",
            "الميزانية العمومية",
            "statement of financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: balanceKeywords.length ? balanceKeywords : [
            "الموجودات", "الأصول", "الاصول", "المطلوبات", "الالتزامات",
            "حقوق الملكية", "إجمالي الموجودات", "اجمالي الموجودات",
            "إجمالي المطلوبات", "اجمالي المطلوبات", "إجمالي حقوق الملكية",
            "اجمالي حقوق الملكية", "assets", "liabilities", "equity",
            "total assets", "total liabilities", "total equity"
          ],
          negatives: [
            "قائمة الدخل", "الدخل الشامل", "قائمة التدفقات النقدية",
            "قائمة التغيرات في حقوق الملكية", "statement of income",
            "statement of comprehensive income", "statement of cash flows",
            "changes in equity"
          ]
        },
        income: {
          key: "income",
          titles: [
            "قائمة الدخل",
            "قائمة الأرباح والخسائر",
            "قائمة الارباح والخسائر",
            "قائمة الربح والخسارة",
            "statement of income",
            "income statement",
            "statement of profit or loss",
            "profit or loss",
            "consolidated statement of profit or loss"
          ],
          structure: incomeKeywords.length ? incomeKeywords : [
            "الايرادات", "الإيرادات", "المبيعات", "تكلفة المبيعات",
            "تكلفة الايرادات", "تكلفة الإيرادات", "مجمل الربح",
            "الربح التشغيلي", "الدخل التشغيلي", "صافي الربح",
            "صافي الدخل", "revenue", "sales", "cost of sales",
            "gross profit", "operating profit", "operating income",
            "net profit", "net income"
          ],
          negatives: [
            "الدخل الشامل", "قائمة الدخل الشامل",
            "statement of comprehensive income", "other comprehensive income",
            "قائمة المركز المالي", "قائمة التدفقات النقدية",
            "changes in equity", "statement of cash flows"
          ]
        },
        cashflow: {
          key: "cashflow",
          titles: [
            "قائمة التدفقات النقدية",
            "بيان التدفقات النقدية",
            "التدفقات النقدية",
            "cash flow statement",
            "statement of cash flows",
            "consolidated statement of cash flows"
          ],
          structure: cashflowKeywords.length ? cashflowKeywords : [
            "التدفقات النقدية من الأنشطة التشغيلية",
            "التدفقات النقدية من الأنشطة الاستثمارية",
            "التدفقات النقدية من الأنشطة التمويلية",
            "صافي النقد من الانشطة التشغيلية",
            "صافي النقد من الانشطة الاستثمارية",
            "صافي النقد من الانشطة التمويلية",
            "التغير في النقد", "التغير في النقد وما في حكمه",
            "النقد وما في حكمه", "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "cash and cash equivalents"
          ],
          negatives: [
            "قائمة الدخل", "الدخل الشامل", "قائمة المركز المالي",
            "قائمة التغيرات في حقوق الملكية", "statement of income",
            "comprehensive income", "financial position", "changes in equity"
          ]
        }
      }
    };

    const ACTIVE_STATEMENT_CONFIGS =
      STATEMENT_CONFIGS[statementProfile] || STATEMENT_CONFIGS.operating_company;

    function mergeStatementConfigWithSectorKeywords(kind, cfg) {
      const sectorStructure =
        kind === "income"
          ? incomeKeywords
          : kind === "balance"
            ? balanceKeywords
            : cashflowKeywords;

      return {
        ...cfg,
        structure: unique([
          ...(cfg?.structure || []),
          ...(sectorStructure || [])
        ])
      };
    }

        function getHeaderSearchText(pageCtx) {
      return flattenValue(pageCtx?.header || "");
    }

    function getPageStatementText(pageCtx) {
      const firstRowsText = (pageCtx?.mainRows || [])
        .slice(0, 10)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      return [
        getHeaderSearchText(pageCtx),
        pageCtx?.headerText || "",
        firstRowsText,
        pageCtx?.mainTableText || "",
        pageCtx?.text || "",
        pageCtx?.structuralText || ""
      ].join("\n");
    }

    function statementRankScore(pageCtx, cfg, kind) {
      let score = 0;
      const reasons = [];
      const signals = {};

      if (!pageCtx) {
        return { score, reasons, signals };
      }

      const headerText = getHeaderSearchText(pageCtx);
      const wholeText = getPageStatementText(pageCtx);
      const firstRowsText = (pageCtx.mainRows || [])
        .slice(0, 6)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      const titleHitsHeader = countDistinctPhraseHits(
        `${headerText}\n${pageCtx.headerText || ""}\n${pageCtx.mainTableText || ""}`,
        cfg.titles || []
      );
      const titleHitsAll = countDistinctPhraseHits(wholeText, cfg.titles || []);
      const structureHitsAll = countDistinctPhraseHits(wholeText, cfg.structure || []);
      const structureHitsFirstRows = countDistinctPhraseHits(
        `${firstRowsText}\n${pageCtx.mainTableText || ""}`,
        cfg.structure || []
      );
      const negativeHits = countDistinctPhraseHits(wholeText, cfg.negatives || []);

      signals.titleHitsHeader = titleHitsHeader;
      signals.titleHitsAll = titleHitsAll;
      signals.structureHitsAll = structureHitsAll;
      signals.structureHitsFirstRows = structureHitsFirstRows;
      signals.negativeHits = negativeHits;

      if (titleHitsHeader.length > 0) {
  const base = titleHitsHeader.length * 90;
  const multiplier = structureHitsAll.length > 0 ? 1 : 0.6;
  const s = Math.round(base * multiplier);
  score += s;
  reasons.push(`titleHeader:+${s}`);
} else if (titleHitsAll.length > 0) {
  const base = titleHitsAll.length * 40;
  const multiplier = structureHitsAll.length > 0 ? 1 : 0.6;
  const s = Math.round(base * multiplier);
  score += s;
  reasons.push(`titleAll:+${s}`);
}

      if (structureHitsAll.length > 0) {
        const s = Math.min(structureHitsAll.length, 10) * 16;
        score += s;
        reasons.push(`structureAll:+${s}`);
      }

      if (structureHitsFirstRows.length > 0) {
        const s = Math.min(structureHitsFirstRows.length, 6) * 18;
        score += s;
        reasons.push(`structureFirstRows:+${s}`);
      }

      const structureSupportCount =
  structureHitsAll.length + structureHitsFirstRows.length;
      if (structureSupportCount >= 5 && pageCtx.positionRatio <= 0.35) {
  score += 25;
  reasons.push("strongStructureBonus:+25");
}

if (pageCtx.hasYearLikeHeader) {
  const s = structureSupportCount > 0 ? 22 : 10;
  score += s;
  reasons.push(`yearHeader:+${s}`);
}

if (pageCtx.years && pageCtx.years.length >= 2) {
  const s = structureSupportCount > 0 ? 14 : 6;
  score += s;
  reasons.push(`yearsDetected:+${s}`);
} else if (pageCtx.years && pageCtx.years.length === 1) {
  const s = structureSupportCount > 0 ? 5 : 2;
  score += s;
  reasons.push(`singleYearDetected:+${s}`);
}

      if (pageCtx.numbersCount > 20) {
  const s = structureSupportCount > 0 ? 10 : 4;
  score += s;
  reasons.push(`numbersDensity:+${s}`);
}

if (pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 60) {
  const s = structureSupportCount > 0 ? 8 : 3;
  score += s;
  reasons.push(`rowRange:+${s}`);
}

if (pageCtx.mainColumnCount >= 3 && pageCtx.mainColumnCount <= 8) {
  const s = structureSupportCount > 0 ? 8 : 3;
  score += s;
  reasons.push(`columnRange:+${s}`);
}

      if (pageCtx.positionRatio <= 0.30) {
  const s = structureSupportCount > 0 ? 8 : 3;
  score += s;
  reasons.push(`earlyPage:+${s}`);
} else if (pageCtx.positionRatio >= 0.35) {
  score -= 120;
  reasons.push("latePagePenalty:-120");
}

      if (pageCtx.isLikelyIndexPage) {
        score -= 220;
        reasons.push("indexPenalty:-220");
      }

      if (pageCtx.isLikelyStandardsPage) {
        score -= 190;
        reasons.push("standardsPenalty:-190");
      }

      if (pageCtx.isLikelyNarrativePage) {
        score -= 170;
        reasons.push("narrativePenalty:-170");
      }

      if (kind === "income" && pageCtx.isLikelyComprehensiveIncome) {
        score -= 140;
        reasons.push("comprehensiveIncomePenalty:-140");
      }

      if (kind !== "income" && pageCtx.isLikelyComprehensiveIncome) {
        score -= 60;
        reasons.push("crossStatementComprehensivePenalty:-60");
      }

      if (pageCtx.isLikelyEquityStatement) {
        score -= 120;
        reasons.push("equityStatementPenalty:-120");
      }

      if (negativeHits.length > 0) {
        const s = Math.min(negativeHits.length, 8) * 20;
        score -= s;
        reasons.push(`negativeHits:-${s}`);
      }

      const hasNoTitle = titleHitsHeader.length === 0 && titleHitsAll.length === 0;
const hasNoStructure = structureHitsAll.length === 0 && structureHitsFirstRows.length === 0;

if (hasNoTitle && hasNoStructure) {
  const penalty = kind === "balance" ? 70 : 110;
  score -= penalty;
  reasons.push(`noTitleNoStructure:-${penalty}`);
}

      return {
        score,
        reasons,
        signals
      };
    }

    function rankPages(kind) {
      const cfg = mergeStatementConfigWithSectorKeywords(
        kind,
        ACTIVE_STATEMENT_CONFIGS[kind]
      );

      return pageContexts
        .map((pageCtx) => {
          const ranked = statementRankScore(pageCtx, cfg, kind);

          return {
            pageNumber: pageCtx.pageNumber,
            score: ranked.score,
            reasons: ranked.reasons,
            signals: ranked.signals,
            years: pageCtx.years,
            numbersCount: pageCtx.numbersCount,
            rowCount: pageCtx.rowCount,
            tableCount: pageCtx.tableCount,
            mainColumnCount: pageCtx.mainColumnCount,
            mainRowCount: pageCtx.mainRowCount,
            positionRatio: pageCtx.positionRatio,
            header: pageCtx.header
          };
        })
        .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    }

    const rankedBalance = rankPages("balance");
    const rankedIncome = rankPages("income");
    const rankedCashflow = rankPages("cashflow");

    // =========================================================
    // Score Calibration Layer
    // =========================================================

    function normalizeRankingScores(list) {
      if (!Array.isArray(list) || !list.length) return [];

      const maxScore = Math.max(...list.map((x) => x.score));
      const minScore = Math.min(...list.map((x) => x.score));
      const range = Math.max(1, maxScore - minScore);

      return list.map((item) => ({
        ...item,
        normalizedScore: Math.round(((item.score - minScore) / range) * 100)
      }));
    }

    const calibratedIncome = normalizeRankingScores(rankedIncome);
    const calibratedBalance = normalizeRankingScores(rankedBalance);
    const calibratedCashflow = normalizeRankingScores(rankedCashflow);

    // =========================================================
    // Confidence Score
    // =========================================================

    function computeConfidence(rankList) {
      if (!rankList || rankList.length < 2) return 0.5;

      const top = rankList[0].score;
      const second = rankList[1].score;
      const diff = top - second;

      if (diff > 200) return 0.95;
      if (diff > 120) return 0.9;
      if (diff > 60) return 0.8;
      if (diff > 30) return 0.7;
      if (diff > 10) return 0.6;

      return 0.5;
    }

    const confidence = {
      income: computeConfidence(rankedIncome),
      balance: computeConfidence(rankedBalance),
      cashflow: computeConfidence(rankedCashflow)
    };

    let incomePage = rankedIncome[0]?.pageNumber || null;
    let balancePage = rankedBalance[0]?.pageNumber || null;
    let cashFlowPage = rankedCashflow[0]?.pageNumber || null;

    function topPages(list, limit = 3) {
      return (list || []).slice(0, limit).map((x) => x.pageNumber);
    }

    const strongIncomePages = new Set(topPages(rankedIncome, 3));
    const strongBalancePages = new Set(topPages(rankedBalance, 3));
    const strongCashflowPages = new Set(topPages(rankedCashflow, 3));

    function findAlternative(list, blockedPages) {
      return (list || []).find((p) => !blockedPages.has(p.pageNumber))?.pageNumber || null;
    }

    function getPageContextByNumber(pageNumber) {
      return pageContexts.find((p) => p.pageNumber === pageNumber) || null;
    }

    function getNeighborPageContext(basePageNumber, offset = 1) {
      if (!Number.isFinite(basePageNumber)) return null;
      return getPageContextByNumber(basePageNumber + offset);
    }

    function getContinuationConfig(kind) {
      const cfg = mergeStatementConfigWithSectorKeywords(
        kind,
        ACTIVE_STATEMENT_CONFIGS[kind]
      );

      return {
        titles: cfg?.titles || [],
        structure: cfg?.structure || [],
        negatives: cfg?.negatives || []
      };
    }

    function continuationScore(candidateCtx, kind) {
      if (!candidateCtx) {
        return { score: -999, reasons: [] };
      }

      const cfg = getContinuationConfig(kind);
      const text = getPageStatementText(candidateCtx);
      const firstRowsText = (candidateCtx.mainRows || [])
        .slice(0, 8)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      const titleHits = countDistinctPhraseHits(
        `${candidateCtx.headerText || ""}\n${candidateCtx.mainTableText || ""}`,
        cfg.titles
      );

      const structureHitsAll = countDistinctPhraseHits(text, cfg.structure);
      const structureHitsFirstRows = countDistinctPhraseHits(firstRowsText, cfg.structure);
      const negativeHits = countDistinctPhraseHits(text, cfg.negatives);

      let score = 0;
      const reasons = [];

      if (structureHitsAll.length > 0) {
        const s = Math.min(structureHitsAll.length, 8) * 18;
        score += s;
        reasons.push(`structureAll:+${s}`);
      }

      if (structureHitsFirstRows.length > 0) {
        const s = Math.min(structureHitsFirstRows.length, 5) * 20;
        score += s;
        reasons.push(`structureFirstRows:+${s}`);
      }

      if (titleHits.length > 0) {
        const s = Math.min(titleHits.length, 2) * 20;
        score += s;
        reasons.push(`title:+${s}`);
      }

            if (candidateCtx.hasYearLikeHeader) {
        score += 15;
        reasons.push("yearHeader:+15");
      }

      if ((candidateCtx.years || []).length >= 2) {
        score += 12;
        reasons.push("years:+12");
      }

      if (candidateCtx.numbersCount >= 12) {
        score += 12;
        reasons.push("numbers:+12");
      }

      if (candidateCtx.mainRowCount >= 6) {
        score += 10;
        reasons.push("rowCount:+10");
      }

      if (candidateCtx.mainColumnCount >= 3) {
        score += 8;
        reasons.push("columnCount:+8");
      }

      if (candidateCtx.isLikelyIndexPage) {
        score -= 220;
        reasons.push("indexPenalty:-220");
      }

      if (candidateCtx.isLikelyStandardsPage) {
        score -= 180;
        reasons.push("standardsPenalty:-180");
      }

      if (candidateCtx.isLikelyNarrativePage) {
        score -= 150;
        reasons.push("narrativePenalty:-150");
      }

      if (candidateCtx.isLikelyEquityStatement) {
        score -= 120;
        reasons.push("equityPenalty:-120");
      }

      if (kind === "income" && candidateCtx.isLikelyComprehensiveIncome) {
        score -= 120;
        reasons.push("comprehensivePenalty:-120");
      }

      if (negativeHits.length > 0) {
        const s = Math.min(negativeHits.length, 6) * 22;
        score -= s;
        reasons.push(`negativeHits:-${s}`);
      }

      return { score, reasons };
    }

    function pageLooksLikeOtherStatementTitle(pageCtx, currentKind) {
      if (!pageCtx) return false;

      const kinds = ["income", "balance", "cashflow"].filter((k) => k !== currentKind);

      const titleText = [
        pageCtx.headerText || "",
        ...(pageCtx.mainRows || [])
          .slice(0, 3)
          .map((r) => Array.isArray(r) ? r.join(" | ") : "")
      ].join("\n");

      for (const kind of kinds) {
        const cfg = mergeStatementConfigWithSectorKeywords(
          kind,
          ACTIVE_STATEMENT_CONFIGS[kind]
        );

        const otherTitleHits = countDistinctPhraseHits(titleText, cfg?.titles || []);
        if (otherTitleHits.length >= 2) {
          return true;
        }
      }

      return false;
    }

    function looksLikeSameStatement(baseCtx, candidateCtx) {
      if (!baseCtx || !candidateCtx) return false;

      let score = 0;

      if (
        Math.abs((baseCtx.mainColumnCount || 0) - (candidateCtx.mainColumnCount || 0)) <= 1
      ) {
        score += 20;
      }

      if (
        Math.abs((baseCtx.numbersCount || 0) - (candidateCtx.numbersCount || 0)) <= 20
      ) {
        score += 20;
      }

      if (
        Math.abs((baseCtx.mainRowCount || 0) - (candidateCtx.mainRowCount || 0)) <= 20
      ) {
        score += 20;
      }

      if (
        baseCtx.years &&
        candidateCtx.years &&
        baseCtx.years.some((y) => candidateCtx.years.includes(y))
      ) {
        score += 20;
      }

      if ((baseCtx.mainRowCount || 0) > 5 && (candidateCtx.mainRowCount || 0) > 5) {
        score += 20;
      }

      return score >= 60;
    }

    function detectStatementContinuation(basePageNumber, kind) {
      const baseCtx = getPageContextByNumber(basePageNumber);

      if (!baseCtx) {
        return {
          basePage: basePageNumber || null,
          pages: Number.isFinite(basePageNumber) ? [basePageNumber] : [],
          details: {
            previousPage: null,
            nextPage: null
          }
        };
      }

      const prevCtx = getNeighborPageContext(basePageNumber, -1);
      const nextCtx = getNeighborPageContext(basePageNumber, 1);

      const prevEval = continuationScore(prevCtx, kind);
      const nextEval = continuationScore(nextCtx, kind);

      const pages = [basePageNumber];

      if (
        prevCtx &&
        prevEval.score >= 55 &&
        !pageLooksLikeOtherStatementTitle(prevCtx, kind) &&
        (
          looksLikeSameStatement(baseCtx, prevCtx) ||
          prevEval.score >= 200
        )
      ) {
        pages.unshift(prevCtx.pageNumber);
      }

      if (
        nextCtx &&
        nextEval.score >= 55 &&
        !pageLooksLikeOtherStatementTitle(nextCtx, kind) &&
        (
          looksLikeSameStatement(baseCtx, nextCtx) ||
          nextEval.score >= 200
        )
      ) {
        pages.push(nextCtx.pageNumber);
      }

      return {
        basePage: basePageNumber,
        pages: unique(pages).sort((a, b) => a - b),
        details: {
          previousPage: prevCtx
            ? {
                pageNumber: prevCtx.pageNumber,
                score: prevEval.score,
                reasons: prevEval.reasons
              }
            : null,
          nextPage: nextCtx
            ? {
                pageNumber: nextCtx.pageNumber,
                score: nextEval.score,
                reasons: nextEval.reasons
              }
            : null
        }
      };
    }

    if (incomePage && balancePage && incomePage === balancePage) {
      const incomeScore = rankedIncome.find((p) => p.pageNumber === incomePage)?.score ?? -999999;
      const balanceScore = rankedBalance.find((p) => p.pageNumber === balancePage)?.score ?? -999999;

      if (balanceScore >= incomeScore) {
        incomePage = findAlternative(
          rankedIncome,
          new Set([balancePage, ...strongBalancePages, cashFlowPage].filter(Boolean))
        ) || incomePage;
      } else {
        balancePage = findAlternative(
          rankedBalance,
          new Set([incomePage, ...strongIncomePages, cashFlowPage].filter(Boolean))
        ) || balancePage;
      }
    }

    if (incomePage && cashFlowPage && incomePage === cashFlowPage) {
      cashFlowPage = findAlternative(
        rankedCashflow,
        new Set([incomePage, balancePage, ...strongIncomePages].filter(Boolean))
      ) || cashFlowPage;
    }

    if (balancePage && cashFlowPage && balancePage === cashFlowPage) {
      cashFlowPage = findAlternative(
        rankedCashflow,
        new Set([balancePage, incomePage, ...strongBalancePages].filter(Boolean))
      ) || cashFlowPage;
    }

    if (
      incomePage &&
      strongCashflowPages.has(incomePage) &&
      !strongIncomePages.has(incomePage)
    ) {
      incomePage = findAlternative(
        rankedIncome,
        new Set([balancePage, cashFlowPage, ...strongCashflowPages].filter(Boolean))
      ) || incomePage;
    }

    if (
      cashFlowPage &&
      strongIncomePages.has(cashFlowPage) &&
      !strongCashflowPages.has(cashFlowPage)
    ) {
      cashFlowPage = findAlternative(
        rankedCashflow,
        new Set([incomePage, balancePage, ...strongIncomePages].filter(Boolean))
      ) || cashFlowPage;
    }

    const incomeContinuation = detectStatementContinuation(incomePage, "income");
    const balanceContinuation = detectStatementContinuation(balancePage, "balance");
    const cashflowContinuation = detectStatementContinuation(cashFlowPage, "cashflow");

    const statementPageRanges = {
      income: incomeContinuation.pages,
      balance: balanceContinuation.pages,
      cashflow: cashflowContinuation.pages
    };

    return send(200, {
      ok: true,
      sector: finalSector,
      sectorInfo,
      activeSectorProfile: finalSectorProfile,
      engine: "extract-financial-v6.7",
      phase: "5_sector_keyword_ranking_safe_build",
      fileName: body.fileName || normalized?.meta?.fileName || null,
      statementProfile,

      selectedPages: {
        incomePage,
        balancePage,
        cashFlowPage
      },

      statementPageRanges,

      confidence,

      debug: {
        continuation: {
          income: incomeContinuation,
          balance: balanceContinuation,
          cashflow: cashflowContinuation
        },
        profileDetection,
        activeProfileKeywords: {
          income: incomeKeywords.slice(0, 12),
          balance: balanceKeywords.slice(0, 12),
          cashflow: cashflowKeywords.slice(0, 12)
        },
        ranking: {
          balanceTop: calibratedBalance.slice(0, 5),
          incomeTop: calibratedIncome.slice(0, 5),
          cashFlowTop: calibratedCashflow.slice(0, 5)
        }
      },

      meta: {
        pages: normalized?.meta?.pages ?? pages.length ?? null,
        tables: normalized?.meta?.tables ?? tablesPreview.length ?? null,
        textLength: normalized?.meta?.textLength ?? null
      },

      normalizedPrevExists: !!normalizedPrev
    });
  } catch (err) {
    return send(500, {
      ok: false,
      error: err?.message || "unknown error in extract-financial"
    });
  }
};









  
