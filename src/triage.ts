import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';
import { validateTriageApiResponse, TriageValidationError } from './triage-validator.js';
import {
  TriageCategory,
  ReportFormat,
  type PlaywrightFailure,
  type TriageResult,
} from './types.js';

const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
const BATCH_SIZE = 10;

export async function triageFailures(
  failures: PlaywrightFailure[],
  instincts: string[],
  detectedFormat: ReportFormat = ReportFormat.PLAYWRIGHT_JSON,
): Promise<TriageResult[]> {
  const results: TriageResult[] = [];
  for (let i = 0; i < failures.length; i += BATCH_SIZE) {
    const batch = failures.slice(i, i + BATCH_SIZE);
    const batchResults = await triageBatch(batch, instincts, detectedFormat);
    results.push(...batchResults);
  }
  return results;
}

async function triageBatch(
  failures: PlaywrightFailure[],
  instincts: string[],
  detectedFormat: ReportFormat,
): Promise<TriageResult[]> {
  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     buildSystemPrompt(instincts, detectedFormat),
      messages:   [{ role: 'user', content: buildUserPrompt(failures) }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const text = textBlock?.type === 'text' ? textBlock.text : '{}';
    const raw    = JSON.parse(text.replace(/```json|```/g, '').trim()) as unknown;
    const parsed = validateTriageApiResponse(raw);

    return parsed.results.map((r, idx) => ({
      ...(failures[idx] as PlaywrightFailure),
      category:     r.category,
      confidence:   r.confidence,
      reasoning:    r.reasoning,
      suggestedFix: r.suggested_fix,
    }));
  } catch (err) {
    if (err instanceof TriageValidationError) {
      // The LLM returned a structurally invalid response.
      // Log field-level detail without echoing the full LLM payload.
      console.error('[oracle] triage batch rejected — LLM output failed schema validation:');
      console.error(err.message);
    } else {
      // API transport error, network failure, or JSON parse error.
      console.error('[oracle] triage batch failed:', (err as Error).message);
    }
    throw err;
  }
}
