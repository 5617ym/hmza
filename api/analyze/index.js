// api/analyze/index.js
// تحليل PDF/صور عبر Azure Document Intelligence (prebuilt-layout)

const { normalizeAnalyzeResult } = require("../_lib/normalize-di");

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

    const ep = endpoint.replace(/\/+$/, "");
    const model = "prebuilt-layout";
    const apiVersion = "2023-07-31";
    const analyzeUrl = `${ep}/formrecognizer/documentModels/${model}:analyze?api-version=${apiVersion}`;

    // 1) Start
    const start = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": key,
      },
      body: JSON.stringify({ urlSource: blobUrl }),
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

    // 2) Poll
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const maxTries = 60;
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
      return send(504, { ok: false, error: "DI timeout", details: last });
    }

    const analyzeResult = last.analyzeResult || {};
    const normalized = normalizeAnalyzeResult(analyzeResult);

    return send(200, {
      ok: true,
      fileName: fileName || null,

      // ✅ قياسات ثابتة
      pages: normalized.pagesCount,
      tables: normalized.tablesCount,
      textLength: normalized.textLength,
      sampleText: normalized.sampleText,

      // ✅ Debug مفيد
      diModel: model,
      diApiVersion: apiVersion,
      diStatus: last.status,
      diPagesLen: normalized.pagesCount,
      diPageNumbers: normalized.pageNumbers,
      diWarnings: last?.analyzeResult?.warnings || null,

      // ✅ ناتج موحّد نستخدمه لاحقًا لاستخراج الأرقام
      normalized,
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
