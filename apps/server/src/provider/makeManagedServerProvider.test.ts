import { describe, it, assert } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

interface TestSettings {
  readonly enabled: boolean;
}

const initialSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect(
    "returns the initial snapshot while the first provider check runs in the background",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseCheck = yield* Deferred.make<void>();
          const checkStarted = yield* Deferred.make<void>();
          const checkCalls = yield* Ref.make(0);

          const provider = yield* makeManagedServerProvider<TestSettings>({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            buildInitialSnapshot: () => initialSnapshot,
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.succeed(checkStarted, undefined)),
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );

          const firstSnapshot = yield* provider.getSnapshot;
          const secondSnapshot = yield* provider.getSnapshot;
          yield* Deferred.await(checkStarted);

          assert.deepStrictEqual(firstSnapshot, initialSnapshot);
          assert.deepStrictEqual(secondSnapshot, initialSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latestSnapshot = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latestSnapshot, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseCheck = yield* Deferred.make<void>();
        const releaseEnrichment = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          buildInitialSnapshot: () => initialSnapshot,
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const initial = yield* provider.getSnapshot;
        assert.deepStrictEqual(initial, initialSnapshot);

        yield* Deferred.succeed(releaseCheck, undefined);
        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ),
  );
});
