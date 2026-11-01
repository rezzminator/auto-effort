/** A model id as the settings and the stored marks name it: without a context-window suffix (`[1m]`) or a date stamp (`-20261001`). */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}
