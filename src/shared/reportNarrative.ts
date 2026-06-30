import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS } from './bedrock';
import type { ReportStats } from './types';

const SYSTEM_PROMPT =
  'You write short, plain-language progress summaries for a support person caring for ' +
  'someone who uses a task app. You are given pre-computed statistics as JSON. ' +
  'Summarize what the numbers show in 2-4 short paragraphs: overall engagement, ' +
  'trends, which categories/tasks went well or poorly, and any sticking points ' +
  '(slow steps, abandoned tasks). Do NOT invent numbers beyond the JSON. Do NOT give ' +
  'medical, clinical, or behavioral advice or recommendations. The rates describe ' +
  'tasks the person actually attempted (basis: attempted-instances-only), not the full ' +
  'schedule — say so if you mention completion rates.';

export async function generateReportNarrative(stats: ReportStats): Promise<string> {
  const prompt = `Here are the statistics as JSON:\n\n${JSON.stringify(stats)}`;
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: BEDROCK_MAX_TOKENS },
    }),
  );
  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('failed to generate report narrative');
  return text;
}
