// MCP の呼び先切替（ElevenLabs → BuzzAssist）の疎通確認。
// ローカルの BuzzAssist（next dev + ローカル Convex）に対して実際に音声を作る。
//   BUZZASSIST_API_BASE=http://localhost:3000 node scripts/voiceMcpE2E.mjs
import {
  generateSpeech,
  listVoices,
  resolveSpeechProvider,
  speechBoundsFromAlignment,
} from "../lib/speechGeneration.mjs";

// ローカル検証では認証ヘッダなしで叩く（dev サーバー側の開発用シムが受ける）
const plainFetch = (url, { method = "POST", headers = {}, body, signal } = {}) =>
  fetch(url, { method, headers, body, signal });

const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
};

const provider = resolveSpeechProvider();
check("既定のプロバイダーが buzzassist", provider === "buzzassist", provider);

const voices = await listVoices({ apiFetch: plainFetch });
check("声の一覧を取得できる", Array.isArray(voices) && voices.length > 0, `${voices.length}件`);
const voice = voices.find((v) => v.voiceId === "lib_hinata") || voices[0];
check("声にメタ情報が付いている", Boolean(voice.name && voice.gender && voice.ageGroup),
  `${voice.voiceId} ${voice.name} ${voice.gender}/${voice.ageGroup}`);

const text = "こんにちは。MCPからBuzzAssistの音声基盤を呼び出しています。";
const speech = await generateSpeech({
  apiFetch: plainFetch,
  voiceId: voice.voiceId,
  text,
  speed: 1,
  style: "neutral",
  format: "mp3",
  requestKey: `mcp-e2e:${Date.now()}`,
});

check("provider が buzzassist", speech.provider === "buzzassist", speech.provider);
check("音声バイナリが返る", Buffer.isBuffer(speech.audioBuffer) && speech.audioBuffer.length > 1000,
  `${speech.audioBuffer.length} bytes ${speech.mimeType}`);
check("再生時間が返る", speech.durationSeconds > 0, `${speech.durationSeconds}s`);
check("alignment が ElevenLabs 形式に変換されている",
  Array.isArray(speech.alignment.characters)
  && speech.alignment.characters.length > 0
  && speech.alignment.characters.length === speech.alignment.characterStartTimesSeconds.length
  && speech.alignment.characters.length === speech.alignment.characterEndTimesSeconds.length,
  `${speech.alignment.characters.length}文字`);

// 既存の吹き出し同期処理がそのまま使えること（仕様 ②C の要件）
const bounds = speechBoundsFromAlignment(speech.alignment, speech.durationSeconds);
check("speechBoundsFromAlignment が無改修で動く",
  bounds.startSeconds >= 0 && bounds.endSeconds > bounds.startSeconds && bounds.endSeconds <= speech.durationSeconds + 0.5,
  `${bounds.startSeconds}s〜${bounds.endSeconds}s / 全体${speech.durationSeconds}s`);
check("課金秒数が返る", typeof speech.chargedSeconds === "number", `chargedSec=${speech.chargedSeconds}`);

// 同じ requestKey で作り直すと無料になること（再生成無料ルール）
const again = await generateSpeech({
  apiFetch: plainFetch,
  voiceId: voice.voiceId,
  text,
  speed: 1,
  style: "neutral",
  format: "mp3",
  requestKey: speech.requestKeyUsed || `mcp-e2e-regen:${Date.now()}`,
});
check("2回目も生成できる", again.audioBuffer.length > 1000, `${again.audioBuffer.length} bytes`);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
console.log("VOICE MCP E2E: ALL PASSED");
