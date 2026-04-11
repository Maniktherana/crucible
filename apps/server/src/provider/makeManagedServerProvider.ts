import type { ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, Equal, Fiber, PubSub, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@t3tools/contracts";

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly buildInitialSnapshot: (settings: Settings) => ServerProvider;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  type InitialRefreshState = "idle" | "running" | "done";
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = input.buildInitialSnapshot(initialSettings);
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const settingsRef = yield* Ref.make(initialSettings);
  const initialRefreshStateRef = yield* Ref.make<InitialRefreshState>("idle");
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const enrichmentGenerationRef = yield* Ref.make(0);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const currentGeneration = yield* Ref.get(enrichmentGenerationRef);
    if (currentGeneration !== generation) {
      return;
    }

    const previousSnapshot = yield* Ref.get(snapshotRef);
    if (Equal.equals(previousSnapshot, nextSnapshot)) {
      return;
    }

    yield* Ref.set(snapshotRef, nextSnapshot);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotRef),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    const nextSnapshot = yield* input.checkProvider;
    yield* Ref.set(settingsRef, nextSettings);
    yield* Ref.set(snapshotRef, nextSnapshot);
    yield* Ref.set(initialRefreshStateRef, "done");
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    const generation = yield* Ref.updateAndGet(enrichmentGenerationRef, (value) => value + 1);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, generation);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const startInitialRefreshIfNeeded = Effect.fn("startInitialRefreshIfNeeded")(function* () {
    const shouldStart = yield* Ref.modify(
      initialRefreshStateRef,
      (state): readonly [boolean, InitialRefreshState] =>
        state === "idle" ? [true, "running"] : [false, state],
    );

    if (!shouldStart) {
      return;
    }

    yield* refreshSnapshot().pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? Ref.update(initialRefreshStateRef, (state) => (state === "running" ? "idle" : state))
          : Effect.void,
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
      Effect.flatMap(() => refreshSnapshot()),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  return {
    getSnapshot: startInitialRefreshIfNeeded().pipe(
      Effect.flatMap(() =>
        input.getSettings.pipe(
          Effect.flatMap(applySnapshot),
          Effect.tapError(Effect.logError),
          Effect.orDie,
        ),
      ),
    ),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
