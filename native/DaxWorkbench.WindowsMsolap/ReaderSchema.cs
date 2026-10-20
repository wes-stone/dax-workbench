using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using DaxWorkbench.Shared;

namespace DaxWorkbench.WindowsMsolap
{
    internal static class ReaderSchema
    {
        internal const int MaxObjects = 20000;
        internal const string ReaderWarning = "MDSCHEMA verifies reader-exposed attributes, requesting hidden/internal attributes where supported. Full model coverage and declared types cannot be certified without TMSCHEMA; level types are provider key types. No member values are read.";
        internal static object Read(ISession session, string connectionId, string catalog, CancellationToken token, string requestedCube = null)
        {
            if (string.IsNullOrEmpty(catalog)) throw Invalid("WINDOWS_SCHEMA_CATALOG_REQUIRED", "Reader schema requires an explicit catalog.");
            var warnings = new List<string> { "Windows MSOLAP metadata uses the existing OS-provider session with prompting disabled. No model data queries are executed." };
            if (!string.IsNullOrEmpty(requestedCube))
            {
                ValidateName(requestedCube);
                warnings.Add("Reader metadata is restricted to the configured Cube; model-wide TMSCHEMA discovery was not used.");
                warnings.Add(ReaderWarning);
                try
                {
                    var reader = Reader(session, catalog, token, requestedCube);
                    token.ThrowIfCancellationRequested();
                    return reader.Finish(connectionId, warnings);
                }
                catch (Exception error) { throw Errors.Map(error, "schema"); }
            }
            Snapshot snapshot;
            try { snapshot = Tabular(session, token); }
            catch (Exception error)
            {
                var safe = Errors.Map(error, "schema");
                if (!Unavailable(safe)) throw safe;
                warnings.Add("TMSCHEMA metadata unavailable (" + safe.Code + "); using verified MDSCHEMA reader metadata instead.");
                try { snapshot = Reader(session, catalog, token); }
                catch (Exception readerError) { throw Errors.Map(readerError, "schema"); }
                warnings.Add(ReaderWarning);
            }
            token.ThrowIfCancellationRequested();
            return snapshot.Finish(connectionId, warnings);
        }

