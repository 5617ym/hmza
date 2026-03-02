// api/extract-financial/index.js
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

    const pages = Array.isArray(normalized.pages) ? normalized.pages : [];
    const tables = Array.isArray(normalized.tables) ? normalized.tables : [];

    // كلمات مفتاحية لاكتشاف صفحات القوائم
    const KW = {
      bs: [
        "قائمة المركز المالي",
        "قائمة الوضع المالي",
        "الميزانية",
        "الميزانية العمومية",
        "Statement of Financial Position",
        "Balance Sheet",
      ],
      is: [
        "قائمة الدخل",
        "قائمة الربح والخسارة",
        "قائمة الأرباح والخسائر",
        "Income Statement",
        "Profit & Loss",
        "P&L",
      ],
      cf: [
        "قائمة التدفقات النقدية",
        "بيان التدفقات النقدية",
        "Cash Flow Statement",
        "Statement of Cash Flows",
      ],
      eq: [
        "قائمة التغيرات في حقوق الملكية",
        "Statement of Changes in Equity",
        "Statement of Shareholders' Equity",
      ],
    };

    const norm = (s) => String(s || "").toLowerCase();
    const hasAny = (text, arr) => arr.some((k) => norm(text).includes(norm(k)));

    // 1) اكتشاف صفحات القوائم اعتمادًا على نص الصفحة
    const detected = { balanceSheet: [], incomeStatement: [], cashFlow: [], equity: [] };

    for (const p of pages) {
      const pageNumber = p.pageNumber ?? p.page ?? null;
      const text = p.text || "";
      if (!pageNumber) continue;

      if (hasAny(text, KW.bs)) detected.balanceSheet.push(pageNumber);
      if (hasAny(text, KW.is)) detected.incomeStatement.push(pageNumber);
      if (hasAny(text, KW.cf)) detected.cashFlow.push(pageNumber);
      if (hasAny(text, KW.eq)) detected.equity.push(pageNumber);
    }

    // إزالة تكرار + ترتيب
    const uniqSort = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b);
    detected.balanceSheet = uniqSort(detected.balanceSheet);
    detected.incomeStatement = uniqSort(detected.incomeStatement);
    detected.cashFlow = uniqSort(detected.cashFlow);
    detected.equity = uniqSort(detected.equity);

    // 2) اختيار أهم الجداول: التي تقع ضمن الصفحات المكتشفة أو قريبة منها
    const allDetectedPages = uniqSort([
      ...detected.balanceSheet,
      ...detected.incomeStatement,
      ...detected.cashFlow,
      ...detected.equity,
    ]);

    const near = (p, targets) => targets.some((t) => Math.abs((p || 0) - t) <= 1);

    const pickedTables = tables
      .filter((t) => {
        const pn = t.pageNumber ?? t.page ?? null;
        if (!pn) return false;
        if (allDetectedPages.length === 0) return true; // إذا ما اكتشفنا صفحات، خذ الكل مؤقتًا
        return near(pn, allDetectedPages);
      })
      .slice(0, 20); // حد مبدئي

    // 3) استخراج أرقام مبدئي (بسيط جدًا الآن): نجمع كل الأرقام من نص الصفحات المكتشفة
    // ملاحظة: هذا "Draft" وسنحسنه بالخطوات القادمة لاستخراج البنود المسماة.
    const numericRegex = /[-+]?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?/g;

    const numberHits = [];
    const targetPagesSet = new Set(allDetectedPages);

    for (const p of pages) {
      const pn = p.pageNumber ?? p.page ?? null;
      if (!pn) continue;
      if (allDetectedPages.length > 0 && !targetPagesSet.has(pn)) continue;

      const text = String(p.text || "");
      const matches = text.match(numericRegex) || [];
      for (const m of matches.slice(0, 200)) {
        numberHits.push({ page: pn, raw: m });
      }
    }

    return send(200, {
      ok: true,
      financial: {
        pagesDetected: detected,
        tablesPickedCount: pickedTables.length,
        tablesPicked: pickedTables,
        numbersSampleCount: numberHits.length,
        numbersSample: numberHits.slice(0, 200),
      },
    });
  } catch (e) {
    return send(500, { ok: false, error: e.message || String(e) });
  }
};
