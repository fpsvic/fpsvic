import type { BuffId } from "./playerBuffs";
import {
  addEntryToInventory,
  type InventorySlot,
  type StackableItemId,
} from "./inventory";

export type ShopCategory = "weapon" | "consumable" | "buff" | "utility";

export type ShopListing = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: ShopCategory;
  weaponIndex?: number;
  stackableId?: StackableItemId;
  quantity?: number;
};

export const SHOP_LISTINGS: ShopListing[] = [
  {
    id: "w_knight",
    name: "Knight Sword",
    description: "Balanced blade with solid reach.",
    price: 120,
    category: "weapon",
    weaponIndex: 1,
  },
  {
    id: "w_axe",
    name: "Raider Axe",
    description: "Heavy hits and strong knockback.",
    price: 185,
    category: "weapon",
    weaponIndex: 2,
  },
  {
    id: "w_spear",
    name: "Crystal Spear",
    description: "Long reach for safer duels.",
    price: 150,
    category: "weapon",
    weaponIndex: 3,
  },
  {
    id: "medkit",
    name: "Medkit",
    description: "Restore 35 HP instantly.",
    price: 45,
    category: "consumable",
    stackableId: "medkit",
    quantity: 1,
  },
  {
    id: "mega_medkit",
    name: "Mega Medkit",
    description: "Restore 70 HP instantly.",
    price: 85,
    category: "consumable",
    stackableId: "mega_medkit",
    quantity: 1,
  },
  {
    id: "berserk",
    name: "Berserk Tonic",
    description: "+28% damage for 28s.",
    price: 95,
    category: "buff",
    stackableId: "berserk",
    quantity: 1,
  },
  {
    id: "swift",
    name: "Swift Elixir",
    description: "+18% move speed for 24s.",
    price: 75,
    category: "buff",
    stackableId: "swift",
    quantity: 1,
  },
  {
    id: "iron",
    name: "Iron Plate",
    description: "−22% damage taken for 30s.",
    price: 90,
    category: "buff",
    stackableId: "iron",
    quantity: 1,
  },
  {
    id: "vampiric",
    name: "Vamp Charm",
    description: "+14 HP on each elimination for 35s.",
    price: 110,
    category: "buff",
    stackableId: "vampiric",
    quantity: 1,
  },
  {
    id: "stormward",
    name: "Storm Salve",
    description: "55% less storm damage for 22s.",
    price: 80,
    category: "utility",
    stackableId: "stormward",
    quantity: 1,
  },
];

export type PurchaseResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export function purchaseListing(
  listing: ShopListing,
  shards: number,
  inventory: InventorySlot[],
): { result: PurchaseResult; shards: number } {
  if (shards < listing.price) {
    return {
      shards,
      result: { ok: false, message: `Need ${listing.price} shards (you have ${shards}).` },
    };
  }

  let entry;
  if (listing.category === "weapon" && listing.weaponIndex !== undefined) {
    entry = { kind: "weapon" as const, weaponIndex: listing.weaponIndex };
  } else if (listing.stackableId) {
    entry = {
      kind: "stackable" as const,
      itemId: listing.stackableId,
      quantity: listing.quantity ?? 1,
    };
  } else {
    return { shards, result: { ok: false, message: "Invalid shop item." } };
  }

  const placed = addEntryToInventory(inventory, entry);
  if (!placed.ok) {
    return { shards, result: { ok: false, message: "Inventory full — free a slot first." } };
  }

  return {
    shards: shards - listing.price,
    result: { ok: true, message: `Purchased ${listing.name}.` },
  };
}

export function listingBuffId(listing: ShopListing): BuffId | null {
  if (!listing.stackableId) {
    return null;
  }
  const id = listing.stackableId;
  if (
    id === "berserk" ||
    id === "swift" ||
    id === "iron" ||
    id === "vampiric" ||
    id === "stormward"
  ) {
    return id;
  }
  return null;
}
