import { getWeaponByIndex, type Weapon, WEAPONS } from "./weapons";
import type { BuffId } from "./playerBuffs";

export const INVENTORY_SLOTS = 5;
export const MAX_STACK = 5;

export type StackableItemId =
  | "medkit"
  | "mega_medkit"
  | "berserk"
  | "swift"
  | "iron"
  | "vampiric"
  | "stormward";

export type InventoryEntry =
  | { kind: "weapon"; weaponIndex: number }
  | { kind: "stackable"; itemId: StackableItemId; quantity: number };

export type InventorySlot = InventoryEntry | null;

export function createStarterInventory(): InventorySlot[] {
  return [
    { kind: "weapon", weaponIndex: 0 },
    null,
    null,
    null,
    null,
  ];
}

export function getEntryLabel(entry: InventoryEntry): string {
  if (entry.kind === "weapon") {
    return getWeaponByIndex(entry.weaponIndex).name;
  }
  switch (entry.itemId) {
    case "medkit":
      return "Medkit";
    case "mega_medkit":
      return "Mega Medkit";
    case "berserk":
      return "Berserk Tonic";
    case "swift":
      return "Swift Elixir";
    case "iron":
      return "Iron Plate";
    case "vampiric":
      return "Vamp Charm";
    case "stormward":
      return "Storm Salve";
    default:
      return "Item";
  }
}

export function getEntryIcon(entry: InventoryEntry): string {
  if (entry.kind === "weapon") {
    return "⚔";
  }
  switch (entry.itemId) {
    case "medkit":
    case "mega_medkit":
      return "✚";
    default:
      return "✦";
  }
}

export function isBuffItem(itemId: StackableItemId): itemId is BuffId {
  return (
    itemId === "berserk" ||
    itemId === "swift" ||
    itemId === "iron" ||
    itemId === "vampiric" ||
    itemId === "stormward"
  );
}

export function findFirstEmptySlot(slots: InventorySlot[]): number {
  return slots.findIndex((slot) => slot === null);
}

export function addEntryToInventory(
  slots: InventorySlot[],
  entry: InventoryEntry,
): { ok: true; slot: number } | { ok: false } {
  if (entry.kind === "stackable") {
    const incoming = entry;
    const existingIndex = slots.findIndex((slot) => {
      if (!slot || slot.kind !== "stackable") {
        return false;
      }
      return slot.itemId === incoming.itemId && slot.quantity < MAX_STACK;
    });
    if (existingIndex >= 0) {
      const slot = slots[existingIndex];
      if (slot?.kind === "stackable") {
        const room = MAX_STACK - slot.quantity;
        const add = Math.min(room, incoming.quantity);
        slot.quantity += add;
        const leftover = incoming.quantity - add;
        if (leftover <= 0) {
          return { ok: true, slot: existingIndex };
        }
        entry = { kind: "stackable", itemId: incoming.itemId, quantity: leftover };
      }
    }
  }

  const empty = findFirstEmptySlot(slots);
  if (empty < 0) {
    return { ok: false };
  }
  slots[empty] = entry;
  return { ok: true, slot: empty };
}

export function addWeaponToInventory(slots: InventorySlot[], weapon: Weapon): boolean {
  const weaponIndex = WEAPONS.indexOf(weapon);
  if (weaponIndex < 0) {
    return false;
  }
  return addEntryToInventory(slots, { kind: "weapon", weaponIndex }).ok;
}

export function getWeaponInSlot(slots: InventorySlot[], slotIndex: number): Weapon | null {
  const entry = slots[slotIndex];
  if (!entry || entry.kind !== "weapon") {
    return null;
  }
  return getWeaponByIndex(entry.weaponIndex);
}

export function consumeSlot(slots: InventorySlot[], slotIndex: number): InventoryEntry | null {
  const entry = slots[slotIndex];
  if (!entry) {
    return null;
  }
  if (entry.kind === "weapon") {
    return entry;
  }
  entry.quantity -= 1;
  if (entry.quantity <= 0) {
    slots[slotIndex] = null;
  }
  return entry;
}
