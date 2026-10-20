import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryProject as Project, ProjectFile } from "../contracts/query-projects";
import type { Action } from "./useWorkbench";
import { api, errorMessage } from "./api";
import "./query-projects.css";

export function QueryProject({ id, action, connected, hidden, revision, onChanged }: {
  id: string; action: Action; connected: boolean; hidden: boolean; revision: number; onChanged: () => void;
}) {
  const [project, setProject] = useState<Project>();
  const [file, setFile] = useState<ProjectFile>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const readSequence = useRef(0), fileSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    const next = await api.read<Project>("projects.get", { id });
    if (mounted.current && sequence === readSequence.current) { setProject(next); setQuery(previous => previous || next.sources[0]?.id || ""); }
  }, [id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    void refresh().catch(reason => { if (!cancelled) setError(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [refresh, hidden, revision]);
  const active = project && ["setting-up", "starting", "running"].includes(project.activity.status);
  useEffect(() => {
    if (!active || hidden) return;
    const timer = setInterval(() => { void refresh().catch(reason => setError(errorMessage(reason))); }, 1500);
    return () => clearInterval(timer);
  }, [active, hidden, refresh]);
  async function perform(name: string, payload: object = {}) {
    if (pending.current || !project) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(name, { id, revision: project.revision, ...payload }); await refresh(); onChanged(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function readFile(name: string) {
    const sequence = ++fileSequence.current;
    setError("");
    try { const result = await api.read<ProjectFile>("projects.file", { id, name }); if (mounted.current && sequence === fileSequence.current) setFile(result); }
    catch (reason) { setError(errorMessage(reason)); }
  }
  const runnable = project && ["python", "streamlit", "pack"].includes(project.target);
  return <section className="query-project" aria-label="Query project details">
    {!project ? <p role="status">Loading project details...</p> : <>
      <header><h3>{project.title}</h3><p className="project-status" role="status"><strong>{project.activity.status.replaceAll("-", " ")}</strong> · {project.activity.message}</p></header>
      <dl className="project-properties"><dt>Project type</dt><dd>{project.target}</dd><dt>Local folder</dt><dd>{project.directory}</dd><dt>Storage</dt><dd>Linked plaintext files. Credentials and captured rows were not exported.</dd></dl>
      <div className="project-controls">
        {active ? <button className="button" disabled={busy || !connected} onClick={() => void perform("projects.stop")}>Stop</button>
          : runnable && !project.archived && <>{!project.activity.environmentReady
            ? <button className="button primary" disabled={busy || !connected} onClick={() => void perform("projects.setup")}>Set up environment</button>
            : <>
              <label className="field-label">Query to run<select value={query} onChange={event => setQuery(event.target.value)}>{project.sources.map(source => <option key={source.id} value={source.id}>{source.title} · {source.connectionName}</option>)}</select></label>
              <button className={`button ${project.target === "streamlit" ? "" : "primary"}`} disabled={busy || !connected || !query} onClick={() => void perform("projects.run", { queryId: query })}>Run Python</button>
              {["streamlit", "pack"].includes(project.target) && <button className={`button ${project.target === "streamlit" ? "primary" : ""}`} disabled={busy || !connected} onClick={() => void perform("projects.launch")}>Launch app</button>}
            </>}</>}
        <button className="button" disabled={busy || !connected} onClick={() => void perform("projects.openFolder")}>Open folder</button>
        {project.activity.url && project.activity.status === "running" && <a className="button" href={project.activity.url} target="_blank" rel="noreferrer">Open local app</a>}
        <button className="button quiet" disabled={busy || !connected || Boolean(active)} onClick={() => void perform("projects.organize", { archived: !project.archived })}>{project.archived ? "Restore reference" : "Archive reference"}</button>
      </div>
      {runnable && <p className="field-help">Python setup, runs and app launches all use uv. Setup installs reviewed dependencies into this project's .venv and records uv.lock; runs never install packages. There is no pip or global-Python fallback. Python and package code run with your local permissions, not in a sandbox. Run Python queries the selected model. Launch app waits for Run query in the app. Owned processes stop when this Workbench closes.</p>}
      <h4>Sources</h4>
      <table className="project-source-table"><thead><tr><th>Query</th><th>Model</th><th>Captured evidence</th></tr></thead><tbody>{project.sources.map(source => <tr key={source.id}><td>{source.title}<small>revision {source.revision}</small></td><td>{source.connectionName}</td><td>{source.evidence.truncated ? "Partial" : source.evidence.status}</td></tr>)}</tbody></table>
      <h4>Files</h4>
      <div className="project-files">{project.files.map(item => <button className={`text-button ${file?.name === item.name ? "is-active" : ""}`} key={item.name} onClick={() => void readFile(item.name)}>{item.name}</button>)}</div>
      {file && <section aria-label="Generated file preview"><h4>{file.name}</h4><pre className="project-code" tabIndex={0}>{file.content}</pre></section>}
      <details className="project-independent"><summary>Run independently</summary><p>Use uv sync for setup and uv run --frozen --no-sync for execution. Follow the generated README and connection.example.json to configure your own ADOMD-compatible connection. The independent runner does not inherit Workbench permissions or credentials. REST and isolated Windows MSOLAP profiles need a compatible endpoint. For notebooks, select the project's uv-managed .venv kernel in your editor; opening a notebook does not execute cells.</p></details>
      <details className="project-activity" open={project.activity.status === "failed" || undefined}><summary>Activity (local only)</summary><p className="field-help">Latest 64 KiB of process output. This can include query results; it is not shared with Copilot automatically.</p><pre className="project-code" tabIndex={0}>{project.activity.log || "No process output in this session."}</pre></details>
    </>}
    {error && <div className="field-error" role="alert"><p>{error}</p><button className="button" onClick={() => void refresh().then(() => setError("")).catch(reason => setError(errorMessage(reason)))}>Reload project details</button></div>}
  </section>;
}
