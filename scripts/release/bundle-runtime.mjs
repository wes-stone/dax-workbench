import { build } from "esbuild";
import { writeEntry } from "./release-files.mjs";

export async function bundleExcel(root, release) {
    // Only the Node-hosted workbook export uses ExcelJS. Build its official bare
    // workbook entry so every bundled dependency maps to this checkout's lockfile.
    const result = await build({
        absWorkingDir: root,
        entryPoints: ["node_modules/exceljs/lib/exceljs.bare.js"],
        bundle: true, platform: "node", format: "cjs", target: "node24",
        minify: true, legalComments: "inline", write: false, metafile: true,
    });
    await writeEntry(release, "payload/node_modules/exceljs/dist/exceljs.min.js", result.outputFiles[0].contents);
    await writeEntry(release, "runtime-dependencies.json", JSON.stringify({
        entry: "exceljs/lib/exceljs.bare.js",
        inputs: Object.keys(result.metafile.inputs).sort(),
    }, null, 2) + "\n");
}
