// api/analyze/index.js

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

    const body = req.body || {};
    const fileName = body.fileName || "unknown.pdf";
    const blobUrl = body.blobUrl;

    if (!blobUrl) {
      return send(400, { ok: false, error: "blobUrl مطلوب" });
    }

    const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = process.env.DOCUMENT_INTELLIGENCE_KEY;

    if (!endpoint || !key) {
      return send(500, { ok: false, error: "Document Intelligence غير مهيأ" });
    }

    // 1️⃣ إرسال طلب التحليل
    const analyzeResponse = await fetch(
      `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2023-10-31-preview`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          urlSource: blobUrl,
        }),
      }
    );

    if (!analyzeResponse.ok) {
      const t = await analyzeResponse.text();
      return send(500, { ok: false, error: "فشل بدء التحليل", details: t });
    }

    const operationLocation = analyzeResponse.headers.get("operation-location");

    if (!operationLocation) {
      return send(500, { ok: false, error: "لم يتم إرجاع operation-location" });
    }

    // 2️⃣ انتظار اكتمال المعالجة
    let result;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const poll = await fetch(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": key },
      });

      result = await poll.json();

      if (result.status === "succeeded") break;
      if (result.status === "failed") {
        return send(500, { ok: false, error: "فشل التحليل", details: result });
      }
    }

    if (!result || result.status !== "succeeded") {
      return send(500, { ok: false, error: "انتهت مهلة الانتظار" });
    }

    const fullText = (result.analyzeResult.content || "").trim();

    return send(200, {
      ok: true,
      fileName,
      textLength: fullText.length,
      tables: result.analyzeResult.tables?.length || 0,
      pages: result.analyzeResult.pages?.length || 0,
    });

  } catch (err) {
    return send(500, {
      ok: false,
      error: err.message || "Unhandled error",
      stack: err.stack || null,
    });
  }
};
