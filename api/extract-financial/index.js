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

    function isYearCell(cell) {
      const s = toEnglishDigits(String(cell || "").trim());
      return /^(19|20)\d{2}$/.test(s);
    }

    function isNoteCell(cell) {
      const s = normalizeText(cell);
      return s === "ايضاح" || s === "notes" || s === "note";
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

    function getTableDensityScore(table) {
      return (getTableRowCount(table) * 10) + getTableColumnCount(table);
    }

    function getPageMainTable(pageTables) {
      const tables = Array.isArray(pageTables) ? pageTables : [];
      if (!tables.length) return null;

      return tables
        .slice()
        .sort((a, b) => getTableDensityScore(b) - getTableDensityScore(a))[0];
    }

    function getHeaderCandidates(rows) {
      const r0 = rows[0] || [];
      const r1 = rows[1] || [];
      const r2 = rows[2] || [];
      return [r0, r1, r2];
    }

    function detectHeaderColumns(rows) {
      const headerCandidates = getHeaderCandidates(rows);

      let latest = null;
      let previous = null;
      let currentCol = null;
      let previousCol = null;
      let noteCol = null;
      let headerRowIndex = null;

      for (let i = 0; i < headerCandidates.length; i += 1) {
        const row = headerCandidates[i];
        if (!Array.isArray(row) || !row.length) continue;

        const yearCells = row
          .map((cell, idx) => ({
            idx,
            year: isYearCell(cell) ? Number(toEnglishDigits(String(cell).trim())) : null
          }))
          .filter((x) => Number.isFinite(x.year));

        if (yearCells.length >= 2) {
          const sortedYears = yearCells.map((x) => x.year).sort((a, b) => b - a);
          latest = sortedYears[0];
          previous = sortedYears[1];

          const latestMatch = yearCells.find((x) => x.year === latest);
          const previousMatch = yearCells.find((x) => x.year === previous);

          currentCol = latestMatch ? latestMatch.idx : null;
          previousCol = previousMatch ? previousMatch.idx : null;
          headerRowIndex = i;

          for (let c = 0; c < row.length; c += 1) {
            if (isNoteCell(row[c])) {
              noteCol = c;
              break;
            }
          }
          break;
        }
      }

      if (noteCol == null) {
        for (const row of headerCandidates) {
          for (let c = 0; c < row.length; c += 1) {
            if (isNoteCell(row[c])) {
              noteCol = c;
              break;
            }
          }
          if (noteCol != null) break;
        }
      }

      return {
        latest,
        previous,
        currentCol,
        previousCol,
        noteCol,
        headerRowIndex
      };
    }

    function buildPageContext(pageNumber, orderedPageNumbers) {
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

      const headerCandidates = getHeaderCandidates(mainRows);
      const headerText = headerCandidates.map((r) => flattenTableValue(r)).join("\n");

      const firstRowsText = (mainRows || []).slice(0, 8).map((r) => r.join(" | ")).join("\n");
      const lastRowsText = (mainRows || []).slice(-8).map((r) => r.join(" | ")).join("\n");

      const structuralHintsText = `${headerText}\n${firstRowsText}\n${lastRowsText}\n${mergedText}`;
      const normalizedAllText = normalizeText(structuralHintsText);
      const headerColumns = detectHeaderColumns(mainRows);

      const tableIndex = orderedPageNumbers.indexOf(pageNumber);
      const positionRatio = orderedPageNumbers.length > 1
        ? tableIndex / (orderedPageNumbers.length - 1)
        : 0;

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
          "credit risk",
          "القيمة الحالية",
          "القيمة المستقبلية",
          "الاستحقاق التعاقدي",
          "تحليل الحساسية",
          "تحليل الاستحقاق"
        ]);

      const hasStatementHeader =
        textContainsAny(headerText, [
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

      const hasYearHeaderLikeStatement =
        headerCandidates.some((r) => {
          const joined = normalizeText(r.join(" | "));
          const yearCount = extractYears(joined).length;
          return (
            yearCount >= 2 &&
            (
              joined.includes("ايضاح") ||
              joined.includes("notes") ||
              joined.includes("note")
            )
          );
        });

      const isLikelyIndexPage =
        textContainsAny(normalizedAllText, [
          "تقرير مراجعي الحسابات المستقلين",
          "ايضاحات حول القوايم الماليه الموحده",
          "إيضاحات حول القوائم المالية الموحدة",
          "موافقه مجلس الاداره",
          "موافقة مجلس الإدارة",
          "الفهرس",
          "جدول المحتويات",
          "independent auditor",
          "table of contents"
        ]) &&
        textContainsAny(normalizedAllText, [
          "قائمه المركز المالي الموحده",
          "قائمة المركز المالي الموحدة",
          "قائمه الدخل الموحده",
          "قائمة الدخل الموحدة",
          "قائمه التدفقات النقديه الموحده",
          "قائمة التدفقات النقدية الموحدة",
          "statement of financial position",
          "statement of profit or loss",
          "statement of cash flows"
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
          "إفصاح",
          "السياسات المحاسبية",
          "السياسة المحاسبية",
          "السياسات المحاسبيه",
          "accounting policies",
          "financial instruments",
          "risk management"
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
          "قائمة التغيرات في حقوق الملكية",
          "قائمة التغيرات في حقوق المساهمين",
          "statement of changes in equity",
          "retained earnings",
          "treasury shares",
          "non-controlling interests"
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
        firstRowsText,
        lastRowsText,
        structuralHintsText,
        headerColumns,
        positionRatio,
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

    const pageContexts = allPageNumbers.map((p) => buildPageContext(p, allPageNumbers));

    // =========================
    // Sector Detection Engine
    // =========================

    const PROFILES = {
      bank: {
        key: "bank",
        positiveKeywords: [
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
        negativeKeywords: [
          "revenue",
          "cost of sales",
          "gross profit",
          "inventories",
          "selling and distribution expenses",
          "statement of profit or loss",
          "profit or loss"
        ]
      },
      operating_company: {
        key: "operating_company",
        positiveKeywords: [
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
          "general and administrative expenses",
          "statement of profit or loss"
        ],
        negativeKeywords: [
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
      const fullText = pageContexts.map((p) => p.structuralHintsText || "").join("\n\n");
      const profileScores = {};

      for (const key of Object.keys(PROFILES)) {
        const cfg = PROFILES[key];
        const positive = countKeywordHits(fullText, cfg.positiveKeywords);
        const negative = countKeywordHits(fullText, cfg.negativeKeywords);
        profileScores[key] = (positive * 8) - (negative * 5);
      }

      const bankScore = safeNumber(profileScores.bank, 0);
      const operatingScore = safeNumber(profileScores.operating_company, 0);

      const statementProfile = bankScore > operatingScore
        ? "bank"
        : "operating_company";

      return {
        statementProfile,
        scores: profileScores,
        reason: statementProfile === "bank"
          ? "bank keywords stronger than operating-company keywords"
          : "operating-company keywords stronger than bank keywords"
      };
    }

    const profileDetection = detectStatementProfile();
    const statementProfile = profileDetection.statementProfile;

    // =========================
    // Statement Config by Profile
    // =========================

    const PROFILE_STATEMENTS = {
      bank: {
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
            "total liabilities",
            "نقد وارصده لدى البنوك المركزيه",
            "نقد وارصدة لدى البنوك المركزية",
            "ودائع العملاء",
            "تمويل وسلف",
            "استثمارات بصافي"
          ],
          strongStructureKeywords: [
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "اجمالي المطلوبات وحقوق الملكيه",
            "الموجودات",
            "المطلوبات",
            "حقوق الملكيه",
            "ودائع العملاء",
            "ارصده لدى البنوك والمؤسسات الماليه الاخرى",
            "نقد وارصده لدى البنوك المركزيه"
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
            "الانشطة التشغيلية",
            "الانشطة الاستثمارية",
            "الانشطة التمويلية"
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
          strongStructureKeywords: [
            "اجمالي دخل العمليات",
            "اجمالي مصاريف العمليات",
            "دخل السنة قبل الزكاه",
            "صافي دخل السنه",
            "ربحيه السهم",
            "الدخل من التمويل والاستثمارات",
            "المصاريف على ودائع العملاء لاجل والبنوك والمؤسسات الماليه الاخرى"
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
          strongStructureKeywords: [
            "صافي النقد الناتج من الانشطه التشغيليه",
            "صافي النقد المستخدم في الانشطه الاستثماريه",
            "صافي النقد الناتج من الانشطه التمويليه",
            "النقد وشبه النقد في بدايه السنه",
            "النقد وشبه النقد في نهايه السنه",
            "الانشطه التشغيليه",
            "الانشطه الاستثماريه",
            "الانشطه التمويليه"
          ],
          negativeKeywords: [
            "قائمة الدخل",
            "الدخل الشامل",
            "قائمة المركز المالي",
            "قائمة التغيرات في حقوق الملكية",
            "income statement",
            "comprehensive income",
            "financial position",
            "changes in equity",
            "اجمالي الموجودات",
            "اجمالي المطلوبات"
          ]
        }
      },

      operating_company: {
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
            "assets",
            "liabilities",
            "equity",
            "total assets",
            "total liabilities",
            "total equity",
            "inventories",
            "trade receivables",
            "trade payables",
            "cash and cash equivalents",
            "property plant and equipment",
            "right-of-use assets",
            "deferred tax",
            "current assets",
            "non-current assets",
            "current liabilities",
            "non-current liabilities",
            "الاصول",
            "الموجودات",
            "المطلوبات",
            "حقوق الملكية",
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "المخزون",
            "النقد وما في حكمه",
            "المدينون التجاريون",
            "الدائنون التجاريون"
          ],
          strongStructureKeywords: [
            "total assets",
            "total liabilities",
            "total equity",
            "total liabilities and equity",
            "current assets",
            "non-current assets",
            "current liabilities",
            "non-current liabilities",
            "اجمالي الموجودات",
            "اجمالي المطلوبات",
            "اجمالي حقوق الملكيه",
            "اجمالي المطلوبات وحقوق الملكيه"
          ],
          negativeKeywords: [
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
          positiveTitles: [
            "قائمة الدخل",
            "قائمة الارباح والخسائر",
            "قائمة الربح والخسارة",
            "statement of profit or loss",
            "statement of income",
            "income statement",
            "profit and loss",
            "profit or loss"
          ],
          positiveKeywords: [
            "revenue",
            "sales",
            "cost of sales",
            "cost of revenue",
            "gross profit",
            "operating profit",
            "profit before zakat and income tax",
            "profit before income tax",
            "profit for the year",
            "earnings per share",
            "selling and distribution expenses",
            "general and administrative expenses",
            "finance cost",
            "الايرادات",
            "تكلفة المبيعات",
            "مجمل الربح",
            "الربح التشغيلي",
            "صافي الربح",
            "ربحية السهم"
          ],
          strongStructureKeywords: [
            "revenue",
            "cost of sales",
            "gross profit",
            "operating profit",
            "profit before zakat and income tax",
            "profit for the year",
            "earnings per share",
            "selling and distribution expenses",
            "general and administrative expenses",
            "الايرادات",
            "تكلفه المبيعات",
            "مجمل الربح",
            "الربح التشغيلي"
          ],
          negativeKeywords: [
            "customer deposits",
            "central banks",
            "due from banks",
            "due to banks",
            "statement of financial position",
            "statement of cash flows",
            "statement of changes in equity"
          ]
        },

        cashflow: {
          key: "cashflow",
          positiveTitles: [
            "قائمة التدفقات النقدية",
            "بيان التدفقات النقدية",
            "cash flow statement",
            "statement of cash flows",
            "cash flows",
            "consolidated statement of cash flows"
          ],
          positiveKeywords: [
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "net cash from operating activities",
            "cash and cash equivalents",
            "operating activities",
            "investing activities",
            "financing activities",
            "صافي النقد الناتج من الانشطة التشغيلية",
            "صافي النقد المستخدم في الانشطة الاستثمارية",
            "صافي النقد الناتج من الانشطة التمويلية"
          ],
          strongStructureKeywords: [
            "cash flows from operating activities",
            "cash flows from investing activities",
            "cash flows from financing activities",
            "cash and cash equivalents at 31 december",
            "cash and cash equivalents at 1 january",
            "net cash from operating activities",
            "net cash used in investing activities",
            "net cash from financing activities",
            "صافي النقد الناتج من الانشطه التشغيليه",
            "صافي النقد المستخدم في الانشطه الاستثماريه",
            "صافي النقد الناتج من الانشطه التمويليه"
          ],
          negativeKeywords: [
            "statement of financial position",
            "statement of profit or loss",
            "gross profit",
            "total assets",
            "total liabilities"
          ]
        }
      }
    };

    const STATEMENTS = PROFILE_STATEMENTS[statementProfile] || PROFILE_STATEMENTS.bank;

    // =========================
    // Synthetic Labels by Profile
    // =========================

    const SYNTHETIC_LABELS = {
      bank: {
        balance: [
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
        ],
        income: [
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
        ],
        cashflow: [
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
        ]
      },

      operating_company: {
        balance: [
          "الممتلكات والمعدات والآلات",
          "الدفعات المقدمة طويلة الأجل",
          "أصول حق الاستخدام",
          "موجودات غير ملموسة وشهرة",
          "الأصول الحيوية",
          "الاستثمارات",
          "المشتقات المالية",
          "الضريبة المؤجلة",
          "إجمالي الأصول غير المتداولة",
          "المخزون",
          "الأصول الحيوية المتداولة",
          "المدينون التجاريون والدفعات المقدمة والذمم الأخرى",
          "المشتقات المالية المتداولة",
          "النقد وما في حكمه",
          "إجمالي الأصول المتداولة",
          "إجمالي الموجودات",
          "رأس المال",
          "الاحتياطي النظامي",
          "أسهم خزينة",
          "احتياطيات أخرى",
          "أرباح مبقاة",
          "حقوق الملكية العائدة للمساهمين",
          "حقوق أقلية",
          "إجمالي حقوق الملكية",
          "قروض والتزامات طويلة الأجل",
          "التزامات عقود الإيجار",
          "مكافآت نهاية الخدمة",
          "مشتقات مالية غير متداولة",
          "ضرائب مؤجلة",
          "إجمالي المطلوبات غير المتداولة",
          "السحب على المكشوف والقروض قصيرة الأجل",
          "الجزء المتداول من القروض",
          "الجزء المتداول من التزامات الإيجار",
          "الزكاة والضرائب",
          "ضريبة دخل مستحقة",
          "الدائنون التجاريون والذمم الأخرى",
          "مشتقات مالية متداولة",
          "إجمالي المطلوبات المتداولة",
          "إجمالي المطلوبات",
          "إجمالي المطلوبات وحقوق الملكية"
        ],
        income: [
          "الإيرادات",
          "تكلفة المبيعات",
          "مجمل الربح",
          "مصاريف البيع والتوزيع",
          "المصاريف العمومية والإدارية",
          "مصاريف تشغيلية أخرى",
          "خسائر انخفاض في الأصول المالية",
          "الربح التشغيلي",
          "تكلفة التمويل",
          "حصة من نتائج شركات زميلة",
          "الربح قبل الزكاة وضريبة الدخل",
          "الزكاة",
          "ضريبة الدخل",
          "ربح السنة",
          "ربح السنة العائد إلى مساهمي الشركة",
          "حقوق الأقلية",
          "ربح السنة",
          "ربحية السهم الأساسية",
          "ربحية السهم المخفضة"
        ],
        cashflow: [
          "ربح السنة",
          "تعديلات لبنود غير نقدية",
          "استهلاك ممتلكات ومعدات",
          "إطفاء موجودات غير ملموسة",
          "إهلاك أصول حق الاستخدام",
          "حصة من نتائج شركات زميلة",
          "تكلفة التمويل",
          "الزكاة",
          "ضريبة الدخل",
          "التغيرات في رأس المال العامل",
          "المخزون",
          "الأصول الحيوية",
          "المدينون التجاريون والدفعات المقدمة والذمم الأخرى",
          "الدائنون التجاريون والذمم الأخرى",
          "النقد الناتج من العمليات",
          "مكافآت نهاية الخدمة المدفوعة",
          "الزكاة وضريبة الدخل المدفوعة",
          "صافي النقد الناتج من الأنشطة التشغيلية",
          "اقتناء شركات تابعة",
          "إضافات إلى الممتلكات والمعدات",
          "إضافات إلى الموجودات غير الملموسة",
          "إضافات إلى الأصول الحيوية",
          "المتحصلات من بيع أصول",
          "صافي النقد المستخدم في الأنشطة الاستثمارية",
          "المتحصلات من القروض",
          "سداد القروض",
          "تكلفة التمويل المدفوعة",
          "توزيعات أرباح مدفوعة",
          "مدفوعات التزامات الإيجار",
          "صافي النقد الناتج من الأنشطة التمويلية",
          "صافي التغير في النقد وما في حكمه",
          "النقد وما في حكمه في بداية السنة",
          "النقد وما في حكمه في نهاية السنة"
        ]
      }
    };

    // =========================
    // Page Scoring
    // =========================

    function statementBaseScore(pageCtx, cfg) {
      const text = pageCtx.text || "";
      const headerText = pageCtx.headerText || "";
      const structuralText = pageCtx.structuralHintsText || "";
      const normalizedText = pageCtx.normalizedText || "";

      let score = 0;
      const reasons = [];

      const titleHitsHeader = countKeywordHits(headerText, cfg.positiveTitles);
      const titleHitsAll = countKeywordHits(structuralText, cfg.positiveTitles);

      if (titleHitsHeader > 0) {
        score += titleHitsHeader * 60;
        reasons.push(`titleHitsHeader:+${titleHitsHeader * 60}`);
      } else if (titleHitsAll > 0) {
        score += titleHitsAll * 38;
        reasons.push(`titleHitsAll:+${titleHitsAll * 38}`);
      }

      const keywordHits = countKeywordHits(text, cfg.positiveKeywords);
      if (keywordHits > 0) {
        const bonus = Math.min(keywordHits, 10) * 8;
        score += bonus;
        reasons.push(`keywordHits:+${bonus}`);
      }

      const strongStructureHits = countKeywordHits(structuralText, cfg.strongStructureKeywords || []);
      if (strongStructureHits > 0) {
        const bonus = Math.min(strongStructureHits, 8) * 14;
        score += bonus;
        reasons.push(`strongStructureHits:+${bonus}`);
      }

      const negativeHits = countKeywordHits(text, cfg.negativeKeywords);
      if (negativeHits > 0) {
        const penalty = Math.min(negativeHits, 8) * 13;
        score -= penalty;
        reasons.push(`negativeHits:-${penalty}`);
      }

      const numCount = pageCtx.numbersCount || 0;
      if (numCount >= 8) {
        const bonus = Math.round(Math.min(numCount, 80) * 0.65);
        score += bonus;
        reasons.push(`numbers:+${bonus}`);
      }

      if (pageCtx.tableCount > 0) {
        const bonus = Math.min(pageCtx.tableCount, 4) * 5;
        score += bonus;
        reasons.push(`tableCount:+${bonus}`);
      }

      if (pageCtx.mainColumnCount === 3) {
        score += 34;
        reasons.push("threeCols:+34");
      } else if (pageCtx.mainColumnCount >= 2 && pageCtx.mainColumnCount <= 4) {
        score += 20;
        reasons.push("statementLikeCols:+20");
      } else if (pageCtx.mainColumnCount >= 5) {
        score -= 18;
        reasons.push("tooManyCols:-18");
      }

      if (pageCtx.mainRowCount >= 8 && pageCtx.mainRowCount <= 50) {
        score += 14;
        reasons.push("goodRowRange:+14");
      }

      if (pageCtx.hasStatementHeader) {
        score += 34;
        reasons.push("statementHeader:+34");
      }

      if (pageCtx.hasYearHeaderLikeStatement) {
        score += 44;
        reasons.push("yearHeaderLikeStatement:+44");
      }

      if (pageCtx.headerColumns.latest && pageCtx.headerColumns.previous) {
        score += 26;
        reasons.push("headerYearsDetected:+26");
      }

      if (pageCtx.years.length >= 2) {
        score += 10;
        reasons.push("years2:+10");
      }

      const pos = pageCtx.positionRatio;
      if (pos <= 0.30) {
        score += 8;
        reasons.push("softPositionEarly:+8");
      } else if (pos >= 0.75) {
        score -= 8;
        reasons.push("softPositionLate:-8");
      }

      if (pageCtx.isLikelyNoteTable) {
        score -= 80;
        reasons.push("noteTablePenalty:-80");
      }

      if (pageCtx.isLikelyIndexPage) {
        score -= 130;
        reasons.push("indexPenalty:-130");
      }

      if (pageCtx.isLikelyStandardsPage) {
        score -= 120;
        reasons.push("standardsPenalty:-120");
      }

      if (pageCtx.isLikelyEquityStatement) {
        score -= 90;
        reasons.push("equityPenalty:-90");
      }

      if (cfg.key === "balance") {
        if (textContainsAny(normalizedText, [
          "اجمالي الموجودات",
          "اجمالي المطلوبات",
          "اجمالي المطلوبات وحقوق الملكيه",
          "الموجودات",
          "المطلوبات",
          "حقوق الملكيه",
          "total assets",
          "total liabilities",
          "total equity",
          "total liabilities and equity"
        ])) {
          score += 34;
          reasons.push("balanceStructure:+34");
        }
      }

      if (cfg.key === "income") {
        if (textContainsAny(normalizedText, [
          "اجمالي دخل العمليات",
          "اجمالي مصاريف العمليات",
          "دخل السنه قبل الزكاه",
          "صافي دخل السنه",
          "ربحيه السهم",
          "revenue",
          "cost of sales",
          "gross profit",
          "operating profit",
          "earnings per share",
          "profit for the year"
        ])) {
          score += 34;
          reasons.push("incomeStructure:+34");
        }
      }

      if (cfg.key === "cashflow") {
        if (textContainsAny(normalizedText, [
          "صافي النقد الناتج من الانشطه التشغيليه",
          "صافي النقد المستخدم في الانشطه الاستثماريه",
          "صافي النقد الناتج من الانشطه التمويليه",
          "النقد وشبه النقد في بدايه السنه",
          "النقد وشبه النقد في نهايه السنه",
          "cash flows from operating activities",
          "cash flows from investing activities",
          "cash flows from financing activities",
          "cash and cash equivalents at 31 december"
        ])) {
          score += 38;
          reasons.push("cashflowStructure:+38");
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
            mainRowCount: pageCtx.mainRowCount,
            positionRatio: pageCtx.positionRatio,
            isLikelyNoteTable: pageCtx.isLikelyNoteTable,
            hasStatementHeader: pageCtx.hasStatementHeader,
            isLikelyIndexPage: pageCtx.isLikelyIndexPage,
            isLikelyStandardsPage: pageCtx.isLikelyStandardsPage,
            isLikelyEquityStatement: pageCtx.isLikelyEquityStatement,
            headerColumns: pageCtx.headerColumns
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

    function getTopCandidatePages(rankings, topN = 8, minScore = 0) {
      const list = [];
      for (const r of rankings || []) {
        if (r.score < minScore && list.length >= 3) break;
        list.push(r.pageNumber);
        if (list.length >= topN) break;
      }
      return unique(list);
    }

    function candidateScore(map, pageNumber) {
      return safeNumber(map[pageNumber], -9999);
    }

    function comboOrderScore(balancePage, incomePage, cashFlowPage) {
      let score = 0;

      const bi = incomePage - balancePage;
      const ic = cashFlowPage - incomePage;
      const bc = cashFlowPage - balancePage;

      if (balancePage < incomePage) score += 20;
      else if (balancePage === incomePage) score += 2;
      else score -= 24;

      if (incomePage < cashFlowPage) score += 22;
      else if (incomePage === cashFlowPage) score += 2;
      else score -= 30;

      if (bi >= 1 && bi <= 5) score += 18;
      else if (bi > 7) score -= Math.min((bi - 7) * 2, 20);

      if (ic >= 1 && ic <= 7) score += 18;
      else if (ic > 9) score -= Math.min((ic - 9) * 2, 24);

      if (bc >= 2 && bc <= 12) score += 12;
      else if (bc > 14) score -= Math.min((bc - 14) * 1.5, 24);

      return score;
    }

    function comboNeighborScore(balancePage, incomePage, cashFlowPage) {
      let score = 0;
      const pages3 = [balancePage, incomePage, cashFlowPage];
      const uniqCount = new Set(pages3).size;

      if (uniqCount === 3) score += 18;
      if (uniqCount === 2) score -= 18;
      if (uniqCount === 1) score -= 70;

      if (balancePage === incomePage) score -= 22;
      if (incomePage === cashFlowPage) score -= 26;
      if (balancePage === cashFlowPage) score -= 34;

      const spread = Math.max(...pages3) - Math.min(...pages3);
      if (spread <= 8) score += 16;
      else if (spread > 20) score -= Math.min(spread - 20, 30);

      return score;
    }

    function comboPositionConsistencyScore(balancePage, incomePage, cashFlowPage) {
      const bCtx = pageContexts.find((x) => x.pageNumber === balancePage);
      const iCtx = pageContexts.find((x) => x.pageNumber === incomePage);
      const cCtx = pageContexts.find((x) => x.pageNumber === cashFlowPage);

      if (!bCtx || !iCtx || !cCtx) return 0;

      const avg = (bCtx.positionRatio + iCtx.positionRatio + cCtx.positionRatio) / 3;
      const maxDeviation = Math.max(
        Math.abs(bCtx.positionRatio - avg),
        Math.abs(iCtx.positionRatio - avg),
        Math.abs(cCtx.positionRatio - avg)
      );

      if (maxDeviation <= 0.08) return 10;
      if (maxDeviation <= 0.18) return 4;
      if (maxDeviation >= 0.45) return -12;
      return 0;
    }

    function chooseStatementPages() {
      const balanceCandidates = getTopCandidatePages(rankedBalanceBase, 10, -50);
      const incomeCandidates = getTopCandidatePages(rankedIncomeBase, 10, -50);
      const cashCandidates = getTopCandidatePages(rankedCashBase, 10, -50);

      let best = null;

      for (const balancePage of balanceCandidates) {
        for (const incomePage of incomeCandidates) {
          for (const cashFlowPage of cashCandidates) {
            const baseScore =
              candidateScore(balanceBaseMap, balancePage) +
              candidateScore(incomeBaseMap, incomePage) +
              candidateScore(cashBaseMap, cashFlowPage);

            const orderScore = comboOrderScore(balancePage, incomePage, cashFlowPage);
            const neighborScore = comboNeighborScore(balancePage, incomePage, cashFlowPage);
            const positionConsistencyScore = comboPositionConsistencyScore(balancePage, incomePage, cashFlowPage);

            const total = baseScore + orderScore + neighborScore + positionConsistencyScore;

            const candidate = {
              balancePage,
              incomePage,
              cashFlowPage,
              totalScore: total,
              parts: {
                baseScore,
                orderScore,
                neighborScore,
                positionConsistencyScore
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
          balancePage: rankedBalanceBase[0]?.pageNumber || null,
          incomePage: rankedIncomeBase[0]?.pageNumber || null,
          cashFlowPage: rankedCashBase[0]?.pageNumber || null,
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

    const selected = chooseStatementPages();
    const chosen = {
      balancePage: selected.balancePage,
      incomePage: selected.incomePage,
      cashFlowPage: selected.cashFlowPage
    };

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

    function getSyntheticLabel(statementKey, rowIndex) {
      const labelsByProfile = SYNTHETIC_LABELS[statementProfile] || SYNTHETIC_LABELS.bank;
      const labels = labelsByProfile[statementKey] || [];
      return labels[rowIndex] || `${statementKey}_row_${rowIndex + 1}`;
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
            labelMode: "synthetic_by_statement_template"
          }
        };
      }

      const pageCtx = pageContexts.find((p) => p.pageNumber === pageNumber);
      const rows = Array.isArray(pageCtx?.mainRowsMeta) ? pageCtx.mainRowsMeta : [];
      const mainRows = Array.isArray(pageCtx?.mainRows) ? pageCtx.mainRows : [];

      if (!rows.length) {
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
            labelMode: "synthetic_by_statement_template"
          }
        };
      }

      const headerDetected = detectHeaderColumns(mainRows);

      let latest = headerDetected.latest;
      let previous = headerDetected.previous;
      let currentCol = headerDetected.currentCol;
      let previousCol = headerDetected.previousCol;
      let noteCol = headerDetected.noteCol;

      if (latest == null || previous == null) {
        const pageYears = extractYears(pageCtx?.text || "");
        if (pageYears.length >= 2) {
          latest = pageYears[0];
          previous = pageYears[1];
        }
      }

      const startRowIndex = headerDetected.headerRowIndex != null
        ? headerDetected.headerRowIndex + 1
        : 1;

      const items = [];
      for (let i = startRowIndex; i < rows.length; i += 1) {
        const cells = rows[i].cells || [];
        if (!cells.length) continue;

        const numericCells = cells
          .map((cell, idx) => ({ idx, num: parseNumberSmart(cell) }))
          .filter((x) => x.num != null);

        if (!numericCells.length) continue;

        if (currentCol == null || previousCol == null) {
          const yearLikeTwoCols = numericCells.slice(0, 2);
          if (yearLikeTwoCols.length >= 2) {
            previousCol = yearLikeTwoCols[0].idx;
            currentCol = yearLikeTwoCols[1].idx;
          }
        }

        const currentValue = currentCol != null ? parseNumberSmart(cells[currentCol]) : null;
        const previousValue = previousCol != null ? parseNumberSmart(cells[previousCol]) : null;
        const note = noteCol != null ? String(cells[noteCol] || "").trim() : null;

        let finalCurrent = currentValue;
        let finalPrevious = previousValue;

        if (finalCurrent == null && finalPrevious == null) {
          if (numericCells.length >= 2) {
            finalPrevious = numericCells[0].num;
            finalCurrent = numericCells[1].num;
          } else if (numericCells.length === 1) {
            finalCurrent = numericCells[0].num;
          }
        }

        if (finalCurrent == null && finalPrevious == null) continue;

        const label = getSyntheticLabel(statementKey, items.length);
        items.push(buildItem(label, finalCurrent, finalPrevious, note));
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
          specialCommissionExpense: ["المصاريف على ودائع العملاء لأجل والبنوك والمؤسسات المالية الأخرى"],
          netSpecialCommissionIncome: ["الدخل من التمويل والاستثمارات بالصافي"],
          feeAndCommissionIncomeNet: ["الدخل من رسوم الخدمات المصرفية بالصافي"],
          totalOperatingIncome: ["إجمالي دخل العمليات التشغيلية"],
          totalOperatingExpenses: ["إجمالي مصاريف العمليات التشغيلية"],
          operatingIncomeNet: ["دخل من العمليات التشغيلية بالصافي"],
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل"],
          zakatAndIncomeTax: ["مصروف الزكاة وضريبة الدخل"],
          netIncome: ["صافي دخل السنة"],
          basicEps: ["ربحية السهم الأساسية"],
          dilutedEps: ["ربحية السهم المخفضة"]
        },
        cashflow: {
          netIncomeBeforeZakatAndIncomeTax: ["دخل السنة قبل الزكاة وضريبة الدخل"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من/(المستخدم في) الأنشطة التمويلية"],
          netChangeInCashAndCashEquivalents: ["صافي الزيادة/(النقص) في النقد وشبه النقد"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وشبه النقد في بداية السنة"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وشبه النقد في نهاية السنة"]
        }
      },

      operating_company: {
        balance: {
          cashAndCashEquivalents: ["النقد وما في حكمه"],
          inventories: ["المخزون"],
          tradeReceivables: ["المدينون التجاريون والدفعات المقدمة والذمم الأخرى"],
          propertyPlantAndEquipment: ["الممتلكات والمعدات والآلات"],
          totalAssets: ["إجمالي الموجودات"],
          loansAndBorrowings: ["قروض والتزامات طويلة الأجل", "السحب على المكشوف والقروض قصيرة الأجل", "الجزء المتداول من القروض"],
          tradePayables: ["الدائنون التجاريون والذمم الأخرى"],
          totalLiabilities: ["إجمالي المطلوبات"],
          retainedEarnings: ["أرباح مبقاة"],
          totalEquity: ["إجمالي حقوق الملكية"],
          totalLiabilitiesAndEquity: ["إجمالي المطلوبات وحقوق الملكية"]
        },
        income: {
          revenue: ["الإيرادات"],
          costOfSales: ["تكلفة المبيعات"],
          grossProfit: ["مجمل الربح"],
          sellingAndDistributionExpenses: ["مصاريف البيع والتوزيع"],
          generalAndAdministrativeExpenses: ["المصاريف العمومية والإدارية"],
          operatingProfit: ["الربح التشغيلي"],
          financeCost: ["تكلفة التمويل"],
          profitBeforeZakatAndIncomeTax: ["الربح قبل الزكاة وضريبة الدخل"],
          zakat: ["الزكاة"],
          incomeTax: ["ضريبة الدخل"],
          netIncome: ["ربح السنة"],
          basicEps: ["ربحية السهم الأساسية"],
          dilutedEps: ["ربحية السهم المخفضة"]
        },
        cashflow: {
          netIncome: ["ربح السنة"],
          netCashFromOperatingActivities: ["صافي النقد الناتج من الأنشطة التشغيلية"],
          netCashFromInvestingActivities: ["صافي النقد المستخدم في الأنشطة الاستثمارية"],
          netCashFromFinancingActivities: ["صافي النقد الناتج من الأنشطة التمويلية"],
          netChangeInCashAndCashEquivalents: ["صافي التغير في النقد وما في حكمه"],
          cashAndCashEquivalentsAtBeginningOfYear: ["النقد وما في حكمه في بداية السنة"],
          cashAndCashEquivalentsAtEndOfYear: ["النقد وما في حكمه في نهاية السنة"]
        }
      }
    };

    function buildStructuredFields(items, pageNumber, mapping) {
      const out = {};
      for (const fieldKey of Object.keys(mapping || {})) {
        out[fieldKey] = buildField(items, mapping[fieldKey], pageNumber);
      }
      return out;
    }

    const mappings = STRUCTURED_MAPPINGS[statementProfile] || STRUCTURED_MAPPINGS.bank;

    const balanceSheetStructured = {
      pageNumber: balanceSheetLite.pageNumber,
      latest: balanceSheetLite.latest,
      previous: balanceSheetLite.previous,
      years: balanceSheetLite.years,
      fields: buildStructuredFields(balanceSheetLite.items, balanceSheetLite.pageNumber, mappings.balance)
    };

    const incomeStatementStructured = {
      pageNumber: incomeStatementLite.pageNumber,
      latest: incomeStatementLite.latest,
      previous: incomeStatementLite.previous,
      years: incomeStatementLite.years,
      fields: buildStructuredFields(incomeStatementLite.items, incomeStatementLite.pageNumber, mappings.income)
    };

    const cashFlowStructured = {
      pageNumber: cashFlowLite.pageNumber,
      latest: cashFlowLite.latest,
      previous: cashFlowLite.previous,
      years: cashFlowLite.years,
      fields: buildStructuredFields(cashFlowLite.items, cashFlowLite.pageNumber, mappings.cashflow)
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
        mainRowCount: r.mainRowCount,
        positionRatio: r.positionRatio,
        isLikelyNoteTable: r.isLikelyNoteTable,
        hasStatementHeader: r.hasStatementHeader,
        isLikelyIndexPage: r.isLikelyIndexPage,
        isLikelyStandardsPage: r.isLikelyStandardsPage,
        isLikelyEquityStatement: r.isLikelyEquityStatement,
        headerColumns: r.headerColumns
      }));
    }

    return send(200, {
      ok: true,
      engine: "extract-financial-v3.5",
      phase: "4A",
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
        rankingEngine: selected.rankingEngine,
        ranking: {
          balanceTop: topN(rankedBalanceBase, 5),
          incomeTop: topN(rankedIncomeBase, 5),
          cashFlowTop: topN(rankedCashBase, 5)
        },
        chosen,
        notes: [
          "v3.5 adds Sector Detection Engine before statement ranking",
          "supported profiles: bank, operating_company",
          "page ranking now uses statement config based on detected profile",
          "synthetic labels are profile-specific",
          "structured extraction mapping is profile-specific",
          "all pages remain eligible; no hard page-range exclusion is used",
          "position inside the file is only a soft signal"
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
