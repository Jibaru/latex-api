import type { Limits } from "../domain/limits";
import type {
  ApiKeyResolver,
  ArtifactStore,
  Clock,
  Compiler,
  IdGenerator,
  JobEvents,
  JobQueue,
  JobRepository,
  Logger,
  RateLimiter,
  TemplateRepository,
  WebhookNotifier,
  Workspaces,
} from "../ports/index";

export interface CoreDeps {
  limits: Limits;
  compiler: Compiler;
  workspaces: Workspaces;
  artifacts: ArtifactStore;
  jobs: JobRepository;
  queue: JobQueue;
  events: JobEvents;
  rateLimiter: RateLimiter;
  apiKeys: ApiKeyResolver;
  templates: TemplateRepository;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  webhooks: WebhookNotifier;
}

export const artifactKeys = {
  prefix: (projectHash: string) => `artifacts/${projectHash}`,
  pdf: (projectHash: string) => `artifacts/${projectHash}/output.pdf`,
  log: (projectHash: string) => `artifacts/${projectHash}/output.log`,
};
