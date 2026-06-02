export type BuffId =
  | "berserk"
  | "swift"
  | "iron"
  | "vampiric"
  | "stormward";

export type ActiveBuff = {
  id: BuffId;
  remaining: number;
};

export type BuffModifiers = {
  damageDealt: number;
  moveSpeed: number;
  damageTaken: number;
  healOnKill: number;
  stormDamageReduction: number;
};

const BUFF_DURATION: Record<BuffId, number> = {
  berserk: 28,
  swift: 24,
  iron: 30,
  vampiric: 35,
  stormward: 22,
};

export function createDefaultModifiers(): BuffModifiers {
  return {
    damageDealt: 1,
    moveSpeed: 1,
    damageTaken: 1,
    healOnKill: 0,
    stormDamageReduction: 0,
  };
}

export class BuffController {
  readonly active: ActiveBuff[] = [];

  applyBuff(id: BuffId): void {
    const existing = this.active.find((buff) => buff.id === id);
    if (existing) {
      existing.remaining = BUFF_DURATION[id];
      return;
    }
    this.active.push({ id, remaining: BUFF_DURATION[id] });
  }

  tick(delta: number): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      this.active[index].remaining -= delta;
      if (this.active[index].remaining <= 0) {
        this.active.splice(index, 1);
      }
    }
  }

  getModifiers(): BuffModifiers {
    const mods = createDefaultModifiers();
    for (const buff of this.active) {
      switch (buff.id) {
        case "berserk":
          mods.damageDealt *= 1.28;
          break;
        case "swift":
          mods.moveSpeed *= 1.18;
          break;
        case "iron":
          mods.damageTaken *= 0.78;
          break;
        case "vampiric":
          mods.healOnKill += 14;
          break;
        case "stormward":
          mods.stormDamageReduction = Math.max(mods.stormDamageReduction, 0.55);
          break;
        default:
          break;
      }
    }
    return mods;
  }

  clear(): void {
    this.active.length = 0;
  }
}

export function getBuffLabel(id: BuffId): string {
  switch (id) {
    case "berserk":
      return "Berserk";
    case "swift":
      return "Swift";
    case "iron":
      return "Iron Skin";
    case "vampiric":
      return "Vampiric";
    case "stormward":
      return "Storm Ward";
    default:
      return "Buff";
  }
}
