import oggettiInCasaTrim from "../data/category-oggetti-in-casa.v1.4-trim.json";
import cartePoker52 from "../data/category-carte-poker-52.v1.json";
import animaliTrim from "../data/category-animali.v0.1-trim.json";
import cibiTrim from "../data/category-cibi.v0.1-trim.json";
import portfolio from "../data/portfolio.v0.json";
import { loadCategory } from "./loadCategory.js";

export const oggettiInCasa = loadCategory(oggettiInCasaTrim, { trimLeaf: 8 });
export const cartePoker = loadCategory(cartePoker52, { trimLeaf: 8 });
export const animaliCat = loadCategory(animaliTrim, { trimLeaf: 8 });
export const cibiCat = loadCategory(cibiTrim, { trimLeaf: 8 });

export const CATEGORIES = [oggettiInCasa, cartePoker, animaliCat, cibiCat];

export const PORTFOLIO = portfolio;

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

/** Categories grouped by portfolio meta-world (casa / vivo / gioco). */
export function categoriesByMetaWorld() {
  const byId = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  return (portfolio.metaWorlds || []).map((world) => ({
    id: world.id,
    label: world.label,
    categories: (world.categoryIds || []).map((id) => byId[id]).filter(Boolean),
  }));
}
