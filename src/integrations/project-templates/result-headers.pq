    // Shorten captions after retrieval, without rewriting DAX or converting values.
    ShortName = (Name as text) as text =>
        let
            Opening = if Text.StartsWith(Name, "'")
                then Text.PositionOf(Text.Range(Text.Replace(Name, "''", "  "), 1), "'") + 2
                else Text.PositionOf(Name, "["),
            HasBrackets = Opening >= 0 and Opening < Text.Length(Name) - 2
                and Text.At(Name, Opening) = "[" and Text.EndsWith(Name, "]"),
            Prefix = if HasBrackets then Text.Start(Name, Opening) else "",
            Body = if HasBrackets then Text.Middle(Name, Opening + 1, Text.Length(Name) - Opening - 2) else "",
            Quoted = Text.Length(Prefix) > 2 and Text.StartsWith(Prefix, "'") and Text.EndsWith(Prefix, "'"),
            ValidPrefix = if Quoted
                then not Text.Contains(Text.Replace(Text.Middle(Prefix, 1, Text.Length(Prefix) - 2), "''", ""), "'")
                else not Text.Contains(Prefix, "'") and not Text.Contains(Prefix, "[") and not Text.Contains(Prefix, "]"),
            ValidBody = Body <> "" and not Text.Contains(Text.Replace(Body, "]]", ""), "]")
        in
            if HasBrackets and ValidPrefix and ValidBody then Text.Replace(Body, "]]", "]") else Name,
    SourceNames = Table.ColumnNames(Source),
    ShortNames = List.Transform(SourceNames, ShortName),
    Candidates = List.Transform(List.Positions(SourceNames), (Index) =>
        if List.Count(List.Select(ShortNames, (Name) => Comparer.OrdinalIgnoreCase(Name, ShortNames{Index}) = 0)) > 1
        then SourceNames{Index} else ShortNames{Index}),
    Headers = List.Accumulate(Candidates, {}, (Used, Candidate) =>
        let
            Base = if Candidate = "" then "Column" else Candidate,
            Available = (Label as text) as logical =>
                not List.Contains(Used, Label, Comparer.OrdinalIgnoreCase)
                and (Label = Candidate or not List.Contains(Candidates, Label, Comparer.OrdinalIgnoreCase)),
            Suffixes = List.Transform({2 .. List.Count(Candidates) + 2}, each Base & " (" & Text.From(_, "en-US") & ")"),
            Label = List.First(List.Select({Base} & Suffixes, Available))
        in
            Used & {Label}),
    CleanHeaders = Table.TransformColumnNames(Source, (Name) => Headers{List.PositionOf(SourceNames, Name)})
