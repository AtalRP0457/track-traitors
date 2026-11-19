// Player names come from a word list (no free text, PLAN.md section 8).

export const NAME_ADJECTIVES = [
  "Zippy", "Sandy", "Salty", "Sunny", "Turbo", "Wobbly", "Breezy", "Bouncy",
  "Sneaky", "Speedy", "Lucky", "Fizzy", "Jolly", "Rusty", "Crispy", "Mighty",
];

export const NAME_ANIMALS = [
  "Crab", "Gull", "Turtle", "Otter", "Puffin", "Gecko", "Pelican", "Shrimp",
  "Seal", "Lobster", "Walrus", "Squid", "Toucan", "Iguana", "Clam", "Dolphin",
];

export function randomName(rand: () => number = Math.random): string {
  const a = NAME_ADJECTIVES[Math.floor(rand() * NAME_ADJECTIVES.length)];
  const b = NAME_ANIMALS[Math.floor(rand() * NAME_ANIMALS.length)];
  return `${a} ${b}`;
}

/** Server-side check: only names built from the word lists are accepted. */
export function isListName(name: string): boolean {
  const [a, b, ...rest] = name.split(" ");
  return rest.length === 0 && NAME_ADJECTIVES.includes(a) && NAME_ANIMALS.includes(b);
}
