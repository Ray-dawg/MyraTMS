// @ts-nocheck
/**
 * Example usage patterns for Claude Service module
 * Demonstrates how Agent 3, Agent 5, and Call Parser use the service
 */

import ClaudeService, {
  RateLimitError,
  ParseError,
  BudgetExceededError,
  ClaudeServiceError,
} from '../claude-service';
import type {
  ResearchPromptParams,
  CallParserContext,
  LoadIntelligence,
  CallParseResult,
} from '../types';

// ===== AGENT 3 EXAMPLE: RESEARCH AGENT =====

/**
 * Example: Agent 3 (Research) processing a qualified load
 *
 * Flow:
 * 1. Receive job from research-queue
 * 2. Call Claude to analyze the load
 * 3. Store LoadIntelligence in pipeline_loads
 * 4. Check completion gate (Agent 4 done?)
 * 5. Advance to 'matched' stage if ready
 */
async function exampleAgent3Research() {
  console.log('=== AGENT 3: RESEARCH AGENT ===\n');

  // Initialize service
  const service = new ClaudeService({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2000,
  });

  // Initialize budget for this research job
  const jobId = `research-job-${Date.now()}`;
  service.initializeBudget(jobId, 50000, 5000); // 50k daily, 5k per call

  // Load parameters from pipeline_loads
  const loadParams: ResearchPromptParams = {
    loadId: 'DAT-89234571',
    originCity: 'Toronto',
    originState: 'ON',
    destinationCity: 'Sudbury',
    destinationState: 'ON',
    distanceMiles: 250,
    equipmentType: 'flatbed',
    pickupDate: '2026-04-17',
    originCountry: 'CA',
  };

  try {
    console.log('Calling Claude API for rate intelligence...');
    const result = await service.research(loadParams, jobId);

    console.log('\nRESEARCH RESULT:');
    console.log('================\n');

    // Rate intelligence
    console.log('Market Rates:');
    console.log(`  Floor: $${result.data.rates.floorRate}`);
    console.log(`  Mid: $${result.data.rates.midRate}`);
    console.log(`  Best: $${result.data.rates.bestRate}`);
    console.log(`  Confidence: ${(result.data.rates.confidence * 100).toFixed(0)}%`);
    console.log(`  Currency: ${result.data.rates.currency}`);
    console.log(`  Sources: ${result.data.rates.sources.join(', ')}\n`);

    // Cost breakdown
    console.log('Cost Breakdown:');
    console.log(`  Base: $${result.data.cost.baseCost}`);
    console.log(`  Deadhead: $${result.data.cost.deadheadCost}`);
    console.log(`  Fuel: $${result.data.cost.fuelSurcharge}`);
    console.log(`  Total: $${result.data.cost.total}\n`);

    // Negotiation parameters
    console.log('Negotiation Envelope:');
    console.log(`  Initial Offer: $${result.data.negotiation.initialOffer}`);
    console.log(`  Concession 1: $${result.data.negotiation.concessionStep1}`);
    console.log(`  Concession 2: $${result.data.negotiation.concessionStep2}`);
    console.log(`  Final Offer: $${result.data.negotiation.finalOffer}`);
    console.log(`  Walk Away: $${result.data.negotiation.walkAwayRate}\n`);

    // Margins
    console.log('Margin Envelope:');
    console.log(`  Floor: $${result.data.negotiation.marginEnvelope.floor}`);
    console.log(`  Target: $${result.data.negotiation.marginEnvelope.target}`);
    console.log(`  Stretch: $${result.data.negotiation.marginEnvelope.stretch}\n`);

    // Strategy
    console.log('Strategy:');
    console.log(`  Approach: ${result.data.strategy.approach}`);
    console.log(`  Reasoning: ${result.data.strategy.reasoning}\n`);

    // Token usage
    console.log('API Usage:');
    console.log(`  Input tokens: ${result.tokens.inputTokens}`);
    console.log(`  Output tokens: ${result.tokens.outputTokens}`);
    console.log(`  Total tokens: ${result.tokens.totalTokens}`);
    const cost = service.estimateCost(result.tokens.inputTokens, result.tokens.outputTokens);
    console.log(`  Estimated cost: $${cost.estimatedCostUSD.toFixed(4)}\n`);

    // Budget check
    const budget = service.getBudgetStatus(jobId);
    console.log('Budget Status:');
    console.log(`  Remaining daily: ${budget?.remainingDaily}`);
    console.log(`  Remaining this call: ${budget?.remainingCall}\n`);

    // This would be written to pipeline_loads:
    // UPDATE pipeline_loads SET
    //   research_completed_at = NOW(),
    //   market_rate_floor = $1,
    //   market_rate_mid = $2,
    //   market_rate_best = $3,
    //   recommended_strategy = $4,
    //   research_data = $5
    // WHERE id = $6

    console.log('✓ Research complete. Would write to pipeline_loads and check completion gate.\n');
  } catch (error) {
    handleServiceError(error, service, jobId);
  }
}

