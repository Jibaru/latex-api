export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  /** Extra lines from the log that help understand the message. */
  context?: string;
  /** Package or class that emitted the message, when known. */
  source?: string;
}
