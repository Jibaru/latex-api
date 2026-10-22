import { TemplateNotFoundError } from "../domain/errors.js";
import type { Principal } from "../domain/job.js";
import { createProject, normalizeProjectPath, type Project } from "../domain/project.js";
import type { Template } from "../domain/template.js";
import type { CompileOptionsInput } from "./compile-project.js";
import type { CoreDeps } from "./deps.js";

export class ListTemplates {
  constructor(private readonly deps: CoreDeps) {}
  execute(): Promise<Template[]> {
    return this.deps.templates.list();
  }
}

export class GetTemplate {
  constructor(private readonly deps: CoreDeps) {}
  async execute(id: string): Promise<Template> {
    const template = await this.deps.templates.get(id);
    if (!template) throw new TemplateNotFoundError(id);
    return template;
  }
}

export interface TemplateOverride {
  path: string;
  content: Uint8Array;
}

/**
 * Builds a project from a template plus user overrides. Overrides replace files with the
 * same path and may add new ones. The caller decides whether to compile sync or async.
 */
export class BuildTemplateProject {
  constructor(private readonly deps: CoreDeps) {}

  async execute(input: {
    templateId: string;
    overrides?: TemplateOverride[];
    engine?: string;
    entrypoint?: string;
    principal?: Principal;
    options?: CompileOptionsInput;
  }): Promise<{ template: Template; project: Project }> {
    const template = await this.deps.templates.get(input.templateId);
    if (!template) throw new TemplateNotFoundError(input.templateId);
    const base = (await this.deps.templates.files(input.templateId)) ?? [];
    const merged = new Map(base.map((f) => [f.path, f.content] as const));
    for (const override of input.overrides ?? []) {
      merged.set(normalizeProjectPath(override.path), override.content);
    }
    const project = createProject(
      {
        files: Array.from(merged, ([path, content]) => ({ path, content })),
        entrypoint: input.entrypoint ?? template.entrypoint,
        engine: input.engine ?? template.engine,
      },
      this.deps.limits,
    );
    return { template, project };
  }
}
