import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fail } from "../application/policy.mjs";

const execute = promisify(execFile);

async function isFile(file) {
    try { return (await stat(file)).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function excelPath(value, env = process.env) {
    const expanded = value.trim().replace(/^"(.+)"$/, "$1").replace(/%([^%]+)%/g, (match, key) =>
        Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? match);
    return /^[A-Za-z]:\\/.test(expanded) && path.win32.basename(expanded).toLowerCase() === "excel.exe"
        && !/["\r\n\0]/.test(expanded) ? path.win32.normalize(expanded) : null;
}

export async function findExcel({ env = process.env, executeFile = execute, exists = isFile } = {}) {
    const registry = path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
    for (const hive of ["HKCU", "HKLM"]) for (const view of ["64", "32"]) {
        let output;
        try {
            output = await executeFile(registry, ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe`, "/ve", `/reg:${view}`],
                { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
        } catch (error) {
            if (error.code === 1) continue; // A missing App Paths entry is normal for some Office installations.
            throw fail("EXCEL_DISCOVERY_FAILED", "Windows could not check the installed Excel application. Download the file instead.");
        }
        const value = output.stdout.match(/\sREG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1];
        const candidate = value && excelPath(value, env);
        if (candidate && await exists(candidate)) return candidate;
    }
    for (const base of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean))
        for (const folder of ["root\\Office16", "Office16", "Office15"]) {
            const candidate = excelPath(path.win32.join(base, "Microsoft Office", folder, "EXCEL.EXE"), env);
            if (candidate && await exists(candidate)) return candidate;
        }
    throw fail("EXCEL_NOT_INSTALLED", "Microsoft Excel was not found on this Windows computer. Install Excel or download the file instead.");
}

export async function launchExcel(file, { platform = process.platform, locate = findExcel, spawnProcess = spawn } = {}) {
    if (platform !== "win32") throw fail("EXCEL_OPEN_UNSUPPORTED", "Opening desktop Excel is currently supported on Windows. Download the file instead.");
    if (!path.isAbsolute(file) || ![".xlsx", ".csv"].includes(path.extname(file).toLowerCase()) || !(await stat(file)).isFile())
        throw fail("INVALID_EXPORT", "Only a saved local XLSX or CSV export can be opened in Excel.");
    const executable = await locate();
    if (!excelPath(executable)) throw fail("EXCEL_DISCOVERY_FAILED", "The registered Excel application path is invalid. Download the file instead.");
    return new Promise((resolve, reject) => {
        // Isolate exports from existing workbooks and enterprise add-in authentication prompts.
        const child = spawnProcess(executable, ["/safe", "/x", file], { shell: false, windowsHide: false, stdio: "ignore" });
        child.once("error", () => reject(fail("EXCEL_LAUNCH_FAILED", "Windows could not start Excel. Download the saved export instead.")));
        child.once("spawn", () => { child.unref(); resolve({ processId: child.pid }); });
    });
}
