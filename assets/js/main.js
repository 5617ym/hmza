async function analyzeSingleFile(file) {
  // 1) get uploadUrl + blobUrl
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/pdf",
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j1 = await r1.json().catch(() => null);
  if (!r1.ok || !j1?.ok) {
    throw new Error(`upload-url failed: ${r1.status} ${JSON.stringify(j1)}`);
  }

  // 2) PUT to Azure Blob via SAS
  const put = await fetch(j1.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!put.ok) {
    const t = await put.text().catch(() => "");
    throw new Error(`PUT failed: ${put.status} ${t}`);
  }

  // 3) analyze by blobUrl
  const r2 = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      blobUrl: j1.blobUrl,
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j2 = await r2.json().catch(() => null);
  if (!r2.ok || !j2?.ok) {
    throw new Error(`analyze failed: ${r2.status} ${JSON.stringify(j2)}`);
  }

  return j2;
}
