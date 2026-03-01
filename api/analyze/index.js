// api/analyze/index.js
// تحليل PDF/صور عبر Azure Document Intelligence (prebuilt-layout)

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

    const endpoint =
      process.env.AZURE_DI_ENDPOINT || process.env.DI_ENDPOINT || "";
    const key = process.env.AZURE_DI_KEY || process.env.DI_KEY || "";

    if (!endpoint || !key) {
      return send(500, {
        ok: false,
        error: "DI secrets missing",
        details: {
          hasEndpoint: Boolean(endpoint),
          hasKey: Boolean(key),
          expectedEnv: ["AZURE_DI_ENDPOINT", "AZURE_DI_KEY"],
        },
      });
    }

    const ep = endpoint.replace(/\/+$/, "");
    const model = "prebuilt-layout";
    const apiVersion = "2023-07-31"; // ثابت ومناسب
    const analyzeUrl = `${ep}/documentintelligence/documentModels/${model}:analyze?api-version=${apiVersion}&stringIndexType=utf16CodeUnit`;

    // 1) ابدأ التحليل (نعطيه blobUrl مباشرة)
    const start = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": key,
      },
      body: JSON.stringify({
        urlSource: blobUrl,
      }),
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
    const maxTries = 35; // ~35 ثانية لو انتظرنا 1s
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

      const status = (j?.status || "").toLowerCase();

      if (status === "succeeded") break;
      if (status === "failed") {
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

    const analyzeResult = last.analyzeResult || {};
    const pages = Array.isArray(analyzeResult.pages)
      ? analyzeResult.pages.length
      : 0;
    const tables = Array.isArray(analyzeResult.tables)
      ? analyzeResult.tables.length
      : 0;

    // النص: DI يعطي content شامل
    const content = analyzeResult.content || "";
    const textLength = content.length;

    return send(200, {
      ok: true,
      fileName: fileName || null,
      pages,
      tables,
      textLength,
      // مختصر مفيد لتأكيد وجود بيانات
      sampleText: content.slice(0, 500),
      // لو تحتاج تتوسع لاحقاً نخزن raw كامل (حالياً نخليه مخفف)
      // raw: analyzeResult,
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
