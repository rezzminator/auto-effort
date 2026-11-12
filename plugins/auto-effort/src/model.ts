/** A model id as the settings and the probation counts name it: without a context-window suffix (`[1m]`) or a date stamp (`-20261001`). */
export function normalizeModel(model: string): string {
  return modelVariant(model).replace(/\[[^\]]*\]$/, '');
}

/**
 * A model id as a cache mark names it: its date stamp dropped, its context-window suffix kept (`claude-x-20261001[1m]` is
 * `claude-x[1m]`). One model's windows can carry effort differently in a request, so what the cache check finds on one says
 * nothing of another.
 */
export function modelVariant(model: string): string {
  return model.trim().replace(/-\d{8}(?=(\[[^\]]*\])?$)/, '');
}
