import { Construct } from 'constructs';

/**
 * AI configuration for CanPlan: resolves the Bedrock model id and the region
 * Bedrock Runtime is called in. The rest of the stack stays in ca-central-1,
 * but generation runs in us-east-1 where the US Claude inference profile lives.
 * The current AI path is generateTaskSteps: KB Retrieve followed by Converse.
 */
export class Ai extends Construct {
  /** Bedrock model / inference-profile id the generateTaskSteps Lambda invokes. */
  public readonly bedrockModelId: string;
  /** Region the generateTaskSteps Lambda calls Bedrock in (not the stack region). */
  public readonly bedrockRegion: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Claude Sonnet 4.6 via the US cross-region inference profile. Override with
    // --context bedrockModelId=... for a different model/profile.
    this.bedrockModelId =
      this.node.tryGetContext('bedrockModelId') ?? 'us.anthropic.claude-sonnet-4-6';

    // The US inference profile is served from us-east-1; the backend stack stays
    // in ca-central-1. This region is also where the generateTaskSteps Lambda
    // calls KB Retrieve (runtime client + Retrieve IAM ARN). NOTE: it does NOT
    // move the physically-deployed Knowledge Base — that lives in its own stack
    // pinned to us-east-1 (see knowledge-base-stack.ts). Overriding
    // --context bedrockRegion=... moves inference + the Retrieve target, so it
    // must stay in sync with the KB stack's region or Retrieve will miss the KB.
    this.bedrockRegion = this.node.tryGetContext('bedrockRegion') ?? 'us-east-1';
  }
}
