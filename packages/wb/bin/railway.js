/**
 * Build the `env` of a Railway service in `.railway/railway.ts`, evaluated through `wb deploy`.
 *
 * Every variable `wb deploy` syncs from fnox is declared with `preserve()`, so Railway keeps the
 * value `wb deploy` pushed and plans a deletion for any variable neither here nor in fnox.
 * `railwayOnlyVariables` adds literal values that only Railway reads (never secrets, which belong
 * in fnox).
 *
 * @param {() => unknown} preserve `preserve` from `railway/iac`.
 * @param {Record<string, string>} [railwayOnlyVariables]
 * @returns {Record<string, unknown>}
 */
export function railwayVariables(preserve, railwayOnlyVariables = {}) {
  const namesJson = process.env.WB_RAILWAY_VARIABLE_NAMES;
  if (namesJson === undefined) {
    throw new Error('Evaluate .railway/railway.ts through `wb deploy`, which passes the fnox variable names.');
  }
  const names = JSON.parse(namesJson);
  const duplicatedNames = names.filter((name) => Object.hasOwn(railwayOnlyVariables, name));
  if (duplicatedNames.length > 0) {
    throw new Error(`Declare each variable in either fnox or railway.ts, not both: ${duplicatedNames.join(', ')}`);
  }
  return { ...Object.fromEntries(names.map((name) => [name, preserve()])), ...railwayOnlyVariables };
}
