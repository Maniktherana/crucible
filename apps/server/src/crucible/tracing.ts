/**
 * Crucible Tracing — Langfuse v5 (OpenTelemetry) integration.
 *
 * Lazily initialises the OpenTelemetry NodeSDK with a LangfuseSpanProcessor
 * when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are present in the
 * environment.  When either key is missing, tracing is silently disabled and
 * every helper in this module becomes a no-op.
 *
 * Callers should always gate span creation behind {@link isTracingEnabled}
 * to avoid unnecessary object allocation when tracing is off.
 *
 * @module crucible/tracing
 */

import type { LangfuseSpanProcessor as LangfuseSpanProcessorType } from "@langfuse/otel";

let sdkInstance: { shutdown(): Promise<void> } | null = null;
let spanProcessorInstance: LangfuseSpanProcessorType | null = null;
let tracingEnabled = false;

/**
 * Bootstrap the OpenTelemetry SDK with the Langfuse span processor.
 *
 * Uses dynamic imports so that `@opentelemetry/sdk-node` and `@langfuse/otel`
 * are never loaded when tracing is disabled (keeps the cold-start lean).
 */
export async function initLangfuse(): Promise<void> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    console.warn(
      "[crucible/tracing] LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not set. Tracing disabled.",
    );
    return;
  }

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");

    const processor = new LangfuseSpanProcessor();
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();

    sdkInstance = sdk;
    spanProcessorInstance = processor;
    tracingEnabled = true;

    console.info("[crucible/tracing] Langfuse tracing initialised.");
  } catch (error) {
    console.warn(
      "[crucible/tracing] Failed to initialise Langfuse tracing:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Whether Langfuse tracing has been successfully initialised. */
export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

/** Flush any buffered spans to Langfuse. Best-effort, never throws. */
export async function flushTracing(): Promise<void> {
  try {
    await spanProcessorInstance?.forceFlush();
  } catch {
    /* best-effort */
  }
}

/** Gracefully shut down the OTel SDK (flushes + stops). */
export async function shutdownTracing(): Promise<void> {
  try {
    await sdkInstance?.shutdown();
  } catch {
    /* best-effort */
  }
}

// Re-export the tracing primitives callers need so that `http.ts` only ever
// imports from `./tracing.ts` (single point of control).
export { startObservation, propagateAttributes } from "@langfuse/tracing";
export type { LangfuseSpan, LangfuseGeneration, LangfuseEvent } from "@langfuse/tracing";
