/**
 * Sample product data matching the Medusa product schema.
 * Used to seed the local RxDB database for development/demo purposes.
 */

const BEVERAGES = { id: 'cat_beverages', name: 'Beverages', handle: 'beverages' };
const APPAREL = { id: 'cat_apparel', name: 'Apparel', handle: 'apparel' };
const ACCESSORIES = { id: 'cat_accessories', name: 'Accessories', handle: 'accessories' };

const TIMESTAMPS = {
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const NULL_DIMENSIONS = {
  weight: null,
  length: null,
  height: null,
  width: null,
};

const NULL_SHIPPING = {
  origin_country: null,
  hs_code: null,
  mid_code: null,
  material: null,
};

function makeProduct(
  id: string,
  title: string,
  handle: string,
  description: string,
  category: { id: string; name: string; handle: string },
  variants: any[],
  options: any[] = [],
) {
  return {
    id,
    title,
    handle,
    subtitle: null,
    description,
    status: 'published' as const,
    thumbnail: `https://picsum.photos/seed/${handle}/400/400`,
    is_giftcard: false,
    discountable: true,
    collection_id: null,
    type_id: null,
    external_id: null,
    ...NULL_DIMENSIONS,
    ...NULL_SHIPPING,
    metadata: null,
    categories: [category],
    tags: [],
    images: [{ id: `img_${handle}`, url: `https://picsum.photos/seed/${handle}/400/400`, rank: 0 }],
    options,
    variants,
    ...TIMESTAMPS,
  };
}

function makeSimpleVariant(
  id: string,
  sku: string,
  priceAmount: number,
  inventoryQuantity: number,
) {
  return {
    id,
    title: 'Default',
    sku,
    barcode: null,
    ean: null,
    upc: null,
    allow_backorder: false,
    manage_inventory: true,
    inventory_quantity: inventoryQuantity,
    variant_rank: 0,
    ...NULL_DIMENSIONS,
    options: [],
    prices: [
      {
        id: `price_${id}`,
        currency_code: 'usd',
        amount: priceAmount,
        min_quantity: null,
        max_quantity: null,
      },
    ],
  };
}

function makeSizedVariant(
  id: string,
  sizeLabel: string,
  sku: string,
  priceAmount: number,
  inventoryQuantity: number,
  optionValueId: string,
  rank: number,
) {
  return {
    id,
    title: sizeLabel,
    sku,
    barcode: null,
    ean: null,
    upc: null,
    allow_backorder: false,
    manage_inventory: true,
    inventory_quantity: inventoryQuantity,
    variant_rank: rank,
    ...NULL_DIMENSIONS,
    options: [{ id: optionValueId, value: sizeLabel }],
    prices: [
      {
        id: `price_${id}`,
        currency_code: 'usd',
        amount: priceAmount,
        min_quantity: null,
        max_quantity: null,
      },
    ],
  };
}

export const SAMPLE_PRODUCTS = [
  // --- Beverages (3) ---
  makeProduct(
    'prod_coffee_beans',
    'House Blend Coffee Beans',
    'house-blend-coffee-beans',
    'Whole bean medium roast coffee, 12oz bag. Notes of chocolate, caramel, and toasted almond.',
    BEVERAGES,
    [makeSimpleVariant('var_coffee_beans', 'COF-HB-12', 1499, 42)],
  ),

  makeProduct(
    'prod_matcha_powder',
    'Ceremonial Matcha Powder',
    'ceremonial-matcha-powder',
    'Premium stone-ground Japanese matcha. 30g tin, perfect for lattes and traditional preparation.',
    BEVERAGES,
    [makeSimpleVariant('var_matcha_powder', 'MAT-CER-30', 2899, 18)],
  ),

  makeProduct(
    'prod_cold_brew',
    'Cold Brew Concentrate',
    'cold-brew-concentrate',
    'Ready-to-dilute cold brew coffee concentrate, 32oz bottle. Makes up to 8 servings.',
    BEVERAGES,
    [makeSimpleVariant('var_cold_brew', 'CBR-CON-32', 1299, 35)],
  ),

  // --- Apparel (3) ---
  makeProduct(
    'prod_classic_tee',
    'Classic Logo T-Shirt',
    'classic-logo-tshirt',
    '100% ring-spun cotton tee with embroidered logo. Pre-shrunk, unisex fit.',
    APPAREL,
    [
      makeSizedVariant('var_tshirt_s', 'S', 'TSH-S', 2499, 25, 'val_s', 0),
      makeSizedVariant('var_tshirt_m', 'M', 'TSH-M', 2499, 40, 'val_m', 1),
      makeSizedVariant('var_tshirt_l', 'L', 'TSH-L', 2499, 30, 'val_l', 2),
    ],
    [
      {
        id: 'opt_size',
        title: 'Size',
        values: [
          { id: 'val_s', value: 'S' },
          { id: 'val_m', value: 'M' },
          { id: 'val_l', value: 'L' },
        ],
      },
    ],
  ),

  makeProduct(
    'prod_hoodie',
    'Heavyweight Pullover Hoodie',
    'heavyweight-pullover-hoodie',
    'Thick fleece-lined hoodie with kangaroo pocket. 80/20 cotton-poly blend.',
    APPAREL,
    [makeSimpleVariant('var_hoodie', 'HOD-PUL-M', 5999, 15)],
  ),

  makeProduct(
    'prod_baseball_cap',
    'Embroidered Baseball Cap',
    'embroidered-baseball-cap',
    'Structured six-panel cap with adjustable snapback closure. One size fits most.',
    APPAREL,
    [makeSimpleVariant('var_baseball_cap', 'CAP-EMB-OS', 1999, 50)],
  ),

  // --- Accessories (2) ---
  makeProduct(
    'prod_tote_bag',
    'Canvas Tote Bag',
    'canvas-tote-bag',
    'Sturdy 12oz canvas tote with reinforced handles. 15" x 16" with 4" gusset.',
    ACCESSORIES,
    [makeSimpleVariant('var_tote_bag', 'TOT-CNV-NT', 1599, 60)],
  ),

  makeProduct(
    'prod_water_bottle',
    'Insulated Water Bottle',
    'insulated-water-bottle',
    'Double-wall vacuum insulated stainless steel. Keeps drinks cold 24hrs or hot 12hrs. 20oz.',
    ACCESSORIES,
    [makeSimpleVariant('var_water_bottle', 'BTL-INS-20', 2999, 28)],
  ),
];
