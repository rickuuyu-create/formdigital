/**
 * The option contract for every field type that carries options.
 *
 * Radio, dropdown and checkbox all compare a stored value against the options
 * printed on the form, and every place that does so — the canvas preview, the
 * fill controls, the flattened PDF, the editable PDF and validation — has to
 * compare them the same way. While the PDF normalised and the canvas did not,
 * an option carrying a stray space printed a mark in the exported form and
 * showed nothing on screen for the same stored value.
 *
 * A checkbox with no options is a single printed square: its value is the
 * familiar boolean ("checked" / ""). A checkbox that carries options is one
 * field covering a printed row such as "□關愛人格 □終身學習 □生涯規劃", where
 * any number of squares may be ticked. Those selections are stored one option
 * per line, which keeps them readable in CSV and in the stored workspace.
 */

const CHECKED_PATTERN = /^(checked|true|1|yes|是)$/i;

export function isCheckboxChecked(value: string) {
  return CHECKED_PATTERN.test(value.trim());
}

export function isCheckboxValueChecked(value: string, options?: unknown) {
  return knownOptions(options).length
    ? selectedCheckboxOptions(value, options).length > 0
    : isCheckboxChecked(value);
}

/**
 * The single spelling of an option used for every comparison.
 *
 * Selections are stored one per line and read back trimmed, so an option that
 * itself carries stray whitespace — a trailing space, or the "\r" left behind
 * when a list is pasted from Word or Excel — could be written but never read
 * back as selected. Ticking it looked like it did nothing at all, with no
 * error to show for it. Normalising both sides of the comparison here is what
 * keeps that from happening; a newline inside an option would split one
 * selection into two, so it collapses to a space.
 */
export function normalizeOption(option: unknown) {
  return String(option ?? "").replace(/\s+/g, " ").trim();
}

/** The field's options, normalised, blank-free and de-duplicated. */
export function knownOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  return options.flatMap(item => {
    const option = normalizeOption(item);
    if (!option || seen.has(option)) return [];
    seen.add(option);
    return [option];
  });
}

/**
 * Selected options, in the field's own option order so output is stable no
 * matter which order they were ticked in. Unknown entries are dropped.
 */
export function selectedCheckboxOptions(
  value: string,
  options: unknown
): string[] {
  const known = knownOptions(options);
  if (!known.length) return [];
  // Older single-option controls saved a boolean instead of the option label.
  // Keep those records readable without treating a multi-option boolean as a choice.
  if (known.length === 1 && isCheckboxChecked(value)) return known;
  const chosen = new Set(
    value
      .split("\n")
      .map(item => normalizeOption(item))
      .filter(Boolean)
  );
  return known.filter(option => chosen.has(option));
}

export function toggleCheckboxOption(
  value: string,
  options: unknown,
  option: string
) {
  const known = knownOptions(options);
  const target = normalizeOption(option);
  const chosen = new Set(selectedCheckboxOptions(value, known));
  if (chosen.has(target)) chosen.delete(target);
  else if (known.includes(target)) chosen.add(target);
  return known.filter(item => chosen.has(item)).join("\n");
}

/**
 * The chosen option of a single-select field, or "" when the stored value is
 * not one of the options. Radio and dropdown share this: a value that is not
 * on the form cannot be shown as chosen anywhere.
 */
export function selectedSingleOption(value: string, options: unknown) {
  const known = knownOptions(options);
  const chosen = normalizeOption(value);
  return known.includes(chosen) ? chosen : "";
}

export function isSingleOptionSelected(
  value: string,
  options: unknown,
  option: string
) {
  const target = normalizeOption(option);
  return target !== "" && selectedSingleOption(value, options) === target;
}

export function isCheckboxOptionSelected(
  value: string,
  options: unknown,
  option: string
) {
  return selectedCheckboxOptions(value, options).includes(
    normalizeOption(option)
  );
}