// ===== AGENT 5 EXAMPLE: BRIEF COMPILER =====

/**
 * Example: Agent 5 (Brief Compiler) producing a negotiation brief
 *
 * Per T-08: Brief Compiler is pure template merge (no API call)
 * It takes LoadIntelligence + CarrierStack and assembles NegotiationBrief
 */
async function exampleAgent5BriefCompiler() {
  console.log('=== AGENT 5: BRIEF COMPILER ===\n');

  const service = new ClaudeService();

  // Demonstrate prompt generation (if needed for future AI-assisted features)
  const prompt = service.generateBriefCompilerPrompt({
    briefId: 1042,
    pipelineLoadId: 5891,
    loadDetails: JSON.stringify({
      loadId: 'DAT-89234571',
      origin: { city: 'Toronto', state: 'ON', country: 'CA' },
      destination: { city: 'Sudbury', state: 'ON', country: 'CA' },
      equipmentType: 'flatbed',
      distanceMiles: 250,
      distanceKm: 402,
    }),
    rateEnvelope: JSON.stringify({
      initialOffer: 2400,
      concessionStep1: 2310,
      concessionStep2: 2220,
      finalOffer: 2120,
      minMargin: 270,
      targetMargin: 470,
      stretchMargin: 675,
    }),
    shipperContext: JSON.stringify({
      companyName: 'Northern Mine Supply Co',
      preferredLanguage: 'en',
      preferredCurrency: 'CAD',
      previousCallCount: 0,
      fatigueScore: 0,
    }),
    strategyReasoning: 'Good margin opportunity on established lane with reliable rate data.',
  });

  console.log('Generated Brief Compiler Prompt:');
  console.log(prompt);
  console.log(
    '\nNote: Per T-08, Brief Compilation is deterministic.\n' +
      'No API call is made — this is pure template merging of Agent 3 + Agent 4 output.\n',
  );

  // The actual brief assembly would be:
  // const brief = compileBrief(researchResult, carrierStack);
  // Where compileBrief is a pure TypeScript function that:
  // 1. Merges load data from pipeline_loads
  // 2. Copies rates from Agent 3 result
  // 3. Selects persona using Thompson Sampling
  // 4. Includes objection playbook
  // 5. Writes to negotiation_briefs table
}

// ===== CALL PARSER EXAMPLE: WEBHOOK HANDLER =====

/**
 * Example: Call Parser processing Retell AI webhook
 *
 * Flow:
 * 1. Receive webhook from Retell with transcript
 * 2. Call Claude to extract CallParseResult
 * 3. Recompute profit using brief data
 * 4. Write to agent_calls table
 * 5. Update pipeline_loads stage based on outcome
 * 6. Enqueue next action (dispatch, callback, escalate, etc.)
 */
