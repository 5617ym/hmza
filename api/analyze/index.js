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

  // fetch في بعض بيئات Azure Functions قد لا يكون متاحاً حسب runtime
  const getFetch = async () => {
    if (typeof fetch !== "undefined") return fetch;
    const mod = await import("node-fetch");
    return mod.default;
  };

  try {
    if ((req.method || "").toUpperCase() !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    // ✅ يدعم حالتين:
    // 1) req.body.blobUrl مباشرة
    // 2) req.body.payload.blobUrl لو جاء من ingest
    const body = req.body || {};
    const payload = body.payload && typeof body.payload === "object" ? body.payload : body;

    const fileName = payload.fileName || body.fileName || null;
    const blobUrl = payload.blobUrl || body.blobUrl || null;

    if (!blobUrl) {
      return send(400, {
        ok: false,
        error: "blobUrl مطلوب",
        debug: { hasBody: Boolean(req.body), keys: Object.keys(body || {}) },
      });
    }

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

    const _fetch = await getFetch();

    // 1) start
    const start = await _fetch(analyzeUrl, {
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
      start.headers.get("operation-location") || start.headers.get("Operation-Location");

    if (!operationLocation) {
      return send(500, {
        ok: false,
        error: "Missing operation-location from DI",
        body: startText.slice(0, 2000),
      });
    }

    // 2) poll
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const maxTries = 60; // نخليها 60 ثانية احتياط
    let last = null;

    for (let i = 0; i < maxTries; i++) {
      const r = await _fetch(operationLocation, {
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

    const analyzeResult = last.analyzeResult || {};

    // ✅ عدّ الصفحات الصحيح
    const diPagesLen = Array.isArray(analyzeResult.pages) ? analyzeResult.pages.length : 0;

    const diPageNumbers = Array.isArray(analyzeResult.pages)
      ? analyzeResult.pages
          .map((p) => p?.pageNumber)
          .filter((n) => Number.isFinite(n))
      : [];

    const pages = diPageNumbers.length ? Math.max(...diPageNumbers) : diPagesLen;

    const tables = Array.isArray(analyzeResult.tables) ? analyzeResult.tables.length : 0;

    const content = analyzeResult.content || "";
    const textLength = content.length;

    return send(200, {
      ok: true,
      fileName,
      pages,
      tables,
      textLength,
      sampleText: content.slice(0, 500),

      // Debug مفيد جداً الآن
      diModel: model,
      diApiVersion: apiVersion,
      diStatus: last.status,
      diPagesLen,
      diPageNumbers,
      diWarnings: last?.warnings || null,
    });
  } catch (err) {
    // ✅ أهم شيء: لا نطلع 500 فاضي… لازم نرجع JSON واضح
    return send(500, {
      ok: false,
      error: err?.message || "Unhandled error",
      stack: err?.stack ? String(err.stack).slice(0, 2000) : null,
    });
  }
};