        private static Snapshot Tabular(ISession session, CancellationToken token)
        {
            var tableRows = Scan(() => session.Metadata(MetadataRowset.Tables, 30), token, "ID Name Description IsHidden");
            var columnRows = Scan(() => session.Metadata(MetadataRowset.Columns, 30), token,
                "ID TableID ExplicitName InferredName ExplicitDataType InferredDataType Type IsHidden Description DisplayFolder FormatString SortByColumnID");
            var measureRows = Scan(() => session.Metadata(MetadataRowset.Measures, 30), token,
                "ID TableID Name DataType IsHidden Description DisplayFolder FormatString Expression");
            if (tableRows.Count == 0) throw Invalid("WINDOWS_SCHEMA_UNAVAILABLE", "No tabular tables were exposed to this session.");
            var result = new Snapshot("TMSCHEMA", "model");
            var tables = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            var columns = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            var measuresById = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            foreach (var row in tableRows)
            {
                var item = Item("table", Required(row, "Name"), null, "TMSCHEMA_TABLES");
                Copy(row, item, "Description", "description");
                Visibility(row, item, "IsHidden", false);
                AddMapping(tables, Required(row, "ID"), item);
                result.Add(item);
            }
            foreach (var row in columnRows)
            {
                var table = Resolve(tables, Required(row, "TableID"));
                // TOM RowNumber columns are engine internals, not DAX fields.
                var columnType = Number(row, "Type");
                if (columnType == 3) { result.ExcludedSystemColumns++; continue; }
                if (columnType != 1 && columnType != 2 && columnType != 4)
                    throw Malformed("Column kind is missing or unsupported; engine-internal columns cannot be safely distinguished from DAX fields.");
                var name = Text(row, "ExplicitName");
                if (string.IsNullOrEmpty(name)) name = Required(row, "InferredName");
                var item = Item("column", name, (string)table["name"], "TMSCHEMA_COLUMNS");
                var type = Number(row, "ExplicitDataType");
                if (!type.HasValue || type == 1) type = Number(row, "InferredDataType");
                SetType(item, type, true);
                Attributes(row, item);
                AddMapping(columns, Required(row, "ID"), item);
                result.Add(item);
            }
            foreach (var row in measureRows)
            {
                var table = Resolve(tables, Required(row, "TableID"));
                var item = Item("measure", Required(row, "Name"), (string)table["name"], "TMSCHEMA_MEASURES");
                SetType(item, Number(row, "DataType"), true);
                Attributes(row, item);
                Copy(row, item, "Expression", "expression");
                AddMapping(measuresById, Required(row, "ID"), item);
                result.Add(item);
            }
            result.Cover("tables", "complete", "TMSCHEMA_TABLES");
            result.Cover("columns", "complete", "TMSCHEMA_COLUMNS");
            result.Cover("measures", "complete", "TMSCHEMA_MEASURES");
            result.Cover("hiddenObjects", "complete", "TMSCHEMA");
            result.Cover("measureTableAssociation", "complete", "TMSCHEMA_MEASURES");
            result.Cover("measureExpressions", measureRows.All(r => Text(r, "Expression") != null) ? "complete" : "partial",
                "TMSCHEMA_MEASURES", "Only provider-exposed definitions are included.");
            SortDependencies(columnRows, columns, result);
            result.Cover("groupByColumns", "unavailable", "TMSCHEMA_COLUMNS",
                "The fixed metadata rowsets do not expose GroupByColumns dependencies. Absence is not an empty dependency set.");
            result.Cover("hierarchies", "unavailable", "TMSCHEMA",
                "This tabular metadata path does not enumerate hierarchy/level source-column bindings.");
            try
            {
                var rows = Scan(() => session.Metadata(MetadataRowset.Relationships, 30), token,
                    "ID Name IsActive FromTableID FromColumnID FromCardinality ToTableID ToColumnID ToCardinality CrossFilteringBehavior");
                var relationships = new List<Dictionary<string, object>>();
                foreach (var row in rows)
                {
                    var fromTable = Resolve(tables, Required(row, "FromTableID"));
                    var toTable = Resolve(tables, Required(row, "ToTableID"));
                    var fromColumn = Resolve(columns, Required(row, "FromColumnID"));
                    var toColumn = Resolve(columns, Required(row, "ToColumnID"));
                    if (!Equals(fromColumn["table"], fromTable["name"]) || !Equals(toColumn["table"], toTable["name"]))
                        throw Malformed("Relationship endpoints do not match authoritative table/column IDs.");
                    var item = new Dictionary<string, object>
                    {
                        ["id"] = "relationship:" + Hash(Required(row, "ID")), ["source"] = "TMSCHEMA_RELATIONSHIPS",
                        ["fromTable"] = fromTable["name"], ["fromColumn"] = fromColumn["name"],
                        ["toTable"] = toTable["name"], ["toColumn"] = toColumn["name"]
                    };
                    Copy(row, item, "Name", "name");
                    var active = Boolean(row, "IsActive");
                    if (active.HasValue) item["isActive"] = active.Value;
                    EnumValue(row, item, "FromCardinality", "fromCardinality", new[] { "", "one", "many" });
                    EnumValue(row, item, "ToCardinality", "toCardinality", new[] { "", "one", "many" });
                    EnumValue(row, item, "CrossFilteringBehavior", "crossFilteringBehavior", new[] { "", "oneDirection", "bothDirections", "automatic" });
                    relationships.Add(item);
                }
                result.AddRelationships(relationships);
                result.Cover("relationships", "complete", "TMSCHEMA_RELATIONSHIPS");
            }
            catch (Exception error)
            {
                var safe = Errors.Map(error, "schema");
                if (!Unavailable(safe) && safe.Code != "WINDOWS_SCHEMA_INCOMPLETE") throw safe;
                result.Cover("relationships", "unavailable", "TMSCHEMA_RELATIONSHIPS",
                    safe.Code + ": No complete, verified relationship set is available.");
            }
            result.AttributeCoverage();
            return result;
        }

