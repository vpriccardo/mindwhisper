import { oggettiInCasa } from "./oggetti-in-casa.js";
import { carteGioco } from "./carte-gioco.js";

export const CATEGORIES = [oggettiInCasa, carteGioco];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
