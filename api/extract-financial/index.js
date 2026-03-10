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

      labelCol = refineLabelColumnFromBody(rows, {
        currentCol,
        previousCol,
        noteCol,
        labelCol,
        headerRowIndex,
        direction: language.direction
      });

      const maxColCount = Math.max(0, ...((rows || []).map((r) => Array.isArray(r) ? r.length : 0)));
      const reservedCols = new Set([currentCol, previousCol, noteCol].filter((x) => Number.isFinite(x)));

      if (language.direction === "rtl") {
        const rightmostFreeCol = (() => {
          for (let c = maxColCount - 1; c >= 0; c -= 1) {
            if (!reservedCols.has(c)) return c;
          }
          return null;
        })();

        if (
          rightmostFreeCol != null &&
          (
            labelCol == null ||
            reservedCols.has(labelCol) ||
            labelCol < rightmostFreeCol
          )
        ) {
          labelCol = rightmostFreeCol;
          mode = `${mode}_rtl_rightmost_free_col`;
        }
      } else {
        const leftmostFreeCol = (() => {
          for (let c = 0; c < maxColCount; c += 1) {
            if (!reservedCols.has(c)) return c;
          }
          return null;
        })();

        if (
          leftmostFreeCol != null &&
          (
            labelCol == null ||
            reservedCols.has(labelCol)
          )
        ) {
          labelCol = leftmostFreeCol;
          mode = `${mode}_ltr_leftmost_free_col`;
        }
      }

      return {
        latest,
        previous,
        currentCol,
        previousCol,
        noteCol,
        labelCol,
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

      const pageGuardrails = {
        rejectAsIndex: isLikelyIndexPage,
        rejectAsStandards: isLikelyStandardsPage,
        rejectAsNarrative: isLikelyNarrativePage,
        rejectAsEquity: isLikelyEquityStatement,
        rejectAsComprehensive: isLikelyComprehensiveIncome
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
        positionRatio,
        hasStatementTitle,
        hasYearLikeHeader,
        isLikelyIndexPage,
        isLikelyStandardsPage,
        isLikelyEquityStatement,
        isLikelyComprehensiveIncome,
        isLikelyNarrativePage,
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
            "balance sheet"
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
            "total liabilities and equity"
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
            "statement of income"
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
            "fee from banking services"
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
            "statement of cash flows"
          ],
          structure: [
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية",
            "النقد وشبه النقد",
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
      },

      insurance: {
        balance: {
          key: "balance",
          titles: [
            "قائمة المركز المالي",
            "المركز المالي",
            "statement of financial position",
            "balance sheet"
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
            "insurance contract liabilities"
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
            "statement of profit or loss"
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
            "claims"
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
            "cash flow statement"
          ],
          structure: [
            "صافي النقد الناتج من الانشطة التشغيلية",
            "cash flows from operating activities",
            "cash and cash equivalents"
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
            "balance sheet"
          ],
          structure: [
            "عقارات استثمارية",
            "موجودات مالية بالقيمة العادلة من خلال الربح أو الخسارة",
            "وحدات الصندوق",
            "investment properties",
            "fund units"
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
            "income statement"
          ],
          structure: [
            "دخل ايجار",
            "دخل إيجار",
            "عقارات استثمارية",
            "توزيعات ارباح",
            "دخل تحويل",
            "rental income",
            "investment properties"
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
            "cash flow statement"
          ],
          structure: [
            "صافي النقد الناتج من الانشطه التشغيليه",
            "صافي النقد المستخدم في الانشطه الاستثماريه",
            "صافي النقد الناتج من الانشطه التمويليه",
            "cash and cash equivalents"
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
            "balance sheet"
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
            "profit or loss"
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

    const ACTIVE_STATEMENT_CONFIGS = STATEMENT_CONFIGS[statementProfile] || STATEMENT_CONFIGS.operating_company;

    function statementKindTitleAliases(kind) {
      if (kind === "balance") {
        return [
          "قائمة المركز المالي",
          "المركز المالي",
          "قائمة الوضع المالي",
          "الميزانية",
          "الميزانية العمومية",
          "statement of financial position",
          "financial position",
          "balance sheet"
        ];
      }

      if (kind === "income") {
        return [
          "قائمة الدخل",
          "قائمة الدخل الموحدة",
          "قائمة الارباح والخسائر",
          "قائمة الربح والخسارة",
          "statement of income",
          "income statement",
          "statement of profit or loss",
          "profit and loss",
          "profit or loss"
        ];
      }

      return [
        "قائمة التدفقات النقدية",
        "بيان التدفقات النقدية",
        "التدفقات النقدية",
        "cash flow statement",
        "statement of cash flows",
        "cash flows",
        "consolidated statement of cash flows"
      ];
    }

    function otherStatementTitleAliases(kind) {
      const kinds = ["balance", "income", "cashflow"].filter((x) => x !== kind);
      return kinds.flatMap(statementKindTitleAliases);
    }

    function strongStatementTitleHit(pageCtx, cfg) {
      const headerHits = keywordHits(pageCtx.headerText, cfg.titles);
      if (headerHits > 0) return true;

      const firstRowsText = (pageCtx.mainRows || [])
        .slice(0, 4)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      return keywordHits(firstRowsText, cfg.titles) > 0;
    }

    function statementSpecificCoreShape(pageCtx, kind, cfg) {
      const firstRowsText = (pageCtx.mainRows || [])
        .slice(0, 8)
        .map((r) => (Array.isArray(r) ? r.join(" | ") : ""))
        .join("\n");

      const wholeText = `${pageCtx.headerText || ""}\n${firstRowsText}\n${pageCtx.structuralText || ""}`;
      const structureHits = keywordHits(wholeText, cfg.structure);

      const isEarly = pageCtx.positionRatio < 0.22;
      const hasTwoYears = !!(pageCtx.header?.latest && pageCtx.header?.previous);
      const compactCols = pageCtx.mainColumnCount >= 3 && pageCtx.mainColumnCount <= 5;
      const usableRows = pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 60;

      if (!(isEarly && hasTwoYears && compactCols && usableRows)) {
        return false;
      }

      if (kind === "balance") {
        return (
          structureHits >= 2 ||
          containsAny(wholeText, [
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "اجمالي المطلوبات وحقوق الملكيه",
            "الموجودات",
            "المطلوبات",
            "حقوق الملكيه",
            "total assets",
            "total liabilities",
            "total liabilities and equity"
          ])
        );
      }

      if (kind === "income") {
        return (
          structureHits >= 2 ||
          containsAny(wholeText, [
            "الدخل من التمويل",
            "الدخل من التمويل والاستثمارات",
            "اجمالي دخل العمليات",
            "اجمالي مصاريف العمليات",
            "دخل السنة قبل الزكاة",
            "صافي دخل السنة",
            "ربحية السهم",
            "gross financing and investment income",
            "net financing and investment income",
            "fee from banking services",
            "profit before zakat",
            "net income"
          ])
        );
      }

      return (
        structureHits >= 2 ||
        containsAny(wholeText, [
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
        ])
      );
    }

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
      const hasStrongOwnTitle = strongStatementTitleHit(pageCtx, cfg);

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

      if (pageCtx.header?.latest && pageCtx.header?.previous) {
        score += 18;
        reasons.push("twoYearsDetected:+18");
      }

      if (pageCtx.header?.currentCol != null && pageCtx.header?.labelCol != null) {
        score += 10;
        reasons.push("usableColumns:+10");
      }

      if (structureHits > 0) {
        const s = Math.min(structureHits, 12) * 16;
        score += s;
        reasons.push(`structure:+${s}`);
      }

      if (structureHitsFirstRows > 0) {
        const s = Math.min(structureHitsFirstRows, 6) * 18;
        score += s;
        reasons.push(`structureFirstRows:+${s}`);
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

      if (pageCtx.isLikelyStandardsPage) {
        score -= 190;
        reasons.push("standards:-190");
      }

      if (pageCtx.isLikelyNarrativePage) {
        score -= 180;
        reasons.push("narrative:-180");
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

      return { score, reasons, signals };
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

    function topCandidates(rankings, topN = 8, minScore = -60) {
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
      const balanceCandidates = topCandidates(rankedBalance, 10, -80);
      const incomeCandidates = topCandidates(rankedIncome, 10, -80);
      const cashCandidates = topCandidates(rankedCashflow, 10, -80);

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
          mode: "multi_signal_combo_ranking",
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
    // Layer 6: Row Extraction
    // =========================================================

    const LITE_TEMPLATES = {
      bank: {
        balance: [
          "نقد وأرصدة لدى البنوك المركزية",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي",
          "استثمارات بالصافي",
          "تمويل وسلف بالصافي",
          "إجمالي الموجودات",
          "ودائع العملاء",
          "إجمالي المطلوبات",
          "إجمالي حقوق الملكية",
          "إجمالي المطلوبات وحقوق الملكية"
        ],
        income: [
          "الدخل من التمويل والاستثمارات",
          "الدخل من رسوم الخدمات المصرفية بالصافي",
          "إجمالي دخل العمليات التشغيلية",
          "إجمالي مصاريف العمليات التشغيلية",
          "دخل السنة قبل الزكاة وضريبة الدخل",
          "صافي دخل السنة",
          "ربحية السهم الأساسية"
        ],
        cashflow: [
          "دخل السنة قبل الزكاة وضريبة الدخل",
          "صافي النقد الناتج من الأنشطة التشغيلية",
          "صافي النقد الناتج من الأنشطة الاستثمارية",
          "صافي النقد الناتج من الأنشطة التمويلية",
          "النقد وشبه النقد في بداية السنة",
          "النقد وشبه النقد في نهاية السنة"
        ]
      },
      insurance: {
        balance: [
          "نقد وما في حكمه",
          "ودائع لأجل",
          "استثمارات",
          "ذمم إعادة التأمين",
          "إجمالي الموجودات",
          "مطلوبات عقود التأمين",
          "إجمالي المطلوبات",
          "إجمالي حقوق الملكية"
        ],
        income: [
          "إيرادات التأمين",
          "نتيجة خدمة التأمين",
          "دخل التمويل",
          "صافي نتائج الأنشطة غير التأمينية",
          "صافي ربح السنة"
        ],
        cashflow: [
          "صافي ربح السنة",
          "صافي النقد الناتج من الأنشطة التشغيلية",
          "صافي النقد المستخدم في الأنشطة الاستثمارية",
          "صافي النقد الناتج من الأنشطة التمويلية",
          "النقد وما في حكمه في نهاية السنة"
        ]
      },
      reit: {
        balance: [
          "عقارات استثمارية",
          "موجودات مالية بالقيمة العادلة من خلال الربح أو الخسارة",
          "إجمالي الموجودات",
          "القروض",
          "إجمالي المطلوبات",
          "صافي الموجودات العائدة إلى مالكي الوحدات"
        ],
        income: [
          "دخل إيجار من عقارات استثمارية",
          "توزيعات أرباح",
          "ربح العمليات",
          "ربح السنة",
          "إجمالي الدخل الشامل"
        ],
        cashflow: [
          "صافي الدخل للسنة",
          "صافي النقد الناتج من الأنشطة التشغيلية",
          "صافي النقد المستخدم في الأنشطة الاستثمارية",
          "صافي النقد المستخدم في الأنشطة التمويلية",
          "النقدية وشبه النقدية في نهاية السنة"
        ]
      },
      operating_company: {
        balance: [
          "النقد وما في حكمه",
          "المخزون",
          "المدينون التجاريون والذمم الأخرى",
          "إجمالي الموجودات",
          "الدائنون التجاريون والذمم الأخرى",
          "إجمالي المطلوبات",
          "إجمالي حقوق الملكية",
          "إجمالي المطلوبات وحقوق الملكية"
        ],
        income: [
          "الإيرادات",
          "تكلفة المبيعات",
          "مجمل الربح",
          "الربح التشغيلي",
          "الربح قبل الزكاة وضريبة الدخل",
          "ربح السنة",
          "ربحية السهم الأساسية"
        ],
        cashflow: [
          "ربح السنة",
          "صافي النقد الناتج من الأنشطة التشغيلية",
          "صافي النقد المستخدم في الأنشطة الاستثمارية",
          "صافي النقد الناتج من الأنشطة التمويلية",
          "النقد وما في حكمه في بداية السنة",
          "النقد وما في حكمه في نهاية السنة"
        ]
      }
    };

    function getSyntheticLabel(statementKey, index) {
      const labels = (LITE_TEMPLATES[statementProfile] || LITE_TEMPLATES.operating_company)[statementKey] || [];
      return labels[index] || `${statementKey}_row_${index + 1}`;
    }

    function isSyntheticStatementLabel(label, statementKey) {
      return new RegExp(`^${statementKey}_row_\\d+$`, "i").test(String(label || "").trim());
    }

    function hasRealExtractedLabel(item, statementKey) {
      if (!item) return false;
      if (item.recoveredByTemplate) return false;
      return !isSyntheticStatementLabel(item.label, statementKey);
    }

    function minCoreLabelThreshold(statementKey) {
      if (statementKey === "balance") return 5;
      if (statementKey === "income") return 6;
      return 5;
    }

    function maxRecoveredRowsAllowed(statementKey) {
      if (statementKey === "income") return 4;
      if (statementKey === "cashflow") return 3;
      return 4;
    }

    function isSeparatorRow(cells) {
      const text = (cells || []).join(" ").trim();
      return /^[-–—_=|.\s]+$/.test(text);
    }

    function isSectionHeaderLikeText(text) {
      const s = normalizeText(text);
      return (
        s === "assets" ||
        s === "liabilities" ||
        s === "equity" ||
        s === "current assets" ||
        s === "non-current assets" ||
        s === "current liabilities" ||
        s === "non-current liabilities" ||
        s === "الموجودات" ||
        s === "المطلوبات" ||
        s === "حقوق الملكيه" ||
        s === "حقوق الملكية" ||
        s === "الانشطه التشغيليه" ||
        s === "الأنشطة التشغيلية" ||
        s === "الانشطه الاستثماريه" ||
        s === "الأنشطة الاستثمارية" ||
        s === "الانشطه التمويليه" ||
        s === "الأنشطة التمويلية"
      );
    }

    function isHeaderLikeRow(cells) {
      const nonEmpty = (cells || []).filter((c) => !isBlank(c));
      if (!nonEmpty.length) return false;

      const yearCount = nonEmpty.filter((c) => Number.isFinite(getYearFromCell(c))).length;
      const noteCount = nonEmpty.filter(isNoteHeaderCell).length;
      const periodCount = nonEmpty.filter(isQuarterOrPeriodCell).length;
      const numericCount = nonEmpty.filter((c) => parseNumberSmart(c) != null).length;
      const textJoined = nonEmpty.join(" | ");

      if (yearCount >= 2) return true;
      if (noteCount >= 1 && yearCount >= 1) return true;
      if (periodCount >= 1 && yearCount >= 1) return true;
      if (numericCount === 0 && nonEmpty.length <= 4) return true;
      if (isSectionHeaderLikeText(textJoined) && numericCount === 0) return true;

      return false;
    }

    function extractLabelFromRow(cells, header) {
      const orderedIndexes =
        header?.direction === "rtl"
          ? [...cells.keys()].sort((a, b) => b - a)
          : [...cells.keys()].sort((a, b) => a - b);

      const candidates = [];

      const pushCandidate = (raw, idx, source) => {
        const cleaned = cleanupLabel(raw);
        if (!cleaned) return;
        if (!isLikelyTextLabelCell(cleaned)) return;
        if (isNumericOnlyText(cleaned)) return;
        if (getYearFromCell(cleaned) != null) return;
        if (isLikelyStatementDateText(cleaned)) return;
        if (isLikelyStandardEffectiveDateText(cleaned)) return;
        if (isLikelyNarrativeLine(cleaned)) return;
        if (isQuarterOrPeriodCell(cleaned)) return;
        if (isLikelyOnlyReferenceText(cleaned)) return;

        const norm = normalizeText(cleaned);
        if (
          norm === "ايضاح" ||
          norm === "notes" ||
          norm === "note" ||
          norm === "الملاحظات"
        ) {
          return;
        }

        if (cleaned.length <= 2) return;

        let score = Math.min(cleaned.length, 100);
        if (hasArabicChars(cleaned)) score += 8;
        if (header?.direction === "rtl") score += idx * 5;
        if (source === "header_label_col") score += 12;
        if (source === "body_scan") score += 6;

        candidates.push({
          label: cleaned,
          idx,
          score
        });
      };

      if (
        header?.labelCol != null &&
        header.labelCol !== header?.noteCol &&
        cells[header.labelCol] != null
      ) {
        pushCandidate(String(cells[header.labelCol] || "").trim(), header.labelCol, "header_label_col");
      }

      for (const i of orderedIndexes) {
        if (
          i === header?.currentCol ||
          i === header?.previousCol ||
          i === header?.noteCol
        ) {
          continue;
        }

        const raw = String(cells[i] || "").trim();
        if (!raw) continue;
        pushCandidate(raw, i, "body_scan");
      }

      if (!candidates.length) {
        for (const i of orderedIndexes) {
          if (i === header?.currentCol || i === header?.previousCol || i === header?.noteCol) continue;

          const raw = String(cells[i] || "").trim();
          if (!raw) continue;
          if (isLikelyOnlyReferenceText(raw)) continue;
          if (isNumericOnlyText(raw)) continue;
          if (getYearFromCell(raw) != null) continue;
          if (isLikelyStatementDateText(raw)) continue;

          const cleaned = cleanupLabel(raw);
          if (cleaned && cleaned.length > 2 && /[A-Za-z\u0600-\u06FF]/.test(cleaned)) {
            candidates.push({
              label: cleaned,
              idx: i,
              score: cleaned.length
            });
            break;
          }
        }
      }

      if (!candidates.length) return "";

      candidates.sort((a, b) => b.score - a.score || b.idx - a.idx);
      return candidates[0].label;
    }

    function extractValuesFromRow(cells, header) {
      let current = header?.currentCol != null ? parseNumberSmart(cells[header.currentCol]) : null;
      let previous = header?.previousCol != null ? parseNumberSmart(cells[header.previousCol]) : null;

      if (header?.currentCol != null && isLikelyReferenceValue(cells[header.currentCol])) current = null;
      if (header?.previousCol != null && isLikelyReferenceValue(cells[header.previousCol])) previous = null;
      if (header?.currentCol === header?.noteCol) current = null;
      if (header?.previousCol === header?.noteCol) previous = null;

      if (current == null && previous == null) {
        const numericCells = (cells || [])
          .map((cell, idx) => ({
            idx,
            raw: String(cell || "").trim(),
            num: parseNumberSmart(cell)
          }))
          .filter((x) => x.raw !== "")
          .filter((x) => x.num != null)
          .filter((x) => getYearFromCell(x.raw) == null)
          .filter((x) => !isLikelyReferenceValue(x.raw))
          .filter((x) => !isLikelyStatementDateText(x.raw))
          .filter((x) => !isLikelyStandardEffectiveDateText(x.raw))
          .filter((x) => x.idx !== header?.noteCol)
          .sort((a, b) => a.idx - b.idx);

        if (numericCells.length >= 2) {
          const filteredForValues = numericCells.filter((x) => x.idx !== header?.labelCol);
          const pool = filteredForValues.length >= 2 ? filteredForValues : numericCells;

          previous = pool[pool.length - 2]?.num ?? null;
          current = pool[pool.length - 1]?.num ?? null;
        } else if (numericCells.length === 1) {
          current = numericCells[0].num;
        }
      }

      return { current, previous };
    }

    function validateRow(cells, header, statementKey) {
      if (!Array.isArray(cells) || !cells.length) {
        return { ok: false, reason: "empty_row" };
      }

      if (isSeparatorRow(cells)) {
        return { ok: false, reason: "separator_row" };
      }

      const joined = cells.join(" | ");
      if (isLikelyNarrativeLine(joined) || isLikelyStandardEffectiveDateText(joined)) {
        return { ok: false, reason: "narrative_row" };
      }

      if (isHeaderLikeRow(cells)) {
        return { ok: false, reason: "header_like_row" };
      }

      const label = extractLabelFromRow(cells, header);
      const values = extractValuesFromRow(cells, header);
      const labelNorm = normalizeText(label);

      if (!label && (values.current != null || values.previous != null)) {
        return {
          ok: true,
          reason: "numeric_row_recovered",
          label: "",
          values,
          recoveredByTemplate: true
        };
      }

      if (!label) return { ok: false, reason: "no_label" };

      if (
        labelNorm === "ايضاح" ||
        labelNorm === "notes" ||
        labelNorm === "note" ||
        labelNorm === "الملاحظات"
      ) {
        return { ok: false, reason: "note_header_row" };
      }

      if (isLikelyOnlyReferenceText(label)) {
        return { ok: false, reason: "reference_label" };
      }

      if (isNumericOnlyText(label)) {
        return { ok: false, reason: "numeric_label" };
      }

      if (getYearFromCell(label) != null) {
        return { ok: false, reason: "date_header_row" };
      }

      if (
        isLikelyStatementDateText(label) ||
        isLikelyStandardEffectiveDateText(label) ||
        isLikelyNarrativeLine(label) ||
        isQuarterOrPeriodCell(label)
      ) {
        return { ok: false, reason: "narrative_label" };
      }

      if (
        labelNorm.includes("ديسمبر") ||
        labelNorm.includes("يناير") ||
        labelNorm.includes("december") ||
        labelNorm.includes("january") ||
        labelNorm.includes("as of")
      ) {
        return { ok: false, reason: "date_header_row" };
      }

      if (labelNorm.length <= 1) {
        return { ok: false, reason: "weak_label" };
      }

      if (statementKey === "cashflow") {
        if (
          labelNorm.includes("الانشطه التشغيليه") ||
          labelNorm.includes("الانشطه الاستثماريه") ||
          labelNorm.includes("الانشطه التمويليه") ||
          labelNorm.includes("operating activities") ||
          labelNorm.includes("investing activities") ||
          labelNorm.includes("financing activities")
        ) {
          return { ok: false, reason: "cashflow_section_header" };
        }
      }

      if (values.current == null && values.previous == null) {
        return { ok: false, reason: "no_values" };
      }

      return {
        ok: true,
        reason: "valid",
        label,
        values,
        recoveredByTemplate: false
      };
    }

    function dedupeItems(items) {
      const map = new Map();

      for (const item of (items || [])) {
        const key = normalizeText(item.label);
        if (!key) continue;

        if (!map.has(key)) {
          map.set(key, item);
          continue;
        }

        const prev = map.get(key);
        const prevStrength =
          (prev.current != null ? 1 : 0) +
          (prev.previous != null ? 1 : 0) +
          (prev.note ? 0.25 : 0) +
          (hasRealExtractedLabel(prev, prev.statementKey || "") ? 0.75 : 0);

        const nowStrength =
          (item.current != null ? 1 : 0) +
          (item.previous != null ? 1 : 0) +
          (item.note ? 0.25 : 0) +
          (hasRealExtractedLabel(item, item.statementKey || "") ? 0.75 : 0);

        if (nowStrength > prevStrength) {
          map.set(key, item);
        }
      }

      return Array.from(map.values());
    }

    function shouldAcceptRecoveredRow(params) {
      const {
        statementKey,
        tableIndex,
        recoveredAcceptedCount,
        realLabelAcceptedCount,
        note
      } = params;

      const minReal = minCoreLabelThreshold(statementKey);
      const maxRecovered = maxRecoveredRowsAllowed(statementKey);

      if (realLabelAcceptedCount >= minReal) return false;
      if (recoveredAcceptedCount >= maxRecovered) return false;

      if (tableIndex > 0 && recoveredAcceptedCount >= 1) return false;
      if (tableIndex > 0 && realLabelAcceptedCount >= Math.max(3, minReal - 2)) return false;

      if (note && !isLikelyReferenceValue(note) && normalizeText(note).length > 0) {
        return false;
      }

      return true;
    }

    function pruneStatementItems(items, statementKey) {
      const list = Array.isArray(items) ? items : [];
      const realLabeledItems = list.filter((x) => hasRealExtractedLabel(x, statementKey));
      const threshold = minCoreLabelThreshold(statementKey);

      if (realLabeledItems.length >= threshold) {
        return realLabeledItems;
      }

      const recoveredCap = maxRecoveredRowsAllowed(statementKey);
      const recoveredItems = list.filter((x) => !hasRealExtractedLabel(x, statementKey)).slice(0, recoveredCap);

      return [...realLabeledItems, ...recoveredItems];
    }

    function areTableStructuresCompatible(primaryCtx, nextCtx, statementKey) {
      if (!primaryCtx || !nextCtx) return false;
      if (!primaryCtx.mainTable || !nextCtx.mainTable) return false;

      const primaryHeader = primaryCtx.header || {};
      const nextHeader = nextCtx.header || {};

      if (nextCtx.isLikelyIndexPage || nextCtx.isLikelyStandardsPage || nextCtx.isLikelyNarrativePage) return false;
      if (nextCtx.isLikelyEquityStatement) return false;
      if (statementKey === "income" && nextCtx.isLikelyComprehensiveIncome) return false;

      const primaryCols = safeNumber(primaryCtx.mainColumnCount, 0);
      const nextCols = safeNumber(nextCtx.mainColumnCount, 0);
      if (!primaryCols || !nextCols) return false;
      if (Math.abs(primaryCols - nextCols) > 1) return false;

      if ((primaryHeader.direction || "ltr") !== (nextHeader.direction || "ltr")) return false;

      const primaryLabelCol = primaryHeader.labelCol;
      const nextLabelCol = nextHeader.labelCol;
      if (primaryLabelCol != null && nextLabelCol != null && Math.abs(primaryLabelCol - nextLabelCol) > 1) return false;

      const primaryCurrentCol = primaryHeader.currentCol;
      const nextCurrentCol = nextHeader.currentCol;
      if (primaryCurrentCol != null && nextCurrentCol != null && Math.abs(primaryCurrentCol - nextCurrentCol) > 1) return false;

      const primaryPreviousCol = primaryHeader.previousCol;
      const nextPreviousCol = nextHeader.previousCol;
      if (primaryPreviousCol != null && nextPreviousCol != null && Math.abs(primaryPreviousCol - nextPreviousCol) > 1) return false;

      const primaryYears = unique([primaryHeader.latest, primaryHeader.previous].filter(Boolean)).sort((a, b) => b - a);
      const nextYears = unique([nextHeader.latest, nextHeader.previous].filter(Boolean)).sort((a, b) => b - a);

      if (primaryYears.length && nextYears.length) {
        const sameTopYear = primaryYears[0] === nextYears[0];
        if (!sameTopYear) return false;
      }

      return true;
    }

    function collectStatementTables(startPageNumber, statementKey) {
      const startIndex = allPageNumbers.indexOf(startPageNumber);
      const primary = pageContexts.find((p) => p.pageNumber === startPageNumber);
      if (!primary || !primary.mainTable) return [];

      const result = [{
        pageNumber: primary.pageNumber,
        table: primary.mainTable,
        context: primary
      }];

      const nextPageNumber = allPageNumbers[startIndex + 1];
      const nextCtx = pageContexts.find((p) => p.pageNumber === nextPageNumber);
      if (!nextCtx || !nextCtx.mainTable) {
        return result;
      }

      const cfg = ACTIVE_STATEMENT_CONFIGS[statementKey];
      const primaryScore = statementRankScore(primary, cfg, statementKey).score;
      const nextScore = statementRankScore(nextCtx, cfg, statementKey).score;

      let extensionSignals = 0;
      if (nextScore >= primaryScore - 30) extensionSignals += 1;
      if (
        (primary.header?.latest && nextCtx.header?.latest && primary.header.latest === nextCtx.header.latest) ||
        (primary.years.length && nextCtx.years.length && primary.years[0] === nextCtx.years[0])
      ) {
        extensionSignals += 1;
      }
      if (areTableStructuresCompatible(primary, nextCtx, statementKey)) extensionSignals += 3;

      if (statementKey === "balance" && nextCtx.pageNumber === chosen?.incomePage) {
        extensionSignals -= 10;
      }
      if (statementKey === "income" && nextCtx.pageNumber === chosen?.cashFlowPage) {
        extensionSignals -= 10;
      }

      const canExtend = extensionSignals >= 4;

      if (canExtend) {
        result.push({
          pageNumber: nextCtx.pageNumber,
          table: nextCtx.mainTable,
          context: nextCtx
        });
      }

      return result;
    }

    function buildLiteItem(label, current, previous, note, source, statementKey, recoveredByTemplate = false) {
      return {
        label: String(label || "").trim(),
        current: current != null ? current : null,
        previous: previous != null ? previous : null,
        note: cleanupNote(note),
        source: source || null,
        statementKey,
        recoveredByTemplate: !!recoveredByTemplate
      };
    }

    function extractStatementLite(pageNumber, statementKey) {
      if (!pageNumber) {
        return {
          pageNumber: null,
          latest: null,
          previous: null,
          years: [],
          items: [],
          extractionMeta: {
            currentCol: null,
            previousCol: null,
            noteCol: null,
            labelCol: null,
            headerResolutionMode: null,
            tableDirection: null,
            tablesUsed: 0,
            sourcePages: [],
            acceptedRowsCount: 0,
            rejectedRowsCount: 0,
            recoveredNumericRowsCount: 0,
            labelMode: "synthetic_by_statement_template"
          }
        };
      }

      const statementTables = collectStatementTables(pageNumber, statementKey);
      const sourcePages = unique(statementTables.map((x) => x.pageNumber));
      if (!statementTables.length) {
        return {
          pageNumber,
          latest: null,
          previous: null,
          years: [],
          items: [],
          extractionMeta: {
            currentCol: null,
            previousCol: null,
            noteCol: null,
            labelCol: null,
            headerResolutionMode: null,
            tableDirection: null,
            tablesUsed: 0,
            sourcePages: [],
            acceptedRowsCount: 0,
            rejectedRowsCount: 0,
            recoveredNumericRowsCount: 0,
            labelMode: "synthetic_by_statement_template"
          }
        };
      }

      const primaryRows = extractTableRows(statementTables[0].table);
      const primaryHeader = detectHeaderColumns(primaryRows);

      let latest = primaryHeader.latest;
      let previous = primaryHeader.previous;

      if (latest == null || previous == null) {
        const combinedText = statementTables.map((x) => x.context?.text || "").join("\n");
        const years = extractYears(combinedText);
        if (years.length >= 2) {
          latest = years[0];
          previous = years[1];
        }
      }

      const allItems = [];
      const rejectedRows = [];
      let acceptedRowsCount = 0;
      let rejectedRowsCount = 0;
      let recoveredNumericRowsCount = 0;
      let acceptedRecoveredRowsCount = 0;
      let acceptedRealLabelRowsCount = 0;

      for (let t = 0; t < statementTables.length; t += 1) {
        const tableInfo = statementTables[t];
        const mainRows = extractTableRows(tableInfo.table);
        const metaRows = rowsWithMeta(tableInfo.table);
        const localHeader = detectHeaderColumns(mainRows);

        const header = {
          latest: latest ?? localHeader.latest,
          previous: previous ?? localHeader.previous,
          currentCol: primaryHeader.currentCol != null ? primaryHeader.currentCol : localHeader.currentCol,
          previousCol: primaryHeader.previousCol != null ? primaryHeader.previousCol : localHeader.previousCol,
          noteCol: primaryHeader.noteCol != null ? primaryHeader.noteCol : localHeader.noteCol,
          labelCol: primaryHeader.labelCol != null ? primaryHeader.labelCol : localHeader.labelCol,
          headerRowIndex: localHeader.headerRowIndex != null ? localHeader.headerRowIndex : primaryHeader.headerRowIndex,
          resolutionMode: primaryHeader.resolutionMode || localHeader.resolutionMode,
          direction: primaryHeader.direction || localHeader.direction || "ltr",
          isArabicTable: primaryHeader.isArabicTable != null ? primaryHeader.isArabicTable : localHeader.isArabicTable
        };

        const startRowIndex = header.headerRowIndex != null
          ? header.headerRowIndex + 1
          : (t === 0 ? 1 : 0);

        for (let i = startRowIndex; i < metaRows.length; i += 1) {
          const cells = metaRows[i].cells || [];
          const validation = validateRow(cells, header, statementKey);
          const note = header.noteCol != null
            ? cleanupNote(cells[header.noteCol])
            : null;

          if (!validation.ok) {
            rejectedRowsCount += 1;
            rejectedRows.push({
              pageNumber: tableInfo.pageNumber,
              rowIndex: i,
              reason: validation.reason,
              row: cells.join(" | ")
            });
            continue;
          }

          if (validation.reason === "numeric_row_recovered") {
            const acceptRecovered = shouldAcceptRecoveredRow({
              statementKey,
              tableIndex: t,
              recoveredAcceptedCount: acceptedRecoveredRowsCount,
              realLabelAcceptedCount: acceptedRealLabelRowsCount,
              note
            });

            if (!acceptRecovered) {
              rejectedRowsCount += 1;
              rejectedRows.push({
                pageNumber: tableInfo.pageNumber,
                rowIndex: i,
                reason: "recovered_row_pruned",
                row: cells.join(" | ")
              });
              continue;
            }
          }

          const finalLabel = cleanupLabel(validation.label) || getSyntheticLabel(statementKey, allItems.length);

          if (validation.reason === "numeric_row_recovered") {
            recoveredNumericRowsCount += 1;
            acceptedRecoveredRowsCount += 1;
          } else {
            acceptedRealLabelRowsCount += 1;
          }

          allItems.push(buildLiteItem(
            finalLabel,
            validation.values.current,
            validation.values.previous,
            note,
            {
              pageNumber: tableInfo.pageNumber,
              rowIndex: i
            },
            statementKey,
            validation.recoveredByTemplate
          ));
          acceptedRowsCount += 1;
        }
      }

      const deduped = dedupeItems(allItems);
      const pruned = pruneStatementItems(deduped, statementKey)
        .filter((x) => x.current != null || x.previous != null)
        .map((x) => ({
          label: x.label,
          current: x.current,
          previous: x.previous,
          note: x.note,
          source: x.source
        }));

      return {
        pageNumber,
        latest,
        previous,
        years: [latest, previous].filter(Boolean),
        items: pruned,
        extractionMeta: {
          currentCol: primaryHeader.currentCol,
          previousCol: primaryHeader.previousCol,
          noteCol: primaryHeader.noteCol,
          labelCol: primaryHeader.labelCol,
          headerResolutionMode: primaryHeader.resolutionMode || null,
          tableDirection: primaryHeader.direction || null,
          tablesUsed: statementTables.length,
          sourcePages,
          acceptedRowsCount,
          rejectedRowsCount,
          recoveredNumericRowsCount,
          realLabelAcceptedRowsCount: acceptedRealLabelRowsCount,
          recoveredRowsAcceptedCount: acceptedRecoveredRowsCount,
          outputItemsCount: pruned.length,
          labelMode:
            acceptedRecoveredRowsCount > 0
              ? "mixed_extracted_and_guarded_template_recovery"
              : pruned.some((x) => !isSyntheticStatementLabel(x.label, statementKey))
                ? "extracted_from_table_rows"
                : "synthetic_by_statement_template",
          rejectedRowsSample: rejectedRows.slice(0, 20)
        }
      };
    }

    const balanceSheetLite = extractStatementLite(chosen.balancePage, "balance");
    const incomeStatementLite = extractStatementLite(chosen.incomePage, "income");
    const cashFlowLite = extractStatementLite(chosen.cashFlowPage, "cashflow");

    // =========================================================
    // Layer 7: Structured Field Mapping
    // =========================================================

    const STRUCTURED_MAPPINGS = {
      bank: {
        balance: {
          cashAndBalancesWithCentralBanks: ["نقد وأرصدة لدى البنوك المركزية", "cash and balances with central banks"],
          dueFromBanksAndFinancialInstitutions: ["أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي", "due from banks and other financial institutions"],
          investments: ["استثمارات بالصافي", "investments, net"],
          financingAndAdvances: ["تمويل وسلف بالصافي", "financing, net"],
          totalAssets: ["إجمالي الموجودات", "total assets"],
          dueToBanks: ["أرصدة للبنوك والبنوك المركزية والمؤسسات المالية الأخرى", "due to banks"],
          customerDeposits: ["ودائع العملاء", "customer deposits"],
          totalLiabilities: ["إجمالي المطلوبات", "total liabilities"],
          totalEquity: ["إجمالي حقوق الملكية", "total equity"],
          totalLiabilitiesAndEquity: ["إجمالي المطلوبات وحقوق الملكية", "total liabilities and equity"]
        },
        income: {
          specialCommissionIncome: ["الدخل من التمويل والاستثمارات", "net financing and investment income"],
          feeAndCommissionIncomeNet: ["الدخل من رسوم الخدمات المصرفية بالصافي", "fee from banking services, net"],
          totalOperatingIncome: ["إجمالي دخل العمليات التشغيلية", "total operating income"],
          totalOperatingExpenses: ["إجمالي مصاريف العمليات التشغيلية", "total operating expenses"],
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل", "net income before zakat", "profit before zakat"],
          netIncome: ["صافي دخل السنة", "net income for the year"],
          basicEps: ["ربحية السهم الأساسية", "basic and diluted earnings per share"],
          dilutedEps: ["ربحية السهم المخفضة"]
        },
        cashflow: {
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل", "net income before zakat"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية", "صافي النقد الناتج من الأنشطة التشغيلية", "net cash generated from operating activities", "net cash from operating activities"],
          netCashFromInvestingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة الاستثمارية", "صافي النقد المستخدم في الأنشطة الاستثمارية", "net cash used in investing activities"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التمويلية", "صافي النقد الناتج من الأنشطة التمويلية", "net cash generated from financing activities"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وشبه النقد في بداية السنة", "cash and cash equivalents at the beginning of the year"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وشبه النقد في نهاية السنة", "cash and cash equivalents at the end of the year"]
        }
      },

      insurance: {
        balance: {
          cashAndCashEquivalents: ["نقد وما في حكمه"],
          investments: ["استثمارات"],
          totalAssets: ["إجمالي الموجودات"],
          insuranceContractLiabilities: ["مطلوبات عقود التأمين"],
          totalLiabilities: ["إجمالي المطلوبات"],
          totalEquity: ["إجمالي حقوق الملكية"]
        },
        income: {
          insuranceRevenue: ["إيرادات التأمين", "ايرادات التامين", "insurance revenue"],
          insuranceServiceResult: ["نتيجة خدمة التأمين", "نتيجه خدمه التامين", "insurance service result"],
          netIncome: ["صافي ربح السنة", "ربح السنة"]
        },
        cashflow: {
          netIncome: ["صافي ربح السنة", "ربح السنة"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد المستخدم في الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من الأنشطة التمويلية"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وما في حكمه في نهاية السنة"]
        }
      },

      reit: {
        balance: {
          investmentProperties: ["عقارات استثمارية"],
          fairValueInvestments: ["موجودات مالية بالقيمة العادلة من خلال الربح أو الخسارة"],
          totalAssets: ["إجمالي الموجودات"],
          totalLiabilities: ["إجمالي المطلوبات"],
          netAssetsToUnitHolders: ["صافي الموجودات العائدة إلى مالكي الوحدات"]
        },
        income: {
          rentalIncome: ["دخل إيجار من عقارات استثمارية", "دخل ايجار من عقارات استثمارية"],
          netIncome: ["ربح السنة", "صافي دخل السنة"],
          totalComprehensiveIncome: ["إجمالي الدخل الشامل للسنة"]
        },
        cashflow: {
          netIncome: ["صافي الدخل للسنة", "ربح السنة"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد المستخدم في الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد المستخدم في الأنشطة التمويلية"],
          cashAndCashEquivalentsAtEndOfYear: ["النقدية وشبه النقدية في نهاية السنة"]
        }
      },

      operating_company: {
        balance: {
          cashAndCashEquivalents: ["النقد وما في حكمه", "cash and cash equivalents"],
          inventories: ["المخزون", "inventories"],
          tradeReceivables: ["المدينون التجاريون والدفعات المقدمة والذمم الأخرى", "المدينون التجاريون والذمم الأخرى", "trade receivables", "accounts receivable, prepayments and other receivables"],
          propertyPlantAndEquipment: ["الممتلكات والمعدات والآلات", "property, plant and equipment"],
          totalAssets: ["إجمالي الموجودات", "total assets"],
          tradePayables: ["الدائنون التجاريون والذمم الأخرى", "trade payables", "trade payables and other liabilities", "accounts payable, accruals and other liabilities"],
          totalLiabilities: ["إجمالي المطلوبات", "total liabilities"],
          retainedEarnings: ["أرباح مبقاة", "retained earnings"],
          totalEquity: ["إجمالي حقوق الملكية", "total equity"],
          totalLiabilitiesAndEquity: ["إجمالي المطلوبات وحقوق الملكية", "total liabilities and equity"]
        },
        income: {
          revenue: ["الإيرادات", "الايرادات", "revenue", "sales"],
          costOfSales: ["تكلفة المبيعات", "cost of sales", "operating costs"],
          grossProfit: ["مجمل الربح", "gross profit"],
          operatingProfit: ["الربح التشغيلي", "operating profit", "operating income"],
          profitBeforeZakatAndIncomeTax: ["الربح قبل الزكاة وضريبة الدخل", "profit before zakat and income tax", "profit (loss) before zakat and income tax"],
          netIncome: ["ربح السنة", "صافي الربح", "profit for the year", "profit (loss) for the year"],
          basicEps: ["ربحية السهم الأساسية", "basic earnings per share", "basic and diluted earnings per share"],
          dilutedEps: ["ربحية السهم المخفضة", "diluted earnings per share"]
        },
        cashflow: {
          netIncome: ["ربح السنة", "صافي الربح", "profit for the year", "profit (loss) for the year"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من الأنشطة التشغيلية", "net cash generated from operating activities", "net cash from operating activities"],
          netCashFromInvestingActivities: ["صافي النقد المستخدم في الأنشطة الاستثمارية", "net cash used in investing activities"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من الأنشطة التمويلية", "net cash generated from financing activities"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وما في حكمه في بداية السنة", "cash and cash equivalents at the beginning of the year"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وما في حكمه في نهاية السنة", "cash and cash equivalents at the end of the year"]
        }
      }
    };

    function findMappedItem(items, labels) {
      for (const label of (labels || [])) {
        const exact = (items || []).find((x) => normalizeText(x.label) === normalizeText(label));
        if (exact) return exact;
      }

      for (const label of (labels || [])) {
        const fuzzy = (items || []).find((x) => normalizedContains(x.label, label));
        if (fuzzy) return fuzzy;
      }

      return null;
    }

    function buildField(items, labels, pageNumber) {
      const row = findMappedItem(items, labels);
      return {
        label: row?.label || null,
        current: row?.current ?? null,
        previous: row?.previous ?? null,
        confidence: row ? 1 : 0,
        sourcePage: row?.source?.pageNumber || pageNumber || null,
        note: row?.note || null
      };
    }

    function buildStructuredFields(items, pageNumber, mapping) {
      const out = {};
      for (const fieldKey of Object.keys(mapping || {})) {
        out[fieldKey] = buildField(items, mapping[fieldKey], pageNumber);
      }
      return out;
    }

    const activeMappings = STRUCTURED_MAPPINGS[statementProfile] || STRUCTURED_MAPPINGS.operating_company;

    const balanceSheetStructured = {
      pageNumber: balanceSheetLite.pageNumber,
      latest: balanceSheetLite.latest,
      previous: balanceSheetLite.previous,
      years: balanceSheetLite.years,
      fields: buildStructuredFields(balanceSheetLite.items, balanceSheetLite.pageNumber, activeMappings.balance)
    };

    const incomeStatementStructured = {
      pageNumber: incomeStatementLite.pageNumber,
      latest: incomeStatementLite.latest,
      previous: incomeStatementLite.previous,
      years: incomeStatementLite.years,
      fields: buildStructuredFields(incomeStatementLite.items, incomeStatementLite.pageNumber, activeMappings.income)
    };

    const cashFlowStructured = {
      pageNumber: cashFlowLite.pageNumber,
      latest: cashFlowLite.latest,
      previous: cashFlowLite.previous,
      years: cashFlowLite.years,
      fields: buildStructuredFields(cashFlowLite.items, cashFlowLite.pageNumber, activeMappings.cashflow)
    };

    // =========================================================
    // Layer 8: Final Response Builder
    // =========================================================

    function topN(rankings, n = 5) {
      return (rankings || []).slice(0, n).map((r) => ({
        pageNumber: r.pageNumber,
        score: Math.round(r.score * 10) / 10,
        reasons: r.reasons,
        signals: r.signals,
        years: r.years,
        numbersCount: r.numbersCount,
        rowCount: r.rowCount,
        tableCount: r.tableCount,
        mainColumnCount: r.mainColumnCount,
        mainRowCount: r.mainRowCount,
        positionRatio: r.positionRatio,
        isLikelyIndexPage: r.isLikelyIndexPage,
        isLikelyStandardsPage: r.isLikelyStandardsPage,
        isLikelyEquityStatement: r.isLikelyEquityStatement,
        isLikelyComprehensiveIncome: r.isLikelyComprehensiveIncome,
        isLikelyNarrativePage: r.isLikelyNarrativePage,
        pageGuardrails: r.pageGuardrails,
        header: r.header
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v6.0",
      phase: "4B_guarded_recovery_and_core_row_boundary",
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
          "v6.0 adds guarded template recovery instead of allowing unlabeled numeric rows to flood lite outputs",
          "v6.0 stops recovered rows once enough real core rows have already been extracted",
          "v6.0 prunes synthetic spillover so income/cashflow stay focused on core statement rows",
          "v6.0 keeps the existing ranking and statement-selection architecture intact",
          "multi-page extension remains guarded against crossing into the next detected statement page"
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
