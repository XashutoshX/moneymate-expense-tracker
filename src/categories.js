export const defaultCategories = [
  ['Groceries', 'shopping_cart'], ['Food & dining', 'restaurant'], ['Transport', 'local_taxi'],
  ['Shopping', 'shopping_bag'], ['Bills & utilities', 'lightbulb'], ['Health', 'medication'],
  ['Entertainment', 'movie'], ['Travel', 'flight'], ['Education', 'school'],
  ['Internet', 'wifi'], ['Mobile & phone', 'smartphone'], ['Electricity', 'bolt'], ['Water', 'water_drop'], ['Gas', 'local_fire_department'], ['Rent', 'home'], ['Cook', 'home'], ['Income', 'payments'], ['Transfers', 'swap_horiz'], ['Misc', 'folder'], ['Uncategorized', 'folder']
];
export const categoryIcons = ['folder', 'shopping_cart', 'restaurant', 'local_taxi', 'shopping_bag', 'lightbulb', 'medication', 'movie', 'flight', 'school', 'home', 'payments', 'swap_horiz', 'pets', 'redeem', 'fitness_center', 'work', 'local_cafe', 'wifi', 'smartphone', 'bolt', 'water_drop', 'local_fire_department', 'savings', 'credit_card', 'sports_esports', 'directions_car', 'build'];
export const legacyIcons = {"🛒":"shopping_cart","🍽️":"restaurant","🚕":"local_taxi","🛍️":"shopping_bag","💡":"lightbulb","💊":"medication","🎬":"movie","✈️":"flight","📚":"school","🏠":"home","💰":"payments","🔁":"swap_horiz","📁":"folder","🐾":"pets","🎁":"redeem","🏋️":"fitness_center","💼":"work","☕":"local_cafe"};
const rules = [
  ['Groceries', /\b(blinkit|blink commerce|bigbasket|zepto|dmart)\b/i],
  ['Food & dining', /\b(swiggy|zomato|bakers|bakery|restaurant|cafe|dominos|starbucks)\b/i],
  ['Transport', /\b(uber|ola cabs|rapido|metro)\b/i],
  ['Shopping', /\b(amazon|flipkart|myntra|ajio)\b/i],
  ['Bills & utilities', /\b(airtel|jio|bescom|tangedco|electricity)\b/i],
  ['Health', /\b(pharmacy|pharmacies|hospital|apollo pharmacy|netmeds|pharmeasy)\b/i],
  ['Entertainment', /\b(netflix|spotify|hotstar|pvr|inox)\b/i],
  ['Travel', /\b(irctc|indigo|makemytrip|cleartrip|air india)\b/i]
];

export function classify(transaction, enabled = true) {
  const matches = rules.filter(([, pattern]) => pattern.test(transaction.merchant));
  const category = transaction.type === 'income' ? 'Income'
    : matches.length === 1 ? matches[0][0] : 'Uncategorized';
  // A category guess alone must never confirm an uncertain amount/date or a transfer.
  const automatic = enabled && transaction.autoEligible === true && matches.length === 1
    && transaction.type === 'expense' && Number.isSafeInteger(transaction.amount) && transaction.amount > 0;
  return { ...transaction, category, review: automatic ? 0 : 1,
    note: automatic ? 'Automatically confirmed from a recognized alert and merchant rule. You can edit this.' : transaction.note };
}
