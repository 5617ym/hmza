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

    // =========================
    // Helpers
    // =========================

    const ARABIC_DIGITS = {
      "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
      "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
      "٫": ".", "٬": ",", "−": "-", "–": "-", "—": "-", "ـ": ""
    };

    function toEnglishDigits(value) {
      return String(value || "").replace(/[٠-٩٫٬−–—ـ]/g, (m) => ARABIC_DIGITS[m] || m);
    }

    function normalizeText(value) {
      let s = String(value || "");
      s = toEnglishDigits(s);
      s = s
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[إأآا]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/ؤ/g, "و")
        .replace(/ئ/g, "ي")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return s;
    }

    function unique(arr) {
      return Array.from(new Set((arr || []).filter(Boolean)));
    }

    function safeNumber(v, fallback = 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
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
        const commaParts = s.split(",");
        const last = commaParts[commaParts.length - 1];
        if (last.length === 1 || last.length === 2) {
          s = commaParts.slice(0, -1).join("") + "." + last;
        } else {
          s = s.replace(/,/g, "");
        }
      } else if (hasDot && !hasComma) {
        const dotParts = s.split(".");
        const last = dotParts[dotParts.length - 1];
        if (!(last.length === 1 || last.length === 2)) {
          s = s.replace(/\./g, "");
        }
      }

      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return negative ? -n : n;
    }

    function countNumbers(text) {
      const s = toEnglishDigits(String(text || ""));
      const matches = s.match(/(?:\(?-?\d[\d,]*\.?\d*\)?)/g);
      return matches ? matches.length : 0;
    }

    function extractYears(text) {
      const s = toEnglishDigits(String(text || ""));
      const years = s.match(/\b(20\d{2}|19\d{2})\b/g) || [];
      return unique(years.map(Number)).sort((a, b) => b - a);
    }

    function textContainsAny(text, phrases) {
      const s = normalizeText(text);
      return (phrases || []).some((p) => s.includes(normalizeText(p)));
    }

    function countKeywordHits(text, phrases) {
      const s = normalizeText(text);
      let score = 0;
      for (const p of (phrases || [])) {
        const pp = normalizeText(p);
        if (!pp) continue;
        if (s.includes(pp)) score += 1;
      }
      return score;
    }

    function regexCount(text, list) {
      const s = normalizeText(text);
      let c = 0;
      for (const re of list || []) {
        if (re.test(s)) c += 1;
      }
      return c;
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

    function flattenTableValue(v) {
      if (v == null) return "";
      if (Array.isArray(v)) return v.map(flattenTableValue).join("\n");
      if (typeof v === "object") return Object.values(v).map(flattenTableValue).join("\n");
      return String(v);
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
        .map(flattenTableValue)
        .join("\n");
    }

    function getTablesForPage(pageNumber) {
      return tablesPreview.filter((t) => pageNumFromObj(t) === pageNumber);
    }

    function getTableRowCount(table) {
      return safeNumber(table?.rowCount ?? table?.rows ?? table?.nRows ?? 0, 0);
    }

    function getTableColumnCount(table) {
      return safeNumber(table?.columnCount ?? table?.columns ?? table?.nCols ?? 0, 0);
    }

    function extractTableRows(table) {
      const rows = [];
      const candidates = [];

      if (Array.isArray(table?.sampleHead)) candidates.push(...table.sampleHead);
      if (Array.isArray(table?.sample)) candidates.push(...table.sample);
      if (Array.isArray(table?.sampleTail)) candidates.push(...table.sampleTail);

      for (const row of candidates) {
        if (Array.isArray(row)) {
          rows.push(row.map((x) => String(x == null ? "" : x).trim()));
        } else if (row != null) {
          rows.push([String(row).trim()]);
        }
      }

      return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
    }

    function getTableRowsWithMeta(table) {
      const rows = extractTableRows(table);
      return rows.map((cells, idx) => ({
        index: idx,
        cells,
        joined: cells.join(" | "),
        normalized: normalizeText(cells.join(" | "))
      }));
    }

    function getPageMainTable(pageTables) {
      const tables = Array.isArray(pageTables) ? pageTables : [];
      if (!tables.length) return null;

      return tables
        .slice()
        .sort((a, b) => {
          const aScore = (getTableRowCount(a) * 10) + getTableColumnCount(a);
          const bScore = (getTableRowCount(b) * 10) + getTableColumnCount(b);
          return bScore - aScore;
        })[0];
    }

    function buildPageContext(pageNumber) {
      const pageMeta = pages.find((p) => safeNumber(p.pageNumber) === pageNumber) || {};
      const pageTables = getTablesForPage(pageNumber);
      const mergedTableText = pageTables.map(tableText).join("\n\n");
      const mergedText = mergedTableText;

      const numbersCount = countNumbers(mergedText);
      const years = extractYears(mergedText);

      const rowCount = pageTables.reduce((sum, t) => sum + getTableRowCount(t), 0);
      const columnCount = pageTables.reduce((sum, t) => sum + getTableColumnCount(t), 0);
      const mainTable = getPageMainTable(pageTables);
      const mainRows = extractTableRows(mainTable);
      const mainRowsMeta = getTableRowsWithMeta(mainTable);
      const mainColumnCount = getTableColumnCount(mainTable);
      const mainRowCount = getTableRowCount(mainTable);

      const headerText = [
        mainRows[0] || [],
        mainRows[1] || [],
        mainTable?.sampleHead || []
      ].map(flattenTableValue).join("\n");

      const structuralHintsText = `${headerText}\n${mergedText}`;

      const isLikelyNoteTable =
        mainColumnCount >= 5 ||
        textContainsAny(structuralHintsText, [
          "خلال 3 اشهر",
          "خلال ٣ اشهر",
          "3-12 شهر",
          "12-3 شهر",
          "1-5 سنوات",
          "5-1 سنوات",
          "اكثر من 5 سنوات",
          "اكثر من ٥ سنوات",
          "non-commission",
          "interest rate risk",
          "repricing",
          "gap",
          "الفجوه",
          "الفجوة",
          "التراكميه",
          "التراكمية",
          "مخاطر اسعار العمولات",
          "maturity",
          "liquidity risk",
          "credit risk"
        ]);

      const hasStatementHeader =
        textContainsAny(structuralHintsText, [
          "قائمة المركز المالي",
          "قائمة الدخل",
          "قائمة الدخل الموحدة",
          "قائمة التدفقات النقدية",
          "statement of financial position",
          "income statement",
          "statement of income",
          "statement of cash flows",
          "cash flow statement"
        ]);

      const hasYearHeaderLikeStatement =
        mainRows.some((r) => {
          const joined = normalizeText(r.join(" | "));
          const yearCount = extractYears(joined).length;
          return (
            yearCount >= 1 &&
            (
              joined.includes("ايضاح") ||
              joined.includes("notes") ||
              joined === "2024 | 2025" ||
              joined === "2025 | 2024" ||
              joined.includes("2024 | 2025 | ايضاح") ||
              joined.includes("2025 | 2024 | ايضاح") ||
              joined.includes("2024 2025") ||
              joined.includes("2025 2024")
            )
          );
        });

      return {
        pageNumber,
        pageMeta,
        tables: pageTables,
        text: mergedText,
        normalizedText: normalizeText(mergedText),
        numbersCount,
        years,
        rowCount,
        columnCount,
        tableCount: pageTables.length,
        mainTable,
        mainRows,
        mainRowsMeta,
        mainColumnCount,
        mainRowCount,
        headerText,
        structuralHintsText,
        isLikelyNoteTable,
        hasStatementHeader,
        hasYearHeaderLikeStatement
      };
    }

    const allPageNumbers = unique(
      tablesPreview
        .map((t) => pageNumFromObj(t))
        .filter((n) => Number.isFinite(n) && n > 0)
    ).sort((a, b) => a - b);

    const pageContexts = allPageNumbers.map(buildPageContext);

    // =========================
    // Statement Config
    // =========================

    const STATEMENTS = {
      balance: {
        key: "balance",
        title: "balanceSheet",
        positiveTitles: [
          "قائمة المركز المالي",
          "المركز المالي",
          "قائمة الوضع المالي",
          "الميزانية",
          "الميزانية العمومية",
          "statement of financial position",
          "financial position",
          "balance sheet"
        ],
        positiveKeywords: [
          "الاصول",
          "الموجودات",
          "الالتزامات",
          "المطلوبات",
          "حقوق الملكية",
          "حقوق المساهمين",
          "اجمالي الاصول",
          "اجمالي الموجودات",
          "اجمالي الالتزامات",
          "اجمالي المطلوبات",
          "اجمالي حقوق الملكية",
          "current assets",
          "non-current assets",
          "total assets",
          "equity",
          "liabilities",
          "total liabilities"
        ],
        negativeKeywords: [
          "قائمة الدخل",
          "الدخل الشامل",
          "قائمة التدفقات النقدية",
          "التغيرات في حقوق الملكية",
          "statement of income",
          "comprehensive income",
          "cash flow",
          "changes in equity",
          "خلال 3 اشهر",
          "5-1 سنوات",
          "اكثر من 5 سنوات",
          "الفجوة الخاضعة لمخاطر اسعار العمولات"
        ],
        preferredOrderIndex: 0
      },

      income: {
        key: "income",
        title: "incomeStatement",
        positiveTitles: [
          "قائمة الدخل",
          "قائمة الدخل الموحدة",
          "قائمة الارباح والخسائر",
          "قائمة الربح والخسارة",
          "بيان الارباح",
          "statement of income",
          "income statement",
          "profit and loss",
          "profit or loss"
        ],
        positiveKeywords: [
          "الايرادات",
          "المبيعات",
          "تكلفة الايرادات",
          "تكلفة المبيعات",
          "اجمالي الربح",
          "الربح التشغيلي",
          "دخل العمليات",
          "صافي الربح",
          "صافي دخل السنة",
          "ربحية السهم",
          "ربح السهم",
          "revenue",
          "sales",
          "gross profit",
          "operating income",
          "operating profit",
          "net profit",
          "earnings per share"
        ],
        negativeKeywords: [
          "الدخل الشامل",
          "قائمة الدخل الشامل",
          "قائمة التغيرات في حقوق الملكية",
          "التغيرات في حقوق الملكية",
          "قائمة المركز المالي",
          "قائمة التدفقات النقدية",
          "other comprehensive income",
          "comprehensive income",
          "changes in equity",
          "statement of financial position",
          "cash flow"
        ],
        strongNegativeRegex: [
          /الدخل الشامل/,
          /قائمه الدخل الشامل/,
          /التغيرات في حقوق الملكيه/,
          /changes in equity/,
          /other comprehensive income/
        ],
        preferredOrderIndex: 1
      },

      cashflow: {
        key: "cashflow",
        title: "cashFlowStatement",
        positiveTitles: [
          "قائمة التدفقات النقدية",
          "بيان التدفقات النقدية",
          "التدفقات النقدية",
          "cash flow statement",
          "statement of cash flows",
          "cash flows"
        ],
        positiveKeywords: [
          "صافي النقد",
          "صافي النقد الناتج من الانشطة التشغيلية",
          "صافي النقد المستخدم في الانشطة الاستثمارية",
          "صافي النقد الناتج من الانشطة التمويلية",
          "النقد وما في حكمه",
          "النقد وشبه النقد",
          "رصيد النقد",
          "operating activities",
          "investing activities",
          "financing activities",
          "cash and cash equivalents",
          "net cash"
        ],
        negativeKeywords: [
          "قائمة الدخل",
          "الدخل الشامل",
          "قائمة المركز المالي",
          "قائمة التغيرات في حقوق الملكية",
          "income statement",
          "comprehensive income",
          "financial position",
          "changes in equity"
        ],
        preferredOrderIndex: 3
      }
    };

    // =========================
    // Scoring
    // =========================

    function statementBaseScore(pageCtx, cfg) {
      const text = pageCtx.text || "";
      const structuralText = pageCtx.structuralHintsText || "";
      const normalizedText = pageCtx.normalizedText || "";

      let score = 0;
      const reasons = [];

      const titleHits = countKeywordHits(structuralText, cfg.positiveTitles);
      if (titleHits > 0) {
        score += titleHits * 40;
        reasons.push(`titleHits:${titleHits}`);
      }

      const keywordHits = countKeywordHits(text, cfg.positiveKeywords);
      if (keywordHits > 0) {
        score += Math.min(keywordHits, 8) * 7;
        reasons.push(`keywordHits:${keywordHits}`);
      }

      const negativeHits = countKeywordHits(text, cfg.negativeKeywords);
      if (negativeHits > 0) {
        score -= Math.min(negativeHits, 10) * 10;
        reasons.push(`negativeHits:-${negativeHits}`);
      }

      if (cfg.strongNegativeRegex && cfg.strongNegativeRegex.length) {
        const strongNeg = regexCount(text, cfg.strongNegativeRegex);
        if (strongNeg > 0) {
          score -= strongNeg * 35;
          reasons.push(`strongNegative:-${strongNeg}`);
        }
      }

      const numCount = pageCtx.numbersCount || 0;
      if (numCount >= 10) {
        score += Math.min(numCount, 40) * 0.7;
        reasons.push(`numbers:+${Math.round(Math.min(numCount, 40) * 0.7)}`);
      }

      if (pageCtx.tableCount > 0) {
        score += Math.min(pageCtx.tableCount, 3) * 5;
        reasons.push(`tableCount:+${Math.min(pageCtx.tableCount, 3) * 5}`);
      }

      if (pageCtx.rowCount >= 8) {
        score += Math.min(pageCtx.rowCount, 30) * 0.4;
        reasons.push(`rows:+${Math.round(Math.min(pageCtx.rowCount, 30) * 0.4)}`);
      }

      if (pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4) {
        score += 18;
        reasons.push("statementLikeCols:+18");
      }

      if (pageCtx.mainColumnCount > 4) {
        score -= Math.min(pageCtx.mainColumnCount - 4, 6) * 16;
        reasons.push(`wideTablePenalty:-${Math.min(pageCtx.mainColumnCount - 4, 6) * 16}`);
      } else if (pageCtx.columnCount >= 3) {
        score += Math.min(pageCtx.columnCount, 8) * 1.2;
        reasons.push(`cols:+${Math.round(Math.min(pageCtx.columnCount, 8) * 1.2)}`);
      }

      if (pageCtx.years.length >= 1) {
        score += 4;
        reasons.push("years:+4");
      }
      if (pageCtx.years.length >= 2) {
        score += 3;
        reasons.push("years2:+3");
      }

      if (pageCtx.hasStatementHeader) {
        score += 45;
        reasons.push("statementHeader:+45");
      }

      if (pageCtx.hasYearHeaderLikeStatement) {
        score += 25;
        reasons.push("yearHeaderLikeStatement:+25");
      }

      if (pageCtx.isLikelyNoteTable) {
        score -= 70;
        reasons.push("noteTablePenalty:-70");
      }

      if (cfg.key === "balance") {
        if (textContainsAny(normalizedText, [
          "الاصول المتداولة",
          "الاصول غير المتداولة",
          "الموجودات",
          "المطلوبات",
          "حقوق الملكية",
          "current assets",
          "non-current assets",
          "total liabilities and equity",
          "اجمالي المطلوبات وحقوق الملكية"
        ])) {
          score += 18;
          reasons.push("balanceStructure:+18");
        }
      }

      if (cfg.key === "income") {
        if (textContainsAny(normalizedText, [
          "الايرادات",
          "اجمالي الربح",
          "صافي الربح",
          "صافي دخل السنة",
          "revenue",
          "gross profit",
          "net profit"
        ])) {
          score += 18;
          reasons.push("incomeStructure:+18");
        }
        if (textContainsAny(normalizedText, [
          "الدخل الشامل الاخر",
          "بنود الدخل الشامل",
          "other comprehensive income"
        ])) {
          score -= 25;
          reasons.push("comprehensivePenalty:-25");
        }
      }

      if (cfg.key === "cashflow") {
        if (textContainsAny(normalizedText, [
          "الانشطة التشغيلية",
          "الانشطة الاستثمارية",
          "الانشطة التمويلية",
          "operating activities",
          "investing activities",
          "financing activities"
        ])) {
          score += 22;
          reasons.push("cashflowStructure:+22");
        }
      }

      return { score, reasons };
    }

    function rankPagesForStatement(cfg) {
      return pageContexts
        .map((pageCtx) => {
          const base = statementBaseScore(pageCtx, cfg);
          return {
            pageNumber: pageCtx.pageNumber,
            score: base.score,
            reasons: base.reasons,
            years: pageCtx.years,
            numbersCount: pageCtx.numbersCount,
            rowCount: pageCtx.rowCount,
            tableCount: pageCtx.tableCount,
            mainColumnCount: pageCtx.mainColumnCount,
            isLikelyNoteTable: pageCtx.isLikelyNoteTable,
            hasStatementHeader: pageCtx.hasStatementHeader
          };
        })
        .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    }

    const rankedBalanceBase = rankPagesForStatement(STATEMENTS.balance);
    const rankedIncomeBase = rankPagesForStatement(STATEMENTS.income);
    const rankedCashBase = rankPagesForStatement(STATEMENTS.cashflow);

    function getScoreMap(rankings) {
      const m = {};
      for (const r of rankings) m[r.pageNumber] = r.score;
      return m;
    }

    const balanceBaseMap = getScoreMap(rankedBalanceBase);
    const incomeBaseMap = getScoreMap(rankedIncomeBase);
    const cashBaseMap = getScoreMap(rankedCashBase);

    function orderAdjustedScore(pageNumber, baseScore, statementKey, chosen) {
      let score = baseScore;

      if (statementKey === "income") {
        if (chosen.balancePage) {
          const diff = pageNumber - chosen.balancePage;
          if (diff >= 1 && diff <= 6) score += 18;
          else if (diff >= -1 && diff <= 10) score += 8;
          else if (diff < -1) score -= 14;
        }
      }

      if (statementKey === "cashflow") {
        if (chosen.incomePage) {
          const diff = pageNumber - chosen.incomePage;
          if (diff >= 1 && diff <= 8) score += 24;
          else if (diff >= -1 && diff <= 14) score += 8;
          else if (diff < -1) score -= 18;
        }
        if (chosen.balancePage) {
          const diff2 = pageNumber - chosen.balancePage;
          if (diff2 >= 2) score += 6;
        }
      }

      if (statementKey === "balance") {
        if (chosen.incomePage && pageNumber > chosen.incomePage) score -= 10;
        if (chosen.cashFlowPage && pageNumber > chosen.cashFlowPage) score -= 16;
      }

      return score;
    }

    function pickBestPage(statementKey, baseMap, chosen) {
      const ranked = pageContexts
        .map((ctx) => ({
          pageNumber: ctx.pageNumber,
          score: orderAdjustedScore(ctx.pageNumber, baseMap[ctx.pageNumber] || 0, statementKey, chosen)
        }))
        .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

      return ranked[0] || null;
    }

    const chosen = {};

    const bestBalance = pickBestPage("balance", balanceBaseMap, chosen);
    chosen.balancePage = bestBalance?.pageNumber || null;

    const bestIncome = pickBestPage("income", incomeBaseMap, chosen);
    chosen.incomePage = bestIncome?.pageNumber || null;

    chosen.cashFlowPage = null;
    const bestCash = pickBestPage("cashflow", cashBaseMap, chosen);
    chosen.cashFlowPage = bestCash?.pageNumber || null;

    // =========================
    // Table-aware extraction v3.2
    // =========================

    function isYearCell(cell) {
      const s = toEnglishDigits(String(cell || "").trim());
      return /^(19|20)\d{2}$/.test(s);
    }

    function isNoteCell(cell) {
      const s = normalizeText(cell);
      return s === "ايضاح" || s === "notes" || s === "note";
    }

    function isNumericLikeCell(cell) {
      const n = parseNumberSmart(cell);
      return n !== null && Number.isFinite(n);
    }

    function looksLikeNarrativeLabel(label) {
      const s = normalizeText(label);
      if (!s) return true;
      if (s.length > 140) return true;

      return textContainsAny(s, [
        "كما هو منصوص",
        "المعيار الدولي",
        "انشاتها الزميله",
        "المنشاه المستثمره",
        "يتم اثباتها",
        "يتم تسويتها",
        "لغرض",
        "بالكامل",
        "المشروع المشترك",
        "السياسات المحاسبيه",
        "السياسات المحاسبية",
        "الافصاحات",
        "الإفصاحات",
        "الملخص"
      ]);
    }

    function isStatementTitleLike(label) {
      const s = normalizeText(label);
      return textContainsAny(s, [
        "قائمة المركز المالي",
        "قائمة الدخل",
        "قائمة الدخل الموحده",
        "قائمة الدخل الموحدة",
        "قائمة التدفقات النقدية",
        "قائمة التغيرات في حقوق الملكيه",
        "قائمة التغيرات في حقوق الملكية",
        "statement of financial position",
        "income statement",
        "statement of income",
        "statement of cash flows",
        "changes in equity"
      ]);
    }

    function looksLikeFinancialRowLabel(label, statementKey) {
      const s = normalizeText(label);
      if (!s) return false;
      if (looksLikeNarrativeLabel(s)) return false;
      if (isStatementTitleLike(s)) return false;

      const blacklistCommon = [
        "ايضاح", "الايضاحات", "notes", "note", "ريال", "الف ريال", "مليون ريال",
        "the accompanying notes", "الايضاحات المرفقه", "تابع", "continued",
        "يناير", "فبراير", "مارس", "ابريل", "أبريل", "مايو", "يونيو", "يوليو",
        "اغسطس", "أغسطس", "سبتمبر", "اكتوبر", "أكتوبر", "نوفمبر", "ديسمبر",
        "الموجودات", "المطلوبات", "حقوق الملكيه", "حقوق الملكية",
        "الانشطه التشغيليه", "الانشطه الاستثمارية", "الانشطه التمويلية"
      ];
      if (blacklistCommon.some((x) => s === normalizeText(x))) return false;

      if (statementKey === "balance") {
        return textContainsAny(s, [
          "نقد", "ارصده", "أرصدة", "استثمارات", "تمويل", "سلف", "مشتقات",
          "موجودات", "اصول", "أصول", "مطلوبات", "ودائع", "حقوق الملكيه",
          "اجمالي الموجودات", "اجمالي المطلوبات", "اجمالي حقوق الملكيه",
          "اجمالي المطلوبات وحقوق الملكيه", "cash", "investments", "financing",
          "advances", "deposits", "equity", "assets", "liabilities"
        ]);
      }

      if (statementKey === "income") {
        return textContainsAny(s, [
          "الدخل", "صافي", "اجمالي", "إجمالي", "مصاريف", "رسوم",
          "عمولات", "زكاه", "زكاة", "ضريبه", "ضريبة", "ربحيه", "ربحية",
          "التمويل", "الاستثمارات", "التشغيليه", "التشغيلية",
          "income", "expense", "profit", "earnings", "commission", "operating"
        ]);
      }

      if (statementKey === "cashflow") {
        return textContainsAny(s, [
          "النقد", "شبه النقد", "صافي النقد", "بدايه السنه", "بداية السنة",
          "نهايه السنه", "نهاية السنة", "دخل السنه قبل الزكاه",
          "دخل السنة قبل الزكاة", "cash", "operating activities",
          "investing activities", "financing activities"
        ]);
      }

      return true;
    }

    function detectStatementColumns(mainRowsMeta) {
      const rows = Array.isArray(mainRowsMeta) ? mainRowsMeta : [];
      const maxCols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);

      const best = {
        currentCol: null,
        previousCol: null,
        noteCol: null,
        labelCol: null,
        headerRowIndex: null,
        detectedYears: [],
        allYearCols: []
      };

      // first pass: find explicit year header row
      for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
        const row = rows[i];
        const cells = row.cells || [];
        const yearPositions = [];

        for (let c = 0; c < cells.length; c += 1) {
          if (isYearCell(cells[c])) {
            yearPositions.push({
              col: c,
              year: Number(toEnglishDigits(cells[c]))
            });
          }
          if (isNoteCell(cells[c])) {
            best.noteCol = c;
          }
        }

        if (yearPositions.length >= 2) {
          const yearsSorted = yearPositions.slice().sort((a, b) => b.year - a.year);
          best.currentCol = yearsSorted[0].col;
          best.previousCol = yearsSorted[1].col;
          best.detectedYears = yearsSorted.map((x) => x.year);
          best.allYearCols = yearPositions.map((x) => x.col);
          best.headerRowIndex = i;
          break;
        }

        if (yearPositions.length === 1) {
          best.currentCol = yearPositions[0].col;
          best.detectedYears = [yearPositions[0].year];
          best.allYearCols = [yearPositions[0].col];
          best.headerRowIndex = i;
        }
      }

      // second pass fallback: locate numeric columns
      if (best.currentCol == null || best.previousCol == null) {
        const numericScores = [];
        for (let c = 0; c < maxCols; c += 1) {
          let numericHits = 0;
          for (let r = 0; r < rows.length; r += 1) {
            const cell = rows[r].cells[c];
            if (isNumericLikeCell(cell)) numericHits += 1;
          }
          numericScores.push({ col: c, numericHits });
        }

        const topNumericCols = numericScores
          .filter((x) => x.numericHits >= 3)
          .sort((a, b) => b.numericHits - a.numericHits)
          .slice(0, 2);

        if (best.currentCol == null && topNumericCols[0]) best.currentCol = topNumericCols[0].col;
        if (best.previousCol == null && topNumericCols[1]) best.previousCol = topNumericCols[1].col;

        if (best.currentCol != null && best.previousCol != null && !best.detectedYears.length) {
          best.allYearCols = [best.currentCol, best.previousCol];
        }
      }

      // note col fallback
      if (best.noteCol == null) {
        for (let i = 0; i < Math.min(rows.length, 4); i += 1) {
          const cells = rows[i].cells || [];
          for (let c = 0; c < cells.length; c += 1) {
            if (isNoteCell(cells[c])) best.noteCol = c;
          }
        }
      }

      // label column fallback: prefer far-right non-year/non-note col with text
      let labelCol = null;
      for (let c = maxCols - 1; c >= 0; c -= 1) {
        if (c === best.currentCol || c === best.previousCol || c === best.noteCol) continue;
        let textHits = 0;
        for (let r = 0; r < rows.length; r += 1) {
          const cell = String(rows[r].cells[c] || "").trim();
          if (!cell) continue;
          if (!isNumericLikeCell(cell) && !isYearCell(cell)) textHits += 1;
        }
        if (textHits >= 2) {
          labelCol = c;
          break;
        }
      }
      best.labelCol = labelCol != null ? labelCol : Math.max(0, maxCols - 1);

      // ensure current/previous aligned left-to-right visually but latest year stays current
      if (best.detectedYears.length >= 2) {
        const yearColPairs = [
          { year: best.detectedYears[0], col: best.currentCol },
          { year: best.detectedYears[1], col: best.previousCol }
        ].filter((x) => x.col != null);

        yearColPairs.sort((a, b) => b.year - a.year);
        best.currentCol = yearColPairs[0] ? yearColPairs[0].col : best.currentCol;
        best.previousCol = yearColPairs[1] ? yearColPairs[1].col : best.previousCol;
      }

      return best;
    }

    function rowNumericCount(cells) {
      let c = 0;
      for (const cell of (cells || [])) {
        if (isNumericLikeCell(cell)) c += 1;
      }
      return c;
    }

    function dedupeItems(items) {
      const dedupMap = new Map();

      for (const row of items || []) {
        const key = normalizeText(row.label);
        if (!key) continue;

        if (!dedupMap.has(key)) {
          dedupMap.set(key, row);
        } else {
          const oldRow = dedupMap.get(key);
          const oldScore = (oldRow.current != null ? 1 : 0) + (oldRow.previous != null ? 1 : 0);
          const newScore = (row.current != null ? 1 : 0) + (row.previous != null ? 1 : 0);
          if (newScore > oldScore) dedupMap.set(key, row);
        }
      }

      return Array.from(dedupMap.values());
    }

    function extractStatementItemsFromTable(pageCtx, statementKey) {
      const mainRowsMeta = Array.isArray(pageCtx?.mainRowsMeta) ? pageCtx.mainRowsMeta : [];
      if (!mainRowsMeta.length) return { items: [], latest: null, previous: null, years: [] };

      const detected = detectStatementColumns(mainRowsMeta);
      const items = [];
      const startRow = detected.headerRowIndex != null ? detected.headerRowIndex + 1 : 0;

      for (let i = startRow; i < mainRowsMeta.length; i += 1) {
        const row = mainRowsMeta[i];
        const cells = row.cells || [];
        if (!cells.length) continue;

        const numericCellsInRow = rowNumericCount(cells);
        if (numericCellsInRow === 0) continue;

        const labelCell =
          detected.labelCol != null && cells[detected.labelCol] != null
            ? cells[detected.labelCol]
            : cells[cells.length - 1];

        const label = String(labelCell || "").trim();
        if (!looksLikeFinancialRowLabel(label, statementKey)) continue;

        const currentRaw =
          detected.currentCol != null && cells[detected.currentCol] != null
            ? cells[detected.currentCol]
            : null;

        const previousRaw =
          detected.previousCol != null && cells[detected.previousCol] != null
            ? cells[detected.previousCol]
            : null;

        const current = parseNumberSmart(currentRaw);
        const previous = parseNumberSmart(previousRaw);

        if (current == null && previous == null) continue;

        const note =
          detected.noteCol != null && cells[detected.noteCol] != null
            ? String(cells[detected.noteCol] || "").trim()
            : null;

        items.push({
          label,
          current,
          previous,
          note: note || null
        });
      }

      const deduped = dedupeItems(items).slice(0, 200);

      return {
        items: deduped,
        latest: detected.detectedYears[0] || pageCtx?.years?.[0] || null,
        previous: detected.detectedYears[1] || pageCtx?.years?.[1] || null,
        years: detected.detectedYears.length ? detected.detectedYears : (pageCtx?.years || []),
        detectedColumns: detected
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
          rawLinesCount: 0
        };
      }

      const pageCtx = pageContexts.find((p) => p.pageNumber === pageNumber);
      const tableBased = extractStatementItemsFromTable(pageCtx, statementKey);

      return {
        pageNumber,
        latest: tableBased.latest,
        previous: tableBased.previous,
        years: tableBased.years,
        items: tableBased.items,
        rawLinesCount: Array.isArray(pageCtx?.mainRowsMeta) ? pageCtx.mainRowsMeta.length : 0,
        extractionMeta: {
          currentCol: tableBased.detectedColumns?.currentCol ?? null,
          previousCol: tableBased.detectedColumns?.previousCol ?? null,
          noteCol: tableBased.detectedColumns?.noteCol ?? null,
          labelCol: tableBased.detectedColumns?.labelCol ?? null,
          headerRowIndex: tableBased.detectedColumns?.headerRowIndex ?? null
        }
      };
    }

    const incomeStatementLite = extractStatementLite(chosen.incomePage, "income");
    const balanceSheetLite = extractStatementLite(chosen.balancePage, "balance");
    const cashFlowLite = extractStatementLite(chosen.cashFlowPage, "cashflow");

    // =========================
    // Structured Extraction Layer
    // =========================

    const FIELD_DICTIONARIES = {
      balance: {
        cashAndBalancesWithCentralBanks: [
          "نقد وارصده لدي البنوك المركزيه",
          "نقد وارصدة لدى البنوك المركزية",
          "cash and balances with central banks"
        ],
        dueFromBanksAndFinancialInstitutions: [
          "ارصده لدي البنوك والمؤسسات الماليه الاخري بالصافي",
          "أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي",
          "balances with banks and other financial institutions"
        ],
        investments: [
          "استثمارات بالصافي",
          "investments"
        ],
        financingAndAdvances: [
          "تمويل وسلف بالصافي",
          "financing and advances"
        ],
        positiveFairValueDerivatives: [
          "القيمه العادله الموجبه للمشتقات",
          "القيمة العادلة الموجبة للمشتقات",
          "positive fair value of derivatives"
        ],
        propertyAndEquipment: [
          "ممتلكات ومعدات وبرامج بالصافي",
          "property and equipment"
        ],
        rightOfUseAssets: [
          "حق استخدام الموجودات بالصافي",
          "right of use assets"
        ],
        otherAssets: [
          "موجودات اخري",
          "other assets"
        ],
        totalAssets: [
          "اجمالي الموجودات",
          "اجمالي الاصول",
          "total assets"
        ],
        dueToBanks: [
          "ارصده للبنوك والبنوك المركزيه والمؤسسات الماليه الاخري",
          "أرصدة للبنوك والبنوك المركزية والمؤسسات المالية الأخرى",
          "due to banks"
        ],
        customerDeposits: [
          "ودايع العملاء",
          "ودائع العملاء",
          "customer deposits"
        ],
        debtSecuritiesIssuedAndBorrowings: [
          "صكوك وسندات دين مصدره وقروض لاجل",
          "صكوك وسندات دين مصدرة وقروض لأجل",
          "debt securities"
        ],
        negativeFairValueDerivatives: [
          "القيمه العادله السالبه للمشتقات",
          "القيمة العادلة السالبة للمشتقات",
          "negative fair value of derivatives"
        ],
        otherLiabilities: [
          "مطلوبات اخري",
          "other liabilities"
        ],
        totalLiabilities: [
          "اجمالي المطلوبات",
          "total liabilities"
        ],
        totalEquityAttributedToShareholders: [
          "حقوق الملكيه العائده لمساهمي البنك",
          "حقوق الملكية العائدة لمساهمي البنك"
        ],
        totalEquity: [
          "اجمالي حقوق الملكيه",
          "إجمالي حقوق الملكية",
          "total equity"
        ],
        totalLiabilitiesAndEquity: [
          "اجمالي المطلوبات وحقوق الملكيه",
          "إجمالي المطلوبات وحقوق الملكية",
          "total liabilities and equity"
        ]
      },

      income: {
        specialCommissionIncome: [
          "الدخل من التمويل والاستثمارات"
        ],
        specialCommissionExpense: [
          "المصاريف علي ودائع العملاء لاجل والبنوك والمؤسسات الماليه الاخري",
          "المصاريف على ودائع العملاء لأجل والبنوك والمؤسسات المالية الأخرى"
        ],
        netSpecialCommissionIncome: [
          "الدخل من التمويل والاستثمارات بالصافي"
        ],
        feeAndCommissionIncomeNet: [
          "الدخل من رسوم الخدمات المصرفيه بالصافي",
          "الدخل من رسوم الخدمات المصرفية بالصافي"
        ],
        totalOperatingIncome: [
          "اجمالي دخل العمليات التشغيليه",
          "إجمالي دخل العمليات التشغيلية"
        ],
        employeeSalariesAndBenefits: [
          "رواتب ومصاريف الموظفين"
        ],
        depreciationAndAmortization: [
          "اهلاك اطفاء ممتلكات ومعدات وبرامج وحق استخدام الموجودات",
          "إهلاك/إطفاء ممتلكات ومعدات وبرامج وحق استخدام الموجودات"
        ],
        impairmentChargeForExpectedCreditLosses: [
          "مخصص الانخفاض الاسترداد لخساير الائتمان المتوقعه بالصافي",
          "مخصص الانخفاض/(الاسترداد) لخسائر الائتمان المتوقعة بالصافي"
        ],
        totalOperatingExpenses: [
          "اجمالي مصاريف العمليات التشغيليه",
          "إجمالي مصاريف العمليات التشغيلية"
        ],
        operatingIncomeNet: [
          "دخل من العمليات التشغيليه بالصافي",
          "دخل من العمليات التشغيلية بالصافي"
        ],
        netIncomeBeforeZakatAndIncomeTax: [
          "دخل السنه قبل الزكاه وضريبه الدخل",
          "دخل السنة قبل الزكاة وضريبة الدخل"
        ],
        zakatAndIncomeTax: [
          "مصروف الزكاه وضريبه الدخل",
          "مصروف الزكاة وضريبة الدخل"
        ],
        netIncome: [
          "صافي دخل السنه",
          "صافي الدخل"
        ],
        basicEps: [
          "ربحيه السهم الاساسيه",
          "ربحية السهم الأساسية"
        ],
        dilutedEps: [
          "ربحيه السهم المخفضه",
          "ربحية السهم المخفضة"
        ]
      },

      cashflow: {
        netIncomeBeforeZakatAndIncomeTax: [
          "دخل السنه قبل الزكاه وضريبه الدخل",
          "دخل السنة قبل الزكاة وضريبة الدخل"
        ],
        netCashFromOperatingActivities: [
          "صافي النقد الناتج من المستخدم في الانشطه التشغيليه",
          "صافي النقد الناتج من الانشطة التشغيلية",
          "صافي النقد الناتج من الانشطة التشغيليه"
        ],
        netCashFromInvestingActivities: [
          "صافي النقد الناتج من المستخدم في الانشطه الاستثماريه",
          "صافي النقد المستخدم في الانشطة الاستثمارية",
          "صافي النقد المستخدم في الانشطة الاستثماريه"
        ],
        netCashFromFinancingActivities: [
          "صافي النقد الناتج من المستخدم في الانشطه التمويليه",
          "صافي النقد الناتج من الانشطة التمويلية",
          "صافي النقد الناتج من الانشطة التمويليه"
        ],
        netChangeInCashAndCashEquivalents: [
          "صافي الزياده النقص في النقد وشبه النقد",
          "صافي الزيادة/(النقص) في النقد وشبه النقد"
        ],
        cashAndCashEquivalentsAtBeginningOfYear: [
          "النقد وشبه النقد في بدايه السنه",
          "النقد وشبه النقد في بداية السنة"
        ],
        cashAndCashEquivalentsAtEndOfYear: [
          "النقد وشبه النقد في نهايه السنه",
          "النقد وشبه النقد في نهاية السنة"
        ]
      }
    };

    function scoreLabelMatch(label, synonym) {
      const a = normalizeText(label);
      const b = normalizeText(synonym);
      if (!a || !b) return 0;
      if (a === b) return 1.0;
      if (a.includes(b) || b.includes(a)) return 0.92;

      const aTokens = unique(a.split(/\s+/).filter(Boolean));
      const bTokens = unique(b.split(/\s+/).filter(Boolean));
      if (!aTokens.length || !bTokens.length) return 0;

      let hits = 0;
      for (const token of bTokens) {
        if (token.length < 2) continue;
        if (a.includes(token)) hits += 1;
      }
      return hits / bTokens.length;
    }

    function bestSynonymScore(label, synonyms) {
      let best = 0;
      let matched = null;
      for (const syn of (synonyms || [])) {
        const s = scoreLabelMatch(label, syn);
        if (s > best) {
          best = s;
          matched = syn;
        }
      }
      return { score: best, matchedSynonym: matched };
    }

    function buildStructuredFieldsFromLite(lite, dictionary) {
      const fields = {};
      const items = Array.isArray(lite?.items) ? lite.items : [];

      for (const [fieldKey, synonyms] of Object.entries(dictionary || {})) {
        let bestRow = null;
        let bestScore = 0;
        let matchedSynonym = null;

        for (const row of items) {
          const result = bestSynonymScore(row.label, synonyms);
          if (result.score > bestScore) {
            bestScore = result.score;
            bestRow = row;
            matchedSynonym = result.matchedSynonym;
          }
        }

        if (bestRow && bestScore >= 0.55) {
          fields[fieldKey] = {
            label: bestRow.label,
            matchedSynonym,
            current: bestRow.current ?? null,
            previous: bestRow.previous ?? null,
            confidence: Math.round(bestScore * 1000) / 1000,
            sourcePage: lite.pageNumber || null,
            note: bestRow.note || null
          };
        } else {
          fields[fieldKey] = {
            label: null,
            matchedSynonym: null,
            current: null,
            previous: null,
            confidence: 0,
            sourcePage: lite.pageNumber || null,
            note: null
          };
        }
      }

      return fields;
    }

    function buildStructuredStatement(pageNumber, lite, dictionary) {
      return {
        pageNumber: pageNumber || null,
        latest: lite?.latest ?? null,
        previous: lite?.previous ?? null,
        years: Array.isArray(lite?.years) ? lite.years : [],
        fields: buildStructuredFieldsFromLite(lite, dictionary)
      };
    }

    const balanceSheetStructured = buildStructuredStatement(
      chosen.balancePage,
      balanceSheetLite,
      FIELD_DICTIONARIES.balance
    );

    const incomeStatementStructured = buildStructuredStatement(
      chosen.incomePage,
      incomeStatementLite,
      FIELD_DICTIONARIES.income
    );

    const cashFlowStructured = buildStructuredStatement(
      chosen.cashFlowPage,
      cashFlowLite,
      FIELD_DICTIONARIES.cashflow
    );

    // =========================
    // Debug
    // =========================

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
        isLikelyNoteTable: r.isLikelyNoteTable,
        hasStatementHeader: r.hasStatementHeader
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v3.2",
      phase: "3B",
      fileName: body.fileName || normalized?.meta?.fileName || null,

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
        ranking: {
          balanceTop: topN(rankedBalanceBase, 5),
          incomeTop: topN(rankedIncomeBase, 5),
          cashFlowTop: topN(rankedCashBase, 5)
        },
        chosen,
        notes: [
          "selection logic uses title + keywords + numeric density + report order",
          "statement-like tables are preferred when main columns are 2-4",
          "wide note tables are penalized heavily",
          "explicit statement headers get a strong boost",
          "lite extraction uses table rows instead of free-text lines",
          "v3.2 improves year-column detection and skips title-only rows"
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
