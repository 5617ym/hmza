// api/upload-url/index.js
const crypto = require("crypto");

function toSasTime(date) {
  // format: YYYY-MM-DDTHH:mm:ssZ
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

    // ✅ env vars required
    const account = process.env.STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.STORAGE_ACCOUNT_KEY; // base64 key from Azure
    const container = process.env.BLOB_CONTAINER || "uploads";

    if (!account || !accountKey) {
      return send(500, { ok: false, error: "Storage غير مهيأ (STORAGE_ACCOUNT_NAME/KEY)" });
    }

    const body = req.body || {};
    const originalName = (body.fileName || "file.pdf").toString();
    const ext = originalName.includes(".") ? "." + originalName.split(".").pop() : "";
    const safeExt = ext.length <= 10 ? ext : "";
    const blobName =
      (Date.now().toString() + "-" + crypto.randomBytes(6).toString("hex") + safeExt).toLowerCase();

    // SAS times
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 1000); // -2 min clock skew
    const expiry = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes

    const sv = "2022-11-02"; // stable
    const sp = "rw"; // read + write (upload + DI read using same URL)
    const sr = "b";
    const se = toSasTime(expiry);
    const st = toSasTime(start);
    const spr = "https";
    const si = ""; // not using stored access policy

    // canonicalized resource
    const canonicalizedResource = `/blob/${account}/${container}/${blobName}`;

    // string-to-sign (service SAS)
    // Format (for 2022-11-02):
    // sp\nst\nse\ncanonicalizedResource\n\n\nspr\nsv\nsr\n\n\n\n\n
    const stringToSign = [
      sp,
      st,
      se,
      canonicalizedResource,
      "", // signedIdentifier
      "", // signedIP
      spr,
      sv,
      sr,
      "", // signedSnapshotTime
      "", // rscc
      "", // rscd
      "", // rsce
      "", // rscl
      "", // rsct
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

    const uploadUrl = `${baseUrl}?${sasQuery}`; // PUT to this
    const blobUrl = uploadUrl; // DI can read using same SAS (has r)

    return send(200, {
      ok: true,
      container,
      blobName,
      uploadUrl,
      blobUrl
    });
  } catch (err) {
    return send(500, { ok: false, error: err.message || "Unhandled error" });
  }
};
