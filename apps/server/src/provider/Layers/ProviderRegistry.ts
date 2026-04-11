/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import { CodexProvider } from "../Services/CodexProvider";
import { CursorProvider } from "../Services/CursorProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const PROVIDER_ORDER: ReadonlyArray<ProviderKind> = ["codex", "claudeAgent", "cursor"];

const sortProviders = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) =>
      PROVIDER_ORDER.indexOf(left.provider as ProviderKind) -
      PROVIDER_ORDER.indexOf(right.provider as ProviderKind),
  );

const upsertProvider = (
  providers: ReadonlyArray<ServerProvider>,
  nextProvider: ServerProvider,
): ReadonlyArray<ServerProvider> =>
  sortProviders([
    ...providers.filter((provider) => provider.provider !== nextProvider.provider),
    nextProvider,
  ]);

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const cursorProvider = yield* CursorProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);

    const applyProviderSnapshot = Effect.fn("applyProviderSnapshot")(function* (
      nextProvider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const previousProviders = yield* Ref.get(providersRef);
      const providers = upsertProvider(previousProviders, nextProvider);
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    const loadInitialProvider = (effect: Effect.Effect<ServerProvider>) =>
      effect.pipe(
        Effect.flatMap((provider) => applyProviderSnapshot(provider)),
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
        Effect.asVoid,
      );

    const refreshProviders = Effect.fn("refreshProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const snapshots = yield* Effect.all(
        [codexProvider.refresh, claudeProvider.refresh, cursorProvider.refresh],
        {
          concurrency: "unbounded",
        },
      );
      for (const snapshot of snapshots) {
        yield* applyProviderSnapshot(snapshot, options);
      }
      return yield* Ref.get(providersRef);
    });

    yield* Stream.runForEach(codexProvider.streamChanges, (provider) =>
      Effect.asVoid(applyProviderSnapshot(provider)),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(claudeProvider.streamChanges, (provider) =>
      Effect.asVoid(applyProviderSnapshot(provider)),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(cursorProvider.streamChanges, (provider) =>
      Effect.asVoid(applyProviderSnapshot(provider)),
    ).pipe(Effect.forkScoped);

    yield* loadInitialProvider(codexProvider.getSnapshot);
    yield* loadInitialProvider(claudeProvider.getSnapshot);
    yield* loadInitialProvider(cursorProvider.getSnapshot);

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex": {
          const snapshot = yield* codexProvider.refresh;
          yield* applyProviderSnapshot(snapshot);
          break;
        }
        case "claudeAgent": {
          const snapshot = yield* claudeProvider.refresh;
          yield* applyProviderSnapshot(snapshot);
          break;
        }
        case "cursor": {
          const snapshot = yield* cursorProvider.refresh;
          yield* applyProviderSnapshot(snapshot);
          break;
        }
        default:
          yield* refreshProviders({ publish: true });
          break;
      }
      return yield* Ref.get(providersRef);
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CursorProviderLive),
);
