export type WorkMode = "Remote" | "Hybrid" | "On-site";

const WORK_MODES = ["Remote", "Hybrid", "On-site"] as const;

export function parseWorkLocationAnswer(value: string): {
  modes: WorkMode[];
  locations: string[];
} {
  const [modePart, ...locationParts] = value.split(":");
  const modes = WORK_MODES.filter((mode) =>
    modePart.toLowerCase().includes(mode.toLowerCase()),
  );
  const locations = locationParts
    .join(":")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return { modes: [...modes], locations };
}

export function selectedWorkModes(value: string): WorkMode[] {
  return WORK_MODES.filter((mode) =>
    value.toLowerCase().includes(mode.toLowerCase()),
  );
}

export function willingWorkLocations(value: string): string[] {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function needsWillingWorkLocation(modes: WorkMode[]): boolean {
  return modes.some((mode) => mode !== "Remote");
}
