// api/upload-url/index.js
const crypto = require("crypto");

function toSasTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hmacSHA256(base64Key, stringToSign) {
  // ✅ trim to remove hidden whitespace/newlines that break HMAC
  const cleaned = (base64Key || "").trim();
  const key = Buffer.from(cleaned, "base64");
  return crypto.createHmac("sha256", key).update(stringToSign, "utf8").digest("base64");
}

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

    // ✅ trim all inputs
    const account = (process.env.STORAGE_ACCOUNT_NAME || "").trim();
    const accountKey = (process.env.STORAGE_ACCOUNT_KEY || "").trim(); // base64 Key1 value
    const container = (process.env.BLOB_CONTAINER || "uploads").trim();

    if (!account || !accountKey) {
      return send(500, { ok: false, error: "Storage غير مهيأ (STORAGE_ACCOUNT_NAME/KEY)" });
    }

    const body = req.body || {};
    const originalName = (body.fileName || "file.pdf").toString();

    const ext = originalName.includes(".") ? "." + originalName.split(".").pop() : "";
    const safeExt = ext.length <= 10 ? ext : "";

    const blobName = (
      Date.now().toString() + "-" + crypto.randomBytes(6).toString("hex") + safeExt
    ).toLowerCase();

    const now = new Date();
    const st = toSasTime(new Date(now.getTime() - 2 * 60 * 1000));
    const se = toSasTime(new Date(now.getTime() + 30 * 60 * 1000));

    const sv = "2022-11-02";
    const spr = "https";
    const sp = "rw";
    const sr = "b";

    const canonicalizedResource = `/blob/${account}/${container}/${blobName}`;

    // sp \n st \n se \n canonicalizedResource \n si \n sip \n spr \n sv \n sr
    const stringToSign = [
      sp,
      st,
      se,
      canonicalizedResource,
      "", // si
      "", // sip
      spr,
      sv,
      sr,
    ].join("\n");

    const sig = encodeURIComponent(hmacSHA256(accountKey, stringToSign));

    const baseUrl = `https://${account}.blob.core.windows.net/${container}/${blobName}`;
    const sasQuery =
      `sv=${encodeURIComponent(sv)}` +
      `&spr=${encodeURIComponent(spr)}` +
      `&st=${encodeURIComponent(st)}` +
      `&se=${encodeURIComponent(se)}` +
      `&sr=${encodeURIComponent(sr)}` +
      `&sp=${encodeURIComponent(sp)}` +
      `&sig=${sig}`;

    const uploadUrl = `${baseUrl}?${sasQuery}`;

    return send(200, { ok: true, container, blobName, uploadUrl, blobUrl: uploadUrl });
  } catch (err) {
    return send(500, { ok: false, error: err?.message || "Unhandled error" });
  }
};
