// Mac のローカル生成（Ollama の画像生成）——FLUX.2 klein 4B / Z-Image Turbo を運営者の手元で動かす。
//
// 守ること:
//   - 手元（127.0.0.1 / localhost / ::1）の Ollama だけに話す。素材とプロンプトを外へ送らない
//   - 使えるかを先に確かめる（Ollama が動いているか・モデルが入っているか）。無ければ、何が無いかと、
//     運営者が自分で打つコマンドを返す。モデルを勝手にダウンロードしない（/api/pull は呼ばない）
//   - 生成は運営者の確認のあとに呼ぶ（ここは確認を取らない。呼ぶ側の工程が確認を持つ）
//   - モデルの名前は Ollama のライブラリの表記に合わせて変えられる（既定は調査時点の表記で、実測していない）
//
// fetchImpl を差し替えればテストで通信しない。

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const OLLAMA_LOCAL_IMAGE_VERSION = "optimal-config-ollama-local-image-v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** 構成表の id → Ollama のモデル名（既定。運営者の環境で違えば modelName で渡す）。 */
export const OLLAMA_IMAGE_MODELS = Object.freeze({
  "flux2-klein-4b": "x/flux2-klein:4b",
  "z-image-turbo": "x/z-image-turbo",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** 手元の Ollama の URL だけを受け付ける（外の host へ素材を送らない）。 */
export function assertLoopbackBaseUrl(baseUrl = DEFAULT_OLLAMA_BASE_URL) {
  let url;
  try { url = new URL(baseUrl); } catch { throw codedError("ollama-base-url-invalid", `Ollama の URL として読めない: ${baseUrl}`); }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw codedError("ollama-not-local", `Ollama は手元（127.0.0.1 / localhost）のものだけを使う。${url.hostname} へは素材を送らない。`);
  }
  return url.origin;
}

export function ollamaModelName(catalogModelId, modelName = "") {
  const name = String(modelName || "").trim() || OLLAMA_IMAGE_MODELS[catalogModelId] || "";
  if (!name) throw codedError("ollama-model-unmapped", `${catalogModelId} を Ollama で動かす名前が分からない（手元で動かせるのは ${Object.keys(OLLAMA_IMAGE_MODELS).join(" / ")}）。`);
  return name;
}

function sameModel(installed, wanted) {
  const strip = (value) => String(value || "").replace(/:latest$/u, "");
  return strip(installed) === strip(wanted);
}

async function getJson(fetchImpl, url, { timeoutMs }) {
  const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw codedError("ollama-http-error", `${url} が ${response.status} を返した。`, { status: response.status });
  return response.json();
}

/**
 * 使えるかを確かめる（読むだけ。ダウンロードしない）。
 * 返す: { available, running, version, model, modelPresent, reasons: [{ code, message }], operatorCommands: [...] }
 */
export async function detectOllamaImage({
  catalogModelId = "flux2-klein-4b",
  modelName = "",
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  const origin = assertLoopbackBaseUrl(baseUrl);
  const model = ollamaModelName(catalogModelId, modelName);
  const out = { version: OLLAMA_LOCAL_IMAGE_VERSION, baseUrl: origin, catalogModelId, model, available: false, running: false, serverVersion: null, modelPresent: false, reasons: [], operatorCommands: [] };
  try {
    const info = await getJson(fetchImpl, `${origin}/api/version`, { timeoutMs });
    out.running = true;
    out.serverVersion = typeof info?.version === "string" ? info.version : null;
  } catch (error) {
    out.reasons.push({ code: "ollama-not-running", message: `手元の Ollama（${origin}）に届かない。Ollama のアプリを起動するか、端末で ollama serve を打つ。（${error?.code || error?.name || "接続できない"}）` });
    out.operatorCommands.push("ollama serve");
    return out;
  }
  let tags;
  try {
    tags = await getJson(fetchImpl, `${origin}/api/tags`, { timeoutMs });
  } catch (error) {
    out.reasons.push({ code: "ollama-tags-unreadable", message: `Ollama の入っているモデルの一覧が読めない（${error?.message || error}）。` });
    return out;
  }
  const installed = (Array.isArray(tags?.models) ? tags.models : []).map((row) => row?.name || row?.model).filter(Boolean);
  out.modelPresent = installed.some((name) => sameModel(name, model));
  if (!out.modelPresent) {
    out.reasons.push({
      code: "ollama-model-missing",
      message: `モデル ${model} が手元の Ollama に入っていない（入っているもの: ${installed.join(", ") || "なし"}）。ハーネスは勝手にダウンロードしない。入れるなら運営者が自分の端末で ollama pull ${model} を打つ（数 GB のダウンロード）。`,
    });
    out.operatorCommands.push(`ollama pull ${model}`);
    return out;
  }
  out.available = true;
  return out;
}

function decodeImage(body) {
  const encoded = typeof body?.image === "string" ? body.image : Array.isArray(body?.images) && typeof body.images[0] === "string" ? body.images[0] : "";
  if (!encoded) throw codedError("ollama-no-image", "Ollama の応答に画像が無い（image / images が空）。");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 8) throw codedError("ollama-no-image", "Ollama の応答の画像が壊れている。");
  return bytes;
}

/**
 * 手元で1枚作る。先に detectOllamaImage で使えることを確かめ、使えなければ理由で止める（ダウンロードしない）。
 * 返す記録は10カット試験の欄（dataDestination: local、cashCostJpy: 0）に写せる形。
 */
export async function generateOllamaImage({
  catalogModelId = "flux2-klein-4b",
  modelName = "",
  prompt,
  width = 1024,
  height = 1024,
  steps = null,
  seed = null,
  outputPath,
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw codedError("ollama-prompt-missing", "プロンプトが要る。");
  if (typeof outputPath !== "string" || !outputPath.trim()) throw codedError("ollama-output-missing", "書き出す画像のパス（outputPath）が要る。");
  const detected = await detectOllamaImage({ catalogModelId, modelName, baseUrl, fetchImpl });
  if (!detected.available) {
    throw codedError("ollama-unavailable", detected.reasons.map((item) => item.message).join(" "), { detected });
  }
  const started = now();
  const body = { model: detected.model, prompt, stream: false, width, height, ...(Number.isFinite(steps) ? { steps } : {}), ...(Number.isFinite(seed) ? { seed } : {}) };
  const response = await fetchImpl(`${detected.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw codedError("ollama-http-error", `Ollama の生成が ${response.status} を返した。`, { status: response.status });
  const bytes = decodeImage(await response.json());
  const target = path.resolve(outputPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return {
    version: OLLAMA_LOCAL_IMAGE_VERSION,
    catalogModelId,
    model: detected.model,
    serverVersion: detected.serverVersion,
    outputPath: target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    width,
    height,
    steps: Number.isFinite(steps) ? steps : null,
    waitSeconds: Math.round((now() - started) / 100) / 10,
    cashCostJpy: 0,
    dataDestination: "local",
    runtime: { name: "ollama", version: detected.serverVersion, place: "operator-mac" },
  };
}
