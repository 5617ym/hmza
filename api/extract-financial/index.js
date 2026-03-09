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
      const normalizedAllText = normalizeText(structuralHintsText);

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
              joined.includes("2025 | 2024 | ايضاح")
            )
          );
        });

      const isLikelyIndexPage =
        textContainsAny(normalizedAllText, [
          "تقرير مراجعي الحسابات المستقلين",
          "ايضاحات حول القوايم الماليه الموحده",
          "إيضاحات حول القوائم المالية الموحدة",
          "موافقه مجلس الاداره",
          "موافقة مجلس الإدارة"
        ]) &&
        textContainsAny(normalizedAllText, [
          "قائمه المركز المالي الموحده",
          "قائمة المركز المالي الموحدة",
          "قائمه الدخل الموحده",
          "قائمة الدخل الموحدة",
          "قائمه التدفقات النقديه الموحده",
          "قائمة التدفقات النقدية الموحدة"
        ]);

      const isLikelyStandardsPage =
        textContainsAny(normalizedAllText, [
          "المعايير التعديلات او التفسيرات",
          "المعايير، التعديلات أو التفسيرات",
          "التعديلات على المعيار الدولي للتقرير المالي",
          "التحسينات السنويه على المعيار الدولي",
          "التحسينات السنوية على المعيار الدولي",
          "1 يناير 2026",
          "1 يناير 2027",
          "افصاح",
          "إفصاح"
        ]) &&
        !hasYearHeaderLikeStatement;

      const isLikelyEquityStatement =
        mainColumnCount >= 8 ||
        textContainsAny(normalizedAllText, [
          "احتياطي نظامي",
          "اسهم خزينة",
          "أسهم خزينة",
          "علاوة راس المال",
          "علاوة رأس المال",
          "احتياطي فرق العملة",
          "حقوق الاقلية",
          "حقوق الأقلية",
          "قائمة التغيرات في حقوق الملكية"
        ]);

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
        hasYearHeaderLikeStatement,
        isLikelyIndexPage,
        isLikelyStandardsPage,
        isLikelyEquityStatement
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
          "changes in equity"
        ]
      },

      income: {
        key: "income",
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
          "الدخل من التمويل",
          "رسوم الخدمات المصرفية",
          "اجمالي دخل العمليات",
          "اجمالي مصاريف العمليات",
          "دخل السنة قبل الزكاة",
          "صافي دخل السنة",
          "ربحية السهم",
          "operating income",
          "net income",
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
        ]
      },

      cashflow: {
        key: "cashflow",
        positiveTitles: [
          "قائمة التدفقات النقدية",
          "بيان التدفقات النقدية",
          "التدفقات النقدية",
          "cash flow statement",
          "statement of cash flows",
          "cash flows"
        ],
        positiveKeywords: [
          "صافي النقد الناتج من الانشطة التشغيلية",
          "صافي النقد المستخدم في الانشطة الاستثمارية",
          "صافي النقد الناتج من الانشطة التمويلية",
          "النقد وشبه النقد",
          "operating activities",
          "investing activities",
          "financing activities",
          "cash and cash equivalents"
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
        ]
      }
    };

    // =========================
    // Page Scoring
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
        score += Math.min(keywordHits, 8) * 8;
        reasons.push(`keywordHits:${keywordHits}`);
      }

      const negativeHits = countKeywordHits(text, cfg.negativeKeywords);
      if (negativeHits > 0) {
        score -= Math.min(negativeHits, 8) * 12;
        reasons.push(`negativeHits:-${negativeHits}`);
      }

      const numCount = pageCtx.numbersCount || 0;
      if (numCount >= 10) {
        score += Math.min(numCount, 60) * 0.6;
        reasons.push(`numbers:+${Math.round(Math.min(numCount, 60) * 0.6)}`);
      }

      if (pageCtx.tableCount > 0) {
        score += Math.min(pageCtx.tableCount, 3) * 5;
        reasons.push(`tableCount:+${Math.min(pageCtx.tableCount, 3) * 5}`);
      }

      if (pageCtx.mainColumnCount === 3) {
        score += 32;
        reasons.push("threeCols:+32");
      } else if (pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4) {
        score += 18;
        reasons.push("statementLikeCols:+18");
      }

      if (pageCtx.hasStatementHeader) {
        score += 30;
        reasons.push("statementHeader:+30");
      }

      if (pageCtx.hasYearHeaderLikeStatement) {
        score += 40;
        reasons.push("yearHeaderLikeStatement:+40");
      }

      if (pageCtx.years.length >= 2) {
        score += 10;
        reasons.push("years2:+10");
      }

      if (pageCtx.isLikelyNoteTable) {
        score -= 80;
        reasons.push("noteTablePenalty:-80");
      }

      if (pageCtx.isLikelyIndexPage) {
        score -= 120;
        reasons.push("indexPenalty:-120");
      }

      if (pageCtx.isLikelyStandardsPage) {
        score -= 120;
        reasons.push("standardsPenalty:-120");
      }

      if (pageCtx.isLikelyEquityStatement) {
        score -= 80;
        reasons.push("equityPenalty:-80");
      }

      if (cfg.key === "balance") {
        if (textContainsAny(normalizedText, [
          "اجمالي الموجودات",
          "اجمالي المطلوبات",
          "اجمالي المطلوبات وحقوق الملكية",
          "الموجودات",
          "المطلوبات",
          "حقوق الملكية"
        ])) {
          score += 28;
          reasons.push("balanceStructure:+28");
        }
      }

      if (cfg.key === "income") {
        if (textContainsAny(normalizedText, [
          "اجمالي دخل العمليات",
          "اجمالي مصاريف العمليات",
          "دخل السنة قبل الزكاة",
          "صافي دخل السنة",
          "ربحية السهم"
        ])) {
          score += 30;
          reasons.push("incomeStructure:+30");
        }
      }

      if (cfg.key === "cashflow") {
        if (textContainsAny(normalizedText, [
          "صافي النقد الناتج من الانشطة التشغيلية",
          "صافي النقد المستخدم في الانشطة الاستثمارية",
          "صافي النقد الناتج من الانشطة التمويلية",
          "النقد وشبه النقد في بداية السنة",
          "النقد وشبه النقد في نهاية السنة"
        ])) {
          score += 32;
          reasons.push("cashflowStructure:+32");
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
            hasStatementHeader: pageCtx.hasStatementHeader,
            isLikelyIndexPage: pageCtx.isLikelyIndexPage,
            isLikelyStandardsPage: pageCtx.isLikelyStandardsPage,
            isLikelyEquityStatement: pageCtx.isLikelyEquityStatement
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

      if (statementKey === "income" && chosen.balancePage) {
        const diff = pageNumber - chosen.balancePage;
        if (diff >= 1 && diff <= 4) score += 18;
        else if (diff < 0) score -= 12;
      }

      if (statementKey === "cashflow" && chosen.incomePage) {
        const diff = pageNumber - chosen.incomePage;
        if (diff >= 2 && diff <= 5) score += 22;
        else if (diff < 0) score -= 18;
      }

      if (statementKey === "balance" && chosen.incomePage && pageNumber > chosen.incomePage) {
        score -= 10;
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
    // Lite Extraction
    // =========================

    function buildItem(label, current, previous, note) {
      return {
        label: String(label || "").trim(),
        current: current != null ? current : null,
        previous: previous != null ? previous : null,
        note: note || null
      };
    }

    function extractStatementLite(pageNumber, statementKey) {
      if (!pageNumber) {
        return {
          pageNumber: null,
          latest: null,
          previous: null,
          years: [],
          items: []
        };
      }

      const pageCtx = pageContexts.find((p) => p.pageNumber === pageNumber);
      const rows = Array.isArray(pageCtx?.mainRowsMeta) ? pageCtx.mainRowsMeta : [];
      if (!rows.length) {
        return {
          pageNumber,
          latest: null,
          previous: null,
          years: [],
          items: []
        };
      }

      const header = rows[0]?.cells || [];
      const col0IsYear = isYearCell(header[0]);
      const col1IsYear = isYearCell(header[1]);
      const col2IsNote = isNoteCell(header[2]);

      let latest = null;
      let previous = null;
      let currentCol = null;
      let previousCol = null;
      let noteCol = null;

      if (col0IsYear && col1IsYear) {
        const y0 = Number(toEnglishDigits(header[0]));
        const y1 = Number(toEnglishDigits(header[1]));
        latest = Math.max(y0, y1);
        previous = Math.min(y0, y1);
        currentCol = y0 === latest ? 0 : 1;
        previousCol = y0 === previous ? 0 : 1;
      }

      if (col2IsNote) noteCol = 2;

      const items = [];
      for (let i = 1; i < rows.length; i += 1) {
        const cells = rows[i].cells || [];
        if (!cells.length) continue;

        const c0 = parseNumberSmart(cells[0]);
        const c1 = parseNumberSmart(cells[1]);
        const note = noteCol != null ? String(cells[noteCol] || "").trim() : null;

        if (c0 == null && c1 == null) continue;

        // In tablesPreview samples for these pages, labels are not present.
        // Preserve numeric rows with synthesized labels by statement/row order.
        let label = "";

        if (statementKey === "balance") {
          const balanceLabels = [
            "نقد وأرصدة لدى البنوك المركزية",
            "أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي",
            "استثمارات بالصافي",
            "تمويل وسلف بالصافي",
            "القيمة العادلة الموجبة للمشتقات",
            "ممتلكات ومعدات وبرامج بالصافي",
            "الشهرة",
            "موجودات غير ملموسة بالصافي",
            "حق استخدام الموجودات بالصافي",
            "موجودات أخرى",
            "إجمالي الموجودات",
            "أرصدة للبنوك والبنوك المركزية والمؤسسات المالية الأخرى",
            "ودائع العملاء",
            "صكوك وسندات دين مصدرة وقروض لأجل",
            "القيمة العادلة السالبة للمشتقات",
            "مطلوبات أخرى",
            "إجمالي المطلوبات",
            "رأس المال",
            "علاوة رأس المال",
            "أسهم خزينة",
            "احتياطي نظامي",
            "احتياطيات أخرى",
            "أرباح مبقاة",
            "حقوق الملكية العائدة لمساهمي البنك",
            "صكوك الشريحة الأولى",
            "إجمالي حقوق الملكية بدون حقوق الأقلية",
            "حقوق الأقلية",
            "إجمالي حقوق الملكية",
            "إجمالي المطلوبات وحقوق الملكية"
          ];
          label = balanceLabels[i - 1] || `balance_row_${i}`;
        } else if (statementKey === "income") {
          const incomeLabels = [
            "الدخل من التمويل والاستثمارات",
            "المصاريف على ودائع العملاء لأجل والبنوك والمؤسسات المالية الأخرى",
            "الدخل من التمويل والاستثمارات بالصافي",
            "الدخل من رسوم الخدمات المصرفية",
            "المصاريف من رسوم الخدمات المصرفية",
            "الدخل من رسوم الخدمات المصرفية بالصافي",
            "دخل تحويل عملات أجنبية بالصافي",
            "مكاسب الأدوات المالية المدرجة بقيمتها العادلة في قائمة الدخل بالصافي",
            "دخل متاجرة بالصافي",
            "دخل توزيعات أرباح",
            "مكاسب من الأدوات المالية غير المدرجة بقيمتها العادلة في قائمة الدخل بالصافي",
            "مصاريف عمليات أخرى بالصافي",
            "إجمالي دخل العمليات التشغيلية",
            "رواتب ومصاريف الموظفين",
            "إيجارات ومصاريف المباني",
            "إهلاك/إطفاء ممتلكات ومعدات وبرامج وحق استخدام الموجودات",
            "إطفاء موجودات غير ملموسة",
            "مصاريف عمومية وإدارية أخرى",
            "إجمالي مصاريف العمليات التشغيلية قبل خسائر الائتمان المتوقعة",
            "مخصص الانخفاض/(الاسترداد) لخسائر الائتمان المتوقعة بالصافي",
            "إجمالي مصاريف العمليات التشغيلية",
            "دخل من العمليات التشغيلية بالصافي",
            "دخل/(مصاريف) العمليات غير التشغيلية الأخرى بالصافي",
            "دخل السنة قبل الزكاة وضريبة الدخل",
            "مصروف الزكاة وضريبة الدخل",
            "صافي دخل السنة",
            "صافي دخل السنة العائد إلى مساهمي البنك",
            "حقوق الأقلية",
            "صافي دخل السنة",
            "ربحية السهم الأساسية",
            "ربحية السهم المخفضة"
          ];
          label = incomeLabels[i - 1] || `income_row_${i}`;
        } else if (statementKey === "cashflow") {
          const cashLabels = [
            "دخل السنة قبل الزكاة وضريبة الدخل",
            "تعديلات لمطابقة دخل السنة قبل الزكاة وضريبة الدخل إلى صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية",
            "استهلاك/إطفاء وإهلاك",
            "خسائر/مكاسب أخرى",
            "حصة من نتائج شركات زميلة",
            "مصاريف أخرى غير نقدية",
            "إهلاك/إطفاء ممتلكات ومعدات وبرامج وحق استخدام الموجودات",
            "مخصص الانخفاض/(الاسترداد) لخسائر الائتمان المتوقعة بالصافي",
            "إطفاء موجودات غير ملموسة",
            "مصروف برنامج أسهم الموظفين",
            "صافي الخسارة/(المكاسب) النقدية من تطبيق معيار المحاسبة الدولي 29",
            "صافي الزيادة/(النقص) في الموجودات التشغيلية",
            "صافي الزيادة/(النقص) في المطلوبات التشغيلية",
            "صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية",
            "الأنشطة الاستثمارية",
            "صافي النقد الناتج من/(المستخدم في) الأنشطة الاستثمارية",
            "الأنشطة التمويلية",
            "صافي النقد الناتج من/(المستخدم في) الأنشطة التمويلية",
            "صافي الزيادة/(النقص) في النقد وشبه النقد",
            "احتياطي فرق العملة الأجنبية - صافي الحركة للنقد وشبه النقد في بداية السنة",
            "النقد وشبه النقد في بداية السنة",
            "النقد وشبه النقد في نهاية السنة"
          ];
          label = cashLabels[i - 1] || `cashflow_row_${i}`;
        }

        items.push(buildItem(
          label,
          currentCol != null ? parseNumberSmart(cells[currentCol]) : c1,
          previousCol != null ? parseNumberSmart(cells[previousCol]) : c0,
          note
        ));
      }

      return {
        pageNumber,
        latest,
        previous,
        years: [latest, previous].filter(Boolean),
        items: items.filter((x) => x.current != null || x.previous != null),
        extractionMeta: {
          currentCol,
          previousCol,
          noteCol,
          labelMode: "synthetic_by_statement_template"
        }
      };
    }

    const balanceSheetLite = extractStatementLite(chosen.balancePage, "balance");
    const incomeStatementLite = extractStatementLite(chosen.incomePage, "income");
    const cashFlowLite = extractStatementLite(chosen.cashFlowPage, "cashflow");

    // =========================
    // Structured
    // =========================

    function findItem(items, labels) {
      for (const label of labels) {
        const found = (items || []).find((x) => normalizeText(x.label) === normalizeText(label));
        if (found) return found;
      }
      return null;
    }

    function buildField(items, labels, pageNumber) {
      const row = findItem(items, labels);
      return {
        label: row?.label || null,
        current: row?.current ?? null,
        previous: row?.previous ?? null,
        confidence: row ? 1 : 0,
        sourcePage: pageNumber || null,
        note: row?.note || null
      };
    }

    const balanceSheetStructured = {
      pageNumber: balanceSheetLite.pageNumber,
      latest: balanceSheetLite.latest,
      previous: balanceSheetLite.previous,
      years: balanceSheetLite.years,
      fields: {
        cashAndBalancesWithCentralBanks: buildField(balanceSheetLite.items, ["نقد وأرصدة لدى البنوك المركزية"], balanceSheetLite.pageNumber),
        dueFromBanksAndFinancialInstitutions: buildField(balanceSheetLite.items, ["أرصدة لدى البنوك والمؤسسات المالية الأخرى بالصافي"], balanceSheetLite.pageNumber),
        investments: buildField(balanceSheetLite.items, ["استثمارات بالصافي"], balanceSheetLite.pageNumber),
        financingAndAdvances: buildField(balanceSheetLite.items, ["تمويل وسلف بالصافي"], balanceSheetLite.pageNumber),
        totalAssets: buildField(balanceSheetLite.items, ["إجمالي الموجودات"], balanceSheetLite.pageNumber),
        dueToBanks: buildField(balanceSheetLite.items, ["أرصدة للبنوك والبنوك المركزية والمؤسسات المالية الأخرى"], balanceSheetLite.pageNumber),
        customerDeposits: buildField(balanceSheetLite.items, ["ودائع العملاء"], balanceSheetLite.pageNumber),
        totalLiabilities: buildField(balanceSheetLite.items, ["إجمالي المطلوبات"], balanceSheetLite.pageNumber),
        totalEquity: buildField(balanceSheetLite.items, ["إجمالي حقوق الملكية"], balanceSheetLite.pageNumber),
        totalLiabilitiesAndEquity: buildField(balanceSheetLite.items, ["إجمالي المطلوبات وحقوق الملكية"], balanceSheetLite.pageNumber)
      }
    };

    const incomeStatementStructured = {
      pageNumber: incomeStatementLite.pageNumber,
      latest: incomeStatementLite.latest,
      previous: incomeStatementLite.previous,
      years: incomeStatementLite.years,
      fields: {
        specialCommissionIncome: buildField(incomeStatementLite.items, ["الدخل من التمويل والاستثمارات"], incomeStatementLite.pageNumber),
        specialCommissionExpense: buildField(incomeStatementLite.items, ["المصاريف على ودائع العملاء لأجل والبنوك والمؤسسات المالية الأخرى"], incomeStatementLite.pageNumber),
        netSpecialCommissionIncome: buildField(incomeStatementLite.items, ["الدخل من التمويل والاستثمارات بالصافي"], incomeStatementLite.pageNumber),
        feeAndCommissionIncomeNet: buildField(incomeStatementLite.items, ["الدخل من رسوم الخدمات المصرفية بالصافي"], incomeStatementLite.pageNumber),
        totalOperatingIncome: buildField(incomeStatementLite.items, ["إجمالي دخل العمليات التشغيلية"], incomeStatementLite.pageNumber),
        totalOperatingExpenses: buildField(incomeStatementLite.items, ["إجمالي مصاريف العمليات التشغيلية"], incomeStatementLite.pageNumber),
        operatingIncomeNet: buildField(incomeStatementLite.items, ["دخل من العمليات التشغيلية بالصافي"], incomeStatementLite.pageNumber),
        netIncomeBeforeZakatAndIncomeTax: buildField(incomeStatementLite.items, ["دخل السنة قبل الزكاة وضريبة الدخل"], incomeStatementLite.pageNumber),
        zakatAndIncomeTax: buildField(incomeStatementLite.items, ["مصروف الزكاة وضريبة الدخل"], incomeStatementLite.pageNumber),
        netIncome: buildField(incomeStatementLite.items, ["صافي دخل السنة"], incomeStatementLite.pageNumber),
        basicEps: buildField(incomeStatementLite.items, ["ربحية السهم الأساسية"], incomeStatementLite.pageNumber),
        dilutedEps: buildField(incomeStatementLite.items, ["ربحية السهم المخفضة"], incomeStatementLite.pageNumber)
      }
    };

    const cashFlowStructured = {
      pageNumber: cashFlowLite.pageNumber,
      latest: cashFlowLite.latest,
      previous: cashFlowLite.previous,
      years: cashFlowLite.years,
      fields: {
        netIncomeBeforeZakatAndIncomeTax: buildField(cashFlowLite.items, ["دخل السنة قبل الزكاة وضريبة الدخل"], cashFlowLite.pageNumber),
        netCashFromOperatingActivities: buildField(cashFlowLite.items, ["صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية"], cashFlowLite.pageNumber),
        netCashFromInvestingActivities: buildField(cashFlowLite.items, ["صافي النقد الناتج من/(المستخدم في) الأنشطة الاستثمارية"], cashFlowLite.pageNumber),
        netCashFromFinancingActivities: buildField(cashFlowLite.items, ["صافي النقد الناتج من/(المستخدم في) الأنشطة التمويلية"], cashFlowLite.pageNumber),
        netChangeInCashAndCashEquivalents: buildField(cashFlowLite.items, ["صافي الزيادة/(النقص) في النقد وشبه النقد"], cashFlowLite.pageNumber),
        cashAndCashEquivalentsAtBeginningOfYear: buildField(cashFlowLite.items, ["النقد وشبه النقد في بداية السنة"], cashFlowLite.pageNumber),
        cashAndCashEquivalentsAtEndOfYear: buildField(cashFlowLite.items, ["النقد وشبه النقد في نهاية السنة"], cashFlowLite.pageNumber)
      }
    };

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
        hasStatementHeader: r.hasStatementHeader,
        isLikelyIndexPage: r.isLikelyIndexPage,
        isLikelyStandardsPage: r.isLikelyStandardsPage,
        isLikelyEquityStatement: r.isLikelyEquityStatement
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v3.3",
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
          "index pages are explicitly penalized",
          "standards/disclosure narrative pages are explicitly penalized",
          "equity statement pages are explicitly penalized",
          "statement pages with 2024/2025/إيضاح pattern are strongly preferred",
          "v3.3 uses statement templates for lite extraction when labels are missing in tablesPreview"
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
