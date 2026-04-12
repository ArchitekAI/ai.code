/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderKind,
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  Cache,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Equal,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  Scope,
  ServiceMap,
  Stream,
  Cause,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Apply runtime-only overrides without persisting them to disk. */
  readonly applyRuntimeOverrides: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const baseSettingsRef = yield* Ref.make<ServerSettings>(
          deepMerge(DEFAULT_SERVER_SETTINGS, overrides),
        );
        const runtimeOverridesRef = yield* Ref.make<ServerSettingsPatch>({});
        const changesPubSub = yield* PubSub.unbounded<ServerSettings>();

        const readEffectiveSettings = Effect.all([
          Ref.get(baseSettingsRef),
          Ref.get(runtimeOverridesRef),
        ]).pipe(
          Effect.map(([baseSettings, runtimeOverrides]) =>
            Schema.decodeSync(ServerSettings)(deepMerge(baseSettings, runtimeOverrides)),
          ),
          Effect.map(resolveTextGenerationProvider),
        );

        const emitCurrentSettings = readEffectiveSettings.pipe(
          Effect.tap((settings) => PubSub.publish(changesPubSub, settings)),
        );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: readEffectiveSettings,
          updateSettings: (patch) =>
            Effect.gen(function* () {
              const currentSettings = yield* Ref.get(baseSettingsRef);
              const nextSettings = Schema.decodeSync(ServerSettings)(
                deepMerge(currentSettings, patch),
              );
              yield* Ref.set(baseSettingsRef, nextSettings);
              return yield* emitCurrentSettings;
            }),
          applyRuntimeOverrides: (patch) =>
            Effect.gen(function* () {
              const currentRuntimeOverrides = yield* Ref.get(runtimeOverridesRef);
              const nextRuntimeOverrides = Schema.decodeSync(ServerSettingsPatch)(
                deepMerge(currentRuntimeOverrides, patch),
              );
              yield* Ref.set(runtimeOverridesRef, nextRuntimeOverrides);
              // Runtime overrides model env-backed settings that should never be written back out.
              return yield* emitCurrentSettings;
            }),
          streamChanges: Stream.fromPubSub(changesPubSub),
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);

const PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "claudeAgent"];

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (settings.providers[selection.provider].enabled) {
    return settings;
  }

  const fallback = PROVIDER_ORDER.find((p) => settings.providers[p].enabled);
  if (!fallback) {
    // No providers enabled — return as-is; callers will report the error.
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      provider: fallback,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback],
    } as ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set(["textGenerationModelSelection"]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const runtimeOverridesRef = yield* Ref.make<ServerSettingsPatch>({});
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    return decoded.value;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const decodeSettings = (candidate: unknown, source: string) =>
    Schema.decodeUnknownEffect(ServerSettings)(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath: source,
            detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
            cause,
          }),
      ),
    );

  const resolveEffectiveSettings = (
    baseSettings: ServerSettings,
    runtimeOverrides: ServerSettingsPatch,
  ) =>
    decodeSettings(deepMerge(baseSettings, runtimeOverrides), "<runtime-overrides>").pipe(
      Effect.map(resolveTextGenerationProvider),
    );

  const getEffectiveSettings = Effect.all([
    getSettingsFromCache,
    Ref.get(runtimeOverridesRef),
  ]).pipe(
    Effect.flatMap(([baseSettings, runtimeOverrides]) =>
      resolveEffectiveSettings(baseSettings, runtimeOverrides),
    ),
  );

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    const sparseSettings = stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {};

    return Effect.succeed(`${JSON.stringify(sparseSettings, null, 2)}\n`).pipe(
      Effect.tap(() => fs.makeDirectory(pathService.dirname(settingsPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, settingsPath)),
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getEffectiveSettings;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getEffectiveSettings,
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const currentSettings = yield* getSettingsFromCache;
          const nextSettings = yield* decodeSettings(deepMerge(currentSettings, patch), "<memory>");
          const runtimeOverrides = yield* Ref.get(runtimeOverridesRef);
          yield* writeSettingsAtomically(nextSettings);
          yield* Cache.set(settingsCache, cacheKey, nextSettings);
          const effectiveSettings = yield* resolveEffectiveSettings(nextSettings, runtimeOverrides);
          yield* emitChange(effectiveSettings);
          return effectiveSettings;
        }),
      ),
    applyRuntimeOverrides: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const currentRuntimeOverrides = yield* Ref.get(runtimeOverridesRef);
          const nextRuntimeOverrides = yield* Schema.decodeUnknownEffect(ServerSettingsPatch)(
            deepMerge(currentRuntimeOverrides, patch),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath: "<runtime-overrides>",
                  detail: `failed to normalize runtime settings overrides: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                  cause,
                }),
            ),
          );
          yield* Ref.set(runtimeOverridesRef, nextRuntimeOverrides);
          // Env-backed overrides should affect reads immediately without mutating settings.json.
          const effectiveSettings = yield* getEffectiveSettings;
          yield* emitChange(effectiveSettings);
          return effectiveSettings;
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
