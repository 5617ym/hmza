// api/analyze/index.js
// تحليل PDF/صور عبر Azure Document Intelligence (prebuilt-layout)
// ✅ الإصلاح: تحميل الـ PDF من blobUrl داخل السيرفر ثم إرساله لـ DI كـ bytes (بدون urlSource)

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

    const { fileName, blobUrl } = req.body || {};
    if (!blobUrl) return send(400, { ok: false, error: "blobUrl مطلوب" });

    const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT || "";
    const key = process.env.DOCUMENT_INTELLIGENCE_KEY || "";

    if (!endpoint || !key) {
      return send(500, {
        ok: false,
        error: "DI secrets missing",
        details: {
          hasEndpoint: Boolean(endpoint),
          hasKey: Boolean(key),
          expectedEnv: ["DOCUMENT_INTELLIGENCE_ENDPOINT", "DOCUMENT_INTELLIGENCE_KEY"],
        },
      });
    }

    // 0) حمّل الملف من Blob داخل السيرفر (لتجنب مشاكل DI مع urlSource)
    const blobRes = await fetch(blobUrl, { method: "GET" });
    if (!blobRes.ok) {
      const t = await blobRes.text().catch(() => "");
      return send(500, {
        ok: false,
        error: "Failed to download blob",
        status: blobRes.status,
        body: t.slice(0, 2000),
      });
    }

    const blobContentType =
      blobRes.headers.get("content-type") || "application/pdf";
    const blobArrayBuffer = await blobRes.arrayBuffer();
    const fileBytes = blobArrayBuffer.byteLength;
    const fileBuffer = Buffer.from(blobArrayBuffer);

    // 1) ابدأ التحليل بتمرير bytes مباشرة
    const ep = endpoint.replace(/\/+$/, "");
    const model = "prebuilt-layout";
    const apiVersion = "2023-07-31";
    const analyzeUrl = `${ep}/formrecognizer/documentModels/${model}:analyze?api-version=${apiVersion}`;

    const start = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": blobContentType,
      },
      body: fileBuffer,
    });

    const startText = await start.text().catch(() => "");
    if (!start.ok) {
      return send(500, {
        ok: false,
        error: "DI start failed",
        status: start.status,
        body: startText.slice(0, 2000),
      });
    }

    const operationLocation =
      start.headers.get("operation-location") ||
      start.headers.get("Operation-Location");

    if (!operationLocation) {
      return send(500, {
        ok: false,
        error: "Missing operation-location from DI",
        body: startText.slice(0, 2000),
      });
    }

    // 2) Polling لنتيجة التحليل
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const maxTries = 45; // ~45 ثانية
    let last = null;

    for (let i = 0; i < maxTries; i++) {
      const r = await fetch(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": key },
      });

      const j = await r.json().catch(() => null);
      last = j;

      if (!r.ok) {
        return send(500, {
          ok: false,
          error: "DI poll failed",
          status: r.status,
          body: j || null,
        });
      }

      const st = (j?.status || "").toLowerCase();
      if (st === "succeeded") break;

      if (st === "failed") {
        return send(500, {
          ok: false,
          error: "DI analysis failed",
          details: j,
        });
      }

      await sleep(1000);
    }

    if (!last || (last.status || "").toLowerCase() !== "succeeded") {
      return send(504, {
        ok: false,
        error: "DI timeout",
        details: last,
      });
    }

    // 3) أرقام واضحة
    const analyzeResult = last.analyzeResult || {};
    const pagesArr = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
    const tablesArr = Array.isArray(analyzeResult.tables) ? analyzeResult.tables : [];

    const pages = pagesArr.length; // ✅ هذا هو عدد الصفحات الحقيقي حسب DI
    const tables = tablesArr.length;

    const content = analyzeResult.content || "";
    const textLength = content.length;

    return send(200, {
      ok: true,
      fileName: fileName || null,
      pages,
      tables,
      textLength,
      sampleText: content.slice(0, 500),

      // مفيدة للتأكد أن الملف كامل عندنا قبل DI
      fileBytes,
      blobContentType,
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
