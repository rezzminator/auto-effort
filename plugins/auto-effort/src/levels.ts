// The five effort levels and the arithmetic on them: every level the plugin sends is clamped to [floor, ceiling].

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof LEVELS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

export function rank(level: Effort): number {
  return LEVELS.indexOf(level);
}

export function clamp(level: Effort, floor: Effort, ceiling: Effort): Effort {
  if (rank(level) < rank(floor)) return floor;
  if (rank(level) > rank(ceiling)) return ceiling;
  return level;
}

/** One level up, never past the ceiling. */
export function stepUp(level: Effort, ceiling: Effort): Effort {
  if (rank(level) >= rank(ceiling)) return level;
  return LEVELS[rank(level) + 1] ?? level;
}

export function levelsWithin(floor: Effort, ceiling: Effort): Effort[] {
  return LEVELS.filter((level) => rank(level) >= rank(floor) && rank(level) <= rank(ceiling));
}
