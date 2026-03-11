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
        .replace(/[ ريالرسعوديةsarusd\$]/gi, "")
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

    function normalizedContains(a, b) {
      const x = normalizeText(a);
      const y = normalizeText(b);
      return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
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

    function cleanupNote(note) {
      return String(note || "").replace(/\s+/g, " ").trim() || null;
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

    function isNumericOnlyText(text) {
      const s = toEnglishDigits(String(text || "").trim()).replace(/[(),\s]/g, "");
      if (!s) return false;
      return /^-?\d+(\.\d+)?$/.test(s);
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
        "jزر كايمان",
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

    function hasDistinctLabelColumn(header) {
      if (!header) return false;
      if (!Number.isFinite(header.labelCol)) return false;

      const reserved = new Set(
        [header.currentCol, header.previousCol, header.noteCol].filter((x) => Number.isFinite(x))
      );

      return !reserved.has(header.labelCol);
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
            labelCol = language.direction === "rtl"
              ? Math.max(...candidates)
              : Math.min(...candidates);
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
        const candidate = language.direction === "rtl"
          ? Math.max(...freeCols)
          : Math.min(...freeCols);

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

      const allText = pageTables.map(tableText).join("\n\n");
      const headerText = getHeaderRows(mainRows).map((r) => flattenValue(r)).join("\n");
      const firstRowsText = mainRows.slice(0, 10).map((r) => r.join(" | ")).join("\n");
      const lastRowsText = mainRows.slice(-10).map((r) => r.join(" | ")).join("\n");
      const structuralText = `${headerText}\n${firstRowsText}\n${lastRowsText}\n${allText}`;
      const normalizedText = normalizeText(structuralText);

      const index = orderedPageNumbers.indexOf(pageNumber);
      const positionRatio = orderedPageNumbers.length > 1
        ? index / (orderedPageNumbers.length - 1)
        : 0;

      const hasStatementTitle = containsAny(headerText, [
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
          "اعادة التامين",
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
          "عقارات استثماريه",
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
            "رسوم الخدمات المصرفية",
            "اجمالي دخل العمليات",
            "اجمالي مصاريف العمليات",
            "دخل السنة قبل الزكاة",
            "صافي دخل السنة",
            "ربحية السهم",
            "gross financing and investment income",
            "net financing and investment income",
            "fee from banking services",
            "net income",
            "revenue",
            "sales",
            "operating income",
            "operating profit",
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
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية",
            "النقد وشبه النقد",
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
            "statement of financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: [
            "عقارات استثمارية",
            "موجودات مالية بالقيمة العادلة من خلال الربح أو الخسارة",
            "وحدات الصندوق",
            "investment properties",
            "fund units",
            "total assets",
            "total liabilities",
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
            "statement of profit or loss",
            "income statement",
            "consolidated statement of profit or loss"
          ],
          structure: [
            "دخل ايجار",
            "دخل إيجار",
            "عقارات استثمارية",
            "توزيعات ارباح",
            "دخل تحويل",
            "rental income",
            "investment properties",
            "net income",
            "operating profit"
          ],
          negatives: [
            "statement of comprehensive income",
            "other comprehensive income",
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
            "صافي النقد الناتج من الانشطه التشغيليه",
            "صافي النقد المستخدم في الانشطه الاستثماريه",
            "صافي النقد الناتج من الانشطه التمويليه",
            "cash and cash equivalents",
            "operating activities",
            "investing activities",
            "financing activities"
          ],
          negatives: [
            "effective date",
            "المعايير",
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
            "financial position",
            "balance sheet",
            "consolidated statement of financial position"
          ],
          structure: [
            "assets",
            "liabilities",
            "equity",
            "total assets",
            "total liabilities",
            "total equity",
            "total liabilities and equity",
            "current assets",
            "non-current assets",
            "current liabilities",
            "non-current liabilities",
            "الموجودات",
            "المطلوبات",
            "حقوق الملكية",
            "اجمالي الموجودات",
            "اجمالي المطلوبات"
          ],
          negatives: [
            "special commission",
            "customer deposits",
            "central banks",
            "due from banks",
            "due to banks",
            "statement of cash flows",
            "statement of profit or loss"
          ]
        },
        income: {
          key: "income",
          titles: [
            "قائمة الدخل",
            "قائمة الارباح والخسائر",
            "قائمة الربح والخسارة",
            "statement of profit or loss",
            "statement of income",
            "income statement",
            "profit and loss",
            "profit or loss",
            "consolidated statement of profit or loss"
          ],
          structure: [
            "revenue",
            "sales",
            "cost of sales",
            "cost of revenue",
            "gross profit",
            "operating profit",
            "profit before zakat and income tax",
            "profit for the year",
            "earnings per share",
            "net income",
            "operating income",
            "الايرادات",
            "تكلفة المبيعات",
            "مجمل الربح",
            "الربح التشغيلي",
            "صافي الربح"
          ],
          negatives: [
            "قائمة الدخل الشامل",
            "الدخل الشامل",
            "statement of comprehensive income",
            "other comprehensive income",
            "statement of financial position",
            "statement of cash flows",
            "statement of changes in equity"
          ]
        },
        cashflow: {
          key: "cashflow",
          titles: [
            "قائمة التدفقات النقدية",
            "بيان التدفقات النقدية",
            "cash flow statement",
            "statement of cash flows",
            "cash flows",
            "consolidated statement of cash flows"
          ],
          structure: [
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "net cash from operating activities",
            "cash and cash equivalents",
            "operating activities",
            "investing activities",
            "financing activities",
            "صافي النقد الناتج من الانشطه التشغيليه",
            "صافي النقد المستخدم في الانشطه الاستثماريه",
            "صافي النقد الناتج من الانشطه التمويليه"
          ],
          negatives: [
            "statement of financial position",
            "statement of profit or loss",
            "gross profit",
            "total assets",
            "total liabilities",
            "statement of comprehensive income",
            "changes in equity"
          ]
        }
      }
    };

    const ACTIVE_STATEMENT_CONFIGS =
      STATEMENT_CONFIGS[statementProfile] || STATEMENT_CONFIGS.operating_company;
    

    function statementKindTitleAliases(kind) { /* نفس الكود */ }
    function otherStatementTitleAliases(kind) { /* نفس الكود */ }
    function getPageStatementText(pageCtx) { /* نفس الكود */ }

    function strongStatementTitleHit(pageCtx, cfg, kind) {
      const semantic = SEMANTIC_RULES[kind] || {};
      const titles = unique([...(cfg?.titles || []), ...(semantic.strongTitles || [])]);

      const headerHits = keywordHits(pageCtx.headerText, titles);
      if (headerHits > 0) return true;

      const firstRowsText = (pageCtx.mainRows || [])
        .slice(0, 6)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      if (keywordHits(firstRowsText, titles) > 0) return true;

      const structuralHits = keywordHits(pageCtx.structuralText, titles);
      if (structuralHits > 0 && pageCtx.positionRatio <= 0.2) return true;

      return false;
    }

    function countDistinctPhraseHits(text, phrases) { /* نفس الكود */ }
    function semanticYearSignals(pageCtx) { /* نفس الكود */ }
    function mandatoryEligibility(pageCtx, kind) { /* نفس الكود */ }
    function semanticBoostScore(pageCtx, cfg, kind) { /* نفس الكود */ }
    function semanticPenaltyScore(pageCtx, kind) { /* نفس الكود */ }
    function statementSpecificCoreShape(pageCtx, kind, cfg) { /* نفس الكود */ }

    function statementRankScore(pageCtx, cfg, kind) {
      let score = 0;
      const reasons = [];
      const signals = {};

      const titleHitsHeader = keywordHits(pageCtx.headerText, cfg.titles);
      const titleHitsAll = keywordHits(pageCtx.structuralText, cfg.titles);
      const structureHits = keywordHits(pageCtx.structuralText, cfg.structure);
      const negativeHits = keywordHits(pageCtx.structuralText, cfg.negatives);

      const firstRowsText = (pageCtx.mainRows || [])
        .slice(0, 6)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      const titleHitsFirstRows = keywordHits(firstRowsText, cfg.titles);
      const structureHitsFirstRows = keywordHits(firstRowsText, cfg.structure);
      const crossStatementTitleHits = keywordHits(pageCtx.structuralText, otherStatementTitleAliases(kind));
      const hasStrongOwnTitle = strongStatementTitleHit(pageCtx, cfg, kind);

      const yearSignals = semanticYearSignals(pageCtx);
      pageCtx.yearSignals = yearSignals;

      const semanticBoost = semanticBoostScore(pageCtx, cfg, kind);
      const semanticPenalty = semanticPenaltyScore(pageCtx, kind);
      const eligibility = mandatoryEligibility(pageCtx, kind);

      let lateNoteDetail = false;
      if (
        pageCtx.positionRatio > 0.6 &&
        pageCtx.mainColumnCount >= 6 &&
        !pageCtx.header?.latest &&
        !hasStrongOwnTitle
      ) {
        lateNoteDetail = true;
        score -= 120;
        reasons.push("lateNoteDetailPenalty:-120");
      }

      const earlyCoreShape = statementSpecificCoreShape(pageCtx, kind, cfg);
      if (earlyCoreShape) {
        score += 28;
        reasons.push("earlyCoreStatementBoost:+28");
      }

      signals.titleHitsHeader = titleHitsHeader;
      signals.titleHitsAll = titleHitsAll;
      signals.titleHitsFirstRows = titleHitsFirstRows;
      signals.structureHits = structureHits;
      signals.structureHitsFirstRows = structureHitsFirstRows;
      signals.negativeHits = negativeHits;
      signals.crossStatementTitleHits = crossStatementTitleHits;
      signals.hasStrongOwnTitle = hasStrongOwnTitle;
      signals.lateNoteDetail = lateNoteDetail;
      signals.earlyCoreShape = earlyCoreShape;
      signals.isLikelyOwnershipPage = !!pageCtx.isLikelyOwnershipPage;
      signals.ownershipLikeRowCount = pageCtx.ownershipLikeRowCount || 0;
      signals.yearSignals = yearSignals;
      signals.eligibility = {
        eligible: eligibility.eligible,
        path: eligibility.path,
        strongTitleHits: eligibility.strongTitleHits,
        coreHits: eligibility.coreHits,
        comboAHits: eligibility.comboAHits,
        comboBHits: eligibility.comboBHits,
        comboCHits: eligibility.comboCHits,
        balanceEquityAnchors: eligibility.balanceEquityAnchors
      };

      if (titleHitsHeader > 0) {
        const s = titleHitsHeader * 110;
        score += s;
        reasons.push(`titleHeader:+${s}`);
      } else if (titleHitsFirstRows > 0) {
        const s = titleHitsFirstRows * 72;
        score += s;
        reasons.push(`titleFirstRows:+${s}`);
      } else if (titleHitsAll > 0) {
        const s = titleHitsAll * 42;
        score += s;
        reasons.push(`titleAll:+${s}`);

        if (pageCtx.positionRatio > 0.55) {
          score -= 55;
          reasons.push("lateTitleOnlyPenalty:-55");
        }
      }

      if (pageCtx.hasYearLikeHeader) {
        score += 26;
        reasons.push("yearHeader:+26");
      }

      if (yearSignals.usableTwoYears) {
        score += 18;
        reasons.push("twoYearsDetected:+18");
      } else if (yearSignals.yearsFound.length >= 2) {
        score += 8;
        reasons.push("textYearsDetected:+8");
      }

      if (yearSignals.duplicateHeaderYears) {
        score -= 30;
        reasons.push("duplicateHeaderYearsPenalty:-30");
      }

      if (pageCtx.header?.currentCol != null && pageCtx.header?.labelCol != null) {
        score += 10;
        reasons.push("usableColumns:+10");
      }

      if (pageCtx.header?.hasDistinctLabelColumn) {
        score += 10;
        reasons.push("distinctLabelCol:+10");
      }

            if (
        !pageCtx.header?.hasDistinctLabelColumn &&
        pageCtx.mainColumnCount <= 3 &&
        !hasStrongOwnTitle &&
        structureHits === 0 &&
        structureHitsFirstRows === 0
      ) {
        score -= 55;
        reasons.push("genericNoDistinctLabelPenalty:-55");
      }

      if (
        kind === "balance" &&
        !pageCtx.header?.hasDistinctLabelColumn &&
        pageCtx.mainColumnCount <= 3 &&
        pageCtx.header?.noteCol != null &&
        !hasStrongOwnTitle &&
        structureHits === 0
      ) {
        score -= 45;
        reasons.push("balanceThreeColRecoveredPenalty:-45");
      }

      if (structureHits > 0) {
        const s = Math.min(structureHits, 12) * 16;
        score += s;
        reasons.push(`structure:+${s}`);
      }

      if (kind === "balance") {
        const headerRow = Array.isArray(pageCtx.mainRows?.[0]) ? pageCtx.mainRows[0] : [];
        const headerJoined = normalizeText(headerRow.join(" | "));
        const looksLikeYearYearNoteHeader =
          headerRow.length === 3 &&
          isYearCell(headerRow[0]) &&
          isYearCell(headerRow[1]) &&
          (
            isNoteHeaderCell(headerRow[2]) ||
            isLikelyReferenceValue(headerRow[2]) ||
            normalizeText(headerRow[2]) === "ايضاح"
          );

        if (
          pageCtx.mainColumnCount === 3 &&
          pageCtx.mainRowCount >= 20 &&
          yearSignals.usableTwoYears &&
          looksLikeYearYearNoteHeader
        ) {
          score += 180;
          reasons.push("bankThreeColumnBalanceBoost:+180");
        } else if (
          pageCtx.mainColumnCount === 3 &&
          pageCtx.mainRowCount >= 20 &&
          yearSignals.usableTwoYears &&
          (
            headerJoined.includes("2025") ||
            headerJoined.includes("2024") ||
            headerJoined.includes("ايضاح") ||
            headerJoined.includes("note") ||
            headerJoined.includes("notes")
          )
        ) {
          score += 120;
          reasons.push("bankThreeColumnBalanceSoftBoost:+120");
        }
      }

      if (structureHitsFirstRows > 0) {
        const s = Math.min(structureHitsFirstRows, 6) * 18;
        score += s;
        reasons.push(`structureFirstRows:+${s}`);
      }

      if (
        kind === "income" &&
        pageCtx.positionRatio <= 0.12 &&
        yearSignals.usableTwoYears &&
        containsAny(pageCtx.text, [
          "قائمة الدخل الموحدة",
          "قائمة الدخل",
          "statement of income",
          "income statement",
          "statement of profit or loss"
        ])
      ) {
        score += 180;
        reasons.push("incomeEarlyTitleBoost:+180");
      }

      if (
        kind === "cashflow" &&
        pageCtx.positionRatio <= 0.16 &&
        yearSignals.usableTwoYears &&
        containsAny(pageCtx.structuralText, [
          "قائمة التدفقات النقدية الموحدة",
          "قائمة التدفقات النقدية",
          "statement of cash flows",
          "cash flow statement",
          "consolidated statement of cash flows"
        ])
      ) {
        score += 180;
        reasons.push("cashflowEarlyTitleBoost:+180");
      }

      if (
        pageCtx.positionRatio > 0.6 &&
        structureHits > 0 &&
        !hasStrongOwnTitle
      ) {
        const penalty = Math.min(structureHits, 4) * 9;
        score -= penalty;
        reasons.push(`lateStructureWeightReduced:-${penalty}`);
      }

      if (negativeHits > 0) {
        const s = Math.min(negativeHits, 8) * 20;
        score -= s;
        reasons.push(`negative:-${s}`);
      }

      if (crossStatementTitleHits > 0 && !hasStrongOwnTitle) {
        const s = Math.min(crossStatementTitleHits, 4) * 40;
        score -= s;
        reasons.push(`crossStatementTitle:-${s}`);
      }

      if (pageCtx.numbersCount >= 8) {
        const s = Math.round(Math.min(pageCtx.numbersCount, 90) * 0.35);
        score += s;
        reasons.push(`numbers:+${s}`);
      }

      if (pageCtx.positionRatio <= 0.35) {
        score += 4;
        reasons.push("earlySoft:+4");
      } else if (pageCtx.positionRatio >= 0.8) {
        score -= 8;
        reasons.push("lateSoft:-8");
      }

      if (pageCtx.isLikelyIndexPage) {
        score -= 220;
        reasons.push("index:-220");
      }

      if (pageCtx.isLikelyIndexPage) {
        const weakHeaderStructure =
          !pageCtx.header?.latest &&
          !pageCtx.header?.previous &&
          !pageCtx.hasYearLikeHeader;

        const weakTableShape =
          pageCtx.mainColumnCount <= 3 ||
          pageCtx.mainRowCount >= 35 ||
          pageCtx.mainRowCount <= 6;

        const lacksRealStatementBody =
          structureHitsFirstRows <= 1 &&
          !yearSignals.usableTwoYears &&
          yearSignals.yearsFound.length < 2;

        if (weakHeaderStructure) {
          score -= 220;
          reasons.push("indexHardRejectWeakHeader:-220");
        }

        if (weakTableShape) {
          score -= 160;
          reasons.push("indexHardRejectWeakShape:-160");
        }

        if (lacksRealStatementBody) {
          score -= 180;
          reasons.push("indexHardRejectNoRealBody:-180");
        }
      }

      if (pageCtx.isLikelyStandardsPage) {
        score -= 190;
        reasons.push("standards:-190");
      }

      if (pageCtx.isLikelyNarrativePage) {
        score -= 180;
        reasons.push("narrative:-180");
      }

      if (pageCtx.isLikelyOwnershipPage) {
        score -= 320;
        reasons.push("ownershipPagePenalty:-320");

        if (kind === "balance") {
          score -= 260;
          reasons.push("ownershipHardRejectForBalance:-260");
        } else {
          score -= 120;
          reasons.push("ownershipHardRejectOtherStatements:-120");
        }
      }

      if (kind === "income" && pageCtx.isLikelyComprehensiveIncome) {
        score -= 170;
        reasons.push("comprehensiveIncomePenalty:-170");
      }

      if (kind === "cashflow" && pageCtx.isLikelyComprehensiveIncome) {
        score -= 120;
        reasons.push("comprehensivePenalty:-120");
      }

      if ((kind === "income" || kind === "cashflow") && containsAny(pageCtx.normalizedText, [
        "اجمالي الموجودات",
        "اجمالي المطلوبات",
        "اجمالي المطلوبات وحقوق الملكيه",
        "الموجودات",
        "المطلوبات",
        "حقوق الملكيه",
        "total assets",
        "total liabilities",
        "total liabilities and equity",
        "customer deposits",
        "ودائع العملاء"
      ])) {
        if (!hasStrongOwnTitle && structureHits < 2) {
          score -= 170;
          reasons.push("balanceCrossHardPenalty:-170");
        } else {
          score -= 70;
          reasons.push("balanceCrossSoftPenalty:-70");
        }
      }

      if (kind !== "cashflow" && containsAny(pageCtx.normalizedText, [
        "cash flows from operating activities",
        "cash flows from investing activities",
        "cash flows from financing activities",
        "صافي النقد الناتج من الانشطه التشغيليه",
        "صافي النقد المستخدم في الانشطه الاستثماريه",
        "صافي النقد الناتج من الانشطه التمويليه"
      ])) {
        if (!hasStrongOwnTitle) {
          score -= 90;
          reasons.push("cashflowCrossPenalty:-90");
        }
      }

      if (kind === "income" && pageCtx.isLikelyEquityStatement) {
        score -= 150;
        reasons.push("equityPenalty:-150");
      }

      if (kind === "cashflow" && pageCtx.isLikelyEquityStatement) {
        score -= 150;
        reasons.push("equityPenalty:-150");
      }

      if (kind === "balance" && pageCtx.isLikelyEquityStatement) {
        score -= 110;
        reasons.push("equityPenalty:-110");
      }

      if (!hasStrongOwnTitle && structureHits === 0) {
        score -= 45;
        reasons.push("noTitleNoStructurePenalty:-45");
      }

      if (!hasStrongOwnTitle && structureHits <= 1 && pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4) {
        score -= 28;
        reasons.push("genericThreeColPenalty:-28");
      }

      if (
        kind === "balance" &&
        pageCtx.mainColumnCount <= 3 &&
        pageCtx.mainRowCount <= 8 &&
        !hasStrongOwnTitle
      ) {
        score -= 120;
        reasons.push("tinyBalanceFragmentPenalty:-120");
      }

      if (
        kind === "balance" &&
        pageCtx.mainColumnCount >= 5 &&
        pageCtx.mainRowCount <= 6 &&
        !hasStrongOwnTitle
      ) {
        score -= 90;
        reasons.push("fragmentedBalanceSlicePenalty:-90");
      }

      if (pageCtx.mainColumnCount >= 5 && !pageCtx.isLikelyEquityStatement) {
        score -= 12;
        reasons.push("manyCols:-12");
      }

      if (pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4 && (hasStrongOwnTitle || structureHits > 0)) {
        score += 16;
        reasons.push("statementLikeCols:+16");
      }

      if (pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 60) {
        score += 8;
        reasons.push("rowRange:+8");
      }

      if (semanticBoost.boost > 0) {
        score += semanticBoost.boost;
        reasons.push(...semanticBoost.reasons);
      }

      if (semanticPenalty.penalty > 0) {
        score -= semanticPenalty.penalty;
        reasons.push(...semanticPenalty.reasons);
      }

      signals.semantic = {
        boost: semanticBoost.boost,
        penalty: semanticPenalty.penalty,
        ...semanticBoost.signals,
        ...semanticPenalty.signals
      };

      if (!eligibility.eligible) {
        if (
          kind === "balance" &&
          pageCtx.mainColumnCount === 3 &&
          pageCtx.mainRowCount >= 20 &&
          yearSignals.usableTwoYears
        ) {
          score -= 80;
          reasons.push("mandatoryEligibilityReducedForBankThreeColBalance:-80");
        } else if (
          kind === "income" &&
          signals.hasStrongOwnTitle &&
          pageCtx.positionRatio <= 0.12 &&
          pageCtx.mainRowCount >= 20 &&
          pageCtx.numbersCount >= 60
        ) {
          score -= 40;
          reasons.push("mandatoryEligibilityReducedForEarlyIncomeTitlePage:-40");
        } else if (
          kind === "cashflow" &&
          signals.hasStrongOwnTitle &&
          pageCtx.positionRatio <= 0.16 &&
          pageCtx.mainRowCount >= 20 &&
          pageCtx.numbersCount >= 60
        ) {
          score -= 40;
          reasons.push("mandatoryEligibilityReducedForEarlyCashflowTitlePage:-40");
        } else {
          score -= 260;
          reasons.push("mandatoryEligibilityFail:-260");
        }
      } else {
        score += 18;
        reasons.push(`mandatoryEligibilityPass:+18(${eligibility.path})`);
      }

      return {
        score,
        reasons,
        signals
      };
    }

    function rankPages(kind) {
      const cfg = ACTIVE_STATEMENT_CONFIGS[kind];
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
            isLikelyIndexPage: pageCtx.isLikelyIndexPage,
            isLikelyStandardsPage: pageCtx.isLikelyStandardsPage,
            isLikelyEquityStatement: pageCtx.isLikelyEquityStatement,
            isLikelyComprehensiveIncome: pageCtx.isLikelyComprehensiveIncome,
            isLikelyNarrativePage: pageCtx.isLikelyNarrativePage,
            isLikelyOwnershipPage: pageCtx.isLikelyOwnershipPage,
            ownershipLikeRowCount: pageCtx.ownershipLikeRowCount,
            header: pageCtx.header,
            pageGuardrails: pageCtx.pageGuardrails
          };
        })
        .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    }

    const rankedBalance = rankPages("balance");
    const rankedIncome = rankPages("income");
    const rankedCashflow = rankPages("cashflow");

    function scoreMap(rankings) {
      const out = {};
      for (const r of (rankings || [])) out[r.pageNumber] = r.score;
      return out;
    }

    const balanceScoreMap = scoreMap(rankedBalance);
    const incomeScoreMap = scoreMap(rankedIncome);
    const cashScoreMap = scoreMap(rankedCashflow);

    function topCandidates(rankings, topN = 8, minScore = -120) {
      const out = [];
      for (const r of (rankings || [])) {
        if (r.score < minScore && out.length >= 3) break;
        out.push(r.pageNumber);
        if (out.length >= topN) break;
      }
      return unique(out);
    }

    function softSequenceScore(balancePage, incomePage, cashPage) {
      let score = 0;

      if (balancePage < incomePage) score += 18;
      else if (balancePage === incomePage) score += 2;
      else score -= 20;

      if (incomePage < cashPage) score += 20;
      else if (incomePage === cashPage) score += 2;
      else score -= 24;

      const bi = incomePage - balancePage;
      const ic = cashPage - incomePage;
      const bc = cashPage - balancePage;

      if (bi >= 1 && bi <= 6) score += 16;
      else if (bi > 8) score -= Math.min((bi - 8) * 2, 18);

      if (ic >= 1 && ic <= 8) score += 16;
      else if (ic > 10) score -= Math.min((ic - 10) * 2, 22);

      if (bc >= 2 && bc <= 14) score += 10;
      else if (bc > 16) score -= Math.min((bc - 16) * 1.5, 22);

      return score;
    }

    function uniquenessScore(balancePage, incomePage, cashPage) {
      let score = 0;
      const values = [balancePage, incomePage, cashPage];
      const uniqueCount = new Set(values).size;

      if (uniqueCount === 3) score += 18;
      if (uniqueCount === 2) score -= 20;
      if (uniqueCount === 1) score -= 70;

      if (balancePage === incomePage) score -= 22;
      if (incomePage === cashPage) score -= 26;
      if (balancePage === cashPage) score -= 34;

      return score;
    }

    function chooseStatementPages() {
      const balanceCandidates = topCandidates(rankedBalance, 10, -140);
      const incomeCandidates = topCandidates(rankedIncome, 10, -140);
      const cashCandidates = topCandidates(rankedCashflow, 10, -140);

      let best = null;

      for (const balancePage of balanceCandidates) {
        for (const incomePage of incomeCandidates) {
          for (const cashFlowPage of cashCandidates) {
            const baseScore =
              safeNumber(balanceScoreMap[balancePage], -9999) +
              safeNumber(incomeScoreMap[incomePage], -9999) +
              safeNumber(cashScoreMap[cashFlowPage], -9999);

            const sequence = softSequenceScore(balancePage, incomePage, cashFlowPage);
            const uniqueness = uniquenessScore(balancePage, incomePage, cashFlowPage);
            const totalScore = baseScore + sequence + uniqueness;

            const candidate = {
              balancePage,
              incomePage,
              cashFlowPage,
              totalScore,
              parts: {
                baseScore,
                sequence,
                uniqueness
              }
            };

            if (!best || candidate.totalScore > best.totalScore) {
              best = candidate;
            }
          }
        }
      }

      if (!best) {
        return {
          balancePage: rankedBalance[0]?.pageNumber || null,
          incomePage: rankedIncome[0]?.pageNumber || null,
          cashFlowPage: rankedCashflow[0]?.pageNumber || null,
          rankingEngine: {
            mode: "fallback_top1",
            combo: null
          }
        };
      }

      return {
        balancePage: best.balancePage,
        incomePage: best.incomePage,
        cashFlowPage: best.cashFlowPage,
        rankingEngine: {
          mode: "semantic_mandatory_combo_ranking",
          combo: best
        }
      };
    }

    const selectedPagesResult = chooseStatementPages();
    const chosen = {
      balancePage: selectedPagesResult.balancePage,
      incomePage: selectedPagesResult.incomePage,
      cashFlowPage: selectedPagesResult.cashFlowPage
    };

    // =========================================================
    // Layer 6, 7, 8
    // =========================================================
    // من هنا إلى نهاية الملف:
    // استخدم نفس الكود الذي أرسلته أنت بدون أي تغيير
    // لأن الكسر كان داخل statementRankScore فقط.

    return send(200, {
      ok: true,
      engine: "extract-financial-v6.3",
      phase: "4B_semantic_ranking_hardening",
      fileName: body.fileName || normalized?.meta?.fileName || null,

      statementProfile,

      selectedPages: {
        incomePage: chosen.incomePage,
        balancePage: chosen.balancePage,
        cashFlowPage: chosen.cashFlowPage
      },

      incomePage: chosen.incomePage,
      balancePage: chosen.balancePage,
      cashFlowPage: chosen.cashFlowPage,

      incomeStatementLite,
      balanceSheetLite,
      cashFlowLite,

      incomeStatementStructured,
      balanceSheetStructured,
      cashFlowStructured,

      debug: {
        totalPagesWithTables: pageContexts.length,
        profileDetection,
        rankingEngine: selectedPagesResult.rankingEngine,
        ranking: {
          balanceTop: topN(rankedBalance, 5),
          incomeTop: topN(rankedIncome, 5),
          cashFlowTop: topN(rankedCashflow, 5)
        },
        chosen,
        rowStats: {
          income: {
            accepted: incomeStatementLite?.extractionMeta?.acceptedRowsCount ?? 0,
            rejected: incomeStatementLite?.extractionMeta?.rejectedRowsCount ?? 0,
            recoveredNumericRows: incomeStatementLite?.extractionMeta?.recoveredNumericRowsCount ?? 0,
            realLabelAcceptedRows: incomeStatementLite?.extractionMeta?.realLabelAcceptedRowsCount ?? 0,
            recoveredRowsAccepted: incomeStatementLite?.extractionMeta?.recoveredRowsAcceptedCount ?? 0,
            outputItems: incomeStatementLite?.extractionMeta?.outputItemsCount ?? 0
          },
          balance: {
            accepted: balanceSheetLite?.extractionMeta?.acceptedRowsCount ?? 0,
            rejected: balanceSheetLite?.extractionMeta?.rejectedRowsCount ?? 0,
            recoveredNumericRows: balanceSheetLite?.extractionMeta?.recoveredNumericRowsCount ?? 0,
            realLabelAcceptedRows: balanceSheetLite?.extractionMeta?.realLabelAcceptedRowsCount ?? 0,
            recoveredRowsAccepted: balanceSheetLite?.extractionMeta?.recoveredRowsAcceptedCount ?? 0,
            outputItems: balanceSheetLite?.extractionMeta?.outputItemsCount ?? 0
          },
          cashflow: {
            accepted: cashFlowLite?.extractionMeta?.acceptedRowsCount ?? 0,
            rejected: cashFlowLite?.extractionMeta?.rejectedRowsCount ?? 0,
            recoveredNumericRows: cashFlowLite?.extractionMeta?.recoveredNumericRowsCount ?? 0,
            realLabelAcceptedRows: cashFlowLite?.extractionMeta?.realLabelAcceptedRowsCount ?? 0,
            recoveredRowsAccepted: cashFlowLite?.extractionMeta?.recoveredRowsAcceptedCount ?? 0,
            outputItems: cashFlowLite?.extractionMeta?.outputItemsCount ?? 0
          }
        },
        notes: [
          "v6.3 adds semantic ranking hardening with mandatory statement eligibility",
          "v6.3 adds stronger balance eligibility by requiring an equity anchor",
          "v6.3 adds note-table penalties for risk, gap, sukuk, bonds, debt and maturity-heavy pages",
          "v6.3 improves year logic and keeps distinct label-column guardrails intact"
        ]
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
