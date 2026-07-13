const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

process.stdout.write(JSON.stringify({
  success: true,
  mimeType: "video/mp4",
  fileName: payload.fileName,
  base64: "AAAA",
}));
