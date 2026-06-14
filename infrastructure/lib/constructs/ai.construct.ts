import { Construct } from 'constructs';

export interface AiProps {
  /** Region for KB Retrieve + Converse. Resolved once in app.ts. */
  readonly bedrockRegion: string;
}

/**
 * AI configuration for CanPlan: resolves the Bedrock model id and the region
 * Bedrock Runtime is called in. The rest of the stack stays in ca-central-1,
 * but generation runs in the Bedrock region where the KB and inference profile
 * live. The current AI path is generateTaskSteps: KB Retrieve followed by
 * Converse.
 */
export class Ai extends Construct {
  /** Bedrock model / inference-profile id the generateTaskSteps Lambda invokes. */
  public readonly bedrockModelId: string;
  /** Region the generateTaskSteps Lambda calls Bedrock in (not the stack region). */
  public readonly bedrockRegion: string;

  constructor(scope: Construct, id: string, props: AiProps) {
    super(scope, id);

    // Claude Sonnet 4.6 via the US cross-region inference profile. Override with
    // --context bedrockModelId=... for a different model/profile.
    this.bedrockModelId =
      this.node.tryGetContext('bedrockModelId') ?? 'us.anthropic.claude-sonnet-4-6';

    // Resolved once in app.ts so the deployed KB region and Lambda runtime/IAM
    // target cannot drift apart.
    this.bedrockRegion = props.bedrockRegion;
  }
}
