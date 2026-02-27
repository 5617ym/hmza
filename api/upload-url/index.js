// api/upload-url/index.js
const crypto = require("crypto");

function toSasTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hmacSHA256(base64Key, stringToSign) {
  const key = Buffer.from(base64Key, "base64");
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

    const account = process.env.STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.STORAGE_ACCOUNT_KEY; // base64 key from Azure (Key1 value)
    const container = process.env.BLOB_CONTAINER || "uploads";

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

    // SAS times
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 1000);
    const expiry = new Date(now.getTime() + 30 * 60 * 1000);

    // Service SAS (Blob)
    const sv = "2022-11-02";
    const ss = "b";     // signed services: blob
    const srt = "o";    // signed resource types: object
    const sp = "rw";    // permissions
    const se = toSasTime(expiry);
    const st = toSasTime(start);
    const spr = "https";

    // Canonicalized resource for service SAS
    const canonicalizedResource = `/blob/${account}/${container}/${blobName}`;

    // IMPORTANT: String-to-sign order for service SAS (sv 2022-11-02)
    // sp\nst\nse\ncanonicalizedResource\nsi\nsip\nspr\nsv\nsr\nskt\nske\nsks\nskv\nrscc\nrscd\nrsce\nrscl\nrsct
    // Here we are NOT using:
    // - stored access policy (si)
    // - signed IP (sip)
    // - signed key (skt/ske/sks/skv)
    // - response headers (rscc..rsct)
    const sr = "b";
    const stringToSign = [
      sp,
      st,
      se,
      canonicalizedResource,
      "",   // si
      "",   // sip
      spr,
      sv,
      sr,
      "",   // skt
      "",   // ske
      "",   // sks
      "",   // skv
      "",   // rscc
      "",   // rscd
      "",   // rsce
      "",   // rscl
      "",   // rsct
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
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
