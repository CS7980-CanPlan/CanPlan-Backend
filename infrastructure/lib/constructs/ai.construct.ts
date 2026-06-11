import { Construct } from 'constructs';

/**
 * AI configuration for CanPlan. Currently just resolves the Bedrock model id;
 * a home for future AI resources (e.g. a Bedrock Knowledge Base).
 */
export class Ai extends Construct {
  /** Bedrock model / inference-profile id the askAi Lambda invokes. */
  public readonly bedrockModelId: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Default is Claude 3 Haiku: the org SCP on this account denies newer models
    // (Sonnet 4.6 / inference profiles) but allows Haiku 3 on-demand. Override
    // once the SCP is widened: --context bedrockModelId=global.anthropic.claude-sonnet-4-6
    this.bedrockModelId =
      this.node.tryGetContext('bedrockModelId') ?? 'anthropic.claude-3-haiku-20240307-v1:0';
  }
}