        private static Snapshot Reader(ISession session, string catalog, CancellationToken token, string requestedCube = null)
        {
            var cubes = Scan(() => session.Schema(32, new object[] { catalog, null, null }), token,
                "CUBE_NAME CUBE_TYPE BASE_CUBE_NAME")
                .Where(row => !string.Equals(Text(row, "CUBE_TYPE"), "DIMENSION", StringComparison.OrdinalIgnoreCase))
                .GroupBy(row => Required(row, "CUBE_NAME"), StringComparer.OrdinalIgnoreCase)
                .Select(group => Unique(group)).ToArray();
            var cube = SelectCube(cubes, requestedCube);
            var result = new Snapshot("MDSCHEMA", "reader-exposed");
            result.SelectCube(cube, !string.IsNullOrEmpty(requestedCube) ? "configured" : cubes.Length == 1 ? "only-visible" : "base-cube");
            var tables = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            var measureDimensions = new HashSet<string>(StringComparer.Ordinal);
            var dimensions = ExpandedScan(session, 33, new object[] { catalog, null, cube, null, null, 1, 3 }, 5, token,
                "DIMENSION_TYPE DIMENSION_NAME DIMENSION_UNIQUE_NAME DESCRIPTION DIMENSION_IS_VISIBLE", result);
            foreach (var row in dimensions)
            {
                var unique = Required(row, "DIMENSION_UNIQUE_NAME");
                if (!Number(row, "DIMENSION_TYPE").HasValue) throw Malformed("Dimension metadata did not identify its object type.");
                if (Number(row, "DIMENSION_TYPE") == 2) { measureDimensions.Add(unique); continue; }
                var item = Item("table", Required(row, "DIMENSION_NAME"), null, "MDSCHEMA_DIMENSIONS");
                Copy(row, item, "DESCRIPTION", "description");
                Visibility(row, item, "DIMENSION_IS_VISIBLE", true);
                AddMapping(tables, unique, item);
                result.Add(item);
            }
            if (tables.Count == 0) throw Invalid("WINDOWS_SCHEMA_UNAVAILABLE", "No authoritative parent dimensions were exposed to this reader.");
            result.Cover("tables", "complete", "MDSCHEMA_DIMENSIONS");
            result.Cover("hiddenObjects", "partial", "MDSCHEMA", ReaderWarning);
            result.Cover("relationships", "unavailable", "MDSCHEMA", "Reader hierarchy metadata does not identify tabular relationship endpoints.");
            result.Cover("measureExpressions", "unavailable", "MDSCHEMA", "Reader measures do not expose authoritative DAX definitions.");
            result.Cover("sortByColumns", "unavailable", "MDSCHEMA",
                "Reader level key types and ordering properties do not establish model SortByColumn dependencies.");
            result.Cover("groupByColumns", "unavailable", "MDSCHEMA",
                "Reader metadata does not expose GroupByColumns dependencies. Absence is not an empty dependency set.");
            result.Cover("hierarchies", "unavailable", "MDSCHEMA_HIERARCHIES",
                "Hierarchy expansion requires a complete verified attribute/level mapping.");
            try
            {
                var hierarchies = ExpandedScan(session, 34, new object[] { catalog, null, cube, null, null, null, 15, 1, 3 }, 6, token,
                    "DIMENSION_UNIQUE_NAME HIERARCHY_NAME HIERARCHY_UNIQUE_NAME HIERARCHY_ORIGIN HIERARCHY_IS_VISIBLE HIERARCHY_DISPLAY_FOLDER DESCRIPTION", result);
                var levels = ExpandedScan(session, 35, new object[] { catalog, null, cube, null, null, null, null, 15, 1, 3 }, 7, token,
                    "DIMENSION_UNIQUE_NAME HIERARCHY_UNIQUE_NAME LEVEL_UNIQUE_NAME LEVEL_NAME LEVEL_TYPE LEVEL_DBTYPE LEVEL_NUMBER LEVEL_ATTRIBUTE_HIERARCHY_NAME", result);
                var byHierarchy = levels.GroupBy(row => Required(row, "HIERARCHY_UNIQUE_NAME"), StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);
                var fields = new List<Dictionary<string, object>>();
                var unmapped = 0;
                foreach (var row in hierarchies)
                {
                    var dimension = Required(row, "DIMENSION_UNIQUE_NAME");
                    if (measureDimensions.Contains(dimension)) continue;
                    var origin = Number(row, "HIERARCHY_ORIGIN");
                    if (!origin.HasValue) throw Malformed("Hierarchy origin is missing; attribute fields cannot be distinguished from user hierarchies.");
                    if (origin.Value == 0 || (origin.Value & ~15) != 0) throw Malformed("Hierarchy origin is unknown; no column mapping was guessed.");
                    if ((origin.Value & 14) == 0) continue;
                    if (!tables.ContainsKey(dimension)) { unmapped++; continue; }
                    var table = tables[dimension];
                    var item = Item("column", Required(row, "HIERARCHY_NAME"), (string)table["name"], "MDSCHEMA_HIERARCHIES");
                    Copy(row, item, "DESCRIPTION", "description");
                    Copy(row, item, "HIERARCHY_DISPLAY_FOLDER", "displayFolder");
                    Visibility(row, item, "HIERARCHY_IS_VISIBLE", true);
                    List<Dictionary<string, object>> members;
                    if (byHierarchy.TryGetValue(Required(row, "HIERARCHY_UNIQUE_NAME"), out members))
                    {
                        var realLevels = members.Where(level => Number(level, "LEVEL_TYPE").HasValue && Number(level, "LEVEL_TYPE").Value != 1)
                            .GroupBy(level => Required(level, "LEVEL_UNIQUE_NAME"), StringComparer.Ordinal).Select(group => Unique(group)).ToArray();
                        if (realLevels.Length > 1) throw Malformed("An attribute hierarchy has multiple non-All levels; no DAX column type was guessed.");
                        if (realLevels.Length == 1)
                        {
                            if (Required(realLevels[0], "DIMENSION_UNIQUE_NAME") != dimension)
                                throw Malformed("The level and hierarchy do not identify the same parent dimension.");
                            SetType(item, Number(realLevels[0], "LEVEL_DBTYPE"), false);
                        }
                    }
                    fields.Add(item);
                }
                result.AddObjects(fields);
                result.Cover("columns", "partial", "MDSCHEMA_HIERARCHIES", ReaderWarning +
                    (unmapped == 0 ? "" : " " + unmapped + " attributes lack an exposed parent dimension and are omitted."));
                ReaderHierarchies(hierarchies, levels, fields, tables, measureDimensions, result);
            }
            catch (Exception error)
            {
                var safe = Errors.Map(error, "schema");
                if (!Unavailable(safe) && safe.Code != "WINDOWS_SCHEMA_INCOMPLETE") throw safe;
                result.Cover("columns", "unavailable", "MDSCHEMA_HIERARCHIES", safe.Code + ": No complete verified attribute scan is available.");
            }
            try
            {
                var measures = ExpandedScan(session, 36, new object[] { catalog, null, cube, null, null, null, 1, 3 }, 5, token,
                    "MEASURE_NAME MEASURE_UNIQUE_NAME MEASUREGROUP_NAME DATA_TYPE MEASURE_IS_VISIBLE MEASURE_DISPLAY_FOLDER DEFAULT_FORMAT_STRING DESCRIPTION", result);
                var tableNames = new HashSet<string>(tables.Values.Select(table => (string)table["name"]), StringComparer.Ordinal);
                var items = new List<Dictionary<string, object>>();
                foreach (var row in measures)
                {
                    Required(row, "MEASURE_UNIQUE_NAME");
                    var table = Text(row, "MEASUREGROUP_NAME");
                    var item = Item("measure", Required(row, "MEASURE_NAME"), table != null && tableNames.Contains(table) ? table : null, "MDSCHEMA_MEASURES");
                    Copy(row, item, "MEASUREGROUP_NAME", "measureGroup");
                    Copy(row, item, "DESCRIPTION", "description");
                    Copy(row, item, "MEASURE_DISPLAY_FOLDER", "displayFolder");
                    Copy(row, item, "DEFAULT_FORMAT_STRING", "formatString");
                    Visibility(row, item, "MEASURE_IS_VISIBLE", true);
                    SetType(item, Number(row, "DATA_TYPE"), false);
                    items.Add(item);
                }
                result.AddObjects(items);
                result.Cover("measures", "complete", "MDSCHEMA_MEASURES");
                result.Cover("measureTableAssociation", items.All(item => item.ContainsKey("table")) ? "complete" : "partial",
                    "MDSCHEMA_MEASURES", items.Count(item => !item.ContainsKey("table")) +
                    " measures have no verified table association. Only exact MEASUREGROUP_NAME to dimension-name matches are included.");
            }
            catch (Exception error)
            {
                var safe = Errors.Map(error, "schema");
                if (!Unavailable(safe) && safe.Code != "WINDOWS_SCHEMA_INCOMPLETE") throw safe;
                result.Cover("measures", "unavailable", "MDSCHEMA_MEASURES", safe.Code + ": No complete verified measure scan is available.");
                result.Cover("measureTableAssociation", "unavailable", "MDSCHEMA_MEASURES", "Measure discovery is unavailable.");
            }
            result.AttributeCoverage();
            return result;
        }

