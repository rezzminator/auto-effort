/** What the plugin keeps for a session, so a plugin reload (an option change) does not lose it. */
export type AutoEffortSession = {
  /** False after `/auto-effort off`. */
  enabled: boolean;
  /** The level the user pinned with /effort; null while none is pinned. */
  pin: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** The main chat's own level, set with `set_effort`, held across turns until it calls `set_effort` with auto; null while the automatic rules apply. */
  override: { level: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; reason: string } | null;
};

declare module 'claude-code' {
  interface PluginState {
    'auto-effort': { session: StateFamily<AutoEffortSession> };
  }
}
