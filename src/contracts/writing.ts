export type WritingKind = "query" | "research" | "note" | "journal";
export interface WritingIssue {
  code: string;
  severity: "error" | "warning";
  line: number;
  section?: string;
  message: string;
}
export interface WritingSummary {
  version: number;
  status: "pass" | "needs-attention" | "empty";
  errorCount: number;
  warningCount: number;
  checkedDocuments: number;
}
export interface WritingValidation extends WritingSummary {
  template: WritingKind;
  issues: WritingIssue[];
  omittedIssues: number;
  scope: "structure-only";
}
