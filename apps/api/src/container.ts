import {
  ApproveDeviceAuthorization,
  BuildTemplateProject,
  CancelJob,
  CompileProject,
  type CoreDeps,
  CreateApiToken,
  DenyDeviceAuthorization,
  EnqueueCompileJob,
  GetDeviceAuthorization,
  GetHealth,
  GetJob,
  GetLimits,
  GetStats,
  GetTemplate,
  ListApiTokens,
  ListJobs,
  ListTemplates,
  PollDeviceAuthorization,
  ProcessCompileJob,
  PurgeExpired,
  RecoverStaleJobs,
  ResolveCredential,
  RevokeApiToken,
  StartDeviceAuthorization,
} from "@latex-api/core";
import {
  ClerkSessionVerifier,
  createLogger,
  createPool,
  DockerSiblingCompiler,
  disabledSessions,
  EnvApiKeyResolver,
  FetchWebhookNotifier,
  FsArtifactStore,
  FsTemplateRepository,
  FsWorkspaces,
  type InfraConfig,
  InlineJobQueue,
  loadConfig,
  MemoryApiTokenRepository,
  MemoryDeviceAuthRepository,
  MemoryJobEvents,
  MemoryJobRepository,
  MemoryRateLimiter,
  PgApiTokenRepository,
  PgBossQueue,
  PgDeviceAuthRepository,
  PgJobRepository,
  type PgPool,
  systemClock,
  uuidIds,
} from "@latex-api/infra";

export interface Container {
  config: InfraConfig;
  deps: CoreDeps;
  compiler: DockerSiblingCompiler;
  workspaces: FsWorkspaces;
  templates: FsTemplateRepository;
  events: MemoryJobEvents;
  rateLimiter: MemoryRateLimiter;
  apiKeys: EnvApiKeyResolver;
  pool: PgPool | undefined;
  queue: PgBossQueue | InlineJobQueue;
  useCases: {
    compileProject: CompileProject;
    enqueueCompileJob: EnqueueCompileJob;
    processCompileJob: ProcessCompileJob;
    getJob: GetJob;
    cancelJob: CancelJob;
    listTemplates: ListTemplates;
    getTemplate: GetTemplate;
    buildTemplateProject: BuildTemplateProject;
    purgeExpired: PurgeExpired;
    recoverStaleJobs: RecoverStaleJobs;
    getLimits: GetLimits;
    getStats: GetStats;
    getHealth: GetHealth;
    resolveCredential: ResolveCredential;
    createApiToken: CreateApiToken;
    listApiTokens: ListApiTokens;
    revokeApiToken: RevokeApiToken;
    listJobs: ListJobs;
    startDevice: StartDeviceAuthorization;
    getDevice: GetDeviceAuthorization;
    approveDevice: ApproveDeviceAuthorization;
    denyDevice: DenyDeviceAuthorization;
    pollDevice: PollDeviceAuthorization;
  };
}

const GLOBAL_KEY = Symbol.for("latex-api.container");
type GlobalWithContainer = typeof globalThis & { [GLOBAL_KEY]?: Container };

/**
 * Composition root. Built once per process, lazily, so `next build` never touches infra.
 * Stored on globalThis because Next.js bundles instrumentation and route handlers
 * separately; module-level singletons would otherwise be duplicated.
 */
export function getContainer(): Container {
  const g = globalThis as GlobalWithContainer;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = build(loadConfig());
  return g[GLOBAL_KEY];
}

export function build(config: InfraConfig): Container {
  const logger = createLogger(config.logLevel, { service: "latex-api" });
  const workspaces = new FsWorkspaces(config.dataDir, config.hostDataDir);
  const compiler = new DockerSiblingCompiler({
    image: config.compilerImage,
    limits: config.limits,
    workspaces,
    logger,
    user: config.compilerUser,
    runtime: config.compilerRuntime,
    seccompProfile: config.compilerSeccompProfile,
    socketPath: config.dockerSocket,
    pullIfMissing: true,
  });
  const artifacts = new FsArtifactStore(config.dataDir);
  const events = new MemoryJobEvents();
  const rateLimiter = new MemoryRateLimiter();
  const apiKeys = new EnvApiKeyResolver(config.apiKeys);
  const templates = new FsTemplateRepository(config.templatesDir);

  const pool = config.databaseUrl ? createPool(config.databaseUrl) : undefined;
  const jobs = pool ? new PgJobRepository(pool) : new MemoryJobRepository();
  const queue = config.databaseUrl
    ? new PgBossQueue({ connectionString: config.databaseUrl, logger })
    : new InlineJobQueue();

  if (!pool) logger.warn("DATABASE_URL not set: using in-memory jobs and an inline queue");
  const sessions = config.clerkSecretKey
    ? new ClerkSessionVerifier({
        secretKey: config.clerkSecretKey,
        jwtKey: config.clerkJwtKey,
        authorizedParties: config.clerkAuthorizedParties,
        logger,
      })
    : disabledSessions;
  if (!config.clerkSecretKey)
    logger.warn("CLERK_SECRET_KEY not set: user sign-in and personal tokens are disabled");
  if (apiKeys.size === 0)
    logger.warn("API_KEYS not set: every authenticated endpoint will reject requests");

  const deps: CoreDeps = {
    limits: config.limits,
    compiler,
    workspaces,
    artifacts,
    jobs,
    queue,
    events,
    rateLimiter,
    apiKeys,
    templates,
    clock: systemClock,
    ids: uuidIds,
    logger,
    webhooks: new FetchWebhookNotifier(logger),
    tokens: pool ? new PgApiTokenRepository(pool) : new MemoryApiTokenRepository(),
    devices: pool ? new PgDeviceAuthRepository(pool) : new MemoryDeviceAuthRepository(),
    sessions,
  };

  return {
    config,
    deps,
    compiler,
    workspaces,
    templates,
    events,
    rateLimiter,
    apiKeys,
    pool,
    queue,
    useCases: {
      compileProject: new CompileProject(deps),
      enqueueCompileJob: new EnqueueCompileJob(deps),
      processCompileJob: new ProcessCompileJob(deps),
      getJob: new GetJob(deps),
      cancelJob: new CancelJob(deps),
      listTemplates: new ListTemplates(deps),
      getTemplate: new GetTemplate(deps),
      buildTemplateProject: new BuildTemplateProject(deps),
      purgeExpired: new PurgeExpired(deps),
      recoverStaleJobs: new RecoverStaleJobs(deps),
      getLimits: new GetLimits(deps),
      getStats: new GetStats(deps),
      getHealth: new GetHealth(deps),
      resolveCredential: new ResolveCredential(deps),
      createApiToken: new CreateApiToken(deps),
      listApiTokens: new ListApiTokens(deps),
      revokeApiToken: new RevokeApiToken(deps),
      listJobs: new ListJobs(deps),
      startDevice: new StartDeviceAuthorization(deps),
      getDevice: new GetDeviceAuthorization(deps),
      approveDevice: new ApproveDeviceAuthorization(deps),
      denyDevice: new DenyDeviceAuthorization(deps),
      pollDevice: new PollDeviceAuthorization(deps),
    },
  };
}

/** Test hook. */
export function setContainer(container: Container | undefined): void {
  (globalThis as GlobalWithContainer)[GLOBAL_KEY] = container;
}
