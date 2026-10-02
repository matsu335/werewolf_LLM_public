/**
 * 観察用の日本語訳をサーバー側で作るプロバイダ。既定はブラウザ内蔵の翻訳（外部送信なし）で、
 * これは DEEPL_API_KEY が設定されているときだけ使う予備の経路。訳文はゲームにもLLMにも戻さない。
 */
export function serverTranslationProvider() {
  return process.env.DEEPL_API_KEY ? "deepl" : null;
}

export async function translateWithServerProvider(texts, source, target) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) return null;
  if (!texts.length) return { provider: "deepl", texts: [] };
  // 無料版のキーは末尾が ":fx" で、エンドポイントが異なる。
  const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const response = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({ text: texts, source_lang: source.toUpperCase(), target_lang: target.toUpperCase() }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`DeepL HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  return { provider: "deepl", texts: data.translations.map((row) => row.text) };
}
