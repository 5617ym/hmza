const pdfParse = require("pdf-parse");

module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "GET") {
      context.res = {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: {
          message: "API شغالة بنجاح 🚀",
          timestamp: new Date().toISOString(),
        },
      };
      return;
    }

    const body = req.body || {};
    const fileName = body.fileName || "uploaded.pdf";
    const fileBase64 = body.fileBase64;

    if (!fileBase64) {
      context.res = {
        status: 400,
        body: { ok: false, error: "لم يتم إرسال fileBase64" },
      };
      return;
    }

    const cleaned = fileBase64.includes("base64,")
      ? fileBase64.split("base64,")[1]
      : fileBase64;

    const buffer = Buffer.from(cleaned, "base64");

    // استخراج النص
    const parsed = await pdfParse(buffer);
    const text = parsed.text || "";

    context.res = {
      status: 200,
      body: {
        ok: true,
        pages: parsed.numpages,
        textLength: text.length,
        preview: text.substring(0, 1000)
      },
    };

  } catch (err) {
    context.res = {
      status: 500,
      body: { ok: false, error: err.message },
    };
  }
};
