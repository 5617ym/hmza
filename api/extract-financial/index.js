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
        .replace(/[\u064B-\u065F\u0670]/g, "") // remove arabic diacritics
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

      // handle common Arabic/financial formatting
      const hasDot = s.includes(".");
      const hasComma = s.includes(",");

      if (hasDot && hasComma) {
        // choose last separator as decimal separator if decimal-like
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
        .join("\n");
    }

    function getTablesForPage(pageNumber) {
      return tablesPreview.filter((t) => pageNumFromObj(t) === pageNumber);
    }

    function buildPageContext(pageNumber) {
      const pageMeta = pages.find((p) => safeNumber(p.pageNumber) === pageNumber) || {};
      const pageTables = getTablesForPage(pageNumber);

      const mergedTableText = pageTables.map(tableText).join("\n\n");
      const mergedText = mergedTableText;

      const numbersCount = countNumbers(mergedText);
      const years = extractYears(mergedText);

      const rowCount = pageTables.reduce((sum, t) => {
        return sum + safeNumber(
          t?.rowCount ??
          t?.rows ??
          t?.nRows ??
          0
        );
      }, 0);

      const columnCount = pageTables.reduce((sum, t) => {
        return sum + safeNumber(
          t?.columnCount ??
          t?.columns ??
          t?.nCols ??
          0
        );
      }, 0);

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
        tableCount: pageTables.length
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
        ],
        preferredOrderIndex: 0
      },

      income: {
        key: "income",
        title: "incomeStatement",
        positiveTitles: [
          "قائمة الدخل",
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
          "ربح السهم",
          "revenue",
          "sales",
          "gross profit",
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
          "النقد الناتج من الانشطة التشغيلية",
          "النقد المستخدم في الانشطة الاستثمارية",
          "النقد الناتج من الانشطة التمويلية",
          "رصيد النقد",
          "النقد وما في حكمه",
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
      const normalizedText = pageCtx.normalizedText || "";

      let score = 0;
      const reasons = [];

      // 1) exact/near title score
      const titleHits = countKeywordHits(text, cfg.positiveTitles);
      if (titleHits > 0) {
        score += titleHits * 40;
        reasons.push(`titleHits:${titleHits}`);
      }

      // 2) content keywords score
      const keywordHits = countKeywordHits(text, cfg.positiveKeywords);
      if (keywordHits > 0) {
        score += Math.min(keywordHits, 8) * 7;
        reasons.push(`keywordHits:${keywordHits}`);
      }

      // 3) negative keywords
      const negativeHits = countKeywordHits(text, cfg.negativeKeywords);
      if (negativeHits > 0) {
        score -= Math.min(negativeHits, 8) * 10;
        reasons.push(`negativeHits:-${negativeHits}`);
      }

      // 4) strong negative regex for income confusion
      if (cfg.strongNegativeRegex && cfg.strongNegativeRegex.length) {
        const strongNeg = regexCount(text, cfg.strongNegativeRegex);
        if (strongNeg > 0) {
          score -= strongNeg * 35;
          reasons.push(`strongNegative:-${strongNeg}`);
        }
      }

      // 5) numeric density
      const numCount = pageCtx.numbersCount || 0;
      if (numCount >= 10) {
        score += Math.min(numCount, 40) * 0.7;
        reasons.push(`numbers:+${Math.round(Math.min(numCount, 40) * 0.7)}`);
      }

      // 6) table size / structure
      if (pageCtx.tableCount > 0) {
        score += Math.min(pageCtx.tableCount, 3) * 5;
        reasons.push(`tableCount:+${Math.min(pageCtx.tableCount, 3) * 5}`);
      }

      if (pageCtx.rowCount >= 8) {
        score += Math.min(pageCtx.rowCount, 30) * 0.4;
        reasons.push(`rows:+${Math.round(Math.min(pageCtx.rowCount, 30) * 0.4)}`);
      }

      if (pageCtx.columnCount >= 3) {
        score += Math.min(pageCtx.columnCount, 8) * 1.2;
        reasons.push(`cols:+${Math.round(Math.min(pageCtx.columnCount, 8) * 1.2)}`);
      }

      // 7) years present is a good sign
      if (pageCtx.years.length >= 1) {
        score += 4;
        reasons.push("years:+4");
      }
      if (pageCtx.years.length >= 2) {
        score += 3;
        reasons.push("years2:+3");
      }

      // 8) phrase density around common headers
      if (cfg.key === "balance") {
        if (textContainsAny(normalizedText, ["الاصول المتداولة", "الاصول غير المتداولة", "حقوق الملكية", "current assets", "non-current assets"])) {
          score += 18;
          reasons.push("balanceStructure:+18");
        }
      }

      if (cfg.key === "income") {
        if (textContainsAny(normalizedText, ["الايرادات", "اجمالي الربح", "صافي الربح", "revenue", "gross profit", "net profit"])) {
          score += 18;
          reasons.push("incomeStructure:+18");
        }
        if (textContainsAny(normalizedText, ["الدخل الشامل الاخر", "بنود الدخل الشامل", "other comprehensive income"])) {
          score -= 25;
          reasons.push("comprehensivePenalty:-25");
        }
      }

      if (cfg.key === "cashflow") {
        if (textContainsAny(normalizedText, ["الانشطة التشغيلية", "الانشطة الاستثمارية", "الانشطة التمويلية", "operating activities", "investing activities", "financing activities"])) {
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
            tableCount: pageCtx.tableCount
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

    // =========================
    // Order-aware final selection
    // =========================
    // التقرير غالباً:
    // المركز المالي -> الدخل -> الدخل الشامل/التغيرات -> التدفقات النقدية
    // لذلك نعطي مكافأة ترتيب لكن بدون أن نجبره بشكل يكسّر الحالات المختلفة.

    function orderAdjustedScore(pageNumber, baseScore, statementKey, chosen) {
      let score = baseScore;

      if (statementKey === "income") {
        if (chosen.balancePage) {
          const diff = pageNumber - chosen.balancePage;
          if (diff >= 1 && diff <= 8) score += 18;
          else if (diff >= -1 && diff <= 12) score += 8;
          else if (diff < -1) score -= 14;
        }
      }

      if (statementKey === "cashflow") {
        if (chosen.incomePage) {
          const diff = pageNumber - chosen.incomePage;
          if (diff >= 1 && diff <= 12) score += 24;
          else if (diff >= -1 && diff <= 16) score += 8;
          else if (diff < -1) score -= 18;
        }
        if (chosen.balancePage) {
          const diff2 = pageNumber - chosen.balancePage;
          if (diff2 >= 2) score += 6;
        }
      }

      if (statementKey === "balance") {
        // balance غالباً الأسبق
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
    // Generic row extraction from preview text
    // =========================
    // الهدف هنا المحافظة على البناء الحالي قدر الإمكان:
    // - نقرأ الجداول من الصفحة المختارة
    // - نستخرج أعمدة السنوات
    // - نبني items = [{label,current,previous}]
    // هذا المحرك متسامح مع اختلاف شكل preview.

    function splitLinesFromTables(tables) {
      const text = (tables || []).map(tableText).join("\n");
      return text
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    }

    function isLikelyLabel(line) {
      const s = normalizeText(line);
      if (!s) return false;
      if (/^(page|صفحه|جدول|table)\b/.test(s)) return false;
      return /[a-zA-Z\u0600-\u06FF]/.test(line);
    }

    function extractNumbersFromLine(line) {
      const matches = toEnglishDigits(String(line || "")).match(/\(?-?\d[\d,]*\.?\d*\)?/g) || [];
      return matches
        .map(parseNumberSmart)
        .filter((n) => n !== null && Number.isFinite(n));
    }

    function cleanLabel(line) {
      let s = String(line || "").trim();
      s = s.replace(/\s{2,}/g, " ");
      s = s.replace(/[\|\t]+/g, " ");
      s = s.replace(/\b(20\d{2}|19\d{2})\b/g, " ");
      s = s.replace(/\(?-?\d[\d,]*\.?\d*\)?/g, " ");
      s = s.replace(/\s{2,}/g, " ").trim();
      return s;
    }

    function detectYearColumnsFromPageText(pageCtx) {
      const years = extractYears(pageCtx?.text || "");
      const latest = years[0] || null;
      const previous = years[1] || null;
      return { latest, previous, years };
    }

    function shouldKeepRow(label, statementKey) {
      const s = normalizeText(label);
      if (!s) return false;
      if (s.length < 2) return false;

      const blacklistCommon = [
        "ايضاح", "الايضاحات", "notes", "note", "ريال", "الف ريال", "مليون ريال",
        "the accompanying notes", "الايضاحات المرفقه", "تابع", "continued"
      ];
      if (blacklistCommon.some((x) => s === normalizeText(x))) return false;

      if (statementKey === "income") {
        if (textContainsAny(s, [
          "الدخل الشامل", "other comprehensive income", "التغيرات في حقوق الملكيه"
        ])) return false;
      }

      if (statementKey === "balance") {
        return textContainsAny(s, [
          "الاصول", "الموجودات", "النقد", "الذمم", "المخزون", "الممتلكات", "الالتزامات",
          "المطلوبات", "حقوق الملكيه", "current", "asset", "liabil", "equity", "inventory"
        ]) || s.length > 4;
      }

      if (statementKey === "income") {
        return textContainsAny(s, [
          "الايرادات", "المبيعات", "تكلفه", "اجمالي الربح", "مصروف", "صافي الربح", "ربح السهم",
          "revenue", "sales", "gross", "expense", "profit", "earnings"
        ]) || s.length > 4;
      }

      if (statementKey === "cashflow") {
        return textContainsAny(s, [
          "الانشطه التشغيليه", "الانشطه الاستثماريه", "الانشطه التمويليه",
          "صافي النقد", "النقد وما في حكمه",
          "operating", "investing", "financing", "cash and cash equivalents"
        ]) || s.length > 4;
      }

      return true;
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
      const lines = splitLinesFromTables(pageCtx?.tables || []);
      const colInfo = detectYearColumnsFromPageText(pageCtx);

      const items = [];

      for (const line of lines) {
        if (!isLikelyLabel(line)) continue;

        const nums = extractNumbersFromLine(line);
        if (!nums.length) continue;

        const label = cleanLabel(line);
        if (!shouldKeepRow(label, statementKey)) continue;

        const current = nums[0] ?? null;
        const previous = nums[1] ?? null;

        if (!label) continue;

        items.push({
          label,
          current,
          previous
        });
      }

      // إزالة التكرارات
      const dedupMap = new Map();
      for (const row of items) {
        const key = normalizeText(row.label);
        if (!dedupMap.has(key)) {
          dedupMap.set(key, row);
        } else {
          const oldRow = dedupMap.get(key);
          const oldScore = (oldRow.current != null) + (oldRow.previous != null);
          const newScore = (row.current != null) + (row.previous != null);
          if (newScore > oldScore) dedupMap.set(key, row);
        }
      }

      const finalItems = Array.from(dedupMap.values()).slice(0, 120);

      return {
        pageNumber,
        latest: colInfo.latest,
        previous: colInfo.previous,
        years: colInfo.years,
        items: finalItems,
        rawLinesCount: lines.length
      };
    }

    const incomeStatementLite = extractStatementLite(chosen.incomePage, "income");
    const balanceSheetLite = extractStatementLite(chosen.balancePage, "balance");
    const cashFlowLite = extractStatementLite(chosen.cashFlowPage, "cashflow");

    // =========================
    // Selection debug / transparency
    // =========================

    function topN(rankings, n = 5) {
      return (rankings || []).slice(0, n).map((r) => ({
        pageNumber: r.pageNumber,
        score: Math.round(r.score * 10) / 10,
        reasons: r.reasons,
        years: r.years,
        numbersCount: r.numbersCount,
        rowCount: r.rowCount,
        tableCount: r.tableCount
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v2",
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
          "income statement penalizes comprehensive income and changes in equity pages",
          "cash flow prefers pages after income statement",
          "balance sheet prefers earlier statement pages"
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
