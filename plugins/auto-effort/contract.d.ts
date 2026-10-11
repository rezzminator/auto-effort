/** What the plugin keeps for a session, so a plugin reload (an option change) does not lose it. */
export type AutoEffortSession = {
  /** False after `/auto-effort off`. */
  enabled: boolean;
  /** The level the user pinned with /effort; null while none is pinned. */
  pin: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
};

declare module 'claude-code' {
  interface PluginState {
    'auto-effort': { session: StateFamily<AutoEffortSession> };
  }
}
