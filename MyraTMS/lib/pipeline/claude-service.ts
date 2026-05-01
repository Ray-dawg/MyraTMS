/**
 * Claude Service Module - Shared API wrapper for Agent 3, Agent 5, and Call Parser
 *
 * This module provides:
 * - Claude API client configuration and management
 * - Structured output parsing and validation (Zod-based)
 * - Retry logic with exponential backoff
 * - Token cost tracking and budget management
 * - Error handling with custom error classes
 * - Prompt templates for all three consumers
 *
 * Dependencies:
 * - @anthropic-ai/sdk
 * - zod (for structured output validation)
 *
 * Usage:
 * const service = new ClaudeService();
 * const research = await service.parseResearch(params, template);
 * const brief = await service.parseBrief(params, template);
 * const callResult = await service.parseCall(transcript, context, template);
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  ClaudeConfig,
  TokenUsage,
  TokenCostEstimate,
  JobTokenBudget,
  ErrorContext,
  LoadIntelligence,
  CallParseResult,
  CallParserContext,
  ResearchPromptParams,
  BriefCompilerPromptParams,
  CallParserPromptParams,
  StructuredOutput,
  BudgetStatus,
  RetryConfig,
} from './types';

// ===== Custom Error Classes =====

/**
 * Base error for Claude API operations
 */
export class ClaudeServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ClaudeServiceError';
  }
}

/**
 * Rate limit error - indicates 429 response
 */
export class RateLimitError extends ClaudeServiceError {
  constructor(message: string, public retryAfterSeconds?: number) {
    super(message, 'RATE_LIMIT', 429, true);
    this.name = 'RateLimitError';
  }
}

/**
 * Parsing error - returned JSON is invalid or doesn't match schema
 */
export class ParseError extends ClaudeServiceError {
  constructor(
    message: string,
    public rawResponse: string,
  ) {
    super(message, 'PARSE_ERROR', undefined, false);
    this.name = 'ParseError';
  }
}

/**
 * Budget exceeded error - daily or per-call token limit reached
 */
export class BudgetExceededError extends ClaudeServiceError {
  constructor(
    message: string,
    public remainingDaily: number,
    public remainingCall: number,
  ) {
    super(message, 'BUDGET_EXCEEDED', undefined, false);
    this.name = 'BudgetExceededError';
  }
}

/**
 * API error from Anthropic
 */
export class APIError extends ClaudeServiceError {
  constructor(message: string, statusCode: number) {
    super(message, 'API_ERROR', statusCode, statusCode >= 500 || statusCode === 429);
    this.name = 'APIError';
  }
}

// ===== Token Pricing (as of April 2026) =====

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-1-20250805': { input: 0.015, output: 0.045 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-3-5-haiku-20241022': { input: 0.0008, output: 0.004 },
};

// ===== Zod Schemas for Structured Output =====