async function exampleCallParser() {
  console.log('=== CALL PARSER: WEBHOOK HANDLER ===\n');

  const service = new ClaudeService({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2000,
  });

  // Initialize budget for call parsing
  const jobId = `call-parser-${Date.now()}`;
  service.initializeBudget(jobId, 200000, 5000); // Higher daily budget for batch processing

  // Sample transcript (in production, this comes from Retell webhook)
  const sampleTranscript = `
Agent: Good afternoon, this is Sarah from Myra Logistics. I'm calling about the load posting from Toronto to Sudbury next Wednesday.

Shipper: Hey Sarah, sure, what's the rate?

Agent: We're looking at twenty-four hundred for this load. We have a vetted carrier with excellent on-time performance in Northern Ontario.

Shipper: That seems high. What's your best rate?

Agent: I can come down to twenty-three-ten if you're committed to weekly loads on this corridor. What do you think?

Shipper: Let me think about it... I usually pay around twenty-two hundred with my current broker.

Agent: I understand. Our focus is on reliable service, not just the cheapest option. But I can meet you closer. What if we do twenty-two-twenty and you give us your next two loads on this lane?

Shipper: That works for me. Let's book it.

Agent: Excellent! So to confirm: Rate is twenty-two hundred twenty, departure Wednesday morning from Toronto, delivery Thursday Sudbury. Can I get a shipper contact name for the pickup?

Shipper: Sure, it's Jean-Marc Tremblay, that's T-R-E-M-B-L-A-Y.

Agent: Perfect. I'm sending you a booking confirmation via email right now. Thanks for your business!
`;

  // Call context from brief
  const callContext: CallParserContext = {
    callType: 'outbound',
    loadId: 'DAT-89234571',
    originCity: 'Toronto',
    originState: 'ON',
    destinationCity: 'Sudbury',
    destinationState: 'ON',
    equipmentType: 'flatbed',
    initialOffer: 2400,
    minAcceptableRate: 2120,
    currency: 'CAD',
    persona: 'friendly',
    language: 'en',
  };

  try {
    console.log('Parsing call transcript...\n');
    const result = await service.parseCall(callContext, sampleTranscript, jobId);

    console.log('CALL PARSE RESULT:');
    console.log('==================\n');

    console.log(`Outcome: ${result.data.outcome}`);
    console.log(`Final Rate: $${result.data.final_rate} ${result.data.final_rate_currency}`);
    console.log(`Profit: $${result.data.profit}`);
    console.log(`Profit Tier: ${result.data.profit_tier}`);
    console.log(`Auto-book Eligible: ${result.data.auto_book_eligible}`);
    console.log(`Sentiment: ${result.data.sentiment}`);
    console.log(`Confidence: ${(result.data.confidence * 100).toFixed(0)}%\n`);

    console.log(`Objections Raised: ${result.data.objections.join(', ')}`);
    console.log(`Concessions Made: ${result.data.concessions_made}/3\n`);

    console.log('Next Action:', result.data.next_action);
    console.log('Analysis:', result.data.analysis_notes);

    if (result.data.decision_maker_referral.provided) {
      console.log(`\nDecision Maker: ${result.data.decision_maker_referral.name}`);
      console.log(`Phone: ${result.data.decision_maker_referral.phone}`);
    }

    console.log('\nShipper Intel:');
    console.log(`  Weekly Volume: ${result.data.shipper_intel.weekly_volume || 'unknown'}`);
    console.log(`  Current Broker: ${result.data.shipper_intel.current_broker || 'none mentioned'}`);
    if (result.data.shipper_intel.primary_lanes.length > 0) {
      console.log(`  Primary Lanes: ${result.data.shipper_intel.primary_lanes.join(', ')}`);
    }

    console.log('\nToken Usage:');
    console.log(`  Input: ${result.tokens.inputTokens}`);
    console.log(`  Output: ${result.tokens.outputTokens}`);
    console.log(`  Total: ${result.tokens.totalTokens}`);

    // CRITICAL per T-12: Recompute profit using brief data, not Claude's calculation
    console.log('\n⚠ IMPORTANT: Recomputing profit (never trust Claude\'s calculation)');
    const totalCostFromBrief = 1850; // From brief
    const minMarginFromBrief = 270;  // From brief
    if (result.data.final_rate) {
      const { profit, tier } = service.computeProfit(
        result.data.final_rate,
        totalCostFromBrief,
        minMarginFromBrief,
      );
      console.log(`  Recomputed Profit: $${profit}`);
      console.log(`  Recomputed Tier: ${tier}`);
      console.log(`  Auto-book Eligible: ${profit >= minMarginFromBrief}`);
    }

    console.log(
      '\n✓ Parse complete. Would write to agent_calls table and update pipeline_loads stage.\n',
    );
  } catch (error) {
    handleServiceError(error, service, jobId);
  }
}

