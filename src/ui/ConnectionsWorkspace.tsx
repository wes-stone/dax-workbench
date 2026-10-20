import { useCallback, useEffect, useState } from "react";
import type { ConnectionDetails, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { ConnectionForm } from "./Drawers";
import { api, errorMessage } from "./api";
import { connectionKindLabel } from "./model";
import { Icon } from "./icons";
import "./connections.css";

export function ConnectionsWorkspace({ state, action, connected, hidden, inert, requested, onDirtyChange }: {
  state: Snapshot; action: Action; connected: boolean; hidden: boolean; onDirtyChange: (dirty: boolean) => void;
  requested?: { id: string; sequence: number };
  inert?: boolean;
}) {
  const activeId = state.documents.find(doc => doc.id === state.activeDocumentId)?.connectionId;
  const [selected, setSelected] = useState(activeId ?? state.connections[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"browse" | "add" | "import">("browse");
  const [details, setDetails] = useState<{ key: string; value: ConnectionDetails }>();
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">(activeId ? "detail" : "list");
  const dirtyChanged = useCallback((value: boolean) => setDraft(value), []);
  useEffect(() => { onDirtyChange(draft); return () => onDirtyChange(false); }, [draft, onDirtyChange]);
  useEffect(() => {
    if (requested) { setSelected(requested.id); setMode("browse"); setMobilePane("detail"); setNotice(""); setError(""); }
  }, [requested]);
  const profile = state.connections.find(item => item.id === selected);
  const inventoryKey = JSON.stringify(state.connections);
  const key = `${selected}:${inventoryKey}:${reload}`;
  const value = details?.key === key ? details.value : undefined;
  const available = connected && state.native.available;
  const hasProfile = Boolean(profile);
  useEffect(() => {
    const abort = new AbortController();
    setDetails(undefined); setDetailError("");
    if (hidden || mode !== "browse" || !hasProfile || !available) return;
    void api.read<ConnectionDetails>("connection.details", { connectionId: selected }, abort.signal).then(value => {
      if (!abort.signal.aborted) setDetails({ key, value });
    }).catch(reason => { if (!abort.signal.aborted) setDetailError(errorMessage(reason)); });
    return () => abort.abort();
  }, [hidden, mode, selected, key, available, hasProfile]);
  async function perform(command: string) {
    setBusy(command); setError(""); setNotice("");
    try {
      const result = await action<{ schema?: { status: string }; message?: string }>(command,
        command === "connection.open" ? { connectionId: selected } : {});
      setReload(value => value + 1);
      setNotice(command === "connection.open" ? `Opened a blank query for ${profile?.name ?? "the selected model"}. Your previous query was preserved; nothing ran.${result.schema?.status !== "available" ? " Model metadata is unavailable; review the canvas diagnostic." : ""}`
        : command === "connections.discover" ? "Desktop discovery finished. Choose a profile to inspect it."
          : "Connection profiles refreshed. Your active query is unchanged.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  }
  const filtered = state.connections.filter(item => `${item.name} ${item.model ?? ""} ${connectionKindLabel(item.kind)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const discovery = state.connectionDiscovery;
  return <section id="connections-workspace" role="tabpanel" aria-labelledby="connections-workspace-tab" className="connections-workspace" hidden={hidden} inert={inert}>
    <header className="connections-heading">
      <div><h2>Connection settings</h2><p>Inspect a profile without changing your query. Open a query only when you are ready.</p></div>
      <div className="button-row">
        <button className="button connections-browse-toggle" onClick={() => setMobilePane(value => value === "list" ? "detail" : "list")}>{mobilePane === "list" ? "Back to details" : "Browse connections"}</button>
        <button className="button" onClick={() => { setMode("import"); setMobilePane("detail"); }} disabled={!available || Boolean(busy)}>Import bundle</button>
        <button className="button primary" onClick={() => { setMode("add"); setMobilePane("detail"); }} disabled={!available || Boolean(busy)}><Icon name="plus" size={14}/>Add connection</button>
      </div>
    </header>
    <div className="connections-body" data-mobile-pane={mobilePane}>
      <aside className="connections-browser" aria-label="Configured connections">
        <label className="connections-search"><span className="sr-only">Search connections</span><Icon name="search" size={15}/><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, model or transport"/></label>
        <div className="connections-count">{filtered.length} of {state.connections.length} connections</div>
        <div className="connection-profiles">
          {filtered.map(item => <button key={item.id} className={mode === "browse" && selected === item.id ? "is-selected" : ""} aria-pressed={mode === "browse" && selected === item.id}
            onClick={() => { setSelected(item.id); setMode("browse"); setMobilePane("detail"); setError(""); setNotice(""); }}>
            <Icon name="database" size={16}/><span><strong>{item.name}</strong><small>{item.model || connectionKindLabel(item.kind)}</small><small>{connectionKindLabel(item.kind)}{item.id === activeId ? " · Current query" : ""}</small></span>
          </button>)}
          {!filtered.length && <p className="connections-empty">{state.connections.length ? "No matching connections. Try a different name or clear the search." : "No profiles available. Refresh DAX MCP profiles, discover Desktop, or add a connection."}</p>}
        </div>
        <div className="connections-sources" role="region" aria-label="DAX MCP connection discovery">
          <h3>Profile sources</h3>
          {discovery && <p role="status">{discovery.status === "unavailable" ? "Connection discovery needs attention." : `${discovery.loaded} configured profiles available.`}</p>}
          {discovery?.warning && <p className="field-error" role="alert">{discovery.warning}</p>}
          {!!discovery?.issues.length && <details><summary>{discovery.issues.length} profile{discovery.issues.length === 1 ? " needs" : "s need"} attention</summary>{discovery.issues.map((issue, index) => <p key={index}><strong>{issue.name}</strong>: {issue.message}</p>)}</details>}
          {state.hostMode === "copilot-canvas" && <button className="button small" disabled={!available || Boolean(busy)} onClick={() => void perform("connections.refresh")}><Icon name="refresh" size={13}/>{busy === "connections.refresh" ? "Refreshing..." : "Refresh DAX MCP connections"}</button>}
          <button className="button small" disabled={!available || Boolean(busy)} onClick={() => void perform("connections.discover")}>{busy === "connections.discover" ? "Discovering..." : "Discover Power BI Desktop"}</button>
          <p className="field-help">Reads local profiles only. No sign-in, model query or dashboard rebinding.</p>
        </div>
      </aside>
      <div className="connection-detail-pane">
        {error && <p className="field-error" role="alert">{error}</p>}
        {notice && <p className="operation-notice" role="status">{notice}</p>}
        {!available && <p className="field-error" role="alert">Connection settings are offline. Reconnect the local controller and native companion to load details.</p>}
        {draft && mode === "browse" && <p className="operation-notice">Your unsaved connection draft is kept in Add connection / Import bundle. Finish or discard it before opening another model.</p>}
        {mode === "browse" && profile && <>
          <header className="connection-detail-heading"><div><h3>{profile.name}</h3><p>{connectionKindLabel(profile.kind)}{selected === activeId ? " · Used by the current query" : ""}</p></div>
            <button className="button" disabled={!available || Boolean(busy) || draft || selected === activeId || profile.capabilities?.query?.status === "unsupported"} onClick={() => void perform("connection.open")}>{selected === activeId ? "Current query connection" : busy === "connection.open" ? "Opening..." : "Open in new query"}</button>
          </header>
          <dl className="connection-facts">
            <div><dt>Model / database</dt><dd>{profile.model || "Not specified"}</dd></div>
            <div><dt>Profile source</dt><dd>{value?.source ?? (detailError || !available ? "Unavailable" : "Loading...")}</dd></div>
            <div><dt>Authentication</dt><dd>{value?.authentication ?? (detailError || !available ? "Unavailable" : "Loading...")}</dd></div>
          </dl>
          {detailError && <div role="alert"><p className="field-error">{detailError}</p><button className="button" onClick={() => setReload(value => value + 1)}>Retry connection details</button></div>}
          {!value && !detailError && available && <p role="status">Loading connection details...</p>}
          {value && <>
            {value.connectionString !== null && <section className="connection-string-section" aria-label="Connection string">
              <div className="section-heading"><h4>Connection string</h4><button className="button small" onClick={async () => {
                try { await navigator.clipboard.writeText(value.connectionString ?? ""); setNotice("Redacted connection string copied."); }
                catch (reason) { setError(`Could not copy the connection string. ${errorMessage(reason)}`); }
              }}>Copy redacted string</button></div>
              <textarea aria-label="Connection string (redacted)" readOnly spellCheck={false} value={value.connectionString}/>
              <p className="field-help">Passwords, user IDs, tokens and unrecognized property values are redacted before leaving the native companion. URL credentials and query parameters are removed. This is not an editable credential form.</p>
            </section>}
            {!!value.properties.length && <section className="connection-properties"><h4>Connection properties</h4><dl>{value.properties.map(property => <div key={property.name}><dt>{property.name}</dt><dd><code>{property.value}</code>{property.redacted && <small>Redacted</small>}</dd></div>)}</dl></section>}
            <p className="field-help">{value.notice}</p>
            <p className="field-help">{value.source === "DAX MCP configuration" ? "To change this profile, edit its DAX MCP configuration and refresh profiles here." : value.source === "Saved Workbench profile" ? "This is the saved Workbench profile, which takes precedence over an automatically discovered copy. Add or explicitly import a replacement configuration rather than editing redacted values." : ""}</p>
          </>}
          <details className="connection-capabilities"><summary>Capabilities and connection identity</summary>
            <p className="field-help">Configured support is not proof of current sign-in or server availability. Inspecting this page never tests or runs a query.</p>
            <dl>{Object.entries(profile.capabilities ?? {}).map(([name, capability]) => <div key={name}><dt>{name}</dt><dd><strong>{capability.status}</strong> - {capability.reason}</dd></div>)}
              <div><dt>Connection ID</dt><dd><code>{profile.id}</code></dd></div></dl>
          </details>
        </>}
        {mode === "browse" && !profile && <p className="connections-empty">Select a connection from the list to inspect its settings.</p>}
        <div className="connection-create" hidden={mode === "browse"}>
          <button className="button quiet" onClick={() => setMode("browse")}>Back to connection details</button>
          <ConnectionForm state={state} action={action} mode={mode} onDirtyChange={dirtyChanged} onSaved={id => { if (id) setSelected(id); setMode("browse"); setReload(value => value + 1); setNotice("Connection configuration saved. No query executed."); }}/>
        </div>
      </div>
    </div>
  </section>;
}
