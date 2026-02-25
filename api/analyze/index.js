module.exports = async function (context, req) {
  try {
    // GET للتأكد السريع
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

    // POST: نتوقع JSON بالشكل التالي:
    // { fileName: "report.pdf", fileBase64: "...." }
    const body = req.body || {};
    const fileName = body.fileName || "uploaded.pdf";
    const fileBase64 = body.fileBase64;

    if (!fileBase64 || typeof fileBase64 !== "string") {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { ok: false, error: "لم يتم إرسال fileBase64" },
      };
      return;
    }

    // إزالة بادئة data:application/pdf;base64, لو كانت موجودة
    const cleaned = fileBase64.includes("base64,")
      ? fileBase64.split("base64,")[1]
      : fileBase64;

    const buffer = Buffer.from(cleaned, "base64");

    // “بصمة” أول 4 بايت من PDF غالبًا تكون %PDF
    const first4 = buffer.slice(0, 4).toString("utf8");

    context.res = {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: true,
        received: true,
        fileName,
        bytes: buffer.length,
        first4,
        note:
          first4 === "%PDF"
            ? "واضح أنه ملف PDF ✅"
            : "قد لا يكون PDF أو التحويل Base64 غير صحيح",
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { ok: false, error: err?.message || "خطأ غير معروف" },
    };
  }
};
