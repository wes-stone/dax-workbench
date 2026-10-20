import { useState } from "react";
import type { Action } from "./useWorkbench";
import { errorMessage } from "./api";

export function ResultNameSetting({ showFullColumnNames, action }: { showFullColumnNames: boolean; action: Action }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <div className="result-name-setting">
    <label className="check-field" title="Use full source names in the table and Excel/CSV headers. Off uses short captions. Original names remain in JSON and Excel export details.">
      <input type="checkbox" checked={showFullColumnNames} disabled={saving} onChange={event => {
        setSaving(true); setError("");
        void action("result-settings.update", { showFullColumnNames: event.target.checked })
          .catch(reason => setError(errorMessage(reason))).finally(() => setSaving(false));
      }}/>
      Full column names
    </label>
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}
