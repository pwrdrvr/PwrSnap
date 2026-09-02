// Main-process owner for PwrSnap settings and installed-agent discovery.
//
// The persistence service below this boundary knows how to parse, quarantine,
// normalize, migrate, and atomically replace pwrsnap-settings.json. Production
// callers never import it directly: they consume this store's immutable
// process snapshot and targeted provider refresh methods. Expensive binary /
// PATH discovery is keyed by its actual inputs, single-flight, and retained
// until an explicit refresh or a dependency-changing settings update.

import { createHash } from "node:crypto";
import { app } from "electron";
import { join } from "node:path";
import {
  BUILT_IN_ACP_STRATEGIES,
  discoverLocalAcpAgentInstances,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import type {
  CodexTestResult,
  DesktopCodexAuthProbe,
  DesktopCodexCandidateSource,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";

import { execAgentCommand } from "../ai/agent-command";
import { resolveActiveAcpInstance } from "../ai/acp-instance-resolver";
import {
  clearCodexCliCompatibilityAlert,
  CodexCliTooOldError,
  reportCodexCliTooOld
} from "./codex-compatibility-alert";
import {
  DesktopSettingsService,
  type DesktopSettingsServiceConfig,
  type DesktopSettingsWriteOptions,
  type SerializedSettingsOperation
} from "./desktop-settings-service";
import {
  compareCodexCliVersions,
  discoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION,
  probeCodexAuth,
  selectResolvedCodexCommand,
  type DesktopCodexDiscoverySnapshot as RawCodexDiscoverySnapshot,
  type ResolvedCodexCommandCandidate
} from "./codex-discovery";

const CODEX_TEST_TIMEOUT_MS = 7_500;
const ERROR_MESSAGE_LIMIT = 240;
const DISCOVERY_FINGERPRINT_VERSION = 1;

type CodexDiscoverer = typeof discoverCodexCommands;
type CodexAuthProber = typeof probeCodexAuth;
type AgentCommandExecutor = typeof execAgentCommand;
type AcpDiscoverer = (
  options?: LocalAcpDiscoveryOptions
) => Promise<DiscoveredAcpAgentGroup[]>;

export type DesktopSettingsDomain = keyof Settings;

export type DesktopSettingsDomainChange<
  K extends DesktopSettingsDomain = DesktopSettingsDomain
> = Readonly<{
  version: number;
  changedDomains: readonly K[];
  values: Readonly<Pick<Settings, K>>;
}>;

export type DesktopSettingsStoreDiagnostics = Readonly<{
  settingsFileReads: number;
  settingsAtomicWrites: number;
  codexDiscoveryRuns: number;
  codexDiscoveryDedupeHits: number;
  codexDiscoveryCacheHits: number;
  acpDiscoveryRuns: number;
  acpDiscoveryDedupeHits: number;
  acpDiscoveryCacheHits: number;
}>;

export type DesktopSettingsStoreConfig = DesktopSettingsServiceConfig & {
  persistence?: DesktopSettingsService;
  discoverCodex?: CodexDiscoverer;
  probeCodexAuthentication?: CodexAuthProber;
  executeAgentCommand?: AgentCommandExecutor;
  discoverAcp?: AcpDiscoverer;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

type Subscription = Readonly<{
  domains: ReadonlySet<DesktopSettingsDomain>;
  listener: (event: DesktopSettingsDomainChange) => void;
}>;

type AcpDiscoveryCacheEntry = Readonly<{
  fingerprint: string;
  group: DiscoveredAcpAgentGroup | null;
}>;

/** Public settings contract used by production consumers. Raw file ownership
 * deliberately does not appear in this interface. */
export interface DesktopSettingsStoreApi {
  read(): Promise<Settings>;
  readDomain<K extends DesktopSettingsDomain>(domain: K): Promise<Settings[K]>;
  getCurrentSnapshot(): Settings | null;
  getCurrentDomain<K extends DesktopSettingsDomain>(domain: K): Settings[K] | null;
  write(patch: SettingsPatch, options?: DesktopSettingsWriteOptions): Promise<Settings>;
  adoptTrustedPeerSnapshot(settings: Settings): Settings;
  withSerializedSettings<T>(operation: SerializedSettingsOperation<T>): Promise<T>;
  subscribe<K extends DesktopSettingsDomain>(
    domains: readonly K[],
    listener: (event: DesktopSettingsDomainChange<K>) => void
  ): () => void;
}

export class DesktopSettingsStore implements DesktopSettingsStoreApi {
  private readonly persistence: DesktopSettingsService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly discoverCodex: CodexDiscoverer;
  private readonly probeCodexAuthentication: CodexAuthProber;
  private readonly executeAgentCommand: AgentCommandExecutor;
  private readonly discoverAcp: AcpDiscoverer;

  private publishedSnapshot: Settings | null = null;
  private snapshotVersion = 0;
  private readonly subscriptions = new Set<Subscription>();

  private readonly rawCodexCache = new Map<string, RawCodexDiscoverySnapshot>();
  private readonly rawCodexInflight = new Map<
    string,
    Promise<RawCodexDiscoverySnapshot>
  >();
  private readonly codexUiCache = new Map<string, DesktopCodexDiscoverySnapshot>();
  private readonly codexUiInflight = new Map<
    string,
    Promise<DesktopCodexDiscoverySnapshot>
  >();
  private codexDiscoveryEpoch = 0;
  private readonly acpCache = new Map<string, AcpDiscoveryCacheEntry>();
  private readonly acpInflight = new Map<string, Promise<void>>();
  private readonly acpDiscoveryEpochs = new Map<string, number>();

  private diagnostics: DesktopSettingsStoreDiagnostics = {
    settingsFileReads: 0,
    settingsAtomicWrites: 0,
    codexDiscoveryRuns: 0,
    codexDiscoveryDedupeHits: 0,
    codexDiscoveryCacheHits: 0,
    acpDiscoveryRuns: 0,
    acpDiscoveryDedupeHits: 0,
    acpDiscoveryCacheHits: 0
  };

  constructor(config: DesktopSettingsStoreConfig) {
    this.persistence = config.persistence ?? new DesktopSettingsService(config);
    this.env = config.env ?? process.env;
    this.now = config.now ?? Date.now;
    this.discoverCodex = config.discoverCodex ?? discoverCodexCommands;
    this.probeCodexAuthentication =
      config.probeCodexAuthentication ?? probeCodexAuth;
    this.executeAgentCommand = config.executeAgentCommand ?? execAgentCommand;
    this.discoverAcp = config.discoverAcp ?? discoverLocalAcpAgentInstances;
  }

  async read(): Promise<Settings> {
    const settings = await this.persistence.read();
    this.observeSnapshot(settings, false);
    return settings;
  }

  async readDomain<K extends DesktopSettingsDomain>(domain: K): Promise<Settings[K]> {
    return (await this.read())[domain];
  }

  getCurrentSnapshot(): Settings | null {
    return this.persistence.getCurrentSnapshot();
  }

  getCurrentDomain<K extends DesktopSettingsDomain>(domain: K): Settings[K] | null {
    return this.getCurrentSnapshot()?.[domain] ?? null;
  }

  async write(
    patch: SettingsPatch,
    options: DesktopSettingsWriteOptions = {}
  ): Promise<Settings> {
    const result = await this.persistence.write(patch, options);
    this.observeSnapshot(this.persistence.getCurrentSnapshot() ?? result, true);
    return result;
  }

  adoptTrustedPeerSnapshot(settings: Settings): Settings {
    const snapshot = this.persistence.adoptTrustedSnapshot(settings);
    this.observeSnapshot(snapshot, true);
    return snapshot;
  }

  withSerializedSettings<T>(operation: SerializedSettingsOperation<T>): Promise<T> {
    return this.persistence.withSerializedSettings(operation);
  }

  subscribe<K extends DesktopSettingsDomain>(
    domains: readonly K[],
    listener: (event: DesktopSettingsDomainChange<K>) => void
  ): () => void {
    const subscription: Subscription = {
      domains: new Set(domains),
      listener: listener as unknown as Subscription["listener"]
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  readDiagnostics(): DesktopSettingsStoreDiagnostics {
    const io = this.persistence.readIoDiagnostics();
    return Object.freeze({
      ...this.diagnostics,
      settingsFileReads: io.fileReads,
      settingsAtomicWrites: io.atomicWrites
    });
  }

  /** Resolve a Codex command from one discovery publication. Runtime starts,
   * Settings, profiles, and compatibility checks share this cache when their
   * command/environment inputs match. */
  async resolveCodexCommand(params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ResolvedCodexCommandCandidate> {
    const env = params.env ?? this.env;
    const configuredCommand =
      params.command.trim() && params.command.trim() !== "codex"
        ? params.command.trim()
        : undefined;
    const discovery = await this.getRawCodexDiscovery({
      configuredCommand,
      env,
      force: false
    });
    return selectResolvedCodexCommand(discovery, params.command);
  }

  /** Resolve a launchable, protocol-compatible Codex command from the cached
   * discovery publication. This is the runtime guard: callers must not run a
   * second version probe after resolution. */
  async resolveCompatibleCodexCommand(params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ResolvedCodexCommandCandidate> {
    const env = params.env ?? this.env;
    const requestedCommand = params.command.trim() || "codex";
    const configuredCommand =
      requestedCommand !== "codex" ? requestedCommand : undefined;
    const discovery = await this.getRawCodexDiscovery({
      configuredCommand,
      env,
      force: false
    });
    const selected = discovery.candidates.find((candidate) => candidate.selected);
    if (selected !== undefined && selected.version !== undefined) {
      if (
        compareCodexCliVersions(selected.version, MINIMUM_CODEX_CLI_VERSION) < 0
      ) {
        throw new CodexCliTooOldError(
          reportCodexCliTooOld(
            selected.command,
            selected.version,
            MINIMUM_CODEX_CLI_VERSION
          )
        );
      }
      clearCodexCliCompatibilityAlert();
      return {
        command: selected.command,
        source: selected.source,
        version: selected.version
      };
    }

    const incompatible = discovery.candidates.find(
      (candidate) =>
        candidate.failureReason === "codex_too_old" &&
        candidate.version !== undefined
    );
    if (incompatible?.version !== undefined) {
      throw new CodexCliTooOldError(
        reportCodexCliTooOld(
          incompatible.command,
          incompatible.version,
          MINIMUM_CODEX_CLI_VERSION
        )
      );
    }
    if (selected !== undefined) {
      const reason = selected.versionFailureReason ?? "version_not_reported";
      throw new Error(
        `Codex CLI version could not be verified: ${selected.command} (${reason})`
      );
    }
    throw new Error(codexNotFoundMessage(requestedCommand));
  }

  async getCodexDiscoverySnapshot(): Promise<DesktopCodexDiscoverySnapshot> {
    return this.loadCodexDiscoverySnapshot(false);
  }

  /** Expensive user-action boundary. Production callers outside the Settings
   * Refresh handler are rejected by scripts/check-settings-store-boundary.mjs. */
  async refreshCodexDiscoveryForUserRequest(): Promise<DesktopCodexDiscoverySnapshot> {
    return this.loadCodexDiscoverySnapshot(true);
  }

  private async loadCodexDiscoverySnapshot(
    force: boolean
  ): Promise<DesktopCodexDiscoverySnapshot> {
    const settings = await this.read();
    const configuredCommand = configuredCodexCommand(settings);
    const fingerprint = this.codexPublicationFingerprint(
      configuredCommand,
      this.env
    );
    if (!force) {
      const cached = this.codexUiCache.get(fingerprint);
      if (cached !== undefined) {
        this.bumpDiagnostic("codexDiscoveryCacheHits");
        return cached;
      }
    }
    const existing = this.codexUiInflight.get(fingerprint);
    if (existing !== undefined) {
      this.bumpDiagnostic("codexDiscoveryDedupeHits");
      return existing;
    }

    const computation = this.computeCodexUiSnapshot({
      configuredCommand,
      env: this.env,
      fingerprint,
      force
    });
    this.codexUiInflight.set(fingerprint, computation);
    try {
      const snapshot = await computation;
      const latest = await this.read();
      const latestFingerprint = this.codexPublicationFingerprint(
        configuredCodexCommand(latest),
        this.env
      );
      if (latestFingerprint !== fingerprint) {
        return this.loadCodexDiscoverySnapshot(false);
      }
      return snapshot;
    } catch (cause) {
      const lastKnownGood = this.codexUiCache.get(fingerprint);
      if (!force && lastKnownGood !== undefined) return lastKnownGood;
      throw cause;
    } finally {
      if (this.codexUiInflight.get(fingerprint) === computation) {
        this.codexUiInflight.delete(fingerprint);
      }
    }
  }

  async testCodexForUserRequest(): Promise<CodexTestResult> {
    const startedAt = this.now();
    const settings = await this.read();
    let resolvedCommand: string | null = null;
    try {
      resolvedCommand = (
        await this.resolveCodexCommand({
          command: configuredCodexCommand(settings) ?? "codex",
          env: this.env
        })
      ).command;
    } catch {
      resolvedCommand = null;
    }

    if (resolvedCommand === null) {
      return {
        status: "unset",
        testedAt: new Date(this.now()).toISOString(),
        durationMs: this.now() - startedAt,
        account: null
      };
    }

    const probeStart = this.now();
    try {
      const { stdout, stderr } = await this.executeAgentCommand(
        resolvedCommand,
        ["--version"],
        { env: this.env, timeoutMs: CODEX_TEST_TIMEOUT_MS }
      );
      const durationMs = this.now() - probeStart;
      const testedAt = new Date(this.now()).toISOString();
      const output = `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`;
      const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
      if (match) {
        const version = match[1] as string;
        if (compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) {
          return {
            status: "failed",
            testedAt,
            durationMs,
            account: resolvedCommand,
            errorMessage: `Codex CLI ${version} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}`
          };
        }
        return {
          status: "ok",
          testedAt,
          durationMs,
          account: resolvedCommand,
          detail: version
        };
      }
      return {
        status: "failed",
        testedAt,
        durationMs,
        account: resolvedCommand,
        errorMessage: "version banner not recognized in stdout/stderr"
      };
    } catch (cause) {
      return {
        status: "failed",
        testedAt: new Date(this.now()).toISOString(),
        durationMs: this.now() - probeStart,
        account: resolvedCommand,
        errorMessage: clipError(cause)
      };
    }
  }

  /** Installed-agent scan for Settings/Library/Float-Over. Automatic reads
   * stay cached; only an explicit force refresh or changed discovery inputs
   * launch new probes. */
  async getAcpDiscoveryGroups(): Promise<DiscoveredAcpAgentGroup[]> {
    return this.loadAcpDiscoveryGroups(false);
  }

  /** Expensive user-action boundary. Production callers outside the Settings
   * Refresh handler are rejected by scripts/check-settings-store-boundary.mjs. */
  async refreshAcpDiscoveryForUserRequest(): Promise<
    DiscoveredAcpAgentGroup[]
  > {
    return this.loadAcpDiscoveryGroups(true);
  }

  private async loadAcpDiscoveryGroups(
    force: boolean
  ): Promise<DiscoveredAcpAgentGroup[]> {
    const settings = await this.read();
    return this.discoverAcpGroups({
      settings,
      agentIds: BUILT_IN_ACP_STRATEGIES.map((strategy) => strategy.id),
      force
    });
  }

  /** Runtime lookup for one enabled ACP provider. Capture enrichment, chat,
   * and model listing all share the same provider-scoped publication. */
  async resolveEnabledAcpAgent(
    agentId: string,
    settingsInput?: Settings
  ): Promise<DiscoveredAcpAgent | null> {
    const settings = settingsInput ?? (await this.read());
    if (!settings.ai.acp.enabledAgentIds.includes(agentId)) return null;
    const groups = await this.discoverAcpGroups({
      settings,
      agentIds: [agentId],
      force: false
    });
    const group = groups.find((candidate) => candidate.strategyId === agentId);
    if (group === undefined || group.instances.length === 0) return null;
    const active = resolveActiveAcpInstance(
      group.instances,
      settings.ai.acp.agents?.[agentId]
    );
    return {
      strategyId: group.strategyId,
      backendId: group.backendId,
      name: group.name,
      command: active.command,
      args: group.args,
      env: group.env,
      discoveredAt: group.discoveredAt,
      ...(active.version !== undefined ? { version: active.version } : {})
    };
  }

  private async computeCodexUiSnapshot(params: {
    configuredCommand: string | undefined;
    env: NodeJS.ProcessEnv;
    fingerprint: string;
    force: boolean;
  }): Promise<DesktopCodexDiscoverySnapshot> {
    const discovery = await this.getRawCodexDiscovery(params);
    const candidates: DesktopCodexDiscoveryCandidate[] = discovery.candidates.map(
      (candidate) => ({
        path: candidate.command,
        source: candidate.source as DesktopCodexCandidateSource,
        version: candidate.version ?? null,
        available: candidate.executable
      })
    );
    const resolved = selectResolvedCodexCommand(
      discovery,
      params.configuredCommand ?? "codex"
    );
    let resolvedPath: string | null = null;
    let auth: DesktopCodexAuthProbe | null = null;
    if (
      candidates.some(
        (candidate) => candidate.available && candidate.path === resolved.command
      )
    ) {
      resolvedPath = resolved.command;
      auth = await this.probeCodexAuthentication(resolved.command, params.env);
    }
    const snapshot = deepFreeze({
      candidates,
      resolvedPath,
      auth,
      refreshedAt: new Date(this.now()).toISOString()
    });
    if (
      this.codexPublicationFingerprint(params.configuredCommand, params.env) ===
      params.fingerprint
    ) {
      this.codexUiCache.set(params.fingerprint, snapshot);
    }
    return snapshot;
  }

  private async getRawCodexDiscovery(params: {
    configuredCommand: string | undefined;
    env: NodeJS.ProcessEnv;
    force: boolean;
  }): Promise<RawCodexDiscoverySnapshot> {
    const fingerprint = this.codexPublicationFingerprint(
      params.configuredCommand,
      params.env
    );
    if (!params.force) {
      const cached = this.rawCodexCache.get(fingerprint);
      if (cached !== undefined) {
        this.bumpDiagnostic("codexDiscoveryCacheHits");
        return cached;
      }
    }
    const existing = this.rawCodexInflight.get(fingerprint);
    if (existing !== undefined) {
      this.bumpDiagnostic("codexDiscoveryDedupeHits");
      return existing;
    }
    this.bumpDiagnostic("codexDiscoveryRuns");
    const discovery = this.discoverCodex({
      configuredCommand: params.configuredCommand,
      env: params.env
    }).then((snapshot) => {
      const frozen = deepFreeze(snapshot);
      if (
        this.codexPublicationFingerprint(params.configuredCommand, params.env) ===
        fingerprint
      ) {
        this.rawCodexCache.set(fingerprint, frozen);
      }
      return frozen;
    });
    this.rawCodexInflight.set(fingerprint, discovery);
    try {
      const snapshot = await discovery;
      if (
        this.codexPublicationFingerprint(params.configuredCommand, params.env) !==
        fingerprint
      ) {
        return this.getRawCodexDiscovery({ ...params, force: false });
      }
      return snapshot;
    } finally {
      if (this.rawCodexInflight.get(fingerprint) === discovery) {
        this.rawCodexInflight.delete(fingerprint);
      }
    }
  }

  private async discoverAcpGroups(params: {
    settings: Settings;
    agentIds: readonly string[];
    force: boolean;
  }): Promise<DiscoveredAcpAgentGroup[]> {
    const descriptors = params.agentIds.flatMap((agentId) => {
      const strategy = BUILT_IN_ACP_STRATEGIES.find(
        (candidate) => candidate.id === agentId
      );
      if (strategy === undefined) return [];
      const fingerprint = this.acpPublicationFingerprint(
        params.settings,
        agentId,
        this.env
      );
      return [{ agentId, fingerprint, key: `${agentId}:${fingerprint}`, strategy }];
    });

    const waits = new Set<Promise<void>>();
    const toProbe = descriptors.filter((descriptor) => {
      const existing = this.acpInflight.get(descriptor.key);
      if (existing !== undefined) {
        this.bumpDiagnostic("acpDiscoveryDedupeHits");
        waits.add(existing);
        return false;
      }
      const cached = this.acpCache.get(descriptor.agentId);
      if (!params.force && cached?.fingerprint === descriptor.fingerprint) {
        this.bumpDiagnostic("acpDiscoveryCacheHits");
        return false;
      }
      return true;
    });

    if (toProbe.length > 0) {
      const enabled = new Set(params.settings.ai.acp.enabledAgentIds);
      const overrides: Record<string, string> = {};
      for (const descriptor of toProbe) {
        if (!enabled.has(descriptor.agentId)) continue;
        const override = params.settings.ai.acp.agents?.[
          descriptor.agentId
        ]?.overridePath?.trim();
        if (override) overrides[descriptor.agentId] = override;
      }
      const options: LocalAcpDiscoveryOptions = {
        strategies: toProbe.map((descriptor) => descriptor.strategy),
        includeRejectedCandidates: true,
        ...(Object.keys(overrides).length > 0 ? { overrides } : {})
      };
      this.bumpDiagnostic("acpDiscoveryRuns");
      const batch = this.discoverAcp(options).then(async (groups) => {
        const latest = await this.read();
        for (const descriptor of toProbe) {
          if (
            this.acpPublicationFingerprint(
              latest,
              descriptor.agentId,
              this.env
            ) !==
            descriptor.fingerprint
          ) {
            continue;
          }
          const group = groups.find(
            (candidate) => candidate.strategyId === descriptor.agentId
          );
          const previous = this.acpCache.get(descriptor.agentId);
          const softProbeFailure =
            group !== undefined &&
            group.instances.length === 0 &&
            (group.rejectedInstances?.length ?? 0) > 0;
          if (
            softProbeFailure &&
            previous?.fingerprint === descriptor.fingerprint &&
            previous.group !== null &&
            previous.group.instances.length > 0
          ) {
            continue;
          }
          this.acpCache.set(descriptor.agentId, {
            fingerprint: descriptor.fingerprint,
            group:
              group !== undefined && group.instances.length > 0
                ? deepFreeze(group)
                : null
          });
        }
      });
      for (const descriptor of toProbe) {
        this.acpInflight.set(descriptor.key, batch);
      }
      const cleanup = batch.finally(() => {
        for (const descriptor of toProbe) {
          if (this.acpInflight.get(descriptor.key) === batch) {
            this.acpInflight.delete(descriptor.key);
          }
        }
      });
      waits.add(cleanup);
    }

    await Promise.all(waits);
    const latest = await this.read();
    if (
      descriptors.some(
        (descriptor) =>
          this.acpPublicationFingerprint(
            latest,
            descriptor.agentId,
            this.env
          ) !== descriptor.fingerprint
      )
    ) {
      return this.discoverAcpGroups({
        settings: latest,
        agentIds: params.agentIds,
        force: false
      });
    }
    return descriptors.flatMap((descriptor) => {
      const cached = this.acpCache.get(descriptor.agentId);
      return cached?.fingerprint === descriptor.fingerprint && cached.group !== null
        ? [cached.group]
        : [];
    });
  }

  private observeSnapshot(settings: Settings, notify: boolean): void {
    if (this.publishedSnapshot === settings) return;
    const previous = this.publishedSnapshot;
    if (previous !== null) {
      this.invalidateDiscoveryDependencies(previous, settings);
    }
    this.publishedSnapshot = settings;
    this.snapshotVersion += 1;
    if (!notify || previous === null) return;
    const changedDomains = (Object.keys(settings) as DesktopSettingsDomain[]).filter(
      (domain) => JSON.stringify(previous[domain]) !== JSON.stringify(settings[domain])
    );
    if (changedDomains.length === 0) return;
    for (const subscription of this.subscriptions) {
      const relevant = changedDomains.filter((domain) =>
        subscription.domains.has(domain)
      );
      if (relevant.length === 0) continue;
      subscription.listener({
        version: this.snapshotVersion,
        changedDomains: relevant,
        values: Object.fromEntries(
          relevant.map((domain) => [domain, settings[domain]])
        ) as Pick<Settings, DesktopSettingsDomain>
      });
    }
  }

  private invalidateDiscoveryDependencies(
    previous: Settings,
    settings: Settings
  ): void {
    if (
      codexFingerprint(configuredCodexCommand(previous), this.env) !==
      codexFingerprint(configuredCodexCommand(settings), this.env)
    ) {
      this.codexDiscoveryEpoch += 1;
      this.rawCodexCache.clear();
      this.codexUiCache.clear();
    }

    for (const strategy of BUILT_IN_ACP_STRATEGIES) {
      if (
        acpFingerprint(previous, strategy.id, this.env) ===
        acpFingerprint(settings, strategy.id, this.env)
      ) {
        continue;
      }
      this.acpDiscoveryEpochs.set(
        strategy.id,
        (this.acpDiscoveryEpochs.get(strategy.id) ?? 0) + 1
      );
      this.acpCache.delete(strategy.id);
    }
  }

  private codexPublicationFingerprint(
    configuredCommand: string | undefined,
    env: NodeJS.ProcessEnv
  ): string {
    return `${this.codexDiscoveryEpoch}:${codexFingerprint(configuredCommand, env)}`;
  }

  private acpPublicationFingerprint(
    settings: Settings,
    agentId: string,
    env: NodeJS.ProcessEnv
  ): string {
    return `${this.acpDiscoveryEpochs.get(agentId) ?? 0}:${acpFingerprint(
      settings,
      agentId,
      env
    )}`;
  }

  private bumpDiagnostic(key: keyof DesktopSettingsStoreDiagnostics): void {
    this.diagnostics = { ...this.diagnostics, [key]: this.diagnostics[key] + 1 };
  }
}

function configuredCodexCommand(settings: Settings): string | undefined {
  return settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
    ? settings.codex.pinnedPath
    : undefined;
}

function discoveryEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PWRSNAP_CODEX_COMMAND"
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, env[key] ?? ""]));
}

function codexFingerprint(
  configuredCommand: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  return fingerprint({
    kind: "codex",
    version: DISCOVERY_FINGERPRINT_VERSION,
    platform: process.platform,
    arch: process.arch,
    configuredCommand: configuredCommand ?? "",
    env: discoveryEnvironment(env)
  });
}

function acpFingerprint(
  settings: Settings,
  agentId: string,
  env: NodeJS.ProcessEnv
): string {
  const enabled = settings.ai.acp.enabledAgentIds.includes(agentId);
  return fingerprint({
    kind: "acp",
    version: DISCOVERY_FINGERPRINT_VERSION,
    platform: process.platform,
    arch: process.arch,
    agentId,
    enabled,
    overridePath: enabled
      ? settings.ai.acp.agents?.[agentId]?.overridePath?.trim() ?? ""
      : "",
    env: discoveryEnvironment(env)
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function codexNotFoundMessage(command: string): string {
  return (
    `Codex CLI not found: ${command}. Install the Codex CLI ` +
    (process.platform === "darwin"
      ? `(Codex Desktop / ChatGPT Desktop or \`brew install codex\`), or pin its `
      : `(Codex Desktop / ChatGPT Desktop or another supported CLI install), or pin its `) +
    `full path in Settings → AI.`
  );
}

function clipError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= ERROR_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

let processStore: DesktopSettingsStore | null = null;

export function getDesktopSettingsStore(): DesktopSettingsStore {
  processStore ??= new DesktopSettingsStore({
    filePath: join(app.getPath("userData"), "pwrsnap-settings.json"),
    resolveAppVersion: () => {
      try {
        return typeof app.getVersion === "function" ? app.getVersion() : "";
      } catch {
        return "";
      }
    }
  });
  return processStore;
}

/** Test seam for production-wiring specs. Secrets deliberately do not live
 * in this store and retain their existing encrypted, on-demand substrate. */
export function __setDesktopSettingsStoreForTests(
  store: DesktopSettingsStore | null
): void {
  processStore = store;
}