const LoadIntelligenceSchema = z.object({
  rates: z.object({
    floorRate: z.number().positive(),
    midRate: z.number().positive(),
    bestRate: z.number().positive(),
    confidence: z.number().min(0).max(1),
    sources: z.array(z.string()),
    currency: z.enum(['CAD', 'USD']),
  }),
  cost: z.object({
    baseCost: z.number().nonnegative(),
    deadheadCost: z.number().nonnegative(),
    fuelSurcharge: z.number().nonnegative(),
    accessorials: z.number().nonnegative(),
    adminOverhead: z.number().nonnegative(),
    crossBorderFees: z.number().nonnegative(),
    factoringFee: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  negotiation: z.object({
    initialOffer: z.number().positive(),
    concessionStep1: z.number().positive(),
    concessionStep2: z.number().positive(),
    finalOffer: z.number().positive(),
    walkAwayRate: z.number().positive(),
    minMargin: z.number().nonnegative(),
    targetMargin: z.number().nonnegative(),
    stretchMargin: z.number().nonnegative(),
    marginEnvelope: z.object({
      floor: z.number().nonnegative(),
      target: z.number().nonnegative(),
      stretch: z.number().nonnegative(),
    }),
  }),
  shipperProfile: z.object({
    preferredLanguage: z.string(),
    preferredCurrency: z.enum(['CAD', 'USD']),
    previousCallCount: z.number().nonnegative(),
    previousOutcomes: z.array(z.string()),
    postingFrequency: z.number().nonnegative(),
    bestPerformingPersona: z.string().nullable(),
    lastBookedRate: z.number().nullable(),
    fatigueScore: z.number().nonnegative(),
  }),
  strategy: z.object({
    approach: z.enum(['aggressive', 'standard', 'walk']),
    reasoning: z.string(),
  }),
  distance: z.object({
    miles: z.number().positive(),
    km: z.number().positive(),
    durationHours: z.number().nonnegative(),
  }),
});

const CallParseResultSchema = z.object({
  outcome: z.enum([
    'booked',
    'declined',
    'counter_pending',
    'callback',
    'voicemail',
    'no_answer',
    'wrong_contact',
    'escalated',
    'dropped',
  ]),
  final_rate: z.number().nullable(),
  final_rate_currency: z.enum(['CAD', 'USD']).nullable(),
  profit: z.number().nullable(),
  profit_tier: z.enum(['excellent', 'good', 'acceptable', 'below_minimum']).nullable(),
  auto_book_eligible: z.boolean(),
  objections: z.array(z.string()),
  concessions_made: z.number().int().min(0).max(3),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number().min(0).max(1),
  next_action: z.enum([
    'send_confirmation',
    'schedule_callback',
    'escalate_human',
    'retry_later',
    'add_to_dnc',
    'no_action',
  ]),
  callback_details: z.object({
    requested: z.boolean(),
    day: z.string().nullable(),
    time: z.string().nullable(),
    timezone: z.string().nullable(),
  }),
  decision_maker_referral: z.object({
    provided: z.boolean(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  shipper_intel: z.object({
    weekly_volume: z.string().nullable(),
    primary_lanes: z.array(z.string()),
    current_broker: z.string().nullable(),
    facility_notes: z.string().nullable(),
    pain_points: z.array(z.string()),
  }),
  analysis_notes: z.string(),
});

// ===== Prompt Templates =====

/**
 * System prompt for research agent
 * Instructs Claude to analyze freight load data and produce structured rate intelligence
 */
const RESEARCH_SYSTEM_PROMPT = `You are an expert freight rate analyst for Myra Logistics, a Canadian freight brokerage.
Your job is to analyze freight loads and provide structured rate intelligence including:
- Market rate floor (lowest carriers accept)
- Mid rate (average market rate)
- Best rate (highest shippers pay)
- Cost breakdown for Myra to move the load
- Negotiation parameters (initial offer, concession steps, walk-away rate)
- Shipper profile analysis
- Strategic recommendation (aggressive/standard/walk)

Return ONLY valid JSON matching the schema provided. No markdown, no preamble.
All currency is in the specified format (CAD/USD). All rates are per-load, not per-mile.`;

/**
 * System prompt for call parser
 * Instructs Claude to extract structured data from call transcripts
 */
const CALL_PARSER_SYSTEM_PROMPT = `You are an expert freight brokerage call analyst. Your job is to analyze call transcripts between an AI freight broker agent and a shipper, and extract structured data.

You must return ONLY valid JSON matching the exact schema provided. No markdown, no preamble, no explanation — just the JSON object.

Be precise with rate extraction. If a rate is mentioned as "twenty-four hundred" that is 2400. If "two thousand four" that is 2400. If ambiguous, set final_rate to null and set confidence to the level of uncertainty.

Outcome definitions:
- "booked": Both parties explicitly agreed to a rate and the agent confirmed booking details
- "declined": Full conversation happened but shipper said no to the rate after negotiation
- "counter_pending": Shipper made a counter-offer that falls outside the agent's authority (below min_acceptable_rate)
- "callback": Shipper asked to be called back at a specific time
- "voicemail": Agent reached voicemail
- "no_answer": Phone rang with no answer and no voicemail
- "wrong_contact": Reached someone who is not the decision-maker
- "escalated": Conversation hit a scenario the agent couldn't handle
- "dropped": Call dropped or had technical issues`;

// ===== Claude Service Class =====

/**
 * ClaudeService provides a unified interface for all Claude API calls across the pipeline.
 *
 * Features:
 * - Automatic retry with exponential backoff (configurable)
 * - Token cost tracking per call and per job
 * - Budget enforcement (daily and per-call limits)
 * - Structured output parsing with Zod validation
 * - Custom error classes for different failure modes
 * - Prompt templates for all three consumers
 */
export class ClaudeService {
  private client: Anthropic;
  private config: Required<ClaudeConfig>;
  private retryConfig: RetryConfig;
  private tokenStats: Map<string, TokenUsage> = new Map();
  private jobBudgets: Map<string, JobTokenBudget> = new Map();

  /**
   * Initialize ClaudeService
   *
   * @param config Configuration including baseUrl, apiKey, model
   * @param retryConfig Retry strategy (maxRetries, baseDelayMs, etc.)
   *
   * @throws Will throw if ANTHROPIC_API_KEY env var is not set and apiKey not provided
   */
  constructor(config?: ClaudeConfig, retryConfig?: Partial<RetryConfig>) {
    const apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ClaudeServiceError(
        'ANTHROPIC_API_KEY environment variable or config.apiKey required',
        'MISSING_API_KEY',
        undefined,
        false,
      );
    }

    this.config = {
      baseUrl: config?.baseUrl || 'https://api.anthropic.com',
      apiKey,
      model: config?.model || 'claude-sonnet-4-20250514',
      maxTokens: config?.maxTokens || 2000,
    };

    this.retryConfig = {
      maxRetries: retryConfig?.maxRetries ?? 3,
      baseDelayMs: retryConfig?.baseDelayMs ?? 1000,
      maxDelayMs: retryConfig?.maxDelayMs ?? 30000,
      backoffMultiplier: retryConfig?.backoffMultiplier ?? 2,
    };

    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  /**
   * Initialize budget tracking for a job
   *
   * @param jobId Unique identifier for the job
   * @param dailyBudget Daily token limit for the entire job
   * @param perCallBudget Per-call token limit (e.g., max 5000 per Claude API call)
   */
  public initializeBudget(
    jobId: string,
    dailyBudget: number = 100000,
    perCallBudget: number = 5000,
  ): JobTokenBudget {
    const budget: JobTokenBudget = {
      jobId,
      dailyTokenBudget: dailyBudget,
      perCallTokenBudget: perCallBudget,
      tokensUsedToday: 0,
      tokensUsedThisCall: 0,
      remainingDaily: dailyBudget,
      remainingThisCall: perCallBudget,
    };
    this.jobBudgets.set(jobId, budget);
    return budget;
  }

  /**
   * Check if a call would exceed budget
   *
   * @param jobId Job identifier
   * @param estimatedTokens Expected token count for the call
   *
   * @throws BudgetExceededError if call would exceed limits
   */
  public checkBudget(jobId: string, estimatedTokens: number): BudgetStatus {
    const budget = this.jobBudgets.get(jobId);
    if (!budget) {
      // If no budget tracking, assume it's OK
      return {
        dailyBudgetOK: true,
        callBudgetOK: true,
        remainingDaily: Infinity,
        remainingCall: Infinity,
        warningThreshold: 0.2,
      };
    }

    const dailyOK = estimatedTokens <= budget.remainingDaily;
    const callOK = estimatedTokens <= budget.remainingThisCall;

    if (!dailyOK || !callOK) {
      throw new BudgetExceededError(
        `Token budget exceeded: daily=${dailyOK}, call=${callOK}`,
        budget.remainingDaily,
        budget.remainingThisCall,
      );
    }

    return {
      dailyBudgetOK: dailyOK,
      callBudgetOK: callOK,
      remainingDaily: budget.remainingDaily,
      remainingCall: budget.remainingThisCall,
      warningThreshold: 0.2,
    };
  }

  /**
   * Parse a Claude response using a Zod schema
   *
   * @param text Raw response text from Claude
   * @param schema Zod schema to validate against
   * @param context Optional context for error messages
   *
   * @throws ParseError if response is invalid JSON or doesn't match schema
   */
  private parseStructuredOutput<T>(text: string, schema: z.ZodSchema<T>, context: string): T {
    try {
      // Clean markdown if present
      const cleaned = text.replace(/```json\s?|\s?```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // Validate against schema
      const validated = schema.parse(parsed);
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ParseError(
          `Schema validation failed in ${context}: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
          text,
        );
      }
      if (error instanceof SyntaxError) {
        throw new ParseError(`Invalid JSON response in ${context}: ${error.message}`, text);
      }
      throw error;
    }
  }

  /**
   * Execute API call with retry logic and exponential backoff
   *
   * @param fn Async function that makes the API call
   * @param context Description for error logging
   *
   * @returns Response from successful call
   * @throws ClaudeServiceError variants (RateLimitError, APIError, etc.)
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: string,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        let isRetryable = false;
        let retryAfter: number | undefined;

        if (error instanceof Anthropic.RateLimitError) {
          isRetryable = true;
          retryAfter = 60; // Default 60 seconds
          throw new RateLimitError(`Rate limit hit in ${context}`, retryAfter);
        } else if (error instanceof Anthropic.APIError) {
          isRetryable = error.status >= 500 || error.status === 429;
          if (isRetryable && attempt < this.retryConfig.maxRetries) {
            // Calculate backoff
            const delayMs = Math.min(
              this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt),
              this.retryConfig.maxDelayMs,
            );
            await this.delay(delayMs);
            continue;
          }
          throw new APIError(`API error in ${context}: ${error.message}`, error.status);
        }

        if (attempt === this.retryConfig.maxRetries) {
          throw new ClaudeServiceError(`Max retries exceeded in ${context}`, 'MAX_RETRIES', undefined, false);
        }

        // Generic retry with backoff
        const delayMs = Math.min(
          this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt),
          this.retryConfig.maxDelayMs,
        );
        await this.delay(delayMs);
      }
    }

    throw lastError || new ClaudeServiceError(`Failed after ${this.retryConfig.maxRetries} retries in ${context}`, 'UNKNOWN_ERROR', undefined, false);
  }

  /**
   * Simple delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Track token usage for a call
   *
   * @param jobId Job identifier
   * @param usage Token usage from API response
   */
  private recordTokenUsage(jobId: string, usage: TokenUsage): void {
    const budget = this.jobBudgets.get(jobId);
    if (budget) {
      budget.tokensUsedToday += usage.totalTokens;
      budget.tokensUsedThisCall += usage.totalTokens;
      budget.remainingDaily = budget.dailyTokenBudget - budget.tokensUsedToday;
      budget.remainingThisCall = budget.perCallTokenBudget - budget.tokensUsedThisCall;
    }

    // Also track in stats
    const existing = this.tokenStats.get(jobId) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.tokenStats.set(jobId, {
      inputTokens: existing.inputTokens + usage.inputTokens,
      outputTokens: existing.outputTokens + usage.outputTokens,
      totalTokens: existing.totalTokens + usage.totalTokens,
    });
  }

  /**
   * Estimate cost for tokens
   *
   * @param inputTokens Number of input tokens
   * @param outputTokens Number of output tokens
   * @param model Model name (defaults to configured model)
   *
   * @returns Cost estimate in USD
   */
  public estimateCost(
    inputTokens: number,
    outputTokens: number,
    model?: string,
  ): TokenCostEstimate {
    const modelToUse = model || this.config.model;
    const pricing = MODEL_PRICING[modelToUse] || MODEL_PRICING['claude-sonnet-4-20250514'];

    const costUSD = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;

    return {
      inputTokens,
      outputTokens,
      estimatedCostUSD: costUSD,
      modelName: modelToUse,
    };
  }

  /**
   * Get token statistics for a job
   *
   * @param jobId Job identifier
   */
  public getTokenStats(jobId: string): TokenUsage | undefined {
    return this.tokenStats.get(jobId);
  }

  /**
   * Get budget status for a job
   *
   * @param jobId Job identifier
   */
  public getBudgetStatus(jobId: string): JobTokenBudget | undefined {
    return this.jobBudgets.get(jobId);
  }

  // ===== RESEARCH AGENT METHODS (T-06) =====

  /**
   * Generate research prompt for rate estimation
   * Template from T-06 Step 7: Strategy Recommendation
   *
   * @param params Load and context parameters
   *
   * @returns Formatted user prompt for Claude
   */
  public generateResearchPrompt(params: ResearchPromptParams): string {
    return `Estimate the freight rate for this load:

Lane: ${params.originCity}, ${params.originState} → ${params.destinationCity}, ${params.destinationState}
Distance: ${params.distanceMiles} miles
Equipment: ${params.equipmentType}
Date: ${params.pickupDate}
Country: ${params.originCountry}
Load ID: ${params.loadId}

Provide a comprehensive rate analysis in JSON format including:
- floorRate: Lowest market rate carriers are accepting
- midRate: Average market rate
- bestRate: Highest rate shippers are paying
- confidence: 0.0-1.0 confidence in the estimate
- sources: Array of data sources used (e.g., ["historical", "dat_rateview"])
- currency: "CAD" or "USD"

Additionally, estimate the cost breakdown (baseCost, deadheadCost, fuelSurcharge, etc.) and negotiation parameters.`;
  }

  /**
   * Parse research output from Claude
   * Returns structured LoadIntelligence object
   *
   * @param response Claude API message response
   * @param jobId Job identifier for budget tracking
   *
   * @returns Structured LoadIntelligence data
   * @throws ParseError if response doesn't match schema
   */
  public parseResearchResponse(response: Anthropic.Message, jobId: string): StructuredOutput<LoadIntelligence> {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    const parsed = this.parseStructuredOutput<LoadIntelligence>(
      text,
      LoadIntelligenceSchema,
      'research response',
    );

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    this.recordTokenUsage(jobId, usage);

    return {
      data: parsed,
      tokens: usage,
      extractedAt: new Date().toISOString(),
      modelUsed: this.config.model,
    };
  }

  /**
   * Execute full research call with retry and budget checks
   *
   * @param params Load parameters
   * @param jobId Job identifier for budget tracking
   * @param systemPrompt Optional custom system prompt
   *
   * @returns Structured LoadIntelligence data
   */
  public async research(
    params: ResearchPromptParams,
    jobId: string,
    systemPrompt?: string,
  ): Promise<StructuredOutput<LoadIntelligence>> {
    // Check budget before making call
    this.checkBudget(jobId, 2000); // Rough estimate

    const userPrompt = this.generateResearchPrompt(params);

    return this.executeWithRetry(async () => {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: systemPrompt || RESEARCH_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });

      return this.parseResearchResponse(response, jobId);
    }, `research call for load ${params.loadId}`);
  }

  // ===== CALL PARSER METHODS (T-12) =====

  /**
   * Generate prompt for call transcript parsing
   * Template from T-12 Section 3
   *
   * @param context Call context
   * @param transcript Raw call transcript
   *
   * @returns Formatted user prompt for Claude
   */
  public generateCallParserPrompt(context: CallParserContext, transcript: string): string {
    return `Analyze this freight broker call transcript and extract the data as JSON.

CALL CONTEXT:
- Call Type: ${context.callType}
- Load ID: ${context.loadId}
- Lane: ${context.originCity}, ${context.originState} → ${context.destinationCity}, ${context.destinationState}
- Equipment: ${context.equipmentType}
- Initial Offer: $${context.initialOffer} ${context.currency}
- Min Acceptable Rate: $${context.minAcceptableRate} ${context.currency}
- Persona Used: ${context.persona}
- Language: ${context.language}

TRANSCRIPT:
${transcript}

Return ONLY the JSON structure with these fields:
- outcome: one of [booked, declined, counter_pending, callback, voicemail, no_answer, wrong_contact, escalated, dropped]
- final_rate: negotiated rate or null
- final_rate_currency: CAD or USD
- profit: final_rate - totalCost or null
- profit_tier: excellent/good/acceptable/below_minimum/null
- auto_book_eligible: boolean
- objections: array of objection types encountered
- concessions_made: number 0-3
- sentiment: positive/neutral/negative
- confidence: 0.0 to 1.0
- next_action: send_confirmation/schedule_callback/escalate_human/retry_later/add_to_dnc/no_action
- callback_details: {requested, day, time, timezone}
- decision_maker_referral: {provided, name, phone, email}
- shipper_intel: {weekly_volume, primary_lanes[], current_broker, facility_notes, pain_points[]}
- analysis_notes: one sentence summary`;
  }

  /**
   * Parse call transcript response from Claude
   *
   * @param response Claude API message response
   * @param jobId Job identifier for budget tracking
   *
   * @returns Structured CallParseResult data
   * @throws ParseError if response doesn't match schema
   */
  public parseCallResponse(response: Anthropic.Message, jobId: string): StructuredOutput<CallParseResult> {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    const parsed = this.parseStructuredOutput<CallParseResult>(
      text,
      CallParseResultSchema,
      'call parse response',
    );

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    this.recordTokenUsage(jobId, usage);

    return {
      data: parsed,
      tokens: usage,
      extractedAt: new Date().toISOString(),
      modelUsed: this.config.model,
    };
  }

  /**
   * Execute full call parsing with retry and budget checks
   *
   * @param context Call context (load ID, rates, etc.)
   * @param transcript Raw call transcript
   * @param jobId Job identifier for budget tracking
   * @param systemPrompt Optional custom system prompt
   *
   * @returns Structured CallParseResult data
   */
  public async parseCall(
    context: CallParserContext,
    transcript: string,
    jobId: string,
    systemPrompt?: string,
  ): Promise<StructuredOutput<CallParseResult>> {
    // Check budget before making call
    this.checkBudget(jobId, 2000); // Rough estimate

    const userPrompt = this.generateCallParserPrompt(context, transcript);

    return this.executeWithRetry(async () => {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: systemPrompt || CALL_PARSER_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });

      return this.parseCallResponse(response, jobId);
    }, `call parse for load ${context.loadId}`);
  }

  /**
   * Recompute profit based on brief data
   * Per T-12 Section 4: Never trust Claude's profit calculation
   *
   * @param finalRate Rate agreed to
   * @param totalCost Total cost from brief
   * @param minMargin Minimum acceptable margin
   *
   * @returns Computed profit and tier
   */
  public computeProfit(finalRate: number, totalCost: number, minMargin: number): { profit: number; tier: 'excellent' | 'good' | 'acceptable' | 'below_minimum' } {
    const profit = finalRate - totalCost;
    const tier =
      profit >= 500
        ? ('excellent' as const)
        : profit >= 350
          ? ('good' as const)
          : profit >= 200
            ? ('acceptable' as const)
            : ('below_minimum' as const);

    return { profit, tier };
  }

  // ===== BRIEF COMPILER PLACEHOLDER (T-08) =====

  /**
   * Brief Compiler is pure template merge (no API call needed per T-08)
   * This placeholder documents the pattern for future AI-assisted brief generation
   *
   * @param params Brief parameters
   *
   * @returns Generated user prompt for brief context analysis (if needed)
   */
  public generateBriefCompilerPrompt(params: BriefCompilerPromptParams): string {
    // Per T-08: "No AI Required in Agent 5"
    // This is kept for consistency if future versions need Claude assistance
    return `Brief ID: ${params.briefId}
Pipeline Load ID: ${params.pipelineLoadId}
Generated Load Details: ${params.loadDetails}
Rate Envelope: ${params.rateEnvelope}
Shipper Context: ${params.shipperContext}
Strategy: ${params.strategyReasoning}`;
  }

  // ===== UTILITY METHODS =====

  /**
   * Get current configuration
   */
  public getConfig(): Readonly<Required<ClaudeConfig>> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Reset token stats for a job
   *
   * @param jobId Job identifier
   */
  public resetJobStats(jobId: string): void {
    this.tokenStats.delete(jobId);
    this.jobBudgets.delete(jobId);
  }

  /**
   * Get all active job budgets
   */
  public getActiveBudgets(): JobTokenBudget[] {
    return Array.from(this.jobBudgets.values());
  }

  /**
   * Validate that an error is retryable
   *
   * @param error Error to check
   */
  public isRetryable(error: unknown): boolean {
    if (error instanceof RateLimitError) return true;
    if (error instanceof APIError) return error.retryable;
    if (error instanceof ClaudeServiceError) return error.retryable;
    return false;
  }
}

// ===== EXPORTS =====

export default ClaudeService;
