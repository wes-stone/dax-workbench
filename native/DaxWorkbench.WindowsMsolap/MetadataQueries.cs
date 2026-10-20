using DaxWorkbench.Shared;

namespace DaxWorkbench.WindowsMsolap
{
    internal enum MetadataRowset { Tables, Columns, Measures, Relationships }

    internal static class MetadataQueries
    {
        // This allowlist is private to schema.get. No request text, filters, or
        // identifiers can become a DMV command, and query.execute retains its gate.
        internal static string Command(MetadataRowset rowset)
        {
            switch (rowset)
            {
                case MetadataRowset.Tables:
                    return "SELECT [ID], [Name], [Description], [IsHidden] FROM $SYSTEM.TMSCHEMA_TABLES";
                case MetadataRowset.Columns:
                    return "SELECT [ID], [TableID], [ExplicitName], [InferredName], [ExplicitDataType], [InferredDataType], [Type], [IsHidden], [Description], [DisplayFolder], [FormatString], [SortByColumnID] FROM $SYSTEM.TMSCHEMA_COLUMNS";
                case MetadataRowset.Measures:
                    return "SELECT [ID], [TableID], [Name], [DataType], [IsHidden], [Description], [DisplayFolder], [FormatString], [Expression] FROM $SYSTEM.TMSCHEMA_MEASURES";
                case MetadataRowset.Relationships:
                    return "SELECT [ID], [Name], [IsActive], [FromTableID], [FromColumnID], [FromCardinality], [ToTableID], [ToColumnID], [ToCardinality], [CrossFilteringBehavior] FROM $SYSTEM.TMSCHEMA_RELATIONSHIPS";
                default:
                    throw new DaxGateError("WINDOWS_METADATA_ROWSET_DENIED", "Only the fixed table, column, measure and relationship metadata rowsets are allowed.");
            }
        }
    }
}
