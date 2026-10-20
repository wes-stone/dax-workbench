import type { WritingValidation } from "../contracts/writing";
import { WRITING_TEMPLATES } from "../shared/writing.mjs";

export function WritingChecks({ validation }: { validation: WritingValidation }) {
  const { status, errorCount, warningCount, issues, omittedIssues, version, template } = validation;
  const title = WRITING_TEMPLATES.find(item => item.id === template)?.title;
  return <details className="writing-checks" data-status={status}>
    <summary>Documentation checks: <strong>{status === "empty" ? "missing documentation"
      : status === "pass" ? "structure passes" : `${errorCount} ${errorCount === 1 ? "issue" : "issues"} to fix`}</strong>
      {warningCount > 0 && <span> · {warningCount} {warningCount === 1 ? "warning" : "warnings"}</span>}
    </summary>
    <div className="writing-checks-scope">{title} · Rules v{version}. These checks validate structure, not facts, query filters, execution or business correctness.
      Drafts remain saveable; saving does not resolve failed checks.</div>
    {issues.length > 0 && <table>
      <thead><tr><th scope="col">Location</th><th scope="col">What to fix</th></tr></thead>
      <tbody>{issues.map((issue, index) => <tr key={`${issue.code}:${issue.line}:${index}`}>
        <th scope="row">{issue.section || "Document"}<small>Line {issue.line} · {issue.severity}</small></th>
        <td>{issue.message}</td>
      </tr>)}</tbody>
    </table>}
    {omittedIssues > 0 && <div className="writing-checks-scope">{omittedIssues} additional issues. Fix the listed issues, then check again.</div>}
    {!issues.length && <div className="writing-checks-scope">Required sections and table structure are present. Sources and business meaning still need review.</div>}
  </details>;
}