        private static string SelectCube(Dictionary<string, object>[] cubes, string requestedCube)
        {
            if (!string.IsNullOrEmpty(requestedCube))
            {
                var selected = cubes.SingleOrDefault(row => string.Equals(Required(row, "CUBE_NAME"), requestedCube, StringComparison.OrdinalIgnoreCase));
                if (selected == null) throw Invalid("WINDOWS_SCHEMA_CUBE_NOT_FOUND",
                    "The configured Cube was not returned for this catalog. Check Cube in the source connection configuration; no different cube was selected.");
                return Required(selected, "CUBE_NAME");
            }
            if (cubes.Length == 0) throw Invalid("WINDOWS_SCHEMA_UNAVAILABLE", "No visible cube was returned for the selected catalog.");
            if (cubes.Length == 1) return Required(cubes[0], "CUBE_NAME");
            // Perspectives are CUBE rows too; only BASE_CUBE_NAME identifies their parent.
            var bases = cubes.Where(row => row.ContainsKey("BASE_CUBE_NAME") && string.IsNullOrEmpty(Text(row, "BASE_CUBE_NAME"))
                && string.Equals(Text(row, "CUBE_TYPE"), "CUBE", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (bases.Length == 1)
            {
                var name = Required(bases[0], "CUBE_NAME");
                if (cubes.All(row => ReferenceEquals(row, bases[0]) ||
                    string.Equals(Text(row, "CUBE_TYPE"), "CUBE", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(Text(row, "BASE_CUBE_NAME"), name, StringComparison.OrdinalIgnoreCase))) return name;
            }
            throw Invalid("WINDOWS_SCHEMA_AMBIGUOUS",
                "Multiple cubes remain without one verified base cube and its perspectives. Set Cube in the source connection configuration; schema names were not merged.");
        }

        private static void SortDependencies(List<Dictionary<string, object>> rows,
            Dictionary<string, Dictionary<string, object>> columns, Snapshot result)
        {
            try
            {
                if (columns.Values.GroupBy(column => (string)column["id"], StringComparer.Ordinal).Any(group => group.Count() > 1))
                    throw Malformed("Multiple provider column IDs resolve to the same DAX object.");
                var bindings = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var row in rows)
                {
                    if (Number(row, "Type") == 3) continue;
                    if (!row.ContainsKey("SortByColumnID")) throw Malformed("SortByColumnID was not exposed by the metadata rowset.");
                    var target = Text(row, "SortByColumnID");
                    if (string.IsNullOrEmpty(target) || target == "0") continue;
                    var fromId = Required(row, "ID");
                    var from = Resolve(columns, fromId);
                    var to = Resolve(columns, target);
                    if (!Equals(from["table"], to["table"]) || fromId == target)
                        throw Malformed("SortByColumnID did not resolve to another verified column in the same table.");
                    bindings[fromId] = target;
                }
                var checkedIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var id in bindings.Keys)
                {
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    var current = id;
                    while (bindings.ContainsKey(current) && !checkedIds.Contains(current))
                    {
                        if (!seen.Add(current)) throw Malformed("SortByColumnID metadata contains a dependency cycle.");
                        current = bindings[current];
                    }
                    checkedIds.UnionWith(seen);
                }
                foreach (var pair in bindings) columns[pair.Key]["sortByColumnId"] = columns[pair.Value]["id"];
                result.Cover("sortByColumns", "complete", "TMSCHEMA_COLUMNS");
            }
            catch (DaxGateError error) when (error.Code == "WINDOWS_SCHEMA_INCOMPLETE")
            {
                result.Cover("sortByColumns", "unavailable", "TMSCHEMA_COLUMNS",
                    error.Message + " No partial sort dependency set was returned.");
            }
        }

        private static void ReaderHierarchies(List<Dictionary<string, object>> hierarchies, List<Dictionary<string, object>> levels,
            List<Dictionary<string, object>> fields, Dictionary<string, Dictionary<string, object>> tables,
            HashSet<string> measureDimensions, Snapshot result)
        {
            try
            {
                var fieldMap = fields.GroupBy(item => (string)item["qualifiedName"], StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => Unique(group), StringComparer.Ordinal);
                var attributes = hierarchies.Where(row => Number(row, "HIERARCHY_ORIGIN").HasValue &&
                    (Number(row, "HIERARCHY_ORIGIN").Value & 14) != 0).ToArray();
                var sources = new Dictionary<string, List<Dictionary<string, object>>>(StringComparer.Ordinal);
                foreach (var attribute in attributes)
                {
                    foreach (var alias in new[] { Required(attribute, "HIERARCHY_NAME"), Required(attribute, "HIERARCHY_UNIQUE_NAME") }.Distinct())
                    {
                        var key = Required(attribute, "DIMENSION_UNIQUE_NAME") + "\0" + alias;
                        List<Dictionary<string, object>> candidates;
                        if (!sources.TryGetValue(key, out candidates)) sources.Add(key, candidates = new List<Dictionary<string, object>>());
                        candidates.Add(attribute);
                    }
                }
                var levelLookup = levels.ToLookup(level => Required(level, "HIERARCHY_UNIQUE_NAME"), StringComparer.Ordinal);
                var staged = new List<Dictionary<string, object>>();
                foreach (var row in hierarchies)
                {
                    var dimension = Required(row, "DIMENSION_UNIQUE_NAME");
                    if (measureDimensions.Contains(dimension) || Number(row, "HIERARCHY_ORIGIN") != 1) continue;
                    var table = Resolve(tables, dimension);
                    var item = Item("hierarchy", Required(row, "HIERARCHY_NAME"), (string)table["name"], "MDSCHEMA_HIERARCHIES");
                    Copy(row, item, "HIERARCHY_DISPLAY_FOLDER", "displayFolder");
                    Copy(row, item, "DESCRIPTION", "description");
                    Visibility(row, item, "HIERARCHY_IS_VISIBLE", true);
                    var unique = Required(row, "HIERARCHY_UNIQUE_NAME");
                    var members = levelLookup[unique]
                        .GroupBy(level => Required(level, "LEVEL_UNIQUE_NAME"), StringComparer.Ordinal).Select(group => Unique(group)).ToArray();
                    var mapped = new List<Dictionary<string, object>>();
                    var ordinals = new HashSet<int>();
                    foreach (var level in members)
                    {
                        var type = Number(level, "LEVEL_TYPE");
                        if (!type.HasValue) throw Malformed("A hierarchy level did not expose its level type.");
                        if (type == 1) continue;
                        if (Required(level, "DIMENSION_UNIQUE_NAME") != dimension)
                            throw Malformed("A hierarchy level does not match its parent dimension.");
                        var source = Required(level, "LEVEL_ATTRIBUTE_HIERARCHY_NAME");
                        List<Dictionary<string, object>> candidates;
                        if (!sources.TryGetValue(dimension + "\0" + source, out candidates))
                            throw Malformed("A hierarchy level source does not identify a verified attribute.");
                        var matches = candidates
                            .GroupBy(attribute => Required(attribute, "HIERARCHY_UNIQUE_NAME"), StringComparer.Ordinal)
                            .Select(group => Unique(group)).ToArray();
                        if (matches.Length != 1) throw Malformed("A hierarchy level source does not resolve to exactly one authoritative attribute.");
                        var field = Item("column", Required(matches[0], "HIERARCHY_NAME"), (string)table["name"], "MDSCHEMA_HIERARCHIES");
                        var column = Resolve(fieldMap, (string)field["qualifiedName"]);
                        var ordinal = Number(level, "LEVEL_NUMBER");
                        if (!ordinal.HasValue || ordinal < 0 || ordinal > MaxObjects || !ordinals.Add(ordinal.Value))
                            throw Malformed("Hierarchy level order is missing or ambiguous.");
                        mapped.Add(new Dictionary<string, object>
                        {
                            ["id"] = "level:" + Hash(Required(level, "LEVEL_UNIQUE_NAME")),
                            ["name"] = Required(level, "LEVEL_NAME"), ["ordinal"] = ordinal.Value, ["columnId"] = column["id"]
                        });
                    }
                    if (mapped.Count == 0) throw Malformed("A user hierarchy has no verified column-backed levels.");
                    item["levels"] = mapped.OrderBy(level => (int)level["ordinal"]).ToList();
                    staged.Add(item);
                }
                result.AddHierarchies(staged);
                result.Cover("hierarchies", "complete", "MDSCHEMA_HIERARCHIES");
            }
            catch (DaxGateError error) when (error.Code == "WINDOWS_SCHEMA_INCOMPLETE")
            {
                result.Cover("hierarchies", "unavailable", "MDSCHEMA_HIERARCHIES",
                    error.Message + " No partial hierarchy expansion set was returned.");
            }
        }

        private static List<Dictionary<string, object>> ExpandedScan(ISession session, int rowset, object[] restrictions, int basicLength,
            CancellationToken token, string fields, Snapshot result)
        {
            try { return Scan(() => session.Schema(rowset, restrictions), token, fields); }
            catch (Exception error)
            {
                var safe = Errors.Map(error, "schema");
                if (!Unavailable(safe)) throw safe;
                result.RestrictionWarnings.Add("Rowset " + rowset + " all-visibility/internal-attribute restrictions were unavailable (" +
                    safe.Code + "); only the provider's default reader scope was scanned.");
                return Scan(() => session.Schema(rowset, restrictions.Take(basicLength).ToArray()), token, fields);
            }
        }

        private sealed class Snapshot
        {
            private readonly string source, scope;
            private readonly Dictionary<string, Dictionary<string, object>> objects = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            private readonly Dictionary<string, Dictionary<string, object>> identities = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, Dictionary<string, object>> relationships = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            private readonly Dictionary<string, Dictionary<string, object>> hierarchies = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            private readonly Dictionary<string, object> coverage = new Dictionary<string, object>();
            internal int ExcludedSystemColumns;
            internal readonly List<string> RestrictionWarnings = new List<string>();
            internal Snapshot(string source, string scope) { this.source = source; this.scope = scope; }
            internal void SelectCube(string name, string selection)
            {
                coverage["cube"] = new Dictionary<string, object>
                {
                    ["status"] = "complete", ["source"] = "MDSCHEMA_CUBES", ["name"] = name, ["selection"] = selection
                };
            }
            internal void Add(Dictionary<string, object> item)
            {
                AddMapping(identities, Identity(item), item);
                AddMapping(objects, (string)item["id"], item);
                if (objects.Count + relationships.Count + HierarchySize() > MaxObjects) throw TooLarge();
            }
            internal void AddObjects(List<Dictionary<string, object>> items)
            {
                var staged = new Dictionary<string, Dictionary<string, object>>(objects, StringComparer.Ordinal);
                var stagedIdentities = new Dictionary<string, Dictionary<string, object>>(identities, StringComparer.OrdinalIgnoreCase);
                foreach (var item in items)
                {
                    AddMapping(stagedIdentities, Identity(item), item);
                    AddMapping(staged, (string)item["id"], item);
                }
                if (staged.Count + relationships.Count + HierarchySize() > MaxObjects) throw TooLarge();
                foreach (var pair in staged)
                    if (!objects.ContainsKey(pair.Key)) objects.Add(pair.Key, pair.Value);
                foreach (var pair in stagedIdentities)
                    if (!identities.ContainsKey(pair.Key)) identities.Add(pair.Key, pair.Value);
            }
            internal void AddRelationships(List<Dictionary<string, object>> items)
            {
                var staged = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
                foreach (var item in items) AddMapping(staged, (string)item["id"], item);
                if (objects.Count + staged.Count + HierarchySize() > MaxObjects) throw TooLarge();
                foreach (var pair in staged) relationships.Add(pair.Key, pair.Value);
            }
            internal void AddHierarchies(List<Dictionary<string, object>> items)
            {
                var staged = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
                foreach (var item in items)
                {
                    var key = (string)item["id"];
                    Dictionary<string, object> existing;
                    if (staged.TryGetValue(key, out existing))
                    {
                        if (!Wire.Bytes(existing).SequenceEqual(Wire.Bytes(item))) throw Malformed("Conflicting duplicate hierarchy metadata was returned.");
                    }
                    else staged.Add(key, item);
                }
                var size = staged.Count + staged.Values.Sum(item => ((List<Dictionary<string, object>>)item["levels"]).Count);
                if (objects.Count + relationships.Count + size > MaxObjects) throw TooLarge();
                foreach (var pair in staged) hierarchies.Add(pair.Key, pair.Value);
            }
            private int HierarchySize() => hierarchies.Count + hierarchies.Values.Sum(item => ((List<Dictionary<string, object>>)item["levels"]).Count);
            internal void Cover(string facet, string status, string rowset, string reason = null)
            {
                var value = new Dictionary<string, object> { ["status"] = status, ["source"] = rowset };
                if (status != "complete" && reason != null) value["reason"] = reason;
                coverage[facet] = value;
            }
            internal void AttributeCoverage()
            {
                var fields = objects.Values.Where(item => (string)item["kind"] != "table").ToArray();
                Cover("dataTypes", fields.All(item => item.ContainsKey("dataType") && (string)item["dataType"] != "Variant") && source == "TMSCHEMA" ? "complete" : "partial",
                    source, source == "TMSCHEMA" ? "Missing or unknown provider type codes are not inferred." : ReaderWarning);
                Cover("displayFolders", fields.All(item => item.ContainsKey("displayFolder")) ? "complete" : "partial", source,
                    "Absent folders are unknown; empty strings are known root folders.");
                Cover("visibility", objects.Values.All(item => item.ContainsKey("isHidden")) ? "complete" : "partial", source,
                    "Visibility is included only when explicitly exposed by the provider.");
            }
            internal object Finish(string connectionId, List<string> warnings)
            {
                var partial = coverage.Values.Cast<Dictionary<string, object>>().Any(value => (string)value["status"] != "complete");
                foreach (var pair in coverage)
                {
                    var value = (Dictionary<string, object>)pair.Value;
                    if (value.ContainsKey("reason")) warnings.Add(pair.Key + ": " + (string)value["reason"]);
                }
                coverage["status"] = partial ? "partial" : "complete";
                warnings.AddRange(RestrictionWarnings);
                coverage["scope"] = scope;
                coverage["source"] = source;
                coverage["counts"] = new
                {
                    tables = objects.Values.Count(item => (string)item["kind"] == "table"),
                    columns = objects.Values.Count(item => (string)item["kind"] == "column"),
                    measures = objects.Values.Count(item => (string)item["kind"] == "measure"),
                    relationships = relationships.Count,
                    hierarchies = hierarchies.Count,
                    hierarchyLevels = HierarchySize() - hierarchies.Count,
                    excludedSystemColumns = ExcludedSystemColumns
                };
                var result = new
                {
                    connectionId, objects = objects.Values.ToList(), relationships = relationships.Values.ToList(), hierarchies = hierarchies.Values.ToList(),
                    fetchedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture), warnings = warnings.Distinct().ToList(), coverage
                };
                if (Wire.Bytes(result).Length > Wire.MaxLineBytes - 4096) throw TooLarge();
                return result;
            }
        }

