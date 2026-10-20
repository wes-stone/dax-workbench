import os from "node:os";
import path from "node:path";

const directoryError = (code, message) => Object.assign(new Error(message), { code });

function directoryFromTools(tools, registered = false) {
    const directories = new Set();
    for (const tool of tools ?? []) {
        if (registered && tool.mcpServerName !== "dax-query-server") continue;
        if (!["list_connections", "server_info"].includes(tool.mcpToolName ?? tool.name)) continue;
        const directory = (tool.input_schema ?? tool.inputSchema ?? tool.parameters)?.properties?.connections_dir?.default;
        if (directory === undefined || directory === null) continue;
        if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 4096)
            throw directoryError("MCP_DIRECTORY_INVALID", "DAX MCP advertises an invalid local profile folder. Correct its connections_dir setting.");
        directories.add(path.normalize(directory));
    }
    if (directories.size > 1) throw directoryError("MCP_DIRECTORY_AMBIGUOUS", "DAX MCP tools advertise different profile folders. Correct the server configuration before refreshing.");
    return [...directories][0];
}

export class RuntimeMcp {
    constructor(getSession) { this.getSession = getSession; this.tools = []; }
    async connectionDirectory() {
        if (typeof this.getSession()?.rpc?.tools?.getCurrentMetadata === "function") await this.describe();
        const directory = directoryFromTools(this.tools, true);
        if (directory) return { directory, source: "DAX MCP configuration" };
        return {
            directory: process.env.DAX_QUERY_MCP_CONNECTIONS_DIR || path.join(os.homedir(), ".copilot", "dax-query-mcp", "Connections"),
            source: process.env.DAX_QUERY_MCP_CONNECTIONS_DIR ? "Local DAX MCP environment" : "Default local DAX MCP folder",
            warning: "The MCP host did not supply a profile-folder default. Using this host's DAX MCP folder; custom server-only folders require runtime metadata support.",
        };
    }
    async reconnect() {
        const before = await this.diagnostics();
        if (before.available) return { ...before, restarted: false };
        const rpc = this.getSession()?.rpc?.mcp;
        if (typeof rpc?.restartServer !== "function") throw Object.assign(new Error("This runtime cannot reconnect an individual MCP server."), { code: "MCP_RECONNECT_UNAVAILABLE" });
        await rpc.restartServer({ serverName: "dax-query-server" });
        const status = await this.diagnostics();
        if (!status.available) throw Object.assign(new Error(status.metadataProbeError?.message ?? "DAX MCP did not reconnect."), { code: "MCP_RECONNECT_FAILED" });
        return { ...status, restarted: true };
    }
    async describe() {
        const session = this.getSession();
        if (typeof session?.rpc?.tools?.getCurrentMetadata !== "function") return { available: false, message: "This runtime does not expose MCP tool discovery. Use local query-bundle imports." };
        const metadata = await session.rpc.tools.getCurrentMetadata();
        this.tools = (metadata?.tools ?? []).filter(tool => tool.mcpServerName === "dax-query-server");
        return this.tools.length
            ? { available: false, message: `${this.tools.length} DAX MCP tools registered; transport health is unverified. Native execution and local file imports are independent.` }
            : { available: false, message: "DAX MCP tools are not offered in this session. Local connection and query-bundle import is available." };
    }
    async diagnostics() {
        const status = await this.describe();
        const rpc = this.getSession()?.rpc?.tools;
        const mcp = this.getSession()?.rpc?.mcp;
        const info = this.tools.find(tool => tool.mcpToolName === "server_info");
        let metadataProbe = "unavailable";
        let metadataProbeError = null;
        const metadataMethod = typeof mcp?.listTools === "function" ? "tools/list" : "server_info";
        if (metadataMethod === "tools/list" && this.tools.length) {
            try {
                const result = await mcp.listTools({ serverName: "dax-query-server" });
                metadataProbe = Array.isArray(result?.tools) && result.tools.length ? "succeeded" : "failed";
                if (metadataProbe === "failed") metadataProbeError = { code: "MCP_NO_TOOLS", message: "The configured DAX server returned no live tools." };
            } catch (error) {
                metadataProbe = "failed";
                metadataProbeError = { code: String(error?.code ?? "MCP_DISCOVERY_FAILED"), message: String(error?.message ?? "Live DAX MCP discovery failed.").slice(0, 500) };
            }
        } else if (info && typeof rpc?.execute === "function") {
            try {
                const result = await rpc.execute({ name: info.name, arguments: {} });
                metadataProbe = typeof result === "object" && result?.resultType && result.resultType !== "success" ? "failed" : "succeeded";
                if (metadataProbe === "failed") metadataProbeError = { code: result.resultType, message: typeof result.textResultForLlm === "string" ? result.textResultForLlm.slice(0, 500) : "The runtime returned a non-success result for the metadata-only server_info operation." };
            } catch (error) {
                metadataProbe = "failed";
                metadataProbeError = { code: String(error?.code ?? "RUNTIME_TOOL_ERROR"), message: String(error?.message ?? "The runtime metadata operation failed.").slice(0, 500) };
            }
        }
        return {
            ...status,
            available: metadataProbe === "succeeded",
            message: metadataProbe === "succeeded" ? "DAX MCP metadata connection verified. Model queries and native connectivity were not tested by this check." : metadataProbe === "failed" ? `DAX MCP runtime integration check failed: ${metadataProbeError?.message ?? "metadata probe failed"} Native execution and local file imports remain independent.` : status.message,
            toolNames: this.tools.map(tool => tool.mcpToolName),
            executionBridgeAvailable: typeof this.getSession()?.rpc?.tools?.execute === "function",
            metadataProbe,
            metadataMethod,
            metadataProbeError,
            metadataTool: metadataMethod === "server_info" && info ? { name: info.name, namespacedName: info.namespacedName, deferred: info.deferLoading === true } : null,
            dataBearingToolsInvoked: false,
        };
    }
}