// ===== ERROR HANDLING EXAMPLE =====

/**
 * Centralized error handling for service failures
 */
function handleServiceError(error: unknown, service: ClaudeService, jobId: string) {
  if (error instanceof RateLimitError) {
    console.error('✗ Rate limited by Claude API');
    if (error.retryAfterSeconds) {
      console.error(`  Retry after: ${error.retryAfterSeconds} seconds`);
    }
  } else if (error instanceof ParseError) {
    console.error('✗ Failed to parse Claude response');
    console.error(`  Raw response: ${error.rawResponse.substring(0, 200)}...`);
  } else if (error instanceof BudgetExceededError) {
    console.error('✗ Token budget exceeded');
    console.error(`  Remaining daily: ${error.remainingDaily}`);
    console.error(`  Remaining this call: ${error.remainingCall}`);
  } else if (error instanceof ClaudeServiceError) {
    console.error(`✗ Service error: ${error.code}`);
    console.error(`  Message: ${error.message}`);
    if (service.isRetryable(error)) {
      console.error('  (This error is retryable)');
    }
  } else {
    console.error('✗ Unknown error:', error);
  }

  // Log job stats for debugging
  const stats = service.getTokenStats(jobId);
  if (stats) {
    console.log('\nJob Statistics:');
    console.log(`  Total tokens used: ${stats.totalTokens}`);
    console.log(`  Estimated cost: $${service.estimateCost(stats.inputTokens, stats.outputTokens).estimatedCostUSD.toFixed(4)}`);
  }
}

// ===== BUDGET MANAGEMENT EXAMPLE =====

/**
 * Example: Tracking budgets across multiple jobs
 */
function exampleBudgetTracking() {
  console.log('=== BUDGET TRACKING ===\n');

  const service = new ClaudeService();

  // Initialize multiple jobs
  service.initializeBudget('research-job-1', 50000, 5000);
  service.initializeBudget('research-job-2', 50000, 5000);
  service.initializeBudget('call-parser-1', 200000, 5000);

  // Simulate some usage
  service.estimateCost(1500, 500); // Fake a call for budget tracking

  // Get all active budgets
  const allBudgets = service.getActiveBudgets();

  console.log(`Total active jobs: ${allBudgets.length}\n`);

  allBudgets.forEach((b) => {
    const used = b.dailyTokenBudget - b.remainingDaily;
    const percentUsed = (used / b.dailyTokenBudget * 100).toFixed(1);
    console.log(`Job: ${b.jobId}`);
    console.log(`  Daily: ${used}/${b.dailyTokenBudget} tokens (${percentUsed}%)`);
    console.log(`  Remaining: ${b.remainingDaily}\n`);
  });

  // Check for budget warnings
  allBudgets.forEach((b) => {
    const thresholdWarning = b.dailyTokenBudget * 0.2; // 20% threshold
    if (b.remainingDaily < thresholdWarning) {
      console.warn(
        `⚠ WARNING: Job ${b.jobId} approaching budget limit (${b.remainingDaily} remaining)`,
      );
    }
  });
}

// ===== MAIN EXECUTION =====

/**
 * Run all examples
 */
async function runAllExamples() {
  console.log('\n========================================');
  console.log('CLAUDE SERVICE EXAMPLES');
  console.log('========================================\n');

  try {
    // Note: These examples use mock/sample data and won't actually call Claude API
    // In production, they would make real API calls with actual transcripts

    // await exampleAgent3Research();
    await exampleAgent5BriefCompiler();
    // await exampleCallParser();
    exampleBudgetTracking();

    console.log(
      '\nNote: Set ANTHROPIC_API_KEY environment variable to run live examples.\n',
    );
  } catch (error) {
    console.error('Example execution failed:', error);
  }
}

// Export for external use
export { exampleAgent3Research, exampleAgent5BriefCompiler, exampleCallParser };

// Run examples if executed directly
if (require.main === module) {
  runAllExamples().catch(console.error);
}
