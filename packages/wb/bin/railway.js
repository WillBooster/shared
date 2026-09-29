/**
 * Build the `env` of a Railway service in `.railway/railway.ts`, evaluated through `wb deploy`.
 * Call it inside the default-exported function that only the Railway CLI evaluates (e.g. the callback
 * of `railway/iac`'s `defineRailway`), never at module scope: `wb` imports the file for
 * `railwayTarget` before it passes the variable names.
 *
 * Every variable `wb deploy` syncs from fnox is declared with `preserve()`, so Railway keeps the
 * value `wb deploy` pushed and plans a deletion for any variable neither here nor in fnox.
 * `railwayOnlyVariables` adds values Railway supplies: literals that only Railway reads, or
 * `railway/iac` references such as a linked database's `DATABASE_URL`. Such a key must not be
 * exported by the deployed fnox profile (e.g. `KEY = { env = false }` in its profile table).
 *
 * @param {() => unknown} preserve `preserve` from `railway/iac`.
 * @param {Record<string, unknown>} [railwayOnlyVariables]
 * @returns {Record<string, unknown>}
 */
export function railwayVariables(preserve, railwayOnlyVariables = {}) {
  const namesJson = process.env.WB_RAILWAY_VARIABLE_NAMES;
  if (namesJson === undefined) {
    throw new Error(
      'railwayVariables() needs the fnox variable names that `wb deploy` passes to the Railway CLI: call it inside the default-exported function (e.g. the callback of defineRailway), not at module scope, and plan through `wb deploy`.'
    );
  }
  const names = JSON.parse(namesJson);
  const duplicatedNames = names.filter((name) => Object.hasOwn(railwayOnlyVariables, name));
  if (duplicatedNames.length > 0) {
    throw new Error(`Declare each variable in either fnox or railway.ts, not both: ${duplicatedNames.join(', ')}`);
  }
  return { ...Object.fromEntries(names.map((name) => [name, preserve()])), ...railwayOnlyVariables };
}
