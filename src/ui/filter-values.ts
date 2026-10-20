import type { BuilderFilter, FilterValueOption } from "../contracts/workbench";

export function selectedValueFilter(options: FilterValueOption[], exclude: boolean): Partial<BuilderFilter> {
  if (!options.length || options.length > 200) throw new Error("Choose between 1 and 200 values.");
  if (options.some(option => option.unavailable)) throw new Error("A selected value cannot be represented exactly. Remove it before applying.");
  const blank = options.some(option => option.value === null);
  if (blank && options.length !== 1) throw new Error("Choose (Blank) on its own. It cannot be combined with other values in this filter.");
  if (options.length > 1 && options.some(option => /[\r\n]/.test(option.literal ?? "")))
    throw new Error("A value containing a line break must be used on its own to preserve the exact text.");
  return {
    operator: blank ? exclude ? "IsNotBlank" : "IsBlank"
      : options.length === 1 && /[\r\n]/.test(options[0].literal ?? "") ? exclude ? "IsNot" : "Is" : exclude ? "NotIn" : "In",
    value: options.map(option => option.literal ?? "").join("\n"), value2: undefined,
    isParameter: false, isParameter2: false, enabled: true,
  };
}

export function calendarFilters(filter: BuilderFilter, from: string, through: string): [BuilderFilter, BuilderFilter] {
  const date = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31")
      throw new Error("Choose valid dates between 1900 and 9999.");
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
      throw new Error("Choose valid calendar dates.");
    return parsed;
  };
  date(from);
  const end = date(through);
  if (from > through) throw new Error("The end date must be on or after the start date.");
  end.setUTCDate(end.getUTCDate() + 1);
  if (end.getUTCFullYear() > 9999) throw new Error("Choose an end date before December 31, 9999.");
  const base = { ...filter, enabled: true, value2: undefined, isParameter: false, isParameter2: false };
  return [{ ...base, operator: "GreaterThanOrEqual", value: from },
    { ...base, id: `calendar:${filter.id}`, operator: "LessThan", value: end.toISOString().slice(0, 10) }];
}
