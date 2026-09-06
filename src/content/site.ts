// Central content config for Layers Cake Bakery.
// All placeholder copy/pricing/contact info lives here so it can be
// swapped for real brand content in one place later.

export const brand = {
  name: "Layers",
  fullName: "Layers Cake Bakery",
  tagline: "Cake, built the slow way.",
};

export const nav = [
  { label: "Menu", href: "#menu" },
  { label: "Story", href: "#story" },
  { label: "Process", href: "#process" },
  { label: "Locations", href: "#locations" },
];

export const hero = {
  eyebrow: "Baked in layers, since day one",
  // Headings are deliberately short: the cake floats in front of them, so a
  // long line would be unreadable behind it.
  checkpoints: [
    {
      progress: 0,
      heading: "Built in layers.",
      body: "Six layers of sponge and cream, stacked by hand every morning.",
    },
    {
      progress: 0.28,
      heading: "Cut fresh.",
      body: "Sliced to order, never portioned the night before.",
    },
    {
      progress: 0.55,
      heading: "Every layer shows.",
      body: "No fillers, no shortcuts. Just butter, cocoa, and time.",
    },
    {
      progress: 0.8,
      heading: "Made to be shared.",
      body: "Boxed warm and ready the same day you pick it up.",
    },
  ],
  ctaLabel: "See the menu",
  ctaHref: "#menu",
};

export type Flavor = {
  id: string;
  name: string;
  description: string;
  price: string;
  tag?: string;
};

export const flavors: Flavor[] = [
  {
    id: "dark-chocolate-truffle",
    name: "Dark Chocolate Truffle",
    description: "Six layers of dark cocoa sponge, whipped ganache, and chocolate pearls.",
    price: "$62",
    tag: "Bestseller",
  },
  {
    id: "salted-caramel",
    name: "Salted Caramel",
    description: "Brown butter sponge, salted caramel cream, caramel drip.",
    price: "$58",
  },
  {
    id: "vanilla-bean-rose",
    name: "Vanilla Bean & Rose",
    description: "Madagascar vanilla sponge, rose mascarpone cream, candied petals.",
    price: "$58",
    tag: "New",
  },
  {
    id: "pistachio-honey",
    name: "Pistachio Honey",
    description: "Toasted pistachio sponge, honey mascarpone, crushed pistachio shell.",
    price: "$64",
  },
  {
    id: "red-velvet",
    name: "Classic Red Velvet",
    description: "Cocoa-kissed red sponge, cream cheese frosting, velvet crumb.",
    price: "$56",
  },
  {
    id: "lemon-elderflower",
    name: "Lemon Elderflower",
    description: "Bright lemon sponge, elderflower cream, candied lemon.",
    price: "$58",
  },
];

export const process = [
  {
    step: "01",
    title: "Mixed at 4am",
    body: "Our bakers start before sunrise, mixing each batter fresh for the day ahead.",
  },
  {
    step: "02",
    title: "Layered by hand",
    body: "Every sponge is leveled, filled, and stacked one layer at a time — no shortcuts.",
  },
  {
    step: "03",
    title: "Rested overnight",
    body: "Cakes rest so the layers settle and the flavor deepens before they're finished.",
  },
  {
    step: "04",
    title: "Finished to order",
    body: "Frosted, decorated, and boxed the same day you pick it up.",
  },
];

export const values = {
  heading: "What we left out matters just as much.",
  weUse: [
    "Belgian dark chocolate",
    "Cultured creamery butter",
    "Madagascar vanilla bean",
    "Free-range eggs",
  ],
  weAvoid: [
    "Preservatives",
    "Palm shortening",
    "Artificial flavoring",
    "Pre-mixed batters",
  ],
};

export const locations = [
  {
    name: "Layers — Downtown",
    address: "214 Mill Street, Riverside",
    hours: "Tue–Sun, 8am–6pm",
  },
  {
    name: "Layers — Northside",
    address: "88 Orchard Ave, Northside",
    hours: "Wed–Sun, 9am–5pm",
  },
];

export const footer = {
  newsletterHeading: "Get first pick of monthly flavors.",
  newsletterSub: "One email a month. No spam, just cake.",
};