        private static List<Dictionary<string, object>> Scan(Func<IRowset> open, CancellationToken token, string fields)
        {
            token.ThrowIfCancellationRequested();
            var result = new List<Dictionary<string, object>>();
            var wanted = new HashSet<string>(fields.Split(' '), StringComparer.OrdinalIgnoreCase);
            using (var rows = open())
            {
                if (rows == null) throw Invalid("WINDOWS_SCHEMA_UNAVAILABLE", "The provider returned no metadata rowset.");
                if (rows.FieldCount > 256) throw TooLarge();
                var selected = new Dictionary<int, string>();
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (var i = 0; i < rows.FieldCount; i++)
                {
                    var name = rows.Name(i);
                    if (!wanted.Contains(name)) continue;
                    if (!names.Add(name)) throw Malformed("The metadata rowset contains ambiguous duplicate fields.");
                    selected.Add(i, name);
                }
                long bytes = 0;
                while (rows.Read())
                {
                    token.ThrowIfCancellationRequested();
                    if (result.Count >= MaxObjects) throw TooLarge();
                    var row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                    foreach (var pair in selected)
                    {
                        var value = rows.Value(pair.Key);
                        if (value == null || value is DBNull) { row[pair.Value] = null; continue; }
                        var text = Convert.ToString(value, CultureInfo.InvariantCulture);
                        if (text.Length > 65536) throw TooLarge();
                        row[pair.Value] = text;
                    }
                    bytes += Wire.Bytes(row).Length;
                    if (bytes > Wire.MaxLineBytes) throw TooLarge();
                    result.Add(row);
                }
            }
            return result;
        }
        private static Dictionary<string, object> Item(string kind, string name, string table, string source)
        {
            ValidateName(name);
            if (table != null) ValidateName(table);
            var qualified = kind == "table" ? QuoteTable(name) : (table == null ? "" : QuoteTable(table)) + "[" + name.Replace("]", "]]") + "]";
            var item = new Dictionary<string, object>
            {
                ["id"] = kind + ":" + Hash(qualified), ["name"] = name, ["kind"] = kind, ["qualifiedName"] = qualified, ["source"] = source
            };
            if (table != null) item["table"] = table;
            return item;
        }
        private static string QuoteTable(string name) => "'" + name.Replace("'", "''") + "'";
        private static void ValidateName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 4096 || name.Any(char.IsControl)) throw Malformed("A provider object name is missing or invalid.");
        }
        private static void Attributes(Dictionary<string, object> row, Dictionary<string, object> item)
        {
            Copy(row, item, "Description", "description");
            Copy(row, item, "DisplayFolder", "displayFolder");
            Copy(row, item, "FormatString", "formatString");
            Visibility(row, item, "IsHidden", false);
        }
        private static void Copy(Dictionary<string, object> row, Dictionary<string, object> item, string from, string to)
        {
            var value = Text(row, from);
            if (value != null) item[to] = value;
        }
        private static void Visibility(Dictionary<string, object> row, Dictionary<string, object> item, string key, bool invert)
        {
            var value = Boolean(row, key);
            if (value.HasValue) item["isHidden"] = invert ? !value.Value : value.Value;
        }
        private static bool? Boolean(Dictionary<string, object> row, string key)
        {
            var text = Text(row, key);
            if (text == null) return null;
            bool value;
            if (bool.TryParse(text, out value)) return value;
            if (text == "1" || text == "-1") return true;
            if (text == "0") return false;
            throw Malformed("A metadata visibility/activity flag is invalid.");
        }
        private static void SetType(Dictionary<string, object> item, int? type, bool tabular)
        {
            if (!type.HasValue) return;
            item["nativeDataType"] = (tabular ? "TOM:" : "DBTYPE:") + type.Value.ToString(CultureInfo.InvariantCulture);
            item["dataType"] = tabular ? TabularType(type.Value) : Cells.TypeName(type.Value);
        }
        internal static string TabularType(int type)
        {
            switch (type)
            {
                case 2: return "String";
                case 6: return "Int64";
                case 8: return "Double";
                case 9: return "DateTime";
                case 10: return "Decimal";
                case 11: return "Boolean";
                case 17: return "Binary";
                default: return "Variant";
            }
        }
        private static void EnumValue(Dictionary<string, object> row, Dictionary<string, object> item, string from, string to, string[] values)
        {
            var value = Number(row, from);
            if (!value.HasValue) return;
            if (value.Value < 1 || value.Value >= values.Length) throw Malformed("A relationship property has an unsupported enumeration value.");
            item[to] = values[value.Value];
        }
        private static Dictionary<string, object> Resolve(Dictionary<string, Dictionary<string, object>> items, string id)
        {
            Dictionary<string, object> value;
            if (!items.TryGetValue(id, out value)) throw Malformed("Metadata references a parent or endpoint that was not exposed; no association was guessed.");
            return value;
        }
        private static Dictionary<string, object> Unique(IEnumerable<Dictionary<string, object>> items)
        {
            var first = items.First();
            if (items.Any(item => !Same(first, item))) throw Malformed("Conflicting duplicate metadata was returned.");
            return first;
        }
        private static bool Same(Dictionary<string, object> left, Dictionary<string, object> right) =>
            left.Count == right.Count && left.All(pair => right.ContainsKey(pair.Key) && Equals(pair.Value, right[pair.Key]));
        private static string Identity(Dictionary<string, object> item) => item["kind"] + "\0" + item["qualifiedName"];
        private static void AddMapping(Dictionary<string, Dictionary<string, object>> items, string key, Dictionary<string, object> item)
        {
            Dictionary<string, object> existing;
            if (items.TryGetValue(key, out existing))
            {
                if (!Same(existing, item)) throw Malformed("Conflicting duplicate metadata was returned.");
            }
            else items.Add(key, item);
        }
        private static string Text(Dictionary<string, object> row, string key)
        {
            object value;
            return row.TryGetValue(key, out value) ? (string)value : null;
        }
        private static string Required(Dictionary<string, object> row, string key)
        {
            var value = Text(row, key);
            if (string.IsNullOrEmpty(value)) throw Malformed("Required metadata field " + key + " was not exposed.");
            return value;
        }
        private static int? Number(Dictionary<string, object> row, string key)
        {
            var text = Text(row, key);
            if (text == null) return null;
            int value;
            if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) throw Malformed("A metadata type/origin code is invalid.");
            return value;
        }
        private static string Hash(string text)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
        }
        private static bool Unavailable(DaxGateError error) => error.Code == "WINDOWS_SCHEMA_ACCESS_DENIED" || error.Code == "WINDOWS_SCHEMA_UNAVAILABLE";
        private static DaxGateError Invalid(string code, string message) => new DaxGateError(code, message);
        private static DaxGateError Malformed(string message) => Invalid("WINDOWS_SCHEMA_INCOMPLETE", message);
        private static DaxGateError TooLarge() => Invalid("SCHEMA_TOO_LARGE", "Metadata exceeds the bounded 20000-object/2-MiB budget; no truncated schema was returned.");
    }
}
