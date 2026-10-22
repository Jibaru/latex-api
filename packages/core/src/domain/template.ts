import type { Engine } from "./engine";

export interface TemplateVariable {
  name: string;
  description: string;
  default?: string;
}

export interface TemplateFileInfo {
  path: string;
  size: number;
  /** Files users are expected to edit (shown first in the UI). */
  editable?: boolean;
}

export interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  category: "paper" | "cv" | "brochure" | "poster" | "report" | "letter" | "other";
  engine: Engine;
  entrypoint: string;
  tags: string[];
  /** Human readable origin / license of the class or template. */
  license: string;
  source?: string;
  variables: TemplateVariable[];
  /** Relative path of a preview image shipped with the template, if any. */
  preview?: string;
  /** Files users are expected to edit. */
  editable?: string[];
}

export interface Template extends TemplateManifest {
  files: TemplateFileInfo[];
}

export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
