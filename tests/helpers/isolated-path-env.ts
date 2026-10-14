export function envWithOnlyPath(
  pathValue: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === "path" || value === undefined) continue;
    env[key] = value;
  }
  return { ...env, PATH: pathValue, ...extra };
}
