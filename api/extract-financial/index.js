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
    const detectedSector = rawSectorInfo.sector;
    const activeSectorProfile =
      sectorProfiles[detectedSector] || sectorProfiles.operating_company;

    const sectorStatements = activeSectorProfile.statements || {};
    const incomeKeywords = sectorStatements.income || [];
    const balanceKeywords = sectorStatements.balance || [];
    const cashflowKeywords = sectorStatements.cashflow || [];

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
        s.includes("31 december 2025") ||
        s.includes("31 december 2024") ||
        s.includes("31 december 2023") ||
        s.includes("31 december") ||
        s.includes("31 ديسمبر 2025") ||
        s.includes("31 ديسمبر 2024") ||
        s.includes("31 ديسمبر 2023") ||
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
        s.includes("1 january 2026") ||
        s.includes("1 january 2027") ||
        s.includes("1 january 2028") ||
        s.includes("1 january") ||
        s.includes("1 يناير 2026") ||
        s.includes("1 يناير 2027") ||
        s.includes("1 يناير") ||
        s.includes("لم يتم تحديد تاريخ سريان") ||
        s.includes("تم تاجيل تاريخ سريان") ||
        s.includes("تاريخ سريان") ||
        s.includes("الفتره التقرير السنويه") ||
        s.includes("الفترة التقرير السنوية") ||
        s.includes("الفترات التقريريه") ||
        s.includes("المجلس الدولي للمعايير المحاسبيه") ||
        s.includes("المجلس الدولي للمعايير المحاسبية") ||
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

    function isLikelyOwnershipPercentValue(value) {
      const raw = toEnglishDigits(String(value || "").trim());
      if (!raw) return false;
      if (isYearCell(raw)) return false;
      if (isLikelyReferenceValue(raw)) return false;

      const n = parseNumberSmart(raw);
      if (n == null) return false;

      return n >= 0 && n <= 100 && raw.length <= 8;
    }

    function isLikelySubsidiaryNarrativeText(text) {
      const s = normalizeText(text);
      if (!s) return false;

      const ownershipKeywords = [
        "شركة تابعة",
        "شركه تابعه",
        "شركة زميلة",
        "شركه زميله",
        "شركة مساهمة",
        "شركة مساهمه",
        "شركة ذات مسؤولية محدودة",
        "شركه ذات مسؤوليه محدوده",
        "ذات غرض خاص",
        "غرض خاص",
        "special purpose entity",
        "special purpose vehicle",
        "spv",
        "subsidiar",
        "associate",
        "ownership",
        "percentage of ownership",
        "country of incorporation",
        "principal activity",
        "incorporated",
        "registered in",
        "cayman",
        "جزر كايمان",
        "تركيا",
        "باكستان",
        "saudi arabia",
        "المملكه العربيه السعوديه",
        "المملكة العربية السعودية",
        "النشاط الرئيسي",
        "نسبة الملكية",
        "نسبه الملكيه"
      ];

      const wordCount = s.split(/\s+/).filter(Boolean).length;
      const hitCount = ownershipKeywords.filter((k) => s.includes(normalizeText(k))).length;

      return hitCount >= 2 || (hitCount >= 1 && wordCount >= 10);
    }

    function isLikelyOwnershipHeaderText(text) {
      const s = normalizeText(text);
      return (
        s.includes("نسبة الملكية") ||
        s.includes("نسبه الملكيه") ||
        s.includes("principal activity") ||
        s.includes("country of incorporation") ||
        s.includes("ownership") ||
        s.includes("subsidiar")
      );
    }

    function isLikelyOwnershipRow(cells) {
      const arr = Array.isArray(cells) ? cells : [];
      if (!arr.length) return false;

      const joined = arr.join(" | ");
      const textCells = arr.filter((x) => isLikelyTextLabelCell(x));
      const percentLikeCount = arr.filter((x) => isLikelyOwnershipPercentValue(x)).length;
      const longNarrative = textCells.some((x) => {
        const clean = cleanupLabel(x);
        const wordCount = normalizeText(clean).split(/\s+/).filter(Boolean).length;
        return clean.length >= 35 || wordCount >= 6;
      });

      return (
        isLikelyOwnershipHeaderText(joined) ||
        (isLikelySubsidiaryNarrativeText(joined) && percentLikeCount >= 1) ||
        (longNarrative && percentLikeCount >= 1)
      );
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

    function compactFinancialShape(pageCtx) {
      return (
        pageCtx.mainRowCount >= 8 &&
        pageCtx.mainRowCount <= 60 &&
        pageCtx.mainColumnCount >= 3 &&
        pageCtx.mainColumnCount <= 8 &&
        pageCtx.numbersCount >= 24
      );
    }

    function semanticYearSignals(pageCtx) {
      const header = pageCtx.header || {};
      const yearHits = extractYears(
        `${pageCtx.headerText || ""}\n${pageCtx.mainTableText || ""}\n${pageCtx.text || ""}\n${pageCtx.structuralText || ""}`
      );
      const latest = header.latest;
      const previous = header.previous;

      const duplicateHeaderYears =
        Number.isFinite(latest) &&
        Number.isFinite(previous) &&
        latest === previous;

      const usableTwoYears =
        Number.isFinite(latest) &&
        Number.isFinite(previous) &&
        latest !== previous;

      return {
        yearsFound: yearHits,
        usableTwoYears,
        duplicateHeaderYears
      };
    }

    function bankDenseCandidateSignals(pageCtx) {
      const yearSignals = semanticYearSignals(pageCtx);
      const labelCount = countLikelyTextLabels(pageCtx.mainRows, 24);
      const compactShape = compactFinancialShape(pageCtx);
      const earlyEnough = pageCtx.positionRatio <= 0.22;
      const hasTitle = pageCtx.hasStatementTitle;
      const hasSomeYears = yearSignals.usableTwoYears || yearSignals.yearsFound.length >= 1;
      const dense = pageCtx.numbersCount >= 28;
      const structured = labelCount >= 6;

      return {
        compactShape,
        earlyEnough,
        hasTitle,
        hasSomeYears,
        dense,
        structured,
        labelCount,
        qualifies: compactShape && earlyEnough && hasSomeYears && dense && structured
      };
    }

    function truncatedRtlNumericStatementSignals(pageCtx) {
      const yearSignals = semanticYearSignals(pageCtx);
      const header = pageCtx.header || {};
      const joinedMain = normalizeText(pageCtx.mainTableText || "");
      const hasNoteCol = Number.isFinite(header.noteCol) || joinedMain.includes("ايضاح") || joinedMain.includes("notes");
      const earlyEnough = pageCtx.positionRatio <= 0.12;
      const threeCols = pageCtx.mainColumnCount === 3;
      const noDistinctLabel = !header.hasDistinctLabelColumn;
      const denseNumbers = pageCtx.numbersCount >= 40;
      const enoughRows = pageCtx.mainRowCount >= 12;
      const rtl = header.direction === "rtl";
      const hasSomeYears = yearSignals.usableTwoYears || yearSignals.yearsFound.length >= 1;

      return {
        earlyEnough,
        threeCols,
        noDistinctLabel,
        hasNoteCol,
        denseNumbers,
        enoughRows,
        rtl,
        hasSomeYears,
        qualifies:
          earlyEnough &&
          threeCols &&
          noDistinctLabel &&
          hasNoteCol &&
          denseNumbers &&
          enoughRows &&
          rtl &&
          hasSomeYears
      };
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

    function scoreLabelColumnsFromBody(rows, headerState) {
      const scoreByCol = {};
      const start = headerState?.headerRowIndex != null
        ? Math.max(0, headerState.headerRowIndex + 1)
        : 0;

      for (const row of (rows || []).slice(start, start + 40)) {
        if (!Array.isArray(row)) continue;

        row.forEach((cell, idx) => {
          const raw = String(cell || "").trim();
          if (!raw) return;
          if (idx === headerState?.currentCol || idx === headerState?.previousCol || idx === headerState?.noteCol) return;
          if (!isLikelyTextLabelCell(raw)) return;

          let score = Math.min(raw.length, 80) + 10;
          if (hasArabicChars(raw)) score += 8;
          if (headerState?.direction === "rtl") score += idx * 6;
          if (headerState?.direction === "ltr") score += (row.length - idx) * 2;

          scoreByCol[idx] = (scoreByCol[idx] || 0) + score;
        });
      }

      return Object.keys(scoreByCol)
        .map((k) => ({ idx: Number(k), score: scoreByCol[k] }))
        .sort((a, b) => b.score - a.score || b.idx - a.idx);
    }

    function refineLabelColumnFromBody(rows, headerState) {
      const ranked = scoreLabelColumnsFromBody(rows, headerState);
      if (ranked.length) {
        if (headerState?.direction === "rtl") {
          const bestScore = ranked[0].score;
          const close = ranked.filter((x) => x.score >= bestScore - 14);
          return close.sort((a, b) => b.idx - a.idx || b.score - a.score)[0].idx;
        }
        return ranked[0].idx;
      }

      const maxCols = Math.max(0, ...((rows || []).map((r) => Array.isArray(r) ? r.length : 0)));
      const reserved = new Set(
        [headerState?.currentCol, headerState?.previousCol, headerState?.noteCol]
          .filter((x) => Number.isFinite(x))
      );

      if (headerState?.direction === "rtl") {
        for (let c = maxCols - 1; c >= 0; c -= 1) {
          if (!reserved.has(c)) return c;
        }
      } else {
        for (let c = 0; c < maxCols; c += 1) {
          if (!reserved.has(c)) return c;
        }
      }

      return headerState?.labelCol ?? 0;
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
          .map((cell, idx) => ({
            idx,
            year: getYearFromCell(cell)
          }))
          .filter((x) => Number.isFinite(x.year));

        if (yearCells.length >= 2) {
          const sortedYears = yearCells.slice().sort((a, b) => b.year - a.year || a.idx - b.idx);
          latest = sortedYears[0]?.year ?? null;
          previous = sortedYears[1]?.year ?? null;

          currentCol = yearCells.find((x) => x.year === latest)?.idx ?? null;
          previousCol = yearCells.find((x) => x.year === previous)?.idx ?? null;
          headerRowIndex = i;
          mode = "year_header";

          for (let c = 0; c < row.length; c += 1) {
            if (isNoteHeaderCell(row[c])) {
              noteCol = c;
              break;
            }
          }

          const candidates = [];
          for (let c = 0; c < row.length; c += 1) {
            if (c === currentCol || c === previousCol || c === noteCol) continue;
            const text = String(row[c] || "").trim();
            if (!text) continue;
            if (!isLikelyTextLabelCell(text)) continue;
            candidates.push(c);
          }

          if (candidates.length) {
            labelCol = language.direction === "rtl" ? Math.max(...candidates) : Math.min(...candidates);
          }
          break;
        }
      }

      if ((currentCol == null || previousCol == null) && headerRows.length >= 2) {
        for (let i = 0; i < headerRows.length - 1; i += 1) {
          const row1 = headerRows[i] || [];
          const row2 = headerRows[i + 1] || [];

          const mergedCandidates = [];
          const maxLen = Math.max(row1.length, row2.length);
          for (let c = 0; c < maxLen; c += 1) {
            const y1 = getYearFromCell(row1[c]);
            const y2 = getYearFromCell(row2[c]);
            const finalYear = Number.isFinite(y2) ? y2 : Number.isFinite(y1) ? y1 : null;
            if (Number.isFinite(finalYear)) {
              mergedCandidates.push({ idx: c, year: finalYear });
            }
          }

          if (mergedCandidates.length >= 2) {
            const sortedYears = mergedCandidates.slice().sort((a, b) => b.year - a.year || a.idx - b.idx);
            latest = sortedYears[0]?.year ?? latest ?? null;
            previous = sortedYears[1]?.year ?? previous ?? null;
            mode = "merged_year_header";
            currentCol = mergedCandidates.find((x) => x.year === latest)?.idx ?? currentCol;
            previousCol = mergedCandidates.find((x) => x.year === previous)?.idx ?? previousCol;
            headerRowIndex = i + 1;

            if (noteCol == null) {
              for (const row of [row1, row2]) {
                for (let c = 0; c < row.length; c += 1) {
                  if (isNoteHeaderCell(row[c])) {
                    noteCol = c;
                    break;
                  }
                }
                if (noteCol != null) break;
              }
            }

            break;
          }
        }
      }

      if (noteCol == null) {
        for (const row of headerRows) {
          for (let i = 0; i < row.length; i += 1) {
            if (isNoteHeaderCell(row[i])) {
              noteCol = i;
              break;
            }
          }
          if (noteCol != null) break;
        }
      }

      if (headerRowIndex == null) {
        for (let i = 0; i < headerRows.length; i += 1) {
          const row = headerRows[i] || [];
          if (!row.length) continue;

          const hasNoteHeader = row.some((cell) => isNoteHeaderCell(cell));
          const hasPeriodHeader = row.some((cell) => isQuarterOrPeriodCell(cell));
          const hasDateLikeYear = row.some((cell) => Number.isFinite(getYearFromCell(cell)));

          if (hasNoteHeader && (hasPeriodHeader || hasDateLikeYear || row.length >= 3)) {
            headerRowIndex = i;
            mode = mode === "fallback" ? "note_header" : mode;
            break;
          }

          if (hasPeriodHeader && hasDateLikeYear) {
            headerRowIndex = i;
            mode = mode === "fallback" ? "period_header" : mode;
            break;
          }
        }
      }

      if ((currentCol == null || previousCol == null) && headerRowIndex != null) {
        const neighborhood = [
          headerRows[headerRowIndex - 1] || [],
          headerRows[headerRowIndex] || [],
          headerRows[headerRowIndex + 1] || []
        ];

        const yearByCol = {};
        for (const row of neighborhood) {
          for (let c = 0; c < row.length; c += 1) {
            const year = getYearFromCell(row[c]);
            if (Number.isFinite(year)) {
              yearByCol[c] = Math.max(yearByCol[c] || 0, year);
            }
          }
        }

        const yearCols = Object.keys(yearByCol)
          .map((k) => ({ idx: Number(k), year: yearByCol[k] }))
          .sort((a, b) => b.year - a.year || a.idx - b.idx);

        if (yearCols.length >= 2) {
          latest = latest ?? yearCols[0].year;
          previous = previous ?? yearCols[1].year;
          currentCol = currentCol ?? yearCols.find((x) => x.year === latest)?.idx ?? yearCols[0].idx;
          previousCol = previousCol ?? yearCols.find((x) => x.year === previous)?.idx ?? yearCols[1].idx;
        }
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

      labelCol = refineLabelColumnFromBody(rows, {
        currentCol,
        previousCol,
        noteCol,
        labelCol,
        headerRowIndex,
        direction: language.direction
      });

      if (Number.isFinite(labelCol) && reservedCols.has(labelCol)) {
        labelCol = null;
        mode = `${mode}_label_collision_cleared`;
      }

      const freeCols = [];
      for (let c = 0; c < maxColCount; c += 1) {
        if (!reservedCols.has(c)) freeCols.push(c);
      }

      if (labelCol == null && freeCols.length > 0) {
        const candidate = language.direction === "rtl" ? Math.max(...freeCols) : Math.min(...freeCols);

        const candidateHasText = (rows || []).slice(0, 30).some((row) => {
          if (!Array.isArray(row)) return false;
          const raw = String(row[candidate] || "").trim();
          return raw && isLikelyTextLabelCell(raw);
        });

        if (candidateHasText) {
          labelCol = candidate;
          mode = `${mode}_${language.direction}_free_text_label_col`;
        }
      }

      if (Number.isFinite(labelCol) && reservedCols.has(labelCol)) {
        labelCol = null;
        mode = `${mode}_label_collision_cleared_again`;
      }

      if (maxColCount <= 3 && reservedCols.size >= maxColCount) {
        labelCol = null;
        mode = `${mode}_no_distinct_label_col`;
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

      const ownershipLikeRowCount = (mainRows || []).slice(0, 24).filter((r) => isLikelyOwnershipRow(r)).length;
      const isLikelyOwnershipPage =
        (
          containsAny(normalizedText, [
            "نسبة الملكية",
            "نسبه الملكيه",
            "principal activity",
            "country of incorporation",
            "ownership",
            "subsidiar",
            "شركة تابعة",
            "شركة ذات مسؤولية محدودة",
            "ذات غرض خاص",
            "special purpose entity",
            "special purpose vehicle"
          ]) &&
          ownershipLikeRowCount >= 2
        ) ||
        ownershipLikeRowCount >= 4;

      const pageGuardrails = {
        rejectAsIndex: isLikelyIndexPage,
        rejectAsStandards: isLikelyStandardsPage,
        rejectAsNarrative: isLikelyNarrativePage,
        rejectAsEquity: isLikelyEquityStatement,
        rejectAsComprehensive: isLikelyComprehensiveIncome,
        rejectAsOwnership: isLikelyOwnershipPage
      };

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
        isLikelyNarrativePage,
        isLikelyOwnershipPage,
        ownershipLikeRowCount,
        pageGuardrails
      };
    }

    const allPageNumbers = unique(
      tablesPreview
        .map((t) => pageNumFromObj(t))
        .filter((n) => Number.isFinite(n) && n > 0)
    ).sort((a, b) => a - b);

    const pageContexts = allPageNumbers.map((pageNumber) => buildPageContext(pageNumber, allPageNumbers));

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
      sectorProfiles[finalSector] || sectorProfiles.operating_company;

    const sectorInfo =
      finalSector !== rawSectorInfo.sector
        ? {
            ...rawSectorInfo,
            sector: finalSector,
            reasons: [
              `sector overridden by statement profile: ${rawSectorInfo.sector} -> ${finalSector}`
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
          structure: [
            "الموجودات",
            "الأصول",
            "الاصول",
            "المطلوبات",
            "الالتزامات",
            "حقوق الملكية",
            "إجمالي الموجودات",
            "اجمالي الموجودات",
            "إجمالي المطلوبات",
            "اجمالي المطلوبات",
            "إجمالي حقوق الملكية",
            "اجمالي حقوق الملكية",
            "الموجودات المتداولة",
            "الموجودات غير المتداولة",
            "المطلوبات المتداولة",
            "المطلوبات غير المتداولة",
            "assets",
            "liabilities",
            "equity",
            "current assets",
            "non-current assets",
            "current liabilities",
            "non-current liabilities",
            "total assets",
            "total liabilities",
            "total equity"
          ],
          negatives: [
            "قائمة الدخل",
            "الدخل الشامل",
            "قائمة التدفقات النقدية",
            "قائمة التغيرات في حقوق الملكية",
            "statement of income",
            "statement of comprehensive income",
            "statement of cash flows",
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
          structure: [
            "الايرادات",
            "الإيرادات",
            "المبيعات",
            "تكلفة المبيعات",
            "تكلفة الايرادات",
            "تكلفة الإيرادات",
            "مجمل الربح",
            "إجمالي الربح",
            "اجمالي الربح",
            "الربح التشغيلي",
            "الدخل التشغيلي",
            "صافي الربح",
            "صافي الدخل",
            "ربحية السهم",
            "revenue",
            "sales",
            "cost of sales",
            "cost of revenue",
            "gross profit",
            "operating profit",
            "operating income",
            "net profit",
            "net income",
            "earnings per share"
          ],
          negatives: [
            "الدخل الشامل",
            "قائمة الدخل الشامل",
            "statement of comprehensive income",
            "other comprehensive income",
            "قائمة المركز المالي",
            "قائمة التدفقات النقدية",
            "changes in equity",
            "statement of cash flows"
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
            "التدفقات النقدية من الأنشطة التشغيلية",
            "التدفقات النقدية من الأنشطة الاستثمارية",
            "التدفقات النقدية من الأنشطة التمويلية",
            "صافي النقد من الانشطة التشغيلية",
            "صافي النقد من الانشطة الاستثمارية",
            "صافي النقد من الانشطة التمويلية",
            "التغير في النقد",
            "التغير في النقد وما في حكمه",
            "النقد وما في حكمه",
            "النقدية وما يعادلها",
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "operating activities",
            "investing activities",
            "financing activities",
            "cash and cash equivalents"
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

        const SEMANTIC_RULES = {
      balance: {
        strongTitles: [
          "balance sheet",
          "statement of financial position",
          "consolidated statement of financial position",
          "قائمة المركز المالي",
          "قائمة المركز المالي الموحدة",
          "المركز المالي",
          "قائمة الوضع المالي"
        ],
        coreAnchors: [
          "assets",
          "liabilities",
          "equity",
          "total assets",
          "total liabilities",
          "total equity",
          "shareholders equity",
          "share capital",
          "retained earnings",
          "current assets",
          "non-current assets",
          "current liabilities",
          "non-current liabilities",
          "الاصول",
          "الأصول",
          "الموجودات",
          "المطلوبات",
          "الالتزامات",
          "حقوق الملكية",
          "اجمالي الاصول",
          "اجمالي الأصول",
          "اجمالي الموجودات",
          "اجمالي المطلوبات",
          "اجمالي حقوق الملكية",
          "رأس المال",
          "راس المال",
          "الأرباح المبقاة",
          "الارباح المبقاه"
        ],
        comboA: [
          "assets",
          "liabilities",
          "equity",
          "الأصول",
          "الاصول",
          "الموجودات",
          "المطلوبات",
          "الالتزامات",
          "حقوق الملكية"
        ],
        comboB: [
          "total assets",
          "total liabilities",
          "total equity",
          "shareholders equity",
          "share capital",
          "retained earnings",
          "اجمالي الاصول",
          "اجمالي الأصول",
          "اجمالي الموجودات",
          "اجمالي المطلوبات",
          "اجمالي حقوق الملكية",
          "رأس المال",
          "راس المال",
          "الأرباح المبقاة",
          "الارباح المبقاه"
        ],
        bankBoost: [
          "customer deposits",
          "due from banks",
          "due to banks",
          "cash and balances with central bank",
          "cash and balances with central banks",
          "loans and advances",
          "investments",
          "ودائع العملاء",
          "ارصدة لدى البنوك",
          "أرصدة لدى البنوك",
          "البنك المركزي",
          "البنوك المركزية",
          "قروض",
          "تمويل وسلف",
          "استثمارات"
        ],
        mandatory: {
          withTitleMinCore: 2,
          comboAMin: 2,
          comboBMin: 1
        }
      },

      income: {
        strongTitles: [
          "income statement",
          "statement of income",
          "statement of profit or loss",
          "consolidated statement of profit or loss",
          "profit or loss",
          "قائمة الدخل",
          "قائمة الربح أو الخسارة",
          "قائمة الربح والخسارة",
          "قائمة الأرباح والخسائر"
        ],
        coreAnchors: [
          "revenue",
          "sales",
          "gross profit",
          "operating income",
          "operating profit",
          "net income",
          "net profit",
          "earnings",
          "profit before tax",
          "profit before zakat and tax",
          "profit before zakat and income tax",
          "الايرادات",
          "الإيرادات",
          "المبيعات",
          "إجمالي الربح",
          "اجمالي الربح",
          "الدخل التشغيلي",
          "الربح التشغيلي",
          "صافي الربح",
          "صافي الدخل",
          "الربح قبل الزكاة والضريبة",
          "الربح قبل الزكاة وضريبة الدخل",
          "الدخل من التمويل",
          "الدخل من التمويل والاستثمارات",
          "صافي دخل العمولات الخاصة",
          "ايرادات العمولات الخاصة",
          "إيرادات العمولات الخاصة",
          "اجمالي دخل العمليات",
          "إجمالي دخل العمليات",
          "رسوم الخدمات المصرفية"
        ],
        comboA: [
          "revenue",
          "sales",
          "الإيرادات",
          "الايرادات",
          "المبيعات",
          "الدخل من التمويل",
          "الدخل من التمويل والاستثمارات",
          "صافي دخل العمولات الخاصة"
        ],
        comboB: [
          "operating income",
          "operating profit",
          "gross profit",
          "net income",
          "net profit",
          "earnings",
          "الدخل التشغيلي",
          "الربح التشغيلي",
          "صافي الربح",
          "صافي الدخل",
          "إجمالي الربح",
          "اجمالي الربح",
          "اجمالي دخل العمليات",
          "إجمالي دخل العمليات",
          "رسوم الخدمات المصرفية",
          "دخل السنة قبل الزكاة"
        ],
        bankBoost: [
          "special commission income",
          "special commission expense",
          "net special commission income",
          "total operating income",
          "impairment charge",
          "fee from banking services",
          "gross financing and investment income",
          "net financing and investment income",
          "إيرادات العمولات الخاصة",
          "ايرادات العمولات الخاصة",
          "صافي دخل العمولات الخاصة",
          "اجمالي دخل العمليات",
          "إجمالي دخل العمليات",
          "الدخل من التمويل",
          "الدخل من التمويل والاستثمارات",
          "خسائر الائتمان",
          "مخصص خسائر الائتمان"
        ],
        mandatory: {
          withTitleMinCore: 2,
          comboAMin: 1,
          comboBMin: 2
        }
      },

      cashflow: {
        strongTitles: [
          "cash flow statement",
          "statement of cash flows",
          "consolidated statement of cash flows",
          "قائمة التدفقات النقدية",
          "قائمة التدفقات النقدية الموحدة",
          "بيان التدفقات النقدية"
        ],
        coreAnchors: [
          "cash flows from operating activities",
          "cash flows from investing activities",
          "cash flows from financing activities",
          "operating activities",
          "investing activities",
          "financing activities",
          "cash and cash equivalents",
          "net increase in cash",
          "net decrease in cash",
          "beginning of the period",
          "end of the period",
          "beginning of the year",
          "end of the year",
          "التدفقات النقدية من الأنشطة التشغيلية",
          "التدفقات النقدية من الأنشطة الاستثمارية",
          "التدفقات النقدية من الأنشطة التمويلية",
          "صافي النقد من الانشطة التشغيلية",
          "صافي النقد من الانشطة الاستثمارية",
          "صافي النقد من الانشطة التمويلية",
          "التغير في النقد",
          "التغير في النقد وما في حكمه",
          "الأنشطة التشغيلية",
          "الأنشطة الاستثمارية",
          "الأنشطة التمويلية",
          "النقدية وما يعادلها",
          "النقد وما في حكمه",
          "صافي الزيادة في النقد",
          "صافي النقص في النقد",
          "في بداية الفترة",
          "في نهاية الفترة",
          "اول الفترة",
          "آخر الفترة"
        ],
        comboA: [
          "cash flows from operating activities",
          "operating activities",
          "الأنشطة التشغيلية",
          "الانشطه التشغيليه",
          "التدفقات النقدية من الأنشطة التشغيلية",
          "صافي النقد من الانشطة التشغيلية"
        ],
        comboB: [
          "cash flows from investing activities",
          "investing activities",
          "cash flows from financing activities",
          "financing activities",
          "الأنشطة الاستثمارية",
          "الانشطه الاستثماريه",
          "الأنشطة التمويلية",
          "الانشطه التمويليه",
          "التدفقات النقدية من الأنشطة الاستثمارية",
          "التدفقات النقدية من الأنشطة التمويلية",
          "صافي النقد من الانشطة الاستثمارية",
          "صافي النقد من الانشطة التمويلية"
        ],
        comboC: [
          "cash and cash equivalents",
          "net increase in cash",
          "net decrease in cash",
          "beginning of the period",
          "end of the period",
          "beginning of the year",
          "end of the year",
          "النقدية وما يعادلها",
          "النقد وما في حكمه",
          "صافي الزيادة في النقد",
          "صافي النقص في النقد",
          "التغير في النقد",
          "التغير في النقد وما في حكمه",
          "في بداية الفترة",
          "في نهاية الفترة",
          "اول الفترة",
          "آخر الفترة"
        ],
        mandatory: {
          withTitleMinCore: 2,
          comboAMin: 1,
          comboBMin: 1,
          comboCMin: 1
        }
      }
    };

    const NOTE_PENALTY_ANCHORS_GENERAL = [
      "risk", "risks", "market risk", "liquidity risk", "credit risk",
      "operational risk", "interest rate risk", "profit rate risk",
      "sensitivity", "sensitivities", "gap", "repricing", "repricing gap",
      "maturity", "maturities", "maturity gap", "fair value hierarchy",
      "debt securities", "medium term notes", "issued debt",
      "subordinated debt", "hedging", "financial instruments",
      "notes to the financial statements",
      "مخاطر", "مخاطر السوق", "مخاطر السيولة", "مخاطر الائتمان", "مخاطر التشغيل",
      "حساسية", "فجوة", "استحقاق", "القيمة العادلة",
      "أدوات مالية", "ادوات مالية", "تحوط", "إيضاحات القوائم المالية"
    ];

    const NOTE_PENALTY_ANCHORS_NON_BANK_ONLY = [
      "sukuk", "bonds", "derivatives", "صكوك", "سندات", "مشتقات"
    ];

    // ضع هنا بقية الدوال كما كانت عندك بدون تغيير:
    // statementKindTitleAliases
    // otherStatementTitleAliases
    // getPageStatementText
    // strongStatementTitleHit
    // countDistinctPhraseHits
    // rowPhraseCoverage
    // semanticAnchorCoverage
    // noteDetailSignals
    // crossStatementConflictSignals
    // mandatoryEligibility
    // semanticBoostScore
    // semanticPenaltyScore
    // statementSpecificCoreShape
    // statementRankScore

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
    // Score Calibration Layer (v6.6)
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

    return send(200, {
      ok: true,
      sector: finalSector,
      sectorInfo,
      activeSectorProfile: finalSectorProfile,
      engine: "extract-financial-v6.6",
      phase: "4B_semantic_ranking_hardening_plus_confidence",
      fileName: body.fileName || normalized?.meta?.fileName || null,
      statementProfile,

      selectedPages: {
        incomePage,
        balancePage,
        cashFlowPage
      },

      confidence,

      debug: {
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





  
