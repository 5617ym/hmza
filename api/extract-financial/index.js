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
        .replace(/[ ريالرسعوديةSARUSD\$]/gi, "")
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
        s.includes("3 months") ||
        s.includes("12 months") ||
        s.includes("السنه المنتهيه") ||
        s.includes("الفتره المنتهيه")
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

    function isLikelyReferenceValue(cell) {
      const raw = String(cell || "").trim();
      const s = normalizeText(raw);
      if (!raw) return false;
      if (isNoteHeaderCell(raw)) return true;
      if (isYearCell(raw)) return false;
      if (/^\(?\d{1,3}[a-zA-Z]?\)?$/.test(raw)) return true;
      if (/^[a-zA-Z]\d{1,3}$/.test(raw)) return true;
      if (/^\d{1,2}(\.\d{1,2})?$/.test(toEnglishDigits(raw))) return true;
      if (s === "n/a") return false;
      return false;
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
      return [rows[0] || [], rows[1] || [], rows[2] || [], rows[3] || []];
    }

    function getNumericColumnDensity(rows, limit = 20) {
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

    function detectHeaderColumns(rows) {
      const headerRows = getHeaderRows(rows);

      let latest = null;
      let previous = null;
      let currentCol = null;
      let previousCol = null;
      let noteCol = null;
      let labelCol = null;
      let headerRowIndex = null;
      let mode = "fallback";

      // 1) Try explicit year header
      for (let i = 0; i < headerRows.length; i += 1) {
        const row = headerRows[i];
        if (!Array.isArray(row) || !row.length) continue;

        const yearCells = row
          .map((cell, idx) => ({
            idx,
            year: isYearCell(cell) ? Number(toEnglishDigits(String(cell).trim())) : null
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
            if (isYearCell(text) || isLikelyReferenceValue(text)) continue;
            candidates.push(c);
          }

          labelCol = candidates.length ? Math.min(...candidates) : 0;
          break;
        }
      }

      // 2) Find note column separately
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

      // 3) Fallback numeric density
      if (currentCol == null || previousCol == null) {
        const numericCols = getNumericColumnDensity(rows, 20)
          .filter((x) => x.idx !== noteCol);

        if (numericCols.length >= 2) {
          const candidates = numericCols
            .slice(0, 6)
            .map((x) => x.idx)
            .sort((a, b) => a - b)
            .slice(-2);

          previousCol = candidates[0] ?? previousCol;
          currentCol = candidates[1] ?? currentCol;
          mode = "numeric_density";
        } else if (numericCols.length === 1) {
          currentCol = numericCols[0].idx;
          mode = "single_numeric_column";
        }
      }

      // 4) Label column fallback
      if (labelCol == null) {
        const scoreByCol = {};
        for (const row of (rows || []).slice(0, 20)) {
          if (!Array.isArray(row)) continue;
          row.forEach((cell, idx) => {
            const raw = String(cell || "").trim();
            if (!raw) return;
            if (idx === currentCol || idx === previousCol || idx === noteCol) return;
            if (isYearCell(raw)) return;
            if (isLikelyReferenceValue(raw)) return;
            const n = parseNumberSmart(raw);
            if (n != null && !/[^\d.,()\-]/.test(toEnglishDigits(raw))) return;
            scoreByCol[idx] = Math.max(scoreByCol[idx] || 0, raw.length);
          });
        }

        labelCol = Object.keys(scoreByCol)
          .map((k) => ({ idx: Number(k), score: scoreByCol[k] }))
          .sort((a, b) => b.score - a.score || a.idx - b.idx)[0]?.idx ?? 0;
      }

      return {
        latest,
        previous,
        currentCol,
        previousCol,
        noteCol,
        labelCol,
        headerRowIndex,
        resolutionMode: mode
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
      const firstRowsText = mainRows.slice(0, 8).map((r) => r.join(" | ")).join("\n");
      const lastRowsText = mainRows.slice(-8).map((r) => r.join(" | ")).join("\n");
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
        "statement of comprehensive income"
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
          "repricing"
        ]) &&
        !hasYearLikeHeader;

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
          "أسهم خزينة"
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
        isLikelyComprehensiveIncome
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
          "selling and distribution expenses"
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
          "due to banks"
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

      const bankScore = safeNumber(scores.bank, 0);
      const operatingScore = safeNumber(scores.operating_company, 0);

      const statementProfile = bankScore > operatingScore ? "bank" : "operating_company";

      return {
        statementProfile,
        scores,
        reason: statementProfile === "bank"
          ? "bank keywords stronger than operating-company keywords"
          : "operating-company keywords stronger than bank keywords"
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
            "profit or loss"
          ],
          structure: [
            "الدخل من التمويل",
            "الدخل من التمويل والاستثمارات",
            "رسوم الخدمات المصرفية",
            "اجمالي دخل العمليات",
            "اجمالي مصاريف العمليات",
            "دخل السنة قبل الزكاة",
            "صافي دخل السنة",
            "ربحية السهم"
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
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية"
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

    const ACTIVE_STATEMENT_CONFIGS = STATEMENT_CONFIGS[statementProfile] || STATEMENT_CONFIGS.bank;

    function statementRankScore(pageCtx, cfg, kind) {
      let score = 0;
      const reasons = [];

      // 1) Statement title first
      const titleHitsHeader = keywordHits(pageCtx.headerText, cfg.titles);
      const titleHitsAll = keywordHits(pageCtx.structuralText, cfg.titles);
      if (titleHitsHeader > 0) {
        const s = titleHitsHeader * 90;
        score += s;
        reasons.push(`titleHeader:+${s}`);
      } else if (titleHitsAll > 0) {
        const s = titleHitsAll * 55;
        score += s;
        reasons.push(`titleAll:+${s}`);
      }

      // 2) Header structure second
      if (pageCtx.hasYearLikeHeader) {
        score += 28;
        reasons.push("yearHeader:+28");
      }

      if (pageCtx.header?.latest && pageCtx.header?.previous) {
        score += 22;
        reasons.push("twoYearsDetected:+22");
      }

      if (pageCtx.header?.currentCol != null && pageCtx.header?.labelCol != null) {
        score += 12;
        reasons.push("usableColumns:+12");
      }

      // 3) Structural keywords third
      const structureHits = keywordHits(pageCtx.structuralText, cfg.structure);
      if (structureHits > 0) {
        const s = Math.min(structureHits, 10) * 12;
        score += s;
        reasons.push(`structure:+${s}`);
      }

      const negativeHits = keywordHits(pageCtx.structuralText, cfg.negatives);
      if (negativeHits > 0) {
        const s = Math.min(negativeHits, 8) * 16;
        score -= s;
        reasons.push(`negative:-${s}`);
      }

      // 4) Numbers density fourth
      if (pageCtx.numbersCount >= 8) {
        const s = Math.round(Math.min(pageCtx.numbersCount, 90) * 0.55);
        score += s;
        reasons.push(`numbers:+${s}`);
      }

      // 5) Order / position fifth
      if (pageCtx.positionRatio <= 0.35) {
        score += 6;
        reasons.push("earlySoft:+6");
      } else if (pageCtx.positionRatio >= 0.8) {
        score -= 6;
        reasons.push("lateSoft:-6");
      }

      // hard penalties
      if (pageCtx.isLikelyIndexPage) {
        score -= 180;
        reasons.push("index:-180");
      }

      if (pageCtx.isLikelyStandardsPage) {
        score -= 140;
        reasons.push("standards:-140");
      }

      if (kind !== "cashflow" && containsAny(pageCtx.normalizedText, [
        "cash flows from operating activities",
        "صافي النقد الناتج من الانشطه التشغيليه"
      ])) {
        score -= 55;
        reasons.push("cashflowCrossPenalty:-55");
      }

      if (kind !== "balance" && containsAny(pageCtx.normalizedText, [
        "اجمالي الموجودات",
        "اجمالي المطلوبات وحقوق الملكيه",
        "total liabilities and equity"
      ])) {
        if (!keywordHits(pageCtx.structuralText, cfg.titles)) {
          score -= 35;
          reasons.push("balanceCrossPenalty:-35");
        }
      }

      if (kind === "income") {
        if (pageCtx.isLikelyComprehensiveIncome) {
          score -= 120;
          reasons.push("comprehensiveIncomePenalty:-120");
        }
        if (pageCtx.isLikelyEquityStatement) {
          score -= 140;
          reasons.push("equityPenalty:-140");
        }
      }

      if (kind === "cashflow") {
        if (pageCtx.isLikelyEquityStatement) {
          score -= 140;
          reasons.push("equityPenalty:-140");
        }
        if (pageCtx.isLikelyComprehensiveIncome) {
          score -= 80;
          reasons.push("comprehensivePenalty:-80");
        }
      }

      if (kind === "balance" && pageCtx.isLikelyEquityStatement) {
        score -= 100;
        reasons.push("equityPenalty:-100");
      }

      if (pageCtx.mainColumnCount >= 5 && !pageCtx.isLikelyEquityStatement) {
        score -= 12;
        reasons.push("manyCols:-12");
      }

      if (pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4) {
        score += 18;
        reasons.push("statementLikeCols:+18");
      }

      if (pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 60) {
        score += 10;
        reasons.push("rowRange:+10");
      }

      return { score, reasons };
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
            header: pageCtx.header
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

    function topCandidates(rankings, topN = 8, minScore = -50) {
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
      const balanceCandidates = topCandidates(rankedBalance, 10, -60);
      const incomeCandidates = topCandidates(rankedIncome, 10, -60);
      const cashCandidates = topCandidates(rankedCashflow, 10, -60);

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
    // Layer 5: Header / Column Detection
    // =========================================================
    // implemented above as detectHeaderColumns(rows)

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
      const labels = (LITE_TEMPLATES[statementProfile] || LITE_TEMPLATES.bank)[statementKey] || [];
      return labels[index] || `${statementKey}_row_${index + 1}`;
    }

    function isSeparatorRow(cells) {
      const text = (cells || []).join(" ").trim();
      return /^[-–—_=|.\s]+$/.test(text);
    }

    function isHeaderLikeRow(cells) {
      const nonEmpty = (cells || []).filter((c) => !isBlank(c));
      if (!nonEmpty.length) return false;

      const yearCount = nonEmpty.filter(isYearCell).length;
      const noteCount = nonEmpty.filter(isNoteHeaderCell).length;
      const periodCount = nonEmpty.filter(isQuarterOrPeriodCell).length;
      const numericCount = nonEmpty.filter((c) => parseNumberSmart(c) != null).length;

      if (yearCount >= 2) return true;
      if (noteCount >= 1 && yearCount >= 1) return true;
      if (periodCount >= 1 && yearCount >= 1) return true;
      if (numericCount === 0 && nonEmpty.length <= 4) return true;

      return false;
    }

    function extractLabelFromRow(cells, header) {
      const pieces = [];

      if (header?.labelCol != null && cells[header.labelCol] != null) {
        const raw = String(cells[header.labelCol] || "").trim();
        if (raw && !isYearCell(raw) && !isLikelyReferenceValue(raw) && parseNumberSmart(raw) == null) {
          pieces.push(raw);
        }
      }

      for (let i = 0; i < cells.length; i += 1) {
        if (i === header?.currentCol || i === header?.previousCol || i === header?.noteCol) continue;

        const raw = String(cells[i] || "").trim();
        if (!raw) continue;
        if (isYearCell(raw)) continue;
        if (isLikelyReferenceValue(raw)) continue;

        const n = parseNumberSmart(raw);
        if (n != null && !/[^\d.,()\-]/.test(toEnglishDigits(raw))) continue;

        if (!pieces.includes(raw)) pieces.push(raw);
      }

      return cleanupLabel(pieces.join(" "));
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
          .filter((x) => !isYearCell(x.raw))
          .filter((x) => !isLikelyReferenceValue(x.raw))
          .filter((x) => x.idx !== header?.noteCol)
          .filter((x) => x.idx !== header?.labelCol)
          .sort((a, b) => a.idx - b.idx);

        if (numericCells.length >= 2) {
          previous = numericCells[numericCells.length - 2].num;
          current = numericCells[numericCells.length - 1].num;
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

      if (isHeaderLikeRow(cells)) {
        return { ok: false, reason: "header_like_row" };
      }

      const label = extractLabelFromRow(cells, header);
      const values = extractValuesFromRow(cells, header);

      if (!label) return { ok: false, reason: "no_label" };
      if (values.current == null && values.previous == null) {
        return { ok: false, reason: "no_values" };
      }

      const labelNorm = normalizeText(label);

      if (
        labelNorm === "ايضاح" ||
        labelNorm === "notes" ||
        labelNorm === "note" ||
        labelNorm === "الملاحظات"
      ) {
        return { ok: false, reason: "note_header_row" };
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

      return {
        ok: true,
        reason: "valid",
        label,
        values
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
          (prev.note ? 0.25 : 0);

        const nowStrength =
          (item.current != null ? 1 : 0) +
          (item.previous != null ? 1 : 0) +
          (item.note ? 0.25 : 0);

        if (nowStrength > prevStrength) {
          map.set(key, item);
        }
      }

      return Array.from(map.values());
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
      if (!nextCtx || !nextCtx.mainTable) return result;

      const cfg = ACTIVE_STATEMENT_CONFIGS[statementKey];
      const primaryScore = statementRankScore(primary, cfg, statementKey).score;
      const nextScore = statementRankScore(nextCtx, cfg, statementKey).score;

      const canExtend =
        nextScore >= primaryScore - 35 &&
        !nextCtx.isLikelyIndexPage &&
        !nextCtx.isLikelyStandardsPage &&
        !nextCtx.isLikelyEquityStatement &&
        !(statementKey === "income" && nextCtx.isLikelyComprehensiveIncome);

      if (canExtend) {
        result.push({
          pageNumber: nextCtx.pageNumber,
          table: nextCtx.mainTable,
          context: nextCtx
        });
      }

      return result;
    }

    function buildLiteItem(label, current, previous, note, source) {
      return {
        label: String(label || "").trim(),
        current: current != null ? current : null,
        previous: previous != null ? previous : null,
        note: note || null,
        source: source || null
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
            tablesUsed: 0,
            sourcePages: [],
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
            tablesUsed: 0,
            sourcePages: [],
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
          headerRowIndex: localHeader.headerRowIndex,
          resolutionMode: primaryHeader.resolutionMode || localHeader.resolutionMode
        };

        const startRowIndex = localHeader.headerRowIndex != null
          ? localHeader.headerRowIndex + 1
          : (t === 0 ? 1 : 0);

        for (let i = startRowIndex; i < metaRows.length; i += 1) {
          const cells = metaRows[i].cells || [];
          const validation = validateRow(cells, header, statementKey);

          if (!validation.ok) {
            rejectedRows.push({
              pageNumber: tableInfo.pageNumber,
              rowIndex: i,
              reason: validation.reason,
              row: cells.join(" | ")
            });
            continue;
          }

          const note = header.noteCol != null
            ? String(cells[header.noteCol] || "").trim() || null
            : null;

          const finalLabel = cleanupLabel(validation.label) || getSyntheticLabel(statementKey, allItems.length);

          allItems.push(buildLiteItem(
            finalLabel,
            validation.values.current,
            validation.values.previous,
            note,
            {
              pageNumber: tableInfo.pageNumber,
              rowIndex: i
            }
          ));
        }
      }

      const items = dedupeItems(allItems);

      return {
        pageNumber,
        latest,
        previous,
        years: [latest, previous].filter(Boolean),
        items: items.filter((x) => x.current != null || x.previous != null),
        extractionMeta: {
          currentCol: primaryHeader.currentCol,
          previousCol: primaryHeader.previousCol,
          noteCol: primaryHeader.noteCol,
          labelCol: primaryHeader.labelCol,
          headerResolutionMode: primaryHeader.resolutionMode || null,
          tablesUsed: statementTables.length,
          sourcePages,
          labelMode: items.some((x) => !/^balance_row_|^income_row_|^cashflow_row_/i.test(x.label))
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
          cashAndBalancesWithCentralBanks: ["نقد وأرصدة لدى البنوك المركزية"],
          dueFromBanksAndFinancialInstitutions: ["أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي"],
          investments: ["استثمارات بالصافي"],
          financingAndAdvances: ["تمويل وسلف بالصافي"],
          totalAssets: ["إجمالي الموجودات"],
          dueToBanks: ["أرصدة للبنوك والبنوك المركزية والمؤسسات المالية الأخرى"],
          customerDeposits: ["ودائع العملاء"],
          totalLiabilities: ["إجمالي المطلوبات"],
          totalEquity: ["إجمالي حقوق الملكية"],
          totalLiabilitiesAndEquity: ["إجمالي المطلوبات وحقوق الملكية"]
        },
        income: {
          specialCommissionIncome: ["الدخل من التمويل والاستثمارات"],
          feeAndCommissionIncomeNet: ["الدخل من رسوم الخدمات المصرفية بالصافي"],
          totalOperatingIncome: ["إجمالي دخل العمليات التشغيلية"],
          totalOperatingExpenses: ["إجمالي مصاريف العمليات التشغيلية"],
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل"],
          netIncome: ["صافي دخل السنة"],
          basicEps: ["ربحية السهم الأساسية"],
          dilutedEps: ["ربحية السهم المخفضة"]
        },
        cashflow: {
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية", "صافي النقد الناتج من الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة الاستثمارية", "صافي النقد المستخدم في الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التمويلية", "صافي النقد الناتج من الأنشطة التمويلية"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وشبه النقد في بداية السنة"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وشبه النقد في نهاية السنة"]
        }
      },
      operating_company: {
        balance: {
          cashAndCashEquivalents: ["النقد وما في حكمه"],
          inventories: ["المخزون"],
          tradeReceivables: ["المدينون التجاريون والدفعات المقدمة والذمم الأخرى", "المدينون التجاريون والذمم الأخرى"],
          propertyPlantAndEquipment: ["الممتلكات والمعدات والآلات"],
          totalAssets: ["إجمالي الموجودات"],
          tradePayables: ["الدائنون التجاريون والذمم الأخرى"],
          totalLiabilities: ["إجمالي المطلوبات"],
          retainedEarnings: ["أرباح مبقاة"],
          totalEquity: ["إجمالي حقوق الملكية"],
          totalLiabilitiesAndEquity: ["إجمالي المطلوبات وحقوق الملكية"]
        },
        income: {
          revenue: ["الإيرادات", "الايرادات"],
          costOfSales: ["تكلفة المبيعات"],
          grossProfit: ["مجمل الربح"],
          operatingProfit: ["الربح التشغيلي"],
          profitBeforeZakatAndIncomeTax: ["الربح قبل الزكاة وضريبة الدخل"],
          netIncome: ["ربح السنة", "صافي الربح"],
          basicEps: ["ربحية السهم الأساسية"],
          dilutedEps: ["ربحية السهم المخفضة"]
        },
        cashflow: {
          netIncome: ["ربح السنة", "صافي الربح"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد المستخدم في الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من الأنشطة التمويلية"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وما في حكمه في بداية السنة"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وما في حكمه في نهاية السنة"]
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

    const activeMappings = STRUCTURED_MAPPINGS[statementProfile] || STRUCTURED_MAPPINGS.bank;

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
        header: r.header
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v5.0",
      phase: "4B_rewrite",
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
        notes: [
          "v5.0 rewrite keeps the same external architecture and response shape",
          "page selection priority: statement title -> header structure -> structural keywords -> numbers density -> soft order",
          "bank and operating_company are separated more clearly",
          "income ranking applies strict penalties against comprehensive income and equity statement confusion",
          "page selection relies on Azure pageNumber / tablesPreview page mapping only",
          "header detection explicitly resolves current / previous / note / label columns",
          "row extraction blocks reference/note/year cells from being interpreted as financial values",
          "multi-page extraction is supported with guarded extension to the next compatible page",
          "internal layers are organized to enable later extraction into separate files"
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
