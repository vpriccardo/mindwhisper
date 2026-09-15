import oggettiInCasaV13 from "../data/category-oggetti-in-casa.v1.3.json";
import oggettiInCasaV1 from "../data/category-oggetti-in-casa.v1.json";
import cartePoker52 from "../data/category-carte-poker-52.v1.json";
import animali from "../data/category-animali.v0.json";
import cibi from "../data/category-cibi.v0.json";
import { loadCategory } from "./loadCategory.js";

export const oggettiInCasa = loadCategory(oggettiInCasaV13, {
  extraLeafTrees: oggettiInCasaV1.leafTrees,
  trimLeaf: 8,
});

export const cartePoker = loadCategory(cartePoker52, { trimLeaf: 8 });

export const animaliCat = loadCategory(animali, { trimLeaf: 8 });

export const cibiCat = loadCategory(cibi, { trimLeaf: 8 });

export const CATEGORIES = [oggettiInCasa, cartePoker, animaliCat, cibiCat];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
