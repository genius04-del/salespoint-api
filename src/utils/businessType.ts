// Restaurant features (tables, kitchen, recipes, day-end deduction) are for
// restaurants and bars. Everyone else (provision stores, mini-marts, clothing,
// phones...) sells products with their own stock. The type is free text in
// Settings, so match loosely.
export function isRestaurantType(businessType: string | null | undefined): boolean {
  return /restaurant|\bbar\b|cafe|café|eatery|kitchen|chop ?bar|canteen|bakery|pizz|fast ?food/i.test(businessType ?? "");
}
