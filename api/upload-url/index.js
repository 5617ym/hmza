// api/upload-url/index.js

const {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require("@azure/storage-blob");

module.exports = async function (context, req) {
  const send = (status, body) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body
    };
  };

  try {
    if ((req.method || "").toUpperCase() !== "POST") {
      return send(405, { ok: false, error: "Method not allowed" });
    }

    const account = (process.env.STORAGE_ACCOUNT_NAME || "").trim();
    const accountKey = (process.env.STORAGE_ACCOUNT_KEY || "").trim();
    const container = (process.env.BLOB_CONTAINER || "uploads").trim();

    if (!account || !accountKey) {
      return send(500, { ok: false, error: "Storage not configured" });
    }

    const body = req.body || {};
    const originalName = (body.fileName || "file.pdf").toString();

    const ext = originalName.includes(".")
      ? "." + originalName.split(".").pop()
      : "";

    const blobName =
      Date.now().toString() +
      "-" +
      Math.random().toString(16).slice(2) +
      ext;

    const credential = new StorageSharedKeyCredential(account, accountKey);

    const now = new Date();
    const startsOn = new Date(now.getTime() - 2 * 60 * 1000);
    const expiresOn = new Date(now.getTime() + 30 * 60 * 1000);

    const sas = generateBlobSASQueryParameters(
      {
        containerName: container,
        blobName,
        permissions: BlobSASPermissions.parse("rw"),
        startsOn,
        expiresOn
      },
      credential
    ).toString();

    const uploadUrl =
      `https://${account}.blob.core.windows.net/${container}/${blobName}?${sas}`;

    return send(200, {
      ok: true,
      container,
      blobName,
      uploadUrl,
      blobUrl: uploadUrl
    });

  } catch (err) {
    return send(500, { ok: false, error: err.message });
  }
};
