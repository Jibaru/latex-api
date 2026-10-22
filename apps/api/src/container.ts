import {
  BuildTemplateProject,
  CancelJob,
  CompileProject,
  type CoreDeps,
  EnqueueCompileJob,
  GetHealth,
  GetJob,
  GetLimits,
  GetStats,
  GetTemplate,
  ListTemplates,
  ProcessCompileJob,
  PurgeExpired,
  RecoverStaleJobs,
} from "@latex-api/core";
import {
  createLogger,
  createPool,
  DockerSiblingCompiler,
  EnvApiKeyResolver,
  FetchWebhookNotifier,
  FsArtifactStore,
  FsTemplateRepository,
  FsWorkspaces,
  type InfraConfig,
  InlineJobQueue,
  loadConfig,
  MemoryJobEvents,
  MemoryJobRepository,
  MemoryRateLimiter,
  PgBossQueue,
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
  };
}

let instance: Container | undefined;

/** Composition root. Built once per process, lazily, so `next build` never touches infra. */
export function getContainer(): Container {
  if (instance) return instance;
  instance = build(loadConfig());
  return instance;
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
    },
  };
}

/** Test hook. */
export function setContainer(container: Container | undefined): void {
  instance = container;
}
