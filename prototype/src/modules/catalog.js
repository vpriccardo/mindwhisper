import { oggettiCasa } from "./oggetti-casa.js";
import { carteGioco } from "./carte-gioco.js";

export const CATEGORIES = [oggettiCasa, carteGioco];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
