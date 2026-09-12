from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


worker_path = Path('lambdas/sqs2scouts/function/persistence-processor.mjs')
worker = worker_path.read_text()

worker = replace_once(
    worker,
    """    // Load SDK lazily so local tests don't fail if package is not installed
    let GoogleGenerativeAILib;
    try {
        GoogleGenerativeAILib = (await import('@google/generative-ai')).GoogleGenerativeAI;
    } catch (err) {
        console.warn('[Gemini] @google/generative-ai SDK not available:', err?.message || err);
        return blockedEnrichmentResult('sdk_unavailable', 'manual_review');
    }
""",
    """    // Load SDK lazily so local tests don't fail if package is not installed.
    // @google/genai is the supported Google Gen AI SDK; image generation already
    // uses the same client elsewhere in this worker.
    let GoogleGenAIClient;
    try {
        GoogleGenAIClient = (await import('@google/genai')).GoogleGenAI;
    } catch (err) {
        console.warn('[Gemini] @google/genai SDK not available:', err?.message || err);
        return blockedEnrichmentResult('sdk_unavailable', 'manual_review');
    }
""",
    'replace deprecated SDK import',
)

worker = replace_once(
    worker,
    """        const genAI = new GoogleGenerativeAILib(geminiApiKey);
        const { result, model, attemptedModels } = await generateGeminiTextWithFallback({
            models: GEMINI_TEXT_MODEL_PREFERENCES,
            generate: async (modelName) => {
                const suggestionModel = genAI.getGenerativeModel({
                    model: modelName,
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 2048,
                        responseMimeType: 'application/json',
                        responseSchema: GEMINI_TEXT_RESPONSE_SCHEMAS[stage],
                    },
                });
                console.log('[Gemini] Request payload:', { model: modelName, prompt: prompt.substring(0, 200) + '...' });
                return suggestionModel.generateContent(prompt);
            },
""",
    """        const genAI = new GoogleGenAIClient({
            apiKey: geminiApiKey,
            httpOptions: { apiVersion: GEMINI_API_VERSION },
        });
        const { result, model, attemptedModels } = await generateGeminiTextWithFallback({
            models: GEMINI_TEXT_MODEL_PREFERENCES,
            generate: async (modelName) => {
                console.log('[Gemini] Request payload:', { model: modelName, prompt: prompt.substring(0, 200) + '...' });
                return genAI.models.generateContent({
                    model: modelName,
                    contents: prompt,
                    config: {
                        temperature: 0.3,
                        maxOutputTokens: 2048,
                        responseMimeType: 'application/json',
                        // These schemas are JSON Schema-shaped (lowercase type names),
                        // so use responseJsonSchema rather than the SDK Type enum form.
                        responseJsonSchema: GEMINI_TEXT_RESPONSE_SCHEMAS[stage],
                    },
                });
            },
""",
    'replace text generation client',
)

worker = replace_once(
    worker,
    """        const responseObj = result?.response;
        const responseText = typeof responseObj?.text === 'function' ? responseObj.text().trim() : String(responseObj || '').trim();
""",
    """        const responseObj = result?.response ?? result;
        const responseText = typeof responseObj?.text === 'function'
            ? responseObj.text().trim()
            : typeof responseObj?.text === 'string'
                ? responseObj.text.trim()
                : String(responseObj || '').trim();
""",
    'support new SDK response text property',
)

worker_path.write_text(worker)

contract_path = Path('tests/ai-generation-contract.test.mjs')
contract = contract_path.read_text()
contract = replace_once(
    contract,
    "  assert.match(worker, /responseSchema:\\s*GEMINI_TEXT_RESPONSE_SCHEMAS\\[stage\\]/);\n",
    "  assert.match(worker, /responseJsonSchema:\\s*GEMINI_TEXT_RESPONSE_SCHEMAS\\[stage\\]/);\n"
    "  assert.match(worker, /import\\('@google\\/genai'\\)/);\n"
    "  assert.doesNotMatch(worker, /@google\\/generative-ai/);\n",
    'update generation contract for supported SDK',
)
contract_path.write_text(contract)

for package_path in [
    Path('lambdas/shared-layer/nodejs/package.json'),
    Path('lambdas/scouts/package.json'),
]:
    package = json.loads(package_path.read_text())
    dependencies = package.get('dependencies', {})
    if '@google/generative-ai' not in dependencies:
        raise RuntimeError(f'{package_path}: deprecated dependency was not present')
    del dependencies['@google/generative-ai']
    if '@google/genai' not in dependencies:
        raise RuntimeError(f'{package_path}: supported @google/genai dependency is missing')
    package_path.write_text(json.dumps(package, indent=2) + '\n')

docs_path = Path('lambdas/scouts/docs/README.md')
docs = docs_path.read_text()
docs = replace_once(
    docs,
    '- `@google/generative-ai` for Gemini API integration',
    '- `@google/genai` for Gemini API integration',
    'update SDK documentation',
)
docs_path.write_text(docs)

print('Gemini SDK source migration complete')
