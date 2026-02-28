// api/ingest/index.js
module.exports = async function (context, req) {
  const send = (status, payload) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: payload,
    };
  };

  try {
    if ((req.method || "").toUpperCase() !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    const { fileName, blobUrl, contentType } = req.body || {};
    if (!blobUrl) return send(400, { ok: false, error: "blobUrl مطلوب" });

    const name = (fileName || "").toLowerCase();
    const ct = (contentType || "").toLowerCase();

    const isPdf = name.endsWith(".pdf") || ct.includes("pdf");
    const isImage =
      ct.startsWith("image/") ||
      /\.(png|jpg|jpeg|webp|tiff|bmp)$/i.test(name);

    const isCsv = name.endsWith(".csv") || ct.includes("csv");
    const isXlsx =
      /\.(xlsx|xls)$/i.test(name) ||
      ct.includes("spreadsheet") ||
      ct.includes("excel");

    const isDocx =
      name.endsWith(".docx") ||
      ct.includes("wordprocessingml") ||
      ct.includes("msword");

    // ✅ المرحلة الحالية: نوجّه فقط (نحلل PDF/صور بـ DI الآن)
    if (isPdf || isImage) {
      // استدعاء محلل الـPDF الحالي عندك
      // نفس input المتوقع في /api/analyze
      const analyzeUrl = "/api/analyze";
      return send(200, {
        ok: true,
        route: "analyze",
        next: analyzeUrl,
        payload: { fileName, blobUrl },
        note: "هذا توجيه فقط. استدعِ /api/analyze بنفس البيانات.",
      });
    }

    // الأنواع الأخرى (نفعّلها في الخطوة التالية بدون تشعب)
    if (isCsv) return send(200, { ok: true, route: "csv", next: "/api/parse-csv" });
    if (isXlsx) return send(200, { ok: true, route: "excel", next: "/api/parse-excel" });
    if (isDocx) return send(200, { ok: true, route: "word", next: "/api/parse-word" });

    return send(400, {
      ok: false,
      error: "نوع ملف غير مدعوم حالياً",
      details: { fileName, contentType },
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
