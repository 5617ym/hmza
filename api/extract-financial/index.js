// api/extract-financial/index.js
const parseArabicNumber = require("../_lib/parse-arabic-number");

module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    const body = req.body || {};
    const normalized = body.normalized;

    if (!normalized || typeof normalized !== "object") {
      return send(400, { ok: false, error: "Missing 'normalized' in request body" });
    }

    // نستخدم tablesPreviewNormalized (الأهم لنا الآن)
    const tablesPreviewNormalized =
      Array.isArray(normalized.tablesPreviewNormalized) ? normalized.tablesPreviewNormalized : [];

    if (!tablesPreviewNormalized.length) {
      return send(200, {
        ok: true,
        financial: {
          incomeStatement: { ok: false, reason: "No tablesPreviewNormalized found" },
        },
      });
    }

    const norm = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const containsAny = (text, keywords) => {
      const t = norm(text);
      return keywords.some((k) => t.includes(norm(k)));
    };

    // ---------- 1) بنود قائمة الدخل التي سنبحث عنها ----------
    const IS_ITEMS = [
      { key: "revenue", label: "الإيرادات", kws: ["الإيرادات", "revenue"] },
      { key: "cogs", label: "تكلفة الإيرادات", kws: ["تكلفة الإيرادات", "cost of revenue", "cost of sales"] },
      { key: "grossProfit", label: "مجمل الربح", kws: ["مجمل الربح", "gross profit"] },
      { key: "ads", label: "مصروفات دعاية وإعلان", kws: ["مصروفات دعاية وإعلان", "دعاية", "إعلان", "advertising"] },
      { key: "gna", label: "مصروفات عمومية وإدارية", kws: ["مصروفات عمومية وإدارية", "عمومية", "إدارية", "g&a", "general and administrative"] },
      { key: "rnd", label: "مصروفات أبحاث وتطوير", kws: ["مصروفات أبحاث وتطوير", "أبحاث", "تطوير", "r&d", "research and development"] },
      { key: "operatingProfit", label: "الربح التشغيلي", kws: ["الربح التشغيلي", "operating profit", "operating income"] },
    ];

    // ---------- 2) نلتقط "رأس الأعمدة" إن أمكن (سنوات/فترات) ----------
    // في عينتك كان فيه صف: 2024م / 2025م ... الخ
    const looksLikeYear = (cell) => {
      const t = norm(cell);
      return /20\d{2}/.test(t) || t.includes("٢٠٢٤") || t.includes("٢٠٢٥");
    };

    // ---------- 3) نبحث داخل كل جدول عن صفوف قائمة الدخل ----------
    // sample في كل جدول عبارة عن Array of rows, كل row عبارة عن Array cells.
    const results = {};
    const hits = []; // للتتبع

    for (const table of tablesPreviewNormalized) {
      const sample = Array.isArray(table.sample) ? table.sample : [];
      if (!sample.length) continue;

      // اكتشاف صف السنوات (اختياري)
      let headerYears = null;
      for (const row of sample.slice(0, 6)) {
        const yearCells = row.filter(looksLikeYear);
        if (yearCells.length >= 2) {
          headerYears = row;
          break;
        }
      }

      for (const row of sample) {
        // نجمع نص الصف كله
        const rowText = row.map((c) => String(c ?? "")).join(" | ");

        // لو الصف لا يحتوي أي كلمة من قائمة الدخل، تجاهله بسرعة
        const quickIS = containsAny(rowText, [
          "الإيرادات",
          "تكلفة الإيرادات",
          "مجمل الربح",
          "مصروفات",
          "الربح التشغيلي",
          "income",
          "profit",
        ]);
        if (!quickIS) continue;

        for (const item of IS_ITEMS) {
          if (!containsAny(rowText, item.kws)) continue;

          // نحاول استخراج الأرقام من نفس الصف:
          // نأخذ كل الخلايا التي يمكن تحويلها إلى رقم
          const numericCells = [];
          for (let i = 0; i < row.length; i++) {
            const v = row[i];
            const n = parseArabicNumber(v);
            if (typeof n === "number" && Number.isFinite(n)) {
              numericCells.push({ colIndex: i, raw: v, value: n });
            }
          }

          // إذا ما فيه أرقام، نسجل hit بدون أرقام
          if (!numericCells.length) {
            hits.push({
              tableIndex: table.index ?? null,
              item: item.key,
              label: item.label,
              row,
              note: "Matched label but no numeric cells",
            });
            continue;
          }

          // نخزن أفضل نتيجة (أول مرة) أو إذا كانت أقوى (عدد أرقام أكثر)
          const current = results[item.key];
          const candidate = {
            label: item.label,
            tableIndex: table.index ?? null,
            headerYears,
            row,
            numbers: numericCells,
          };

          if (!current || (candidate.numbers?.length || 0) > (current.numbers?.length || 0)) {
            results[item.key] = candidate;
          }

          hits.push({
            tableIndex: table.index ?? null,
            item: item.key,
            label: item.label,
            numbersCount: numericCells.length,
          });
        }
      }
    }

    // ---------- 4) تبسيط شكل الإخراج للمستخدم ----------
    // نخرج لكل بند: رقمين (غالبًا 2024/2025) إن توفروا
    const simplify = (entry) => {
      if (!entry) return null;

      // خذ أول رقمين على اليسار (أحيانًا تكون الأعمدة 2024/2025)
      // ملاحظة: هذا “نسخة 1” وسنحسن اختيار الأعمدة في الخطوة التالية.
      const nums = Array.isArray(entry.numbers) ? entry.numbers : [];
      const picked = nums.slice(0, 4).map((x) => x.value);

      return {
        label: entry.label,
        tableIndex: entry.tableIndex,
        values: picked,
        // للاطلاع فقط:
        row: entry.row,
        headerYears: entry.headerYears,
      };
    };

    const incomeStatement = {};
    for (const item of IS_ITEMS) {
      incomeStatement[item.key] = simplify(results[item.key]);
    }

    return send(200, {
      ok: true,
      financial: {
        incomeStatement: {
          ok: true,
          items: incomeStatement,
          debug: {
            tablesPreviewNormalizedCount: tablesPreviewNormalized.length,
            hitsCount: hits.length,
            hitsSample: hits.slice(0, 50),
          },
        },
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
